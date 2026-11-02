import { useEffect, useRef, useState } from 'react';
import {
	isMachineName,
	isMessageKey,
	remotePasswordMin,
	revokeAllText,
	t,
	type Locale,
	type RemoteAccessStatus,
	type RemoteAuditEntry,
	type PairedMachine,
	type RemoteDevice,
} from '@brigadir/core';
import { Button, IconButton, Segments, Switch } from './ui/Controls';
import { TextInput } from './ui/Input';
import { Glyph } from './ui/Glyph';
import { ConfirmDialog } from './ui/ConfirmDialog';
import { ModalDialog } from './ui/ModalDialog';
import { SettingsSection, SettingsRow } from './SettingsForm';
import { RemotePair } from './RemotePair';
import { RemoteFacts, RemoteScheme, TailscaleLink } from './RemoteOverview';
import { WebLink } from './ui/WebLink';
import {
	reloadRemoteMachines,
	remoteMachine,
	setRemoteStatus,
	useRemoteMachines,
	watchRemoteMachines,
} from './remote-store';
import {
	addressNetwork,
	auditEvents,
	deviceLine,
	fill,
	listeningParts,
	machineReach,
	reachDot,
	reachLine,
	rich,
} from './remote-text';
import { MachineGlyph } from './ui/MachineGlyph';
import { RemoteConnect } from './RemoteConnect';
import { characterCount, remoteClock, remoteMoment } from '@brigadir/core';
import styles from './RemoteSettings.module.css';

export type RemoteDialog = 'pair' | 'journal' | 'password';

/**
 * spec/remote-access-and-mobile#module-and-settings: Settings ▸ Remote on the working machine — the switch (a password the first time), where the gateway
 * listens, the machine's name, `Change password…`, the devices with `Revoke` / `Unblock`, `Add device`, `Revoke all` and
 * the log. Opened from a device it is read-only (`editable: false`, spec/remote-access-and-mobile#architecture).
 */
export type RemotePart = 'this' | 'other';
/** The part the tab opened on last, until the app quits (spec/remote-access-and-mobile#remote-button). */
let lastPart: RemotePart = 'this';

/**
 * spec/remote-access-and-mobile#remote-button: two parts under a switch at the top — `To this machine` (everything below) and `Connect to another · N`,
 * the paired machines this computer connects to. A window of another machine shows only the first, read-only.
 */
export function RemoteSettings({
	locale,
	open,
	paired,
	part: initialPart,
}: {
	locale: Locale;
	open?: RemoteDialog | undefined;
	paired?: string | undefined;
	part?: RemotePart | undefined;
}) {
	const [part, setPart] = useState<RemotePart>(open ? 'this' : (initialPart ?? lastPart));
	const machines = useRemoteMachines((state) => state.machines);
	useEffect(() => {
		if (!remoteMachine) void reloadRemoteMachines();
	}, []);
	if (remoteMachine) return <ThisMachine locale={locale} open={open} paired={paired} />;
	return (
		<>
			<div className={styles.parts} data-size="m">
				<Segments
					tablist
					tabs
					label={t(locale, 'Remote')}
					value={part}
					onChange={(value) => {
						lastPart = value as RemotePart;
						setPart(lastPart);
					}}
					options={[
						{ value: 'this', label: t(locale, 'To this machine') },
						{
							value: 'other',
							label: t(locale, 'Connect to another'),
							...(machines?.length ? { tail: String(machines.length) } : {}),
						},
					]}
				/>
			</div>
			{part === 'this' ? (
				<ThisMachine locale={locale} open={open} paired={paired} />
			) : (
				<OtherMachines locale={locale} />
			)}
		</>
	);
}

/** Settings ▸ Remote ▸ To this machine: the working machine's side (spec/remote-access-and-mobile#module-and-settings, spec/settings-modules-and-onboarding#intro-remote). */
function ThisMachine({
	locale,
	open,
	paired,
}: {
	locale: Locale;
	/** A dialog to open with the tab (the window chip's menu, a toast). */ open?:
		RemoteDialog | undefined;
	/** The device paired a moment ago: its row is lit for 3 s. */ paired?: string | undefined;
}) {
	const [status, setStatus] = useState<RemoteAccessStatus | null>(null),
		[busy, setBusy] = useState(false),
		[error, setError] = useState(''),
		[enabling, setEnabling] = useState(false),
		[dialog, setDialog] = useState<RemoteDialog | 'revoke-all' | null>(open ?? null),
		[fresh, setFresh] = useState<string | null>(paired ?? null);
	const mounted = useRef(true);
	useEffect(() => {
		mounted.current = true;
		const stop = window.brigadir.onRemoteStatus((value) => {
			if (mounted.current) setStatus(value);
		});
		void window.brigadir
			.readRemoteAccess()
			.then((value) => {
				if (mounted.current) setStatus(value);
			})
			.catch(() => {
				if (mounted.current) setError(t(locale, 'Could not change remote access.'));
			});
		return () => {
			mounted.current = false;
			stop();
		};
	}, []);
	useEffect(() => {
		if (!fresh) return;
		const timer = setTimeout(() => setFresh(null), 3000);
		return () => clearTimeout(timer);
	}, [fresh]);
	async function run(action: () => Promise<RemoteAccessStatus | void>) {
		setBusy(true);
		setError('');
		try {
			const value = await action();
			if (value && mounted.current) {
				setStatus(value);
				setRemoteStatus(value);
			}
			return true;
		} catch {
			if (mounted.current) setError(t(locale, 'Could not change remote access.'));
			return false;
		} finally {
			if (mounted.current) setBusy(false);
		}
	}
	if (!status) return error ? <p className={styles.error}>{error}</p> : null;
	const editable = status.editable;
	const on = status.enabled;
	// The device paired a moment ago: the newest one of that name (a device paired again keeps its name).
	const freshId = fresh
		? [...status.devices]
				.filter((device) => device.name === fresh)
				.sort((a, b) => b.pairedAt.localeCompare(a.pairedAt))[0]?.id
		: undefined;
	const controller = status.control.active === 'remote' ? status.control.deviceId : null;
	const deviceRows = (actions: boolean) =>
		status.devices.map((device) => (
			<DeviceRow
				key={device.id}
				device={device}
				locale={locale}
				live={device.id === controller}
				fresh={device.id === freshId}
				action={
					!actions ? null : device.blocked ? (
						<Button
							size="s"
							variant="ghost"
							disabled={busy}
							onClick={() => void run(() => window.brigadir.unblockRemoteDevice(device.id))}>
							{t(locale, 'Unblock')}
						</Button>
					) : (
						<Button
							size="s"
							variant="ghost"
							appearance="danger"
							disabled={busy}
							onClick={() => void run(() => window.brigadir.revokeRemoteDevice(device.id))}>
							{t(locale, 'Revoke')}
						</Button>
					)
				}
			/>
		));
	const statusLines = (
		<>
			<span className={styles.status} data-remote-status>
				<span className={styles.dot} data-on={status.listening.length > 0} />
				{status.listening.length ? (
					<span>
						{t(locale, 'Listening · {networks}').replace('{networks}', '')}
						{listeningParts(status.listening, styles.mono!)}
					</span>
				) : (
					<span className={styles.warn}>
						{status.error
							? fill(locale, 'Not listening: {error}', {
									error: isMessageKey(status.error) ? t(locale, status.error) : status.error,
								})
							: t(locale, 'Not listening: no LAN or Tailscale network.')}
					</span>
				)}
			</span>
			<small>
				{fill(locale, 'Port {port}. No port forwarding on the router.', { port: status.port })}
			</small>
		</>
	);
	// spec/settings-modules-and-onboarding#intro-remote: the intro's sentence, scheme and facts over the controls on the working machine.
	const overview = (
		<section className={styles.overview} data-remote-overview>
			<p>
				{t(
					locale,
					'Control this machine from Brigadir on another computer: tasks, terminal, browser and simulator run here.'
				)}
			</p>
			<RemoteScheme locale={locale} machine={status.machineName} on={on} />
			<RemoteFacts locale={locale} />
		</section>
	);
	// —— a device's window: read-only (spec/remote-access-and-mobile#architecture) ——
	if (!editable)
		return (
			<>
				<div className={styles.note} data-remote-readonly>
					<Glyph name="scope-lock" size={14} />
					<span>
						{rich(
							fill(
								locale,
								'Remote access changes only on **{machine}** itself: the name, password, devices and switch are not available from here.',
								{ machine: status.machineName }
							)
						)}
					</span>
				</div>
				<SettingsSection title={t(locale, 'Remote access')}>
					<SettingsRow label={t(locale, 'Remote access')}>
						<span className={styles.inline} data-inactive data-lines>
							<Switch
								label={t(locale, 'Allow control from other devices')}
								checked={on}
								disabled
								onChange={() => {}}
							/>
							<span>{t(locale, 'Allow control from other devices')}</span>
						</span>
						{on && statusLines}
					</SettingsRow>
					<SettingsRow label={t(locale, 'Name')}>
						<b className={styles.name}>{status.machineName}</b>
					</SettingsRow>
				</SettingsSection>
				{status.devices.length > 0 && (
					<SettingsSection title={t(locale, 'Devices')}>{deviceRows(false)}</SettingsSection>
				)}
			</>
		);
	// —— off ——
	if (!on && !enabling)
		return (
			<>
				{overview}
				<SettingsSection>
					<SettingsRow
						label={t(locale, 'Remote access')}
						hint={t(locale, 'Needs a password and a one-time pairing of each device.')}>
						<label className={styles.inline}>
							<Switch
								label={t(locale, 'Allow control from other devices')}
								checked={false}
								disabled={busy}
								onChange={() => {
									if (status.passwordSet) void run(() => window.brigadir.setRemoteAccess(true));
									else setEnabling(true);
								}}
							/>
							<span>{t(locale, 'Allow control from other devices')}</span>
						</label>
					</SettingsRow>
				</SettingsSection>
				{error && <p className={styles.error}>{error}</p>}
			</>
		);
	// —— turning on: the password and its repeat ——
	if (!on)
		return (
			<>
				{overview}
				<EnableForm
					locale={locale}
					busy={busy}
					cancel={() => setEnabling(false)}
					submit={async (password) => {
						if (await run(() => window.brigadir.setRemoteAccess(true, password)))
							setEnabling(false);
					}}
				/>
				{error && <p className={styles.error}>{error}</p>}
			</>
		);
	// —— on ——
	return (
		<>
			{overview}
			<SettingsSection title={t(locale, 'Remote access')}>
				<SettingsRow label={t(locale, 'Remote access')}>
					<label className={styles.inline} data-lines>
						<Switch
							label={t(locale, 'Allow control from other devices')}
							checked
							disabled={busy}
							onChange={() => void run(() => window.brigadir.setRemoteAccess(false))}
						/>
						<span>{t(locale, 'Allow control from other devices')}</span>
					</label>
					{statusLines}
				</SettingsRow>
				<NameRow
					locale={locale}
					name={status.machineName}
					system={status.defaultName}
					busy={busy}
					rename={(name) => run(() => window.brigadir.renameRemoteMachine(name))}
				/>
				<SettingsRow label={t(locale, 'Password')}>
					<Button size="s" disabled={busy} onClick={() => setDialog('password')}>
						{t(locale, 'Change password…')}
					</Button>
				</SettingsRow>
			</SettingsSection>
			<PhoneSection
				locale={locale}
				phone={status.phone}
				paired={status.devices.some((device) => device.kind === 'phone')}
				busy={busy}
				run={run}
			/>
			<SettingsSection
				title={t(locale, 'Devices')}
				footnote={
					<>
						<span className={styles.footText}>
							{t(locale, 'A device with no sign-in for 30 days is revoked by itself.')}
						</span>
						<span className={styles.linkSlot}>
							<button
								type="button"
								className={styles.link}
								data-remote-log
								onClick={() => setDialog('journal')}>
								<Glyph name="log" size={14} />
								{t(locale, 'Log (remote access)')}
							</button>
						</span>
					</>
				}>
				{deviceRows(true)}
				<div className={styles.actions} data-size="s">
					<Button size="s" disabled={busy} onClick={() => setDialog('pair')} data-remote-add>
						<Glyph name="plus" size={14} />
						{t(locale, 'Add device')}
					</Button>
					<Button
						size="s"
						variant="ghost"
						appearance="danger"
						disabled={busy || status.devices.length === 0}
						onClick={() => setDialog('revoke-all')}>
						{t(locale, 'Revoke all')}
					</Button>
				</div>
			</SettingsSection>
			{error && <p className={styles.error}>{error}</p>}
			{dialog === 'password' && (
				<PasswordDialog
					locale={locale}
					close={() => setDialog(null)}
					save={async (password) => {
						if (await run(() => window.brigadir.setRemotePassword(password))) setDialog(null);
					}}
				/>
			)}
			{dialog === 'journal' && <JournalDialog locale={locale} close={() => setDialog(null)} />}
			{dialog === 'revoke-all' && (
				<ConfirmDialog
					title={t(locale, 'Revoke all devices?')}
					locale={locale}
					action={t(locale, 'Revoke all')}
					danger
					error={t(locale, 'Could not change remote access.')}
					cancel={() => setDialog(null)}
					confirm={async () => {
						const value = await window.brigadir.revokeAllRemoteDevices();
						setStatus(value);
						setRemoteStatus(value);
						setDialog(null);
					}}>
					<p>{revokeAllText(locale, status.devices.length)}</p>
				</ConfirmDialog>
			)}
			{dialog === 'pair' && (
				<RemotePair
					locale={locale}
					machine={status.machineName}
					close={(device) => {
						setDialog(null);
						if (device) setFresh(device);
					}}
				/>
			)}
		</>
	);
}

function DeviceRow({
	device,
	locale,
	live,
	fresh,
	action,
}: {
	device: RemoteDevice;
	locale: Locale;
	live: boolean;
	fresh: boolean;
	action: React.ReactNode;
}) {
	return (
		<PeerRow
			name={device.name}
			line={deviceLine(locale, device)}
			warning={device.blocked}
			glyph="laptop"
			badge={live ? t(locale, 'controls now') : null}
			fresh={fresh}
			action={action}
			data-remote-device={device.name}
		/>
	);
}
/** A paired computer in a list of the tab: a device on the working machine, a machine on the client (spec/remote-access-and-mobile#identity-and-keys). */
function PeerRow({
	name,
	line,
	warning = false,
	glyph,
	reach,
	badge = null,
	fresh = false,
	action,
	onOpen,
	...data
}: {
	name: string;
	line: string;
	warning?: boolean;
	glyph: 'laptop' | 'machine';
	/** spec/remote-access-and-mobile#remote-button: a machine's reach on its glyph. */ reach?:
		'on' | 'off' | 'check' | undefined;
	badge?: string | null;
	fresh?: boolean;
	action: React.ReactNode;
	/** The row's own action (a machine's `Connect` / `Show window`): the whole row takes it, its buttons stay above. */ onOpen?:
		(() => void) | undefined;
} & { [key: `data-${string}`]: string | undefined }) {
	return (
		<div
			{...data}
			className={styles.device}
			data-size="s"
			data-fresh={fresh || undefined}
			data-opens={onOpen ? true : undefined}
			onClick={
				onOpen
					? (event) => {
							if (!(event.target as HTMLElement).closest('button')) onOpen();
						}
					: undefined
			}>
			<MachineGlyph tile glyph={glyph} reach={reach} />
			<span className={styles.two}>
				<b>
					{name}
					{badge && <span className={styles.live}>{badge}</span>}
				</b>
				<small data-warning={warning || undefined}>{line}</small>
			</span>
			{action}
		</div>
	);
}

/**
 * spec/remote-access-and-mobile#remote-button (canvas WSetMachines…WSetForget): Settings ▸ Remote ▸ Connect to another — the paired machines with their
 * reach (checked while the part is open), `Connect` / `Show window`, `Forget` / `Disconnect`, `New machine…`.
 */
function OtherMachines({ locale }: { locale: Locale }) {
	useEffect(() => watchRemoteMachines(), []);
	const machines = useRemoteMachines((state) => state.machines),
		found = useRemoteMachines((state) => state.found),
		reach = useRemoteMachines((state) => state.reach),
		sessions = useRemoteMachines((state) => state.sessions);
	const [connect, setConnect] = useState<{ machine?: string; pair?: boolean } | null>(null),
		[forget, setForget] = useState<PairedMachine | null>(null);
	if (!machines) return null;
	const intro = (
		<p className={styles.partIntro}>
			{t(
				locale,
				'Control Brigadir on another computer from this window. A machine is paired once with a code, and you sign in with the password set on it.'
			)}
		</p>
	);
	const newMachine = (size: 's' | 'm') => (
		<Button size={size} onClick={() => setConnect({ pair: true })} data-remote-new-machine>
			<Glyph name="plus" size={14} />
			{t(locale, 'New machine…')}
		</Button>
	);
	return (
		<>
			{intro}
			{machines.length ? (
				<SettingsSection
					title={t(locale, 'Machines')}
					footnote={
						<span>
							{t(locale, 'Outside home both computers need Tailscale.')}{' '}
							<TailscaleLink locale={locale} />
						</span>
					}>
					{machines.map((machine) => {
						const state = machineReach(machine, reach, found, sessions),
							live = state.state === 'live';
						const open = () =>
							live
								? void window.brigadir.showRemoteWindow(machine.id, false).catch(() => {})
								: setConnect({ machine: machine.id });
						return (
							<PeerRow
								key={machine.id}
								name={machine.name}
								line={reachLine(locale, machine, state)}
								glyph="machine"
								reach={state.state === 'check' ? 'check' : reachDot(state)}
								badge={live ? t(locale, 'window open (machine)') : null}
								onOpen={open}
								data-remote-peer={machine.name}
								data-remote-reach={state.state}
								action={
									<span className={styles.peerActions}>
										<Button size="s" onClick={open} data-remote-peer-open>
											{t(locale, live ? 'Show window' : 'Connect')}
										</Button>
										{live ? (
											<Button
												size="s"
												variant="ghost"
												onClick={() =>
													void window.brigadir.disconnectRemoteMachine(machine.id).catch(() => {})
												}>
												{t(locale, 'Disconnect')}
											</Button>
										) : (
											<Button
												size="s"
												variant="ghost"
												appearance="danger"
												onClick={() => setForget(machine)}
												data-remote-peer-forget>
												{t(locale, 'Forget')}
											</Button>
										)}
									</span>
								}
							/>
						);
					})}
					<div className={styles.actions} data-size="s">
						{newMachine('s')}
					</div>
				</SettingsSection>
			) : (
				<SettingsSection title={t(locale, 'Machines')}>
					<div className={styles.empty} data-size="m" data-remote-no-machines>
						<MachineGlyph tile dashed />
						<span className={styles.two}>
							<b>{t(locale, 'No paired machines yet')}</b>
							<small className={styles.wrap}>
								{t(
									locale,
									'On the other machine turn on remote access and press «Add device»: it shows a code.'
								)}
							</small>
						</span>
						{newMachine('m')}
					</div>
				</SettingsSection>
			)}
			{connect && (
				<RemoteConnect
					locale={locale}
					machine={connect.machine}
					pair={connect.pair}
					close={() => {
						setConnect(null);
						void reloadRemoteMachines();
					}}
				/>
			)}
			{forget && (
				<ConfirmDialog
					title={fill(locale, 'Forget {machine}?', { machine: forget.name })}
					locale={locale}
					action={t(locale, 'Forget')}
					danger
					error={t(locale, 'Could not forget the machine.')}
					cancel={() => setForget(null)}
					confirm={async () => {
						await window.brigadir.forgetRemoteMachine(forget.id);
						setForget(null);
						await reloadRemoteMachines();
					}}>
					<p>
						{fill(locale, 'To connect to {machine} again, pair with it again.', {
							machine: forget.name,
						})}
					</p>
				</ConfirmDialog>
			)}
		</>
	);
}

function NameRow({
	locale,
	name,
	system,
	busy,
	rename,
	label,
	about,
}: {
	locale: Locale;
	name: string;
	system: string;
	busy: boolean;
	rename(name: string | null): Promise<boolean>;
	/** The client names this computer, not a machine (spec/remote-access-and-mobile#identity-and-keys). */ label?: string;
	about?: string;
}) {
	const [draft, setDraft] = useState(name),
		[focused, setFocused] = useState(false),
		input = useRef<HTMLInputElement>(null),
		cancelled = useRef(false);
	useEffect(() => {
		if (!focused) setDraft(name);
	}, [name, focused]);
	const value = draft.trim(),
		invalid = !value || !isMachineName(value);
	const save = async () => {
		if (invalid || value === name) return;
		await rename(value === system ? null : value);
	};
	return (
		<SettingsRow
			label={t(locale, 'Name')}
			warning={false}
			hint={
				<span className={invalid ? styles.errorText : undefined}>
					{invalid
						? t(locale, 'The name cannot be empty.')
						: (about ??
							t(
								locale,
								'Other devices see this machine by this name. By default, the system name.'
							))}
				</span>
			}>
			<TextInput
				ref={input}
				size="s"
				className={styles.nameField}
				aria-label={label ?? t(locale, 'Machine name')}
				aria-invalid={invalid}
				maxLength={64}
				value={draft}
				disabled={busy}
				placeholder={system}
				onFocus={() => setFocused(true)}
				onBlur={() => {
					setFocused(false);
					if (cancelled.current) cancelled.current = false;
					else if (!invalid) void save();
					else setDraft(name);
				}}
				onChange={(event) => setDraft(event.target.value)}
				onKeyDown={(event) => {
					if (event.key === 'Enter') {
						event.preventDefault();
						if (!invalid) void save().then(() => input.current?.blur());
					}
					if (event.key === 'Escape') {
						// Esc gives the old name back; the Settings dialog stays open.
						event.preventDefault();
						event.stopPropagation();
						cancelled.current = true;
						setDraft(name);
						input.current?.blur();
					}
				}}
			/>
		</SettingsRow>
	);
}

function EnableForm({
	locale,
	busy,
	cancel,
	submit,
}: {
	locale: Locale;
	busy: boolean;
	cancel(): void;
	submit(password: string): Promise<void>;
}) {
	const [password, setPassword] = useState(''),
		[again, setAgain] = useState(''),
		first = useRef<HTMLInputElement>(null);
	useEffect(() => first.current?.focus(), []);
	const long = [...password].length >= remotePasswordMin,
		mismatch = again.length > 0 && again.length >= password.length && again !== password,
		ready = long && again === password && !busy;
	const go = () => {
		if (ready) void submit(password);
	};
	return (
		<SettingsSection title={t(locale, 'Remote access')}>
			<SettingsRow label={t(locale, 'Remote access')}>
				<span className={styles.inline}>
					<Switch
						label={t(locale, 'Allow control from other devices')}
						checked
						disabled={busy}
						onChange={cancel}
					/>
					<span>{t(locale, 'Allow control from other devices')}</span>
				</span>
			</SettingsRow>
			<SettingsRow
				label={t(locale, 'Password')}
				hint={fill(locale, 'At least 10 characters · now {count}', {
					count: [...password].length,
				})}>
				<TextInput
					ref={first}
					type="password"
					size="m"
					className={styles.passwordField}
					aria-label={t(locale, 'Password')}
					autoComplete="new-password"
					value={password}
					onChange={(event) => setPassword(event.target.value)}
					onKeyDown={(event) => {
						if (event.key === 'Enter') go();
					}}
				/>
			</SettingsRow>
			<SettingsRow
				label={t(locale, 'Again (password)')}
				hint={
					mismatch ? (
						<span className={styles.errorText}>{t(locale, 'The passwords do not match.')}</span>
					) : undefined
				}>
				<TextInput
					type="password"
					size="m"
					className={styles.passwordField}
					aria-label={t(locale, 'Repeat the password')}
					aria-invalid={mismatch}
					placeholder={t(locale, 'Repeat the password')}
					autoComplete="new-password"
					value={again}
					onChange={(event) => setAgain(event.target.value)}
					onKeyDown={(event) => {
						if (event.key === 'Enter') go();
					}}
				/>
			</SettingsRow>
			<div className={styles.formActions} data-size="m">
				<Button disabled={busy} onClick={cancel}>
					{t(locale, 'Cancel')}
				</Button>
				<Button appearance="primary" disabled={!ready} onClick={go} data-remote-enable>
					{t(locale, 'Turn on')}
				</Button>
			</div>
		</SettingsSection>
	);
}

function PasswordDialog({
	locale,
	close,
	save,
}: {
	locale: Locale;
	close(): void;
	save(password: string): Promise<void>;
}) {
	const [password, setPassword] = useState(''),
		[again, setAgain] = useState(''),
		[busy, setBusy] = useState(false),
		first = useRef<HTMLInputElement>(null);
	const count = [...password].length,
		mismatch = again.length > 0 && again.length >= password.length && again !== password,
		ready = count >= remotePasswordMin && again === password && !busy;
	const go = async () => {
		if (!ready) return;
		setBusy(true);
		await save(password);
		setBusy(false);
	};
	return (
		<ModalDialog
			title={t(locale, 'Change password')}
			locale={locale}
			close={close}
			width={420}
			top={170}
			initialFocus={first}
			data-remote-password
			footer={
				<>
					<Button onClick={close}>{t(locale, 'Cancel')}</Button>
					<Button appearance="primary" disabled={!ready} onClick={() => void go()}>
						{t(locale, 'Change (password)')}
					</Button>
				</>
			}>
			<span className={styles.label}>{t(locale, 'New password')}</span>
			<div className={styles.fieldRow} data-size="m">
				<TextInput
					ref={first}
					type="password"
					aria-label={t(locale, 'New password')}
					autoComplete="new-password"
					value={password}
					tail={count > 0 ? characterCount(locale, count) : ''}
					onChange={(event) => setPassword(event.target.value)}
					onKeyDown={(event) => {
						if (event.key === 'Enter') void go();
					}}
				/>
			</div>
			<span className={styles.label} data-gap>
				{t(locale, 'Again (password)')}
			</span>
			<div className={styles.fieldRow} data-size="m">
				<TextInput
					type="password"
					aria-label={t(locale, 'Repeat the password')}
					aria-invalid={mismatch}
					placeholder={t(locale, 'Repeat the password')}
					autoComplete="new-password"
					value={again}
					onChange={(event) => setAgain(event.target.value)}
					onKeyDown={(event) => {
						if (event.key === 'Enter') void go();
					}}
				/>
			</div>
			<p className={mismatch ? styles.hintError : styles.hint}>
				{mismatch
					? t(locale, 'The passwords do not match.')
					: t(
							locale,
							'At least 10 characters. Kept only as a hash; devices stay paired. Current connections are dropped, the next one asks for the new password.'
						)}
			</p>
		</ModalDialog>
	);
}

function JournalDialog({ locale, close }: { locale: Locale; close(): void }) {
	const [entries, setEntries] = useState<RemoteAuditEntry[] | null>(null),
		[failed, setFailed] = useState(false);
	useEffect(() => {
		void window.brigadir
			.readRemoteAudit(200)
			.then(setEntries)
			.catch(() => setFailed(true));
	}, []);
	const now = Date.now();
	const when = (iso: string) => {
		const moment = remoteMoment(locale, iso, now);
		return moment.startsWith(locale === 'uk' ? 'сьогодні' : 'today')
			? remoteClock(locale, iso)
			: moment.startsWith(locale === 'uk' ? 'вчора' : 'yesterday')
				? t(locale, 'Yesterday')
				: moment.replace(/ (о|at) .*$/, '');
	};
	return (
		<ModalDialog
			title={t(locale, 'Remote access log')}
			locale={locale}
			close={close}
			width={560}
			top={100}
			data-remote-journal
			footer={
				// spec/remote-access-and-mobile#architecture: the file manager of the working machine never opens for a device.
				remoteMachine ? undefined : (
					<Button onClick={() => void window.brigadir.revealRemoteAudit().catch(() => {})}>
						{t(locale, 'Reveal in Finder')}
					</Button>
				)
			}>
			{failed ? (
				<p className={styles.hintError}>{t(locale, 'Could not read the log.')}</p>
			) : entries && entries.length === 0 ? (
				<p className={styles.hint}>{t(locale, 'The log is empty.')}</p>
			) : (
				<div className={styles.journalScroll}>
					<table className={styles.journal}>
						<thead>
							<tr>
								<th>{t(locale, 'Time')}</th>
								<th>{t(locale, 'Device')}</th>
								<th>{t(locale, 'Event')}</th>
								<th>{t(locale, 'Address')}</th>
							</tr>
						</thead>
						<tbody>
							{(entries ?? []).map((entry, index) => {
								const event = auditEvents[entry.kind];
								return (
									<tr key={`${entry.at}-${index}`}>
										<td className={styles.mono}>{when(entry.at)}</td>
										<td>{entry.device ?? '—'}</td>
										<td data-tone={event.tone}>{t(locale, event.key)}</td>
										<td className={styles.mono}>
											{entry.address
												? `${entry.address} · ${addressNetwork(entry.address, entry.network)}`
												: '—'}
										</td>
									</tr>
								);
							})}
						</tbody>
					</table>
				</div>
			)}
			<p className={styles.hint}>
				{t(
					locale,
					'Who, when and from where: pairing, sign-ins, failed tries (and those refused at TLS), revocation, blocking. File:'
				)}
				<br />
				<span className={styles.mono}>~/.brigadir/remote/audit.jsonl</span>
			</p>
		</ModalDialog>
	);
}

/**
 * spec/remote-access-and-mobile#phone, spec/remote-access-and-mobile#phone-network, spec/remote-access-and-mobile#phone-app: the phone on the working machine — the switch of the web listener, its address in the
 * tailnet, the one `tailscale serve` command it needs, and why it does not listen (no Tailscale, Funnel on that name, another
 * service under the same name). The machine's name goes into public certificate logs: said under the switch.
 */
function phoneError(locale: Locale, error: string, host: string | null): string {
	const shared =
		/^Another service shares https:\/\/(.+) through tailscale serve; give it another port\.$/.exec(
			error
		);
	if (shared)
		return fill(
			locale,
			'Another service shares https://{host} through tailscale serve; give it another port.',
			{ host: shared[1]! }
		);
	return isMessageKey(error) ? t(locale, error) : error;
}
function PhoneSection({
	locale,
	phone,
	paired,
	busy,
	run,
}: {
	locale: Locale;
	phone: RemoteAccessStatus['phone'];
	/** A phone is among the devices: its first, fourth and fifth steps are done. */
	paired: boolean;
	busy: boolean;
	run(action: () => Promise<RemoteAccessStatus | void>): Promise<boolean>;
}) {
	const [copied, setCopied] = useState(false);
	// spec/remote-access-and-mobile#tailscale-guidance: no tailscale command here — the reason links the download instead of standing bare.
	const missing = phone.enabled && !phone.tailscale.cli;
	// Tailscale is asked only while the phone's switch is on: off, nothing is known and no step is ticked.
	const known = phone.enabled && !missing;
	const address = known && phone.host ? `https://${phone.host}` : null;
	const [before, after] = t(locale, 'Open {address} on the phone and enter the code.').split(
		'{address}'
	);
	return (
		<SettingsSection title={t(locale, 'Phone')}>
			<SettingsRow
				label={t(locale, 'Phone')}
				hint={t(locale, 'The machine’s name in the tailnet goes into public certificate logs.')}>
				<label className={styles.inline} data-lines>
					<Switch
						label={t(locale, 'Access from a phone')}
						checked={phone.enabled}
						disabled={busy}
						onChange={(on) => void run(() => window.brigadir.setRemotePhone(on))}
					/>
					<span>{t(locale, 'Access from a phone')}</span>
				</label>
				{phone.enabled && (
					<span className={styles.status} data-remote-phone-status>
						<span className={styles.dot} data-on={phone.listening} />
						{phone.listening && phone.host ? (
							<span>
								{t(locale, 'Address')} <span className={styles.mono}>https://{phone.host}</span>
							</span>
						) : missing ? (
							<span>
								<span className={styles.warn}>
									{t(locale, 'Tailscale is not found on this machine.')}
								</span>{' '}
								<TailscaleLink locale={locale} />
							</span>
						) : (
							<span className={styles.warn}>
								{fill(locale, 'Not listening: {error}', {
									error: phone.error
										? phoneError(locale, phone.error, phone.host)
										: t(locale, 'tailscale serve does not send this address here yet.'),
								})}
							</span>
						)}
					</span>
				)}
			</SettingsRow>
			<SettingsRow label={t(locale, 'Steps')}>
				<ol className={styles.steps} data-remote-phone-steps>
					<PhoneStep locale={locale} n={1} done={paired}>
						{t(locale, 'Install Tailscale on the phone and sign in to the same tailnet.')}{' '}
						<TailscaleLink locale={locale} />
					</PhoneStep>
					<PhoneStep locale={locale} n={2} done={known && phone.tailscale.https}>
						{t(locale, 'Turn on HTTPS in the tailnet’s DNS settings.')}{' '}
						<WebLink href="https://login.tailscale.com/admin/dns" data-tailscale-admin>
							{t(locale, 'Open the admin console')}
						</WebLink>
					</PhoneStep>
					<PhoneStep
						locale={locale}
						n={3}
						done={known && phone.tailscale.serving}
						below={
							<span className={styles.command} data-size="s">
								<code className={styles.mono} data-remote-phone-command>
									{phone.tailscale.command}
								</code>
								<IconButton
									size="s"
									appearance="neutral"
									label={t(locale, copied ? 'Copied' : 'Copy')}
									onClick={() =>
										void window.brigadir
											.copyText(phone.tailscale.command)
											.then(() => setCopied(true))
									}>
									<Glyph name={copied ? 'tick' : 'copy'} size={14} />
								</IconButton>
							</span>
						}>
						{t(locale, 'Run once on this machine:')}
					</PhoneStep>
					<PhoneStep locale={locale} n={4} done={paired}>
						{t(locale, 'Click Add device below to get a code.')}
					</PhoneStep>
					<PhoneStep locale={locale} n={5} done={paired}>
						{before}
						{address ? (
							<span className={styles.mono}>{address}</span>
						) : (
							t(locale, 'the machine’s tailnet address')
						)}
						{after}
					</PhoneStep>
				</ol>
			</SettingsRow>
			{phone.enabled && (
				<div className={styles.actions} data-size="s">
					<Button
						size="s"
						disabled={busy}
						data-remote-phone-check
						onClick={() => void run(() => window.brigadir.checkRemotePhone())}>
						{t(locale, 'Check again')}
					</Button>
				</div>
			)}
		</SettingsSection>
	);
}
/** spec/remote-access-and-mobile#tailscale-guidance: a step of the phone's setup — its number, or ✓ once the machine sees it done. */
function PhoneStep({
	locale,
	n,
	done,
	below,
	children,
}: {
	locale: Locale;
	n: number;
	done: boolean;
	below?: React.ReactNode;
	children: React.ReactNode;
}) {
	return (
		<li data-done={done || undefined} data-remote-phone-step={n}>
			<span className={styles.stepMark} data-done={done || undefined}>
				{done ? (
					<span role="img" aria-label={t(locale, 'Done (step)')}>
						<Glyph name="env-ok" size={18} />
					</span>
				) : (
					n
				)}
			</span>
			<span className={styles.stepText}>
				<span>{children}</span>
				{below}
			</span>
		</li>
	);
}
