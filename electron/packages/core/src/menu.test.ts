import { expect, it } from 'vitest';
import {
	emptyMenuContext,
	isMenuContext,
	menuCommands,
	menuCommandEnabled,
	withGroupSeparators,
	type MenuContext,
} from './menu';
it('bounds the availability payload and blocks commands under a modal', () => {
	expect(isMenuContext(emptyMenuContext)).toBe(true);
	expect(isMenuContext({ ...emptyMenuContext, task: 'yes' })).toBe(false);
	expect(isMenuContext({ ...emptyMenuContext, path: '/tmp' })).toBe(false);
	const all = Object.fromEntries(
		Object.keys(emptyMenuContext).map((key) => [key, true])
	) as MenuContext;
	expect(menuCommands.filter((command) => menuCommandEnabled(command, all))).toEqual([]);
});
it('has no competing accelerators in reachable surface contexts', () => {
	expect(new Set(menuCommands.map((command) => command.id)).size).toBe(menuCommands.length);
	for (const surface of ['editor', 'diff', 'activity', 'console', 'browser'] as const) {
		const context = {
			...emptyMenuContext,
			task: true,
			project: true,
			needsYou: true,
			[surface]: true,
			font: surface !== 'browser' && surface !== 'activity',
			document: surface === 'editor' || surface === 'diff',
			find: ['editor', 'diff', 'activity'].includes(surface),
		};
		const accelerators = menuCommands
			.filter(
				(command) =>
					command.accelerator && menuCommandEnabled(command, context, surface === 'browser')
			)
			.map((command) => command.accelerator);
		expect(new Set(accelerators).size, `${surface} shortcut collision`).toBe(accelerators.length);
	}
});
it('gives native browser focus priority over a stale renderer context', () => {
	const context = {
		...emptyMenuContext,
		editor: true,
		document: true,
		diff: true,
		font: true,
		browser: true,
	};
	const enabled = menuCommands
		.filter((command) => menuCommandEnabled(command, context, true))
		.map((command) => command.id);
	expect(enabled).toContain('browser-back');
	expect(enabled).not.toContain('editor-outdent');
	expect(enabled).not.toContain('font-increase');
	expect(enabled).not.toContain('document-next');
});

it('disables empty submissions, missing permission choices and one-tab console navigation', () => {
	const enabled = (id: string, patch: Partial<MenuContext>) =>
		menuCommandEnabled(
			menuCommands.find((command) => command.id === id)!,
			{ ...emptyMenuContext, ...patch }
		);
	expect(enabled('review-send', {})).toBe(false);
	expect(enabled('review-send', { question: true })).toBe(true);
	expect(enabled('review-send-go', { permission: true })).toBe(false);
	expect(enabled('review-send-go', { permissionAlways: true })).toBe(true);
	expect(enabled('review-send-go', { comment: true })).toBe(false);
	expect(enabled('review-send-go', { commentGo: true })).toBe(true);
	expect(enabled('terminal-next', { console: true })).toBe(false);
	expect(enabled('terminal-next', { console: true, terminalTabs: true })).toBe(true);
	expect(enabled('terminal-compose', { console: true })).toBe(false);
	expect(enabled('diff-comment', { diff: true })).toBe(false);
	expect(enabled('diff-comment', { diff: true, diffSelection: true })).toBe(true);
});

it('moves between turns only while a turn rail is on screen (spec/chat-turns-plans-and-questions#turn-rail)', () => {
	const enabled = (id: string, patch: Partial<MenuContext>) =>
		menuCommandEnabled(
			menuCommands.find((command) => command.id === id)!,
			{ ...emptyMenuContext, ...patch }
		);
	for (const id of ['turn-next', 'turn-previous']) {
		expect(enabled(id, { activity: true })).toBe(false);
		expect(enabled(id, { turnRail: true })).toBe(true);
		expect(enabled(id, { turnRail: true, modal: true })).toBe(false);
	}
	expect(
		menuCommands
			.filter((command) => command.id.startsWith('turn-'))
			.map((command) => command.accelerator)
	).toEqual(['CmdOrCtrl+Alt+Down', 'CmdOrCtrl+Alt+Up']);
});

it('refreshes pull requests with ⌘R only from the PR panel, never from the focused browser (spec/pull-requests-and-ci#reading-and-refresh)', () => {
	const refresh = menuCommands.find((command) => command.id === 'pull-requests-refresh')!;
	expect(refresh.accelerator).toBe('CmdOrCtrl+R');
	expect(refresh.group).toBe('View');
	expect(menuCommandEnabled(refresh, { ...emptyMenuContext, task: true })).toBe(false);
	expect(menuCommandEnabled(refresh, { ...emptyMenuContext, pullRequests: true })).toBe(true);
	expect(menuCommandEnabled(refresh, { ...emptyMenuContext, pullRequests: true }, true)).toBe(
		false
	);
	expect(
		menuCommandEnabled(refresh, { ...emptyMenuContext, pullRequests: true, modal: true })
	).toBe(false);
});

it('never enables Add to queue and Submit together: both are ⌘↩ (spec/composer-steering-queue-and-ghost#steering-hold)', () => {
	const queue = menuCommands.find((command) => command.id === 'composer-queue')!,
		submit = menuCommands.find((command) => command.id === 'review-send')!;
	expect(queue.accelerator).toBe(submit.accelerator);
	// View: «Додати в чергу» right after «Зупинити».
	const view = menuCommands
		.filter((command) => command.group === 'View')
		.map((command) => command.id);
	expect(view.indexOf('composer-queue')).toBe(view.indexOf('cancel') + 1);
	const keys = ['composerQueue', 'review', 'permission', 'question', 'comment'] as const;
	for (let mask = 0; mask < 1 << keys.length; mask++) {
		const context: MenuContext = {
			...emptyMenuContext,
			task: true,
			...Object.fromEntries(keys.map((key, index) => [key, Boolean(mask & (1 << index))])),
		};
		expect(
			menuCommandEnabled(queue, context) && menuCommandEnabled(submit, context),
			JSON.stringify(context)
		).toBe(false);
	}
	expect(menuCommandEnabled(queue, { ...emptyMenuContext, composerQueue: true })).toBe(true);
	expect(menuCommandEnabled(queue, { ...emptyMenuContext, composerQueue: true }, true)).toBe(false);
	expect(menuCommandEnabled(queue, { ...emptyMenuContext, composerQueue: true, modal: true })).toBe(
		false
	);
});

it('puts Close tab after Close task and the find panel items after Find and replace (spec/search-menus-and-commands#menu-structure)', () => {
	const ids = (group: string) =>
		menuCommands.filter((command) => command.group === group).map((command) => command.id);
	const file = ids('File');
	expect(file.indexOf('close-tab')).toBe(file.indexOf('close-task') + 1);
	const editor = ids('Editor');
	expect(editor.slice(editor.indexOf('editor-replace') + 1).slice(0, 3)).toEqual([
		'editor-find-next',
		'editor-find-previous',
		'editor-replace-all',
	]);
	const enabled = (id: string, patch: Partial<MenuContext>, browser = false) =>
		menuCommandEnabled(
			menuCommands.find((command) => command.id === id)!,
			{ ...emptyMenuContext, ...patch },
			browser
		);
	expect(enabled('close-tab', { task: true })).toBe(false);
	expect(enabled('close-tab', { task: true, document: true })).toBe(true);
	expect(enabled('close-tab', { task: true, document: true, modal: true })).toBe(false);
	expect(enabled('close-tab', { task: true, document: true }, true)).toBe(false);
	for (const id of ['editor-find-next', 'editor-find-previous', 'editor-replace-all']) {
		expect(enabled(id, { task: true })).toBe(false);
		expect(enabled(id, { editor: true })).toBe(true);
	}
});

it('splits Editor and View into groups without changing the order (spec/search-menus-and-commands#menu-structure)', () => {
	const ids = (group: string) =>
		menuCommands
			.filter((command) => command.group === group)
			.map((command) => ({ id: command.id }));
	const editor = withGroupSeparators(ids('Editor'));
	expect(editor.filter((item) => item.id).map((item) => item.id)).toEqual(
		ids('Editor').map((item) => item.id)
	);
	expect(editor.filter((item) => (item as { type?: string }).type === 'separator')).toHaveLength(4);
	const view = withGroupSeparators(ids('View'));
	expect(view.filter((item) => (item as { type?: string }).type === 'separator')).toHaveLength(6);
	// No leading separator and none twice in a row, even when a module hides the group's first item.
	const hidden = withGroupSeparators(
		ids('View').filter((item) => item.id !== 'turns' && item.id !== 'cancel')
	);
	expect((hidden[0] as { type?: string }).type).toBeUndefined();
	hidden.forEach((item, index) => {
		if ((item as { type?: string }).type === 'separator')
			expect((hidden[index + 1] as { type?: string })?.type).toBeUndefined();
	});
});
