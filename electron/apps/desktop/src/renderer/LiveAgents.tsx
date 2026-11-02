import {
	createContext,
	useContext,
	useEffect,
	useLayoutEffect,
	useRef,
	useState,
	type ReactNode,
} from 'react';
import { onSessionEvent } from './session-events';
import {
	mcpActivityTitle,
	t,
	type LiveAgent,
	type LiveAgentsSnapshot,
	type Locale,
	type MessageKey,
} from '@brigadir/core';
import { useWorkspace } from './store';
import { Glyph } from './ui/Glyph';
import { PopupClose } from './ui/PopupClose';
import { MenuItem, MenuPopover } from './ui/Popover';
import { Button, IconButton } from './ui/Controls';
import { usePresence } from './ui/use-presence';
import s from './LiveAgents.module.css';
import { SkeletonRows } from './ui/Loading';
const Context = createContext<{
	snapshot: LiveAgentsSnapshot | null;
	error: boolean;
	open: boolean;
	show(button: HTMLElement): void;
} | null>(null);
export function AgentsButton() {
	const context = useContext(Context),
		locale = useWorkspace((state) => state.appearance.locale);
	if (!context) return null;
	const waiting = !!context.snapshot?.agents.some((agent) => agent.status === 'needs-you');
	// spec/appearance#evolution-redesign, spec/task-window#repo-line: a pulse with the live count; someone waiting is an amber dot on the pulse, not a tone.
	return (
		<Button
			variant="ghost"
			data-agent-button
			className={s.trigger}
			aria-label={`${t(locale, 'Agents in work')} · ${context.error ? '?' : (context.snapshot?.agents.length ?? '—')}`}
			aria-description={waiting ? t(locale, 'Needs you') : undefined}
			title={t(locale, 'Agents in work')}
			aria-haspopup="dialog"
			aria-expanded={context.open}
			data-attention={waiting}
			onClick={(event) => context.show(event.currentTarget)}>
			<span className={s.pulse}>
				<Glyph name="activity" size={16} />
				{waiting && <span className={s.waiting} aria-hidden="true" />}
			</span>
			<span className={s.count}>
				{context.error ? '?' : (context.snapshot?.agents.length ?? '—')}
			</span>
		</Button>
	);
}
/** spec/task-window#narrow-toolbar: the «…» menu row of the Agents button: the same count, the same popup, opened from «…». */
export function useAgentsEntry() {
	const context = useContext(Context);
	return context
		? {
				count: context.error ? '?' : String(context.snapshot?.agents.length ?? '—'),
				attention: !!context.snapshot?.agents.some((agent) => agent.status === 'needs-you'),
				show: context.show,
			}
		: null;
}
const active = (agent: LiveAgent) => ['working', 'needs-you', 'preparing'].includes(agent.status);
const label = (agent: LiveAgent): MessageKey =>
	agent.status === 'rate-limited'
		? 'Rate limited'
		: agent.status === 'working'
			? 'Working'
			: agent.status === 'needs-you'
				? 'Needs you'
				: agent.status === 'failed'
					? 'Error'
					: agent.status === 'interrupted'
						? 'Interrupted'
						: agent.status === 'preparing'
							? 'Preparing…'
							: agent.status === 'queued'
								? 'Queued'
								: 'Waiting for a prompt';
function age(date: string, locale: Locale) {
	const minutes = Math.max(0, Math.floor((Date.now() - Date.parse(date)) / 60000));
	return new Intl.NumberFormat(locale, {
		style: 'unit',
		unit: minutes < 60 ? 'minute' : 'hour',
		unitDisplay: 'short',
	}).format(minutes < 60 ? minutes : Math.floor(minutes / 60));
}
export function AgentsProvider({ children, locale }: { children: ReactNode; locale: Locale }) {
	const [snapshot, setSnapshot] = useState<LiveAgentsSnapshot | null>(null),
		[error, setError] = useState(false),
		[open, setOpen] = useState(false);
	const alive = useRef(true),
		anchor = useRef<HTMLElement | null>(null),
		pending = useRef<Promise<void> | null>(null),
		refresh = useRef<() => Promise<void>>(async () => {});
	refresh.current = () => {
		if (pending.current) return pending.current;
		const work = window.brigadir
			.readLiveAgents()
			.then(
				(value) => {
					if (alive.current) {
						setSnapshot(value);
						setError(false);
					}
				},
				() => {
					if (alive.current) setError(true);
				}
			)
			.finally(() => {
				if (pending.current === work) pending.current = null;
			});
		pending.current = work;
		return work;
	};
	useEffect(() => {
		alive.current = true;
		void refresh.current();
		let timer: ReturnType<typeof setTimeout> | undefined;
		const stop = onSessionEvent(({ record }) => {
			if (
				!record ||
				[
					'session.started',
					'turn.started',
					'turn.completed',
					'question.requested',
					'permission.requested',
					'task.proposal.requested',
					'crew.plan.requested',
					'host.stopped',
				].includes(record.event.kind)
			) {
				clearTimeout(timer);
				timer = setTimeout(() => void refresh.current(), 200);
			}
		});
		return () => {
			alive.current = false;
			clearTimeout(timer);
			stop();
		};
	}, []);
	useEffect(() => {
		const timer = setInterval(
			() => {
				if (document.visibilityState === 'visible') void refresh.current();
			},
			open ? 1000 : 5000
		);
		return () => clearInterval(timer);
	}, [open]);
	const present = usePresence(open),
		close = () => setOpen(false),
		show = (button: HTMLElement) => {
			anchor.current = button;
			setOpen((value) => !value);
			void refresh.current();
		};
	return (
		<Context.Provider value={{ snapshot, error, open, show }}>
			{children}
			{present && (
				<AgentsPopup
					open={open}
					close={close}
					anchor={anchor}
					locale={locale}
					snapshot={snapshot}
					error={error}
					refresh={() => refresh.current()}
				/>
			)}
		</Context.Provider>
	);
}
function AgentsPopup({
	open,
	close,
	anchor,
	locale,
	snapshot,
	error,
	refresh,
}: {
	open: boolean;
	close(): void;
	anchor: React.RefObject<HTMLElement | null>;
	locale: Locale;
	snapshot: LiveAgentsSnapshot | null;
	error: boolean;
	refresh(): Promise<void>;
}) {
	const dialog = useRef<HTMLDialogElement>(null),
		[busy, setBusy] = useState<string[]>([]),
		[failures, setFailures] = useState<Record<string, 'stop' | 'terminate'>>({}),
		[menu, setMenu] = useState<string | null>(null),
		[confirm, setConfirm] = useState<string | null>(null),
		alive = useRef(true);
	useEffect(() => {
		alive.current = true;
		return () => {
			alive.current = false;
		};
	}, []);
	useLayoutEffect(() => {
		const element = dialog.current!;
		const position = () => {
			const rect = anchor.current?.getBoundingClientRect(),
				top = Math.min(rect ? rect.bottom + 8 : 60, innerHeight - 180);
			element.style.left = `${Math.max(12, Math.min(rect?.left ?? 12, innerWidth - 432))}px`;
			element.style.top = `${top}px`;
			element.style.maxHeight = `${innerHeight - top - 12}px`;
		};
		if (open) {
			position();
			element.showModal();
		} else element.close();
		window.addEventListener('resize', position);
		return () => {
			window.removeEventListener('resize', position);
			element.close();
			requestAnimationFrame(() => {
				if (dialog.current?.open) return;
				const target = anchor.current?.isConnected
					? anchor.current
					: document.querySelector<HTMLElement>('[data-agent-button]');
				target?.focus({ preventScroll: true });
			});
		};
	}, [open]);
	const menuAnchor = useRef<HTMLElement | null>(null),
		actionsButton = (id: string) =>
			dialog.current?.querySelector<HTMLElement>(
				`[data-agent-instance="${id}"] button[aria-expanded]`
			) ?? null;
	const openMenu = (id: string) => {
		menuAnchor.current = actionsButton(id);
		setMenu(id);
	};
	const focusActions = (id: string) =>
		requestAnimationFrame(() =>
			dialog.current
				?.querySelector<HTMLElement>(`[data-agent-instance="${id}"] button[aria-expanded]`)
				?.focus({ preventScroll: true })
		);
	// The confirm group mounts with `confirm`: it is focused once React adds it, not in a frame that may come first.
	const [confirmFocus, setConfirmFocus] = useState(0);
	useLayoutEffect(() => {
		if (confirmFocus && confirm)
			dialog.current
				?.querySelector<HTMLElement>(`[data-agent-instance="${confirm}"] [role=group] button`)
				?.focus();
	}, [confirmFocus]);
	const dismissConfirm = () => {
		const id = confirm;
		setConfirm(null);
		if (id) focusActions(id);
	};
	const agents = snapshot?.agents ?? [],
		projects = [...new Set(agents.map((agent) => agent.key.projectId))];
	const action = async (agent: LiveAgent, kind: 'stop' | 'terminate') => {
		setBusy((values) => [...values, agent.instance]);
		setFailures(({ [agent.instance]: _, ...rest }) => rest);
		try {
			await window.brigadir.controlLiveAgent({ key: agent.key, instance: agent.instance }, kind);
			if (alive.current) {
				setConfirm(null);
				setMenu(null);
			}
			await refresh();
			if (kind === 'terminate' && alive.current)
				requestAnimationFrame(() =>
					dialog.current
						?.querySelector<HTMLElement>('header button')
						?.focus({ preventScroll: true })
				);
		} catch {
			if (alive.current) setFailures((values) => ({ ...values, [agent.instance]: kind }));
		} finally {
			if (alive.current) setBusy((values) => values.filter((value) => value !== agent.instance));
		}
	};
	const stopAll = async () => {
		for (const agent of agents.filter(active)) {
			await action(agent, 'stop');
		}
	};
	const [stoppingAll, setStoppingAll] = useState(false);
	return (
		<dialog
			ref={dialog}
			className={s.popup}
			aria-label={t(locale, 'Agents in work')}
			onCancel={(event) => {
				event.preventDefault();
				if (confirm) dismissConfirm();
				else if (menu) {
					const id = menu;
					setMenu(null);
					focusActions(id);
				} else close();
			}}
			onClick={(event) => {
				if (event.target === dialog.current) {
					const rect = dialog.current!.getBoundingClientRect();
					if (
						event.clientX < rect.left ||
						event.clientX > rect.right ||
						event.clientY < rect.top ||
						event.clientY > rect.bottom
					)
						close();
				}
			}}>
			<header>
				<h2>{t(locale, 'Agents in work')}</h2>
				<span>{agents.length}</span>
				<PopupClose locale={locale} close={close} />
			</header>
			<div className={s.list}>
				{!snapshot && !error && <SkeletonRows count={4} height={36} />}
				{(error || !!snapshot?.issues) && (
					<p className={s.error} role="alert">
						{t(locale, 'Some agents could not be read.')}{' '}
						<Button onClick={() => void refresh()}>{t(locale, 'Retry')}</Button>
					</p>
				)}
				{snapshot && !agents.length && <p>{t(locale, 'No live agents')}</p>}
				{projects.map((projectId) => (
					<section
						key={projectId}
						aria-label={agents.find((agent) => agent.key.projectId === projectId)!.projectName}>
						<h3>{agents.find((agent) => agent.key.projectId === projectId)!.projectName}</h3>
						{agents
							.filter((agent) => agent.key.projectId === projectId)
							.map((agent) => {
								const id = agent.instance,
									disabled = busy.includes(id) || stoppingAll;
								return (
									<article
										key={id}
										data-live-agent={agent.key.id}
										data-agent-instance={id}
										data-state={agent.status}
										className={s.row}
										aria-label={agent.title}
										onContextMenu={(event) => {
											event.preventDefault();
											openMenu(id);
										}}
										onKeyDown={(event) => {
											if (event.key === 'ContextMenu' || (event.shiftKey && event.key === 'F10')) {
												event.preventDefault();
												openMenu(id);
											}
										}}>
										<div className={s.line}>
											<span className={s.chevron} />
											<span className={s.status} title={t(locale, label(agent))}>
												<Glyph
													name={
														agent.status === 'rate-limited'
															? 'agent-hourglass'
															: agent.status === 'needs-you'
																? agent.attention === 'question'
																	? 'agent-question'
																	: 'agent-permission'
																: agent.status === 'working' || agent.status === 'preparing'
																	? 'agent-run'
																	: agent.status === 'failed'
																		? 'agent-failed'
																		: agent.status === 'interrupted'
																			? 'agent-stopped'
																			: agent.status === 'queued'
																				? 'agent-queued'
																				: agent.status === 'completed'
																					? 'agent-completed'
																					: 'agent-idle'
													}
													size={15}
												/>
											</span>
											<button
												className={s.task}
												onClick={() => {
													close();
													useWorkspace.getState().selectTask(agent.key.projectId, agent.key.id);
													if (location.hash === '#kit') location.hash = 'workspace';
													void useWorkspace.getState().load();
												}}>
												<span>
													{agent.title}
													{agent.provider && (
														<Glyph
															name={agent.provider === 'claude' ? 'claude' : 'openai'}
															size={10}
														/>
													)}
												</span>
												<small
													title={
														agent.activity
															? (mcpActivityTitle(locale, agent.activity) ?? agent.activity)
															: t(locale, label(agent))
													}>
													{active(agent) && agent.activity
														? (mcpActivityTitle(locale, agent.activity) ?? agent.activity)
														: t(locale, label(agent))}
												</small>
											</button>
											<span className={s.action}>
												<span className={s.age}>{age(agent.startedAt, locale)}</span>
												<Button
													size="s"
													className={s.stop}
													disabled={disabled || !active(agent)}
													title={t(locale, 'Stop the turn; keep the session alive.')}
													onClick={() => void action(agent, 'stop')}>
													{t(locale, 'Stop')}
												</Button>
											</span>
											<IconButton
												size="s"
												className={s.more}
												label={`${t(locale, 'Agent actions')} · ${agent.title}`}
												aria-haspopup="menu"
												aria-expanded={menu === id}
												onClick={() => (menu === id ? setMenu(null) : openMenu(id))}>
												<Glyph name="more" size={14} />
											</IconButton>
										</div>

										{confirm === id && (
											<div
												className={s.confirm}
												role="group"
												aria-label={t(locale, 'End this session?')}>
												<span>{t(locale, 'End this session?')}</span>
												<Button disabled={disabled} onClick={dismissConfirm}>
													{t(locale, 'Cancel')}
												</Button>
												<Button
													appearance="danger"
													disabled={disabled}
													onClick={() => void action(agent, 'terminate')}>
													{t(locale, 'Kill process')}
												</Button>
											</div>
										)}
										{/* spec/notifications-slack-notes-and-schedules#message-classes: the popup is modal, a toast would sit under it — the failure stays in the row and names the action. */}
										{failures[id] && (
											<p className={s.error} role="alert">
												{t(
													locale,
													failures[id] === 'stop'
														? 'Could not stop the agent.'
														: 'Could not kill the process.'
												)}{' '}
												<Button onClick={() => void refresh()}>{t(locale, 'Refresh')}</Button>
											</p>
										)}
									</article>
								);
							})}
					</section>
				))}
			</div>
			<footer>
				<span>{t(locale, 'Live sessions across all projects')}</span>
				<Button
					disabled={!agents.some(active) || !!busy.length || stoppingAll}
					onClick={() => {
						setStoppingAll(true);
						void stopAll().finally(() => {
							if (alive.current) setStoppingAll(false);
						});
					}}>
					{t(locale, 'Stop all')}
				</Button>
			</footer>
			<MenuPopover
				open={menu !== null && confirm !== menu}
				onClose={() => setMenu(null)}
				anchor={menuAnchor}
				align="end"
				label={t(locale, 'Agent actions')}
				locale={locale}>
				<MenuItem
					danger
					disabled={!!menu && (busy.includes(menu) || stoppingAll)}
					onSelect={() => {
						setConfirm(menu);
						setConfirmFocus((value) => value + 1);
					}}>
					{t(locale, 'Kill process…')}
				</MenuItem>
			</MenuPopover>
		</dialog>
	);
}
