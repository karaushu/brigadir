import { useEffect, useRef, useState } from 'react';
import {
	formatPairingCode,
	pairingAttemptsLeft,
	t,
	type Locale,
	type RemotePairing,
} from '@brigadir/core';
import { Button } from './ui/Controls';
import { Glyph } from './ui/Glyph';
import { TextInput } from './ui/Input';
import { ModalDialog } from './ui/ModalDialog';
import { notify } from './ui/Toast';
import { fill, rich, shortKey, addressNetwork } from './remote-text';
import styles from './RemotePair.module.css';

/**
 * spec/remote-access-and-mobile#architecture, spec/remote-access-and-mobile#module-and-settings: `Add device` on the working machine — a fresh code 4 + 4 for 5 minutes
 * and its countdown, then the device's name to confirm. An expired code is struck out with `New code`; five wrong codes
 * close the window with a toast; `Pair` ends it with a toast and the new row lit. Esc stops the pairing.
 */
export function RemotePair({
	locale,
	machine,
	close,
}: {
	locale: Locale;
	machine: string;
	/** The device's name when it paired. */ close(device?: string): void;
}) {
	const [pairing, setPairing] = useState<RemotePairing | null>(null),
		[name, setName] = useState(''),
		[busy, setBusy] = useState(false),
		[now, setNow] = useState(Date.now()),
		nameField = useRef<HTMLInputElement>(null),
		lastCode = useRef(''),
		done = useRef(false);
	if (pairing?.state === 'open' && pairing.code) lastCode.current = pairing.code;
	const finish = (device?: string) => {
		if (done.current) return;
		done.current = true;
		close(device);
	};
	useEffect(() => {
		const stop = window.brigadir.onRemoteStatus((status) => setPairing(status.pairing));
		void window.brigadir
			.startRemotePairing()
			.then(setPairing)
			.catch(() => finish());
		return () => {
			stop();
		};
	}, []);
	// The countdown of the open window.
	useEffect(() => {
		if (pairing?.state !== 'open' && pairing?.state !== 'confirm') return;
		const timer = setInterval(() => setNow(Date.now()), 1000);
		return () => clearInterval(timer);
	}, [pairing?.state]);
	useEffect(() => {
		if (!pairing) return;
		if (pairing.state === 'confirm') {
			setName(pairing.device);
			requestAnimationFrame(() => nameField.current?.select());
		}
		// The toast comes with the gateway's `paired` notice (App), whether this dialog is open or not.
		if (pairing.state === 'paired') finish(pairing.device);
		if (pairing.state === 'declined' || pairing.state === 'idle') finish();
		if (pairing.state === 'exhausted') {
			// The address of the last wrong code comes from the log (the pairing window does not keep it).
			void window.brigadir
				.readRemoteAudit(10)
				.then(
					(entries) => entries.find((entry) => entry.kind === 'pairing-failed')?.address ?? null
				)
				.catch(() => null)
				.then((address) => {
					notify(
						'warning',
						address
							? fill(locale, 'Pairing stopped: 5 wrong codes from {address}.', { address })
							: t(locale, 'Pairing stopped: 5 wrong codes.'),
						{ key: 'remote-pairing-exhausted', bold: address ?? undefined }
					);
				});
			finish();
		}
	}, [pairing]);
	const stop = () => {
		void window.brigadir.stopRemotePairing().catch(() => {});
		finish();
	};
	const fresh = () => {
		setBusy(true);
		void window.brigadir
			.startRemotePairing()
			.then(setPairing)
			.catch(() => {})
			.finally(() => setBusy(false));
	};
	const confirm = (accept: boolean) => {
		const value = name.trim();
		setBusy(true);
		void window.brigadir
			.confirmRemotePairing(
				accept,
				accept && value && pairing?.state === 'confirm' && value !== pairing.device ? value : null
			)
			.then(setPairing)
			.catch(() => {})
			.finally(() => setBusy(false));
	};
	const how = (
		<p>
			{rich(
				fill(
					locale,
					'On the other computer: **File ▸ Connect… ▸ New machine…**, choose **{machine}** and enter the code.',
					{ machine }
				),
				undefined,
				{ text: machine, className: styles.mono! }
			)}
		</p>
	);
	let body = null,
		footer = null;
	if (pairing?.state === 'open') {
		const left = Math.max(0, Date.parse(pairing.expiresAt) - now),
			minutes = Math.floor(left / 60000),
			seconds = Math.floor((left % 60000) / 1000);
		body = (
			<>
				{how}
				<BigCode code={pairing.code} />
				<div className={styles.timer}>
					<span>
						{fill(locale, 'Valid for {time}', {
							time: `${minutes}:${String(seconds).padStart(2, '0')}`,
						})}
					</span>
					<span className={styles.bar}>
						<i style={{ width: `${Math.min(100, (left / 300000) * 100)}%` }} />
					</span>
				</div>
				<div className={styles.wait} role="status">
					<span className={styles.spin}>
						<Glyph name="agent-spinner" size={14} />
					</span>
					{t(locale, 'Waiting for a device…')}
				</div>
				{/* A wrong code spent a try (five in all, spec/remote-access-and-mobile#architecture). */}
				{pairing.attemptsLeft < 5 && (
					<p className={styles.tries} role="alert">
						{pairingAttemptsLeft(locale, pairing.attemptsLeft)}
					</p>
				)}
			</>
		);
		footer = (
			<Button variant="ghost" disabled={busy} onClick={fresh}>
				<Glyph name="refresh" size={14} />
				{t(locale, 'New code')}
			</Button>
		);
	} else if (pairing?.state === 'confirm') {
		body = (
			<>
				<p>{t(locale, 'The device entered the right code and wants to control this machine.')}</p>
				<div className={styles.kv}>
					<span>{t(locale, 'Name')}</span>
					<div data-size="m" className={styles.kvField}>
						<TextInput
							ref={nameField}
							aria-label={t(locale, 'Name')}
							maxLength={64}
							value={name}
							onChange={(event) => setName(event.target.value)}
							onKeyDown={(event) => {
								if (event.key === 'Enter' && name.trim()) confirm(true);
							}}
						/>
					</div>
					{pairing.address && (
						<>
							<span>{t(locale, 'Address')}</span>
							<span className={styles.mono}>
								{pairing.address} · {addressNetwork(pairing.address, pairing.network)}
							</span>
						</>
					)}
					<span>{t(locale, 'Device key')}</span>
					<span className={styles.mono} data-small>
						{shortKey(pairing.fingerprint)}
					</span>
				</div>
			</>
		);
		footer = (
			<>
				<Button variant="ghost" appearance="danger" disabled={busy} onClick={() => confirm(false)}>
					{t(locale, 'Decline')}
				</Button>
				<Button
					appearance="primary"
					disabled={busy || !name.trim()}
					onClick={() => confirm(true)}
					data-remote-pair-accept>
					{t(locale, 'Pair')}
				</Button>
			</>
		);
	} else if (pairing?.state === 'expired') {
		body = (
			<>
				{how}
				<BigCode code={lastCode.current} dead />
				<div className={styles.timer} data-dead>
					<span>{t(locale, 'The code no longer works')}</span>
					<span className={styles.bar} />
				</div>
			</>
		);
		footer = (
			<Button appearance="primary" disabled={busy} onClick={fresh}>
				<Glyph name="refresh" size={14} />
				{t(locale, 'New code')}
			</Button>
		);
	}
	return (
		<ModalDialog
			title={t(locale, 'Add a device')}
			locale={locale}
			close={stop}
			width={440}
			top={120}
			data-remote-pair
			footer={footer}>
			{body}
		</ModalDialog>
	);
}

/** The code as the working machine shows it: 34 px mono, 4 + 4; struck out once it expired. */
function BigCode({ code, dead = false }: { code: string; dead?: boolean }) {
	const shown = code;
	return (
		<div
			className={styles.code}
			data-dead={dead || undefined}
			data-remote-code={shown}
			aria-label={formatPairingCode(shown)}>
			{[...shown].map((char, index) => (
				<span key={index} data-gap={index === 4 || undefined}>
					{char}
				</span>
			))}
		</div>
	);
}
