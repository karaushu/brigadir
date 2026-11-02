import {
	useEffect,
	useId,
	useLayoutEffect,
	useMemo,
	useRef,
	useState,
	type ReactNode,
	type RefObject,
} from 'react';
import {
	Compartment,
	EditorSelection,
	EditorState,
	Prec,
	StateEffect,
	type Range,
} from '@codemirror/state';
import {
	Decoration,
	EditorView,
	ViewPlugin,
	WidgetType,
	keymap,
	placeholder as placeholderExtension,
	type DecorationSet,
	type KeyBinding,
	type ViewUpdate,
} from '@codemirror/view';
import { defaultKeymap, history, historyKeymap, insertNewline } from '@codemirror/commands';
import { composerTrigger } from './composer-mentions';
import {
	applyFormat,
	continueBlock,
	formatActions,
	indentItem,
	inListLine,
	outdentItem,
	parseBlock,
	pasteAsMarkdown,
	type Block,
	type Wrap,
} from './composer-format';
import {
	codeMirrorKey,
	commandAccelerator,
	defaultKeymap as brigadirKeymap,
	menuCommands,
} from '@brigadir/core';
import { useWorkspace } from './store';
import { fileDragType } from './ui/file-drop';
import { MentionMenu, type MentionMenuItem } from './ui/MentionMenu';
import { allTab, mentionView, nextTab, type MentionGroup } from './ui/mention-tabs';
import styles from './PromptEditor.module.css';

/** How a mention token shows in the text (spec/tasks#sheet-layout, spec/composer#mentions): a pill with a glyph, or an image's thumbnail. */
export type MentionDisplay =
	| {
			kind: 'pill';
			type: string;
			label: string;
			glyph: string;
			mono?: boolean;
			title?: string;
			missing?: boolean;
			/** The attachment a click opens. */ attachment?: string;
	  }
	| {
			kind: 'image';
			key: string;
			title: string;
			missing?: boolean;
			src(): Promise<string>;
			attachment?: string;
	  };
/** A token in one line of text, positions within that line. */
export type MentionMatch = { from: number; to: number; display: MentionDisplay };
/** spec/composer#slash-highlight: a command or a skill the `/` list knows, named in one line of text; positions within that line. */
export type CommandMatch = { from: number; to: number; title: string };
/** The known names of one line; `start`: the line begins the message. */
export type FindCommands = (line: string, start: boolean) => readonly CommandMatch[];
export type MentionTrigger = {
	kind: '@' | '/';
	from: number;
	to: number;
	query: string;
	/** `/` as the message's first character (spec/composer#slash-menu). */ start?: boolean;
};
export type MentionEditorHandle = {
	focus(at?: 'end'): void;
	insert(text: string): void;
	readonly view: EditorView | null;
};

class PillWidget extends WidgetType {
	constructor(readonly display: Extract<MentionDisplay, { kind: 'pill' }>) {
		super();
	}
	override eq(other: PillWidget) {
		const a = this.display,
			b = other.display;
		return (
			a.label === b.label &&
			a.type === b.type &&
			a.glyph === b.glyph &&
			a.title === b.title &&
			a.missing === b.missing &&
			a.mono === b.mono &&
			a.attachment === b.attachment
		);
	}
	toDOM() {
		const span = document.createElement('span');
		span.className = styles.mention!;
		span.dataset.kind = this.display.type;
		span.dataset.mentionPill = '';
		if (this.display.mono) span.dataset.mono = '';
		if (this.display.missing) span.dataset.missing = '';
		if (this.display.title) span.title = this.display.title;
		if (this.display.attachment) span.dataset.attachmentId = this.display.attachment;
		span.innerHTML = this.display.glyph;
		const text = document.createElement('span');
		text.textContent = this.display.label;
		span.append(text);
		return span;
	}
	override ignoreEvent() {
		return false;
	}
}
/** spec/composer#mentions: an image stands in the line as its thumbnail, 30 × 20, cropped to the centre. */
class ImageWidget extends WidgetType {
	constructor(readonly display: Extract<MentionDisplay, { kind: 'image' }>) {
		super();
	}
	override eq(other: ImageWidget) {
		return (
			other.display.key === this.display.key &&
			other.display.missing === this.display.missing &&
			other.display.title === this.display.title
		);
	}
	toDOM() {
		const span = document.createElement('span');
		span.className = styles.image!;
		span.dataset.mentionImage = '';
		span.title = this.display.title;
		span.setAttribute('role', 'img');
		span.setAttribute('aria-label', this.display.title);
		if (this.display.attachment) span.dataset.attachmentId = this.display.attachment;
		if (this.display.missing) span.dataset.missing = '';
		else {
			span.dataset.loading = '';
			void this.display.src().then(
				(src) => {
					const image = document.createElement('img');
					image.alt = '';
					image.draggable = false;
					image.src = src;
					span.replaceChildren(image);
					delete span.dataset.loading;
				},
				() => {
					delete span.dataset.loading;
					span.dataset.missing = '';
				}
			);
		}
		return span;
	}
	override ignoreEvent() {
		return false;
	}
}
/** spec/composer#formatting: `- ` off the caret's line is a bullet in a column as wide as the marker, so a wrapped line of the item hangs under its text. */
class BulletWidget extends WidgetType {
	constructor(
		readonly indent: number,
		readonly width: number
	) {
		super();
	}
	override eq(other: BulletWidget) {
		return other.indent === this.indent && other.width === this.width;
	}
	toDOM() {
		const span = document.createElement('span');
		span.className = styles.bullet!;
		span.style.width = `${this.width}px`;
		span.style.paddingLeft = `${this.indent}px`;
		span.textContent = '•';
		return span;
	}
}
/** One space of leading indent, in px: two spaces under `- ` are the bullet's 14, three under `1. ` are the number's 22. */
const SPACE = 7.2,
	BULLET = 14,
	NUMBER = 22;
/** Where a block's own text starts, in px from the line's left edge, and how much of that is indent. */
function column(block: Block): { indent: number; width: number } {
	const indent = Math.round(block.indent * SPACE * 10) / 10;
	if (block.kind === 'ordered') {
		const digits = String(block.number).length;
		return { indent, width: indent + NUMBER + Math.max(0, digits - 1) * 7 };
	}
	return { indent, width: indent + BULLET };
}

/**
 * Markdown as typed (spec/tasks#sheet-layout, spec/composer#formatting): the `**`, `*`, `_` and `` ` `` markers hide everywhere but the caret's line; `- `
 * becomes a bullet; a number, `>` and `[ ]` stay muted text; a wrapped item line hangs under its text; code block lines lie on a band; mentions are
 * pills; a known command or skill is a chip on the text (spec/composer#slash-highlight). No new widgets: it is the same text.
 */
function decorations(
	view: EditorView,
	find: (line: string) => MentionMatch[],
	commands?: FindCommands
): { all: DecorationSet; atomic: DecorationSet } {
	const ranges: Range<Decoration>[] = [],
		atomic: Range<Decoration>[] = [],
		S = (name: string) => styles[name] ?? '';
	const doc = view.state.doc,
		head = view.state.selection.main.head,
		activeLine = doc.lineAt(head).number;
	const last = view.visibleRanges.reduce((end, range) => Math.max(end, range.to), 0);
	const shown = (from: number, to: number) =>
		view.visibleRanges.some((range) => from <= range.to && to >= range.from);
	let fenced = false;
	for (let number = 1; number <= doc.lines; number++) {
		const line = doc.line(number),
			text = line.text;
		if (line.from > last) break;
		const fence = /^[ \t]*```/.test(text),
			inside = fenced || fence,
			opening = fence && !fenced;
		if (fence) fenced = !fenced;
		if (!shown(line.from, line.to)) continue;
		const active = number === activeLine,
			code: [number, number][] = [];
		const mentions = find(text);
		const inMention = (start: number, end: number) =>
			mentions.some((match) => start < line.from + match.to && end > line.from + match.from);
		if (inside) {
			// A code block: the fence lines and the lines between lie on one band; the fences are muted.
			const classes = [
				S('fence'),
				opening ? S('fenceFirst') : '',
				fence && !opening ? S('fenceLast') : '',
			]
				.filter(Boolean)
				.join(' ');
			ranges.push(Decoration.line({ class: classes }).range(line.from));
			if (line.to > line.from)
				ranges.push(
					Decoration.mark({
						class: fence ? `${S('fenceText')} ${S('syn')}` : S('fenceText'),
					}).range(line.from, line.to)
				);
		} else {
			const block = parseBlock(text);
			if (block) {
				const geometry = column(block);
				ranges.push(
					Decoration.line({
						class: S('hang'),
						attributes: { style: `--hang:${geometry.width}px` },
					}).range(line.from)
				);
				// A task's `- ` is the bullet; its `[ ]` stays text, muted.
				const core = block.kind === 'task' ? block.indent + 2 : block.contentFrom;
				if ((block.kind === 'bullet' || block.kind === 'task') && !active)
					ranges.push(
						Decoration.replace({ widget: new BulletWidget(geometry.indent, geometry.width) }).range(
							line.from,
							line.from + core
						)
					);
				else {
					ranges.push(
						Decoration.mark({
							class: block.kind === 'quote' ? `${S('marker')} ${S('syn')}` : S('marker'),
							attributes: { style: `width:${geometry.width}px` },
						}).range(line.from, line.from + core)
					);
					// The marker's closing space sits at the column's edge, so the caret of an empty item stands where its text will start.
					if (text[core - 1] === ' ')
						ranges.push(
							Decoration.mark({ class: S('markerGap') }).range(
								line.from + core - 1,
								line.from + core
							)
						);
				}
				if (block.kind === 'task')
					ranges.push(
						Decoration.mark({ class: S('syn') }).range(line.from + core, line.from + core + 3)
					);
			}
			for (const match of text.matchAll(/`([^`\n]+)`/g)) {
				const start = line.from + match.index!,
					end = start + match[0].length;
				if (inMention(start, end)) continue;
				code.push([start, end]);
				if (!active) ranges.push(Decoration.replace({}).range(start, start + 1));
				ranges.push(Decoration.mark({ class: S('code') }).range(start + 1, end - 1));
				if (!active) ranges.push(Decoration.replace({}).range(end - 1, end));
			}
			const styled: [number, number][] = [];
			const emphasis = (pattern: RegExp, mark: number, style: string) => {
				for (const match of text.matchAll(pattern)) {
					const start = line.from + match.index!,
						end = start + match[0].length;
					if (
						code.some(([a, b]) => start < b && end > a) ||
						styled.some(([a, b]) => start < b && end > a) ||
						inMention(start, end)
					)
						continue;
					styled.push([start, end]);
					if (!active) ranges.push(Decoration.replace({}).range(start, start + mark));
					ranges.push(Decoration.mark({ class: style }).range(start + mark, end - mark));
					if (!active) ranges.push(Decoration.replace({}).range(end - mark, end));
				}
			};
			emphasis(/\*\*([^*\n]+)\*\*/g, 2, S('strong'));
			// `*x*` and `_x_`: not a list marker (`* x`), not half of `**`, not the underscores inside snake_case.
			emphasis(/(?<![*\w])\*(?![\s*])([^*\n]*[^\s*])\*(?![*\w])/g, 1, S('em'));
			emphasis(/(?<![\w_])_(?![\s_])([^_\n]*[^\s_])_(?![\w_])/g, 1, S('em'));
			// spec/composer#slash-highlight: a name the `/` list knows stays text the caret walks through, on the pill's tint; not in code, not over a pill.
			for (const word of commands?.(text, number === 1) ?? []) {
				const start = line.from + word.from,
					end = line.from + word.to;
				if (code.some(([a, b]) => start < b && end > a) || inMention(start, end)) continue;
				ranges.push(
					Decoration.mark({
						class: S('command'),
						attributes: { title: word.title, 'data-slash-command': '' },
					}).range(start, end)
				);
			}
			// A link keeps its text as typed; its brackets and address are muted.
			for (const match of text.matchAll(/\[([^\]\n]+)\](\([^)\n]*\))/g)) {
				const start = line.from + match.index!,
					end = start + match[0].length,
					middle = start + 1 + match[1]!.length;
				if (code.some(([a, b]) => start < b && end > a) || inMention(start, end)) continue;
				ranges.push(
					Decoration.mark({ class: S('syn') }).range(start, start + 1),
					Decoration.mark({ class: S('syn') }).range(middle, end)
				);
			}
		}
		for (const match of mentions) {
			const start = line.from + match.from,
				end = line.from + match.to;
			if (code.some(([a, b]) => start < b && end > a)) continue;
			const deco = Decoration.replace({
				widget:
					match.display.kind === 'image'
						? new ImageWidget(match.display)
						: new PillWidget(match.display),
			});
			ranges.push(deco.range(start, end));
			atomic.push(deco.range(start, end));
		}
	}
	return { all: Decoration.set(ranges, true), atomic: Decoration.set(atomic, true) };
}

/** spec/composer#formatting: ⌘B ⌘I ⌘E ⌘K follow the keymap, as the Edit ▸ Formatting items do; with no shortcut a wrap has no key. */
function formatKeymap(accelerators: Partial<Record<Wrap, string>>) {
	return Prec.high(
		keymap.of(
			Object.entries(accelerators).flatMap(([wrap, accelerator]) =>
				accelerator
					? [
							{
								key: codeMirrorKey(accelerator),
								run: (view: EditorView) => applyFormat(view, wrap as Wrap),
							},
						]
					: []
			)
		)
	);
}
// Recompute the pills when the set of known mentions changes.
const refreshMentions = StateEffect.define<null>();
type Open = { trigger: MentionTrigger; left: number; top: number };

/**
 * spec/tasks#sheet-layout, spec/composer#mentions: one editor for the prompt of the New task sheet and the task composer — CodeMirror with Markdown
 * typeset, mention pills and the `@` (and, in the composer, `/`) menu with tabs. The caller owns the sources (`groups`),
 * what a pick inserts (`onPick`) and how tokens show (`find`); the hook owns the text, the trigger and the keys of the menu.
 */
/** The placeholder: its text, or the text and a key in a frame after it (`data-placeholder-key`). */
function hintContent(text: string, key: string | undefined): string | HTMLElement {
	if (!key) return text;
	const root = document.createElement('span'),
		kbd = document.createElement('kbd');
	root.append(text);
	kbd.dataset.placeholderKey = '';
	kbd.textContent = key;
	root.append(kbd);
	return root;
}
export function useMentionEditor(config: {
	value: string;
	onChange(value: string): void;
	ariaLabel: string;
	placeholder: string;
	/** spec/composer#agent-capsule: a key drawn in a frame after the placeholder text (the ghost suggestion's `Tab`). */ placeholderKey?:
		string | undefined;
	disabled?: boolean;
	/** Extra attributes of the editable element (ghost state, busy, description). */ attributes?: Record<
		string,
		string
	>;
	/** `/` as the first character opens the commands (the composer, spec/composer#mention-menu). */ slash?: boolean;
	find(line: string): MentionMatch[];
	/** Changes when what `find` or `commands` knows changes, so pills are drawn again. */ findKey: string;
	/** spec/composer#slash-highlight: the commands and skills the text names, marked where they stand. */ commands?: FindCommands;
	groups: readonly MentionGroup[];
	/** The row when no group has a match (spec/composer#mentions); null closes the empty menu. */ empty:
		string | null;
	/** spec/composer#slash-menu: a grey row above the items — what kind of list it is. */ note?:
		string | null;
	onTrigger?(trigger: MentionTrigger | null): void;
	onPick(item: MentionMenuItem, trigger: MentionTrigger): string | null | Promise<string | null>;
	/** The surface's own keys, under the menu's: they run only when the menu does not take the key. */ keys?: readonly KeyBinding[];
	/** True when the surface handles this paste itself and CodeMirror must not insert anything. */ ownPaste?(
		event: ClipboardEvent
	): boolean;
	/** The row of an empty tab while other tabs have items, so Tab does not close the menu on its way round. */
	menu: {
		label: string;
		tabsLabel: string;
		allLabel: string;
		hint: string;
		emptyTab: string;
		placement: 'caret' | 'top';
		className?: string;
	};
}): {
	host: RefObject<HTMLDivElement | null>;
	menu: ReactNode;
	open: boolean;
	handle: MentionEditorHandle;
} {
	const host = useRef<HTMLDivElement>(null),
		view = useRef<EditorView | null>(null);
	const editable = useRef(new Compartment()),
		attrs = useRef(new Compartment()),
		hint = useRef(new Compartment()),
		formatKeys = useRef(new Compartment());
	const [open, setOpen] = useState<Open | null>(null),
		[active, setActive] = useState(0),
		[tab, setTab] = useState(allTab);
	const latest = useRef(config);
	latest.current = config;
	const keymapSettings = useWorkspace((state) => state.appearance.keymap) ?? brigadirKeymap;
	const accelerators = useRef<Partial<Record<Wrap, string>>>({});
	accelerators.current = Object.fromEntries(
		Object.entries(formatActions).flatMap(([action, wrap]) => {
			const key = commandAccelerator(
				menuCommands.find((command) => command.id === action)!,
				keymapSettings
			);
			return key ? [[wrap, key]] : [];
		})
	);
	const acceleratorKey = JSON.stringify(accelerators.current);
	const dismissed = useRef<string | null>(null),
		id = useId();
	const shown = useMemo(
		() => (open ? mentionView(config.groups, tab, config.menu.allLabel) : null),
		[open, config.groups, tab, config.menu.allLabel]
	);
	const status = shown
		? (shown.status ??
			(shown.items.length
				? null
				: (config.empty ?? (shown.tabs?.[0]?.count ? config.menu.emptyTab : null))))
		: null;
	const visible = Boolean(open && shown && (shown.items.length || status));
	const state = useRef({ open, shown, active, visible });
	state.current = { open, shown, active, visible };

	function close(dismiss: boolean) {
		const current = state.current.open;
		if (dismiss && current) dismissed.current = `${current.trigger.kind}:${current.trigger.from}`;
		setOpen(null);
	}
	function replace(trigger: MentionTrigger, word: string, insert: string) {
		const instance = view.current;
		if (!instance) return;
		// The text may have moved on while an attachment was made: replace the word only where it still stands.
		if (instance.state.doc.sliceString(trigger.from, trigger.from + word.length) !== word) return;
		const to = trigger.from + word.length,
			glue = insert && !/^\s/.test(instance.state.doc.sliceString(to, to + 1)) ? ' ' : '';
		// A file attaches asynchronously: if the person typed on meanwhile, the caret stays where they are (mapped through the change).
		const range = instance.state.selection.main,
			waiting = range.empty && range.head === to;
		instance.dispatch({
			changes: { from: trigger.from, to, insert: insert + glue },
			...(waiting ? { selection: { anchor: trigger.from + insert.length + glue.length } } : {}),
			userEvent: 'input.complete',
		});
		if (waiting) instance.focus();
	}
	function pick(item: MentionMenuItem) {
		const instance = view.current,
			current = state.current.open;
		if (!instance || !current) return;
		const trigger = current.trigger,
			word = instance.state.doc.sliceString(trigger.from, trigger.to);
		close(true);
		const result = latest.current.onPick(item, trigger);
		if (typeof result === 'string') replace(trigger, word, result);
		else if (result)
			void result.then(
				(text) => {
					if (text !== null) replace(trigger, word, text);
				},
				() => {}
			);
	}
	const pickRef = useRef(pick);
	pickRef.current = pick;

	useLayoutEffect(() => {
		const plugin = ViewPlugin.fromClass(
			class {
				all: DecorationSet;
				atomic: DecorationSet;
				constructor(v: EditorView) {
					({ all: this.all, atomic: this.atomic } = decorations(
						v,
						latest.current.find,
						latest.current.commands
					));
					this.flag(v);
				}
				update(update: ViewUpdate) {
					if (
						update.docChanged ||
						update.selectionSet ||
						update.viewportChanged ||
						update.transactions.some(
							(tr) => tr.reconfigured || tr.effects.some((effect) => effect.is(refreshMentions))
						)
					)
						({ all: this.all, atomic: this.atomic } = decorations(
							update.view,
							latest.current.find,
							latest.current.commands
						));
					if (update.docChanged || update.selectionSet) this.flag(update.view);
				}
				/** spec/composer#formatting: the caret is on a list item, so ⇧Tab is its level: the app menu reads this from the focused element and gives the key up. */
				flag(v: EditorView) {
					const on = String(inListLine(v.state));
					if (v.contentDOM.dataset.listLine !== on) v.contentDOM.dataset.listLine = on;
				}
			},
			{ decorations: (value) => value.all }
		);
		const atomicOf = (v: EditorView) => v.plugin(plugin)?.atomic ?? Decoration.none;
		const menuKeys = Prec.highest(
			keymap.of([
				{
					key: 'ArrowDown',
					run: () => {
						const { visible, shown } = state.current;
						if (!visible || !shown?.items.length) return false;
						setActive((value) => (value + 1) % shown.items.length);
						return true;
					},
				},
				{
					key: 'ArrowUp',
					run: () => {
						const { visible, shown } = state.current;
						if (!visible || !shown?.items.length) return false;
						setActive((value) => (value - 1 + shown.items.length) % shown.items.length);
						return true;
					},
				},
				{
					key: 'Enter',
					run: () => {
						const { visible, shown, active } = state.current,
							item = visible ? shown?.items[Math.min(active, shown.items.length - 1)] : undefined;
						if (!item) return false;
						pickRef.current(item);
						return true;
					},
				},
				// spec/composer#mentions: Tab and ⇧Tab switch tabs while the menu is open; they do not pick.
				{
					key: 'Tab',
					run: () => {
						const { visible, shown } = state.current;
						if (!visible) return false;
						if (shown?.tabs) {
							setTab(nextTab(shown.tabs, shown.tab, 1));
							setActive(0);
						}
						return true;
					},
					shift: () => {
						const { visible, shown } = state.current;
						if (!visible) return false;
						if (shown?.tabs) {
							setTab(nextTab(shown.tabs, shown.tab, -1));
							setActive(0);
						}
						return true;
					},
				},
				// Esc closes the menu only for this `@`, not the sheet or the suggestion: a second Esc closes those (spec/appearance#popup-close).
				{
					key: 'Escape',
					run: () => {
						if (!state.current.visible) return false;
						close(true);
						return true;
					},
				},
			])
		);
		// spec/composer#mentions: the first ⌫ right after a pill selects it whole, the second removes it.
		const pillKeys = keymap.of([
			{
				key: 'Backspace',
				run: (v) => {
					const range = v.state.selection.main;
					if (!range.empty) return false;
					let found: { from: number; to: number } | null = null;
					atomicOf(v).between(range.head - 1, range.head, (from, to) => {
						if (to === range.head) found = { from, to };
					});
					if (!found) return false;
					v.dispatch({
						selection: EditorSelection.range((found as { from: number }).from, range.head),
					});
					return true;
				},
			},
		]);
		const instance = new EditorView({
			parent: host.current!,
			state: EditorState.create({
				doc: latest.current.value,
				extensions: [
					// The surface's keys are named once; what they do is read at the press, so handlers see the surface's current state.
					history(),
					menuKeys,
					Prec.high(
						keymap.of(
							(latest.current.keys ?? []).map((binding, index): KeyBinding => ({
								key: binding.key!,
								run: (v) => latest.current.keys?.[index]?.run?.(v) ?? false,
								...(binding.shift
									? { shift: (v) => latest.current.keys?.[index]?.shift?.(v) ?? false }
									: {}),
							}))
						)
					),
					pillKeys,
					formatKeys.current.of(formatKeymap(accelerators.current)),
					// spec/composer#formatting: ⇧↩ continues a list, a quote or a code block; Tab and ⇧Tab move a list item (outside a list they are not ours).
					keymap.of([
						{ key: 'Shift-Enter', run: (v) => continueBlock(v) || insertNewline(v) },
						{ key: 'Tab', run: indentItem, shift: outdentItem },
						...defaultKeymap,
						...historyKeymap,
					]),
					plugin,
					EditorView.atomicRanges.of(atomicOf),
					EditorView.lineWrapping,
					hint.current.of(
						placeholderExtension(
							hintContent(latest.current.placeholder, latest.current.placeholderKey)
						)
					),
					attrs.current.of(
						EditorView.contentAttributes.of({
							'aria-label': latest.current.ariaLabel,
							'aria-multiline': 'true',
							'aria-autocomplete': 'list',
							'data-prompt': '',
						})
					),
					editable.current.of([
						EditorView.editable.of(!latest.current.disabled),
						EditorState.readOnly.of(Boolean(latest.current.disabled)),
					]),
					EditorView.domEventHandlers({
						// A paste the surface takes itself (an image, Finder's files, spec/composer#paste) is left to it: CodeMirror would insert its text.
						paste: (event, v) => {
							if (latest.current.ownPaste?.(event)) return true;
							// spec/composer#formatting: `•` lines and an HTML list become items, an address over a selected word a link; other text pastes as it is.
							const data = event.clipboardData,
								range = v.state.selection.main;
							if (!data || v.state.selection.ranges.length > 1) return false;
							const text = pasteAsMarkdown(
								data.getData('text/plain'),
								data.getData('text/html'),
								v.state.sliceDoc(range.from, range.to)
							);
							if (text === null) return false;
							event.preventDefault();
							v.dispatch({
								changes: { from: range.from, to: range.to, insert: text },
								selection: { anchor: range.from + text.length },
								scrollIntoView: true,
								userEvent: 'input.paste',
							});
							return true;
						},
						// CodeMirror reads dropped files as text; files are attachments here, the surface handles them (spec/composer#paste).
						drop: (event) =>
							Boolean(
								event.dataTransfer?.files.length || event.dataTransfer?.types.includes(fileDragType)
							),
					}),
					EditorView.updateListener.of((update) => {
						if (update.docChanged) latest.current.onChange(update.state.doc.toString());
						if (update.focusChanged && !update.view.hasFocus) {
							setOpen(null);
							return;
						}
						if (!update.docChanged && !update.selectionSet && !update.focusChanged) return;
						const range = update.state.selection.main;
						const found =
							update.view.hasFocus && range.empty
								? composerTrigger(update.state.doc.toString(), range.head)
								: null;
						// A pill is `@[…]` in the text: the caret right after one is not a new `@`.
						const trigger: MentionTrigger | null =
							found &&
							!found.query.startsWith('[') &&
							(found.kind === 'file' || latest.current.slash)
								? {
										kind: found.kind === 'file' ? '@' : '/',
										from: found.from,
										to: found.to,
										query: found.query,
										...(found.start ? { start: true } : {}),
									}
								: null;
						const key = trigger && `${trigger.kind}:${trigger.from}`;
						if (dismissed.current !== key) dismissed.current = null;
						if (!trigger || dismissed.current === key) {
							setOpen(null);
							return;
						}
						const coords =
								latest.current.menu.placement === 'caret'
									? update.view.coordsAtPos(trigger.from)
									: null,
							box = host.current!.getBoundingClientRect();
						setOpen((current) => {
							const fresh =
								!current ||
								current.trigger.from !== trigger.from ||
								current.trigger.kind !== trigger.kind;
							if (fresh) setTab(allTab);
							if (fresh || current.trigger.query !== trigger.query) setActive(0);
							if (
								!fresh &&
								current.trigger.query === trigger.query &&
								current.trigger.to === trigger.to &&
								current.trigger.start === trigger.start
							)
								return current;
							return {
								trigger,
								left: coords ? coords.left - box.left : 0,
								top: coords ? coords.bottom - box.top + 4 : 0,
							};
						});
					}),
				],
			}),
		});
		view.current = instance;
		return () => {
			instance.destroy();
			view.current = null;
		};
	}, []);
	useEffect(() => {
		latest.current.onTrigger?.(open?.trigger ?? null);
	}, [open?.trigger.kind, open?.trigger.from, open?.trigger.query, open === null]);
	// The sheet loads its settings after mount: editing turns on as soon as it is ready.
	useEffect(() => {
		view.current?.dispatch({
			effects: editable.current.reconfigure([
				EditorView.editable.of(!config.disabled),
				EditorState.readOnly.of(Boolean(config.disabled)),
			]),
		});
	}, [config.disabled]);
	useEffect(() => {
		view.current?.dispatch({
			effects: hint.current.reconfigure(
				placeholderExtension(hintContent(config.placeholder, config.placeholderKey))
			),
		});
	}, [config.placeholder, config.placeholderKey]);
	useEffect(() => {
		view.current?.dispatch({
			effects: formatKeys.current.reconfigure(formatKeymap(accelerators.current)),
		});
	}, [acceleratorKey]);
	// spec/composer#formatting: Edit ▸ Formatting from the menu bar acts on the editor that has the focus.
	useEffect(
		() =>
			window.brigadir.onWorkspaceAction((action) => {
				const instance = view.current,
					wrap = (formatActions as Record<string, Wrap>)[action];
				if (instance?.hasFocus && wrap) applyFormat(instance, wrap);
			}),
		[]
	);
	// The editable element carries the menu's ARIA wiring and the surface's own state; a transaction only when it changes,
	// because every transaction drops a DOM selection not yet read.
	const items = shown?.items ?? [],
		activeIndex = Math.min(active, Math.max(0, items.length - 1));
	const attributes: Record<string, string> = {
		'aria-label': config.ariaLabel,
		'aria-multiline': 'true',
		'aria-autocomplete': 'list',
		'data-prompt': '',
		...(config.placeholder ? { 'aria-placeholder': config.placeholder } : {}),
		...(config.disabled ? { 'aria-disabled': 'true' } : {}),
		...config.attributes,
		...(visible
			? {
					'aria-controls': id,
					'aria-expanded': 'true',
					...(items.length ? { 'aria-activedescendant': `${id}-${activeIndex}` } : {}),
				}
			: {}),
	};
	const attributesKey = JSON.stringify(attributes),
		shownAttributes = useRef(attributesKey);
	useEffect(() => {
		if (shownAttributes.current === attributesKey) return;
		shownAttributes.current = attributesKey;
		view.current?.dispatch({
			effects: attrs.current.reconfigure(EditorView.contentAttributes.of(attributes)),
		});
	}, [attributesKey]);
	// An outside text replacement (suggestion, queue, reset) without losing the position when the texts are already equal.
	useEffect(() => {
		const instance = view.current;
		if (instance && instance.state.doc.toString() !== config.value)
			instance.dispatch({
				changes: { from: 0, to: instance.state.doc.length, insert: config.value },
			});
	}, [config.value]);
	// A new find may turn typed text into a mention: recompute decorations only when the set really changed.
	const shownKey = useRef(config.findKey);
	useEffect(() => {
		if (shownKey.current === config.findKey) return;
		shownKey.current = config.findKey;
		view.current?.dispatch({ effects: refreshMentions.of(null) });
	}, [config.findKey]);

	const handle = useMemo<MentionEditorHandle>(
		() => ({
			get view() {
				return view.current;
			},
			focus(at) {
				const instance = view.current;
				if (!instance) return;
				instance.focus();
				if (at === 'end')
					instance.dispatch({
						selection: { anchor: instance.state.doc.length },
						scrollIntoView: true,
					});
			},
			insert(text) {
				const instance = view.current;
				if (!instance) return;
				const range = instance.hasFocus
					? instance.state.selection.main
					: EditorSelection.cursor(instance.state.doc.length);
				const before = instance.state.doc.sliceString(Math.max(0, range.from - 1), range.from),
					after = instance.state.doc.sliceString(range.to, range.to + 1);
				const insert =
					(before && !/\s/.test(before) ? ' ' : '') +
					text +
					(!after || !/\s/.test(after) ? ' ' : '');
				instance.dispatch({
					changes: { from: range.from, to: range.to, insert },
					selection: { anchor: range.from + insert.length },
					userEvent: 'input.paste',
				});
			},
		}),
		[]
	);
	const menu =
		visible && open && shown ? (
			<MentionMenu
				id={id}
				label={config.menu.label}
				className={config.menu.className ?? ''}
				{...(config.menu.placement === 'top'
					? { side: 'top' as const }
					: { style: { left: open.left, top: open.top } })}
				items={items}
				status={status}
				loading={Boolean(shown.status)}
				note={config.note ?? null}
				active={activeIndex}
				onActive={setActive}
				onPick={(item) => pick(item)}
				tabs={shown.tabs}
				tab={shown.tab}
				tabsLabel={config.menu.tabsLabel}
				hint={config.menu.hint}
				onTab={(value) => {
					setTab(value);
					setActive(0);
				}}
			/>
		) : null;
	return { host, menu, open: visible, handle };
}
