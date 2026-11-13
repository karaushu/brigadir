import { afterEach, beforeEach, expect, it } from 'vitest';
import { mkdtemp, mkdir, writeFile, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { SessionStore } from '@brigadir/persistence';
import { gitText } from '@brigadir/git';
import { startHost } from './server';
import { connectHost } from './client';
import { checklistBrief } from './crew';
import { compactionWindow } from './agent-settings';
let root: string;
const codexHome = process.env.CODEX_HOME;
beforeEach(async () => {
	root = await mkdtemp(join(tmpdir(), 'brigadir-session-brief-'));
	// The person's own Codex config must not decide the test (spec/agents-and-providers#compaction-window).
	process.env.CODEX_HOME = join(root, 'codex-home');
});
afterEach(async () => {
	if (codexHome === undefined) delete process.env.CODEX_HOME;
	else process.env.CODEX_HOME = codexHome;
	await rm(root, { recursive: true, force: true });
});
const settings = (agents: Record<string, unknown>) =>
	JSON.stringify({ schemaVersion: 1, settings: { agents } });
it('reads the compaction window: 200k without a file or key, null for the agent default (spec/agents-and-providers#compaction-window)', async () => {
	expect(await compactionWindow(root)).toBe(200_000);
	await writeFile(join(root, 'settings.json'), settings({ provider: 'claude' }));
	expect(await compactionWindow(root)).toBe(200_000);
	await writeFile(join(root, 'settings.json'), settings({ compactionWindow: null }));
	expect(await compactionWindow(root)).toBeNull();
	await writeFile(join(root, 'settings.json'), settings({ compactionWindow: 400_000 }));
	expect(await compactionWindow(root)).toBe(400_000);
	await writeFile(join(root, 'settings.json'), settings({ compactionWindow: 5 }));
	expect(await compactionWindow(root)).toBeNull();
});
async function run(scenario: string) {
	const repo = join(root, `repo-${scenario}`);
	await mkdir(repo);
	await gitText(repo, ['init', '-b', 'main']);
	const store = await SessionStore.at(join(root, `data-${scenario}`));
	await mkdir(store.root, { recursive: true });
	await writeFile(join(store.root, 'settings.json'), settings({ compactionWindow: 300_000 }));
	const project = await store.addProject(repo),
		task = await store.createTask(project.id, 'Brief', 'codex'),
		log = join(root, `agent-${scenario}.jsonl`),
		services = resolve('apps/desktop/out/services');
	const host = await startHost({
		key: task,
		dataDir: store.root,
		mcpEntry: join(services, 'mcp-relay'),
		adapter: {
			command: process.execPath,
			args: [resolve('packages/transport/fixtures/agent.mjs'), scenario, log],
		},
	});
	const client = await connectHost(host.identity);
	try {
		await client.command({ kind: 'prompt', text: 'Start' });
		await expect
			.poll(async () =>
				(await client.snapshot()).records.some((record) => record.event.kind === 'turn.completed')
			)
			.toBe(true);
		const records = (await client.snapshot()).records;
		const entries = (await readFile(log, 'utf8'))
			.trim()
			.split('\n')
			.map((line) => JSON.parse(line) as { event: string; params: unknown });
		return { entries, records };
	} finally {
		client.close();
		await host.stop();
	}
}
it('sends the brief as the appended system prompt and keeps it out of the first prompt and the journal (spec/agents-and-providers#session-brief)', async () => {
	const { entries, records } = await run('system-prompt');
	const raw = entries.find((entry) => entry.event === 'raw-session/new')?.params as {
		systemPrompt: { mode: string; content: { type: string; text: string }[] };
	};
	expect(raw.systemPrompt.mode).toBe('append');
	expect(raw.systemPrompt.content[0]?.text).toContain(checklistBrief);
	const blocks = entries.find((entry) => entry.event === 'prompt-blocks')?.params;
	expect(JSON.stringify(blocks)).not.toContain(checklistBrief);
	expect(JSON.stringify(records)).not.toContain(checklistBrief);
	// The window from the app's settings reaches Codex.
	expect(entries.find((entry) => entry.event === 'codex-config')?.params).toMatchObject({
		model_auto_compact_token_limit: 300_000,
	});
});
it('falls back to the brief in the first prompt when the agent refuses the system prompt', async () => {
	const { entries, records } = await run('system-prompt-refused');
	const blocks = entries.find((entry) => entry.event === 'prompt-blocks')?.params;
	expect(JSON.stringify(blocks)).toContain(checklistBrief);
	expect(JSON.stringify(records)).not.toContain(checklistBrief);
});
it('sends the brief as .context after a restart whose load refused the system prompt (spec/agents-and-providers#session-brief)', async () => {
	const repo = join(root, 'repo-restart');
	await mkdir(repo);
	await gitText(repo, ['init', '-b', 'main']);
	const store = await SessionStore.at(join(root, 'data-restart'));
	const project = await store.addProject(repo),
		task = await store.createTask(project.id, 'Brief', 'codex'),
		log = join(root, 'agent-restart.jsonl'),
		services = resolve('apps/desktop/out/services');
	const turn = async (scenario: string, text: string, turns: number) => {
		const host = await startHost({
			key: task,
			dataDir: store.root,
			mcpEntry: join(services, 'mcp-relay'),
			adapter: {
				command: process.execPath,
				args: [resolve('packages/transport/fixtures/agent.mjs'), scenario, log],
			},
		});
		const client = await connectHost(host.identity);
		try {
			await client.command({ kind: 'prompt', text });
			await expect
				.poll(
					async () =>
						(await client.snapshot()).records.filter(
							(record) => record.event.kind === 'turn.completed'
						).length
				)
				.toBe(turns);
		} finally {
			client.close();
			await host.stop();
		}
	};
	const entries = async () =>
		(await readFile(log, 'utf8'))
			.trim()
			.split('\n')
			.map((line) => JSON.parse(line) as { event: string; params: unknown });
	// The session opens with the brief in its system prompt…
	await turn('system-prompt', 'Start', 1);
	expect(
		JSON.stringify((await entries()).filter((entry) => entry.event === 'prompt-blocks'))
	).not.toContain(checklistBrief);
	// …the restarted host loads it; the agent refuses the system prompt, so the next prompt carries the brief.
	await turn('system-prompt-refused', 'Next', 2);
	const after = await entries();
	const loads = after.filter((entry) => entry.event === 'raw-session/load');
	expect(loads).toHaveLength(2);
	expect(loads[0]?.params).toHaveProperty('systemPrompt');
	expect(loads[1]?.params).not.toHaveProperty('systemPrompt');
	expect(JSON.stringify(after.filter((entry) => entry.event === 'prompt-blocks').at(-1))).toContain(
		checklistBrief
	);
});
