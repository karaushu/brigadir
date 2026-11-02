import { expect, it } from 'vitest';
import { mkdtemp, mkdir, writeFile, rm, readdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { SessionStore } from '@brigadir/persistence';
import { connectHost, startHost } from './index';
const delay = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
async function until<T>(read: () => T | undefined, timeout = 120_000): Promise<T> {
	const end = Date.now() + timeout;
	while (Date.now() < end) {
		const value = read();
		if (value !== undefined) return value;
		await delay(100);
	}
	throw new Error('Live gate timed out');
}
it.skipIf(process.env.BRIGADIR_LIVE_GATES !== 'codex')(
	'G1/G2: Codex MCP, >5 minute wait, cancel and disconnect',
	async () => {
		const root = await mkdtemp(join(tmpdir(), 'brigadir-gates-'));
		const projectPath = join(root, 'project');
		await mkdir(projectPath);
		const store = await SessionStore.at(join(root, 'data'));
		const project = await store.addProject(projectPath);
		const task = await store.createTask(project.id, 'MCP gate', 'codex');
		const report: Record<string, unknown> = {
			startedAt: new Date().toISOString(),
			sdk: { acp: '1.4.0', mcp: '1.30.0' },
			adapter: 'codex-acp 1.10.0',
			command: 'BRIGADIR_LIVE_GATES=codex pnpm exec vitest run packages/host/src/gates.test.ts',
			expected:
				'Actual ask_user, >300 seconds pending, same turn receives answer, cancellation/disconnect interrupt',
			status: 'failed',
			exitCode: 1,
		};
		let host: Awaited<ReturnType<typeof startHost>> | undefined;
		let client: Awaited<ReturnType<typeof connectHost>> | undefined;
		try {
			host = await startHost({
				dataDir: store.root,
				key: task,
				mcpEntry: resolve('apps/desktop/out/services/mcp-relay'),
			});
			client = await connectHost(host.identity);
			report.adapter = host.adapterInfo;
			const records = () => host!.records;
			const approve = setInterval(() => {
				for (const r of records())
					if (r.event.kind === 'permission.requested') {
						const req = r.event.request;
						if (
							!records().some(
								(r) => r.event.kind === 'permission.resolved' && r.event.id === req.id
							)
						) {
							const option = req.options.find((o) => o.kind === 'allow_once');
							if (option)
								void client!
									.command({ kind: 'answerPermission', id: req.id, optionId: option.id })
									.catch(() => {});
						}
					}
			}, 200);
			try {
				const prompt =
					'Call the brigadir ask_user MCP tool now using its flat input schema (not a questions array). Ask "Which gate label?", header "Gate", options [{"label":"READY","description":"Continue the test"}], allowsFreeText false, allowsMultiple false. Wait for the human answer, however long it takes. After receiving it, reply with exactly its selected label. Do not call other tools or modify files.';
				await client.command({ kind: 'prompt', text: prompt });
				const question = await until(() =>
					records().find((r) => r.event.kind === 'question.requested')
				);
				report.toolTimeoutSeconds = 604800;
				report.configuration =
					'Complete stdio server in CODEX_CONFIG.mcp_servers; no duplicate ACP entry';
				report.G1 = { status: 'passed', questionSeq: question.seq, at: question.at };
				console.log('G1 passed. ask_user pending; beginning 305-second human wait.');
				client.close();
				await delay(305_000);
				expect(records().some((r) => r.event.kind === 'turn.completed')).toBe(false);
				client = await connectHost(host.identity);
				expect((await client.snapshot()).records.some((r) => r.seq === question.seq)).toBe(true);
				if (question.event.kind !== 'question.requested') throw new Error('Expected question');
				await client.command({
					kind: 'answerQuestion',
					id: question.event.question.id,
					answer: { labels: ['READY'], text: '' },
				});
				const done = await until(() => records().find((r) => r.event.kind === 'turn.completed'));
				const reply = records()
					.flatMap((r) =>
						r.event.kind === 'message.delta' &&
						r.event.role === 'assistant' &&
						r.event.content.kind === 'text'
							? [r.event.content.text]
							: []
					)
					.join('');
				expect(reply).toContain('READY');
				expect(done.event).toMatchObject({ reason: 'end_turn' });
				report.wait = {
					seconds: (Date.parse(done.at) - Date.parse(question.at)) / 1000,
					reply,
					sameTurn: records().filter((r) => r.event.kind === 'turn.started').length === 1,
					reattached: true,
				};
				console.log('Long wait passed. Checking cancellation.');
				await delay(200);
				const after = records().at(-1)!.seq;
				await client.command({ kind: 'prompt', text: prompt });
				const second = await until(() =>
					records().find((r) => r.seq > after && r.event.kind === 'question.requested')
				);
				await client.command({ kind: 'cancel' });
				expect(
					(
						await until(() =>
							records().find((r) => r.seq > second.seq && r.event.kind === 'turn.completed')
						)
					).event
				).toMatchObject({ reason: 'cancelled' });
				expect(
					records().some(
						(r) =>
							r.seq > second.seq && r.event.kind === 'question.resolved' && r.event.answer === null
					)
				).toBe(true);
				report.cancel = 'passed';
				await delay(200);
				const thirdAfter = records().at(-1)!.seq;
				await client.command({ kind: 'prompt', text: prompt });
				const third = await until(() =>
					records().find((r) => r.seq > thirdAfter && r.event.kind === 'question.requested')
				);
				await host.stop('gate_disconnect');
				const saved = await store.journal(task);
				expect(saved.issue).toBeNull();
				expect(
					saved.records.some(
						(r) =>
							r.seq > third.seq && r.event.kind === 'question.resolved' && r.event.answer === null
					)
				).toBe(true);
				report.disconnect = 'passed (host closes ACP during a pending tool)';
				expect(await readdir(projectPath)).toEqual([]);
				report.status = 'passed';
				report.exitCode = 0;
				report.fixture = saved.records.filter((r) =>
					['question.requested', 'question.resolved', 'turn.completed', 'host.stopped'].includes(
						r.event.kind
					)
				);
			} finally {
				clearInterval(approve);
			}
		} catch (e) {
			report.error = e instanceof Error ? e.message : String(e);
			throw e;
		} finally {
			report.toolFailures = host?.records
				.filter((r) => r.event.kind === 'tool.changed' && r.event.patch.status === 'failed')
				.map((r) => r.event);
			client?.close();
			await host?.stop();
			await rm(root, { recursive: true, force: true });
			await mkdir(resolve('test-results/live'), { recursive: true });
			await writeFile(
				resolve('test-results/live/G1-G2-codex.json'),
				JSON.stringify(report, null, 2) + '\n'
			);
		}
	},
	750_000
);

it.skipIf(process.env.BRIGADIR_LIVE_GATES !== 'claude')(
	'live Claude asks through stdio MCP and receives the explicit answer',
	async () => {
		const root = await mkdtemp(join(tmpdir(), 'brigadir-claude-mcp-'));
		const repo = join(root, 'repo');
		await mkdir(repo);
		const store = await SessionStore.at(join(root, 'data'));
		const project = await store.addProject(repo);
		const task = await store.createTask(project.id, 'Claude MCP smoke', 'claude');
		let host: Awaited<ReturnType<typeof startHost>> | undefined;
		let client: Awaited<ReturnType<typeof connectHost>> | undefined;
		const report: Record<string, unknown> = {
			startedAt: new Date().toISOString(),
			command: 'BRIGADIR_LIVE_GATES=claude pnpm exec vitest run packages/host/src/gates.test.ts',
			sdk: { acp: '1.4.0', mcp: '1.30.0' },
			expected: 'MCP question, explicit answer READY, end_turn, no project changes',
			status: 'failed',
			exitCode: 1,
		};
		try {
			host = await startHost({
				dataDir: store.root,
				key: task,
				mcpEntry: resolve('apps/desktop/out/services/mcp-relay'),
			});
			report.adapter = host.adapterInfo;
			client = await connectHost(host.identity);
			await client.command({
				kind: 'prompt',
				text: 'Use the brigadir ask_user tool to ask "Which label?" with option {"label":"READY","description":"Test label"}. Wait for the answer and reply with exactly its selected label. Do not use other tools or modify files.',
			});
			const question = await until(() =>
				host!.records.find((r) => r.event.kind === 'question.requested')
			);
			if (question.event.kind !== 'question.requested') throw new Error('Expected question');
			await client.command({
				kind: 'answerQuestion',
				id: question.event.question.id,
				answer: { labels: ['READY'], text: '' },
			});
			const done = await until(() => host!.records.find((r) => r.event.kind === 'turn.completed'));
			expect(done.event).toMatchObject({ reason: 'end_turn' });
			const reply = host.records
				.flatMap((r) =>
					r.event.kind === 'message.delta' &&
					r.event.role === 'assistant' &&
					r.event.content.kind === 'text'
						? [r.event.content.text]
						: []
				)
				.join('');
			expect(reply).toContain('READY');
			expect(await readdir(repo)).toEqual([]);
			report.actual = reply;
			report.status = 'passed';
			report.exitCode = 0;
			report.fixture = host.records.filter((r) =>
				['question.requested', 'question.resolved', 'turn.completed'].includes(r.event.kind)
			);
		} catch (e) {
			report.error = e instanceof Error ? e.message : String(e);
			throw e;
		} finally {
			client?.close();
			await host?.stop();
			await rm(root, { recursive: true, force: true });
			await mkdir(resolve('test-results/live'), { recursive: true });
			await writeFile(
				resolve('test-results/live/host-claude.json'),
				JSON.stringify(report, null, 2) + '\n'
			);
		}
	},
	180000
);
