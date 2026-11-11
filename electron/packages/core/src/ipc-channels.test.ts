import { describe, expect, it } from 'vitest';
import type { DesktopBridge } from './bridge';
import {
	createDesktopBridge,
	hashIpcTable,
	ipcEventClass,
	ipcInvokeRows,
	ipcSubscribeRows,
	ipcTable,
	ipcTableHash,
	type BridgeEnvironment,
	type IpcRow,
} from './ipc-channels';
import { fitsUtf8, utf8Bytes } from './utf8';

// Compile-time: the table has exactly the members of DesktopBridge, no more and no fewer.
type Same<A, B> = [A] extends [B] ? ([B] extends [A] ? true : false) : false;
const sameMembers: Same<keyof typeof ipcTable, keyof DesktopBridge> = true;

const env: BridgeEnvironment = {
	pathForFile: (file) => (file as { path?: string }).path ?? '',
	testCrash: 'chat',
	testAttentionMs: 50,
	chromePlatform: 'linux',
	remoteMachine: null,
};
function recorder() {
	const calls: { channel: string; args: readonly unknown[] }[] = [];
	const subscriptions: string[] = [];
	const emitted: { channel: string; value: unknown }[] = [];
	const bridge = createDesktopBridge(
		{
			invoke: async (channel, args) => {
				calls.push({ channel, args });
				return null;
			},
			subscribe: (channel) => {
				subscriptions.push(channel);
				return () => {};
			},
			emit: (channel, value) => emitted.push({ channel, value }),
		},
		env
	);
	return { bridge, calls, subscriptions, emitted };
}
const rows = Object.entries(ipcTable) as [keyof DesktopBridge, IpcRow][];

describe('channel table (spec/architecture-and-platform#ipc-boundary, spec/remote-access-and-mobile#architecture)', () => {
	it('has one row per bridge member and one row per channel of a kind', () => {
		expect(sameMembers).toBe(true);
		const { bridge } = recorder();
		expect(Object.keys(bridge).sort()).toEqual(Object.keys(ipcTable).sort());
		const invoke = rows.filter(([, row]) => row.kind === 'invoke');
		const subscribe = rows.filter(([, row]) => row.kind === 'subscribe');
		expect(ipcInvokeRows.size).toBe(invoke.length);
		expect(ipcSubscribeRows.size).toBe(subscribe.length);
		for (const [method, row] of invoke)
			if (row.kind === 'invoke') expect(ipcInvokeRows.get(row.channel)?.method).toBe(method);
	});
	it('routes every invoke member to its own channel and every listener to its own event', async () => {
		const { bridge, calls, subscriptions } = recorder();
		const methods = bridge as unknown as Record<string, (...args: unknown[]) => unknown>;
		for (const [method, row] of rows) {
			if (row.kind === 'invoke') {
				const before = calls.length;
				const args =
					method === 'attachDroppedFiles'
						? ['owner', [{ path: '/tmp/a.png' }]]
						: method === 'addDroppedProject'
							? [{ path: '/tmp/project' }]
							: [1, 2, 3, 4, 5, 6, 7, 8];
				await methods[method]!(...args);
				expect(calls.length, method).toBe(before + 1);
				expect(calls.at(-1)!.channel, method).toBe(row.channel);
			} else if (row.kind === 'subscribe') {
				methods[method]!(() => {});
				expect(subscriptions.at(-1), method).toBe(row.channel);
			}
		}
	});
	it('sends what the named method used to: arity, defaults and optional tails', async () => {
		const { bridge, calls } = recorder();
		const last = () => calls.at(-1)!.args;
		await bridge.readLiveAgents();
		expect(last()).toEqual([]);
		await bridge.collapseProject('p', true);
		expect(last()).toEqual(['p', true]);
		// A missing trailing argument goes as undefined, as with `(id, collapsed) => invoke(ch, id, collapsed)`.
		await (bridge.collapseProject as unknown as (...args: unknown[]) => Promise<void>)('p');
		expect(last()).toEqual(['p', undefined]);
		// An extra argument (a click event passed through) is cut.
		await (bridge.readLiveAgents as (...args: unknown[]) => Promise<unknown>)({ type: 'click' });
		expect(last()).toEqual([]);
		await bridge.readSession({ projectId: 'p', id: 't' });
		expect(last()).toEqual([{ projectId: 'p', id: 't' }]);
		await bridge.readSession({ projectId: 'p', id: 't' }, 4);
		expect(last()).toHaveLength(2);
		await bridge.openAppMenu();
		expect(last()).toEqual([]);
		await bridge.openAppMenu(10, 42);
		expect(last()).toEqual([10, 42]);
		await bridge.listFiles({ projectId: 'p', id: 't' }, 'f');
		expect(last()).toEqual([{ projectId: 'p', id: 't' }, 'f', false]);
		await bridge.pullBranch('p', 's');
		expect(last()).toEqual(['p', 's', null]);
		await bridge.createTask('p', 'hi', 'claude');
		expect(last()).toEqual(['p', 'hi', 'claude', 'gui', false, undefined, undefined, undefined]);
		// spec/pull-requests-and-ci#review-crew: the crew of a review goes 8th; without it the tail stays short.
		const key = { projectId: 'p', id: 't' },
			ref = { scopeId: 's', number: 7 };
		await bridge.startPullRequestAgent(key, ref, 'review', false, 'quick');
		expect(last()).toEqual([key, ref, 'review', false, 'quick']);
		await bridge.startPullRequestAgent(key, ref, 'review', false, undefined, null, false, 'review');
		expect(last()).toEqual([key, ref, 'review', false, null, null, false, 'review']);
		await bridge.startPullRequestAgent(key, ref, 'review', false, 'worktree', null, true, 'mine');
		expect(last()).toEqual([key, ref, 'review', false, 'worktree', null, true, 'mine']);
		const row = ipcInvokeRows.get('prs:agent-task')!;
		expect(row.validate([key, ref, 'review', false, null, null, false, 'review'])).toBe(true);
		// An agent and a crew exclude each other; a fix takes no crew.
		expect(
			row.validate([
				key,
				ref,
				'review',
				false,
				null,
				{ provider: 'claude', model: 'opus', effort: null },
				false,
				'review',
			])
		).toBe(false);
		expect(row.validate([key, ref, 'fix', false, null, null, false, 'review'])).toBe(false);
		expect(row.validate([key, ref, 'review', false, null, null, false, '../x'])).toBe(false);
		// spec/pull-requests-and-ci#review-launch: the person's instructions go 9th, only when there are some.
		await bridge.startPullRequestAgent(
			key,
			ref,
			'review',
			false,
			'quick',
			null,
			false,
			null,
			'Look at the race'
		);
		expect(last()).toEqual([
			key,
			ref,
			'review',
			false,
			'quick',
			null,
			false,
			null,
			'Look at the race',
		]);
		await bridge.startPullRequestAgent(key, ref, 'review', false, 'quick', null, false, null, '  ');
		expect(last()).toEqual([key, ref, 'review', false, 'quick']);
		expect(row.validate([key, ref, 'review', false, null, null, false, 'review', 'Notes'])).toBe(
			true
		);
		expect(row.validate([key, ref, 'review', false, null, null, false, null, ''])).toBe(false);
		expect(row.validate([key, ref, 'fix', false, null, null, false, null, 'Notes'])).toBe(false);
		expect(
			row.validate([key, ref, 'review', false, null, null, false, null, 'x'.repeat(16001)])
		).toBe(false);
		const notes = ipcInvokeRows.get('projects:review-notes')!;
		expect(notes.validate(['p', { source: 'text', text: 'Check migrations' }])).toBe(true);
		expect(notes.validate(['p', { source: 'file' }])).toBe(true);
		expect(notes.validate(['p', null])).toBe(true);
		expect(notes.validate(['p', { source: 'text', text: '  ' }])).toBe(false);
		expect(notes.validate(['p', { source: 'file', text: 'x' }])).toBe(false);
		expect(ipcInvokeRows.get('settings:action-crew')!.validate(['review', null])).toBe(true);
		expect(
			ipcInvokeRows
				.get('settings:action-crew')!
				.validate(['reviewSuggestions', { templateId: 'review', name: 'Review crew' }])
		).toBe(true);
		expect(
			ipcInvokeRows
				.get('settings:action-crew')!
				.validate(['agentFix', { templateId: 'review', name: 'Review crew' }])
		).toBe(false);
		const sent = calls.length;
		await expect(
			bridge.attachDroppedFiles({ kind: 'sheet', id: 'x' } as never, [{}])
		).resolves.toEqual([]);
		expect(calls.length).toBe(sent);
	});
	it('takes local members from the preload and fans a workspace action out locally', () => {
		const { bridge, emitted } = recorder();
		expect(bridge.testCrash).toBe('chat');
		expect(bridge.testAttentionMs).toBe(50);
		expect(bridge.chromePlatform).toBe('linux');
		bridge.dispatchWorkspaceAction('settings');
		expect(emitted).toEqual([{ channel: 'workspace:action', value: 'settings' }]);
	});
	it('classes the client channels and forbids the test crash remotely (spec/remote-access-and-mobile#architecture)', () => {
		const client = rows.filter(([, row]) => row.class === 'client').map(([method]) => method);
		for (const method of [
			'copyText',
			'readClipboardText',
			'openWebLink',
			'readNotificationPermission',
			'chatMenu',
			'openAppMenu',
			'readAppearance',
			'setChromeColors',
			'pickAttachments',
			'attachDroppedFiles',
		] as const)
			expect(client).toContain(method);
		for (const method of [
			'sendCommand',
			'readWorkspace',
			'saveEditorFile',
			'browserCommand',
		] as const)
			expect(ipcTable[method].class).toBe('remote');
		expect(ipcTable.testCrash.remote).toBe('forbidden');
		expect(ipcTable.saveSettings.remote).toBe('guarded');
		expect(ipcEventClass('appearance:changed')).toBe('client');
		expect(ipcEventClass('session:event')).toBe('remote');
	});
	it('validates the reads as taking nothing', () => {
		expect(ipcInvokeRows.get('workspace:read')!.validate([])).toBe(true);
		expect(ipcInvokeRows.get('workspace:read')!.validate(['/etc/passwd'])).toBe(false);
		expect(ipcInvokeRows.get('project:add-path')!.validate(['relative/path'])).toBe(false);
		expect(ipcInvokeRows.get('project:add-path')!.validate(['/Users/me/project'])).toBe(true);
	});
	it('exports a stable hash that moves with the table (spec/remote-access-and-mobile#architecture)', () => {
		expect(ipcTableHash()).toMatch(/^[0-9a-f]{16}$/);
		expect(ipcTableHash()).toBe(hashIpcTable({ ...ipcTable }));
		const reclassed = { ...ipcTable, copyText: { ...ipcTable.copyText, class: 'remote' as const } };
		expect(hashIpcTable(reclassed)).not.toBe(ipcTableHash());
		const revalidated = {
			...ipcTable,
			copyText: { ...ipcTable.copyText, validate: (a: unknown[]) => a.length === 2 },
		};
		expect(hashIpcTable(revalidated)).not.toBe(ipcTableHash());
	});
});
describe('utf8', () => {
	it('counts like Buffer.byteLength and bounds without walking the obvious', () => {
		for (const text of ['', 'abc', 'é', 'ї', '€', '😀', '\ud800', 'a\udc00b', 'x😀y'])
			expect(utf8Bytes(text), text).toBe(Buffer.byteLength(text, 'utf8'));
		for (const [text, limit] of [
			['abc', 3],
			['abc', 2],
			['ї', 2],
			['ї', 1],
			['😀', 4],
			['😀', 3],
			['\ud800', 3],
			['\ud800', 2],
			['é'.repeat(10), 20],
			['é'.repeat(10), 19],
		] as const)
			expect(fitsUtf8(text, limit), `${text} ${limit}`).toBe(
				Buffer.byteLength(text, 'utf8') <= limit
			);
	});
});
