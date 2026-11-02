import { describe, expect, it } from 'vitest';
import { isTerminalMenuState, terminalMenuItems, type TerminalMenuState } from './terminal-menu';
import { t } from './messages';
import { setShortcutPlatform } from './keymap';

const none: TerminalMenuState = { selection: false, link: null, browser: true, canPaste: true };
const ids = (state: TerminalMenuState) =>
	terminalMenuItems(state).map((item) =>
		item ? `${item.id}${item.enabled ? '' : ' (off)'}` : '-'
	);

describe('console menu (spec/terminal-and-cli-agents#console-links)', () => {
	it('always has the edit group and the agent group', () => {
		expect(ids(none)).toEqual(['copy (off)', 'paste', 'select-all', '-', 'show-agent', 'clear']);
		expect(ids({ ...none, selection: true, canPaste: false })).toEqual([
			'copy',
			'paste (off)',
			'select-all',
			'-',
			'show-agent',
			'clear',
		]);
	});
	it('puts the link group first: the task browser, the system browser, Copy link', () => {
		expect(ids({ ...none, link: 'web' }).slice(0, 4)).toEqual([
			'open-task-browser',
			'open-system',
			'copy-link',
			'-',
		]);
		expect(ids({ ...none, link: 'web', browser: false }).slice(0, 3)).toEqual([
			'open-system',
			'copy-link',
			'-',
		]);
		expect(ids({ ...none, link: 'mail' }).slice(0, 3)).toEqual(['open-system', 'copy-link', '-']);
		expect(ids({ ...none, link: 'file' }).slice(0, 2)).toEqual(['open-file', '-']);
		expect(ids({ ...none, link: 'folder' }).slice(0, 2)).toEqual(['open-file', '-']);
		expect(isTerminalMenuState({ ...none, link: 'folder' })).toBe(true);
	});
	it('puts Open in the PR panel first on a PR link (spec/terminal-and-cli-agents#console-menu)', () => {
		expect(ids({ ...none, link: 'pr' }).slice(0, 5)).toEqual([
			'open-pr',
			'open-task-browser',
			'open-system',
			'copy-link',
			'-',
		]);
		expect(ids({ ...none, link: 'pr', browser: false }).slice(0, 4)).toEqual([
			'open-pr',
			'open-system',
			'copy-link',
			'-',
		]);
		expect(t('uk', terminalMenuItems({ ...none, link: 'pr' })[0]!.label)).toBe(
			'Відкрити в панелі PR'
		);
		expect(isTerminalMenuState({ ...none, link: 'pr' })).toBe(true);
	});
	it('names the items in the terms of the chat menu and the glossary', () => {
		const all = terminalMenuItems({ ...none, link: 'web' }).flatMap((item) =>
			item ? [t('uk', item.label)] : []
		);
		expect(all).toEqual([
			'Відкрити в браузері задачі',
			'Відкрити в системному браузері',
			'Копіювати посилання',
			'Копіювати',
			'Вставити',
			'Вибрати все',
			'Показати агенту',
			'Очистити термінал',
		]);
	});
	it('shows the keymap key of Clear terminal, not a fixed one (spec/search-menus-and-commands#menu-structure)', () => {
		const clear = (keymap?: Parameters<typeof terminalMenuItems>[1]) =>
			terminalMenuItems(none, keymap).find((item) => item?.id === 'clear')!.accelerator;
		expect(clear()).toBe('CmdOrCtrl+K');
		expect(clear({ preset: 'brigadir', overrides: { 'terminal-clear': 'CmdOrCtrl+Alt+K' } })).toBe(
			'Alt+CmdOrCtrl+K'
		);
		expect(clear({ preset: 'brigadir', overrides: { 'terminal-clear': null } })).toBeUndefined();
		setShortcutPlatform('linux');
		try {
			expect(clear()).toBe('Ctrl+K');
		} finally {
			setShortcutPlatform('darwin');
		}
	});
	it('validates the IPC state', () => {
		expect(isTerminalMenuState(none)).toBe(true);
		expect(isTerminalMenuState({ ...none, link: 'file' })).toBe(true);
		expect(isTerminalMenuState({ ...none, link: 'ftp' })).toBe(false);
		expect(isTerminalMenuState({ ...none, extra: true })).toBe(false);
		expect(isTerminalMenuState({ ...none, canPaste: 1 })).toBe(false);
	});
});
