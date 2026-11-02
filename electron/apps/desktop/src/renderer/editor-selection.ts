import { StateField, type EditorState } from '@codemirror/state';
import { Decoration, EditorView, WidgetType } from '@codemirror/view';

class SelectionBlock extends WidgetType {
	private observer?: ResizeObserver;
	constructor(readonly host: HTMLElement) {
		super();
	}
	override eq(other: SelectionBlock) {
		return other.host === this.host;
	}
	override toDOM(view: EditorView) {
		const measure = () =>
			view.requestMeasure({
				key: this,
				read: () => ({
					width: view.scrollDOM.clientWidth,
					gutter: view.dom.querySelector('.cm-gutters')?.getBoundingClientRect().width ?? 0,
				}),
				write: ({ width, gutter }) => {
					this.host.style.setProperty('--review-available', `${width - gutter}px`);
					this.host.style.setProperty('--review-inset', `${Math.max(8, 44 - gutter)}px`);
				},
			});
		this.observer = new ResizeObserver(() => {
			measure();
			view.requestMeasure();
		});
		this.observer.observe(this.host);
		this.observer.observe(view.scrollDOM);
		measure();
		return this.host;
	}
	override destroy() {
		this.observer?.disconnect();
	}
	override ignoreEvent() {
		return true;
	}
}

/** React owns the controls; CodeMirror owns their place in the document flow. */
export function inlineSelection(state: EditorState, host: HTMLElement, end: number) {
	const at = state.doc.line(Math.max(1, Math.min(end, state.doc.lines))).to;
	const decorations = Decoration.set([
		Decoration.widget({ widget: new SelectionBlock(host), block: true, side: 1 }).range(at),
	]);
	return StateField.define({
		create: () => decorations,
		update: (value, transaction) => value.map(transaction.changes),
		provide: (field) => EditorView.decorations.from(field),
	});
}
