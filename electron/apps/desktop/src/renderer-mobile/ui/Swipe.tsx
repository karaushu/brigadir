/**
 * spec/remote-access-and-mobile#phone-task-tools (spec/tasks#archive-actions): a card swiped left shows its action — Complete for a task in work whose
 * agent is idle, Archive for a completed one, nothing while the agent works or waits (core `swipeAction`, the same rule
 * as the computer's trackpad swipe). The action runs on a tap, not at the end of the swipe: a finger is less exact than a
 * trackpad, and the phone has no undo toast. A vertical drag stays the list's scroll.
 */
import { useRef, useState, type ReactNode } from 'react';
import { swipeAction, t, type AgentTask, type Locale } from '@brigadir/core';
import { Icon } from './Icon';
import { useOffline } from '../store';
import s from './Swipe.module.css';

const width = 84;
export function SwipeRow({
	task,
	tasks,
	locale,
	row = false,
	children,
}: {
	task: AgentTask;
	tasks: readonly AgentTask[];
	locale: Locale;
	/** The quiet row of a completed task: its radius. */ row?: boolean;
	children: ReactNode;
}) {
	// The machine is away: the cached cards open read-only, and nothing to swipe — the action could not reach it.
	const offline = useOffline(),
		action = offline ? null : swipeAction(task, tasks);
	const [offset, setOffset] = useState(0),
		[dragging, setDragging] = useState(false),
		[busy, setBusy] = useState(false),
		drag = useRef<{ x: number; y: number; from: number; moved: boolean } | null>(null),
		swallow = useRef(false);
	if (!action) return <>{children}</>;
	const close = () => setOffset(0);
	const run = async () => {
		setBusy(true);
		try {
			const key = { projectId: task.projectId, id: task.id };
			if (action === 'complete') await window.brigadir.moveTask(key, 'completed');
			else await window.brigadir.archiveTask(key);
		} catch {
			// The machine refused (the agent started meanwhile): the card stays as it is.
		} finally {
			setBusy(false);
			close();
		}
	};
	return (
		<div
			className={s.swipe}
			data-row={row || undefined}
			data-swipe={task.id}
			data-open={offset > 0 || undefined}
			data-dragging={dragging || undefined}
			onPointerDown={(event) => {
				drag.current = { x: event.clientX, y: event.clientY, from: offset, moved: false };
			}}
			onPointerMove={(event) => {
				const state = drag.current;
				if (!state) return;
				const dx = event.clientX - state.x,
					dy = event.clientY - state.y;
				if (!state.moved) {
					if (Math.abs(dx) < 8 || Math.abs(dx) < Math.abs(dy)) {
						if (Math.abs(dy) > 8) drag.current = null;
						return;
					}
					state.moved = true;
					setDragging(true);
					(event.currentTarget as HTMLElement).setPointerCapture(event.pointerId);
				}
				setOffset(Math.max(0, Math.min(width + 24, state.from - dx)));
			}}
			onPointerUp={() => {
				const state = drag.current;
				drag.current = null;
				setDragging(false);
				if (!state) return;
				if (state.moved) {
					swallow.current = true;
					setOffset((value) => (value > width / 2 ? width : 0));
				} else if (state.from > 0) {
					swallow.current = true;
					close();
				}
			}}
			onPointerCancel={() => {
				drag.current = null;
				setDragging(false);
				setOffset((value) => (value > width / 2 ? width : 0));
			}}
			onClickCapture={(event) => {
				if (!swallow.current) return;
				swallow.current = false;
				if ((event.target as HTMLElement).closest('[data-swipe-action]')) return;
				event.preventDefault();
				event.stopPropagation();
			}}>
			<button
				type="button"
				className={s.action}
				data-swipe-action={action}
				tabIndex={offset > 0 ? 0 : -1}
				aria-hidden={offset === 0 || undefined}
				disabled={busy}
				onClick={() => void run()}>
				<Icon name={action === 'complete' ? 'tick' : 'archive'} size={20} />
				{t(locale, action === 'complete' ? 'Complete' : 'Archive')}
			</button>
			<div
				className={s.content}
				data-dragging={dragging || undefined}
				style={offset ? { transform: `translateX(${-offset}px)` } : undefined}>
				{children}
			</div>
		</div>
	);
}
