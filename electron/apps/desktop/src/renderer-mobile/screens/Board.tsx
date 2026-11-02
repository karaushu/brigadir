/**
 * spec/remote-access-and-mobile#phone-pr-list: the project's tasks as the computer's board — the columns «Беклог · У роботі ·
 * Завершені» as pages under tabs, a sideways swipe between them, the list's cards. A long press lifts a card; over a tab the
 * page turns to that column and a hint under the finger says what a release does, or why it may not — `boardMove`'s rules.
 * A release that would stop a working agent asks first (a sheet).
 */
import {
	useEffect,
	useLayoutEffect,
	useRef,
	useState,
	type PointerEvent as ReactPointerEvent,
} from 'react';
import {
	boardColumns,
	boardSections,
	crewNeedsYou,
	crewWorkers,
	t,
	type AgentTask,
	type BoardColumn,
	type Locale,
	type MessageKey,
} from '@brigadir/core';
import { Button } from '../../renderer/ui/Controls';
import { QuietRow, TaskCard } from '../ui/Cards';
import { Sheet } from '../ui/Sheet';
import { Icon } from '../ui/Icon';
import { back, openSheet } from '../router';
import { useOffline } from '../store';
import { openTask } from './Home';
import { columnLabels, moveVerdict, type MoveVerdict } from './board-moves';
import sheets from './Sheets.module.css';
import s from './Board.module.css';

const hints: Record<BoardColumn, MessageKey> = {
	backlog: 'Set aside for later',
	progress: 'Drop here and the agent starts',
	completed: 'Drop here what you have accepted',
};
/** Which page each project shows, kept while the person opens a task and comes back. */
const pages = new Map<string, BoardColumn>();
const pressMs = 500;
type Lift = {
	task: AgentTask;
	/** The card's box when it was lifted and the finger's offset in it. */ box: DOMRect;
	dx: number;
	dy: number;
	x: number;
	y: number;
	over: BoardColumn;
	verdict: MoveVerdict;
};
async function move(task: AgentTask, column: BoardColumn) {
	try {
		await window.brigadir.moveTask({ projectId: task.projectId, id: task.id }, column);
		return null;
	} catch {
		return 'Could not move the task.' as const;
	}
}
export function Board({
	projectId,
	tasks,
	all,
	locale,
}: {
	projectId: string;
	/** The project's tasks after the filter. */ tasks: readonly AgentTask[];
	/** Every task of the machine: a foreman counts its workers. */ all: readonly AgentTask[];
	locale: Locale;
}) {
	const offline = useOffline();
	// spec/crew#attention: a foreman whose worker waits sorts with those that need you, as on the computer's board.
	const sections = boardSections(tasks, (task) => crewNeedsYou(task, all));
	const [page, setPage] = useState<BoardColumn>(() => pages.get(projectId) ?? 'progress'),
		[lift, setLift] = useState<Lift | null>(null),
		[toast, setToast] = useState<{ text: MessageKey; refused: boolean } | null>(null);
	const pager = useRef<HTMLDivElement>(null),
		tabs = useRef<HTMLDivElement>(null),
		press = useRef<{
			timer: ReturnType<typeof setTimeout>;
			x: number;
			y: number;
			task: AgentTask;
			node: HTMLElement;
		} | null>(null),
		swallow = useRef(false),
		liftRef = useRef<Lift | null>(null);
	liftRef.current = lift;
	useEffect(() => {
		pages.set(projectId, page);
	}, [projectId, page]);
	const show = (column: BoardColumn, smooth = true) => {
		const node = pager.current;
		if (!node) return;
		const index = boardColumns.indexOf(column);
		node.scrollTo({ left: index * node.clientWidth, behavior: smooth ? 'smooth' : 'instant' });
		setPage(column);
	};
	useLayoutEffect(() => show(page, false), []);
	// A sideways swipe settles on a page: its tab follows.
	const settle = () => {
		const node = pager.current;
		if (!node || liftRef.current) return;
		const index = Math.round(node.scrollLeft / Math.max(1, node.clientWidth));
		const column = boardColumns[Math.max(0, Math.min(boardColumns.length - 1, index))]!;
		if (column !== page) setPage(column);
	};
	useEffect(() => {
		if (!toast) return;
		const timer = setTimeout(() => setToast(null), 1800);
		return () => clearTimeout(timer);
	}, [toast]);
	// While a card is lifted the finger moves it, not the page: the browser's own pan is held back.
	useEffect(() => {
		if (!lift) return;
		const hold = (event: TouchEvent) => event.preventDefault();
		document.addEventListener('touchmove', hold, { passive: false });
		return () => document.removeEventListener('touchmove', hold);
	}, [Boolean(lift)]);
	const target = (x: number, y: number): BoardColumn => {
		const tab = document
			.elementsFromPoint(x, y)
			.find((node) => node instanceof HTMLElement && node.dataset.boardTab);
		return ((tab as HTMLElement | undefined)?.dataset.boardTab as BoardColumn | undefined) ?? page;
	};
	const start = (event: ReactPointerEvent, task: AgentTask) => {
		if (offline || event.button > 0) return;
		const node = event.currentTarget as HTMLElement;
		const at = { x: event.clientX, y: event.clientY };
		clearTimeout(press.current?.timer);
		press.current = {
			x: at.x,
			y: at.y,
			task,
			node,
			timer: setTimeout(() => {
				const current = press.current;
				if (!current) return;
				const box = current.node.getBoundingClientRect();
				swallow.current = true;
				navigator.vibrate?.(10);
				setLift({
					task,
					box,
					dx: current.x - box.left,
					dy: current.y - box.top,
					x: current.x,
					y: current.y,
					over: page,
					verdict: moveVerdict(task, page),
				});
			}, pressMs),
		};
		node.setPointerCapture?.(event.pointerId);
	};
	const pointerMove = (event: ReactPointerEvent) => {
		const current = press.current;
		if (!current) return;
		const state = liftRef.current;
		if (!state) {
			// A finger that travels before the press ends is a scroll or a swipe: no lift.
			if (Math.hypot(event.clientX - current.x, event.clientY - current.y) > 8) {
				clearTimeout(current.timer);
				press.current = null;
			}
			return;
		}
		const over = target(event.clientX, event.clientY);
		const verdict = moveVerdict(state.task, over);
		// KBDrag: over an allowed column's tab its page turns; a refused one stays put with its reason (KBRefused).
		if (over !== page && verdict.move) show(over);
		setLift({ ...state, x: event.clientX, y: event.clientY, over, verdict });
		setToast(verdict.hint ? { text: verdict.hint, refused: verdict.move === null } : null);
	};
	const end = async () => {
		const current = press.current;
		press.current = null;
		if (current) clearTimeout(current.timer);
		const state = liftRef.current;
		if (!state) return;
		setLift(null);
		const { verdict, task } = state;
		if (!verdict.move) {
			if (!verdict.hint) setToast(null);
			// A refused drop leaves its reason up a moment longer; the card goes back to its column.
			show(boardColumns.find((column) => sections[column].includes(task)) ?? page);
			return;
		}
		setToast(null);
		if (verdict.confirm) {
			openSheet({ kind: 'move', taskId: task.id, column: verdict.column });
			return;
		}
		const failed = await move(task, verdict.column);
		if (failed) setToast({ text: failed, refused: true });
	};
	const card = (task: AgentTask, column: BoardColumn) => {
		const lifted = lift?.task.id === task.id;
		return (
			<div
				key={task.id}
				className={s.slot}
				data-lifted={lifted || undefined}
				data-board-card={task.id}
				onPointerDown={(event) => start(event, task)}
				onPointerMove={pointerMove}
				onPointerUp={() => void end()}
				onPointerCancel={() => void end()}
				onContextMenu={(event) => event.preventDefault()}
				onClickCapture={(event) => {
					if (!swallow.current) return;
					swallow.current = false;
					event.preventDefault();
					event.stopPropagation();
				}}>
				{column === 'completed' ? (
					<QuietRow task={task} locale={locale} onOpen={openTask} />
				) : (
					<TaskCard
						task={task}
						locale={locale}
						{...(task.crew
							? { workers: crewWorkers(task, all).length, attention: crewNeedsYou(task, all) }
							: {})}
						onOpen={openTask}
					/>
				)}
			</div>
		);
	};
	return (
		<div className={s.board} data-board data-page={page}>
			<div ref={tabs} className={s.tabs} role="tablist" aria-label={t(locale, 'Board')}>
				{boardColumns.map((column) => {
					const drop =
							lift && lift.over === column && lift.verdict.move !== null ? true : undefined,
						refused =
							lift && lift.over === column && lift.verdict.move === null && lift.verdict.hint;
					return (
						<button
							key={column}
							type="button"
							role="tab"
							className={s.tab}
							aria-selected={page === column}
							data-board-tab={column}
							data-drop={drop}
							data-refused={refused ? true : undefined}
							onClick={() => show(column)}>
							{t(locale, columnLabels[column])}
							<small>{sections[column].length}</small>
						</button>
					);
				})}
			</div>
			<div className={s.area}>
				<div
					ref={pager}
					className={s.pager}
					data-lifting={lift ? true : undefined}
					onScroll={settle}>
					{boardColumns.map((column) => (
						<div
							key={column}
							className={s.page}
							role="tabpanel"
							aria-label={t(locale, columnLabels[column])}
							data-board-column={column}>
							{(() => {
								const drop = lift?.over === column && lift.verdict.move !== null;
								const box = (
									<div
										className={s.empty}
										data-drop={drop || undefined}
										data-compact={sections[column].length ? true : undefined}>
										<span>{t(locale, hints[column])}</span>
										{drop && <small>{t(locale, 'Release here')}</small>}
									</div>
								);
								if (!sections[column].length) return box;
								// spec/remote-access-and-mobile#remote-button: Backlog and Completed keep the dashed box
								// under their cards at all times; it is also where a held card lands.
								if (column !== 'progress')
									return (
										<>
											{sections[column].map((task) => card(task, column))}
											{box}
										</>
									);
								// KBDrag: «In progress» with cards takes a drop box on top while a card is held over it.
								return (
									<>
										{drop && box}
										{sections[column].map((task) => card(task, column))}
									</>
								);
							})()}
						</div>
					))}
				</div>
				{toast && (
					<div
						className={s.toast}
						data-refused={toast.refused || undefined}
						role="status"
						data-board-toast>
						<Icon name={toast.refused ? 'x2' : 'tick'} size={16} />
						{t(locale, toast.text)}
					</div>
				)}
			</div>
			{lift && (
				<div
					className={s.lifted}
					aria-hidden="true"
					style={{
						left: lift.x - lift.dx,
						top: lift.y - lift.dy,
						width: lift.box.width,
					}}>
					{lift.task.status === 'completed' ? (
						<QuietRow task={lift.task} locale={locale} onOpen={() => {}} />
					) : (
						<TaskCard task={lift.task} locale={locale} onOpen={() => {}} />
					)}
				</div>
			)}
		</div>
	);
}
/** A move that stops a working agent asks first (spec/remote-access-and-mobile#phone-pr-list): the turn would end from one slip of the finger. */
export function MoveSheet({
	task,
	column,
	locale,
}: {
	task: AgentTask | undefined;
	column: BoardColumn;
	locale: Locale;
}) {
	const [busy, setBusy] = useState(false),
		[failed, setFailed] = useState(false);
	if (!task) return null;
	const run = async () => {
		setBusy(true);
		const error = await move(task, column);
		setBusy(false);
		if (error) setFailed(true);
		else back();
	};
	return (
		<Sheet
			label={t(locale, 'Stop the agent?')}
			title={t(locale, 'Stop the agent?')}
			locale={locale}
			close={back}>
			<div data-move-sheet={column}>
				<p className={sheets.dialogText}>
					{t(
						locale,
						'The agent of «{title}» is working: its turn stops and the task moves to «{column}».'
					)
						.replace('{title}', task.title)
						.replace('{column}', t(locale, columnLabels[column]))}
				</p>
				{failed && (
					<p className={`${sheets.dialogText} ${s.failed}`}>
						{t(locale, 'Could not move the task.')}
					</p>
				)}
				<div className={sheets.dialogButtons} data-size="xl">
					<Button
						appearance="danger"
						className={sheets.wide}
						data-move-confirm
						disabled={busy}
						onClick={() => void run()}>
						{t(locale, 'Stop and move')}
					</Button>
					<Button className={sheets.wide} onClick={back}>
						{t(locale, 'Cancel')}
					</Button>
				</div>
			</div>
		</Sheet>
	);
}
