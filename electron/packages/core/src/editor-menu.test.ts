import { afterEach, describe, expect, it } from 'vitest';
import {
	editorMenuItems,
	isEditorMenuState,
	pathWithLines,
	type EditorMenuState,
} from './editor-menu';
import { menuCommands } from './menu';
import { commandAccelerator, defaultKeymap, setShortcutPlatform } from './keymap';
import { t } from './messages';

afterEach(() => setShortcutPlatform('darwin'));
const idle: EditorMenuState = {
	selection: false,
	word: false,
	change: false,
	revert: false,
	editable: false,
	format: false,
	comment: false,
	lines: { start: 3, end: 3 },
	at: null,
	git: { history: false, commit: false },
	script: null,
};
const busy: EditorMenuState = {
	selection: true,
	word: true,
	change: true,
	revert: true,
	editable: true,
	format: true,
	comment: true,
	lines: { start: 3, end: 7 },
	at: { x: 10, y: 20 },
	git: { history: true, commit: true },
	script: null,
};
const ids = (state: EditorMenuState) => editorMenuItems(state).map((item) => item?.id ?? '-');

describe('editor menu (spec/editor#editor-context-menu)', () => {
	it('keeps the same items in the same order in any state', () => {
		expect(ids(idle)).toEqual(ids(busy));
		expect(ids(idle)).toEqual([
			'ask',
			'comment',
			'compose',
			'-',
			'definition',
			'references',
			'-',
			'diff',
			'revert',
			'-',
			'history',
			'line-commit',
			'-',
			'cut',
			'copy',
			'paste',
			'toggle-comment',
			'format',
			'-',
			'copy-line',
			'copy-path',
			'terminal',
			'finder',
		]);
	});
	it('disables what does not apply instead of hiding it', () => {
		const enabled = (state: EditorMenuState) =>
			editorMenuItems(state)
				.filter((item) => item?.enabled)
				.map((item) => item!.id);
		expect(enabled(idle)).toEqual([
			'ask',
			'compose',
			'copy-line',
			'copy-path',
			'terminal',
			'finder',
		]);
		expect(enabled(busy)).toEqual(ids(busy).filter((id) => id !== '-'));
		// A read-only file still copies a selection but neither cuts nor pastes.
		expect(enabled({ ...idle, selection: true })).toContain('copy');
		expect(enabled({ ...idle, selection: true })).not.toContain('cut');
	});
	it('shows the menu bar accelerators', () => {
		const shown = Object.fromEntries(
			editorMenuItems(busy)
				.filter((item) => item?.accelerator)
				.map((item) => [item!.id, item!.accelerator])
		);
		const bar = (id: string) =>
			commandAccelerator(
				menuCommands.find((command) => command.id === id)!,
				defaultKeymap
			);
		expect(shown).toMatchObject({
			ask: bar('ask-agent'),
			definition: bar('editor-definition'),
			references: bar('editor-references'),
			revert: bar('editor-change-revert'),
			'toggle-comment': bar('editor-comment'),
			format: bar('editor-format'),
		});
		expect(Object.values(shown).every(Boolean)).toBe(true);
	});
	it("takes the keymap's key per platform and the person's own, not the command's raw default", () => {
		const revert = (keymap = defaultKeymap) =>
			editorMenuItems(busy, keymap).find((item) => item?.id === 'revert')?.accelerator;
		expect(revert()).toBe('Alt+CmdOrCtrl+Z');
		expect(
			revert({ preset: 'brigadir', overrides: { 'editor-change-revert': 'CmdOrCtrl+Shift+R' } })
		).toBe('Shift+CmdOrCtrl+R');
		expect(revert({ preset: 'brigadir', overrides: { 'editor-change-revert': null } })).toBe(
			undefined
		);
		for (const platform of ['win32', 'linux'] as const) {
			setShortcutPlatform(platform);
			// ⌥⌘Z reads Ctrl+Alt+Z, AltGr+Z in European layouts: the menu bar has Ctrl+Alt+Shift+Z there, and so does this menu.
			expect(revert()).toBe('Ctrl+Alt+Shift+Z');
		}
	});
	it('names every item in both languages', () => {
		for (const item of editorMenuItems(busy)) if (item) expect(t('uk', item.label)).toBeTruthy();
		expect(t('uk', 'Copy path:line')).toBe('Копіювати шлях:рядок');
	});
	it('leads a package.json menu with its script group, disabled off a script line (spec/search-menus-and-commands#package-scripts)', () => {
		expect(ids({ ...idle, script: false }).slice(0, 3)).toEqual([
			'script-run',
			'script-command',
			'-',
		]);
		expect(ids({ ...idle, script: false }).slice(3)).toEqual(ids(idle));
		const enabled = (state: EditorMenuState) =>
			editorMenuItems(state)
				.filter((item) => item?.enabled)
				.map((item) => item!.id);
		expect(enabled({ ...idle, script: false })).toEqual(enabled(idle));
		expect(enabled({ ...idle, script: true }).slice(0, 2)).toEqual([
			'script-run',
			'script-command',
		]);
		expect(isEditorMenuState({ ...idle, script: true })).toBe(true);
		expect(isEditorMenuState({ ...idle, script: 'web' })).toBe(false);
	});
	it('formats path:line like the composer attachment name', () => {
		expect(pathWithLines('src/a.ts', { start: 12, end: 12 })).toBe('src/a.ts:12');
		expect(pathWithLines('src/a.ts', { start: 12, end: 20 })).toBe('src/a.ts:12-20');
	});
	it('validates the IPC state', () => {
		expect(isEditorMenuState(idle)).toBe(true);
		expect(isEditorMenuState(busy)).toBe(true);
		expect(isEditorMenuState({ ...idle, lines: { start: 5, end: 4 } })).toBe(false);
		expect(isEditorMenuState({ ...idle, lines: { start: 0, end: 1 } })).toBe(false);
		expect(isEditorMenuState({ ...idle, at: { x: -1, y: 0 } })).toBe(false);
		expect(isEditorMenuState({ ...idle, extra: true })).toBe(false);
		const { word: _word, ...missing } = idle;
		expect(isEditorMenuState(missing)).toBe(false);
		expect(isEditorMenuState({ ...idle, git: { history: true } })).toBe(false);
	});
	it('offers the file history and the line commit only in Git (spec/editor#line-author)', () => {
		const enabled = (state: EditorMenuState) =>
			editorMenuItems(state)
				.filter((item) => item?.enabled)
				.map((item) => item!.id);
		expect(enabled({ ...idle, git: { history: true, commit: false } })).toContain('history');
		expect(enabled({ ...idle, git: { history: true, commit: false } })).not.toContain(
			'line-commit'
		);
		expect(t('uk', 'File history')).toBe('Історія файла');
		expect(t('uk', 'Commit of this line')).toBe('Коміт цього рядка');
	});
});
