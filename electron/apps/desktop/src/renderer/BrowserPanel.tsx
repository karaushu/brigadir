import { DocumentDialog } from './ui/DocumentDialog';
import { TextInput } from './ui/Input';
import { Glyph } from './ui/Glyph';
import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import {
	actionCount,
	t,
	commandAccelerator,
	deviceExternalUrl,
	defaultKeymap,
	formatAccelerator,
	menuCommands,
	mobileViewport,
	type AgentTask,
	type Locale,
	type BrowserEvent,
	type BrowserNetworkDetails,
	type BrowserCommand,
	type MessageKey,
} from '@brigadir/core';
import { useTaskState, rowPosition, attachTaskContext } from './task-state';
import { Button, IconButton, Segments } from './ui/Controls';
import { ToolbarMore, type MoreEntry } from './ToolbarMore';
import { useWorkspace } from './store';
import { Rows } from './ui/Rows';
import { notify } from './ui/Toast';
import { draggedTab } from './EditorGroups';
import {
	agentStepText,
	displayAddress,
	freshBrowserTabs,
	useAgentMark,
	useBrowserTab,
} from './browser-tabs';
import { remoteMachine, useRemote } from './remote-store';
import { BrowserScreen } from './BrowserScreen';
import { MachineTag } from './ui/MachineTag';
import { fill } from './remote-text';
import styles from './BrowserPanel.module.css';
/** spec/notifications-slack-notes-and-schedules#message-classes: what a failed browser command was, for its own toast; `null` — a step the person did not take (focus after mount). */
const commandFailures: Partial<Record<BrowserCommand['kind'], MessageKey | null>> = {
	open: 'Could not open the page.',
	back: 'Could not open the page.',
	forward: 'Could not open the page.',
	reload: 'Could not reload the page.',
	external: 'Could not open the page in the default browser.',
	mode: 'Could not switch the browser view.',
	notifications: 'Could not save the site notifications.',
	mute: null,
	pick: 'Could not switch node selection.',
	inspect: 'Could not open DevTools.',
	network: 'Could not read the request details.',
	screenshot: 'Could not take a page screenshot.',
	focus: null,
};
const showFailure = (kind: 'console' | 'network'): MessageKey =>
	kind === 'console'
		? 'Could not show the page console to the agent.'
		: 'Could not show the network requests to the agent.';
const blankPage = (url: string) => !url || url === 'about:blank';
/**
 * spec/task-window-workspace#work-area: one browser tab of the work area — the address and actions strips over the page, as the column had. Each tab
 * is its own page in main (`tab`); the agent's tab shows its work, and under an overlay the page stands in as a
 * picture. `onChat` goes to the agent's tool rows in the chat (`In chat`).
 */
export function BrowserPanel({
	task,
	locale,
	tab,
	onChat,
}: {
	task: AgentTask;
	locale: Locale;
	tab: string;
	onChat?: () => void;
}) {
	const address = useRef<HTMLInputElement>(null);
	const info = useBrowserTab(task, tab),
		mark = useAgentMark(info?.agent);
	// The picture of the page while an overlay covers it (spec/task-window-workspace#work-area).
	const [snapshot, setSnapshot] = useState<string | null>(null);
	const root = useRef<HTMLElement>(null);
	/** spec/task-window-workspace#work-area: a menu action goes to the browser tab with the focus, else the one in the focused group, else the only one. */
	const mine = () => {
		const node = root.current;
		if (!node) return false;
		const all = document.querySelectorAll('[data-browser]');
		if (all.length === 1 || node.contains(document.activeElement)) return true;
		if (document.activeElement?.closest('[data-browser]')) return false;
		return !!node.closest('[data-editor-group][data-focused=true]');
	};
	const [{ positions, attachments }, setTask] = useTaskState(task);
	const [event, setEvent] = useState<BrowserEvent | null>(null);
	const [url, setUrl] = useState('');
	const [drawer, setDrawer] = useState<'console' | 'network' | null>(null);
	const viewport = useRef<HTMLDivElement>(null);
	// spec/browser-and-simulator#browser «Desktop / Mobile»: the phone viewport stands in the middle of the tab.
	const mobile = !remoteMachine && !!event?.state.mobile;
	const mobileRef = useRef(mobile);
	mobileRef.current = mobile;
	const remeasure = useRef<() => void>(() => {});
	const editingAddress = useRef(false);
	// spec/task-window-workspace#tool-tab-look.1: at rest the field shows the address without `http://` / `https://`; focused, the whole of it.
	const [addressFocused, setAddressFocused] = useState(false);
	useLayoutEffect(() => {
		if (addressFocused) address.current?.select();
	}, [addressFocused]);
	const mountedOnce = useRef(false);
	const [details, setDetails] = useState<BrowserNetworkDetails | null>(null);
	const [dismissed, setDismissed] = useState('');
	const failure = event?.logs.findLast((log) => log.error);
	const consoleErrors =
		event?.logs.filter((log) => log.kind === 'console' && log.error).length ?? 0;
	const networkErrors =
		event?.logs.filter((log) => log.kind === 'network' && log.error).length ?? 0;
	const fail = (key: MessageKey, options: { retry?: () => void; warning?: boolean } = {}) =>
		notify(options.warning ? 'warning' : 'error', t(locale, key), {
			action: options.retry ? { label: t(locale, 'Retry'), run: options.retry } : undefined,
		});
	const screenshot = () => {
		void command({ kind: 'screenshot' })
			.then(async (result) => {
				if (result && typeof result === 'object' && 'image' in result)
					await attachTaskContext(task, {
						kind: 'image',
						mimeType: 'image/png',
						name: t(locale, 'Screenshot'),
						data: String(result.image),
					});
			})
			.catch(() => fail('Could not attach the screenshot.'));
	};
	useEffect(
		() =>
			window.brigadir.onWorkspaceAction((action) => {
				if (!action.startsWith('browser-') || !mine()) return;
				if (action === 'browser-address') {
					editingAddress.current = true;
					address.current?.focus();
					address.current?.select();
					return;
				}
				const kind = (
					{
						'browser-pick': 'pick',
						'browser-inspect': 'inspect',
						'browser-reload': 'reload',
						'browser-back': 'back',
						'browser-forward': 'forward',
					} as const
				)[action as 'browser-pick'];
				if (kind && !(action === 'browser-inspect' && remoteMachine)) void command({ kind });
				if (action === 'browser-screenshot') screenshot();
			}),
		[task.id, task.projectId, locale, tab]
	);
	// spec/browser-and-simulator#browser-toolbar: «…» — the page actions that have no button of their own in the strip, each with its menu shortcut.
	const keymap = useWorkspace((state) => state.appearance.keymap) ?? defaultKeymap;
	const accelerator = (id: string) => {
		const item = menuCommands.find((entry) => entry.id === id),
			key = item && commandAccelerator(item, keymap);
		return key ? formatAccelerator(key) : undefined;
	};
	// spec/remote-access-and-mobile#client-ui-seam: in a window of another machine the page is that machine's. Its DevTools would open on that
	// screen, and its local address means another computer here: such pages have no «Open in default browser».
	const pageUrl = event?.state.url ?? '';
	const external = remoteMachine
		? deviceExternalUrl(pageUrl)
		: /^https?:\/\//i.test(pageUrl)
			? pageUrl
			: null;
	const openExternal = () => {
		if (remoteMachine) {
			if (external)
				void window.brigadir.openWebLink(external).catch(() => fail('Could not open the page.'));
		} else void command({ kind: 'external' });
	};
	// spec/browser-and-simulator#notifications: the person's decision for the page's domain; a device has no strip yet.
	const notifications = remoteMachine ? null : (event?.state.notifications ?? null);
	const notificationChoices = [
		['default', 'Ask (notifications)'],
		['granted', 'Allow (notifications)'],
		['denied', 'Block (notifications)'],
	] as const;
	const moreEntries: MoreEntry[] = [
		...(remoteMachine
			? []
			: [
					{
						key: 'devtools',
						label: t(locale, 'DevTools'),
						icon: 'sim-devtools' as const,
						kbd: accelerator('browser-inspect'),
						kind: 'action' as const,
						run: () => {
							void command({ kind: 'inspect' });
						},
					},
				]),
		...(external
			? [
					{
						key: 'external',
						label: t(locale, 'Open in default browser'),
						icon: 'external' as const,
						kind: 'action' as const,
						separator: !remoteMachine,
						run: openExternal,
					},
				]
			: []),
		...(notifications
			? notificationChoices.map(([value, label], index) => ({
					key: `notifications-${value}`,
					label: t(locale, label),
					icon: (value === 'denied' ? 'notifications-off' : 'bell') as 'bell',
					kind: 'radio' as const,
					checked: notifications.permission === value,
					...(index === 0 ? { section: t(locale, 'Site notifications'), separator: true } : {}),
					run: () => {
						void command({ kind: 'notifications', decision: value });
					},
				}))
			: []),
	];
	async function command(command: BrowserCommand) {
		try {
			return await window.brigadir.browserCommand(task, { ...command, tab });
		} catch {
			const key = commandFailures[command.kind];
			if (key) fail(key);
			return null;
		}
	}
	useEffect(
		() =>
			window.brigadir.onBrowserEvent(({ key, event }) => {
				if (key.id !== task.id || key.projectId !== task.projectId || event.tab !== tab) return;
				setEvent(event);
				// spec/browser-and-simulator#notifications: the page's notification while its tab is in front; «Open» is the page's own click.
				if (event.notice) {
					const { id, title, body, host } = event.notice;
					notify('info', [title, body, host].filter(Boolean).join(' · '), {
						bold: title || undefined,
						key: `page-notice:${tab}:${id}`,
						action: {
							label: t(locale, 'Open'),
							run: () => {
								void command({ kind: 'notification-click', id });
							},
						},
					});
				}
				// A new tab without a page has an empty address, not `about:blank`.
				if (!event.state.loading && !editingAddress.current)
					setUrl(blankPage(event.state.url) ? '' : event.state.url);
				if (event.node)
					void attachTaskContext(task, {
						kind: 'text',
						name: t(locale, 'Select node'),
						text: `Selected browser node: ${event.node}`,
					})
						.then((attachment) =>
							event.nodeToken
								? window.brigadir.browserCommand(task, {
										kind: 'bind-node',
										token: event.nodeToken,
										attachmentId: attachment.id,
										tab,
									})
								: null
						)
						.catch(() => fail('Could not attach the node.'));
			}),
		[task.id, task.projectId, locale, tab]
	);
	useEffect(() => {
		void window.brigadir
			.browserCommand(task, {
				kind: 'retain-nodes',
				attachmentIds: attachments.map((item) => item.id),
				tab,
			})
			.catch(() => {});
	}, [task.id, task.projectId, attachments, tab]);
	useLayoutEffect(() => {
		// spec/remote-access-and-mobile#browser-from-device: a window of another machine streams the page into a canvas (BrowserScreen) instead.
		if (remoteMachine) return;
		const element = viewport.current!;
		let disposed = false,
			frame = 0,
			sent = '',
			shown = false;
		// Mutations and scrolls anywhere in the window fire constantly while an agent streams: measure once per frame
		// and cross IPC only when the native view has to move, hide or show.
		// A popover (the strip's «…», a menu next to the column) floats in the top layer, still under the native view:
		// the page steps aside while an open one overlaps it.
		const overlaps = (popover: Element, box: DOMRect) => {
			const rect = popover.getBoundingClientRect();
			return (
				rect.width > 0 &&
				rect.left < box.right &&
				rect.right > box.left &&
				rect.top < box.bottom &&
				rect.bottom > box.top
			);
		};
		// spec/task-window-workspace#work-area: a popover, a dialog, a toast over the page, a dragged tab or a group border being moved.
		const covered = () => {
			if (
				document.querySelector('dialog[open]') ||
				document.body.dataset.resizing === 'true' ||
				draggedTab()
			)
				return true;
			const box = element.getBoundingClientRect();
			return [
				...document.querySelectorAll(
					'[popover][data-open=true],[data-toast-id],[data-cover-native]'
				),
			].some((popover) => overlaps(popover, box));
		};
		const measure = () => {
			frame = 0;
			if (disposed) return;
			// The page fills the viewport's content box: the agent's accent frame (spec/task-window-workspace#work-area) stays visible round it.
			const rect = element.getBoundingClientRect();
			const overlay = covered();
			// Mobile: the native view is the phone's width, centred, so the margins either side are equal (spec/browser-and-simulator#browser);
			// a narrower tab keeps its whole width and the page scrolls.
			const width = mobileRef.current
					? Math.min(element.clientWidth, mobileViewport.width)
					: element.clientWidth,
				inset = Math.floor((element.clientWidth - width) / 2);
			const bounds = {
					visible: !overlay,
					x: rect.x + element.clientLeft + inset,
					y: rect.y + element.clientTop,
					width,
					height: element.clientHeight,
				},
				signature = JSON.stringify(bounds);
			if (signature === sent) return;
			sent = signature;
			shown = bounds.visible;
			void window.brigadir
				.browserCommand(task, {
					kind: 'mount',
					...bounds,
					tab,
					// spec/task-window-workspace#work-area: covered, not gone — main leaves a picture and keeps the page live.
					...(overlay ? { snapshot: true } : {}),
				})
				.then(
					(result) => {
						if (disposed) return;
						if (!overlay) setSnapshot(null);
						else if (result && typeof result === 'object' && 'image' in result)
							setSnapshot(String(result.image));
						if (result && !overlay && !mountedOnce.current) {
							mountedOnce.current = true;
							// spec/task-window-workspace#work-area: a tab the person just opened has no page yet — its address takes the focus.
							if (freshBrowserTabs.delete(tab)) address.current?.focus();
							else if (!editingAddress.current) void command({ kind: 'focus' });
						}
					},
					() => {
						if (sent === signature) sent = '';
						if (!disposed) fail('Could not show the browser.', { warning: true });
					}
				);
		};
		const update = () => {
			if (!frame && !disposed) frame = requestAnimationFrame(measure);
		};
		const observer = new ResizeObserver(update);
		observer.observe(element);
		remeasure.current = update;
		// The native view paints above every dialog: hiding it cannot wait for the next frame, or a modal opens
		// under the page. Only `open`/`data-resizing`/`data-open` changes are attribute records, so this stays off the streaming path.
		const dragging = () => update();
		window.addEventListener('dragstart', dragging);
		window.addEventListener('dragend', dragging);
		window.addEventListener('drop', dragging);
		const mutations = new MutationObserver((records) => {
			if (
				shown &&
				!disposed &&
				records.some((record) => record.type === 'attributes') &&
				covered()
			) {
				cancelAnimationFrame(frame);
				measure();
			} else update();
		});
		mutations.observe(document.body, {
			childList: true,
			subtree: true,
			attributes: true,
			attributeFilter: ['open', 'data-resizing', 'data-open', 'data-cover-native'],
		});
		window.addEventListener('resize', update);
		window.addEventListener('scroll', update, true);
		measure();
		return () => {
			disposed = true;
			remeasure.current = () => {};
			cancelAnimationFrame(frame);
			observer.disconnect();
			mutations.disconnect();
			window.removeEventListener('resize', update);
			window.removeEventListener('scroll', update, true);
			window.removeEventListener('dragstart', dragging);
			window.removeEventListener('dragend', dragging);
			window.removeEventListener('drop', dragging);
			void window.brigadir
				.browserCommand(task, {
					kind: 'mount',
					visible: false,
					x: 0,
					y: 0,
					width: 0,
					height: 0,
					tab,
				})
				.catch(() => {});
		};
	}, [task.id, task.projectId, tab]);
	useEffect(() => remeasure.current(), [mobile]);
	const machineName = useRemote((state) => state.session?.machineName) || remoteMachine?.name || '';
	// The page's first state on a device: a tab the person just opened gives its address the focus, as locally.
	const streamed = () => {
		if (mountedOnce.current) return;
		mountedOnce.current = true;
		if (freshBrowserTabs.delete(tab)) address.current?.focus();
	};
	// The modal sheet hides a toast under it: a failed hand-off closes the sheet, the toast offers to try again.
	function showDetails(value: BrowserNetworkDetails) {
		void attachTaskContext(task, {
			kind: 'text',
			name: t(locale, 'Request details'),
			text: JSON.stringify(value, null, 2),
		}).then(
			() => setDetails(null),
			() => {
				setDetails(null);
				fail('Could not show the request details to the agent.', {
					retry: () => showDetails(value),
				});
			}
		);
	}
	return (
		<section
			ref={root}
			data-browser="true"
			data-browser-tab={tab}
			data-agent={mark ?? undefined}
			className={styles.panel}
			aria-label={t(locale, 'Browser')}>
			<form
				data-size="m"
				onSubmit={(event) => {
					event.preventDefault();
					editingAddress.current = false;
					void command({ kind: 'open', url: /^https?:\/\//i.test(url) ? url : `http://${url}` });
				}}>
				<IconButton
					disabled={!event?.state.back}
					label={t(locale, 'Back')}
					onClick={() => {
						void command({ kind: 'back' });
					}}>
					<Glyph name="back" size={13} />
				</IconButton>
				<IconButton
					disabled={!event?.state.forward}
					label={t(locale, 'Forward')}
					onClick={() => {
						void command({ kind: 'forward' });
					}}>
					<Glyph name="forward" size={13} />
				</IconButton>
				<IconButton
					label={t(locale, 'Reload')}
					onClick={() => {
						void command({ kind: 'reload' });
					}}>
					<Glyph name="refresh" size={13} />
				</IconButton>
				<TextInput
					ref={address}
					className={styles.address}
					aria-label={t(locale, 'Address')}
					// spec/remote-access-and-mobile#client-ui-seam: the page lives on the working machine; its name is in the address field.
					{...(remoteMachine
						? {
								lead: (
									<MachineTag
										name={machineName}
										title={fill(locale, 'The page is open on {machine}', { machine: machineName })}
									/>
								),
							}
						: {})}
					value={addressFocused ? url : displayAddress(url)}
					onFocus={() => setAddressFocused(true)}
					onBlur={() => setAddressFocused(false)}
					onChange={(event) => {
						editingAddress.current = true;
						setUrl(event.target.value);
					}}
				/>
				{(!remoteMachine || external) && (
					<IconButton
						disabled={!external}
						label={t(locale, 'Open in default browser')}
						onClick={openExternal}
						data-browser-external>
						<Glyph name="external" size={12} />
					</IconButton>
				)}
			</form>
			<header data-size="m">
				<Button
					variant="ghost"
					aria-pressed={event?.state.picking ?? false}
					onClick={() => {
						void command({ kind: 'pick' });
					}}>
					<Glyph name="pick" size={13} />
					{t(locale, 'Select node')}
				</Button>
				<Segments
					iconOnly
					label={t(locale, 'View')}
					value={event?.state.mobile ? 'mobile' : 'desktop'}
					options={[
						{
							value: 'desktop',
							label: t(locale, 'Desktop'),
							icon: <Glyph name="desktop" size={13} />,
						},
						{
							value: 'mobile',
							label: t(locale, 'Mobile'),
							icon: <Glyph name="mobile" size={13} />,
						},
					]}
					onChange={(value) => {
						void command({ kind: 'mode', mobile: value === 'mobile' });
					}}
				/>
				<span className={styles.spacer} />
				<IconButton
					appearance={consoleErrors > 0 ? 'danger' : 'neutral'}
					variant={consoleErrors > 0 ? 'soft' : 'ghost'}
					shape={consoleErrors > 0 ? 'auto' : 'square'}
					data-errors={consoleErrors > 0}
					label={t(locale, 'Page console')}
					aria-pressed={drawer === 'console'}
					onClick={() => setDrawer((value) => (value === 'console' ? null : 'console'))}>
					<Glyph name="page-console" size={13} />
					{consoleErrors > 0 && <span>{consoleErrors}</span>}
				</IconButton>
				<IconButton
					appearance={networkErrors > 0 ? 'danger' : 'neutral'}
					variant={networkErrors > 0 ? 'soft' : 'ghost'}
					shape={networkErrors > 0 ? 'auto' : 'square'}
					data-errors={networkErrors > 0}
					label={t(locale, 'Network')}
					aria-pressed={drawer === 'network'}
					onClick={() => setDrawer((value) => (value === 'network' ? null : 'network'))}>
					<Glyph name="network" size={13} />
					{networkErrors > 0 && <span>{networkErrors}</span>}
				</IconButton>
				<Button variant="ghost" title={t(locale, 'Screenshot to chat')} onClick={screenshot}>
					<Glyph name="camera" size={13} />
					{t(locale, 'Screenshot to chat')}
				</Button>
				{/* spec/remote-access-and-mobile#client-ui-seam: in a window of another machine a local page has neither DevTools nor «Open in default
				    browser» — no empty «…». */}
				{moreEntries.length > 0 && (
					<ToolbarMore locale={locale} entries={moreEntries} width={280} />
				)}
			</header>
			{event?.state.error && <p role="alert">{event.state.error}</p>}
			{/* spec/task-window-workspace#work-area: the agent's bar while it stays with this page; the page gets the accent frame. */}
			{mark && info?.agent && (
				<div className={styles.agentBar} role="status" data-size="s" data-agent-bar={mark}>
					<Glyph name={mark === 'waiting' ? 'agent-hourglass' : 'agent-spinner'} size={12} />
					<b>
						{t(
							locale,
							mark === 'waiting' ? 'The agent is waiting until you finish' : 'Agent in the browser'
						)}
					</b>
					{(mark === 'waiting' ? info.agent.waiting : (info.agent.acting ?? info.agent.step)) && (
						<span className={styles.agentStep}>
							·{' '}
							{mark === 'waiting'
								? t(locale, 'next: {action}').replace(
										'{action}',
										agentStepText(locale, info.agent.waiting!, true)
									)
								: agentStepText(locale, (info.agent.acting ?? info.agent.step)!)}
						</span>
					)}
					<span className={styles.spacer} />
					{info.agent.count > 0 && (
						<span className={styles.agentCount}>{actionCount(locale, info.agent.count)}</span>
					)}
					{onChat && (
						<Button
							variant="ghost"
							title={t(locale, "Show the agent's actions in the chat")}
							onClick={onChat}>
							{t(locale, 'In chat')}
						</Button>
					)}
				</div>
			)}
			{/* spec/browser-and-simulator#notifications: the page asks to show notifications; only the person answers. */}
			{notifications?.asking && (
				<div className={styles.agentBar} role="status" data-size="s" data-page-ask>
					<Glyph name="bell" size={12} />
					<span className={styles.agentStep}>
						{t(locale, '{host} wants to show notifications').replace('{host}', notifications.host)}
					</span>
					<span className={styles.spacer} />
					<Button
						variant="ghost"
						onClick={() => {
							void command({ kind: 'notifications', decision: 'denied' });
						}}>
						{t(locale, 'Block')}
					</Button>
					<Button
						variant="soft"
						onClick={() => {
							void command({ kind: 'notifications', decision: 'granted' });
						}}>
						{t(locale, 'Allow')}
					</Button>
					<IconButton
						variant="soft"
						label={t(locale, 'Dismiss')}
						onClick={() => {
							void command({ kind: 'notifications', decision: 'dismiss' });
						}}>
						×
					</IconButton>
				</div>
			)}
			<div
				className={styles.viewport}
				data-agent-frame={mark ? true : undefined}
				data-mobile={mobile || undefined}
				ref={viewport}>
				{snapshot && (
					<img className={styles.snapshot} src={snapshot} alt={t(locale, 'Page snapshot')} />
				)}
				{remoteMachine && (
					<BrowserScreen
						task={task}
						tab={tab}
						locale={locale}
						machine={machineName}
						onState={streamed}
					/>
				)}
			</div>

			{drawer && (
				<div className={styles.drawer} data-size="s">
					<Rows
						position={rowPosition(positions, `browser/${drawer}`)}
						rows={event?.logs.filter((log) => log.kind === drawer) ?? []}
						estimatedHeight={34}
						label={t(locale, drawer === 'console' ? 'Page console' : 'Network')}
						render={(log) =>
							log.request ? (
								<div
									className={styles.request}
									data-size="s"
									data-error={log.error}
									title={log.text}>
									<span>{log.request.method}</span>
									<span>{log.request.status ?? '…'}</span>
									<span className={styles.path}>{log.request.url}</span>
									<span>{log.request.type}</span>
									<span>{log.request.duration === null ? '…' : `${log.request.duration} ms`}</span>
									<span>{log.request.bytes === null ? '…' : `${log.request.bytes} B`}</span>
									<Button
										size="s"
										onClick={() => {
											void command({ kind: 'network', requestId: log.id }).then((result) => {
												if (result) setDetails(result as BrowserNetworkDetails);
											});
										}}>
										{t(locale, 'Details')}
									</Button>
								</div>
							) : (
								<p data-error={log.error}>{log.text}</p>
							)
						}
					/>
					<Button
						onClick={() => {
							void attachTaskContext(task, {
								kind: 'text',
								name: t(locale, drawer === 'console' ? 'Page console' : 'Network'),
								text:
									`Browser ${drawer} (${event?.state.url}):\n` +
									(event?.logs
										.filter((log) => log.kind === drawer)
										.map((log) => log.text)
										.join('\n')
										.slice(-16000) ?? ''),
							}).catch(() => fail(showFailure(drawer)));
						}}>
						{t(locale, 'Show the agent')}
					</Button>
				</div>
			)}
			{!drawer && failure && failure.id !== dismissed && (
				<div className={styles.failure} data-size="s" role="status">
					<span>
						{t(locale, failure.kind === 'console' ? 'Page console' : 'Network')}: {failure.text}
					</span>
					<Button
						onClick={() => {
							setDrawer(failure.kind);
							void attachTaskContext(task, {
								kind: 'text',
								name: t(locale, failure.kind === 'console' ? 'Page console' : 'Network'),
								text: failure.text,
							}).catch(() => fail(showFailure(failure.kind)));
						}}>
						{t(locale, 'Show the agent')}
					</Button>
					<IconButton
						variant="soft"
						label={t(locale, 'Dismiss')}
						onClick={() => setDismissed(failure.id)}>
						×
					</IconButton>
				</div>
			)}
			{details && (
				<DocumentDialog
					title={t(locale, 'Request details')}
					locale={locale}
					close={() => setDetails(null)}
					footer={
						<Button
							onClick={() => {
								showDetails(details);
							}}>
							{t(locale, 'Show the agent')}
						</Button>
					}>
					<p>
						{details.request.method} {details.request.status} · {details.request.url}
					</p>
					<h3>{t(locale, 'Response headers')}</h3>
					<pre>{JSON.stringify(details.headers, null, 2)}</pre>
					<h3>{t(locale, 'Response body')}</h3>
					{details.error ? (
						<p role="status">{t(locale, 'Response body is unavailable.')}</p>
					) : (
						<pre>{details.body}</pre>
					)}
					{details.truncated && (
						<p className={styles.truncated}>{t(locale, 'Response body was truncated.')}</p>
					)}
				</DocumentDialog>
			)}
		</section>
	);
}
