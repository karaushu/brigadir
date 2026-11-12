import { expect, it, vi } from 'vitest';
import { createServer, connect, type Socket } from 'node:net';
import { spawn } from 'node:child_process';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import type { CrewProcessRole } from '@brigadir/orchestrator';
import { mcpTools, progressBeatMs, serveMcp, type McpCall, type ModuleSource } from './mcp';
import { defaultModules, type AppModules } from '@brigadir/core';
import { Peer } from './peer';
// Recorded from the SDK server (`@modelcontextprotocol/sdk` 1.30.0 + zod) that this replaces: the same requests, per role.
const golden = JSON.parse(
	await readFile(resolve('packages/host/fixtures/mcp-sdk-1.30.json'), 'utf8')
) as Record<string, { initialize: unknown; toolsList: unknown; calls: Record<string, unknown> }>;
const cases: [string, string, unknown?][] = [
	['missing', 'tools/call', { name: 'nope', arguments: {} }],
	['askEmpty', 'tools/call', { name: 'ask_user', arguments: { question: '   ' } }],
	[
		'askBadOptions',
		'tools/call',
		{
			name: 'ask_user',
			arguments: { question: 'q', options: [{ label: '' }], allowsFreeText: 'x' },
		},
	],
	['browserBad', 'tools/call', { name: 'browser_read', arguments: { requestId: 'x', url: 5 } }],
	['plan', 'tools/call', { name: 'propose_plan', arguments: { parts: [] } }],
	['transcript', 'tools/call', { name: 'read_transcript', arguments: { taskId: '', limit: 1.5 } }],
	[
		'review',
		'tools/call',
		{
			name: 'submit_review',
			arguments: { taskId: 't', comments: [{ path: 'a', start: 0, text: '' }] },
		},
	],
	['notes', 'tools/call', { name: 'read_notes', arguments: { since: -1 } }],
	['noArgs', 'tools/call', { name: 'read_notes' }],
	['ping', 'ping'],
	['unknown', 'resources/list'],
	[
		'oldVersion',
		'initialize',
		{ protocolVersion: '1999-01-01', capabilities: {}, clientInfo: { name: 'x', version: '1' } },
	],
];
async function served(role: CrewProcessRole | null, call: McpCall, modules?: ModuleSource) {
	const root = await mkdtemp(join(tmpdir(), 'brigadir-mcp-')),
		path = join(root, 'm.sock');
	let closed!: () => void;
	const hostClosed = new Promise<void>((resolve) => {
		closed = resolve;
	});
	const server = createServer((socket) => {
		socket.setEncoding('utf8');
		socket.on('data', serveMcp(socket, role, call, modules));
		socket.once('close', closed);
	});
	await new Promise<void>((resolve) => server.listen(path, resolve));
	const client = connect(path);
	await new Promise((resolve) => client.once('connect', resolve));
	return {
		...lines(client),
		send: (value: unknown) => client.write(`${JSON.stringify(value)}\n`),
		client,
		hostClosed,
		async close() {
			client.destroy();
			await new Promise((resolve) => server.close(resolve));
			await rm(root, { recursive: true, force: true });
		},
	};
}
/** Raw response lines by id, so the comparison is on bytes, not on parsed values. */
function lines(stream: {
	setEncoding(encoding: 'utf8'): unknown;
	on(event: 'data', listener: (chunk: string) => void): unknown;
}) {
	stream.setEncoding('utf8');
	let buffer = '';
	const seen = new Map<unknown, string>(),
		waiters = new Map<unknown, (line: string) => void>();
	stream.on('data', (chunk) => {
		buffer += chunk;
		let split;
		while ((split = buffer.indexOf('\n')) >= 0) {
			const line = buffer.slice(0, split);
			buffer = buffer.slice(split + 1);
			const id = JSON.parse(line).id;
			seen.set(id, line);
			waiters.get(id)?.(line);
		}
	});
	return {
		seen,
		reply: (id: unknown) =>
			seen.has(id)
				? Promise.resolve(seen.get(id)!)
				: new Promise<string>((resolve) => waiters.set(id, resolve)),
	};
}
const request = (id: unknown, method: string, params?: unknown) => ({
	jsonrpc: '2.0',
	id,
	method,
	...(params === undefined ? {} : { params }),
});
it('lists the SDK server tools per role and answers validation byte for byte', async () => {
	for (const [name, expected] of Object.entries(golden)) {
		const role = name === 'none' ? null : (name as CrewProcessRole),
			mcp = await served(role, async () => {
				throw new Error('The host is not reached');
			});
		try {
			mcp.send(
				request(1, 'initialize', {
					protocolVersion: '2025-06-18',
					capabilities: {},
					clientInfo: { name: 'x', version: '1' },
				})
			);
			expect(await mcp.reply(1)).toBe(JSON.stringify(expected.initialize));
			mcp.send({ jsonrpc: '2.0', method: 'notifications/initialized' });
			mcp.send(request(2, 'tools/list'));
			expect(await mcp.reply(2)).toBe(
				JSON.stringify({ result: expected.toolsList, jsonrpc: '2.0', id: 2 })
			);
			for (const [index, [label, method, params]] of cases.entries()) {
				mcp.send(request(index + 3, method, params));
				expect(await mcp.reply(index + 3), `${name} ${label}`).toBe(
					JSON.stringify(expected.calls[label])
				);
			}
		} finally {
			await mcp.close();
		}
	}
});
it('passes parsed arguments with defaults to the host and maps results, images and host errors', async () => {
	const calls: [string, unknown][] = [];
	const mcp = await served('foreman', async (method, params) => {
		calls.push([method, params]);
		if (method === 'browser_screenshot') return { image: 'iVBOR' };
		if (method === 'browser_state') return 'ready';
		if (method === 'ask_user') return { labels: ['Blue'], text: '' };
		if (isFailing(params)) throw new Error('Worker is gone');
		return { ok: true };
	});
	const isFailing = (params: unknown) => JSON.stringify(params).includes('gone');
	try {
		const result = async (id: unknown, name: string, args: unknown) => {
			mcp.send(request(id, 'tools/call', { name, arguments: args }));
			return JSON.parse(await mcp.reply(id)).result;
		};
		expect(await result(1, 'ask_user', { question: '  Which color? ' })).toEqual({
			content: [{ type: 'text', text: '{"labels":["Blue"],"text":""}' }],
		});
		expect(calls.at(-1)).toEqual([
			'ask_user',
			{
				question: 'Which color?',
				header: '',
				options: [],
				allowsFreeText: true,
				allowsMultiple: false,
			},
		]);
		expect(await result(2, 'browser_screenshot', {})).toEqual({
			content: [{ type: 'image', data: 'iVBOR', mimeType: 'image/png' }],
		});
		expect(await result(3, 'browser_state', { extra: 1 })).toEqual({
			content: [{ type: 'text', text: 'ready' }],
		});
		expect(calls.at(-1)).toEqual(['browser_state', {}]);
		// The JSON-RPC id is the idempotency key the host keeps for crew calls, a string id included.
		await result(7, 'read_transcript', { taskId: 't' });
		expect(calls.at(-1)).toEqual([
			'crew_tool',
			{ tool: 'read_transcript', params: { taskId: 't', limit: 40, callId: '7' } },
		]);
		await result('n-1', 'post_note', { text: 'Shared type changed' });
		expect(calls.at(-1)).toEqual([
			'crew_tool',
			{ tool: 'post_note', params: { text: 'Shared type changed', files: [], callId: 'n-1' } },
		]);
		expect(await result(8, 'task_status', { taskId: 'gone' })).toEqual({
			content: [{ type: 'text', text: 'Worker is gone' }],
			isError: true,
		});
		mcp.send(request(9, 'tools/call', { name: 7 }));
		expect(JSON.parse(await mcp.reply(9)).error.code).toBe(-32602);
	} finally {
		await mcp.close();
	}
});
it('aborts a cancelled call without a response and every call when the relay goes away', async () => {
	const signals: AbortSignal[] = [];
	const mcp = await served(
		null,
		(_method, _params, signal) =>
			new Promise((_resolve, reject) => {
				signals.push(signal);
				signal.addEventListener('abort', () => reject(new Error('No answer was provided')));
			})
	);
	try {
		mcp.send(request(1, 'tools/call', { name: 'ask_user', arguments: { question: 'First?' } }));
		mcp.send(request(2, 'tools/call', { name: 'ask_user', arguments: { question: 'Second?' } }));
		await expect.poll(() => signals.length).toBe(2);
		mcp.send({
			jsonrpc: '2.0',
			method: 'notifications/cancelled',
			params: { requestId: 1, reason: 'user' },
		});
		mcp.send(request(3, 'ping'));
		expect(await mcp.reply(3)).toBe('{"result":{},"jsonrpc":"2.0","id":3}');
		expect(signals[0]!.aborted).toBe(true);
		expect(signals[1]!.aborted).toBe(false);
		expect(mcp.seen.has(1)).toBe(false);
		mcp.client.destroy();
		await mcp.hostClosed;
		expect(signals[1]!.aborted).toBe(true);
	} finally {
		await mcp.close();
	}
});
it('a call that asked for progress gets a heartbeat while it waits for the person, and none after it answers', async () => {
	vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval'] });
	let answer!: (value: unknown) => void;
	const mcp = await served(
		'foreman',
		() =>
			new Promise((resolve) => {
				answer = resolve;
			})
	);
	try {
		mcp.send(
			request(1, 'tools/call', {
				name: 'propose_plan',
				arguments: { parts: [{ title: 'A', agent: 'Developer', prompt: 'go' }] },
				_meta: { progressToken: 'plan-call' },
			})
		);
		await expect.poll(() => typeof answer).toBe('function');
		vi.advanceTimersByTime(progressBeatMs * 2);
		await expect
			.poll(() => mcp.seen.get(undefined))
			.toBe(
				'{"jsonrpc":"2.0","method":"notifications/progress","params":{"progressToken":"plan-call","progress":2}}'
			);
		answer({ approved: true });
		await mcp.reply(1);
		mcp.seen.delete(undefined);
		vi.advanceTimersByTime(progressBeatMs * 3);
		mcp.send(request(2, 'ping'));
		await mcp.reply(2);
		expect(mcp.seen.has(undefined)).toBe(false);
	} finally {
		vi.useRealTimers();
		await mcp.close();
	}
});
it('the native relay authenticates once, then carries MCP both ways and ends with its stdin', async () => {
	const root = await mkdtemp(join(tmpdir(), 'brigadir-relay-')),
		path = join(root, 'h.sock'),
		token = 't'.repeat(64);
	let aborted = false,
		hostClosed!: () => void;
	const closed = new Promise<void>((resolve) => {
		hostClosed = resolve;
	});
	const big = 'ї'.repeat(3_000_000);
	const server = createServer((socket: Socket) => {
		const peer = new Peer(socket, async (method, params) => {
			const value = params as {
				role?: string;
				token?: string;
				stdio?: boolean;
				key?: { id?: string };
			};
			if (
				method !== 'handshake' ||
				value.role !== 'mcp' ||
				value.token !== token ||
				value.stdio !== true ||
				value.key?.id !== 'task "1"'
			)
				throw new Error('Invalid client credentials');
			socket.once('close', hostClosed);
			peer.handOff(
				serveMcp(socket, 'developer', async (_method, params, signal) => {
					if (JSON.stringify(params).includes('wait'))
						return new Promise((_resolve, reject) =>
							signal.addEventListener('abort', () => {
								aborted = true;
								reject(new Error('aborted'));
							})
						);
					return big;
				})
			);
			return { protocolVersion: 1 };
		});
	});
	await new Promise<void>((resolve) => server.listen(path, resolve));
	const relay = (secret: string) =>
		spawn(resolve('apps/desktop/out/services/mcp-relay'), [], {
			env: {
				BRIGADIR_HOST_SOCKET: path,
				BRIGADIR_HOST_INSTANCE: 'instance',
				BRIGADIR_PROJECT_ID: 'project',
				BRIGADIR_TASK_ID: 'task "1"',
				BRIGADIR_MCP_TOKEN: secret,
			},
		});
	try {
		const rejected = relay('wrong');
		let diagnostics = '';
		rejected.stderr.on('data', (chunk) => {
			diagnostics += chunk;
		});
		expect(await new Promise((resolve) => rejected.once('exit', resolve))).toBe(1);
		expect(diagnostics).toContain('Invalid client credentials');
		const child = relay(token),
			mcp = lines(child.stdout);
		const send = (value: unknown) => child.stdin.write(`${JSON.stringify(value)}\n`);
		send(
			request(1, 'initialize', {
				protocolVersion: '2025-06-18',
				capabilities: {},
				clientInfo: { name: 'x', version: '1' },
			})
		);
		expect(await mcp.reply(1)).toBe(JSON.stringify(golden.developer!.initialize));
		send(request(2, 'tools/list'));
		expect(await mcp.reply(2)).toBe(
			JSON.stringify({ result: golden.developer!.toolsList, jsonrpc: '2.0', id: 2 })
		);
		send(request(3, 'tools/call', { name: 'read_notes', arguments: {} }));
		expect(JSON.parse(await mcp.reply(3)).result.content[0].text).toBe(big);
		send(request(4, 'tools/call', { name: 'ask_foreman', arguments: { question: 'wait' } }));
		await new Promise((resolve) => setTimeout(resolve, 100));
		child.stdin.end();
		expect(await new Promise((resolve) => child.once('exit', resolve))).toBe(0);
		await closed;
		expect(aborted).toBe(true);
	} finally {
		await new Promise((resolve) => server.close(resolve));
		await rm(root, { recursive: true, force: true });
	}
});

it("lists editor_state where the person's tools are and pr_state with pull requests on, and passes the call to the host (spec/agents-and-providers#context-tools)", async () => {
	const names = (role: CrewProcessRole | null, modules: AppModules = defaultModules) =>
		(mcpTools(role, modules).list.tools as { name: string }[]).map((tool) => tool.name);
	for (const role of [null, 'foreman'] as const) {
		expect(names(role)).toContain('editor_state');
		expect(names(role)).toContain('pr_state');
	}
	for (const role of ['lead', 'developer', 'reviewer'] as const) {
		expect(names(role)).not.toContain('editor_state');
		expect(names(role)).not.toContain('pr_state');
	}
	expect(names(null, { ...defaultModules, pullRequests: false })).toContain('editor_state');
	expect(names(null, { ...defaultModules, pullRequests: false })).not.toContain('pr_state');
	const calls: [string, unknown][] = [];
	const mcp = await served(null, async (method, params) => {
		calls.push([method, params]);
		return { window: 'open', tabs: [] };
	});
	try {
		mcp.send(request(1, 'tools/call', { name: 'editor_state', arguments: {} }));
		expect(JSON.parse(await mcp.reply(1)).result).toEqual({
			content: [{ type: 'text', text: '{"window":"open","tabs":[]}' }],
		});
		mcp.send(request(2, 'tools/call', { name: 'pr_state' }));
		await mcp.reply(2);
		expect(calls).toEqual([
			['editor_state', {}],
			['pr_state', {}],
		]);
	} finally {
		await mcp.close();
	}
});

it('lists pr_comment only for a review task while pull requests are on (spec/settings-modules-and-onboarding#module-off)', () => {
	const names = (modules: AppModules, review: boolean) =>
		(mcpTools(null, modules, review).list.tools as { name: string }[]).map((tool) => tool.name);
	expect(names(defaultModules, true)).toContain('pr_comment');
	expect(names(defaultModules, false)).not.toContain('pr_comment');
	expect(names({ ...defaultModules, pullRequests: false }, true)).not.toContain('pr_comment');
	// spec/pull-requests-and-ci#review-with-agent: the thread answer goes and comes with pr_comment.
	expect(names(defaultModules, true)).toContain('pr_comment_reply');
	expect(names(defaultModules, false)).not.toContain('pr_comment_reply');
	expect(names({ ...defaultModules, pullRequests: false }, true)).not.toContain('pr_comment_reply');
});

it('takes the tools of a module switched off out of the list and tells open sessions (spec/settings-modules-and-onboarding#modules)', async () => {
	let value: AppModules = { ...defaultModules };
	const listeners = new Set<(value: AppModules) => void>();
	const modules: ModuleSource = {
		current: () => value,
		subscribe: (listener) => {
			listeners.add(listener);
			return () => {
				listeners.delete(listener);
			};
		},
	};
	const toggle = (next: AppModules) => {
		value = next;
		for (const listener of listeners) listener(next);
	};
	const mcp = await served(null, async (method) => method, modules);
	const names = async (id: number) => {
		mcp.send(request(id, 'tools/list'));
		return (JSON.parse(await mcp.reply(id)).result.tools as { name: string }[]).map(
			(tool) => tool.name
		);
	};
	try {
		mcp.send(
			request(1, 'initialize', {
				protocolVersion: '2025-06-18',
				capabilities: {},
				clientInfo: { name: 'x', version: '1' },
			})
		);
		await mcp.reply(1);
		// Before `initialized` a switch sends nothing: the client has not asked for notifications yet.
		toggle({ ...defaultModules, browser: false, simulator: false });
		expect(await names(2)).toEqual([
			'ask_user',
			'create_task',
			'tasks_list',
			'task_send',
			'propose_review',
			'review_reply',
			'add_folder',
			'commands_list',
			'commands_run',
			'commands_output',
			'commands_stop',
			'console_list',
			'console_read',
			'editor_state',
			'editor_restart_language_servers',
			'pr_state',
		]);
		expect(mcp.seen.has(undefined)).toBe(false);
		mcp.send({ jsonrpc: '2.0', method: 'notifications/initialized' });
		mcp.send(request(9, 'ping'));
		await mcp.reply(9);
		toggle({ ...defaultModules, browser: true, simulator: false });
		expect(JSON.parse(await mcp.reply(undefined))).toEqual({
			jsonrpc: '2.0',
			method: 'notifications/tools/list_changed',
		});
		expect(await names(3)).toContain('browser_open');
		toggle({ ...defaultModules, browser: false, simulator: true });
		expect(await names(6)).toEqual([
			'ask_user',
			'create_task',
			'tasks_list',
			'task_send',
			'propose_review',
			'review_reply',
			'add_folder',
			'commands_list',
			'commands_run',
			'commands_output',
			'commands_stop',
			'console_list',
			'console_read',
			'editor_state',
			'editor_restart_language_servers',
			'pr_state',
			'simulator_state',
			'simulator_open',
			'simulator_ui',
			'simulator_act',
			'simulator_screenshot',
			'simulator_logs',
			'simulator_network',
		]);
		mcp.send(
			request(7, 'tools/call', {
				name: 'simulator_act',
				arguments: { action: 'tap', id: 'take-order' },
			})
		);
		expect(JSON.parse(await mcp.reply(7)).result).toEqual({
			content: [{ type: 'text', text: 'simulator_act' }],
		});
		toggle({ ...defaultModules, browser: false, simulator: false });
		mcp.send(
			request(4, 'tools/call', {
				name: 'browser_open',
				arguments: { url: 'http://localhost:5173' },
			})
		);
		expect(JSON.parse(await mcp.reply(4)).result).toEqual({
			content: [{ type: 'text', text: 'The browser is off in Settings.' }],
			isError: true,
		});
		// spec/search-menus-and-commands#agent-command-tools: project commands are a module too; a session that kept its list hears the sentence.
		toggle({ ...defaultModules, browser: false, simulator: false, commands: false });
		expect(await names(10)).toEqual([
			'ask_user',
			'create_task',
			'tasks_list',
			'task_send',
			'propose_review',
			'review_reply',
			'add_folder',
			'console_list',
			'console_read',
			'editor_state',
			'editor_restart_language_servers',
			'pr_state',
		]);
		mcp.send(request(11, 'tools/call', { name: 'commands_run', arguments: { id: 'dev' } }));
		expect(JSON.parse(await mcp.reply(11)).result).toEqual({
			content: [{ type: 'text', text: 'Project commands are off in Settings.' }],
			isError: true,
		});
		mcp.send(request(5, 'tools/call', { name: 'nope', arguments: {} }));
		expect(JSON.parse(await mcp.reply(5)).result.content[0].text).toBe(
			'MCP error -32602: Tool nope not found'
		);
	} finally {
		await mcp.close();
	}
});

const allModules: AppModules = {
	browser: true,
	simulator: true,
	pullRequests: true,
	commands: true,
	remoteAccess: true,
	notes: true,
	schedules: true,
	slack: false,
};
const offModules: AppModules = {
	browser: false,
	simulator: false,
	pullRequests: true,
	commands: false,
	remoteAccess: false,
	notes: false,
	schedules: false,
	slack: false,
};
async function initialize(role: CrewProcessRole | null, modules: AppModules) {
	const source: ModuleSource = { current: () => modules, subscribe: () => () => {} };
	const mcp = await served(role, async () => null, source);
	try {
		mcp.send(
			request(1, 'initialize', {
				protocolVersion: '2025-06-18',
				capabilities: {},
				clientInfo: { name: 'x', version: '1' },
			})
		);
		return JSON.parse(await mcp.reply(1)).result as { instructions?: string };
	} finally {
		await mcp.close();
	}
}
it('tells the agent in initialize what it has, from the modules on and its role (spec/agents-and-providers#tools-awareness)', async () => {
	const solo = await initialize(null, allModules);
	await expect(solo.instructions).toMatchFileSnapshot(
		'../fixtures/briefs/mcp-instructions-solo.txt'
	);
	const worker = await initialize('developer', allModules);
	await expect(worker.instructions).toMatchFileSnapshot(
		'../fixtures/briefs/mcp-instructions-worker.txt'
	);
	expect(worker.instructions).toContain('shared with your crew');
	expect(solo.instructions).not.toContain('shared with your crew');
	expect((await initialize('foreman', allModules)).instructions).toContain(
		'Your agents have the same tools'
	);
	// A module switched off is not named; with none of the three on, only the console is (spec/terminal-and-cli-agents#agent-console-tools).
	const browserOnly = await initialize(null, { ...offModules, browser: true });
	expect(browserOnly.instructions).toContain('browser_open');
	expect(browserOnly.instructions).not.toMatch(/simulator|commands_/);
	for (const role of [null, 'developer'] as const) {
		const none = (await initialize(role, offModules)).instructions;
		expect(none).toContain('console_read');
		expect(none).not.toMatch(/browser_|simulator_|commands_|The person sees/);
	}
});

it("gives crew workers the browser, the simulator, the project commands and the console, not the person's other tools (spec/agents-and-providers#tools-awareness, spec/terminal-and-cli-agents#agent-console-tools)", () => {
	for (const role of ['developer', 'reviewer', 'lead'] as const) {
		const names = (mcpTools(role, allModules).list.tools as { name: string }[]).map(
			(tool) => tool.name
		);
		for (const name of [
			'browser_open',
			'browser_act',
			'commands_run',
			'simulator_act',
			'console_list',
			'console_read',
		])
			expect(names, role).toContain(name);
		for (const name of ['ask_user', 'create_task', 'add_folder', 'editor_state', 'pr_state'])
			expect(names, role).not.toContain(name);
	}
	const off = (mcpTools('developer', offModules).list.tools as { name: string }[]).map(
		(tool) => tool.name
	);
	expect(off.some((name) => /^(browser|simulator|commands)_/.test(name))).toBe(false);
	// spec/terminal-and-cli-agents#agent-console-tools: the console is no module; a worker reads its own with every module off.
	expect(off).toEqual(expect.arrayContaining(['console_list', 'console_read']));
});

it('says in every tool description when to use it (spec/agents-and-providers#tools-awareness)', () => {
	for (const role of [null, 'foreman', 'lead', 'developer', 'reviewer'] as const)
		for (const tool of mcpTools(role, allModules, true).list.tools as {
			name: string;
			description: string;
		}[])
			expect(tool.description, tool.name).toMatch(/\b(Call|Use) (it|this tool)\b/);
});
