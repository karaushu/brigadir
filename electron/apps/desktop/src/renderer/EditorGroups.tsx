/**
 * spec/editor#editor-groups: editor groups (Split). The tree of splits, the borders between groups and the passive view of a group
 * without the focus. The focused group is the live documents surface of TaskView; the others show their active
 * document read-only and come alive on the first click, as JetBrains' inactive splits take the focus.
 */
import { useEffect, useLayoutEffect, useRef, useState, type ReactNode } from 'react';
import { EditorState } from '@codemirror/state';
import { EditorView, gutter, lineNumbers } from '@codemirror/view';
import {
	t,
	type AgentTask,
	type EditorGroup,
	type EditorGroupNode,
	type FileDiff,
	type GroupDrop,
	type Locale,
	type SplitDirection,
} from '@brigadir/core';
import { readCommitDiff, type CommitDiffEntry } from './commit-diffs';
import { DiffView } from './DiffView';
import { codeSession } from './code-intel';
import { indentExtensions } from './editor-commands';
import { editorTheme, indentSettingsOf, scrollHandover, type EditorModel } from './editor-model';
import { useWorkspace } from './store';
import { setSyntax, syntaxDecorations } from './syntax';
import { ResizeHandle } from './ui/ResizeHandle';
import { Glyph, type GlyphName } from './ui/Glyph';
import { FilePath } from './ui/FilePath';
import editorStyles from './CodeEditor.module.css';
import styles from './EditorGroups.module.css';
import tabStripStyles from './ui/TabStrip.module.css';
import { SkeletonText } from './ui/Loading';

/** The tab being dragged between strips and groups; HTML drag data cannot be read before the drop. */
export type DraggedTab = { group: string; tab: string };
let dragged: DraggedTab | null = null,
	source: HTMLElement | null = null;
export const draggedTab = () => dragged;
/**
 * While a tab is dragged, the pointer carries a ghost of the tab (its icon and name on a card) and the
 * tab itself dims in its strip until the drag ends.
 */
export function startTabDrag(
	event: React.DragEvent<HTMLElement>,
	value: DraggedTab,
	label: string
) {
	dragged = value;
	event.dataTransfer.effectAllowed = 'copyMove';
	event.dataTransfer.setData('text/plain', label);
	const tab = event.currentTarget,
		face = tab.querySelector('button[role="tab"]');
	if (face) {
		const ghost = document.createElement('div');
		ghost.className = tabStripStyles.ghost!;
		for (const node of face.childNodes) ghost.append(node.cloneNode(true));
		document.body.append(ghost);
		event.dataTransfer.setDragImage(ghost, 12, 14);
		// The image is taken when the handler returns; the node is not needed after that.
		setTimeout(() => ghost.remove());
	}
	source = tab;
	// The next frame: the default image, if the ghost failed, is still the undimmed tab.
	requestAnimationFrame(() => {
		if (source === tab && dragged) tab.dataset.dragging = 'true';
	});
}
export const endTabDrag = () => {
	dragged = null;
	if (source) delete source.dataset.dragging;
	source = null;
};

export function GroupTree({
	node,
	leaf,
	locale,
	onResize,
}: {
	node: EditorGroupNode;
	leaf(group: EditorGroup): ReactNode;
	locale: Locale;
	onResize(split: string, ratio: number): void;
}): ReactNode {
	if (node.kind === 'group') return leaf(node);
	return (
		<SplitView split={node} locale={locale} onResize={onResize}>
			{[
				<GroupTree
					key={node.first.id}
					node={node.first}
					leaf={leaf}
					locale={locale}
					onResize={onResize}
				/>,
				<GroupTree
					key={node.second.id}
					node={node.second}
					leaf={leaf}
					locale={locale}
					onResize={onResize}
				/>,
			]}
		</SplitView>
	);
}
function SplitView({
	split,
	children,
	locale,
	onResize,
}: {
	split: Extract<EditorGroupNode, { kind: 'split' }>;
	children: [ReactNode, ReactNode];
	locale: Locale;
	onResize(split: string, ratio: number): void;
}) {
	const box = useRef<HTMLDivElement>(null);
	const [length, setLength] = useState(0);
	const right = split.direction === 'right';
	useLayoutEffect(() => {
		const element = box.current;
		if (!element) return;
		const measure = () => setLength(right ? element.clientWidth : element.clientHeight);
		measure();
		const observer = new ResizeObserver(measure);
		observer.observe(element);
		return () => observer.disconnect();
	}, [right]);
	const min = Math.min(160, length / 2),
		first = Math.round(split.ratio * length);
	return (
		<div ref={box} className={styles.split} data-direction={split.direction}>
			<div className={styles.pane} style={{ flexBasis: `${split.ratio * 100}%` }}>
				{children[0]}
			</div>
			{/* spec/task-window#resize-handles: the border is the second pane's own line; the handle lies over it and takes no room. */}
			<ResizeHandle
				label={t(locale, 'Resize editor groups')}
				axis={right ? 'x' : 'y'}
				edge="end"
				value={first}
				min={min}
				max={Math.max(min, length - min)}
				onChange={(value) => {
					if (length) onResize(split.id, value / length);
				}}
				onCommit={() => {}}
			/>
			<div className={styles.pane} data-second style={{ flexBasis: `${(1 - split.ratio) * 100}%` }}>
				{children[1]}
			</div>
		</div>
	);
}

/** Where a pointer over a group's document drops a tab: the right or the bottom edge splits, the rest moves into the group. */
export function dropZone(box: DOMRect, x: number, y: number): SplitDirection | 'center' {
	const right = (x - box.left) / box.width,
		down = (y - box.top) / box.height;
	if (right > 0.66 && right - 0.66 >= down - 0.66) return 'right';
	if (down > 0.66) return 'down';
	return 'center';
}
/** The drop target over a group's document while a tab is dragged (spec/editor#editor-groups): the zone, its chip and the drop itself. */
export function GroupDropTarget({
	group,
	locale,
	accepts = () => true,
	onDrop,
}: {
	group: string;
	locale: Locale;
	/** A tab this group's document does not take (spec/task-window-workspace#work-area: the work area takes the group under the chat whole). */
	accepts?(tab: DraggedTab): boolean;
	onDrop(drop: GroupDrop, copy: boolean): void;
}) {
	const [zone, setZone] = useState<SplitDirection | 'center' | null>(null);
	const [active, setActive] = useState(false);
	const latest = useRef(accepts);
	latest.current = accepts;
	useDragWindow(
		() => setActive(!!dragged && latest.current(dragged)),
		() => {
			setActive(false);
			setZone(null);
		}
	);
	if (!active) return null;
	return (
		<div
			className={styles.dropTarget}
			data-group-drop={group}
			onDragOver={(event) => {
				if (!dragged) return;
				event.preventDefault();
				event.dataTransfer.dropEffect = event.altKey ? 'copy' : 'move';
				setZone(
					dropZone(event.currentTarget.getBoundingClientRect(), event.clientX, event.clientY)
				);
			}}
			onDragLeave={(event) => {
				if (!event.currentTarget.contains(event.relatedTarget as Node | null)) setZone(null);
			}}
			onDrop={(event) => {
				event.preventDefault();
				const at = dropZone(
					event.currentTarget.getBoundingClientRect(),
					event.clientX,
					event.clientY
				);
				setZone(null);
				onDrop({ group, at }, event.altKey);
			}}>
			{zone &&
				(zone === 'center' ? (
					<DropZone zone="center" label={t(locale, 'Move here')} />
				) : (
					<DropZone
						zone={zone}
						glyph={zone === 'right' ? 'split-right' : 'split-down'}
						label={t(locale, zone === 'right' ? 'Split right' : 'Split down')}
					/>
				))}
		</div>
	);
}
/** The look of every tab drop (spec/editor#editor-groups, rule 17): an accent frame on `--accent-soft` and its chip. */
function DropZone({
	zone,
	glyph,
	label,
}: {
	zone: SplitDirection | 'center';
	glyph?: GlyphName;
	label: string;
}) {
	return (
		<div className={styles.zone} data-zone={zone}>
			<span className={styles.chip}>
				{glyph && <Glyph name={glyph} size={14} />}
				{label}
			</span>
		</div>
	);
}
/**
 * spec/task-window-workspace#work-area: a whole column as one drop target for a dragged tab that `accepts` takes — the chat for the bottom group
 * of the work area («Under the chat»), the work area for the group under the chat. The zone is the lower half, where the
 * group lands; the drop moves the whole group, not the tab.
 */
export function ColumnDropTarget({
	column,
	label,
	glyph,
	accepts,
	onDrop,
}: {
	column: 'chat' | 'work';
	label: string;
	glyph: GlyphName;
	accepts(tab: DraggedTab): boolean;
	onDrop(tab: DraggedTab): void;
}) {
	const [active, setActive] = useState(false);
	const [over, setOver] = useState(false);
	const latest = useRef(accepts);
	latest.current = accepts;
	useDragWindow(
		() => setActive(!!dragged && latest.current(dragged)),
		() => {
			setActive(false);
			setOver(false);
		}
	);
	if (!active) return null;
	return (
		<div
			className={styles.dropTarget}
			data-column-drop={column}
			onDragOver={(event) => {
				if (!dragged) return;
				event.preventDefault();
				event.dataTransfer.dropEffect = 'move';
				setOver(true);
			}}
			onDragLeave={(event) => {
				if (!event.currentTarget.contains(event.relatedTarget as Node | null)) setOver(false);
			}}
			onDrop={(event) => {
				event.preventDefault();
				const from = dragged;
				setOver(false);
				endTabDrag();
				if (from) onDrop(from);
			}}>
			{over && <DropZone zone="down" glyph={glyph} label={label} />}
		</div>
	);
}
/** A drag of a tab starts and ends anywhere in the window. */
function useDragWindow(start: () => void, stop: () => void) {
	const latest = useRef({ start, stop });
	latest.current = { start, stop };
	useEffect(() => {
		const begin = () => latest.current.start(),
			end = () => latest.current.stop();
		window.addEventListener('dragstart', begin);
		window.addEventListener('dragend', end);
		window.addEventListener('drop', end);
		return () => {
			window.removeEventListener('dragstart', begin);
			window.removeEventListener('dragend', end);
			window.removeEventListener('drop', end);
		};
	}, []);
}

/**
 * A file shown by a group without the focus: the buffer read-only, with its colours, following the edits made in the
 * focused group. A click hands the caret and the scroll over and focuses the group.
 */
export function PassiveEditor({
	task,
	model,
	label,
	onActivate,
}: {
	task: AgentTask;
	model: EditorModel;
	label: string;
	onActivate(): void;
}) {
	const parent = useRef<HTMLDivElement>(null);
	const [dirty, setDirty] = useState(model.dirty);
	// spec/editor#indentation: the same indentation as the live editor — Settings, the project's Prettier or
	// .editorconfig, the file's own text — whichever group has the focus; a buffer never shown live asks the project itself.
	const indentChoice = useWorkspace((state) => state.appearance.indent);
	const [indentProject, setIndentProject] = useState(model.indentProject);
	useEffect(() => {
		if (model.live) return;
		let active = true;
		void codeSession(task, model)
			.sync()
			.then(() => window.brigadir.indentInfoCode(task, model.document.id))
			.then(
				(info) => {
					if (active) setIndentProject(info.project);
				},
				() => {}
			);
		return () => {
			active = false;
		};
	}, [model]);
	useLayoutEffect(() => {
		model.applyIndent(
			indentSettingsOf(indentChoice),
			model.live ? model.indentProject : indentProject
		);
	}, [
		model,
		indentProject,
		indentChoice?.indentStyle,
		indentChoice?.indentSize,
		indentChoice?.tabWidth,
	]);
	useEffect(() => {
		let shown = model.resolved;
		const view = new EditorView({
			parent: parent.current!,
			state: EditorState.create({
				doc: model.state.doc,
				extensions: [
					model.indent.of(indentExtensions(shown)),
					lineNumbers(),
					/* the change strip's place, so the code starts where the live editor's does */ gutter({
						class: 'cm-changeGutter',
					}),
					editorTheme,
					syntaxDecorations,
					EditorState.readOnly.of(true),
					EditorView.editable.of(false),
					EditorView.contentAttributes.of({ 'aria-label': label }),
				],
			}),
		});
		const colour = () => {
			if (model.syntaxDoc === model.state.doc && model.syntax)
				view.dispatch({ effects: setSyntax.of(model.syntax.tokens) });
		};
		colour();
		view.scrollDOM.scrollTop = model.scrollTop;
		view.scrollDOM.scrollLeft = model.scrollLeft;
		const stop = model.watch(() => {
			setDirty(model.dirty);
			if (!view.state.doc.eq(model.state.doc))
				view.dispatch({ changes: { from: 0, to: view.state.doc.length, insert: model.state.doc } });
			if (model.resolved !== shown) {
				shown = model.resolved;
				view.dispatch({ effects: model.indent.reconfigure(indentExtensions(shown)) });
			}
			colour();
		});
		const activate = (event: MouseEvent) => {
			if (event.button !== 0 && event.button !== 2) return;
			const pos = view.posAtCoords({ x: event.clientX, y: event.clientY });
			if (pos !== null && pos <= model.state.doc.length && event.button === 0)
				model.state = model.state.update({ selection: { anchor: pos } }).state;
			scrollHandover.set(model, { top: view.scrollDOM.scrollTop, left: view.scrollDOM.scrollLeft });
			onActivate();
		};
		view.dom.addEventListener('mousedown', activate);
		return () => {
			stop();
			view.dom.removeEventListener('mousedown', activate);
			view.destroy();
		};
	}, [model]);
	// The same header row as the live editor, so the lines of both groups stand at one height; no actions here.
	return (
		<div
			className={`${editorStyles.editor} ${styles.passive}`}
			data-passive-editor
			onMouseDown={(event) => {
				if (event.button === 0 || event.button === 2) onActivate();
			}}>
			<header data-size="s">
				<FilePath path={model.document.path} dirty={dirty} />
			</header>
			<div ref={parent} className={styles.mount} />
		</div>
	);
}

/**
 * A diff, commit or PR file shown by a group without the focus: the same DiffView, read from the same source as the live
 * one, with no actions; the first press anywhere in it focuses the group, which then shows the live diff.
 */
export function PassiveDiff({
	task,
	locale,
	target,
	entry,
	fileId,
	label,
	onActivate,
}: {
	task: AgentTask;
	locale: Locale;
	target: string;
	entry: CommitDiffEntry | undefined;
	fileId: string | undefined;
	label: string;
	onActivate(): void;
}) {
	const [diff, setDiff] = useState<FileDiff | null | 'failed'>(null);
	useEffect(() => {
		let current = true;
		setDiff(null);
		const read = entry
			? readCommitDiff(task, target, entry)
			: fileId
				? window.brigadir.readFileDiff(task, fileId)
				: null;
		if (!read) {
			setDiff('failed');
			return;
		}
		void read.then(
			(value) => {
				if (current) setDiff(value);
			},
			() => {
				if (current) setDiff('failed');
			}
		);
		return () => {
			current = false;
		};
	}, [task.id, task.projectId, target, entry, fileId]);
	return (
		<div
			className={styles.passive}
			data-passive-diff
			onMouseDownCapture={(event) => {
				if (event.button === 0 || event.button === 2) onActivate();
			}}>
			{diff && diff !== 'failed' ? (
				<DiffView
					diff={diff}
					locale={locale}
					task={task}
					comments={[]}
					canOpenEditor={false}
					onReviewChanged={async () => {}}
					onCompose={async () => false}
					onOpenEditor={() => {}}
					onRevert={() => {}}
				/>
			) : (
				<button type="button" className={styles.empty} onClick={onActivate}>
					{diff === 'failed' ? label : <SkeletonText lines={8} />}
				</button>
			)}
		</div>
	);
}
