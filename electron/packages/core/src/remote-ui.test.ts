import { describe, expect, it } from 'vitest';
import {
	deviceExternalUrl,
	deviceMenuItems,
	isMachineLocalUrl,
	isRemoteDialog,
	isRemoteFolderName,
	isRemoteFsPath,
	isRemoteMenu,
	isRemoteNotify,
	isRemoteSave,
	isRemoteUiAnswer,
	type NativeMenuItem,
} from './remote-ui';
import { folderAge } from './messages';
import { ipcTable } from './ipc-channels';

describe('what a device shows for the working machine (spec/remote-access-and-mobile#client-ui-seam)', () => {
	const items: NativeMenuItem[] = [
		{ id: 'open', label: 'Open', icon: 'folder' },
		null,
		{ id: 'copy', label: 'Copy path', copy: '/Users/dev/projects/shop' },
		{ id: 'finder', label: 'Reveal in Finder', reveal: '/Users/dev/projects/shop' },
		null,
		{ id: 'finder2', label: 'Reveal', reveal: '/x' },
	];
	it('drops reveal items and the separators they leave behind', () => {
		expect(deviceMenuItems(items)).toEqual([
			{ id: 'open', label: 'Open', icon: 'folder' },
			null,
			{ id: 'copy', label: 'Copy path', copy: '/Users/dev/projects/shop' },
		]);
	});
	it('takes a menu without reveal items, with known glyphs and display-only shortcuts', () => {
		const menu = { id: 3, items: deviceMenuItems(items), at: { x: 10, y: 20 } };
		expect(isRemoteMenu(menu)).toBe(true);
		expect(isRemoteMenu({ ...menu, at: null })).toBe(true);
		expect(isRemoteMenu({ ...menu, items })).toBe(false);
		expect(isRemoteMenu({ ...menu, items: [{ id: 'a', label: 'A', icon: 'no-such-glyph' }] })).toBe(
			false
		);
		expect(isRemoteMenu({ ...menu, items: [{ id: 'a', label: 'A', role: 'quit' }] })).toBe(false);
		expect(
			isRemoteMenu({ ...menu, items: [{ id: 'a', label: 'A', accelerator: 'Ctrl+Command+.' }] })
		).toBe(true);
		expect(isRemoteMenu({ ...menu, items: [{ id: 'a', label: 'A', click: 1 }] })).toBe(false);
		expect(isRemoteMenu({ ...menu, items: [] })).toBe(false);
		expect(isRemoteMenu({ ...menu, id: 0 })).toBe(false);
		expect(isRemoteMenu({ ...menu, extra: true })).toBe(false);
	});
	it('takes one level of submenu, its items counted and without reveal (spec/appearance#evolution-redesign p. 21)', () => {
		const sub: NativeMenuItem = {
			id: 'agent',
			label: 'Review with an agent',
			icon: 'generate',
			submenu: [
				{ id: 'quick', label: 'Quickly' },
				{ id: 'tree', label: 'In a worktree' },
			],
		};
		expect(isRemoteMenu({ id: 1, items: [sub], at: null })).toBe(true);
		const deep = { ...sub, submenu: [{ ...sub, id: 'inner' }] };
		expect(isRemoteMenu({ id: 1, items: [deep], at: null })).toBe(false);
		expect(isRemoteMenu({ id: 1, items: [{ ...sub, submenu: [] }], at: null })).toBe(false);
		expect(isRemoteMenu({ id: 1, items: [{ ...sub, copy: 'x' }], at: null })).toBe(false);
		const hidden = { ...sub, submenu: [{ id: 'finder', label: 'Reveal', reveal: '/x' }] };
		expect(isRemoteMenu({ id: 1, items: [hidden], at: null })).toBe(false);
		expect(deviceMenuItems([hidden, sub])).toEqual([sub]);
		const many = Array.from({ length: 32 }, (_, index) => ({ id: `i${index}`, label: 'I' }));
		expect(
			isRemoteMenu({
				id: 1,
				items: [
					{ ...sub, submenu: many },
					{ ...sub, id: 'b', submenu: many },
				],
				at: null,
			})
		).toBe(false);
	});
	it('checks message boxes, choices and saves', () => {
		const box = {
			kind: 'box',
			id: 1,
			type: 'warning',
			message: 'Delete task… Fix',
			detail: 'Local history will move to Trash.',
			buttons: ['Cancel', 'Delete task'],
			defaultId: 0,
			cancelId: 0,
			danger: 1,
		};
		expect(isRemoteDialog(box)).toBe(true);
		expect(isRemoteDialog({ ...box, cancelId: 2 })).toBe(false);
		expect(isRemoteDialog({ ...box, buttons: [] })).toBe(false);
		const pick = {
			kind: 'pick',
			id: 2,
			target: 'folder',
			title: 'Add a project from studio',
			extensions: null,
		};
		expect(isRemoteDialog(pick)).toBe(true);
		expect(isRemoteDialog({ ...pick, target: 'file', extensions: ['json'] })).toBe(true);
		expect(isRemoteDialog({ ...pick, extensions: ['.json'] })).toBe(false);
		const save = { id: 4, name: 'Reviewer.json', extensions: ['json'], text: '{}\n' };
		expect(isRemoteSave(save)).toBe(true);
		expect(isRemoteSave({ ...save, name: '../evil.json' })).toBe(false);
		expect(isRemoteUiAnswer([1, 'open'])).toBe(true);
		expect(isRemoteUiAnswer([1, 2])).toBe(true);
		expect(isRemoteUiAnswer([1, null])).toBe(true);
		expect(isRemoteUiAnswer([1, true])).toBe(true);
		expect(isRemoteUiAnswer([1, { path: '/' }])).toBe(false);
		expect(isRemoteUiAnswer([0, null])).toBe(false);
		expect(isRemoteUiAnswer([1, 'x'.repeat(5000)])).toBe(false);
		// P1: a page dialog's answer with «Don't show more dialogs from this page» ticked.
		expect(isRemoteUiAnswer([1, { value: true, mute: true }])).toBe(true);
		expect(isRemoteUiAnswer([1, { value: 'Ada', mute: true }])).toBe(true);
		expect(isRemoteUiAnswer([1, { value: null, mute: false }])).toBe(false);
		expect(isRemoteUiAnswer([1, { value: 3, mute: true }])).toBe(false);
	});
	it('takes absolute paths without dot segments and one folder name', () => {
		expect(isRemoteFsPath('/Users/dev/projects')).toBe(true);
		expect(isRemoteFsPath('/')).toBe(true);
		expect(isRemoteFsPath('Users/dev')).toBe(false);
		expect(isRemoteFsPath('/Users/../etc')).toBe(false);
		expect(isRemoteFsPath('/a/./b')).toBe(false);
		expect(isRemoteFolderName('new folder')).toBe(true);
		expect(isRemoteFolderName('a/b')).toBe(false);
		expect(isRemoteFolderName('..')).toBe(false);
		expect(isRemoteFolderName(' ')).toBe(false);
	});
	it('checks notices, sounds and the badge', () => {
		const notice = {
			id: 'n1',
			groupId: 'project/task',
			key: { projectId: 'project', id: 'task' },
			title: 'Fix',
			body: 'Waits for you',
			actions: { allow: 'Allow', deny: null },
		};
		expect(isRemoteNotify({ kind: 'show', id: 1, notice })).toBe(true);
		expect(isRemoteNotify({ kind: 'show', id: 1, notice: { ...notice, key: 'x' } })).toBe(false);
		expect(isRemoteNotify({ kind: 'sound', name: 'Glass' })).toBe(true);
		expect(isRemoteNotify({ kind: 'sound', name: '../x' })).toBe(false);
		expect(isRemoteNotify({ kind: 'badge', count: 3 })).toBe(true);
		expect(isRemoteNotify({ kind: 'badge', count: -1 })).toBe(false);
		expect(isRemoteNotify({ kind: 'open' })).toBe(false);
	});
});

describe('«Open in default browser» from a window of the machine (spec/remote-access-and-mobile#client-ui-seam)', () => {
	it('hides the machine itself and its local network', () => {
		for (const url of [
			'http://localhost:3000/',
			'http://app.localhost/',
			'http://127.0.0.1:8080',
			'http://127.4.5.6',
			'http://[::1]:3000/',
			'http://10.0.0.5/',
			'http://172.20.1.1/',
			'http://192.168.1.24:5173/',
			'http://studio.local/',
			'http://[fd12::1]/',
			'http://[fe80::1]/',
			'http://devbox/',
			'http://100.88.14.2/',
		])
			expect(isMachineLocalUrl(url), url).toBe(true);
		expect(deviceExternalUrl('http://192.168.1.24:5173/')).toBeNull();
	});
	it('opens public pages on the device', () => {
		for (const url of [
			'https://github.com/acme/app/pull/12',
			'http://example.com/',
			'https://172.32.0.1/',
			'https://8.8.8.8/',
		]) {
			expect(isMachineLocalUrl(url), url).toBe(false);
			expect(deviceExternalUrl(url)).toBe(url);
		}
		expect(deviceExternalUrl('mailto:a@b.c')).toBeNull();
		expect(deviceExternalUrl('file:///etc/passwd')).toBeNull();
	});
});

describe('folder browser time (canvas `Folder`)', () => {
	const now = new Date(2026, 9, 15, 19, 20).getTime();
	it('says minutes, today, yesterday, days, weeks, a month, the month and the year', () => {
		expect(folderAge('uk', now - 5 * 60_000, now)).toBe('5 хв тому');
		expect(folderAge('en', now - 5 * 60_000, now)).toBe('5 min ago');
		expect(folderAge('uk', new Date(2026, 9, 15, 9).getTime(), now)).toBe('сьогодні');
		expect(folderAge('uk', new Date(2026, 9, 14, 9).getTime(), now)).toBe('вчора');
		expect(folderAge('uk', new Date(2026, 9, 12, 9).getTime(), now)).toBe('3 дні');
		expect(folderAge('uk', new Date(2026, 9, 10, 9).getTime(), now)).toBe('5 днів');
		expect(folderAge('en', new Date(2026, 9, 12, 9).getTime(), now)).toBe('3 days');
		expect(folderAge('uk', new Date(2026, 9, 1, 9).getTime(), now)).toBe('2 тижні');
		expect(folderAge('uk', new Date(2026, 8, 5, 9).getTime(), now)).toBe('місяць');
		expect(folderAge('uk', new Date(2026, 7, 5, 9).getTime(), now)).toBe('серпень');
		expect(folderAge('en', new Date(2026, 7, 5, 9).getTime(), now)).toBe('August');
		expect(folderAge('uk', new Date(2024, 7, 5, 9).getTime(), now)).toBe('2024');
		expect(folderAge('uk', null, now)).toBe('');
	});
});

describe('table rows of R2 (spec/remote-access-and-mobile#client-ui-seam)', () => {
	it('classes the menus that read the machine as remote and validates the new rows', () => {
		for (const method of [
			'taskMenu',
			'projectMenu',
			'taskOptionMenu',
			'fileMenu',
			'editorMenu',
			'documentTabMenu',
			'turnMenu',
			'projectCommandMenu',
			'answerRemoteUi',
			'listRemoteFolder',
			'createRemoteFolder',
			'uploadAttachment',
			'readMachineAppearance',
			'readPullRequestPageUrl',
			'readPullRequestLinkUrl',
			'readPullRequestUrl',
		] as const)
			expect(ipcTable[method].class, method).toBe('remote');
		for (const method of [
			'chatMenu',
			'terminalMenu',
			'sheetAttachMenu',
			'openAppMenu',
			'pickAttachments',
		] as const)
			expect(ipcTable[method].class, method).toBe('client');
		const upload = ipcTable.uploadAttachment.validate;
		const owner = { projectId: 'project', id: 'task' };
		expect(upload([owner, 'notes.pdf', new Uint8Array([1]), false])).toBe(true);
		expect(upload([owner, '../notes.pdf', new Uint8Array([1]), false])).toBe(false);
		expect(upload([owner, 'notes.pdf', 'AAAA', false])).toBe(false);
		expect(upload([owner, 'notes.pdf', new Uint8Array(0), false])).toBe(false);
		expect(upload([owner, 'notes.pdf', new Uint8Array(10 * 1024 * 1024 + 1), false])).toBe(false);
		const list = ipcTable.listRemoteFolder.validate;
		expect(list([1, null, false])).toBe(true);
		expect(list([1, '/Users/dev', true])).toBe(true);
		expect(list([1, '/Users/../etc', true])).toBe(false);
		expect(list([1, 'relative', true])).toBe(false);
	});
});

describe('security review R2–R4, V5: the machine’s own addresses in every spelling', () => {
	it('hides loopback and private hosts written as browsers read them, not only as dotted quads', () => {
		for (const url of [
			'http://127.1:3000/',
			'http://0x7f.0.0.1/',
			'http://0177.0.0.1/',
			'http://2130706433/',
			'http://0x7f000001/',
			'http://[0:0:0:0:0:0:0:1]/',
			'http://[::127.0.0.1]/',
			'http://[::ffff:127.0.0.1]/',
			'http://[::ffff:7f00:1]/',
			'http://0.0.0.0:8080/',
			'http://10.1/',
			'http://0xc0.0xa8.1.1/',
			'http://[fd00::1]/',
			'http://LOCALHOST./',
		])
			expect([url, deviceExternalUrl(url)]).toEqual([url, null]);
		expect(deviceExternalUrl('https://example.com/a')).toBe('https://example.com/a');
		expect(deviceExternalUrl('http://8.8.8.8/')).toBe('http://8.8.8.8/');
		expect(deviceExternalUrl('http://[2001:db8::1]/')).toBe('http://[2001:db8::1]/');
	});
});
