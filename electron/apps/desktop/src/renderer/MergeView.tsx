import { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import {
	Annotation,
	Compartment,
	EditorState,
	StateEffect,
	StateField,
	type ChangeSpec,
	type Text,
	type Transaction,
} from '@codemirror/state';
import { Decoration, EditorView, WidgetType, keymap, lineNumbers } from '@codemirror/view';
import {
	defaultKeymap,
	history,
	historyKeymap,
	invertedEffects,
	isolateHistory,
} from '@codemirror/commands';
import {
	applyNonConflicting,
	assemble,
	chunkLines,
	chunkSides,
	fromResult,
	initialPicks,
	isResolved,
	merge3,
	mergeLines,
	wordSpans,
	acceptBoth,
	ignoreSide,
	takeSide,
	type AgentChoice,
	type ChunkPick,
	type Merge3,
	type MergeChunk,
	type MergeSide,
} from '@brigadir/diff';
import {
	changesAppliedCount,
	conflictCount,
	conflictOf,
	conflictsLeftCount,
	t,
	type AgentTask,
	type ConflictTexts,
	type Locale,
	type MergeState,
	type MessageKey,
} from '@brigadir/core';
import { editorTheme } from './editor-model';
import { setSyntax, syntaxDecorations } from './syntax';
import { ModalDialog } from './ui/ModalDialog';
import { ConfirmDialog } from './ui/ConfirmDialog';
import { Banner } from './ui/Banner';
import { Button, Choice, IconButton, Segments } from './ui/Controls';
import { GenerateButton } from './ui/GenerateButton';
import { FileIcon } from './ui/FileIcon';
import { Glyph } from './ui/Glyph';
import { toastError } from './ui/Toast';
import { BranchName } from './ui/BranchName';
import { agentName, failureText, fill, folderOf, MergeWhere, shortName } from './ConflictsDialog';
import styles from './MergeView.module.css';

/**
 * spec/appearance#evolution-redesign, spec/git#conflicts: the manual merge of one file in three columns — `Yours · <branch>` | `Result` (editable; at
 * the start the base with the conflicts, changes that do not conflict already in) | `Theirs · <base>`. The model is
 * `@brigadir/diff` merge3; the Result editor keeps where each chunk stands and what was picked in a field that undo
 * restores together with the text. Columns are padded to the same height chunk by chunk and scroll together.
 */
type Slot = { from: number; to: number; pick: ChunkPick };
const slotEffect = StateEffect.define<{ before: Slot[]; after: Slot[] }>();
const chunkAction = Annotation.define<boolean>();
const slotField = StateField.define<Slot[]>({
	create: () => [],
	update(slots, tr) {
		let next = slots;
		if (tr.docChanged)
			next = next.map((slot) => {
				const from = tr.changes.mapPos(slot.from, -1);
				return { ...slot, from, to: Math.max(from, tr.changes.mapPos(slot.to, 1)) };
			});
		for (const effect of tr.effects) if (effect.is(slotEffect)) next = effect.value.after;
		return next;
	},
});
/** A person's edit inside a chunk (or at an empty chunk's place) makes the chunk theirs: it counts as resolved. */
const editMarks = EditorState.transactionExtender.of((tr: Transaction) => {
	if (!tr.docChanged || tr.annotation(chunkAction) || tr.effects.some((e) => e.is(slotEffect)))
		return null;
	const before = tr.startState.field(slotField);
	let touched = false;
	const after = before.map((slot) => {
		let hit = false;
		tr.changes.iterChangedRanges((fromA, toA) => {
			if (fromA <= slot.to && toA >= slot.from) hit = true;
		});
		const from = tr.changes.mapPos(slot.from, -1),
			to = Math.max(from, tr.changes.mapPos(slot.to, 1));
		if (hit && !slot.pick.edited) touched = true;
		return { from, to, pick: hit ? { taken: [], ignored: [], edited: true } : slot.pick };
	});
	return touched ? { effects: slotEffect.of({ before, after }) } : null;
});
const slotHistory = invertedEffects.of((tr) =>
	tr.effects
		.filter((effect) => effect.is(slotEffect))
		.map((effect) =>
			slotEffect.of({
				before: (effect.value as { after: Slot[] }).after,
				after: (effect.value as { before: Slot[] }).before,
			})
		)
);
const setDecorations = StateEffect.define<import('@codemirror/view').DecorationSet>();
const decorationField = StateField.define({
	create: () => Decoration.none,
	update(value, tr) {
		if (tr.docChanged) value = value.map(tr.changes);
		for (const effect of tr.effects) if (effect.is(setDecorations)) value = effect.value;
		return value;
	},
	provide: (field) => EditorView.decorations.from(field),
});
/** The hatched room a column leaves where another column of the same chunk has more lines. */
class Pad extends WidgetType {
	constructor(readonly height: number) {
		super();
	}
	eq(other: Pad) {
		return other.height === this.height;
	}
	toDOM() {
		const pad = document.createElement('div');
		pad.className = 'cm-merge-pad';
		pad.style.height = `${this.height}px`;
		pad.setAttribute('aria-hidden', 'true');
		return pad;
	}
	get estimatedHeight() {
		return this.height;
	}
}

const lineText = (lines: string[]) => lines.map((line) => line + '\n').join('');
const lineStarts = (lines: string[]) => {
	const starts = [0];
	for (const line of lines) starts.push(starts.at(-1)! + line.length + 1);
	return starts;
};
/** Line range `[start, end)` of a slot of the Result. */
function slotLines(doc: Text, slot: Slot) {
	const start = doc.lineAt(slot.from).number - 1;
	if (slot.to <= slot.from) return { start, end: start };
	const end = doc.lineAt(slot.to);
	return { start, end: end.from === slot.to ? end.number - 1 : end.number };
}
type Column = 'ours' | 'result' | 'theirs';
type ChunkView = {
	index: number;
	chunk: MergeChunk;
	pick: ChunkPick;
	resolved: boolean;
	lines: Record<Column, { start: number; end: number }>;
	height: number;
};
function chunkViews(merge: Merge3, doc: Text, slots: Slot[]): ChunkView[] {
	return merge.chunks.map((chunk, index) => {
		const slot = slots[index]!,
			result = slotLines(doc, slot),
			lines = { ours: chunk.ours, theirs: chunk.theirs, result };
		return {
			index,
			chunk,
			pick: slot.pick,
			resolved: isResolved(chunk, slot.pick),
			lines,
			height: Math.max(
				lines.ours.end - lines.ours.start,
				lines.theirs.end - lines.theirs.start,
				result.end - result.start
			),
		};
	});
}
/** Line tints, word marks against the base, and the pads that keep the columns level. */
function columnDecorations(
	column: Column,
	doc: Text,
	merge: Merge3,
	views: ChunkView[],
	current: number,
	lineHeight: number
) {
	const ranges: import('@codemirror/state').Range<Decoration>[] = [];
	for (const view of views) {
		const { chunk, pick, resolved } = view,
			range = view.lines[column],
			rows = range.end - range.start;
		const sideChanged =
			column === 'result' ? true : chunkSides(chunk).includes(column as MergeSide);
		const kind =
			column === 'result'
				? pick.agent
					? 'ag'
					: chunk.kind === 'conflict'
						? resolved
							? 'ok'
							: 'cf'
						: pick.taken.length
							? 'ap'
							: ''
				: !sideChanged
					? ''
					: chunk.kind === 'conflict'
						? resolved
							? 'dn'
							: 'cf'
						: 'ch';
		for (let line = range.start; line < range.end && line < doc.lines; line++) {
			const at = doc.line(line + 1);
			if (kind)
				ranges.push(
					Decoration.line({
						class: `cm-merge-${kind}${view.index === current && chunk.kind === 'conflict' ? ' cm-merge-cur' : ''}`,
					}).range(at.from)
				);
			// Word marks: what this side changed in the line against the same line of the base.
			if (column !== 'result' && sideChanged && kind !== 'dn') {
				const base = merge.base[chunk.base.start + line - range.start];
				if (base !== undefined && base !== at.text) {
					const spans = wordSpans(base, at.text).new;
					let start = 0;
					for (const end of spans) {
						const to = end >>> 1;
						if (end & 1 && to > start)
							ranges.push(
								Decoration.mark({ class: 'cm-merge-word' }).range(at.from + start, at.from + to)
							);
						start = to;
					}
				}
			}
		}
		const pad = view.height - rows;
		if (pad > 0) {
			const at = range.end < doc.lines ? doc.line(range.end + 1).from : doc.length;
			ranges.push(
				Decoration.widget({ widget: new Pad(pad * lineHeight), block: true, side: -1 }).range(at)
			);
		}
	}
	return Decoration.set(ranges, true);
}

const explain: Record<AgentChoice, MessageKey> = {
	ours: 'Kept yours.',
	theirs: 'Kept theirs.',
	both: 'Kept both: yours, then theirs.',
	base: 'Kept the base.',
	own: 'Wrote its own version from both sides.',
};

export function MergeView({
	task,
	locale,
	scopeId,
	path,
	repo,
	state,
	agentBusy,
	onState,
	onClose,
}: {
	task: AgentTask;
	locale: Locale;
	scopeId: string;
	path: string;
	repo: string;
	state: MergeState;
	agentBusy: boolean;
	onState(next: MergeState | null): void;
	onClose(): void;
}) {
	const file = state.conflicts.find((item) => item.path === path);
	const running = file?.agent === 'running',
		agent = agentName(task);
	const [texts, setTexts] = useState<ConflictTexts | null>(null),
		[failed, setFailed] = useState(false),
		[apply, setApply] = useState(true),
		[current, setCurrent] = useState(0),
		[tick, setTick] = useState(0),
		[narrow, setNarrow] = useState(false),
		[tab, setTab] = useState<MergeSide>('ours'),
		[confirm, setConfirm] = useState(false),
		[busy, setBusy] = useState(false),
		[filled, setFilled] = useState<AgentChoice[] | null>(null);
	const body = useRef<HTMLDivElement>(null),
		hosts = {
			ours: useRef<HTMLDivElement>(null),
			result: useRef<HTMLDivElement>(null),
			theirs: useRef<HTMLDivElement>(null),
		},
		views = useRef<Partial<Record<Column, EditorView>>>({}),
		readOnly = useRef(new Compartment()),
		start = useRef(''),
		syncing = useRef(false),
		mounted = useRef(true),
		wasRunning = useRef(running),
		padLine = useRef(0),
		frame = useRef(0),
		currentRef = useRef(current);
	// The editors' listeners live as long as the views: they read the current conflict through a ref.
	currentRef.current = current;
	const merge = useMemo(
		() =>
			texts
				? merge3(mergeLines(texts.base), mergeLines(texts.ours), mergeLines(texts.theirs))
				: null,
		[texts]
	);

	async function load() {
		try {
			const next = await window.brigadir.readConflictTexts(task, scopeId, path);
			if (mounted.current) {
				setTexts(next);
				setFailed(false);
			}
		} catch (cause) {
			if (!mounted.current) return;
			setFailed(true);
			toastError(
				failureText(locale, 'Could not open {file} for merging.', cause, shortName(path)),
				{
					bold: shortName(path),
				}
			);
		}
	}
	useEffect(() => {
		mounted.current = true;
		void load();
		return () => {
			mounted.current = false;
		};
	}, [path]);
	// The agent's turn for this file ended: its text is the Result, chunk by chunk with ✦.
	useEffect(() => {
		if (wasRunning.current && !running) void load();
		wasRunning.current = running;
	}, [running]);
	// The file was resolved elsewhere (the list, another window): nothing is left to merge here.
	useEffect(() => {
		if (!file || file.resolved) onClose();
	}, [file?.resolved, Boolean(file)]);

	const result = () => views.current.result;
	const slots = () => result()?.state.field(slotField) ?? [];
	const chunkInfo = (): ChunkView[] => {
		const view = result();
		return merge && view ? chunkViews(merge, view.state.doc, slots()) : [];
	};
	function decorate() {
		const all = chunkInfo();
		if (!merge) return;
		padLine.current = views.current.result?.defaultLineHeight ?? 0;
		for (const column of ['ours', 'result', 'theirs'] as Column[]) {
			const view = views.current[column];
			if (!view) continue;
			view.dispatch({
				effects: setDecorations.of(
					columnDecorations(
						column,
						view.state.doc,
						merge,
						all,
						currentRef.current,
						view.defaultLineHeight
					)
				),
			});
		}
		setTick((value) => value + 1);
	}
	// Three editors over the texts; the Result one keeps the chunks and the picks.
	useLayoutEffect(() => {
		if (!merge || !texts) return;
		const extension = texts.path.split('.').at(-1) ?? 'txt';
		const fromAgent = texts.byAgent && !/^<{7}(?: |$)/m.test(texts.current);
		let doc: string, slotsAt: Slot[];
		if (fromAgent) {
			const lines = mergeLines(texts.current),
				read = fromResult(merge, lines),
				starts = lineStarts(lines);
			doc = lineText(lines);
			slotsAt = read.ranges.map((range, index) => ({
				from: starts[range.start]!,
				to: starts[range.end]!,
				pick: read.picks[index]!,
			}));
			setFilled(read.choices);
		} else {
			const picks = initialPicks(merge, apply),
				built = assemble(merge, picks),
				starts = lineStarts(built.lines);
			doc = lineText(built.lines);
			slotsAt = built.ranges.map((range, index) => ({
				from: starts[range.start]!,
				to: starts[range.end]!,
				pick: picks[index]!,
			}));
			setFilled(null);
		}
		start.current = doc;
		const label = (column: Column) =>
			column === 'ours'
				? t(locale, 'Side: yours')
				: column === 'theirs'
					? t(locale, 'Side: theirs')
					: t(locale, 'Result (merge)');
		const make = (column: Column, text: string) => {
			const editable = column === 'result';
			return new EditorView({
				parent: hosts[column].current!,
				state: EditorState.create({
					doc: text,
					extensions: [
						lineNumbers(),
						editorTheme,
						syntaxDecorations,
						decorationField,
						EditorView.contentAttributes.of({ 'aria-label': label(column) }),
						// Line heights are estimates until the editor measures: pads and the chunk buttons follow the measure.
						EditorView.updateListener.of((update) => {
							if (!update.geometryChanged) return;
							if (update.view.defaultLineHeight !== padLine.current) queueMicrotask(decorate);
							else if (!frame.current)
								frame.current = requestAnimationFrame(() => {
									frame.current = 0;
									setTick((value) => value + 1);
								});
						}),
						...(editable
							? [
									history(),
									keymap.of([...defaultKeymap, ...historyKeymap]),
									slotField.init(() => slotsAt),
									editMarks,
									slotHistory,
									readOnly.current.of(EditorState.readOnly.of(running)),
									EditorView.updateListener.of((update) => {
										if (
											update.docChanged ||
											update.transactions.some((tr) => tr.effects.some((e) => e.is(slotEffect)))
										)
											queueMicrotask(decorate);
										if (update.docChanged) colourResult();
									}),
								]
							: [EditorState.readOnly.of(true), EditorView.editable.of(false)]),
					],
				}),
			});
		};
		views.current = {
			ours: make('ours', lineText(merge.ours)),
			result: make('result', doc),
			theirs: make('theirs', lineText(merge.theirs)),
		};
		// Scroll together: the columns are level chunk by chunk, so one scrollTop fits all.
		const scrollers = Object.values(views.current).map((view) => view.scrollDOM);
		const onScroll = (event: Event) => {
			if (syncing.current) return;
			syncing.current = true;
			const top = (event.currentTarget as HTMLElement).scrollTop;
			for (const other of scrollers) if (other !== event.currentTarget) other.scrollTop = top;
			requestAnimationFrame(() => {
				syncing.current = false;
				setTick((value) => value + 1);
			});
		};
		for (const scroller of scrollers) scroller.addEventListener('scroll', onScroll);
		decorate();
		const colour = (column: Column) => {
			const view = views.current[column];
			if (!view) return;
			const text = view.state.doc.toString();
			void window.brigadir.readCodeSyntax(extension, text).then(
				(syntax) => {
					if (views.current[column] === view && view.state.doc.toString() === text)
						view.dispatch({ effects: setSyntax.of(syntax.tokens) });
				},
				() => {}
			);
		};
		let timer: ReturnType<typeof setTimeout> | undefined;
		const colourResult = () => {
			clearTimeout(timer);
			timer = setTimeout(() => colour('result'), 250);
		};
		colour('ours');
		colour('result');
		colour('theirs');
		const first = slotsAt.findIndex(
			(slot, index) =>
				merge.chunks[index]!.kind === 'conflict' && !isResolved(merge.chunks[index]!, slot.pick)
		);
		setCurrent(Math.max(0, first));
		return () => {
			clearTimeout(timer);
			cancelAnimationFrame(frame.current);
			frame.current = 0;
			for (const scroller of scrollers) scroller.removeEventListener('scroll', onScroll);
			for (const view of Object.values(views.current)) view.destroy();
			views.current = {};
		};
	}, [merge]);
	useEffect(() => {
		result()?.dispatch({
			effects: readOnly.current.reconfigure(EditorState.readOnly.of(running)),
		});
	}, [running]);
	useEffect(() => decorate(), [current]);
	// Narrow: Yours / Theirs become tabs over the Result.
	useLayoutEffect(() => {
		const element = body.current;
		if (!element) return;
		const observer = new ResizeObserver(() => setNarrow(element.clientWidth < 900));
		observer.observe(element);
		return () => observer.disconnect();
	}, []);
	useEffect(() => {
		for (const view of Object.values(views.current)) view.requestMeasure();
		setTick((value) => value + 1);
	}, [narrow, tab]);

	const info = chunkInfo();
	const conflicts = info.filter((view) => view.chunk.kind === 'conflict');
	const left = conflicts.filter((view) => !view.resolved).length,
		applied = info.filter(
			(view) => view.chunk.kind !== 'conflict' && view.pick.taken.length
		).length,
		notApplied = info.filter(
			(view) => view.chunk.kind !== 'conflict' && !view.pick.taken.length && !view.pick.edited
		).length,
		agentChunks = info.filter((view) => view.pick.agent).length;
	const currentView = info[current]?.chunk.kind === 'conflict' ? info[current] : conflicts[0];
	const position = currentView ? conflicts.indexOf(currentView) + 1 : 0;
	const dirty = Boolean(result() && result()!.state.doc.toString() !== start.current);

	/** Replaces chunks of the Result in one undoable step. */
	function replace(updates: Map<number, ChunkPick>) {
		const view = result();
		if (!view || !merge || running) return;
		const before = view.state.field(slotField),
			changes: ChangeSpec[] = [],
			after: Slot[] = [];
		let shift = 0;
		before.forEach((slot, index) => {
			const pick = updates.get(index);
			if (!pick) {
				after.push({ ...slot, from: slot.from + shift, to: slot.to + shift });
				return;
			}
			const insert = lineText(chunkLines(merge, merge.chunks[index]!, pick));
			changes.push({ from: slot.from, to: slot.to, insert });
			after.push({ from: slot.from + shift, to: slot.from + shift + insert.length, pick });
			shift += insert.length - (slot.to - slot.from);
		});
		view.dispatch({
			changes,
			effects: slotEffect.of({ before, after }),
			// Each » « ✕ is its own undo step, not merged with typing around it.
			annotations: [chunkAction.of(true), isolateHistory.of('full')],
			userEvent: 'input.merge',
		});
	}
	function pickChunk(index: number, make: (pick: ChunkPick) => ChunkPick, advance = true) {
		const slot = slots()[index];
		if (!slot) return;
		replace(new Map([[index, make(slot.pick)]]));
		if (advance && merge?.chunks[index]?.kind === 'conflict') {
			const next = chunkInfo().find(
				(view) => view.index > index && view.chunk.kind === 'conflict' && !view.resolved
			);
			if (next) go(next.index);
		}
	}
	function go(index: number) {
		setCurrent(index);
		const view = result(),
			chunk = slots()[index];
		if (view && chunk)
			view.dispatch({ effects: EditorView.scrollIntoView(chunk.from, { y: 'center' }) });
	}
	function step(direction: 1 | -1) {
		if (!conflicts.length) return;
		const at = Math.max(0, currentView ? conflicts.indexOf(currentView) : 0);
		go(conflicts[(at + direction + conflicts.length) % conflicts.length]!.index);
	}
	function toggleApply(on: boolean) {
		setApply(on);
		if (!merge) return;
		const now = slots().map((slot) => slot.pick),
			next = applyNonConflicting(merge, now, on);
		replace(
			new Map(
				next
					.map((pick, index) => [index, pick] as const)
					.filter(([index, pick]) => pick !== now[index])
			)
		);
	}
	function undoAgent() {
		if (!merge) return;
		const picks = initialPicks(merge, apply);
		replace(new Map(picks.map((pick, index) => [index, pick] as const)));
	}
	async function resolveFile(run: () => Promise<MergeState | null>, failure: MessageKey) {
		setBusy(true);
		try {
			onState(await run());
			onClose();
		} catch (cause) {
			toastError(failureText(locale, failure, cause, shortName(path)), { bold: shortName(path) });
		} finally {
			if (mounted.current) setBusy(false);
		}
	}
	function applyResult() {
		const view = result();
		if (!view || !texts) return;
		let text = view.state.doc.toString();
		if (texts.ours && !texts.ours.endsWith('\n') && text.endsWith('\n')) text = text.slice(0, -1);
		if (texts.ours.includes('\r\n')) text = text.replace(/\r?\n/g, '\r\n');
		void resolveFile(
			() => window.brigadir.applyConflict(task, scopeId, path, text),
			'Could not apply {file}.'
		);
	}
	const close = () => (dirty ? setConfirm(true) : onClose());

	// The buttons beside each chunk: they follow the chunk's line in its column as the columns scroll.
	const overlay = (column: Column, sides: MergeSide[]) => {
		void tick;
		const view = views.current[column],
			host = hosts[column].current;
		if (!view || !host || !merge) return null;
		const box = host.getBoundingClientRect();
		return info.flatMap((chunk) => {
			const range = chunk.lines[column];
			const line = Math.min(range.start, view.state.doc.lines - 1);
			const block = view.lineBlockAt(view.state.doc.line(line + 1).from);
			const empty = range.end <= range.start;
			const top =
				view.documentTop +
				block.top -
				box.top -
				(empty ? (chunk.height - (range.end - range.start)) * view.defaultLineHeight : 0);
			if (top < -24 || top > box.height) return [];
			const marks = sides.flatMap((side) => {
				if (!chunkSides(chunk.chunk).includes(side)) return [];
				const { pick } = chunk,
					taken = pick.taken.includes(side),
					ignored = pick.ignored.includes(side);
				if (running || taken || ignored) return [];
				const other =
					pick.taken.length > 0 && chunk.chunk.kind === 'conflict' && !pick.agent && !pick.edited;
				const add = (
					<button
						key={`${side}-take`}
						type="button"
						className={styles.take}
						data-merge-take={side}
						title={t(
							locale,
							other
								? side === 'ours'
									? 'Add yours as well'
									: 'Add theirs as well'
								: side === 'ours'
									? 'Take yours into the result'
									: 'Take theirs into the result'
						)}
						aria-label={`${t(
							locale,
							other
								? side === 'ours'
									? 'Add yours as well'
									: 'Add theirs as well'
								: side === 'ours'
									? 'Take yours into the result'
									: 'Take theirs into the result'
						)} · ${chunk.index + 1}`}
						onClick={() => {
							setCurrent(chunk.index);
							pickChunk(chunk.index, (old) => takeSide(old, side));
						}}>
						{other ? (side === 'ours' ? '+»' : '«+') : side === 'ours' ? '»' : '«'}
					</button>
				);
				const dismiss =
					chunk.chunk.kind === 'conflict' && !pick.agent && !pick.edited && !other ? (
						<button
							key={`${side}-ignore`}
							type="button"
							className={styles.ignore}
							data-merge-ignore={side}
							title={t(locale, side === 'ours' ? 'Ignore yours' : 'Ignore theirs')}
							aria-label={`${t(locale, side === 'ours' ? 'Ignore yours' : 'Ignore theirs')} · ${chunk.index + 1}`}
							onClick={() => {
								setCurrent(chunk.index);
								pickChunk(chunk.index, (old) => ignoreSide(old, side), false);
							}}>
							<Glyph name="close" size={10} />
						</button>
					) : null;
				return side === 'ours' || narrow ? [dismiss, add] : [add, dismiss];
			});
			const why =
				column === 'result' && chunk.pick.agent && filled ? (
					<span key="why" className={styles.why} tabIndex={0} data-merge-why>
						<Glyph name="generate" size={11} />
						<span className={styles.whyCard} role="tooltip">
							<b>
								<Glyph name="generate" size={11} />
								{t(locale, 'Conflict {n} · the agent').replace(
									'{n}',
									String(conflicts.indexOf(chunk) + 1 || chunk.index + 1)
								)}
							</b>
							{t(locale, explain[filled[chunk.index] ?? 'own'])}
						</span>
					</span>
				) : null;
			if (!marks.some(Boolean) && !why) return [];
			return [
				<div
					key={chunk.index}
					className={styles.marks}
					style={{ top: `${top}px` }}
					data-chunk={chunk.index}>
					{why}
					<span className={styles.grow} />
					{marks}
				</div>,
			];
		});
	};
	// The stripe on the right: every chunk of the Result at its place in the file.
	const stripe = () => {
		const view = result();
		if (!view) return null;
		const total = Math.max(1, view.state.doc.lines);
		return info.map((chunk) => (
			<button
				key={chunk.index}
				type="button"
				tabIndex={-1}
				aria-hidden="true"
				className={styles.mark}
				data-tone={
					chunk.pick.agent
						? 'agent'
						: chunk.chunk.kind === 'conflict'
							? chunk.resolved
								? 'done'
								: 'conflict'
							: 'change'
				}
				style={{ top: `${(chunk.lines.result.start / total) * 100}%` }}
				onClick={() => go(chunk.index)}
			/>
		));
	};
	const header = (column: Column) => (
		<div className={styles.columnHead}>
			{column === 'result' ? (
				<>
					<b>{t(locale, 'Result (merge)')}</b>
					<span>{t(locale, 'editable')}</span>
				</>
			) : (
				<>
					<b>{t(locale, column === 'ours' ? 'Side: yours' : 'Side: theirs')}</b>
					<BranchName name={column === 'ours' ? state.into : state.from} />
				</>
			)}
		</div>
	);
	const name = shortName(path),
		folder = folderOf(path);
	const footerNote = running ? (
		t(locale, 'Waiting for the agent')
	) : !left && agentChunks && agentChunks >= conflicts.length ? (
		<>
			<Glyph name="generate" size={12} />
			{`${conflictCount(locale, agentChunks)} ${t(locale, 'filled by the agent')} · ${t(locale, 'Apply accepts them')}`}
		</>
	) : !left ? (
		<>
			<Glyph name="tick" size={12} />
			{`${t(locale, 'All conflicts resolved')} · ${changesAppliedCount(locale, applied, true)}`}
		</>
	) : (
		`${conflictsLeftCount(locale, left)} · ${
			apply || !notApplied
				? changesAppliedCount(locale, applied, true)
				: changesAppliedCount(locale, notApplied, false)
		}`
	);

	return (
		<>
			<ModalDialog
				title={name}
				icon={<FileIcon name={name} />}
				locale={locale}
				close={close}
				width={2000}
				top={24}
				data-merge-view={path}
				note={
					<span className={styles.note}>
						{folder && <span>{folder}</span>}
						{folder && <span>·</span>}
						<MergeWhere locale={locale} repo={repo} state={state} />
					</span>
				}
				headerExtra={
					<GenerateButton
						label={t(locale, 'Resolve with the agent')}
						disabled={running || busy || !file || file.places === 0 || agentBusy}
						onClick={() => {
							setBusy(true);
							void window.brigadir
								.askAgentToResolve(task, scopeId, [path])
								.then(() => window.brigadir.readMergeState(task, scopeId))
								.then(onState, (cause: unknown) =>
									toastError(
										failureText(locale, 'Could not resolve {file} with the agent.', cause, name),
										{ bold: name }
									)
								)
								.finally(() => mounted.current && setBusy(false));
						}}
					/>
				}
				footer={
					<>
						<span className={styles.footNote} role="status" data-merge-progress>
							{footerNote}
						</span>
						<Button
							disabled={busy || running}
							onClick={() =>
								void resolveFile(
									() => window.brigadir.resolveConflict(task, scopeId, path, 'ours'),
									'Could not resolve the conflict in {file}.'
								)
							}>
							{t(locale, 'Accept yours')}
						</Button>
						<Button
							disabled={busy || running}
							onClick={() =>
								void resolveFile(
									() => window.brigadir.resolveConflict(task, scopeId, path, 'theirs'),
									'Could not resolve the conflict in {file}.'
								)
							}>
							{t(locale, 'Accept theirs')}
						</Button>
						<Button
							appearance="primary"
							disabled={busy || running || left > 0 || !texts}
							title={left ? t(locale, 'Resolve every conflict place first.') : undefined}
							onClick={applyResult}>
							{t(locale, 'Apply')}
						</Button>
					</>
				}>
				<div className={styles.root} ref={body} data-narrow={narrow || undefined}>
					{running && (
						<Banner
							className={styles.banner}
							tone="working"
							title={t(locale, '{agent} is resolving {file}…')
								.replace('{agent}', agent)
								.replace('{file}', name)}
							note={t(locale, 'The result is read-only until the agent is done.')}
							action={
								<Button
									onClick={() =>
										void window.brigadir.stopConflictAgent(task, scopeId).then(onState, () => {})
									}>
									{t(locale, 'Stop')}
								</Button>
							}
						/>
					)}
					{!running && agentChunks > 0 && filled && (
						<Banner
							className={styles.banner}
							tone="done"
							data-merge-agent
							title={fill(t(locale, '{agent} resolved {conflicts} in {file}'), {
								agent,
								conflicts: conflictCount(locale, agentChunks),
								file: <b>{name}</b>,
							})}
							action={
								<Button onClick={undoAgent}>
									<Glyph name="undo" size={12} />
									{t(locale, 'Undo')}
								</Button>
							}
						/>
					)}
					<div className={styles.toolbar} data-size="s">
						<IconButton
							label={t(locale, 'Previous conflict')}
							disabled={!conflicts.length}
							onClick={() => step(-1)}>
							<Glyph name="find-previous" size={12} />
						</IconButton>
						<IconButton
							label={t(locale, 'Next conflict')}
							disabled={!conflicts.length}
							onClick={() => step(1)}>
							<Glyph name="find-next" size={12} />
						</IconButton>
						<span className={styles.counter} data-merge-counter>
							{!left && conflicts.length ? (
								<>
									<Glyph name="tick" size={12} />
									{t(locale, 'All {n} resolved').replace('{n}', String(conflicts.length))}
								</>
							) : (
								<>
									{conflictOf(locale, position, conflicts.length)}
									{agentChunks > 0 && ` · ${t(locale, 'filled by the agent')}`}
								</>
							)}
						</span>
						<span className={styles.rule} />
						<Button
							disabled={
								running || !currentView || (currentView.resolved && !currentView.pick.agent)
							}
							title={t(locale, 'Yours, then theirs')}
							onClick={() =>
								currentView && pickChunk(currentView.index, () => acceptBoth(currentView.chunk))
							}>
							{t(locale, 'Accept both')}
						</Button>
						<span className={styles.grow} />
						<label className={styles.toggle}>
							<Choice
								type="checkbox"
								label={t(locale, 'Apply non-conflicting changes')}
								checked={apply}
								disabled={running}
								onChange={(event) => toggleApply(event.currentTarget.checked)}
							/>
							<span aria-hidden="true">
								{t(locale, narrow ? 'Non-conflicting' : 'Apply non-conflicting changes')}
							</span>
						</label>
					</div>
					{narrow && (
						<div className={styles.tabs} data-size="s">
							<Segments
								label={t(locale, 'Side: yours') + ' / ' + t(locale, 'Side: theirs')}
								value={tab}
								onChange={(value) => setTab(value as MergeSide)}
								options={[
									{ value: 'ours', label: t(locale, 'Side: yours') },
									{ value: 'theirs', label: t(locale, 'Side: theirs') },
								]}
							/>
							<BranchName name={tab === 'ours' ? state.into : state.from} />
						</div>
					)}
					{failed && !texts && (
						<p className={styles.failed} role="alert">
							{t(locale, 'Could not open {file} for merging.').replace('{file}', name)}{' '}
							<Button onClick={() => void load()}>{t(locale, 'Retry')}</Button>
						</p>
					)}
					<div className={styles.columns}>
						{(['ours', 'result', 'theirs'] as Column[]).map((column) => (
							<section
								key={column}
								className={styles.column}
								data-column={column}
								hidden={narrow && column !== 'result' && column !== tab}
								aria-label={t(
									locale,
									column === 'ours'
										? 'Side: yours'
										: column === 'theirs'
											? 'Side: theirs'
											: 'Result (merge)'
								)}>
								{!narrow && header(column)}
								{narrow && column === 'result' && header(column)}
								<div className={styles.editor}>
									<div className={styles.code} ref={hosts[column]} />
									<div className={styles.overlay}>
										{column === 'ours' && overlay('ours', ['ours'])}
										{column === 'result' && overlay('result', narrow ? [] : ['theirs'])}
										{column === 'theirs' && narrow && overlay('theirs', ['theirs'])}
									</div>
								</div>
							</section>
						))}
						<div className={styles.stripe} aria-hidden="true">
							{stripe()}
						</div>
					</div>
				</div>
			</ModalDialog>
			{confirm && (
				<ConfirmDialog
					title={t(locale, 'Close without applying?')}
					locale={locale}
					action={t(locale, 'Discard')}
					danger
					cancel={() => setConfirm(false)}
					confirm={async () => {
						setConfirm(false);
						onClose();
					}}>
					<p>
						{fill(t(locale, 'Your choices in {file} are lost. The file stays in conflict.'), {
							file: <strong>{name}</strong>,
						})}
					</p>
				</ConfirmDialog>
			)}
		</>
	);
}
