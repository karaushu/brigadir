import { afterEach, describe, expect, it } from 'vitest';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { spawn, execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { SessionStore, atomicJson } from '@brigadir/persistence';
import {
	figmaLinks,
	figmaNodeId,
	isSessionEvent,
	type DesignReview,
	type EventRecord,
	type TaskKey,
} from '@brigadir/core';
import { connectHost, readIdentity, type HostClient } from './index';
import {
	checkDesignInput,
	designAnswer,
	designGate,
	designPrompt,
	imageKind,
	readDesignImage,
} from './design-review';

/** spec/design-review: the contract a task's agent files and what the host verifies by itself, end to end through the built host. */
const run = promisify(execFile);
const cleanup: (() => Promise<unknown>)[] = [];
afterEach(async () => {
	for (const fn of cleanup.splice(0).reverse()) await fn();
});
const delay = (ms: number) => new Promise((done) => setTimeout(done, ms));
async function until<T>(read: () => Promise<T | undefined>, timeout = 15000): Promise<T> {
	const end = Date.now() + timeout;
	while (Date.now() < end) {
		const value = await read();
		if (value !== undefined) return value;
		await delay(25);
	}
	throw new Error('Condition timed out');
}
const png = Buffer.from(
	'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==',
	'base64'
);
async function setup() {
	const root = await mkdtemp(join(tmpdir(), 'brigadir-design-'));
	cleanup.push(() => rm(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 }));
	const repo = join(root, 'repo');
	await mkdir(repo);
	await run('git', ['init', '-q', '-b', 'main'], { cwd: repo });
	await writeFile(join(repo, 'README.md'), 'hello\n');
	await run('git', ['add', '-A'], { cwd: repo });
	await run('git', ['-c', 'user.name=t', '-c', 'user.email=t@t', 'commit', '-q', '-m', 'seed'], {
		cwd: repo,
	});
	const figma = join(root, 'header.png');
	await writeFile(figma, png);
	await writeFile(join(root, 'not-an-image.png'), 'text');
	const store = await SessionStore.at(join(root, 'data'));
	// The simulator module is off by default; the person turned it on.
	await mkdir(store.root, { recursive: true });
	await atomicJson(join(store.root, 'settings.json'), {
		schemaVersion: 1,
		settings: { modules: { simulator: true } },
	});
	const project = await store.addProject(repo);
	const task = await store.createTask(project.id, 'Details screen', 'claude');
	return { root, repo, store, key: { projectId: task.projectId, id: task.id }, figma };
}
/** The built host with the scripted agent; the app side answers the simulator's screenshot with a PNG. */
async function launch(store: SessionStore, key: TaskKey) {
	const config = join(await store.taskDir(key), 'config.json');
	await atomicJson(config, {
		schemaVersion: 1,
		dataDir: store.root,
		key,
		mcpEntry: resolve('apps/desktop/out/services/mcp-relay'),
		adapter: {
			command: process.execPath,
			args: [resolve('packages/transport/fixtures/agent.mjs'), 'crew'],
		},
	});
	const child = spawn(process.execPath, [resolve('apps/desktop/out/services/host.cjs'), config], {
		stdio: 'pipe',
	});
	let diagnostics = '';
	child.stderr.on('data', (chunk) => {
		diagnostics += chunk;
	});
	const stop = async () => {
		if (child.exitCode === null && child.signalCode === null) {
			child.kill('SIGTERM');
			await until(async () =>
				child.exitCode !== null || child.signalCode !== null ? true : undefined
			).catch(() => child.kill('SIGKILL'));
		}
	};
	cleanup.push(stop);
	const identity = await until(async () => {
		if (child.exitCode !== null) throw new Error(diagnostics);
		const id = await readIdentity(store, key);
		return id && id.pid === child.pid ? id : undefined;
	});
	const client = await connectHost(
		identity,
		() => {},
		() => {},
		() => {},
		async (method, params) => {
			if (method === 'simulator' && (params as { tool?: string }).tool === 'screenshot')
				return { image: png.toString('base64'), mimeType: 'image/png', device: 'iPhone 17 Pro' };
			throw new Error('Unavailable in the test');
		}
	);
	cleanup.push(async () => client.close());
	await until(async () => ((await client.snapshot()).connected ? true : undefined));
	await client.startAgent();
	await until(async () =>
		(await client.snapshot()).records.find((r) => r.event.kind === 'session.started')
	);
	return { client, stop };
}
/** Sends one scripted turn and waits for its end; returns the records after it. */
async function turn(client: HostClient, text: string) {
	const before = (await client.snapshot()).records.at(-1)?.seq ?? 0;
	await client.command({ kind: 'prompt', text });
	await until(async () =>
		(await client.snapshot()).records.find(
			(r) => r.seq > before && r.event.kind === 'turn.completed'
		)
	);
	return (await client.snapshot()).records.filter((r) => r.seq > before);
}
const reviewed = (records: EventRecord[]) => {
	const found = records.findLast((r) => r.event.kind === 'design.reviewed');
	if (found?.event.kind !== 'design.reviewed') throw new Error('No design review');
	return found.event;
};
const agentText = (records: EventRecord[]) =>
	records
		.map((r) =>
			r.event.kind === 'message.delta' && r.event.content.kind === 'text'
				? r.event.content.text
				: ''
		)
		.join('')
		.trim();
const node = (figma: string, shot: string, match = true, extra: Record<string, unknown> = {}) => ({
	name: 'Header',
	figma: 'https://www.figma.com/design/AbC123/Client?node-id=412-88',
	figmaImage: figma,
	shot,
	rows: [
		{ property: 'Title', expected: '17 / 600', actual: '17 / 600', match: true },
		{
			property: 'Avatar',
			expected: '56 px',
			actual: match ? '56 px' : '48 px',
			match,
			...(match ? {} : { area: { x: 0.1, y: 0.1, width: 0.2, height: 0.1 } }),
		},
	],
	...extra,
});
const submit = (nodes: unknown[], verdict: 'passed' | 'mismatch') =>
	`@call submit_design_review ${JSON.stringify({ screen: 'Details screen', nodes, verdict })}`;

describe('design review through the host', () => {
	it('keeps screenshots, verifies every node and survives a restart', async () => {
		const { store, key, figma, root } = await setup();
		let { client, stop } = await launch(store, key);

		// spec/design-review#shots: a screenshot is kept under an id and the answer names it.
		const shot = await turn(client, '@call simulator_screenshot {}');
		expect(agentText(shot)).toContain('Saved as s1. Pass it as shot to submit_design_review.');
		const index = JSON.parse(
			await readFile(join(await store.taskDir(key), 'shots', 'shots.json'), 'utf8')
		);
		expect(index.shots).toMatchObject([{ id: 's1', file: 'shots/s1.png', tool: 'simulator' }]);
		expect(index.shots[0].trees.length).toBeGreaterThan(0);

		// A passed contract: both images, a current screenshot, every row matches.
		let records = await turn(client, submit([node(figma, 's1')], 'passed'));
		let event = reviewed(records);
		expect(isSessionEvent(event)).toBe(true);
		expect(event).toMatchObject({ state: 'passed', verdict: 'passed', screen: 'Details screen' });
		expect(event.nodes[0]).toMatchObject({
			state: 'ok',
			shot: { id: 's1', file: 'shots/s1.png', device: 'iPhone 17 Pro' },
		});
		expect(event.nodes[0]!.figmaFile).toMatch(/^design\/[^/]+\/figma-1\.png$/);
		expect(agentText(records)).toContain('The design review passed.');

		// A mismatch: the rows are accepted, the state says so, the answer asks for a fix.
		records = await turn(client, submit([node(figma, 's1', false)], 'mismatch'));
		event = reviewed(records);
		expect(event.state).toBe('mismatch');
		expect(agentText(records)).toContain('Fix the mismatches');

		// `passed` with a mismatching row is not accepted as passed.
		records = await turn(client, submit([node(figma, 's1', false)], 'passed'));
		expect(reviewed(records).state).toBe('mismatch');
		expect(agentText(records)).toContain('The verdict passed is not accepted');

		// A missing screenshot (an id this task never took) and a missing design image refuse their nodes.
		records = await turn(
			client,
			submit(
				[node(figma, 's99'), node(join(root, 'not-an-image.png'), 's1', true, { name: 'Tabs' })],
				'passed'
			)
		);
		event = reviewed(records);
		expect(event.state).toBe('refused');
		expect(event.nodes.map((item) => item.state)).toEqual(['no-shot', 'no-figma']);
		expect(agentText(records)).toContain('s99 is not a screenshot of this task');
		expect(agentText(records)).toContain('it is not a PNG, JPEG or WebP image');

		// An old screenshot: the files changed after s1.
		await turn(client, '@write src/Details.tsx export const avatar = 56;');
		records = await turn(client, submit([node(figma, 's1')], 'passed'));
		event = reviewed(records);
		expect(event.state).toBe('refused');
		expect(event.nodes[0]!.state).toBe('old-shot');
		expect(agentText(records)).toContain('s1 was taken before the files changed');

		// A restart: the shots and the design reviews are read from disk; the next shot continues the numbering.
		await stop();
		({ client, stop } = await launch(store, key));
		expect(agentText(await turn(client, '@call simulator_screenshot {}'))).toContain(
			'Saved as s2.'
		);
		records = await turn(client, submit([node(figma, 's2')], 'passed'));
		expect(reviewed(records).state).toBe('passed');
		const doc = JSON.parse(
			await readFile(join(await store.taskDir(key), 'design', 'design-reviews.json'), 'utf8')
		);
		expect(doc.reviews.map((review: DesignReview) => review.state)).toEqual([
			'passed',
			'mismatch',
			'mismatch',
			'refused',
			'refused',
			'passed',
		]);
	}, 60_000);
});

describe('design review rules', () => {
	it('finds Figma links and node ids', () => {
		const text =
			'Build it: https://www.figma.com/design/AbC123/Client?node-id=412-88&t=x. Also https://figma.com/file/Zz9/x, not https://example.com.';
		expect(figmaLinks(text)).toEqual([
			'https://www.figma.com/design/AbC123/Client?node-id=412-88&t=x',
			'https://figma.com/file/Zz9/x',
		]);
		expect(figmaNodeId(figmaLinks(text)[0]!)).toBe('412:88');
	});
	it('reads images by their bytes', async () => {
		expect(imageKind(png)).toBe('png');
		expect(imageKind(Buffer.from([0xff, 0xd8, 0xff, 0]))).toBe('jpg');
		expect(imageKind(Buffer.from('RIFF0000WEBP', 'latin1'))).toBe('webp');
		expect(imageKind(Buffer.from('text'))).toBe(null);
		expect(await readDesignImage('relative.png')).toEqual({ reason: 'the path is not absolute' });
		const fetcher = (async () => new Response(png, { status: 200 })) as typeof fetch;
		expect(await readDesignImage('http://localhost:3845/assets/a.png', fetcher)).toMatchObject({
			kind: 'png',
		});
		const failing = (async () => new Response('', { status: 404 })) as typeof fetch;
		expect(await readDesignImage('https://x.test/a.png', failing)).toEqual({
			reason: 'the address answered 404',
		});
	});
	it('checks the input', () => {
		expect(() => checkDesignInput({ screen: 'S', nodes: [], verdict: 'passed' })).toThrow(
			'nodes: 1 to 24'
		);
		expect(() =>
			checkDesignInput({
				screen: 'S',
				verdict: 'passed',
				nodes: [{ name: 'N', figma: 'f', figmaImage: '/a.png', shot: 's1', rows: [{}] }],
			})
		).toThrow('needs property, expected, actual and match');
	});
	const review = (state: DesignReview['state'], trees: string[]): DesignReview => ({
		id: 'd1',
		screen: 'Details screen',
		at: '2026-11-19T10:00:00.000Z',
		state,
		verdict: 'passed',
		trees: trees.map((tree, index) => ({ scopeId: `s${index}`, tree })),
		nodes: [
			{
				name: 'Header',
				figma: '412:88',
				figmaFile: 'design/d1/figma-1.png',
				shot: { id: 's1', file: 'shots/s1.png', at: '2026-11-19T10:00:00.000Z' },
				state: 'ok',
				rows: [{ property: 'Avatar', expected: '56 px', actual: '48 px', match: false }],
			},
		],
	});
	it('gates an approval on a passed design review of the round', () => {
		const base = { links: [], own: [], reviewer: [], round: [{ tree: 'a' }], taskDir: '/t' };
		// No design source: nothing to gate.
		expect(designGate(base, false)).toBe(null);
		expect(designPrompt(base)).toBe('');
		// A Figma link and no design review: refused, and the prompt says none was filed.
		const linked = { ...base, links: ['https://www.figma.com/design/A/B?node-id=1-2'] };
		expect(designGate(linked, false)).toContain('no design review was filed');
		expect(designPrompt(linked)).toContain('The task has filed no design review.');
		// A mismatch is refused; its rows and images reach the reviewer's prompt.
		const mismatch = { ...linked, own: [review('mismatch', ['a'])] };
		expect(designGate(mismatch, false)).toContain('Details screen: mismatch');
		expect(designPrompt(mismatch)).toContain('MISMATCH Avatar: expected 56 px, on device 48 px');
		expect(designPrompt(mismatch)).toContain('device /t/shots/s1.png');
		// A passed design review of another state does not cover the round.
		const stale = { ...linked, own: [review('passed', ['b'])] };
		expect(designGate(stale, true)).toContain('on another state of the files');
		expect(designGate(stale, true)).toContain('replyTo');
		// A passed one of the round's trees, the task's own or the reviewer's, lets it go.
		expect(designGate({ ...linked, own: [review('passed', ['a'])] }, false)).toBe(null);
		expect(designGate({ ...linked, reviewer: [review('passed', ['a', 'z'])] }, false)).toBe(null);
	});
	it('answers with what to redo', () => {
		const answer = designAnswer({
			...review('refused', ['a']),
			nodes: [
				{
					...review('refused', ['a']).nodes[0]!,
					state: 'old-shot',
					reason: 's1 was taken before the files changed.',
				},
			],
		});
		expect(answer).toMatchObject({
			state: 'refused',
			accepted: 0,
			notAccepted: 1,
			redo: [{ node: 'Header', state: 'old-shot' }],
			mismatches: [],
		});
		expect(answer.next).toContain('The verdict passed is not accepted');
	});
});
