import { useEffect, useRef, useState, type KeyboardEvent, type ReactNode } from 'react';
import {
	normalizePairingCode,
	pairingAlphabet,
	pairingAttemptsLeft,
	pairingCodeLength,
	remoteMoment,
	remoteNetworkName,
	t,
	type FoundMachine,
	type Locale,
	type PairedMachine,
	type RemoteConnectResult,
	type RemoteKeyStore,
	type RemotePairResult,
	type RemoteReach,
} from '@brigadir/core';
import { Button } from './ui/Controls';
import { ConfirmDialog } from './ui/ConfirmDialog';
import { Chevron } from './ui/Controls';
import { Glyph } from './ui/Glyph';
import { MachineGlyph } from './ui/MachineGlyph';
import { TextInput } from './ui/Input';
import { ModalDialog } from './ui/ModalDialog';
import { fill, rich } from './remote-text';
import { TailscaleLink } from './RemoteOverview';
import { reloadRemoteMachines, useRemoteMachines, watchRemoteMachines } from './remote-store';
import styles from './RemoteConnect.module.css';

type Step =
	| { kind: 'list' }
	| { kind: 'new' }
	| { kind: 'address' }
	| { kind: 'code'; host: string; port: number | null; machine: string }
	| { kind: 'wait'; machine: string; device: string }
	| { kind: 'paired'; machine: PairedMachine };
type Failure = Extract<RemoteConnectResult, { ok: false }> & { at: number };

/**
 * spec/remote-access-and-mobile#architecture, spec/remote-access-and-mobile#module-and-settings: `File ▸ Connect…` — the paired machines, a password in the
 * chosen row, and `New machine…` to pair one: machines heard on the LAN or an address typed in, then the code in 8 cells.
 */
export function RemoteConnect({
	locale,
	close,
	machine: initialMachine,
	pair: initialPair = false,
}: {
	locale: Locale;
	close(): void;
	/** spec/remote-access-and-mobile#remote-button: opened on this machine — its row selected, the password open. */ machine?:
		string | undefined;
	/** spec/remote-access-and-mobile#remote-button: opened on `New machine…`. */ pair?:
		boolean | undefined;
}) {
	const [step, setStep] = useState<Step>({ kind: initialPair ? 'new' : 'list' }),
		[machines, setMachines] = useState<PairedMachine[]>([]),
		found = useRemoteMachines((state) => state.found),
		reach = useRemoteMachines((state) => state.reach),
		[selected, setSelected] = useState<string | null>(initialMachine ?? null),
		[failures, setFailures] = useState<Record<string, Failure>>({}),
		[connecting, setConnecting] = useState<string | null>(null),
		[takeOver, setTakeOver] = useState<{ id: string; password: string } | null>(null),
		[deviceName, setDeviceName] = useState(''),
		[keyStore, setKeyStore] = useState<RemoteKeyStore>('ok'),
		mounted = useRef(true),
		// «Try again» after «does not answer» repeats the last try: the password block remounts empty on a failure.
		// Kept in memory only while this dialog is open and only after «does not answer».
		unanswered = useRef(new Map<string, string>());
	const load = () =>
		reloadRemoteMachines().then((list) => {
			if (mounted.current) setMachines(list);
			return list;
		});
	useEffect(() => {
		mounted.current = true;
		void load().then((list) => {
			if (list.length === 1 && !initialMachine) setSelected(list[0]!.id);
		});
		// mDNS and the TLS touch while the list is open, shared with the chip's popover and Settings (spec/remote-access-and-mobile#remote-button).
		const release = watchRemoteMachines();
		void window.brigadir
			.readRemoteAccess()
			.then((status) => {
				if (mounted.current) setDeviceName(status.machineName);
			})
			.catch(() => {});
		// spec/remote-access-and-mobile#identity-and-keys: a computer that cannot keep the key says so before a code or a password.
		void window.brigadir
			.readRemoteKeyStore()
			.then((value) => {
				if (mounted.current) setKeyStore(value);
			})
			.catch(() => {});
		return () => {
			mounted.current = false;
			release();
		};
	}, []);
	// spec/remote-access-and-mobile#networking: whether each machine answers, before a password; an answer clears an old «does not answer».
	useEffect(() => {
		setFailures((current) => {
			const answered = reach.filter(
				(item) => item.state === 'answered' && current[item.machineId]?.reason === 'unreachable'
			);
			if (!answered.length) return current;
			const next = { ...current };
			for (const item of answered) delete next[item.machineId];
			return next;
		});
	}, [reach]);
	async function connect(id: string, typed: string, take: boolean): Promise<boolean> {
		const password = typed || unanswered.current.get(id) || '';
		if (!password) {
			// Nothing to repeat (the failure came from pairing): back to the password field.
			setFailures((value) => {
				const next = { ...value };
				delete next[id];
				return next;
			});
			return false;
		}
		unanswered.current.delete(id);
		setConnecting(id);
		try {
			const result = await window.brigadir.connectRemoteMachine(id, password, take);
			if (!result.ok && result.reason === 'unreachable') unanswered.current.set(id, password);
			if (!mounted.current) return result.ok;
			if (result.ok) {
				close();
				return true;
			}
			if (result.reason === 'local') {
				setTakeOver({ id, password });
				return false;
			}
			setFailures((value) => ({ ...value, [id]: { ...result, at: Date.now() } }));
			void load();
			return false;
		} catch {
			if (mounted.current)
				setFailures((value) => ({
					...value,
					[id]: {
						ok: false,
						reason: 'unknown',
						message: '',
						retryAfterMs: null,
						attemptsLeft: null,
						machine: null,
						at: Date.now(),
					},
				}));
			return false;
		} finally {
			if (mounted.current) setConnecting(null);
		}
	}
	const back =
		step.kind === 'list' || step.kind === 'paired'
			? undefined
			: () => {
					if (step.kind === 'wait') void window.brigadir.cancelPairRemoteMachine().catch(() => {});
					setStep(
						step.kind === 'address'
							? { kind: 'new' }
							: step.kind === 'code' || step.kind === 'wait'
								? { kind: 'new' }
								: { kind: 'list' }
					);
				};
	const shut = () => {
		if (step.kind === 'wait') void window.brigadir.cancelPairRemoteMachine().catch(() => {});
		close();
	};
	const list = (
		<MachineList
			locale={locale}
			device={deviceName}
			machines={machines}
			found={found}
			reach={reach}
			selected={selected}
			failures={failures}
			connecting={connecting}
			select={(id) => setSelected(id === selected ? null : id)}
			connect={(id, password) => void connect(id, password, false)}
			pair={() => setStep({ kind: 'new' })}
		/>
	);
	let title = t(locale, 'Connect'),
		body: ReactNode = null,
		footer: ReactNode = null,
		own: ReactNode = null;
	if (step.kind === 'list') {
		body = (
			<>
				{keyStore !== 'ok' && <KeyStoreNote locale={locale} state={keyStore} />}
				{list}
			</>
		);
	} else if (step.kind === 'new') {
		title = t(locale, 'New machine');
		body = (
			<NewMachine
				locale={locale}
				found={found}
				machines={machines}
				choose={(machine) => {
					const paired = machines.find((item) => item.id === machine.id);
					if (paired) {
						setSelected(paired.id);
						setStep({ kind: 'list' });
					} else
						setStep({
							kind: 'code',
							host: machine.addresses[0]!,
							port: machine.pairingPort,
							machine: machine.name,
						});
				}}
				address={() => setStep({ kind: 'address' })}
			/>
		);
	} else if (step.kind === 'address') {
		title = t(locale, 'Enter an address');
		own = (
			<AddressStep
				locale={locale}
				close={shut}
				back={back!}
				next={(host, port) => setStep({ kind: 'code', host, port, machine: host })}
			/>
		);
	} else if (step.kind === 'code') {
		own = (
			<CodeStep
				locale={locale}
				host={step.host}
				port={step.port}
				machine={step.machine}
				device={deviceName}
				close={shut}
				back={back!}
				waiting={(machine, device) => setStep({ kind: 'wait', machine, device })}
				paired={(machine) => {
					void load();
					setSelected(machine.id);
					setStep({ kind: 'paired', machine });
				}}
			/>
		);
	} else if (step.kind === 'wait') {
		title = fill(locale, 'Pair with {machine}', { machine: step.machine });
		body = (
			<div className={styles.big} data-wait>
				<span className={styles.bigSpin}>
					<Glyph name="agent-spinner" size={28} />
				</span>
				<b>{fill(locale, 'Waiting for confirmation on {machine}', { machine: step.machine })}</b>
				<span>
					{rich(
						fill(locale, 'On {machine} check the name **{device}** and press «Pair».', {
							machine: step.machine,
							device: step.device,
						}),
						styles.strong
					)}
				</span>
			</div>
		);
		footer = <Button onClick={back}>{t(locale, 'Cancel')}</Button>;
	} else {
		body = (
			<PairedStep
				locale={locale}
				machine={step.machine}
				busy={connecting === step.machine.id}
				failure={failures[step.machine.id]}
				connect={(password) => void connect(step.machine.id, password, false)}
			/>
		);
	}
	const modal = own ?? (
		<ModalDialog
			title={title}
			locale={locale}
			close={shut}
			back={back}
			width={480}
			top={110}
			footer={footer}
			data-remote-connect={step.kind}>
			{body}
		</ModalDialog>
	);
	return (
		<>
			{modal}
			{takeOver && (
				<ConfirmDialog
					title={t(locale, 'Take control?')}
					locale={locale}
					action={t(locale, 'Take control')}
					error={t(locale, 'Could not connect.')}
					cancel={() => setTakeOver(null)}
					confirm={async () => {
						const { id, password } = takeOver;
						setTakeOver(null);
						await connect(id, password, true);
					}}>
					<p>
						{fill(
							locale,
							'Someone works on {machine} now. If you connect, a cover closes the window on {machine}, and control can be taken back there.',
							{ machine: machines.find((item) => item.id === takeOver.id)?.name ?? '' }
						)}
					</p>
				</ConfirmDialog>
			)}
		</>
	);
}

/** spec/remote-access-and-mobile#architecture, spec/remote-access-and-mobile#identity-and-keys: why this computer cannot pair or connect — its key would not be sealed. */
function KeyStoreNote({ locale, state }: { locale: Locale; state: Exclude<RemoteKeyStore, 'ok'> }) {
	return (
		<div className={styles.note} role="alert" data-key-store={state}>
			<Glyph name="toast-warning" size={14} />
			<span>
				{t(
					locale,
					state === 'plain'
						? 'No secret service (GNOME Keyring or KWallet): Brigadir cannot keep the key of this computer. Install one and start Brigadir again.'
						: 'The system key store is not available: Brigadir cannot keep the key of this computer.'
				)}
			</span>
		</div>
	);
}

/** ↑/↓ move between the rows of a list. */
function arrows(event: KeyboardEvent<HTMLElement>) {
	if (event.key !== 'ArrowDown' && event.key !== 'ArrowUp') return;
	const rows = [...event.currentTarget.querySelectorAll<HTMLElement>('[data-machine-row]')];
	const index = rows.indexOf(document.activeElement as HTMLElement);
	if (index < 0) return;
	event.preventDefault();
	rows[(index + (event.key === 'ArrowDown' ? 1 : -1) + rows.length) % rows.length]?.focus();
}

function MachineList({
	locale,
	device,
	machines,
	found,
	reach,
	selected,
	failures,
	connecting,
	select,
	connect,
	pair,
}: {
	locale: Locale;
	device: string;
	machines: PairedMachine[];
	found: FoundMachine[];
	reach: RemoteReach[];
	selected: string | null;
	failures: Record<string, Failure>;
	connecting: string | null;
	select(id: string): void;
	connect(id: string, password: string): void;
	pair(): void;
}) {
	return (
		<div
			className={styles.list}
			role="listbox"
			aria-label={t(locale, 'Connect')}
			onKeyDown={arrows}>
			{machines.map((machine) => {
				const failure = failures[machine.id],
					touch = reach.find((item) => item.machineId === machine.id),
					answered = touch?.state === 'answered',
					// spec/remote-access-and-mobile#networking: nothing answered the touch — «unavailable» before anyone types a password.
					silent = touch?.state === 'silent',
					heard = answered || (!silent && found.some((item) => item.id === machine.id)),
					unreachable = failure?.reason === 'unreachable',
					open = machine.id === selected;
				const address =
					answered && touch.network && touch.address
						? { network: touch.network, address: touch.address }
						: machine.addresses[0];
				const when = machine.lastConnectedAt
					? fill(locale, 'last {when}', {
							when: remoteMoment(locale, machine.lastConnectedAt),
						})
					: fill(locale, 'paired {when}', { when: remoteMoment(locale, machine.pairedAt) });
				const line = unreachable
					? fill(locale, 'Last {when}', {
							when: remoteMoment(locale, machine.lastConnectedAt ?? machine.pairedAt),
						})
					: silent
						? [
								t(
									locale,
									touch.tailscale
										? 'No answer on the LAN or through Tailscale'
										: 'Unavailable outside the LAN without Tailscale'
								),
								when,
							].join(' · ')
						: [address ? remoteNetworkName(address.network) : null, address?.address, when]
								.filter(Boolean)
								.join(' · ');
				return (
					<div key={machine.id} className={styles.entry} data-open={open || undefined}>
						<MachineRow
							name={machine.name}
							line={line}
							dot={unreachable || silent ? 'off' : heard ? 'on' : undefined}
							data-remote-reach={touch?.state}
							status={
								unreachable || silent
									? t(locale, 'Unavailable (machine)')
									: heard
										? t(locale, 'Available (machine)')
										: undefined
							}
							selected={open}
							chevron={!open}
							onClick={() => select(machine.id)}
							data-remote-machine={machine.name}
						/>
						{open && (
							<PasswordBlock
								key={failure?.at ?? 0}
								locale={locale}
								machine={machine}
								device={device}
								failure={failure}
								outside={silent && !touch?.tailscale}
								busy={connecting === machine.id}
								connect={(password) => connect(machine.id, password)}
							/>
						)}
					</div>
				);
			})}
			<MachineRow
				add
				name={t(locale, 'New machine…')}
				line={t(locale, 'Pair with a code the working machine shows')}
				onClick={pair}
				data-remote-new
			/>
		</div>
	);
}

/** A machine in a list: its glyph with the link's dot, name and second line, a status and a chevron. */
function MachineRow({
	name,
	line,
	dot,
	status,
	selected = false,
	chevron = true,
	add = false,
	muted = false,
	glyph = 'plus',
	onClick,
	...data
}: {
	name: string;
	line: string;
	dot?: 'on' | 'off' | undefined;
	status?: string | undefined;
	selected?: boolean;
	chevron?: boolean;
	add?: boolean;
	muted?: boolean;
	/** The dashed plate's glyph of an `add` row. */ glyph?: 'plus' | 'search';
	onClick(): void;
} & { [key: `data-${string}`]: string | boolean | undefined }) {
	return (
		<button
			{...data}
			type="button"
			role="option"
			aria-selected={selected}
			className={styles.row}
			data-machine-row
			data-add={add || undefined}
			data-muted={muted || undefined}
			onClick={onClick}>
			{/* The shared 28 px machine plate (rule 17); `add` rows are its dashed form. */}
			{add ? <MachineGlyph tile dashed glyph={glyph} /> : <MachineGlyph tile reach={dot} />}
			<span className={styles.two}>
				<b>{name}</b>
				<small>{line}</small>
			</span>
			{status && <span className={styles.status}>{status}</span>}
			{chevron && !add && (
				<span className={styles.chevron}>
					<Chevron right />
				</span>
			)}
		</button>
	);
}

function PasswordBlock({
	locale,
	machine,
	device,
	failure,
	outside = false,
	busy,
	connect,
}: {
	locale: Locale;
	machine: PairedMachine;
	/** spec/remote-access-and-mobile#tailscale-guidance: it did not answer and has no Tailscale address — the hint links the Tailscale download. */
	outside?: boolean;
	device: string;
	failure: Failure | undefined;
	busy: boolean;
	connect(password: string): void;
}) {
	const [password, setPassword] = useState(''),
		[now, setNow] = useState(Date.now()),
		field = useRef<HTMLInputElement>(null);
	const until = failure?.retryAfterMs ? failure.at + failure.retryAfterMs : 0,
		wait = Math.max(0, Math.ceil((until - now) / 1000));
	useEffect(() => {
		if (!until) return;
		const timer = setInterval(() => setNow(Date.now()), 250);
		return () => clearInterval(timer);
	}, [until]);
	useEffect(() => {
		if (!busy) field.current?.focus();
	}, [busy, wait === 0]);
	const go = () => {
		if (password && !busy && wait === 0) connect(password);
	};
	const name = machine.name;
	if (failure?.reason === 'unreachable')
		return (
			<div className={styles.block} data-tone="amber">
				<p className={styles.blockText}>
					{fill(
						locale,
						'{machine} does not answer on the LAN or through Tailscale. Check that {machine} is awake, Brigadir runs there and remote access is on.',
						{ machine: name }
					)}{' '}
					<TailscaleLink locale={locale} />
				</p>
				<div className={styles.blockRow} data-size="s">
					<Button onClick={() => connect(password)} disabled={busy} data-remote-retry>
						<Glyph name="refresh" size={14} />
						{t(locale, 'Try again (connection)')}
					</Button>
					<span className={styles.hint}>
						{fill(locale, 'Tried: {addresses}', {
							addresses: machine.addresses.map((item) => item.address).join(' · '),
						})}
					</span>
				</div>
			</div>
		);
	if (
		failure?.reason === 'version' ||
		failure?.reason === 'off' ||
		failure?.reason === 'unknown' ||
		failure?.reason === 'identity'
	)
		return (
			<div className={styles.block} data-tone="amber">
				<p className={styles.blockText}>
					{rich(
						failure.reason === 'version'
							? fill(
									locale,
									'Brigadir on {machine} is another version. **Update Brigadir on {machine}**, then connect.',
									{ machine: failure.machine ?? name }
								)
							: failure.reason === 'off'
								? fill(locale, 'Remote access is off on {machine}.', { machine: name })
								: failure.reason === 'unknown'
									? fill(locale, '{machine} no longer knows this device: pair it again.', {
											machine: name,
										})
									: t(locale, 'This computer could not keep its key.')
					)}
				</p>
			</div>
		);
	if (failure?.reason === 'blocked')
		return (
			<div className={styles.block} data-tone="red">
				<p className={styles.blockText}>
					{fill(
						locale,
						'{device} is blocked on {machine} after 10 wrong passwords. Only {machine} can unblock it.',
						{ device, machine: name }
					)}
				</p>
			</div>
		);
	const wrong = failure?.reason === 'password' || failure?.reason === 'wait';
	return (
		<div className={styles.block}>
			<div className={styles.blockRow} data-size="m">
				<TextInput
					ref={field}
					type="password"
					aria-label={fill(locale, 'Password for {machine}', { machine: name })}
					aria-invalid={wrong && !password ? true : undefined}
					placeholder={
						wrong ? fill(locale, 'Password for {machine}', { machine: name }) : undefined
					}
					autoComplete="off"
					disabled={busy}
					value={password}
					onChange={(event) => setPassword(event.target.value)}
					onKeyDown={(event) => {
						if (event.key === 'Enter') go();
					}}
					data-remote-password
				/>
				<Button
					appearance="primary"
					disabled={busy || wait > 0 || !password}
					onClick={go}
					data-remote-connect-button>
					{busy && (
						<span className={styles.spin}>
							<Glyph name="agent-spinner" size={16} />
						</span>
					)}
					{busy
						? t(locale, 'Connecting…')
						: wait > 0
							? fill(locale, '{seconds} s', { seconds: wait })
							: t(locale, 'Connect')}
				</Button>
			</div>
			<span className={wrong ? styles.hintError : styles.hint}>
				{busy
					? machine.addresses[0]
						? fill(locale, 'Via {network} · {address}', {
								network: remoteNetworkName(machine.addresses[0].network),
								address: machine.addresses[0].address,
							})
						: t(locale, 'Connecting…')
					: wrong && failure?.reason === 'password'
						? fill(locale, 'Wrong password. Next try in {seconds} s.', {
								seconds: Math.ceil((failure.retryAfterMs ?? 0) / 1000),
							})
						: wrong
							? fill(locale, 'Too many tries. Next try in {seconds} s.', {
									seconds: Math.ceil((failure!.retryAfterMs ?? 0) / 1000),
								})
							: fill(locale, 'Remote access password set on {machine}. Not kept here.', {
									machine: name,
								})}
			</span>
			{outside && (
				<span className={styles.hint} data-remote-outside>
					{t(locale, 'Outside the LAN, only through Tailscale on both computers.')}{' '}
					<TailscaleLink locale={locale} />
				</span>
			)}
		</div>
	);
}

function NewMachine({
	locale,
	found,
	machines,
	choose,
	address,
}: {
	locale: Locale;
	found: FoundMachine[];
	machines: PairedMachine[];
	choose(machine: FoundMachine): void;
	address(): void;
}) {
	return (
		<>
			<div className={styles.group}>
				{t(locale, 'On this network')}
				<span className={styles.spin}>
					<Glyph name="agent-spinner" size={14} />
				</span>
			</div>
			<div
				className={styles.list}
				role="listbox"
				aria-label={t(locale, 'New machine')}
				onKeyDown={arrows}>
				{found
					.filter((machine) => machine.addresses.length > 0)
					.map((machine) => {
						const paired = machines.some((item) => item.id === machine.id);
						return (
							<MachineRow
								key={`${machine.id ?? machine.name}-${machine.addresses[0]}`}
								name={machine.name}
								line={[
									fill(locale, '{address} · found on the LAN', { address: machine.addresses[0]! }),
									paired ? t(locale, 'already paired') : null,
								]
									.filter(Boolean)
									.join(' · ')}
								dot="on"
								muted={paired}
								onClick={() => choose(machine)}
							/>
						);
					})}
				<MachineRow
					add
					glyph="search"
					name={t(locale, 'Enter an address…')}
					line={t(locale, 'Tailscale or IP, if the machine is not on the list')}
					onClick={address}
					data-remote-address
				/>
			</div>
			<p className={styles.hint}>
				{rich(
					t(locale, 'On the working machine: Settings ▸ Remote ▸ **Add device** shows the code.'),
					styles.strong
				)}
			</p>
		</>
	);
}

function AddressStep({
	locale,
	close,
	back,
	next,
}: {
	locale: Locale;
	close(): void;
	back(): void;
	next(host: string, port: number | null): void;
}) {
	const [host, setHost] = useState(''),
		[port, setPort] = useState('7420'),
		field = useRef<HTMLInputElement>(null);
	const portValue = Number(port);
	const ready =
		host.trim().length > 0 && Number.isInteger(portValue) && portValue >= 1 && portValue <= 65535;
	const go = () => {
		// The working machine pairs on the port after the gateway's (7421 for 7420, spec/remote-access-and-mobile#transport-and-protocol).
		if (ready) next(host.trim(), portValue + 1);
	};
	return (
		<ModalDialog
			title={t(locale, 'Enter an address')}
			locale={locale}
			close={close}
			back={back}
			width={480}
			top={110}
			initialFocus={field}
			data-remote-connect="address"
			footer={
				<Button appearance="primary" disabled={!ready} onClick={go}>
					{t(locale, 'Next')}
				</Button>
			}>
			<span className={styles.label}>{t(locale, 'Address')}</span>
			<div className={styles.blockRow} data-size="m">
				<TextInput
					ref={field}
					className={styles.mono}
					aria-label={t(locale, 'Address')}
					spellCheck={false}
					value={host}
					onChange={(event) => setHost(event.target.value)}
					onKeyDown={(event) => {
						if (event.key === 'Enter') go();
					}}
				/>
				<TextInput
					className={`${styles.mono} ${styles.port}`}
					aria-label={t(locale, 'Port')}
					inputMode="numeric"
					value={port}
					onChange={(event) => setPort(event.target.value.replace(/\D/g, '').slice(0, 5))}
					onKeyDown={(event) => {
						if (event.key === 'Enter') go();
					}}
				/>
			</div>
			<p className={styles.hint}>
				{t(
					locale,
					'IP or name on the LAN or Tailscale. The port is 7420 unless it was changed on the working machine.'
				)}
			</p>
		</ModalDialog>
	);
}

function CodeStep({
	locale,
	host,
	port,
	machine,
	device,
	close,
	back,
	waiting,
	paired,
}: {
	locale: Locale;
	host: string;
	port: number | null;
	machine: string;
	device: string;
	close(): void;
	back(): void;
	waiting(machine: string, device: string): void;
	paired(machine: PairedMachine): void;
}) {
	const [cells, setCells] = useState<string[]>(Array(pairingCodeLength).fill('')),
		[name, setName] = useState(device),
		[busy, setBusy] = useState(false),
		[failure, setFailure] = useState<Extract<RemotePairResult, { ok: false }> | null>(null),
		first = useRef<HTMLInputElement>(null);
	useEffect(() => {
		if (!name && device) setName(device);
	}, [device]);
	useEffect(() => {
		if (!busy) return;
		return window.brigadir.onRemotePairProgress((progress) =>
			waiting(progress.machine || machine, name.trim() || device)
		);
	}, [busy]);
	const code = cells.join('');
	const ready = code.length === pairingCodeLength && !busy && !!name.trim();
	const dead = failure?.reason === 'closed' || failure?.reason === 'exhausted';
	const go = async (value = code) => {
		if (value.length !== pairingCodeLength || busy || !name.trim()) return;
		setBusy(true);
		setFailure(null);
		try {
			const result = await window.brigadir.pairRemoteMachine(host, port, value, name.trim());
			if (result.ok) paired(result.machine);
			else setFailure(result);
		} catch {
			setFailure({ ok: false, reason: 'unreachable', attemptsLeft: null, message: '' });
		} finally {
			setBusy(false);
		}
	};
	const note =
		failure?.reason === 'code' ? (
			<p className={`${styles.hintError} ${styles.center}`} role="alert">
				{pairingAttemptsLeft(locale, failure.attemptsLeft ?? 0)}
			</p>
		) : failure ? (
			<div className={styles.note} role="alert">
				<Glyph name="toast-warning" size={14} />
				<span>
					{failure.reason === 'closed'
						? fill(
								locale,
								'The code no longer works. On {machine} press «New code» and enter it here.',
								{
									machine,
								}
							)
						: failure.reason === 'exhausted'
							? fill(locale, 'Too many wrong codes. On {machine} open «Add device» again.', {
									machine,
								})
							: failure.reason === 'declined'
								? fill(locale, 'The device was declined on {machine}.', { machine })
								: failure.reason === 'busy'
									? fill(
											locale,
											'Another device is pairing with {machine} now. Try again in a minute.',
											{
												machine,
											}
										)
									: failure.reason === 'version'
										? rich(
												fill(
													locale,
													'Brigadir on {machine} is another version. **Update Brigadir on {machine}**, then connect.',
													{ machine }
												)
											)
										: failure.reason === 'identity'
											? t(locale, 'This computer could not keep its key.')
											: fill(locale, 'Could not reach {machine}.', { machine })}
				</span>
			</div>
		) : null;
	return (
		<ModalDialog
			title={fill(locale, 'Pair with {machine}', { machine })}
			locale={locale}
			close={close}
			back={back}
			width={480}
			top={110}
			initialFocus={first}
			data-remote-connect="code"
			footer={
				<Button
					appearance="primary"
					disabled={!ready}
					onClick={() => void go()}
					data-remote-pair-submit>
					{t(locale, 'Pair')}
				</Button>
			}>
			<p>
				{rich(
					fill(
						locale,
						'The code is shown on **{machine}**: Settings ▸ Remote ▸ Add device. Valid for 5 min.',
						{ machine }
					),
					styles.monoStrong
				)}
			</p>
			<CodeCells
				locale={locale}
				cells={cells}
				error={failure?.reason === 'code'}
				dead={dead}
				first={first}
				onChange={(next) => {
					setCells(next);
					if (failure?.reason === 'code') setFailure(null);
				}}
				onDone={(value) => void go(value)}
			/>
			{note}
			<span className={styles.label} data-gap>
				{t(locale, 'This computer’s name')}
			</span>
			<div className={styles.blockRow} data-size="m">
				<TextInput
					aria-label={t(locale, 'This computer’s name')}
					maxLength={64}
					value={name}
					onChange={(event) => setName(event.target.value)}
				/>
			</div>
		</ModalDialog>
	);
}

/** spec/remote-access-and-mobile#module-and-settings: the code in 8 cells, 4 + 4; a pasted code spreads over them, ⌫ goes back. */
function CodeCells({
	locale,
	cells,
	error,
	dead,
	first,
	onChange,
	onDone,
}: {
	locale: Locale;
	cells: string[];
	error: boolean;
	dead: boolean;
	first: React.RefObject<HTMLInputElement | null>;
	onChange(cells: string[]): void;
	onDone(code: string): void;
}) {
	const root = useRef<HTMLDivElement>(null);
	const input = (index: number) =>
		root.current?.querySelectorAll<HTMLInputElement>('input')[Math.max(0, Math.min(7, index))];
	const put = (index: number, text: string) => {
		const chars = [...normalizePairingCode(text)].filter((char) => pairingAlphabet.includes(char));
		if (!chars.length) return;
		const next = [...cells];
		let at = index;
		for (const char of chars) {
			if (at >= pairingCodeLength) break;
			next[at++] = char;
		}
		onChange(next);
		input(at)?.focus();
		if (next.every(Boolean) && at >= pairingCodeLength) onDone(next.join(''));
	};
	return (
		<div
			ref={root}
			className={styles.code}
			data-error={error || undefined}
			data-dead={dead || undefined}
			role="group"
			aria-label={t(locale, 'Pairing code')}>
			{cells.map((char, index) => (
				<input
					key={index}
					ref={index === 0 ? first : undefined}
					data-gap={index === 4 || undefined}
					aria-label={fill(locale, 'Code character {n}', { n: index + 1 })}
					value={char}
					maxLength={2}
					autoComplete="off"
					spellCheck={false}
					disabled={dead}
					onFocus={(event) => event.currentTarget.select()}
					onChange={(event) => {
						const value = event.target.value.replace(char, '') || event.target.value;
						if (!value) {
							const next = [...cells];
							next[index] = '';
							onChange(next);
						} else put(index, value);
					}}
					onPaste={(event) => {
						event.preventDefault();
						put(index, event.clipboardData.getData('text'));
					}}
					onKeyDown={(event) => {
						if (event.key === 'Backspace' && !char && index > 0) {
							event.preventDefault();
							const next = [...cells];
							next[index - 1] = '';
							onChange(next);
							input(index - 1)?.focus();
						}
						if (event.key === 'ArrowLeft') input(index - 1)?.focus();
						if (event.key === 'ArrowRight') input(index + 1)?.focus();
						if (event.key === 'Enter') onDone(cells.join(''));
					}}
				/>
			))}
		</div>
	);
}

function PairedStep({
	locale,
	machine,
	busy,
	failure,
	connect,
}: {
	locale: Locale;
	machine: PairedMachine;
	busy: boolean;
	failure: Failure | undefined;
	connect(password: string): void;
}) {
	const [password, setPassword] = useState(''),
		field = useRef<HTMLInputElement>(null);
	useEffect(() => field.current?.focus(), []);
	const go = () => {
		if (password && !busy) connect(password);
	};
	return (
		<>
			<div className={styles.big}>
				<span className={styles.ok}>
					<Glyph name="toast-success" size={28} />
				</span>
				<b>{fill(locale, '{machine} added', { machine: machine.name })}</b>
				<span>{t(locale, 'Next, the remote access password. No need to pair again.')}</span>
			</div>
			<div className={styles.blockRow} data-size="m">
				<TextInput
					ref={field}
					type="password"
					aria-label={fill(locale, 'Password for {machine}', { machine: machine.name })}
					aria-invalid={failure?.reason === 'password' ? true : undefined}
					autoComplete="off"
					value={password}
					disabled={busy}
					onChange={(event) => setPassword(event.target.value)}
					onKeyDown={(event) => {
						if (event.key === 'Enter') go();
					}}
					data-remote-password
				/>
				<Button appearance="primary" disabled={busy || !password} onClick={go}>
					{busy ? t(locale, 'Connecting…') : t(locale, 'Connect')}
				</Button>
			</div>
			{failure && (
				<span className={styles.hintError}>
					{failure.reason === 'password'
						? fill(locale, 'Wrong password. Next try in {seconds} s.', {
								seconds: Math.ceil((failure.retryAfterMs ?? 0) / 1000),
							})
						: t(locale, 'Could not connect.')}
				</span>
			)}
		</>
	);
}
