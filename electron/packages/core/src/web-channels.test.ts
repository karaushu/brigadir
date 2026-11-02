import { describe, expect, it } from 'vitest';
import { ipcInvokeRows, ipcTable, type IpcMethod } from './ipc-channels';
import { defaultAppSettings } from './settings';
import {
	guardPhoneSettings,
	webCallRefusal,
	webChannels,
	webEventAllowed,
	webSessionCommands,
	webTerminalCommands,
} from './web-channels';

const key = { projectId: 'p', id: 't' };
describe('the web class (spec/remote-access-and-mobile#phone-network)', () => {
	it('has an explicit decision for every row of the table, and none for a row that is not there', () => {
		expect(Object.keys(webChannels).sort()).toEqual(Object.keys(ipcTable).sort());
		for (const access of Object.values(webChannels))
			expect(['allow', 'deny', 'guarded', 'function']).toContain(
				typeof access === 'function' ? 'function' : access
			);
	});
	// spec/remote-access-and-mobile#phone-app: a menu or dialog of an allowed row's handler is the phone's to answer; remote access itself stays shut.
	const remoteUi = new Set(['remote:menu', 'remote:dialog', 'remote:ui-answer']);
	it('never lets a phone reach a client-class or forbidden row, nor remote access itself', () => {
		for (const [method, row] of Object.entries(ipcTable) as [
			IpcMethod,
			(typeof ipcTable)[IpcMethod],
		][]) {
			const access = webChannels[method];
			if (
				row.class === 'client' ||
				('remote' in row && row.remote === 'forbidden') ||
				!('channel' in row)
			)
				expect([method, access]).toEqual([method, 'deny']);
			if ('channel' in row && row.channel.startsWith('remote:') && !remoteUi.has(row.channel))
				expect([method, access]).toEqual([method, 'deny']);
		}
	});
	it('lets the chat through and keeps the rest of the session commands', () => {
		for (const kind of webSessionCommands)
			expect(webCallRefusal('session:command', [key, { kind }])).toBeNull();
		expect(webSessionCommands.has('setOption')).toBe(true);
		for (const kind of ['shutdown', 'setScope', 'addScope', 'submitReview', 'quickAsk', 'setMode'])
			expect(webCallRefusal('session:command', [key, { kind }])).toBe(
				'Not available from a phone.'
			);
	});
	it('reads the terminal and never types into it', () => {
		for (const kind of webTerminalCommands)
			expect(webCallRefusal('terminal:command', [key, { kind, id: 'x' }])).toBeNull();
		for (const kind of [
			'input',
			'resize',
			'run',
			'create',
			// spec/remote-access-and-mobile#phone-task-tools: `list` starts a host on an idle task; the phone's tabs come from `commands:runs`.
			'list',
			'close',
			'clear',
			'stop',
			'close-consoles',
		])
			expect(webCallRefusal('terminal:command', [key, { kind, id: 'x' }])).toBe(
				'Not available from a phone.'
			);
	});
	it('allows what spec/remote-access-and-mobile#phone lists and refuses what it leaves out', () => {
		for (const channel of [
			'workspace:read',
			'session:read',
			'task:create',
			'changes:read',
			'prs:comment',
			'prs:submit',
			'prs:merge',
			'prs:ask',
			'search:peek',
			'changes:file',
			'commands:runs',
			'archive:task',
			'quota:read',
			'settings:read',
			'attachment:upload',
		])
			expect([channel, webCallRefusal(channel, [])]).toEqual([channel, null]);
		for (const channel of [
			'files:save',
			'browser:command',
			'simulator:command',
			'code:complete',
			'templates:save-crew',
			'keep-awake:read',
			'settings:restart',
			'remote:enable',
			'remote:take-control',
			'commands:run',
			// spec/remote-access-and-mobile#phone-task-tools: the editor's lease is not the phone's; it reads with `search:peek`.
			'files:read',
		])
			expect([channel, webCallRefusal(channel, [])]).toEqual([
				channel,
				'Not available from a phone.',
			]);
		expect(webCallRefusal('no:such', [])).toBe('Invalid IPC request');
		expect(webEventAllowed('session:event')).toBe(true);
		expect(webEventAllowed('terminal:event')).toBe(true);
		expect(webEventAllowed('browser:screen')).toBe(false);
		expect(webEventAllowed('remote:status')).toBe(false);
		expect(webEventAllowed('remote:dialog')).toBe(true);
		expect(webEventAllowed('remote:menu')).toBe(true);
		expect(webEventAllowed('remote:files')).toBe(false);
		expect(webCallRefusal('remote:ui-answer', [1, null])).toBeNull();
		expect(webCallRefusal('board:move', [key, 'completed'])).toBeNull();
	});
	it('answers a proposed task on the phone: create or decline by its id, not the sheet (spec/tasks#agent-created-tasks)', () => {
		expect(webCallRefusal('proposal:create', [key, 'p1'])).toBeNull();
		expect(webCallRefusal('proposal:decline', [key, 'p1'])).toBeNull();
		expect(webCallRefusal('proposal:decline', [key, ''])).toBe('Not available from a phone.');
		expect(webCallRefusal('proposal:adopt', [key, 'p1', key])).toBe('Not available from a phone.');
		expect(webCallRefusal('proposal:draft', [key, 'p1', { projectId: 'p', draft: true }])).toBe(
			'Not available from a phone.'
		);
	});
	// spec/remote-access-and-mobile#phone-pr-list: the board moves a card to any column; main keeps `boardMove`'s rules.
	it('moves a board card to every column', () => {
		for (const column of ['backlog', 'progress', 'completed'])
			expect(webCallRefusal('board:move', [key, column])).toBeNull();
	});
	it('opens the main tree for a PR without a task and resolves a conflict only by the agent (spec/remote-access-and-mobile#phone-pr-list)', () => {
		const ref = { scopeId: 'scope', number: 7 };
		expect(webCallRefusal('main-tree:open', ['p'])).toBeNull();
		expect(webCallRefusal('prs:resolve-conflicts', [key, ref, 'agent'])).toBeNull();
		expect(webCallRefusal('prs:resolve-conflicts', [key, ref, 'manual'])).toBe(
			'Not available from a phone.'
		);
	});
	it('hands a PR to the agent to fix, or reviews it with an agent in a place (spec/remote-access-and-mobile#phone-task-tools, spec/remote-access-and-mobile#phone-pr-list)', () => {
		const ref = { scopeId: 'scope', number: 7 };
		expect(webCallRefusal('prs:agent-task', [key, ref, 'fix', true])).toBeNull();
		expect(webCallRefusal('prs:agent-task', [key, ref, 'review', false, 'quick'])).toBeNull();
		expect(webCallRefusal('prs:agent-task', [key, ref, 'review', false, 'worktree'])).toBeNull();
		// A review without its place, or one that would hand drafts over, is not what the phone's sheet sends.
		expect(webCallRefusal('prs:agent-task', [key, ref, 'review', true])).toBe(
			'Not available from a phone.'
		);
		expect(webCallRefusal('prs:agent-task', [key, ref, 'review', true, 'quick'])).toBe(
			'Not available from a phone.'
		);
		expect(webCallRefusal('prs:agent-task', [key, ref, 'fix', true, 'worktree'])).toBe(
			'Not available from a phone.'
		);
	});
	// Security review W2 (spec/remote-access-and-mobile#phone-task-tools): the rows a phone reaches take only what its screens send.
	it('keeps a review patch to its three fields: no drafts or other keys written into the PR draft file', () => {
		const ref = { scopeId: 'scope', number: 7 },
			row = ipcInvokeRows.get('prs:review-set')!;
		expect(row.validate([key, ref, { body: 'ok', event: 'APPROVE', sendComments: true }])).toBe(
			true
		);
		const draft = {
			path: '../../x',
			line: 1,
			side: 'RIGHT',
			body: 'b',
			replyTo: null,
			startLine: null,
		};
		expect(row.validate([key, ref, { body: 'ok', drafts: [draft] }])).toBe(false);
		expect(row.validate([key, ref, { last: { event: 'APPROVE', at: 'x' } }])).toBe(false);
	});
	it('lists and finds only the files the phone shows: no ignored ones, no link lookup', () => {
		expect(webCallRefusal('files:list', [key, null, false])).toBeNull();
		expect(webCallRefusal('files:list', [key, null, true])).toBe('Not available from a phone.');
		expect(webCallRefusal('files:search', [key, 'env', false])).toBeNull();
		expect(webCallRefusal('files:search', [key, 'env', false, true])).toBeNull();
		expect(webCallRefusal('files:search', [key, 'env', true])).toBe('Not available from a phone.');
		expect(webCallRefusal('files:links', [key, [{ text: '.env', literal: true }]])).toBe(
			'Not available from a phone.'
		);
	});
	it('changes only the notifications in a save', () => {
		const incoming = {
			...defaultAppSettings,
			accent: 'pink' as const,
			modules: { ...defaultAppSettings.modules, remoteAccess: false },
			notifications: { ...defaultAppSettings.notifications, mode: 'off' as const },
		};
		const saved = guardPhoneSettings(incoming, defaultAppSettings);
		expect(saved.notifications.mode).toBe('off');
		expect(saved.accent).toBe(defaultAppSettings.accent);
		expect(saved.modules).toEqual(defaultAppSettings.modules);
	});
});
