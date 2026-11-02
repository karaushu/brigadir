import type { Locator } from '@playwright/test';
/**
 * spec/composer#mentions: the composer (like the sheet's prompt) is CodeMirror, not a textarea — its raw text, tokens and line breaks included,
 * and the caret, read from the editor's state behind the editable element.
 */
export function editorState(
	field: Locator
): Promise<{ text: string; caret: number; selected: string; focused: boolean }> {
	return field.evaluate((node) => {
		const view = (
			node as unknown as {
				cmTile?: {
					root?: {
						view?: {
							state: {
								doc: { toString(): string };
								selection: { main: { head: number; from: number; to: number } };
								sliceDoc(from: number, to: number): string;
							};
							hasFocus: boolean;
						};
					};
				};
			}
		).cmTile?.root?.view;
		if (!view) throw new Error('Not a CodeMirror editor');
		const range = view.state.selection.main;
		return {
			text: view.state.doc.toString(),
			caret: range.head,
			selected: view.state.sliceDoc(range.from, range.to),
			focused: view.hasFocus,
		};
	});
}
export const editorText = async (field: Locator) => (await editorState(field)).text;
/** Puts the caret at `position` in the editor, as a click in the text would. */
export function setEditorCaret(field: Locator, position: number) {
	return field.evaluate((node, position) => {
		const view = (
			node as unknown as {
				cmTile?: { root?: { view?: { focus(): void; dispatch(spec: object): void } } };
			}
		).cmTile?.root?.view;
		if (!view) throw new Error('Not a CodeMirror editor');
		view.focus();
		view.dispatch({ selection: { anchor: position } });
	}, position);
}
