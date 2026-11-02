import MarkdownIt from 'markdown-it';
import {
	autocompletion,
	completeAnyWord,
	insertBracket,
	pickedCompletion,
	startCompletion,
	type Completion,
	type CompletionContext,
	type CompletionResult,
} from '@codemirror/autocomplete';
import { setDiagnostics, nextDiagnostic, previousDiagnostic } from '@codemirror/lint';
import {
	Prec,
	StateEffect,
	StateField,
	type ChangeDesc,
	type Extension,
	type Text,
} from '@codemirror/state';
import {
	Decoration,
	EditorView,
	ViewPlugin,
	closeHoverTooltips,
	hasHoverTooltips,
	hoverTooltip,
	keymap,
	showTooltip,
	type DecorationSet,
	type Tooltip,
	type ViewUpdate,
} from '@codemirror/view';
import {
	codeWordAt,
	syntaxFencePath,
	syntaxLanguage,
	t,
	type Locale,
	type AgentTask,
	type CodeChange,
	type CodeCompletion,
	type CodeCompletionKind,
	type CodeProblem,
	type CodeSignatureHelp,
	type CodeStatus,
} from '@brigadir/core';
import { syntaxSegments } from './syntax';
import { callableDetail, wantsCallParens } from './editor-typing';
import { htmlComments } from './markdown-comments';
import { useWorkspace } from './store';
import type { EditorModel } from './editor-model';
import { primaryKey } from './ui/primary-key';
import { showToast, toastError, toastWarning } from './ui/Toast';
// spec/editor-code-intelligence#typing-help: switching language servers makes every session reopen its document on the next sync.
let serversGeneration = 0,
	serversOn = useWorkspace.getState().appearance.editing.languageServers;
useWorkspace.subscribe((state) => {
	const on = state.appearance.editing.languageServers;
	if (on !== serversOn) {
		serversOn = on;
		serversGeneration++;
	}
});
/** Renderer half of spec/editor-code-intelligence#architecture: the document stays in CodeMirror offsets (LF = one character) on both sides. */
export class CodeSession {
	status: CodeStatus | null = null;
	version = 0;
	problems: { version: number; list: CodeProblem[] } | null = null;
	private pending: CodeChange[] = [];
	private expected: Text | null = null;
	private needsOpen = true;
	private generation = serversGeneration;
	private timer: ReturnType<typeof setTimeout> | undefined;
	private tail: Promise<void> = Promise.resolve();
	private tracker: { desc: ChangeDesc | null } | null = null;
	private listeners = new Set<() => void>();
	constructor(
		readonly task: AgentTask,
		readonly model: EditorModel
	) {}
	get fileId() {
		return this.model.document.id;
	}
	onStatus(listener: () => void) {
		this.listeners.add(listener);
		return () => {
			this.listeners.delete(listener);
		};
	}
	record(update: ViewUpdate) {
		if (!update.docChanged) return;
		if (this.tracker)
			this.tracker.desc = this.tracker.desc
				? this.tracker.desc.composeDesc(update.changes.desc)
				: update.changes.desc;
		if (this.needsOpen || this.expected !== update.startState.doc) {
			this.needsOpen = true;
			this.pending = [];
			this.schedule();
			return;
		}
		// iterChanges reports positions in the old document; applied last-first they stay valid in sequence.
		const list: CodeChange[] = [];
		update.changes.iterChanges((from, to, _fromB, _toB, inserted) =>
			list.push({ from, to, insert: inserted.toString() })
		);
		this.pending.push(...list.reverse());
		this.expected = update.state.doc;
		this.schedule();
	}
	private schedule() {
		clearTimeout(this.timer);
		this.timer = setTimeout(() => {
			void this.sync();
		}, 60);
	}
	/** Brings main's mirror to the current document; afterwards `ready(doc)` says whether a request may use `version`. */
	sync(): Promise<void> {
		clearTimeout(this.timer);
		return (this.tail = this.tail
			.then(() => this.step())
			.catch(() => {
				this.needsOpen = true;
			}));
	}
	/** spec/editor-code-intelligence#language-server-restart: the server behind the document restarted; the next sync opens it again. */
	reopen() {
		this.needsOpen = true;
		return this.sync();
	}
	ready(doc: Text) {
		return (
			this.generation === serversGeneration &&
			!this.needsOpen &&
			this.pending.length === 0 &&
			this.expected === doc
		);
	}
	private async step() {
		const doc = this.model.state.doc;
		if (this.generation !== serversGeneration) {
			this.generation = serversGeneration;
			this.needsOpen = true;
		}
		if (this.needsOpen || (this.pending.length === 0 && this.expected !== doc)) {
			this.needsOpen = false;
			this.pending = [];
			this.expected = doc;
			const status = await window.brigadir.openCode(this.task, this.fileId, doc.toString());
			this.status = status;
			this.version = status.version;
			for (const listener of this.listeners) listener();
		}
		while (this.pending.length && !this.needsOpen) {
			const changes = this.pending.splice(0, 256);
			const version = this.version + 1;
			this.version = version;
			const result = await window.brigadir.changeCode(this.task, this.fileId, version, changes);
			if (result.status === 'resync') {
				this.needsOpen = true;
				await this.step();
				return;
			}
		}
	}
	/** Maps positions of the current synced document through later edits (auto-import after insertion). */
	track() {
		const tracker = { desc: null as ChangeDesc | null };
		this.tracker = tracker;
		return (pos: number) => (tracker.desc ? tracker.desc.mapPos(pos, -1) : pos);
	}
}
/** spec/editor-code-intelligence#language-server-restart: Editor ▸ Restart language servers for the open task; the toast says what restarted. */
export async function restartLanguageServers(task: AgentTask, locale: Locale) {
	try {
		const result = await window.brigadir.restartCode(task);
		if (result.off) toastWarning(t(locale, 'Language servers are off in Settings'));
		else if (!result.restarted.length) toastWarning(t(locale, 'No language servers are running'));
		else
			showToast(
				t(locale, 'Language servers restarted: {names}').replace(
					'{names}',
					result.restarted.join(', ')
				)
			);
	} catch {
		toastError(t(locale, 'Could not restart the language servers'));
	}
}
export const codeSessions = new WeakMap<EditorModel, CodeSession>();
export function codeSession(task: AgentTask, model: EditorModel) {
	let session = codeSessions.get(model);
	if (!session) {
		session = new CodeSession(task, model);
		codeSessions.set(model, session);
	}
	return session;
}

const hoverMarkdown = new MarkdownIt({ html: false, linkify: false, breaks: false }).use(
	htmlComments
);
// Links in documentation stay text: the editor window never navigates (spec/architecture-and-platform#ipc-boundary).
hoverMarkdown.renderer.rules.link_open = () => '<span class="cm-code-link-text">';
hoverMarkdown.renderer.rules.link_close = () => '</span>';
hoverMarkdown.renderer.rules.image = (tokens, index) =>
	hoverMarkdown.utils.escapeHtml(tokens[index]?.content ?? '');
/** Markdown without HTML; fenced code goes through the shared tree-sitter worker like chat code (spec/chat#code-syntax). */
export function markdownNode(text: string, className: string) {
	const dom = document.createElement('div');
	dom.className = className;
	dom.innerHTML = hoverMarkdown.render(text);
	for (const code of dom.querySelectorAll<HTMLElement>('pre > code')) {
		const label = /language-([\w+#-]+)/.exec(code.className)?.[1] ?? '';
		if (!syntaxLanguage(syntaxFencePath(label))) continue;
		const source = code.textContent ?? '';
		void window.brigadir
			.readCodeSyntax(label, source)
			.then((result) => {
				if (result.status !== 'ready') return;
				code.replaceChildren(
					...syntaxSegments(source, result.tokens).map((part) => {
						const span = document.createElement('span');
						if (part.kind) span.className = `syntax-${part.kind}`;
						span.textContent = part.text;
						return span;
					})
				);
			})
			.catch(() => {});
	}
	return dom;
}
const completionTypes: Record<CodeCompletionKind, string> = {
	function: 'function',
	method: 'method',
	class: 'class',
	interface: 'interface',
	enum: 'enum',
	variable: 'variable',
	constant: 'constant',
	property: 'property',
	type: 'type',
	keyword: 'keyword',
	namespace: 'namespace',
	text: 'text',
};
const wordBefore = /[\p{L}\p{N}_$]+$/u;
function completionSource(session: CodeSession, hooks: CodeHooks) {
	return async (context: CompletionContext): Promise<CompletionResult | null> => {
		const status = session.status;
		if (!status || status.source === 'fallback' || !status.features.completion)
			return completeAnyWord(context);
		const word = context.matchBefore(wordBefore);
		const before = context.state.sliceDoc(context.pos - 1, context.pos);
		const triggered = status.completionTriggers.includes(before);
		if (!context.explicit && !triggered && !word) return null;
		await session.sync();
		if (context.aborted || !session.ready(context.state.doc)) return null;
		const list = await window.brigadir
			.completeCode(
				session.task,
				session.fileId,
				session.version,
				context.pos,
				triggered && !word ? { kind: 'character', character: before } : { kind: 'invoked' }
			)
			.catch(() => null);
		if (!list || context.aborted) return null;
		const map = session.track();
		const details = new Map<number, ReturnType<typeof window.brigadir.resolveCompletion>>();
		const detail = (item: CodeCompletion) => {
			let found = details.get(item.id);
			if (!found) {
				found = session
					.sync()
					.then(() =>
						window.brigadir.resolveCompletion(
							session.task,
							session.fileId,
							session.version,
							list.list,
							item.id
						)
					)
					.catch(() => null);
				details.set(item.id, found);
			}
			return found;
		};
		const options = list.items.map((item, index): Completion => ({
			label: item.label,
			type: completionTypes[item.kind],
			boost: 99 - Math.round((index * 198) / Math.max(1, list.items.length)),
			...(item.detail ? { detail: item.detail } : {}),
			...(item.resolve
				? {
						info: async () => {
							const found = await detail(item);
							return found?.documentation || found?.detail
								? markdownNode(
										[
											found.detail
												? '```' + (status.language ?? '') + '\n' + found.detail + '\n```'
												: '',
											found.documentation ?? '',
										]
											.filter(Boolean)
											.join('\n\n'),
										'cm-code-doc'
									)
								: null;
						},
					}
				: {}),
			apply: (view, completion, _from, to) => {
				const from = Math.min(map(item.from), to);
				view.dispatch({
					changes: { from, to, insert: item.insert },
					selection: { anchor: from + item.insert.length },
					userEvent: 'input.complete',
					annotations: pickedCompletion.of(completion),
				});
				// spec/editor-code-intelligence#typing-help: a function gets `()` with the cursor inside; a tracked pair steps over its `)`.
				const end = from + item.insert.length,
					next = view.state.sliceDoc(end, end + 1);
				const call =
					hooks.callParens() &&
					!item.insert.includes('(') &&
					wantsCallParens(view.state.sliceDoc(Math.max(0, from - 1000), from), next);
				const parens = () => {
					const head = view.state.selection.main.head;
					const pair = insertBracket(view.state, '(');
					view.dispatch(
						pair ?? {
							changes: { from: head, insert: '()' },
							selection: { anchor: head + 1 },
							userEvent: 'input.complete',
						}
					);
					void showParameters(view, session, { kind: 'character', character: '(' });
				};
				if (call && (item.kind === 'function' || item.kind === 'method')) parens();
				// tsserver calls imports and `const f = () => …` variables: their resolved type decides, unless the person typed on.
				else if (
					call &&
					item.resolve &&
					(item.kind === 'variable' || item.kind === 'constant' || item.kind === 'property')
				)
					void detail(item).then((found) => {
						const { head, empty } = view.state.selection.main;
						if (
							found?.detail &&
							callableDetail(found.detail) &&
							empty &&
							view.state.sliceDoc(head - item.insert.length, head) === item.insert &&
							view.state.sliceDoc(head, head + 1) === next
						)
							parens();
					});
				const edits = (
					found: { from: number; to: number; insert: string }[],
					mapFrom: (pos: number) => number
				) => {
					const changes = found
						.map((edit) => ({
							from: mapFrom(edit.from),
							to: mapFrom(edit.to),
							insert: edit.insert,
						}))
						.filter((edit) => edit.from <= edit.to && edit.to <= view.state.doc.length);
					if (changes.length) view.dispatch({ changes, userEvent: 'input.complete' });
				};
				if (item.edits?.length) edits(item.edits, map);
				else if (item.resolve)
					void session.sync().then(async () => {
						const after = session.track();
						const found = await window.brigadir
							.resolveCompletion(session.task, session.fileId, session.version, list.list, item.id)
							.catch(() => null);
						if (found?.edits.length) edits(found.edits, after);
					});
			},
		}));
		return {
			from: word ? context.pos - word.text.length : context.pos,
			options,
			...(list.incomplete ? {} : { validFor: /^[\p{L}\p{N}_$]*$/u }),
		};
	};
}
const setSignature = StateEffect.define<{ pos: number; help: CodeSignatureHelp } | null>();
function signatureDom(help: CodeSignatureHelp) {
	const dom = document.createElement('div');
	dom.className = 'cm-code-signature';
	const signature = help.signatures[help.active] ?? help.signatures[0]!;
	const parameter = signature.parameters[help.activeParameter];
	const label = document.createElement('div');
	label.className = 'cm-code-signature-label';
	if (parameter && parameter.to > parameter.from) {
		const strong = document.createElement('strong');
		strong.textContent = signature.label.slice(parameter.from, parameter.to);
		label.append(
			signature.label.slice(0, parameter.from),
			strong,
			signature.label.slice(parameter.to)
		);
	} else label.textContent = signature.label;
	dom.append(label);
	const doc = [parameter?.documentation, signature.documentation].filter(Boolean).join('\n\n');
	if (doc) dom.append(markdownNode(doc, 'cm-code-doc'));
	return dom;
}
const signatureField = StateField.define<Tooltip | null>({
	create: () => null,
	update(value, transaction) {
		for (const effect of transaction.effects)
			if (effect.is(setSignature))
				return effect.value
					? {
							pos: effect.value.pos,
							above: true,
							strictSide: true,
							create: () => ({ dom: signatureDom(effect.value!.help) }),
						}
					: null;
		return value && transaction.docChanged
			? { ...value, pos: transaction.changes.mapPos(value.pos) }
			: value;
	},
	provide: (field) => showTooltip.from(field),
});
export async function showParameters(
	view: EditorView,
	session: CodeSession,
	trigger: { kind: 'invoked' } | { kind: 'character'; character: string } = { kind: 'invoked' }
) {
	if (!session.status?.features.signature) return false;
	const pos = view.state.selection.main.head;
	await session.sync();
	if (!session.ready(view.state.doc)) return false;
	const help = await window.brigadir
		.signatureCode(session.task, session.fileId, session.version, pos, trigger)
		.catch(() => null);
	if (view.state.selection.main.head !== pos && !help) return false;
	view.dispatch({
		effects: setSignature.of(help ? { pos: view.state.selection.main.head, help } : null),
	});
	return Boolean(help);
}
function signatureWatcher(session: CodeSession) {
	let timer: ReturnType<typeof setTimeout> | undefined;
	return EditorView.updateListener.of((update) => {
		if (!session.status?.features.signature) return;
		const open = update.state.field(signatureField, false) !== null;
		let typed: string | null = null;
		// The last typed character before the cursor decides; an IME or a multi-character insert counts too.
		const head = update.state.selection.main.head;
		if (update.docChanged && update.transactions.some((tr) => tr.isUserEvent('input.type')))
			update.changes.iterChanges((_a, _b, _fromB, toB, inserted) => {
				const text = inserted.toString();
				if (text && toB === head) typed = text.at(-1)!;
			});
		if (typed && session.status.signatureTriggers.includes(typed)) {
			clearTimeout(timer);
			const character: string = typed;
			timer = setTimeout(() => {
				void showParameters(update.view, session, { kind: 'character', character });
			}, 30);
		} else if (open && (update.docChanged || update.selectionSet)) {
			clearTimeout(timer);
			timer = setTimeout(() => {
				void showParameters(update.view, session).then((shown) => {
					if (!shown && update.view.state.field(signatureField, false))
						update.view.dispatch({ effects: setSignature.of(null) });
				});
			}, 120);
		}
	});
}
const setLink = StateEffect.define<{ from: number; to: number } | null>();
const linkField = StateField.define<DecorationSet>({
	create: () => Decoration.none,
	update(value, transaction) {
		value = value.map(transaction.changes);
		for (const effect of transaction.effects)
			if (effect.is(setLink))
				value = effect.value
					? Decoration.set([
							Decoration.mark({ class: 'cm-code-definition' }).range(
								effect.value.from,
								effect.value.to
							),
						])
					: Decoration.none;
		return value;
	},
	provide: (field) => EditorView.decorations.from(field),
});
function wordRange(view: EditorView, pos: number, language: string | null) {
	const line = view.state.doc.lineAt(pos);
	const found = codeWordAt(line.text, pos - line.from, language);
	return found ? { from: line.from + found.from, to: line.from + found.to } : null;
}
/** ⌘ over a name underlines it; ⌘+click goes to its definition (spec/editor-code-intelligence#typescript-features). */
function definitionLinks(
	go: (view: EditorView, pos: number) => void,
	language: () => string | null
) {
	return [
		linkField,
		ViewPlugin.fromClass(
			class {
				last: { x: number; y: number } | null = null;
				constructor(readonly view: EditorView) {
					window.addEventListener('keydown', this.key);
					window.addEventListener('keyup', this.key);
					window.addEventListener('blur', this.clear);
				}
				key = (event: KeyboardEvent) => {
					if (event.key === 'Meta') {
						if (event.type === 'keydown' && this.last) this.mark(this.last.x, this.last.y);
						else this.clear();
					}
				};
				clear = () => {
					if (this.view.state.field(linkField).size)
						this.view.dispatch({ effects: setLink.of(null) });
					this.view.contentDOM.style.cursor = '';
				};
				mark(x: number, y: number) {
					const pos = this.view.posAtCoords({ x, y });
					const range = pos === null ? null : wordRange(this.view, pos, language());
					const current = this.view.state.field(linkField).iter();
					if (range && current.value && current.from === range.from && current.to === range.to)
						return;
					this.view.dispatch({ effects: setLink.of(range) });
					this.view.contentDOM.style.cursor = range ? 'pointer' : '';
				}
				destroy() {
					window.removeEventListener('keydown', this.key);
					window.removeEventListener('keyup', this.key);
					window.removeEventListener('blur', this.clear);
				}
			},
			{
				eventHandlers: {
					mousemove(event) {
						this.last = { x: event.clientX, y: event.clientY };
						if (primaryKey(event)) this.mark(event.clientX, event.clientY);
						else if (this.view.state.field(linkField).size) this.clear();
					},
					mouseleave() {
						this.last = null;
						this.clear();
					},
					mousedown(event) {
						if (!primaryKey(event) || event.button !== 0 || event.shiftKey || event.altKey)
							return false;
						const pos = this.view.posAtCoords({ x: event.clientX, y: event.clientY });
						if (pos === null) return false;
						event.preventDefault();
						this.clear();
						this.view.dispatch({ selection: { anchor: pos } });
						this.view.focus();
						go(this.view, pos);
						return true;
					},
				},
			}
		),
	];
}
export function applyProblems(view: EditorView, session: CodeSession) {
	const problems = session.problems;
	if (!problems || problems.version !== session.version || !session.ready(view.state.doc)) return;
	const length = view.state.doc.length;
	view.dispatch(
		setDiagnostics(
			view.state,
			problems.list
				.filter((problem) => problem.to <= length && problem.from <= problem.to)
				.map((problem) => ({
					from: problem.from,
					to: problem.to,
					severity: problem.severity,
					message: problem.message,
					...(problem.source ? { source: problem.source } : {}),
				}))
		)
	);
}
export const codeCommands = { startCompletion, nextDiagnostic, previousDiagnostic };
export type CodeHooks = { definition(view: EditorView, pos: number): void; callParens(): boolean };
export function codeIntel(session: CodeSession, hooks: CodeHooks): Extension {
	return [
		EditorView.updateListener.of((update) => session.record(update)),
		autocompletion({
			override: [completionSource(session, hooks)],
			icons: false,
			activateOnTypingDelay: 60,
			maxRenderedOptions: 200,
			closeOnBlur: true,
		}),
		hoverTooltip(
			async (view, pos) => {
				if (!session.status?.features.hover || view.state.field(linkField).size) return null;
				await session.sync();
				if (!session.ready(view.state.doc)) return null;
				const hover = await window.brigadir
					.hoverCode(session.task, session.fileId, session.version, pos)
					.catch(() => null);
				if (!hover || hover.to > view.state.doc.length) return null;
				return {
					pos: hover.from,
					end: hover.to,
					above: true,
					create: () => ({ dom: markdownNode(hover.markdown, 'cm-code-hover') }),
				};
			},
			{ hoverTime: 350, hideOnChange: true }
		),
		signatureField,
		signatureWatcher(session),
		// Above defaultKeymap, whose Escape only collapses the selection a problem jump leaves.
		Prec.high(
			keymap.of([
				{
					key: 'Escape',
					run: (view) => {
						if (view.state.field(signatureField, false)) {
							view.dispatch({ effects: setSignature.of(null) });
							return true;
						}
						if (hasHoverTooltips(view.state)) {
							view.dispatch({ effects: closeHoverTooltips });
							return true;
						}
						return false;
					},
				},
			])
		),
		definitionLinks(hooks.definition, () => syntaxLanguage(session.model.document.path)),
		codeTheme,
	];
}
/** Kit tokens only (rule 4): popups share the menu card of ui/Controls. */
const codeTheme = EditorView.theme({
	'.cm-tooltip': {
		backgroundColor: 'var(--card)',
		color: 'var(--fg)',
		border: '1px solid var(--sep)',
		borderRadius: '7px',
		boxShadow: '0 10px 30px var(--shadow)',
		animation: 'var(--motion-fade)',
		font: 'var(--text-12)/1.45 var(--ui-family)',
	},
	'.cm-tooltip-autocomplete': { padding: '4px' },
	'.cm-tooltip.cm-tooltip-autocomplete > ul': {
		fontFamily: 'var(--editor-family, ui-monospace)',
		fontSize: 'var(--editor-size, 12px)',
		maxHeight: '15.5em',
		minWidth: '240px',
		maxWidth: 'min(560px, 80vw)',
	},
	'.cm-tooltip.cm-tooltip-autocomplete > ul > li': {
		padding: '2px 8px',
		borderRadius: '4px',
		lineHeight: '1.6',
	},
	'.cm-tooltip.cm-tooltip-autocomplete > ul > li[aria-selected]': {
		backgroundColor: 'var(--accent-fill)',
		color: 'var(--selfg)',
	},
	'.cm-completionMatchedText': { textDecoration: 'none', fontWeight: '600' },
	'.cm-completionDetail': { marginLeft: '12px', color: 'var(--fg2)', fontStyle: 'normal' },
	'li[aria-selected] .cm-completionDetail': { color: 'inherit', opacity: '.8' },
	'.cm-tooltip.cm-completionInfo': {
		padding: '6px 9px',
		maxWidth: '420px',
		maxHeight: '320px',
		overflow: 'auto',
	},
	'.cm-code-hover, .cm-code-signature': {
		padding: '6px 9px',
		maxWidth: '560px',
		maxHeight: '320px',
		overflow: 'auto',
	},
	'.cm-code-hover p, .cm-code-doc p': { margin: '4px 0' },
	'.cm-code-hover pre, .cm-code-doc pre': {
		margin: '2px 0',
		whiteSpace: 'pre-wrap',
		fontFamily: 'var(--editor-family, ui-monospace)',
		fontSize: 'var(--editor-size, 12px)',
	},
	'.cm-code-hover code, .cm-code-doc code, .cm-code-signature-label': {
		fontFamily: 'var(--editor-family, ui-monospace)',
		fontSize: 'var(--editor-size, 12px)',
	},
	'.cm-code-hover hr': { border: '0', borderTop: '1px solid var(--sep)', margin: '6px 0' },
	'.cm-code-signature-label strong': { color: 'var(--accent)', fontWeight: '600' },
	'.cm-code-signature .cm-code-doc': { marginTop: '4px', color: 'var(--fg2)' },
	'.cm-code-definition': {
		textDecoration: 'underline',
		textUnderlineOffset: '2px',
		color: 'var(--accent)',
	},
	'.cm-lintRange': {
		backgroundImage: 'none',
		paddingBottom: '0',
		textDecorationLine: 'underline',
		textDecorationStyle: 'wavy',
		textDecorationSkipInk: 'none',
		textUnderlineOffset: '3px',
	},
	'.cm-lintRange-error': { textDecorationColor: 'var(--red)' },
	'.cm-lintRange-warning': { textDecorationColor: 'var(--amber)' },
	'.cm-lintRange-info, .cm-lintRange-hint': { textDecorationColor: 'var(--fg3)' },
	'.cm-tooltip-lint': { padding: '0' },
	'.cm-diagnostic': {
		padding: '6px 9px',
		borderLeft: '3px solid var(--fg3)',
		whiteSpace: 'pre-wrap',
		maxWidth: '560px',
	},
	'.cm-diagnostic-error': { borderLeftColor: 'var(--red)' },
	'.cm-diagnostic-warning': { borderLeftColor: 'var(--amber)' },
	'.cm-diagnosticSource': { color: 'var(--fg2)', opacity: '1' },
	'.cm-tooltip-arrow': { display: 'none' },
});
