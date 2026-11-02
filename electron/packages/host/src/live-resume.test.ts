import { expect, it } from 'vitest';
import { mkdtemp, mkdir, writeFile, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { randomUUID } from 'node:crypto';
import { SessionStore } from '@brigadir/persistence';
import { startHost, connectHost } from './index';
for (const provider of ['claude', 'codex'] as const)
	it.skipIf(process.env.BRIGADIR_LIVE_RESUME !== provider)(
		`live ${provider} GUI host restart retains provider context`,
		async () => {
			const root = await mkdtemp(join(tmpdir(), `brigadir-live-resume-${provider}-`)),
				repo = join(root, 'repo');
			await mkdir(repo);
			const store = await SessionStore.at(join(root, 'data')),
				project = await store.addProject(repo),
				task = await store.createTask(project.id, 'Live GUI resume acceptance', provider),
				marker = `E2_GUI_${randomUUID().slice(0, 8)}`;
			const config = {
				dataDir: store.root,
				key: task,
				mcpEntry: resolve('apps/desktop/out/services/mcp-relay'),
			};
			let host: Awaited<ReturnType<typeof startHost>> | undefined,
				client: Awaited<ReturnType<typeof connectHost>> | undefined;
			const report: Record<string, unknown> = {
				provider,
				startedAt: new Date().toISOString(),
				status: 'failed',
			};
			try {
				host = await startHost(config);
				client = await connectHost(host.identity);
				report.adapter = host.adapterInfo;
				await client.command({
					kind: 'prompt',
					text: `Remember this marker: ${marker}. Reply only READY. Do not call tools or change files.`,
				});
				await expect
					.poll(() => host!.records.filter((r) => r.event.kind === 'turn.completed').length, {
						timeout: 90000,
					})
					.toBe(1);
				const original = host.records.find((r) => r.event.kind === 'session.started')!.event;
				expect(original.kind).toBe('session.started');
				client.close();
				await host.stop();
				host = await startHost(config);
				client = await connectHost(host.identity);
				expect(host.records.filter((r) => r.event.kind === 'session.started')).toHaveLength(2);
				expect(host.records.filter((r) => r.event.kind === 'turn.started')).toHaveLength(1);
				const resumed = host.records.findLast((r) => r.event.kind === 'session.started')!.event;
				expect(resumed).toMatchObject(
					original.kind === 'session.started' ? { sessionId: original.sessionId } : {}
				);
				const after = host.records.at(-1)!.seq;
				await client.command({
					kind: 'prompt',
					text: 'What marker did I ask you to remember earlier? Reply with only that marker. Do not call tools or change files.',
				});
				await expect
					.poll(() => host!.records.filter((r) => r.event.kind === 'turn.completed').length, {
						timeout: 90000,
					})
					.toBe(2);
				const reply = host.records
					.flatMap((r) =>
						r.seq > after &&
						r.event.kind === 'message.delta' &&
						r.event.role === 'assistant' &&
						r.event.content.kind === 'text'
							? [r.event.content.text]
							: []
					)
					.join('');
				expect(reply).toContain(marker);
				expect(
					host.records.findLast((r) => r.event.kind === 'turn.completed')!.event
				).toMatchObject({ reason: 'end_turn' });
				expect(await readdir(repo)).toEqual([]);
				report.status = 'passed';
				report.sameSession = true;
				report.contextRetained = true;
				report.noReplay = true;
				report.projectUnchanged = true;
			} catch (error) {
				report.error = error instanceof Error ? error.message : String(error);
				throw error;
			} finally {
				client?.close();
				await host?.stop();
				report.finishedAt = new Date().toISOString();
				report.eventKinds = host?.records.map((r) => r.event.kind);
				await mkdir(resolve('test-results/live'), { recursive: true });
				await writeFile(
					resolve(`test-results/live/live-resume-${provider}.json`),
					JSON.stringify(report, null, 2) + '\n'
				);
				await rm(root, { recursive: true, force: true });
			}
		},
		240000
	);
