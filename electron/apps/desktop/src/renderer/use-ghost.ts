import { useEffect, useState, type RefObject } from 'react';
import { ghostHeadlessPolicy, ghostTurn, type AgentTask, type EventRecord } from '@brigadir/core';
import { useWorkspace } from './store';
export function useHeadlessGhost({
	task,
	records,
	composerEmpty,
	dismissed,
	heuristicFound,
	connected,
	root,
}: {
	task: AgentTask;
	records: readonly EventRecord[];
	composerEmpty: boolean;
	dismissed: boolean;
	heuristicFound: boolean;
	connected: boolean;
	root: RefObject<HTMLDivElement | null>;
}) {
	const enabled = useWorkspace((state) => state.appearance.suggestNextPrompt),
		[visible, setVisible] = useState(false),
		[reply, setReply] = useState<{ turn: number; text: string } | null>(null),
		[pending, setPending] = useState(false),
		turn = ghostTurn(records);
	useEffect(() => {
		const element = root.current;
		if (!element) return;
		let intersects = false;
		const update = () => setVisible(intersects && document.visibilityState === 'visible');
		const observer = new IntersectionObserver((entries) => {
			intersects = entries[0]?.isIntersecting ?? false;
			update();
		});
		observer.observe(element);
		document.addEventListener('visibilitychange', update);
		return () => {
			observer.disconnect();
			document.removeEventListener('visibilitychange', update);
		};
	}, [root]);
	const reason = ghostHeadlessPolicy({
		enabled,
		visible: visible && connected,
		composerEmpty,
		dismissed,
		heuristicFound,
		records,
	});
	useEffect(() => {
		setPending(false);
		if (reason !== 'allowed' || turn === null) return;
		let active = true;
		const id = crypto.randomUUID(),
			timer = setTimeout(() => {
				setPending(true);
				void window.brigadir
					.requestGhost(task, turn, id)
					.then(
						(text) => {
							if (active && text) setReply({ turn, text });
						},
						() => {}
					)
					.finally(() => {
						if (active) setPending(false);
					});
			}, 400);
		return () => {
			active = false;
			clearTimeout(timer);
			void window.brigadir.cancelGhost(task, id).catch(() => {});
		};
	}, [task.id, task.projectId, reason, turn]);
	return {
		text: reason === 'allowed' && reply?.turn === turn ? reply.text : null,
		pending: reason === 'allowed' && pending,
	};
}
