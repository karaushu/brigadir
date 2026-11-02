import { useEffect, useRef, useState } from 'react';
import {
	commandAccelerator,
	crewAgentCountLabel,
	defaultKeymap,
	formatAccelerator,
	menuCommands,
	remoteClock,
	remoteNetworkName,
	t,
	type Locale,
	type RemoteNotice,
	type WorkspaceSnapshot,
} from '@brigadir/core';
import { Button, IconButton } from './ui/Controls';
import { Glyph } from './ui/Glyph';
import { MachineGlyph } from './ui/MachineGlyph';
import { MenuInfo, MenuItem, MenuPopover, MenuSection, MenuSeparator } from './ui/Popover';
import { notify, ToastHost } from './ui/Toast';
import {
	remoteMachine,
	setRemoteStatus,
	useRemote,
	useRemoteMachines,
	watchRemoteMachines,
} from './remote-store';
import { useWorkspace } from './store';
import type { RemoteDialog, RemotePart } from './RemoteSettings';
import {
	addressNetwork,
	fill,
	machineReach,
	networkNames,
	reachDot,
	reachShort,
} from './remote-text';
import styles from './RemoteChrome.module.css';

/** Remote access settings (spec/settings-modules-and-onboarding#module-settings-popup: Settings ▸ Modules ▸ Remote access ⚙), with a dialog or one of its two parts (spec/remote-access-and-mobile#remote-button). */
export type OpenRemoteSettings = (dialog?: RemoteDialog, part?: RemotePart) => void;
/** The list «Connect» on a machine (its password open) or on `New machine…` (spec/remote-access-and-mobile#remote-button). */
export type OpenRemoteConnect = (target: { machine?: string; pair?: boolean }) => void;

/** The paired machines with what is known of each, while the chip's menu is open (spec/remote-access-and-mobile#remote-button). */
function useMachineRows(open: boolean) {
	useEffect(() => (open ? watchRemoteMachines() : undefined), [open]);
	const machines = useRemoteMachines((state) => state.machines),
		found = useRemoteMachines((state) => state.found),
		reach = useRemoteMachines((state) => state.reach),
		sessions = useRemoteMachines((state) => state.sessions);
	return (machines ?? []).map((machine) => ({
		machine,
		reach: machineReach(machine, reach, found, sessions),
	}));
}
/** The window button's dot for the link (spec/remote-access-and-mobile#remote-button). */
const linkDot = { on: 'var(--green)', warn: 'var(--amber)', off: 'var(--fg3)' } as const;
/** «Connect to another machine… ⌥⌘O»: the chip says its shortcut the way the menu bar spells it. */
function useConnectKey(): string {
	const keymap = useWorkspace((state) => state.appearance.keymap) ?? defaultKeymap;
	const key = commandAccelerator(
		menuCommands.find((item) => item.id === 'connect')!,
		keymap
	);
	return key ? ` · ${formatAccelerator(key)}` : '';
}

/**
 * spec/remote-access-and-mobile#module-and-settings, spec/remote-access-and-mobile#remote-button, spec/appearance#evolution-redesign: the `remote` icon button in the window bar, its state a
 * dot. This machine's window shows it while access is on — its popover is this machine (access, `Add device…`) and the
 * paired machines to connect to; a window of another machine shows the same button with the link's dot (an amber spinner
 * while reconnecting), its menu where it is connected, `Disconnect` and «Go to». The machine and the link are in the
 * system hint. The bar's row decides the size: S over the sidebar, M in a toolbar (rule 16). File ▸ Connect… (⌥⌘O)
 * opens the menu through `askRemoteChip`.
 */
export function RemoteWindowChip({
	locale,
	size,
	placement = 'strip',
	openSettings,
	openConnect,
	onWidth,
}: {
	locale: Locale;
	size: 's' | 'm' | 'xl';
	/** spec/sidebar#section-rail: in the sections rail the button stands in the column and its menu opens beside it. */ placement?:
		'strip' | 'rail';
	openSettings: OpenRemoteSettings;
	openConnect: OpenRemoteConnect;
	/** The chip's width, so the toolbar moves over for it when the sidebar is gone. */ onWidth(
		width: number
	): void;
}) {
	const { status, control, session } = useRemote();
	const asked = useRemote((state) => state.chipAsked);
	const [open, setOpen] = useState(false),
		anchor = useRef<HTMLButtonElement>(null),
		box = useRef<HTMLSpanElement>(null);
	// spec/appearance#evolution-redesign: this machine's button only while access is on; File ▸ Connect… opens the list «Connect» otherwise.
	const shown = remoteMachine
		? !!session
		: !!status?.module && !!status.enabled && control?.active !== 'remote';
	const rows = useMachineRows(open && shown);
	const shortcut = useConnectKey();
	useEffect(() => {
		useRemote.setState({ chipShown: shown });
		return () => useRemote.setState({ chipShown: false });
	}, [shown]);
	useEffect(() => {
		if (asked && shown) setOpen(true);
	}, [asked]);
	useEffect(() => {
		const node = box.current;
		if (!node || placement === 'rail') {
			onWidth(0);
			return;
		}
		const observer = new ResizeObserver(() => onWidth(node.offsetWidth));
		observer.observe(node);
		return () => {
			observer.disconnect();
			onWidth(0);
		};
	}, [shown]);
	if (!shown) return null;
	const side = placement === 'rail' ? { side: 'right' as const, align: 'end' as const } : {};
	/** A paired machine in the menu: its window when open, else the list «Connect» with its password. */
	const machineItem = ({ machine, reach }: (typeof rows)[number], from: 'here' | 'window') => (
		<MenuItem
			key={machine.id}
			icon={<MachineGlyph reach={reachDot(reach)} />}
			description={reachShort(locale, reach)}
			hands
			data-remote-chip-machine={machine.name}
			onSelect={() => {
				if (reach.state === 'live' || from === 'window')
					void window.brigadir.showRemoteWindow(machine.id, true).catch(() => {});
				else openConnect({ machine: machine.id });
			}}>
			{machine.name}
		</MenuItem>
	);
	if (remoteMachine && session) {
		const name = session.machineName || remoteMachine.name;
		const lost = session.state === 'reconnecting' || session.state === 'connecting';
		// spec/remote-access-and-mobile#remote-button: green — in control, the link under 300 ms; amber — slow or taken back; grey — no link.
		const link =
			session.state !== 'connected'
				? 'off'
				: !session.active || (session.latencyMs ?? 0) > 300
					? 'warn'
					: 'on';
		const title = fill(locale, 'Remote machine {machine}', { machine: name });
		const network = session.address ? remoteNetworkName(session.address.network) : null;
		// spec/remote-access-and-mobile#remote-button: the system hint — the machine, then how it is reached: «Connected via LAN · 4 ms».
		const state = lost
			? t(locale, 'Reconnecting…')
			: session.state === 'closed'
				? t(locale, 'The connection closed.')
				: network
					? fill(locale, 'Connected via {network}', {
							network:
								session.latencyMs !== null
									? fill(locale, '{network} · {latency} ms', {
											network,
											latency: session.latencyMs,
										})
									: network,
						})
					: null;
		const taken = !lost && session.state === 'connected' && !session.active;
		const hint = [title, state, taken ? t(locale, 'Control taken back') : null]
			.filter(Boolean)
			.join('\n');
		const others = rows.filter((row) => row.machine.id !== session.machineId);
		return (
			<span
				ref={box}
				className={placement === 'rail' ? styles.railChip : styles.chip}
				data-size={size}
				data-remote-chip>
				{/* The same `remote` icon button as this machine's, the link a dot; reconnecting, an amber spinner. */}
				<IconButton
					ref={anchor}
					label={lost ? `${title} · ${t(locale, 'Reconnecting…')}` : title}
					hint={hint}
					dot={lost ? null : linkDot[link]}
					dotAt="bottom"
					lost={lost}
					aria-haspopup={lost ? undefined : 'menu'}
					aria-expanded={lost ? undefined : open}
					data-remote-link={lost ? 'lost' : link}
					onClick={() => setOpen((value) => !value)}>
					<Glyph name="remote" size={16} />
				</IconButton>
				<MenuPopover
					open={open}
					onClose={() => setOpen(false)}
					anchor={anchor}
					label={name}
					locale={locale}
					{...side}
					width={292}>
					{session.address && (
						<MenuInfo
							icon={<Glyph name="machine" size={14} />}
							description={fill(
								locale,
								session.latencyMs !== null
									? '{address} · {latency} ms · since {time}'
									: '{address} · since {time}',
								{
									address: session.address.address,
									latency: session.latencyMs ?? 0,
									time: remoteClock(locale, session.since),
								}
							)}>
							{fill(locale, 'Connected via {network}', {
								network: remoteNetworkName(session.address.network),
							})}
						</MenuInfo>
					)}
					{/* spec/remote-access-and-mobile#client-ui-seam: the folder browser of the working machine, «Add a project from <machine>». */}
					<MenuItem
						icon={<Glyph name="folder" size={14} />}
						hands
						onSelect={() => window.brigadir.dispatchWorkspaceAction('open-project')}
						data-remote-choose-folder>
						{fill(locale, 'Choose a folder on {machine}…', { machine: name })}
					</MenuItem>
					<MenuItem
						icon={<Glyph name="unlink" size={14} />}
						onSelect={() => void window.brigadir.disconnectRemoteMachine(session.machineId)}
						data-remote-disconnect>
						{t(locale, 'Disconnect')}
					</MenuItem>
					{/* spec/remote-access-and-mobile#remote-button: «Go to» — this computer's task window, this window, the other machines. */}
					<MenuSection>{t(locale, 'Go to (machines)')}</MenuSection>
					<MenuItem
						icon={<Glyph name="machine" size={14} />}
						description={t(locale, 'This machine · task window')}
						hands
						data-remote-go-home
						onSelect={() => void window.brigadir.showRemoteWindow(null, false).catch(() => {})}>
						{remoteMachine.device}
					</MenuItem>
					<MenuItem
						kind="radio"
						checked
						icon={<MachineGlyph reach="on" />}
						description={t(locale, 'This window')}
						onSelect={() => {}}>
						{name}
					</MenuItem>
					{others.map((row) => machineItem(row, 'window'))}
					<MenuItem
						icon={<Glyph name="plus" size={14} />}
						hands
						onSelect={() => void window.brigadir.showRemoteWindow(null, true).catch(() => {})}>
						{t(locale, 'New machine…')}
					</MenuItem>
				</MenuPopover>
			</span>
		);
	}
	if (!status) return null;
	const on = status.enabled;
	const connected = status.devices
		.filter((device) => device.connected)
		.map((device) => device.name);
	const here = !on
		? t(locale, 'Remote access is off')
		: connected.length
			? fill(locale, 'Port {port} · connected: {devices}', {
					port: status.port,
					devices: connected.join(', '),
				})
			: status.listening.length
				? fill(locale, 'Listening · {networks}', { networks: networkNames(status.listening) })
				: t(locale, 'Not listening');
	// spec/remote-access-and-mobile#remote-button: the button's hint leaves the port to the menu — «studio · connected: ThinkPad».
	const state = connected.length
		? fill(locale, 'connected: {devices}', { devices: connected.join(', ') })
		: here;
	// spec/appearance#evolution-redesign: with access off there is no button; File ▸ Connect… opens the list «Connect».
	if (!on) return null;
	return (
		<span
			ref={box}
			className={placement === 'rail' ? styles.railChip : styles.chip}
			data-size={size}
			data-remote-chip="idle">
			{/* spec/appearance#evolution-redesign: the icon alone, its state a dot at the glyph's bottom right; the machine in the hint. */}
			<IconButton
				ref={anchor}
				label={`${status.machineName} · ${state}`}
				hint={`${status.machineName} · ${state}\n${t(locale, 'Remote access and other machines')}${shortcut}`}
				dot={connected.length ? 'var(--green)' : 'var(--fg3)'}
				dotAt="bottom"
				aria-haspopup="menu"
				aria-expanded={open}
				data-remote-on={on}
				onClick={() => setOpen((value) => !value)}>
				<Glyph name="remote" size={16} />
			</IconButton>
			<MenuPopover
				open={open}
				onClose={() => setOpen(false)}
				anchor={anchor}
				label={t(locale, 'Machines')}
				locale={locale}
				{...side}
				width={292}>
				<MenuSection>{t(locale, 'This machine')}</MenuSection>
				<MenuItem
					kind="radio"
					checked
					icon={<Glyph name="machine" size={14} />}
					description={here}
					hands
					data-remote-chip-here
					onSelect={() => openSettings(undefined, 'this')}>
					{status.machineName}
				</MenuItem>
				{on && (
					<MenuItem
						icon={<Glyph name="plus" size={14} />}
						hands
						onSelect={() => openSettings('pair', 'this')}>
						{t(locale, 'Add device…')}
					</MenuItem>
				)}
				<MenuSection>{t(locale, 'Connect to another')}</MenuSection>
				{rows.map((row) => machineItem(row, 'here'))}
				<MenuItem
					icon={<Glyph name="plus" size={14} />}
					hands
					data-remote-chip-new
					onSelect={() => openConnect({ pair: true })}>
					{t(locale, 'New machine…')}
				</MenuItem>
				<MenuSeparator />
				<MenuItem
					icon={<Glyph name="log" size={14} />}
					hands
					data-remote-chip-settings
					onSelect={() => openSettings()}>
					{t(locale, 'Settings…')}
				</MenuItem>
				{on && (
					<MenuItem
						danger
						onSelect={() =>
							void window.brigadir
								.setRemoteAccess(false)
								.then(setRemoteStatus)
								.catch(() => {})
						}>
						{t(locale, 'Turn off remote access')}
					</MenuItem>
				)}
			</MenuPopover>
		</span>
	);
}

/**
 * spec/remote-access-and-mobile#architecture, spec/remote-access-and-mobile#module-and-settings: while a device controls the working machine, its window is under a
 * full cover — who, from where and since when, `Take back` (always wins) and `Disconnect <device>`, and what works now.
 */
export function RemoteCover({
	locale,
	workspace,
}: {
	locale: Locale;
	workspace: WorkspaceSnapshot | null;
}) {
	const { status, control } = useRemote();
	const ref = useRef<HTMLDialogElement>(null),
		take = useRef<HTMLButtonElement>(null);
	const covered = !remoteMachine && control?.active === 'remote' && !!status?.module;
	useEffect(() => {
		const dialog = ref.current;
		if (!covered || !dialog) return;
		dialog.showModal();
		// The cover itself takes focus (no ring on «Take back» before the person touches the keyboard); Tab reaches it.
		dialog.focus({ preventScroll: true });
		return () => dialog.close();
	}, [covered]);
	if (!covered || !status || !control) return null;
	const device = status.devices.find((item) => item.id === control.deviceId);
	const name = control.device ?? device?.name ?? '';
	const working = (workspace?.tasks ?? []).filter(
		(task) => task.status === 'working' && !task.crewTaskId
	);
	const projectName = (id: string) =>
		workspace?.projects.find((project) => project.id === id)?.name ?? '';
	return (
		<dialog
			ref={ref}
			className={styles.cover}
			tabIndex={-1}
			aria-label={fill(locale, 'Controlled from {device}', { device: name })}
			data-remote-cover
			onCancel={(event) => event.preventDefault()}>
			<div className={styles.drag} />
			<div className={styles.card}>
				<span className={styles.coverIcon}>
					<Glyph name="remote" size={26} />
				</span>
				<h1>{fill(locale, 'Controlled from {device}', { device: name })}</h1>
				<p>
					{fill(
						locale,
						'Since {time} · {address} · {network}. Agents, terminals, browser and simulator work here; {device} controls them.',
						{
							time: remoteClock(locale, device?.lastLoginAt ?? null),
							address: device?.lastAddress?.address ?? '',
							network: device?.lastAddress ? remoteNetworkName(device.lastAddress.network) : '',
							device: name,
						}
					)}
				</p>
				<div className={styles.acts} data-size="l">
					<Button
						ref={take}
						appearance="primary"
						onClick={() => void window.brigadir.takeRemoteControl().catch(() => {})}
						data-remote-take-back>
						{t(locale, 'Take back')}
					</Button>
					{control.deviceId && (
						<Button
							data-remote-drop
							onClick={() =>
								void window.brigadir
									.disconnectRemoteDevice(control.deviceId!)
									.then(setRemoteStatus)
									.catch(() => {})
							}>
							{fill(locale, 'Disconnect {device}', { device: name })}
						</Button>
					)}
				</div>
				{working.length > 0 && (
					<div className={styles.runs}>
						<span>{t(locale, 'Working now (cover)')}</span>
						{working.slice(0, 5).map((task) => (
							<span key={`${task.projectId}/${task.id}`}>
								<b>{task.title}</b> ·{' '}
								{task.crew
									? crewAgentCountLabel(
											locale,
											(workspace?.tasks ?? []).filter((item) => item.crewTaskId === task.id).length
										)
									: projectName(task.projectId)}
							</span>
						))}
					</div>
				)}
			</div>
			{/* The connection's toast shows over the cover. */}
			<ToastHost locale={locale} over />
		</dialog>
	);
}

/**
 * spec/remote-access-and-mobile#module-and-settings: a window of another machine while the link is lost (content dimmed, read-only), after
 * the machine took control back (`Take control again` / `Disconnect`), and once the machine closed the connection.
 */
export function RemoteWindowState({ locale, part }: { locale: Locale; part: 'dim' | 'card' }) {
	const session = useRemote((state) => state.session);
	if (!remoteMachine || !session) return null;
	const name = session.machineName || remoteMachine.name;
	if (part === 'dim')
		return session.state === 'reconnecting' ? (
			<div className={styles.dim} data-remote-lost aria-hidden="true" />
		) : null;
	if (session.state === 'reconnecting') return null;
	if (session.state === 'connected' && session.active) return null;
	if (session.state === 'connecting') return null;
	const closed = session.state === 'closed';
	const reason = session.closedReason;
	const text = !closed
		? fill(locale, 'Someone pressed «Take back» at {machine}. The agents keep working.', {
				machine: name,
			})
		: fill(
				locale,
				reason === 'revoked'
					? 'This device was revoked on {machine}.'
					: reason === 'off'
						? 'Remote access was turned off on {machine}.'
						: reason === 'password-changed'
							? 'The password changed on {machine}. Connect with the new one.'
							: reason === 'expired'
								? 'The connection was lost for too long. Connect again.'
								: reason === 'replaced'
									? 'This device connected to {machine} again elsewhere.'
									: reason === 'dropped'
										? '{machine} disconnected this device.'
										: 'The connection closed.',
				{ machine: name }
			);
	return (
		<div className={styles.taken} data-remote-state={closed ? 'closed' : 'taken'}>
			<div className={styles.takenCard} role="alertdialog" aria-labelledby="remote-state-title">
				<b id="remote-state-title">
					{fill(
						locale,
						closed ? 'The connection to {machine} closed' : 'Control was taken back on {machine}',
						{ machine: name }
					)}
				</b>
				<span>{text}</span>
				<div className={styles.takenActions} data-size="m">
					{!closed && (
						<Button
							appearance="primary"
							onClick={() => void window.brigadir.takeRemoteControl().catch(() => {})}
							data-remote-take-again>
							{t(locale, 'Take control again')}
						</Button>
					)}
					<Button
						appearance={closed ? 'primary' : 'neutral'}
						onClick={() => void window.brigadir.disconnectRemoteMachine(session.machineId)}>
						{t(locale, closed ? 'Close window' : 'Disconnect')}
					</Button>
				</div>
			</div>
		</div>
	);
}

/** spec/remote-access-and-mobile#module-and-settings: the gateway's notices as toasts spec/notifications-slack-notes-and-schedules#message-classes on the working machine; refused at TLS stays in the log. */
export function remoteNoticeToast(
	locale: Locale,
	notice: RemoteNotice,
	openSettings: OpenRemoteSettings
) {
	const device = notice.device ?? '—';
	const where = notice.address
		? `${notice.address} · ${addressNetwork(notice.address, notice.network)}`
		: '';
	if (notice.kind === 'connected')
		notify('info', fill(locale, '{device} connected · {address}', { device, address: where }), {
			bold: device,
		});
	if (notice.kind === 'failed')
		notify(
			'warning',
			fill(locale, '{device}: wrong password · {address}', { device, address: where }),
			{
				bold: device,
				action: { label: t(locale, 'Log (remote access)'), run: () => openSettings('journal') },
			}
		);
	if (notice.kind === 'blocked')
		notify('error', fill(locale, '{device} is blocked after 10 wrong passwords.', { device }), {
			bold: device,
			action: { label: t(locale, 'Unblock…'), run: () => openSettings() },
		});
	if (notice.kind === 'paired')
		notify('success', fill(locale, '{device} paired. Connect with the password.', { device }), {
			bold: device,
		});
}
