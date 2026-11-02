import { describe, expect, it } from 'vitest';
import {
	selectDocument,
	closeDocument,
	documentForDiff,
	documentForFile,
	documentTabMenuItems,
	documentsToClose,
	isDocumentTabMenuState,
	documentTabTails,
	type DocumentTabs,
	type DocumentTabMenuState,
} from './document-tabs';
describe('mixed editor documents', () => {
	const empty: DocumentTabs = { documents: [], activeDocument: null };
	it('keeps the file beside its diff and does not duplicate either document', () => {
		const diff = documentForDiff('scope/src/a.ts'),
			file = documentForFile('file-id', 'src/a.ts');
		const state = selectDocument(selectDocument(selectDocument(empty, diff), file), diff);
		expect(state.documents).toEqual([diff, file]);
		expect(state.activeDocument).toBe(diff.id);
		expect(selectDocument(state, documentForDiff('other/src/a.ts')).documents).toHaveLength(3);
		const unrelated = documentForFile('other', 'other.ts');
		const withOther = selectDocument(selectDocument(selectDocument(empty, diff), unrelated), diff);
		expect(selectDocument(withOther, file).documents).toEqual([diff, file, unrelated]);
	});
	it('closes to the adjacent document without moving the active tab when another closes', () => {
		const a = documentForDiff('scope/a'),
			b = documentForFile('b', 'b'),
			c = documentForFile('c', 'c');
		const state = selectDocument(selectDocument(selectDocument(empty, a), b), c);
		expect(closeDocument(state, a.id).activeDocument).toBe(c.id);
		const after = closeDocument(state, c.id);
		expect(after.activeDocument).toBe(b.id);
		expect(closeDocument(closeDocument(after, b.id), a.id)).toEqual(empty);
	});
});

describe('document tab menu (spec/editor#tab-menu)', () => {
	const a = documentForDiff('scope/a'),
		b = documentForFile('b', 'b'),
		c = documentForFile('c', 'c'),
		d = documentForDiff('pr:1:scope/d'),
		tabs = [a, b, c, d];
	const dirty = (tab: { id: string }) => tab.id === c.id;
	it('picks the tabs each close action takes, in strip order', () => {
		expect(documentsToClose(tabs, b.id, 'close', dirty)).toEqual([b]);
		expect(documentsToClose(tabs, b.id, 'close-others', dirty)).toEqual([a, c, d]);
		expect(documentsToClose(tabs, b.id, 'close-all', dirty)).toEqual(tabs);
		expect(documentsToClose(tabs, b.id, 'close-right', dirty)).toEqual([c, d]);
		expect(documentsToClose(tabs, d.id, 'close-right', dirty)).toEqual([]);
		expect(documentsToClose(tabs, b.id, 'close-unmodified', dirty)).toEqual([a, b, d]);
		expect(documentsToClose(tabs, 'missing', 'close-all', dirty)).toEqual([]);
	});
	const state: DocumentTabMenuState = {
		close: true,
		others: true,
		right: true,
		unmodified: true,
		reopen: true,
		groups: 2,
		file: { id: 'f'.repeat(64), source: 'editor' },
		at: null,
		underChat: null,
	};
	it('keeps the same items in the same order and disables what does not apply', () => {
		const ids = (value: DocumentTabMenuState) =>
			documentTabMenuItems(value).map((item) => item?.id ?? '-');
		const none = {
			...state,
			close: false,
			others: false,
			right: false,
			unmodified: false,
			reopen: false,
			groups: 1,
			file: null,
		};
		expect(ids(none)).toEqual(ids(state));
		expect(ids(state)).toEqual([
			'close',
			'close-others',
			'close-all',
			'close-unmodified',
			'close-right',
			'reopen-tab',
			'-',
			'copy-path',
			'copy-absolute',
			'finder',
			'-',
			'split-right',
			'split-down',
			'split-move-right',
			'split-move-down',
			'move-other-group',
			'unsplit',
			'unsplit-all',
		]);
		// spec/editor#editor-groups: Split always applies; Move needs another tab to keep in the group; the group items need a second group.
		expect(
			documentTabMenuItems(none)
				.filter((item) => item?.enabled)
				.map((item) => item!.id)
		).toEqual(['close-all', 'split-right', 'split-down']);
		// spec/editor#reopen-closed-tab: Reopen closed tab shows the menu bar's key of the keymap.
		expect(documentTabMenuItems(state).find((item) => item?.id === 'reopen-tab')).toMatchObject({
			enabled: true,
			accelerator: 'Shift+CmdOrCtrl+T',
		});
		expect(
			documentTabMenuItems(state, {
				preset: 'brigadir',
				overrides: { 'reopen-tab': null },
			}).find((item) => item?.id === 'reopen-tab')?.accelerator
		).toBeUndefined();
		// spec/task-window-workspace#work-area: a tab of the bottom group adds its check item «Under the chat» after a line.
		const bottom = documentTabMenuItems({ ...state, underChat: true });
		expect(bottom.slice(-2)).toEqual([
			null,
			expect.objectContaining({ id: 'under-chat', checked: true, enabled: true }),
		]);
	});
	it('gives every item its own glyph (spec/editor#editor-groups)', () => {
		const items = documentTabMenuItems(state).filter((item) => item !== null);
		expect(items.every((item) => typeof item!.icon === 'string')).toBe(true);
		expect(new Set(items.map((item) => item!.icon)).size).toBe(items.length);
	});

	it('validates the state from the renderer', () => {
		expect(isDocumentTabMenuState(state)).toBe(true);
		expect(isDocumentTabMenuState({ ...state, file: null, at: { x: 4, y: 8 } })).toBe(true);
		expect(
			isDocumentTabMenuState({ ...state, file: { id: '../etc/passwd', source: 'editor' } })
		).toBe(false);
		expect(isDocumentTabMenuState({ ...state, file: { id: 'f'.repeat(64), source: 'tree' } })).toBe(
			false
		);
		expect(isDocumentTabMenuState({ ...state, extra: true })).toBe(false);
		expect(isDocumentTabMenuState({ ...state, groups: 0 })).toBe(false);
		expect(isDocumentTabMenuState({ ...state, groups: 1.5 })).toBe(false);
	});
});
describe('tails of namesake tabs (spec/appearance#evolution-redesign)', () => {
	const tails = (...paths: string[]) => {
		const result = documentTabTails(paths.map((path) => documentForFile(path, path)));
		return paths.map((path) => result.get(`file:${path}`) ?? null);
	};
	it('gives only the namesakes the shortest parent folder that tells them apart', () => {
		expect(
			tails(
				'screens/Feedbacks/components/FeedbackListItem/index.tsx',
				'screens/Feedbacks/components/FeedbackListItemInner/index.tsx',
				'screens/hooks.ts'
			)
		).toEqual(['…/FeedbackListItem', '…/FeedbackListItemInner', null]);
	});
	it('grows to the first folder that differs when the parents are the same', () => {
		expect(
			tails(
				'screens/Orders/components/Header/index.tsx',
				'screens/Feedbacks/components/Header/index.tsx'
			)
		).toEqual(['Orders/…/Header', 'Feedbacks/…/Header']);
		expect(tails('Orders/Header/index.tsx', 'Feedbacks/Header/index.tsx')).toEqual([
			'Orders/Header',
			'Feedbacks/Header',
		]);
	});
	it('keeps a top-level parent without the ellipsis and leaves a root file without a tail', () => {
		expect(tails('src/index.ts', 'index.ts', 'lib/index.ts')).toEqual(['src', null, 'lib']);
	});
	// Two namesake pairs and a lone file open together.
	it('tells two namesake pairs apart independently and leaves the lone file bare', () => {
		expect(
			tails(
				'screens/hooks.ts',
				'screens/Feedbacks/components/FeedbackListItem/index.tsx',
				'screens/Feedbacks/components/FeedbackListItemInner/index.tsx',
				'screens/Orders/components/Header/useHeader.ts',
				'screens/Feedbacks/components/Header/useHeader.ts'
			)
		).toEqual([
			null,
			'…/FeedbackListItem',
			'…/FeedbackListItemInner',
			'Orders/…/Header',
			'Feedbacks/…/Header',
		]);
	});
	it('falls back to the whole run of folders when the shown ends match', () => {
		const found = tails('X/a/c/index.ts', 'X/b/c/index.ts', 'Z/a/c/index.ts', 'Z/b/c/index.ts');
		expect(new Set(found).size).toBe(4);
		expect(found[0]).toBe('X/a/c');
	});
	it('takes a diff of the same file for that file, and skips tools and the Overview', () => {
		const result = documentTabTails([
			documentForFile('f', 'apps/admin/src/index.ts'),
			documentForDiff('scope/src/index.ts'),
			{ id: 'overview', kind: 'diff', path: 'index.ts', target: 'overview:503' },
			{ id: 'terminal:1', kind: 'terminal', path: 'index.ts', target: '1' },
		]);
		expect(result.size).toBe(0);
	});
});
