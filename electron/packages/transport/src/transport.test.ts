import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { AgentEvent } from '@brigadir/core';
import { AgentTransport, type TransportOptions } from './transport';
let directory: string;
let events: AgentEvent[];
const transports: AgentTransport[] = [];
beforeEach(async () => {
	directory = await mkdtemp(join(tmpdir(), 'brigadir-transport-'));
	events = [];
});
afterEach(async () => {
	for (const transport of transports.splice(0)) {
		transport.close();
		await transport.closed;
	}
	await rm(directory, { recursive: true, force: true });
});
const fixture = fileURLToPath(new URL('../fixtures/agent.mjs', import.meta.url));
function config(scenario = 'normal', overrides: Partial<TransportOptions> = {}): TransportOptions {
	return {
		provider: 'codex',
		cwd: directory,
		startupTimeoutMs: 3000,
		adapter: {
			command: process.execPath,
			args: [fixture, scenario, join(directory, 'wire.jsonl')],
		},
		onEvent: (event) => {
			events.push(event);
		},
		...overrides,
	};
}
async function start(scenario = 'normal', overrides: Partial<TransportOptions> = {}) {
	const transport = await AgentTransport.start(config(scenario, overrides));
	transports.push(transport);
	return transport;
}
async function wire() {
	return (await readFile(join(directory, 'wire.jsonl'), 'utf8'))
		.trim()
		.split('\n')
		.map((line) => JSON.parse(line) as { event: string; params: unknown });
}
function deferred<T>() {
	let resolve!: (value: T) => void;
	const promise = new Promise<T>((done) => {
		resolve = done;
	});
	return { promise, resolve };
}
it('negotiates capabilities, forwards MCP definitions and streams portable events in order', async () => {
	const mcpServers = [
		{ name: 'fixture', command: process.execPath, args: ['fixture.mjs'], env: [] },
	];
	const transport = await start('normal', { mcpServers });
	await transport.send({ kind: 'prompt', text: 'hello' });
	expect(events.map((event) => event.kind)).toEqual([
		'session.started',
		'message.delta',
		'message.delta',
		'turn.completed',
	]);
	expect(events.at(-1)).toEqual({ kind: 'turn.completed', reason: 'end_turn' });
	const requests = await wire();
	expect(requests.find((r) => r.event === 'initialize')?.params).toMatchObject({
		clientCapabilities: {
			fs: { readTextFile: false, writeTextFile: false },
			terminal: false,
			plan: {},
		},
	});
	expect(requests.find((r) => r.event === 'new')?.params).toEqual({ cwd: directory, mcpServers });
	expect(JSON.stringify(events)).not.toContain('sessionUpdate');
});
it('validates options against the live catalog and sends typed boolean values', async () => {
	const transport = await start();
	await expect(
		transport.send({ kind: 'setOption', id: 'model', value: 'invented' })
	).rejects.toThrow('catalog');
	await expect(transport.send({ kind: 'setMode', modeId: 'invented' })).rejects.toThrow('catalog');
	await transport.send({ kind: 'setOption', id: 'model', value: 'other' });
	await transport.send({ kind: 'setOption', id: 'fast', value: true });
	await transport.send({ kind: 'setMode', modeId: 'manual' });
	expect(
		(await wire()).filter((event) => event.event === 'option').map((event) => event.params)
	).toEqual([
		{ sessionId: 'fixture-session', configId: 'model', value: 'other' },
		{ sessionId: 'fixture-session', configId: 'fast', type: 'boolean', value: true },
	]);
});
it('keeps the prompt blocked until a valid permission choice arrives', async () => {
	const requested = deferred<void>();
	const decision = deferred<string | null>();
	const transport = await start('normal', {
		requestPermission: async () => {
			requested.resolve();
			return decision.promise;
		},
	});
	const prompt = transport.send({ kind: 'prompt', text: 'permission' });
	await requested.promise;
	expect(events.at(-1)?.kind).toBe('permission.requested');
	expect(events.some((event) => event.kind === 'turn.completed')).toBe(false);
	await expect(transport.send({ kind: 'prompt', text: 'overlap' })).rejects.toThrow(
		'already running'
	);
	decision.resolve('allow');
	await prompt;
	expect(events.at(-1)).toEqual({ kind: 'turn.completed', reason: 'end_turn' });
});
it('answers a preapproved permission with no event and no callback (spec/agents-and-providers#tool-permissions)', async () => {
	let asked = false;
	const transport = await start('normal', {
		preapprove: () => 'allow',
		requestPermission: async () => {
			asked = true;
			return null;
		},
	});
	await transport.send({ kind: 'prompt', text: 'permission' });
	expect(asked).toBe(false);
	expect(events.some((event) => event.kind === 'permission.requested')).toBe(false);
	expect((await wire()).find((event) => event.event === 'permission-result')?.params).toEqual({
		outcome: { outcome: 'selected', optionId: 'allow' },
	});
});
it('cancels a blocked permission even if the UI callback ignores its abort signal', async () => {
	const requested = deferred<void>();
	const transport = await start('normal', {
		requestPermission: async () => {
			requested.resolve();
			return new Promise(() => {});
		},
	});
	const prompt = transport.send({ kind: 'prompt', text: 'permission' });
	await requested.promise;
	await transport.send({ kind: 'cancel' });
	await prompt;
	expect(events.at(-1)).toEqual({ kind: 'turn.completed', reason: 'cancelled' });
	expect((await wire()).find((event) => event.event === 'permission-result')?.params).toEqual({
		outcome: { outcome: 'cancelled' },
	});
});
it('refuses an invented permission option instead of granting it', async () => {
	const transport = await start('normal', { requestPermission: async () => 'invented' });
	await expect(transport.send({ kind: 'prompt', text: 'permission' })).rejects.toThrow();
	expect(events.at(-1)?.kind).toBe('session.failed');
});
it('loads only when initialize advertises support', async () => {
	const transport = await start('normal', { resumeSessionId: 'fixture-session' });
	expect(transport.id).toBe('fixture-session');
	expect((await wire()).some((event) => event.event === 'load')).toBe(true);
	await expect(
		AgentTransport.start(config('no-load', { resumeSessionId: 'fixture-session' }))
	).rejects.toThrow('cannot load');
});
it('times out initialization and surfaces process exit without hanging', async () => {
	await expect(
		AgentTransport.start(config('hang-init', { startupTimeoutMs: 100 }))
	).rejects.toThrow('timed out');
	const transport = await start();
	await expect(transport.send({ kind: 'prompt', text: 'exit' })).rejects.toThrow();
	await transport.closed;
	await expect(transport.send({ kind: 'prompt', text: 'after exit' })).rejects.toThrow('closed');
});
it('closing a pending permission aborts the UI waiter and rejects the prompt', async () => {
	const requested = deferred<void>();
	let signal: AbortSignal | undefined;
	const transport = await start('normal', {
		requestPermission: async (_request, s) => {
			signal = s;
			requested.resolve();
			return new Promise(() => {});
		},
	});
	const prompt = transport.send({ kind: 'prompt', text: 'permission' });
	const rejected = expect(prompt).rejects.toThrow();
	await requested.promise;
	transport.close();
	await rejected;
	expect(signal?.aborted).toBe(true);
});
it('keeps the Codex human-tool timeout in the complete launch configuration', async () => {
	const mcpServers = [
		{
			name: 'brigadir',
			command: process.execPath,
			args: ['mcp.cjs'],
			env: [{ name: 'TEST_SOCKET', value: 'fixture' }],
		},
	];
	const transport = await start('normal', { mcpServers });
	await transport.send({ kind: 'prompt', text: 'hello' });
	const requests = await wire();
	expect(requests.find((r) => r.event === 'new')?.params).toEqual({
		cwd: directory,
		mcpServers: [],
	});
	expect(requests.find((r) => r.event === 'codex-config')?.params).toMatchObject({
		mcp_servers: {
			brigadir: {
				command: process.execPath,
				args: ['mcp.cjs'],
				env: { TEST_SOCKET: 'fixture' },
				tool_timeout_sec: 604800,
			},
		},
	});
});
it('turns on the task tool of Claude unless the person set it (spec/chat-turns-plans-and-questions#checklist-tools)', async () => {
	const previous = process.env.CLAUDE_CODE_ENABLE_TODO_TOOLS;
	delete process.env.CLAUDE_CODE_ENABLE_TODO_TOOLS;
	try {
		(await start('normal', { provider: 'claude' })).close();
		expect((await wire()).find((r) => r.event === 'todo-tools')?.params).toBe('1');
		await rm(join(directory, 'wire.jsonl'));
		(await start()).close();
		expect((await wire()).some((r) => r.event === 'todo-tools')).toBe(false);
		await rm(join(directory, 'wire.jsonl'));
		process.env.CLAUDE_CODE_ENABLE_TODO_TOOLS = '0';
		(await start('normal', { provider: 'claude' })).close();
		expect((await wire()).find((r) => r.event === 'todo-tools')?.params).toBe('0');
	} finally {
		if (previous === undefined) delete process.env.CLAUDE_CODE_ENABLE_TODO_TOOLS;
		else process.env.CLAUDE_CODE_ENABLE_TODO_TOOLS = previous;
	}
});
it('lets a brigadir tool of Claude wait for the person past the 30-minute idle limit unless the person set it', async () => {
	const previous = process.env.CLAUDE_CODE_MCP_TOOL_IDLE_TIMEOUT;
	delete process.env.CLAUDE_CODE_MCP_TOOL_IDLE_TIMEOUT;
	const brigadir = [{ name: 'brigadir', command: process.execPath, args: ['mcp.cjs'], env: [] }];
	try {
		(await start('normal', { provider: 'claude', mcpServers: brigadir })).close();
		expect((await wire()).find((r) => r.event === 'mcp-idle-timeout')?.params).toBe('604800000');
		await rm(join(directory, 'wire.jsonl'));
		(await start('normal', { provider: 'claude' })).close();
		expect((await wire()).some((r) => r.event === 'mcp-idle-timeout')).toBe(false);
		await rm(join(directory, 'wire.jsonl'));
		process.env.CLAUDE_CODE_MCP_TOOL_IDLE_TIMEOUT = '5000';
		(await start('normal', { provider: 'claude', mcpServers: brigadir })).close();
		expect((await wire()).find((r) => r.event === 'mcp-idle-timeout')?.params).toBe('5000');
	} finally {
		if (previous === undefined) delete process.env.CLAUDE_CODE_MCP_TOOL_IDLE_TIMEOUT;
		else process.env.CLAUDE_CODE_MCP_TOOL_IDLE_TIMEOUT = previous;
	}
});
it('turns on the plan tool of Codex unless the person set it (spec/chat-turns-plans-and-questions#checklist-tools)', async () => {
	const previous = process.env.CODEX_CONFIG;
	delete process.env.CODEX_CONFIG;
	try {
		(await start()).close();
		expect((await wire()).find((r) => r.event === 'codex-config')?.params).toEqual({
			tools: { update_plan: { enabled: true } },
		});
		await rm(join(directory, 'wire.jsonl'));
		process.env.CODEX_CONFIG = JSON.stringify({
			tools: { update_plan: { enabled: false }, web_search: true },
		});
		(await start()).close();
		expect((await wire()).find((r) => r.event === 'codex-config')?.params).toEqual({
			tools: { update_plan: { enabled: false }, web_search: true },
		});
	} finally {
		if (previous === undefined) delete process.env.CODEX_CONFIG;
		else process.env.CODEX_CONFIG = previous;
	}
});
it('sends actual ACP image and text blocks and honors negotiated image support', async () => {
	const image = {
		kind: 'image' as const,
		name: 'Screen',
		mimeType: 'image/png' as const,
		data: 'iVBORw0KGgo=',
	};
	const transport = await start();
	await transport.send({ kind: 'prompt', text: '' }, [
		image,
		{ kind: 'text', name: 'Build output', text: 'Error: fixture' },
	]);
	expect((await wire()).find((row) => row.event === 'prompt-blocks')?.params).toEqual([
		{ type: 'image', mimeType: 'image/png', data: image.data },
		{
			type: 'text',
			text: '<attached_context name="Build output">\nError: fixture\n</attached_context>',
		},
	]);
	const unsupported = await start('no-image');
	expect(() => unsupported.validateAttachments([image])).toThrow('does not support');
	await expect(unsupported.send({ kind: 'prompt', text: 'Look' }, [image])).rejects.toThrow(
		'does not support'
	);
});
it('puts mentioned attachments where the text places them, a model as text, the rest after the text (spec/composer#mentions)', async () => {
	const image = {
		kind: 'image' as const,
		name: 'Screen',
		mimeType: 'image/png' as const,
		data: 'iVBORw0KGgo=',
		id: '11111111-1111-4111-8111-111111111111',
	};
	const file = {
		kind: 'text' as const,
		name: 'kit/src/Button.tsx',
		text: 'export const Button',
		id: '22222222-2222-4222-8222-222222222222',
	};
	const transport = await start();
	await transport.send(
		{
			kind: 'prompt',
			text: `Fix @[att:${file.id}] with @[model:claude:sonnet], Safari: @[att:${image.id}]`,
		},
		[image, file, { kind: 'text', name: 'Workspace repositories', text: 'kit' }]
	);
	expect((await wire()).find((row) => row.event === 'prompt-blocks')?.params).toEqual([
		{ type: 'text', text: 'Fix ' },
		{
			type: 'text',
			text: '<attached_context name="kit/src/Button.tsx">\nexport const Button\n</attached_context>',
		},
		{ type: 'text', text: ' with `sonnet` (Claude), Safari: ' },
		{ type: 'image', mimeType: 'image/png', data: image.data },
		{
			type: 'text',
			text: '<attached_context name="Workspace repositories">\nkit\n</attached_context>',
		},
	]);
});
it('negotiates additional roots for new/load, clears them on load and omits unsupported fields', async () => {
	const child = join(directory, 'child');
	await start('directories', { additionalDirectories: [child, child] });
	await start('directories', { resumeSessionId: 'fixture-session', additionalDirectories: [] });
	await start('normal', { additionalDirectories: [child] });
	const requests = (await wire()).filter(
		(entry) => entry.event === 'new' || entry.event === 'load'
	);
	expect(requests.map((entry) => entry.params)).toEqual([
		{ cwd: directory, mcpServers: [], additionalDirectories: [child] },
		{ cwd: directory, mcpServers: [], sessionId: 'fixture-session', additionalDirectories: [] },
		{ cwd: directory, mcpServers: [] },
	]);
	await expect(
		AgentTransport.start(config('directories', { additionalDirectories: ['relative'] }))
	).rejects.toThrow('must be absolute');
});

// spec/composer-steering-queue-and-ghost#steering: the codex-shaped adopted turn — a steer after our prompt's answer, one chunk with many lines, a silent turn.
const steerBegin = async () => {
	events.push({ kind: 'unhandled', name: 'BEGIN' });
};
it('adopts a turn when the steer goes out after our prompt was answered but before its turn.completed is journaled', async () => {
	let transport!: AgentTransport;
	let steered: ReturnType<AgentTransport['steer']> | undefined;
	transport = await start('steering-codex', {
		onEvent: async (event) => {
			events.push(event);
			if (event.kind === 'turn.completed' && !steered) {
				steered = transport.steer('late', [], [], steerBegin);
				await new Promise((resolve) => setTimeout(resolve, 300));
			}
		},
	});
	await transport.send({ kind: 'prompt', text: 'hello' });
	const result = await steered!;
	expect(result.outcome).toBe('adopted');
	if (result.outcome === 'adopted') await result.finished;
	expect(events.filter((event) => event.kind === 'turn.completed')).toHaveLength(2);
	expect(transport.running).toBe(false);
	const kinds = events.map((event) => (event.kind === 'unhandled' ? event.name : event.kind));
	expect(kinds.indexOf('BEGIN')).toBeGreaterThan(kinds.indexOf('turn.completed'));
});
it('closes an adopted turn on the very status that ends it when one chunk carries a flag change, output and the end', async () => {
	process.env.BRIGADIR_FIXTURE_ADOPTED_BURST = '1';
	try {
		const transport = await start('steering-codex');
		const turn = transport.send({ kind: 'prompt', text: 'steer-wait' });
		await new Promise((resolve) => setTimeout(resolve, 100));
		const result = await transport.steer('burst', [], [], steerBegin);
		expect(result.outcome).toBe('adopted');
		await turn;
		if (result.outcome === 'adopted') await result.finished;
		const after = events.slice(
			events.findIndex((event) => event.kind === 'unhandled' && event.name === 'BEGIN')
		);
		const output = after.findIndex(
				(event) =>
					event.kind === 'message.delta' &&
					event.content.kind === 'text' &&
					event.content.text === 'adopted: burst'
			),
			closed = after.findIndex((event) => event.kind === 'turn.completed');
		expect(output).toBeGreaterThan(-1);
		expect(output).toBeLessThan(closed);
	} finally {
		delete process.env.BRIGADIR_FIXTURE_ADOPTED_BURST;
	}
});
it('closes a silent adopted turn by its watchdog and says so in the journal', async () => {
	process.env.BRIGADIR_FIXTURE_ADOPTED_SILENT = '1';
	process.env.BRIGADIR_STEER_WATCHDOG_MS = '1200';
	try {
		const transport = await start('steering-codex');
		const turn = transport.send({ kind: 'prompt', text: 'steer-wait' });
		await new Promise((resolve) => setTimeout(resolve, 100));
		const result = await transport.steer('silent', [], [], steerBegin);
		expect(result.outcome).toBe('adopted');
		await turn;
		if (result.outcome === 'adopted') await result.finished;
		expect(
			events.some(
				(event) =>
					event.kind === 'unhandled' &&
					event.name.startsWith('steering: the adopted turn sent nothing')
			)
		).toBe(true);
		expect(events.at(-1)).toEqual({ kind: 'turn.completed', reason: 'end_turn' });
		expect(transport.running).toBe(false);
	} finally {
		delete process.env.BRIGADIR_FIXTURE_ADOPTED_SILENT;
		delete process.env.BRIGADIR_STEER_WATCHDOG_MS;
	}
}, 10000);
it('still adopts after an earlier prompt failed with an error', async () => {
	const transport = await start('steering-codex');
	await expect(transport.send({ kind: 'prompt', text: 'fail' })).rejects.toThrow();
	const turn = transport.send({ kind: 'prompt', text: 'steer-wait' });
	await new Promise((resolve) => setTimeout(resolve, 100));
	const result = await transport.steer('after failure', [], [], steerBegin);
	expect(result.outcome).toBe('adopted');
	await turn;
	if (result.outcome === 'adopted') await result.finished;
	expect(events.at(-1)).toEqual({ kind: 'turn.completed', reason: 'end_turn' });
	expect(transport.running).toBe(false);
	expect(
		events.some((event) => event.kind === 'unhandled' && event.name.startsWith('steering:'))
	).toBe(false);
});
it('closes an adopted turn 5 s after Stop when its end status never comes (spec/composer-steering-queue-and-ghost#steering-hold)', async () => {
	process.env.BRIGADIR_FIXTURE_ADOPTED_SILENT = '1';
	process.env.BRIGADIR_STEER_STOP_MS = '300';
	try {
		const transport = await start('steering-codex');
		const turn = transport.send({ kind: 'prompt', text: 'steer-wait' });
		await new Promise((resolve) => setTimeout(resolve, 100));
		const result = await transport.steer('stop me', [], [], steerBegin);
		expect(result.outcome).toBe('adopted');
		await turn;
		const started = Date.now();
		await transport.send({ kind: 'cancel' });
		if (result.outcome === 'adopted') await result.finished;
		expect(Date.now() - started).toBeLessThan(5000);
		expect(events.at(-1)).toEqual({ kind: 'turn.completed', reason: 'cancelled' });
		expect(transport.running).toBe(false);
	} finally {
		delete process.env.BRIGADIR_FIXTURE_ADOPTED_SILENT;
		delete process.env.BRIGADIR_STEER_STOP_MS;
	}
});
it('announces subagents and keeps a subagent session apart: its updates, its permission and the launch call (spec/chat#subagents)', async () => {
	const transport = await start('subagents', {
		requestPermission: async (request) => request.options[0]!.id,
	});
	await transport.send({ kind: 'prompt', text: 'subagent' });
	expect((await wire()).find((item) => item.event === 'raw-initialize')?.params).toMatchObject({
		clientCapabilities: { subagents: {} },
	});
	expect(
		events.slice(
			events.findIndex(
				(event) =>
					event.kind === 'message.delta' &&
					event.content.kind === 'text' &&
					event.content.text === 'Starting.'
			)
		)
	).toEqual([
		{
			kind: 'message.delta',
			role: 'assistant',
			messageId: null,
			content: { kind: 'text', text: 'Starting.' },
		},
		{
			kind: 'subagent.started',
			id: 'child-1',
			parentId: null,
			name: 'List files',
			prompt: 'Run ls and answer with the list.',
		},
		{
			kind: 'tool.changed',
			patch: {
				id: 'child-tool',
				title: 'ls',
				category: 'execute',
				status: 'pending',
				parentId: 'launch-1',
			},
			subagentId: 'child-1',
		},
		{
			kind: 'permission.requested',
			request: {
				id: expect.any(String),
				tool: { id: 'child-tool', title: 'ls' },
				options: [{ id: 'allow', name: 'Allow', kind: 'allow_once' }],
			},
		},
		{
			kind: 'tool.changed',
			patch: { id: 'child-tool', status: 'completed', parentId: 'launch-1' },
			subagentId: 'child-1',
		},
		{
			kind: 'message.delta',
			role: 'assistant',
			messageId: null,
			content: { kind: 'text', text: 'README.md' },
			parentId: 'launch-1',
			subagentId: 'child-1',
		},
		{ kind: 'subagent.changed', id: 'child-1', state: 'completed' },
		{
			kind: 'subagent.changed',
			id: 'child-1',
			toolId: 'launch-1',
			type: 'general-purpose',
			model: 'claude-opus-5-5',
			tokens: 34269,
			durationMs: 10556,
		},
		{
			kind: 'message.delta',
			role: 'assistant',
			messageId: null,
			content: { kind: 'text', text: 'world' },
		},
		{ kind: 'turn.completed', reason: 'end_turn' },
	]);
	expect((await wire()).find((item) => item.event === 'child-permission')?.params).toEqual({
		outcome: { outcome: 'selected', optionId: 'allow' },
	});
});
// spec/agents-and-providers#sign-in-recovery: ACP `authRequired` is the sign-in failing — the event says so; any other failure does not.
it('marks a prompt the adapter answered with authRequired as a sign-in failure', async () => {
	const saved = process.env.BRIGADIR_TEST_AUTH_FILE;
	process.env.BRIGADIR_TEST_AUTH_FILE = join(directory, 'signed-in');
	try {
		const transport = await start();
		await expect(transport.send({ kind: 'prompt', text: 'auth please' })).rejects.toThrow(
			'Authentication required'
		);
		expect(events.filter((event) => event.kind === 'session.failed')).toEqual([
			{ kind: 'session.failed', message: 'Authentication required', reason: 'auth' },
		]);
		expect(
			events.some(
				(event) =>
					event.kind === 'message.delta' &&
					event.content.kind === 'text' &&
					event.content.text.startsWith('Failed to authenticate')
			)
		).toBe(true);
		await expect(transport.send({ kind: 'prompt', text: 'fail' })).rejects.toThrow();
		expect(events.filter((event) => event.kind === 'session.failed').at(-1)).not.toHaveProperty(
			'reason'
		);
	} finally {
		if (saved === undefined) delete process.env.BRIGADIR_TEST_AUTH_FILE;
		else process.env.BRIGADIR_TEST_AUTH_FILE = saved;
	}
});

// spec/chat#tool-states: a steer that cut off a call Claude was still writing interrupts that call; the turn ends as usual.
it('turns a steer-orphaned tool call into an interrupted one and completes the turn; without a steer it stays a failure', async () => {
	const transport = await start('steering', { provider: 'claude' });
	const turn = transport.send({ kind: 'prompt', text: 'steer-orphan' });
	await vi.waitFor(() =>
		expect(
			events.some((event) => event.kind === 'tool.changed' && event.patch.id === 'toolu_orphan')
		).toBe(true)
	);
	expect(await transport.steer('like one section', [], [], async () => {})).toEqual({
		outcome: 'injected',
	});
	await turn;
	const tool = events
		.filter((event) => event.kind === 'tool.changed' && event.patch.id === 'toolu_orphan')
		.map((event) => (event.kind === 'tool.changed' ? event.patch : null));
	expect(tool.at(-1)).toEqual({ id: 'toolu_orphan', status: 'interrupted', content: [] });
	expect(events.at(-1)).toEqual({ kind: 'turn.completed', reason: 'end_turn' });
	expect(events.some((event) => event.kind === 'session.failed')).toBe(false);
	// The same refusal in a turn without a steer is the agent's own failure.
	events.length = 0;
	await expect(transport.send({ kind: 'prompt', text: 'orphan-fail' })).rejects.toThrow(
		'without returning results for tool calls: toolu_orphan'
	);
	expect(events.at(-1)).toMatchObject({
		kind: 'session.failed',
		message: expect.stringContaining('toolu_orphan'),
	});
});
