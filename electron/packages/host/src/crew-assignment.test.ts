import { afterEach, expect, it } from 'vitest';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { createConnection } from 'node:net';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { SessionStore } from '@brigadir/persistence';
import { gitText } from '@brigadir/git';
import {
	builtinAgentTemplates,
	resolveCrew,
	templateLookup,
	type CrewAssignment,
	type CrewTemplate,
	type EventRecord,
} from '@brigadir/core';
import { assignmentHeader } from '@brigadir/orchestrator';
import { startHost } from './server';
import { Peer } from './peer';

const cleanup: (() => Promise<unknown>)[] = [];
afterEach(async () => {
	for (const fn of cleanup.splice(0).reverse()) await fn().catch(() => {});
});
const reviewLoop: CrewTemplate = {
	schemaVersion: 1,
	id: 'review-loop',
	name: 'Developer + Reviewer',
	builtin: false,
	root: {
		id: 'root',
		name: 'Foreman',
		template: 'foreman-default',
		agents: [
			{ id: 'developer', name: 'Developer', template: 'developer', checkedBy: ['reviewer'] },
			{ id: 'reviewer', name: 'Reviewer', template: 'reviewer' },
		],
	},
};
const part: CrewAssignment = {
	kind: 'part',
	text: 'Part 1: Client details\n<part_prompt>\nPART-PROMPT-MARK\n</part_prompt>',
	marker: 'PART-PROMPT-MARK',
};
/**
 * spec/crew#assignment-after-compaction: a real worker host over the fixture agent (`crew-compaction`), with the test as its parent on the crew
 * link: it answers `assignment` with `answer` and takes reports.
 */
async function worker(node: 'developer' | 'reviewer' = 'developer') {
	const root = await mkdtemp(join(tmpdir(), 'brigadir-crew-assignment-'));
	cleanup.push(() => rm(root, { recursive: true, force: true }));
	const repo = join(root, 'repo');
	await mkdir(repo);
	await gitText(repo, ['init', '-b', 'main']);
	const store = await SessionStore.at(join(root, 'data'));
	await mkdir(store.root, { recursive: true });
	const project = await store.addProject(repo);
	const spec = resolveCrew(reviewLoop, {
		lookup: templateLookup([...builtinAgentTemplates]),
		defaultProvider: 'claude',
		now: new Date().toISOString(),
	});
	let foreman = await store.createTask(project.id, 'Split the work', 'claude');
	foreman = await store.updateTask(foreman, { crew: spec });
	let task = await store.createTask(project.id, 'Client details', 'claude');
	task = await store.updateTask(task, {
		crewTaskId: foreman.id,
		crewNodeId: node,
		parentTaskId: foreman.id,
	});
	const log = join(root, 'agent.jsonl');
	const config = {
		key: task,
		dataDir: store.root,
		mcpEntry: resolve('apps/desktop/out/services/mcp-relay'),
		adapter: {
			command: process.execPath,
			args: [resolve('packages/transport/fixtures/agent.mjs'), 'crew-compaction', log],
		},
	};
	const state = {
		answer: part as CrewAssignment | null,
		asked: 0,
		host: null as Awaited<ReturnType<typeof startHost>> | null,
		parent: null as Peer | null,
	};
	/** Starts the worker host and connects the parent, as the foreman's host does before it sends a prompt. */
	const start = async () => {
		const host = await startHost(config);
		state.host = host;
		cleanup.push(() => host.stop());
		const parent = new Peer(createConnection(host.identity.socket), async (method) => {
			if (method === 'assignment') {
				state.asked++;
				return state.answer;
			}
			if (method === 'report') return { accepted: true };
			throw new Error(`Unknown method ${method}`);
		});
		state.parent = parent;
		cleanup.push(async () => parent.close());
		await parent.request('handshake', {
			protocolVersion: 1,
			key: task,
			instance: host.identity.instance,
			role: 'crew',
			token: host.identity.crewToken,
		});
		await expect
			.poll(
				async () => ((await parent.request('status', {})) as { connected: boolean }).connected,
				{ timeout: 10_000 }
			)
			.toBe(true);
	};
	const records = () => state.host!.records as EventRecord[];
	const ended = () => records().filter((record) => record.event.kind === 'turn.completed').length;
	/** One prompt from the parent, to the end of its turn. */
	const prompt = async (text: string) => {
		const before = ended();
		await state.parent!.request('command', { kind: 'prompt', text });
		await expect.poll(ended, { timeout: 10_000 }).toBe(before + 1);
	};
	const entries = async () =>
		(await readFile(log, 'utf8'))
			.trim()
			.split('\n')
			.map((line) => JSON.parse(line) as { event: string; params: unknown });
	/** The `Brigadir assignment` block of each prompt the agent got, in order; null — none. */
	const blocks = async () =>
		(await entries())
			.filter((entry) => entry.event === 'prompt-blocks')
			.map((entry) => {
				const block = (entry.params as { type: string; text?: string }[]).find((item) =>
					item.text?.startsWith('<attached_context name="Brigadir assignment">')
				);
				return block?.text ?? null;
			});
	const steers = async () =>
		(await entries())
			.filter((entry) => entry.event === 'steer')
			.map((entry) => (entry.params as { text: string }).text);
	const restored = () =>
		records().flatMap((record) =>
			record.event.kind === 'crew.assignment.restored' ? [record.event] : []
		);
	const compactions = () =>
		records().flatMap((record) => (record.event.kind === 'context.compacted' ? [record.seq] : []));
	return {
		state,
		start,
		stop: () => state.host!.stop(),
		records,
		prompt,
		blocks,
		steers,
		restored,
		compactions,
	};
}

it('steers the part back into the running turn at the next step boundary, once per compaction, also a second time in the same part (spec/crew#assignment-after-compaction)', async () => {
	const w = await worker();
	await w.start();
	await w.prompt('compact-step one');
	const [steer] = await w.steers();
	expect(steer).toBe(
		`<attached_context name="Brigadir assignment">\n${assignmentHeader}\n\n${part.text}\n</attached_context>`
	);
	expect(w.restored()).toEqual([
		{ kind: 'crew.assignment.restored', compactedSeq: w.compactions()[0], assignment: ['part'] },
	]);
	// Hidden: no steered prompt, no second turn, and the agent heard it inside the turn.
	const kinds = w.records().map((record) => record.event.kind);
	expect(kinds).not.toContain('prompt.steered');
	expect(kinds.filter((kind) => kind === 'turn.started')).toHaveLength(1);
	expect(JSON.stringify(w.records())).not.toContain('PART-PROMPT-MARK');
	expect(
		w
			.records()
			.some(
				(record) =>
					record.event.kind === 'message.delta' &&
					record.event.content.kind === 'text' &&
					record.event.content.text === 'steered'
			)
	).toBe(true);
	// The next prompt gets nothing more; a second compaction in the same part gets the assignment again.
	await w.prompt('plain');
	await w.prompt('compact-step two');
	expect(await w.steers()).toHaveLength(2);
	expect(w.restored().map((event) => event.compactedSeq)).toEqual(w.compactions());
	expect(await w.blocks()).toEqual([null, null, null]);
}, 60_000);

it('gives an idle member its part with the next prompt — a Codex compaction journaled at the turn end — and only once (spec/crew#assignment-after-compaction)', async () => {
	const w = await worker();
	await w.start();
	await w.prompt('compact-late');
	expect(w.compactions()).toHaveLength(1);
	// No step boundary came: the turn ended with the assignment still due.
	expect(w.restored()).toEqual([]);
	expect(await w.steers()).toEqual([]);
	await w.prompt('Fix the phone format.');
	await w.prompt('And the label.');
	const blocks = await w.blocks();
	expect(blocks[0]).toBeNull();
	expect(blocks[1]).toContain(`${assignmentHeader}\n\n${part.text}`);
	expect(blocks[2]).toBeNull();
	expect(w.restored()).toEqual([
		{ kind: 'crew.assignment.restored', compactedSeq: w.compactions()[0], assignment: ['part'] },
	]);
	// The block is journaled as a fact, never as text.
	expect(JSON.stringify(w.records())).not.toContain('PART-PROMPT-MARK');
}, 60_000);

it('gives the part after a restart between the compaction and the next prompt, and not again after it (spec/crew#assignment-after-compaction)', async () => {
	const w = await worker();
	await w.start();
	await w.prompt('compact-late');
	await w.stop();
	await w.start();
	await w.prompt('Go on.');
	await w.prompt('More.');
	const blocks = await w.blocks();
	expect(blocks.at(-2)).toContain(part.text);
	expect(blocks.at(-1)).toBeNull();
	expect(w.restored()).toEqual([
		{ kind: 'crew.assignment.restored', compactedSeq: w.compactions()[0], assignment: ['part'] },
	]);
	// A third host start finds the compaction answered.
	await w.stop();
	await w.start();
	await w.prompt('Once more.');
	expect((await w.blocks()).at(-1)).toBeNull();
}, 90_000);

it('gives nothing without an open part or when the prompt is the assignment itself, and answers the compaction (spec/crew#assignment-after-compaction)', async () => {
	const w = await worker();
	w.state.answer = null;
	await w.start();
	await w.prompt('compact-step');
	expect(await w.steers()).toEqual([]);
	expect(w.restored()).toEqual([
		{ kind: 'crew.assignment.restored', compactedSeq: w.compactions()[0], assignment: [] },
	]);
	// The next part's prompt carries the assignment: no block rides on it.
	w.state.answer = part;
	await w.prompt('compact-late');
	await w.prompt('Part 2 of your work: Client details.\n\nPART-PROMPT-MARK');
	expect(await w.blocks()).toEqual([null, null, null]);
	expect(w.restored().at(-1)).toEqual({
		kind: 'crew.assignment.restored',
		compactedSeq: w.compactions()[1],
		assignment: [],
	});
	expect(w.state.asked).toBe(2);
}, 60_000);

it('keeps the assignment due while the parent does not answer, and gives it once the parent is back (spec/crew#assignment-after-compaction)', async () => {
	const w = await worker();
	await w.start();
	await w.prompt('compact-late');
	// The parent's host went away: the person's prompt goes without the block, which stays due.
	w.state.parent!.close();
	const { connectHost } = await import('./client');
	const ui = await connectHost(w.state.host!.identity);
	cleanup.push(async () => ui.close());
	const before = w.records().filter((record) => record.event.kind === 'turn.completed').length;
	await ui.command({ kind: 'prompt', text: 'Are you there?' });
	await expect
		.poll(() => w.records().filter((record) => record.event.kind === 'turn.completed').length, {
			timeout: 10_000,
		})
		.toBe(before + 1);
	expect(w.restored()).toEqual([]);
	await w.stop();
	await w.start();
	await w.prompt('Back.');
	expect((await w.blocks()).at(-1)).toContain(part.text);
	expect(w.restored()).toHaveLength(1);
}, 90_000);

it('writes nothing for a compaction of a solo task (spec/crew#assignment-after-compaction)', async () => {
	const root = await mkdtemp(join(tmpdir(), 'brigadir-crew-assignment-solo-'));
	cleanup.push(() => rm(root, { recursive: true, force: true }));
	const repo = join(root, 'repo');
	await mkdir(repo);
	await gitText(repo, ['init', '-b', 'main']);
	const store = await SessionStore.at(join(root, 'data'));
	await mkdir(store.root, { recursive: true });
	await writeFile(join(root, 'agent.jsonl'), '');
	const project = await store.addProject(repo),
		task = await store.createTask(project.id, 'Solo', 'claude');
	const host = await startHost({
		key: task,
		dataDir: store.root,
		mcpEntry: resolve('apps/desktop/out/services/mcp-relay'),
		adapter: {
			command: process.execPath,
			args: [resolve('packages/transport/fixtures/agent.mjs'), 'crew-compaction'],
		},
	});
	cleanup.push(() => host.stop());
	const { connectHost } = await import('./client');
	const ui = await connectHost(host.identity);
	cleanup.push(async () => ui.close());
	await expect.poll(async () => (await ui.status()).connected, { timeout: 10_000 }).toBe(true);
	await ui.command({ kind: 'prompt', text: 'compact-step' });
	await expect
		.poll(() => host.records.some((record) => record.event.kind === 'turn.completed'), {
			timeout: 10_000,
		})
		.toBe(true);
	expect(host.records.some((record) => record.event.kind === 'context.compacted')).toBe(true);
	expect(host.records.some((record) => record.event.kind === 'crew.assignment.restored')).toBe(
		false
	);
}, 60_000);

it('gives a reviewer its open check back, but not with the check prompt itself (spec/crew#assignment-after-compaction)', async () => {
	const w = await worker('reviewer');
	const check: CrewAssignment = {
		kind: 'check',
		text: 'Check task t1 of `Developer` (reviewId r1, round 1 of 2).\nRead the report with read_report and the change with read_diff, passing this reviewId.',
		marker: 'reviewId r1, round 1 ',
	};
	w.state.answer = check;
	await w.start();
	await w.prompt('compact-step');
	expect((await w.steers())[0]).toContain(`${assignmentHeader}\n\n${check.text}`);
	await w.prompt('compact-late');
	await w.prompt(
		'Check task t1 of `Developer` (reviewId r1, round 1 of 2).\nReport from `Developer`'
	);
	await w.prompt('compact-late');
	await w.prompt('Did you finish?');
	expect((await w.blocks()).slice(2)).toEqual([null, null, expect.stringContaining(check.text)]);
	expect(w.restored().map((event) => event.assignment)).toEqual([['check'], [], ['check']]);
}, 60_000);
