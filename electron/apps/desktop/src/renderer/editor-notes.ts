import controls from './ui/ReviewControls.module.css';
import buttons from './ui/Controls.module.css';
import { Decoration, EditorView, WidgetType } from '@codemirror/view';
import { StateField, type EditorState } from '@codemirror/state';
import { t, type Locale, type ReviewSnapshot } from '@brigadir/core';
class Note extends WidgetType {
	constructor(
		readonly note: ReviewSnapshot['comments'][number],
		readonly locale: Locale,
		readonly edit: () => void,
		readonly remove: () => void,
		readonly resolve: () => void
	) {
		super();
	}
	override toDOM() {
		const article = document.createElement('article');
		article.className = `cm-review-note ${controls.comment}`;
		article.setAttribute('aria-label', t(this.locale, 'File comment'));
		const header = document.createElement('header');
		const avatar = document.createElement('span');
		avatar.className = controls.avatar!;
		avatar.textContent = '●';
		const author = document.createElement('strong');
		author.textContent = t(this.locale, 'You');
		header.append(avatar, author);
		const label = document.createElement('span');
		label.textContent = `${this.note.anchor.start}–${this.note.anchor.end}${this.note.sent ? ' · ' + t(this.locale, this.note.resolved ? 'Resolved' : this.note.addressed ? 'Addressed' : 'Sent') : ''}`;
		header.append(label);
		for (const [label, action] of [
			[t(this.locale, 'Edit comment'), this.edit],
			[t(this.locale, 'Remove comment'), this.remove],
			...(this.note.sent
				? [[t(this.locale, this.note.resolved ? 'Reopen' : 'Resolve'), this.resolve] as const]
				: []),
		] as const) {
			const button = document.createElement('button');
			button.textContent =
				label === t(this.locale, 'Edit comment')
					? '✎'
					: label === t(this.locale, 'Remove comment')
						? '×'
						: label;
			const edits =
				label === t(this.locale, 'Edit comment') || label === t(this.locale, 'Remove comment');
			button.className = edits ? `${buttons.button} ${buttons.iconButton}` : buttons.button!;
			button.dataset.size = 's';
			button.dataset.appearance = 'neutral';
			button.dataset.variant = edits ? 'ghost' : 'soft';
			button.setAttribute('aria-label', label);
			button.title = label;
			button.type = 'button';
			button.onclick = action;
			header.append(button);
		}
		const text = document.createElement('p');
		text.textContent = this.note.text;
		article.append(header, text);
		return article;
	}
	override ignoreEvent() {
		return true;
	}
}
export function inlineNotes(
	state: EditorState,
	notes: ReviewSnapshot['comments'],
	locale: Locale,
	edit: (note: ReviewSnapshot['comments'][number]) => void,
	remove: (id: string) => void,
	resolve: (note: ReviewSnapshot['comments'][number]) => void
) {
	const decorations = Decoration.set(
		notes
			.filter(
				(note) =>
					note.position?.state !== 'outdated' &&
					note.position?.end &&
					note.position.end <= state.doc.lines
			)
			.map((note) =>
				Decoration.widget({
					widget: new Note(
						note,
						locale,
						() => edit(note),
						() => remove(note.id),
						() => resolve(note)
					),
					block: true,
					side: 1,
				}).range(state.doc.line(note.position!.end!).to)
			),
		true
	);
	return StateField.define({
		create: () => decorations,
		update: (value, tr) => (tr.docChanged ? Decoration.none : value),
		provide: (field) => EditorView.decorations.from(field),
	});
}
