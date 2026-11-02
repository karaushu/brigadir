import { expect, it } from 'vitest';
import { mkdtemp, mkdir, writeFile, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { randomUUID } from 'node:crypto';
import { SessionStore, Attachments } from '@brigadir/persistence';
import { discoverScopes } from '@brigadir/git';
import type { TerminalInfo } from '@brigadir/core';
import { startHost, connectHost } from './index';
const delay = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
for (const provider of ['claude', 'codex'] as const)
	it.skipIf(process.env.BRIGADIR_LIVE_CLI !== provider)(
		`live ${provider} CLI hooks and session context survive host restart`,
		async () => {
			const root = await mkdtemp(join(tmpdir(), `brigadir-live-cli-${provider}-`)),
				repo = join(root, 'repo with spaces');
			await mkdir(repo);
			const git = (...args: string[]) => promisify(execFile)('git', args, { cwd: repo });
			await git('init', '-b', 'main');
			await git('config', 'user.name', 'Fixture');
			await git('config', 'user.email', 'fixture@example.invalid');
			await writeFile(join(repo, 'baseline.txt'), 'unchanged\n');
			await git('add', '.');
			await git('commit', '-m', 'Initial');
			const store = await SessionStore.at(join(root, 'data')),
				project = await store.addProject(repo),
				marker = `E2_KEEP_${randomUUID().slice(0, 8)}`;
			const task = await store.createTask(
				project.id,
				`Remember this marker for this session: ${marker}. Reply with exactly READY. Do not call tools or change any files.`,
				provider,
				'terminal',
				'Live CLI acceptance',
				'queued',
				{
					isolation: 'in-place',
					branch: '',
					baseRef: 'main',
					setupCommand: '',
					scopes: (await discoverScopes(repo)).map(({ id, name, kind }) => ({
						id,
						name,
						kind,
						selected: true,
					})),
				}
			);
			const config = {
				dataDir: store.root,
				key: task,
				mcpEntry: resolve('apps/desktop/out/services/mcp-relay'),
			};
			const report: Record<string, unknown> = {
				provider,
				startedAt: new Date().toISOString(),
				status: 'running',
				stage: 'launch',
				trustAccepted: false,
			};
			const output = resolve(`test-results/live/live-cli-${provider}.json`);
			await mkdir(resolve('test-results/live'), { recursive: true });
			let host: Awaited<ReturnType<typeof startHost>> | undefined,
				client: Awaited<ReturnType<typeof connectHost>> | undefined;
			const seenTrust = new Set<string>();
			let lastSaved = 0;
			async function screen() {
				const info = ((await client!.terminal({ kind: 'list' })) as TerminalInfo[]).find(
					(item) => item.role === 'agent'
				);
				if (!info) throw new Error('Agent terminal missing');
				const text = String(await client!.terminal({ kind: 'text', id: info.id }));
				report.screen = text.replaceAll(root, '<fixture>');
				report.eventKinds = host!.records.map((r) => r.event.kind);
				if (Date.now() - lastSaved > 2000) {
					await writeFile(output, JSON.stringify(report, null, 2) + '\n');
					lastSaved = Date.now();
				}
				// Trust only this freshly created, controlled fixture; never approve tool commands.
				if (!seenTrust.has('folder') && /Yes, I trust this folder|Trust and continue/.test(text)) {
					seenTrust.add('folder');
					report.trustAccepted = true;
					if (/❯\s*No, exit/.test(text))
						await client!.terminal({ kind: 'input', id: info.id, data: '\x1b[B' });
					await delay(100);
					await client!.terminal({ kind: 'input', id: info.id, data: '\r' });
				}
				if (
					provider === 'codex' &&
					!seenTrust.has('hooks') &&
					/Hooks need review/.test(text) &&
					/7 hooks are new or changed/.test(text) &&
					/2\. Trust all and continue/.test(text)
				) {
					// This run supplies the seven reviewed Brigadir handlers from cliLaunch.
					seenTrust.add('hooks');
					report.hooksTrusted = true;
					await client!.terminal({ kind: 'input', id: info.id, data: '\x1b[B' });
					await delay(150);
					await client!.terminal({ kind: 'input', id: info.id, data: '\r' });
				}
				if (
					!seenTrust.has('question permission') &&
					text.includes('Allow the brigadir MCP server to run tool "ask_user"?') &&
					text.includes('Acceptance cancellation?') &&
					/› 1\. Allow\s/.test(text)
				) {
					seenTrust.add('question permission');
					await client!.terminal({ kind: 'input', id: info.id, data: '\r' });
				}
				if (info.exited) throw new Error(`CLI exited (${info.exitCode}): ${text}`);
				return { info, text };
			}
			async function until(check: () => boolean, timeout = 90000) {
				const deadline = Date.now() + timeout;
				while (Date.now() < deadline) {
					await screen();
					if (check()) return;
					await delay(300);
				}
				throw new Error(`Timed out during ${report.stage}`);
			}
			try {
				host = await startHost(config);
				client = await connectHost(host.identity);
				await until(() => host!.records.some((r) => r.event.kind === 'turn.completed'));
				const original = host.records.find((r) => r.event.kind === 'session.started')!.event;
				if (original.kind !== 'session.started') throw new Error('Session hook missing');
				report.sessionId = original.sessionId;
				expect(host.records.filter((r) => r.event.kind === 'turn.started')).toHaveLength(1);
				expect(
					host.records.findLast((r) => r.event.kind === 'turn.completed')!.event
				).toMatchObject({ reason: 'end_turn' });
				expect((await screen()).text).toContain('READY');
				report.stage = 'restart';
				await host.stop();
				client.close();
				seenTrust.clear();
				host = await startHost(config);
				client = await connectHost(host.identity);
				if (provider === 'claude')
					await until(
						() => host!.records.filter((r) => r.event.kind === 'session.started').length === 2
					);
				const resumed = host.records.findLast((r) => r.event.kind === 'session.started')!.event;
				expect(resumed).toMatchObject({ sessionId: original.sessionId });
				const launch = JSON.parse(
					await readFile(join(await store.taskDir(task), 'cli-launch.json'), 'utf8')
				);
				expect(launch.resume).toBe(original.sessionId);
				expect(launch.args).not.toContain(task.prompt);
				await delay(5000);
				expect(host.records.filter((r) => r.event.kind === 'turn.started')).toHaveLength(1);
				report.stage = 'context';
				const { info } = await screen();
				await client.terminal({
					kind: 'input',
					id: info.id,
					data: 'What was the marker I asked you to remember earlier? Reply with only that marker. Do not call tools or change files.',
				});
				await delay(1000);
				await client.terminal({ kind: 'input', id: info.id, data: '\r' });
				await until(
					() => host!.records.filter((r) => r.event.kind === 'turn.completed').length === 2
				);
				const finalScreen = (await screen()).text;
				expect(finalScreen.slice(finalScreen.lastIndexOf('What was the marker'))).toContain(marker);
				expect(
					host.records.findLast((r) => r.event.kind === 'turn.completed')!.event
				).toMatchObject({ reason: 'end_turn' });
				expect(host.records.filter((r) => r.event.kind === 'turn.started')).toHaveLength(2);
				expect((await git('status', '--porcelain')).stdout).toBe('');
				report.sameSession = true;
				report.contextRetained = true;
				report.projectUnchanged = true;
				expect(host.records.filter((r) => r.event.kind === 'session.started')).toHaveLength(2);
				report.stage = 'attached context and review';
				const contextMarker = `E2_CONTEXT_${randomUUID().slice(0, 8)}`,
					reviewMarker = `E2_REVIEW_${randomUUID().slice(0, 8)}`;
				const attachment = await new Attachments(store).create(task, {
					kind: 'text',
					name: 'Acceptance context',
					text: `Context marker: ${contextMarker}`,
				});
				await client.command({ kind: 'attachContext', id: attachment.id });
				const review = {
					id: randomUUID().replaceAll('-', '').repeat(2),
					comments: [{ id: randomUUID(), version: 1 }],
				};
				await client.command({
					kind: 'submitReview',
					text: `Review marker: ${reviewMarker}`,
					review,
				});
				const prompt =
					'Reply with the review marker and context marker provided alongside this message. Do not call tools or change files.';
				await client.terminal({ kind: 'input', id: info.id, data: prompt });
				await delay(500);
				await client.terminal({ kind: 'input', id: info.id, data: '\r' });
				await until(
					() => host!.records.filter((r) => r.event.kind === 'turn.completed').length === 3
				);
				const contextScreen = (await screen()).text;
				const response = contextScreen.slice(
					contextScreen.lastIndexOf('Reply with the review marker')
				);
				expect(response).toContain(contextMarker);
				expect(response).toContain(reviewMarker);
				expect(host.records.findLast((r) => r.event.kind === 'turn.started')!.event).toMatchObject({
					review,
					attachments: [attachment],
				});
				expect((await client.snapshot()).pendingAttachments).toEqual([]);
				expect((await client.snapshot()).pendingReview).toBeUndefined();
				report.attachedContext = true;
				report.reviewContext = true;
				report.stage = 'cancel MCP question';
				await client.terminal({
					kind: 'input',
					id: info.id,
					data: 'Call the brigadir ask_user MCP tool to ask "Acceptance cancellation?" with one option {"label":"READY","description":"Test"}. Wait for the answer. Do not call other tools or modify files.',
				});
				await delay(500);
				await client.terminal({ kind: 'input', id: info.id, data: '\r' });
				await until(() => host!.records.some((r) => r.event.kind === 'question.requested'));
				await client.command({ kind: 'cancel' });
				await until(
					() => host!.records.filter((r) => r.event.kind === 'turn.completed').length === 4
				);
				expect(
					host.records.findLast((r) => r.event.kind === 'turn.completed')!.event
				).toMatchObject({ reason: 'cancelled' });
				await until(() =>
					host!.records.some((r) => r.event.kind === 'question.resolved' && r.event.answer === null)
				);
				report.cancel = true;
				report.mcp = true;
				expect((await git('status', '--porcelain')).stdout).toBe('');
				report.status = 'passed';
				report.stage = 'complete';
			} catch (error) {
				report.status = 'failed';
				report.error = error instanceof Error ? error.message : String(error);
				throw error;
			} finally {
				report.finishedAt = new Date().toISOString();
				report.eventKinds = host?.records.map((r) => r.event.kind);
				client?.close();
				await host?.stop();
				await writeFile(output, JSON.stringify(report, null, 2) + '\n');
				await rm(root, { recursive: true, force: true });
			}
		},
		300000
	);
