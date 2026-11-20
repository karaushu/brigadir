import { useEffect, useRef, useState, type PointerEvent as ReactPointerEvent } from 'react';
import { useWorkspace } from './store';
import {
	devicePoint,
	hidUsage,
	isLandscape,
	orientationAngle,
	t,
	type AgentTask,
	type Locale,
	type SimulatorCommand,
	type SimulatorState,
	type SimulatorVideoConfig,
	type MessageKey,
} from '@brigadir/core';
import { attachTaskContext } from './task-state';
import { Button, IconButton, Popup, PopupMarks } from './ui/Controls';
import { Glyph } from './ui/Glyph';
import { notify } from './ui/Toast';
import { remoteMachine, useRemote } from './remote-store';
import { MachineTag } from './ui/MachineTag';
import { fill } from './remote-text';
import { pickerModel } from './simulator-picker';
import styles from './SimulatorPanel.module.css';
/** spec/notifications-slack-notes-and-schedules#message-classes: what a failed simulator command was, for its own toast; reads of the column itself are warnings. */
const commandFailures: Record<SimulatorCommand['kind'], MessageKey> = {
	state: 'Could not read the simulator state.',
	refresh: 'Could not read the simulator state.',
	watch: 'Could not show the simulator screen.',
	keyframe: 'Could not show the simulator screen.',
	select: 'Could not switch the simulator.',
	boot: 'Could not start the simulator.',
	shutdown: 'Could not shut down the simulator.',
	touch: 'Could not send the input to the simulator.',
	key: 'Could not send the input to the simulator.',
	text: 'Could not send the input to the simulator.',
	paste: 'Could not send the input to the simulator.',
	button: 'Could not send the input to the simulator.',
	screenshot: 'Could not take a simulator screenshot.',
	reload: 'Could not reload the app.',
	devtools: 'Could not open DevTools.',
	rotate: 'Could not rotate the simulator.',
};
const backgroundCommands: ReadonlySet<SimulatorCommand['kind']> = new Set([
	'state',
	'refresh',
	'watch',
	'keyframe',
]);
/**
 * spec/browser-and-simulator#simulator: the simulator column. Strip 1 — the device picker and Hide; strip 2 — Home and Screenshot to chat;
 * the screen sits in a device frame on a tinted stage. Frames are H.264 decoded by WebCodecs into a canvas; the pointer
 * and the keyboard of a focused screen go back to the device.
 */
/** spec/task-window-workspace#work-area: the simulator is a tab of the work area; it fills its group and shows the task's own device (spec/browser-and-simulator#sim-lease). */
export function SimulatorPanel({ task, locale }: { task: AgentTask; locale: Locale }) {
	const commandsOn = useWorkspace((state) => state.appearance.modules.commands);
	const tasks = useWorkspace((state) => state.workspace?.tasks) ?? [];
	const [state, setState] = useState<SimulatorState | null>(null);
	// spec/browser-and-simulator#sim-cap: «Start anyway» lifts the low-memory block while the list stays open.
	const [anyway, setAnyway] = useState(false);
	const shown = useRef<string | null>(null);
	const canvas = useRef<HTMLCanvasElement>(null),
		stage = useRef<HTMLDivElement>(null),
		decoder = useRef<VideoDecoder | null>(null),
		waitingKey = useRef(true),
		pointer = useRef<number | null>(null);
	const [box, setBox] = useState({ width: 0, height: 0 });
	const [taps, setTaps] = useState<{ x: number; y: number; label: string; key: number }[]>([]);
	const projectId = task.projectId,
		taskId = task.id;
	const key = { projectId, id: taskId };
	async function command(value: SimulatorCommand): Promise<unknown> {
		try {
			return await window.brigadir.simulatorCommand(key, value);
		} catch {
			const background = backgroundCommands.has(value.kind),
				retry = value.kind === 'state' || value.kind === 'boot';
			notify(background ? 'warning' : 'error', t(locale, commandFailures[value.kind]), {
				action: retry
					? {
							label: t(locale, 'Retry'),
							run: () => {
								void command(value).then((result) => {
									if (value.kind === 'state' && result) setState(result as SimulatorState);
								});
							},
						}
					: undefined,
			});
			return null;
		}
	}
	useEffect(() => {
		let disposed = false,
			recovering = 0;
		// A broken stream asks for a fresh config and key frame, at most once a second.
		const recover = () => {
			if (disposed || recovering) return;
			recovering = window.setTimeout(() => {
				recovering = 0;
				if (!disposed)
					void window.brigadir
						.simulatorCommand({ projectId, id: taskId }, { kind: 'keyframe' })
						.catch(() => {});
			}, 1000);
		};
		const configure = (config: SimulatorVideoConfig) => {
			// A decoder that failed has closed itself already.
			if (decoder.current && decoder.current.state !== 'closed') decoder.current.close();
			waitingKey.current = true;
			const next = new VideoDecoder({
				output: (frame) => {
					const context = canvas.current?.getContext('2d');
					if (!disposed && context && canvas.current) {
						if (
							canvas.current.width !== frame.displayWidth ||
							canvas.current.height !== frame.displayHeight
						) {
							canvas.current.width = frame.displayWidth;
							canvas.current.height = frame.displayHeight;
						}
						context.drawImage(frame, 0, 0);
					}
					frame.close();
				},
				error: () => {
					waitingKey.current = true;
					recover();
				},
			});
			next.configure({
				codec: config.codec,
				codedWidth: config.width,
				codedHeight: config.height,
				description: Uint8Array.from(atob(config.description), (char) => char.charCodeAt(0)),
				optimizeForLatency: true,
				hardwareAcceleration: 'prefer-hardware',
			});
			decoder.current = next;
		};
		// spec/browser-and-simulator#sim-tab: the task's own view, and the frames of the device it shows.
		const offEvent = window.brigadir.onSimulatorEvent((event) => {
			if (disposed) return;
			if ('state' in event) {
				if (event.key.projectId === projectId && event.key.id === taskId) setState(event.state);
			} else if ('config' in event) {
				if (event.device === shown.current) configure(event.config);
			} else if ('tap' in event && event.device === shown.current) {
				const tap = { ...event.tap, key: Date.now() + Math.random() };
				setTaps((list) => [...list, tap]);
				window.setTimeout(() => setTaps((list) => list.filter((item) => item !== tap)), 600);
			}
		});
		const offFrame = window.brigadir.onSimulatorFrame((frame) => {
			const active = decoder.current;
			if (disposed || frame.device !== shown.current || !active || active.state !== 'configured')
				return;
			if (waitingKey.current && !frame.key) return;
			waitingKey.current = false;
			// A decoder that falls behind drops to the next key frame instead of queuing latency.
			if (active.decodeQueueSize > 6) {
				waitingKey.current = true;
				return;
			}
			active.decode(
				new EncodedVideoChunk({
					type: frame.key ? 'key' : 'delta',
					timestamp: frame.timestamp,
					data: frame.data,
				})
			);
		});
		void command({ kind: 'state' }).then((value) => {
			if (!disposed && value) setState(value as SimulatorState);
		});
		void command({ kind: 'watch', on: true });
		return () => {
			disposed = true;
			clearTimeout(recovering);
			offEvent();
			offFrame();
			if (decoder.current && decoder.current.state !== 'closed') decoder.current.close();
			decoder.current = null;
			void window.brigadir
				.simulatorCommand({ projectId, id: taskId }, { kind: 'watch', on: false })
				.catch(() => {});
		};
	}, [projectId, taskId]);
	// Another device on screen (the task's lease moved): its config and a key frame.
	const deviceId = state?.device?.id ?? null;
	useEffect(() => {
		shown.current = deviceId;
		if (deviceId) void command({ kind: 'keyframe' });
	}, [deviceId]);
	// spec/remote-access-and-mobile#networking: a window of another machine that reconnected is a new client there — it watches again and gets the
	// config and a key frame, as when it opened.
	const remoteEpoch = useRemote((store) => store.epoch);
	useEffect(() => {
		if (!remoteMachine || !remoteEpoch) return;
		waitingKey.current = true;
		void window.brigadir
			.simulatorCommand({ projectId, id: taskId }, { kind: 'watch', on: true })
			.catch(() => {});
	}, [remoteEpoch]);
	useEffect(
		() =>
			window.brigadir.onWorkspaceAction((action) => {
				if (action === 'simulator-home') void command({ kind: 'button', name: 'home' });
				if (action === 'simulator-rotate') void command({ kind: 'rotate' });
				if (action === 'simulator-reload') void command({ kind: 'reload' });
				// spec/remote-access-and-mobile#client-ui-seam: DevTools would open on the screen of the machine this window shows.
				if (action === 'simulator-devtools' && !remoteMachine) void command({ kind: 'devtools' });
				if (action === 'simulator-shutdown') void command({ kind: 'shutdown' });
				if (action === 'simulator-screenshot') void sendScreenshot();
			}),
		[projectId, taskId, locale]
	);
	// The screen keeps the device's aspect inside the stage: the frame, not the column, decides the shape.
	useEffect(() => {
		const element = stage.current;
		if (!element) return;
		const observer = new ResizeObserver(([entry]) => {
			if (entry) setBox({ width: entry.contentRect.width, height: entry.contentRect.height });
		});
		observer.observe(element);
		return () => observer.disconnect();
	}, [state?.status]);
	async function sendScreenshot() {
		const result = (await command({ kind: 'screenshot' })) as {
			image?: unknown;
			mimeType?: unknown;
		} | null;
		// Both helpers answer a PNG, the format of chat attachments (spec/browser-and-simulator#simulator).
		if (typeof result?.image !== 'string' || result.mimeType !== 'image/png') return;
		await attachTaskContext(task, {
			kind: 'image',
			mimeType: 'image/png',
			name: t(locale, 'Screenshot'),
			data: result.image,
		}).catch(() => notify('error', t(locale, 'Could not attach the screenshot.')));
	}
	// The box of a turned canvas is the upright interface; the touch goes back to the device frame.
	function point(event: ReactPointerEvent<HTMLCanvasElement>) {
		const rect = event.currentTarget.getBoundingClientRect();
		return devicePoint(
			orientation,
			Math.min(1, Math.max(0, (event.clientX - rect.left) / rect.width)),
			Math.min(1, Math.max(0, (event.clientY - rect.top) / rect.height))
		);
	}
	const device = state?.device ?? null,
		screen = state?.screen ?? (device ? { width: 402, height: 874 } : null),
		orientation = state?.orientation ?? 'portrait',
		angle = orientationAngle(orientation);
	// The upright screen: a turned device lies on its side, the frame keeps the device's portrait pixels.
	const upright =
		screen && isLandscape(orientation) ? { width: screen.height, height: screen.width } : screen;
	const bezel = 12,
		fit =
			upright && box.width && box.height
				? Math.min(
						(box.width - 48 - bezel * 2) / upright.width,
						(box.height - 48 - bezel * 2) / upright.height
					)
				: 0;
	// spec/browser-and-simulator#sim-tab: the picker groups devices by platform, iOS first, and ends each row with who holds the device.
	const picker = state ? pickerModel(state, locale, tasks, anyway) : null;
	const deviceGroups = picker?.grouped
		? {
				ios: { label: 'iOS', icon: <Glyph name="platform-apple" size={11} /> },
				android: { label: 'Android', icon: <Glyph name="platform-android" size={11} /> },
			}
		: undefined;
	// spec/task-window-workspace#tool-tab-look: a running device has a green dot on its glyph and its own
	// shut-down button after its tail; no «Shut down …» row under the list.
	const deviceOptions = (picker?.rows ?? []).map((row) => ({
		value: row.device.id,
		label: row.label,
		tail: row.tail,
		disabled: row.disabled,
		...(row.running ? { live: true } : {}),
		...(row.canShutDown
			? {
					action: {
						label: t(locale, 'Shut down {device}').replace('{device}', row.device.name),
						icon: <Glyph name="quit" size={13} />,
						run: () => void command({ kind: 'shutdown', device: row.device.id }),
					},
				}
			: {}),
		...(picker?.grouped ? { group: row.device.platform } : {}),
		icon: (
			<Glyph
				name={row.device.platform === 'ios' ? 'platform-apple' : 'platform-android'}
				size={12}
			/>
		),
	}));
	const footer = picker?.footer
		? {
				text: picker.footer.text,
				...(picker.footer.tone ? { tone: picker.footer.tone } : {}),
				...('lift' in picker.footer
					? { action: { label: t(locale, 'Start anyway'), run: () => setAnyway(true) } }
					: {}),
			}
		: undefined;
	const live = state?.status === 'on';
	const machineName = useRemote((store) => store.session?.machineName) || remoteMachine?.name || '';
	/** ⌘V: this Mac's clipboard locally; in a window of another machine, this device's (spec/remote-access-and-mobile#browser-from-device). */
	const paste = () => {
		if (!remoteMachine) return void command({ kind: 'paste' });
		void window.brigadir
			.readClipboardText()
			.then((text) => (text ? command({ kind: 'paste', text: text.slice(0, 10_000) }) : null))
			.catch(() => {});
	};
	return (
		<section data-simulator="true" className={styles.panel} aria-label={t(locale, 'Simulator')}>
			<div className={styles.strip} data-size="m">
				{device ? (
					// A ghost trigger in the strip; the list marks the chosen device with ✓.
					<PopupMarks.Provider value>
						<Popup
							ghost
							label={t(locale, 'Simulator')}
							value={device.id}
							options={deviceOptions}
							{...(deviceGroups ? { groups: deviceGroups } : {})}
							{...(footer ? { footer } : {})}
							onOpenChange={(open) => {
								if (!open) setAnyway(false);
							}}
							displayValue={
								picker?.queued ? (
									<span className={styles.queued}>{picker.trigger}</span>
								) : (
									picker?.trigger
								)
							}
							icon={
								<Glyph
									name={device.platform === 'ios' ? 'platform-apple' : 'platform-android'}
									size={12}
								/>
							}
							onChange={(value) => {
								const row = picker?.rows.find((item) => item.device.id === value);
								void command({ kind: 'select', device: value }).then(() => {
									// A device that is off starts at once when the person lifted the low-memory block for it.
									if (row && !row.running && anyway) void command({ kind: 'boot', anyway: true });
								});
							}}
						/>
					</PopupMarks.Provider>
				) : (
					<span className={styles.muted}>{t(locale, 'No simulators')}</span>
				)}
				<span className={styles.spacer} />
				{/* spec/remote-access-and-mobile#client-ui-seam: the simulator runs on the working machine; its name is in the strip. */}
				{remoteMachine && (
					<MachineTag
						name={machineName}
						title={fill(locale, 'The simulator runs on {machine}', { machine: machineName })}
					/>
				)}
				{live &&
					(state?.metro ? (
						<span
							className={styles.metro}
							title={`Metro · ${state.metro.appId || 'app'} · 127.0.0.1:${state.metro.port} · ${state.metro.root}`}>
							<i />
							Metro :{state.metro.port}
						</span>
					) : (
						<span
							className={styles.metro}
							data-missing="true"
							title={t(locale, 'Metro is not running in this task')}>
							<i />
							{t(locale, 'No Metro')}
						</span>
					))}
			</div>
			<div className={styles.strip} data-size="m">
				<IconButton
					disabled={!live}
					label={t(locale, 'Home')}
					onClick={() => {
						void command({ kind: 'button', name: 'home' });
					}}>
					<Glyph name="sim-home" size={14} />
				</IconButton>
				{device?.platform === 'android' && (
					<IconButton
						disabled={!live}
						label={t(locale, 'Back')}
						onClick={() => {
							void command({ kind: 'button', name: 'back' });
						}}>
						<Glyph name="back" size={13} />
					</IconButton>
				)}
				<IconButton
					disabled={!live}
					label={t(locale, 'Rotate')}
					onClick={() => {
						void command({ kind: 'rotate' });
					}}>
					<Glyph name="sim-rotate" size={14} />
				</IconButton>
				<span className={styles.divider} />
				<Button
					variant="ghost"
					disabled={!state?.metro}
					onClick={() => {
						void command({ kind: 'reload' });
					}}>
					<Glyph name="refresh" size={13} />
					{t(locale, 'Reload app')}
				</Button>
				{!remoteMachine && (
					<Button
						variant="ghost"
						disabled={!state?.metro}
						onClick={() => {
							void command({ kind: 'devtools' });
						}}>
						<Glyph name="sim-devtools" size={13} />
						DevTools
					</Button>
				)}
				<span className={styles.spacer} />
				<Button
					variant="ghost"
					disabled={!live}
					onClick={() => {
						void sendScreenshot();
					}}>
					<Glyph name="camera" size={13} />
					{t(locale, 'Screenshot to chat')}
				</Button>
			</div>
			<div ref={stage} className={styles.stage}>
				{!state ? null : !state.toolchain.ios && !state.toolchain.android && !device ? (
					// spec/architecture-and-platform#linux-package: a Linux machine runs Android simulators only.
					<div className={styles.empty}>
						<Glyph name="platform-android" size={36} />
						<strong>{t(locale, 'Android SDK not found')}</strong>
						<span>
							{t(
								locale,
								'Install Android Studio to run Android simulators. iOS simulators need macOS.'
							)}
						</span>
					</div>
				) : !state.toolchain.xcode && !device ? (
					<div className={styles.empty}>
						<Glyph name="platform-apple" size={36} />
						<strong>{t(locale, 'Xcode not found')}</strong>
						<span>{t(locale, 'Install Xcode from the App Store to run iOS simulators.')}</span>
					</div>
				) : state.status === 'booting' ? (
					<div className={styles.empty} role="status">
						<span className={styles.spinner} />
						<span>
							{t(locale, '{device} is starting…').replace('{device}', device?.name ?? '')}
						</span>
						{/* spec/browser-and-simulator#sim-cap: a boot that waits at the gate says why. */}
						{picker?.waitReason && (
							<span data-tone={picker.waitReason.tone} className={styles.gate}>
								{picker.waitReason.text}
							</span>
						)}
					</div>
				) : !device ? (
					// No device on this machine: say so instead of « is off» without a name.
					<div className={styles.empty}>
						<Glyph name="simulator" size={40} />
						<strong>{t(locale, 'No simulators')}</strong>
						<span>
							{t(
								locale,
								state.toolchain.xcode && state.toolchain.android
									? 'Create a simulator in Xcode or Android Studio, then check again.'
									: state.toolchain.xcode
										? 'Create a simulator in Xcode, then check again.'
										: 'Create a virtual device in Android Studio, then check again.'
							)}
						</span>
						<Button
							onClick={() => {
								void command({ kind: 'refresh' }).then((result) => {
									if (result) setState(result as SimulatorState);
								});
							}}>
							{t(locale, 'Check')}
						</Button>
					</div>
				) : !live ? (
					// spec/browser-and-simulator#sim-cap: at the cap there is no Start; under low memory Start becomes Start anyway.
					<div className={styles.empty}>
						<Glyph name="simulator" size={40} />
						<strong>
							{state.error ?? t(locale, '{device} is off').replace('{device}', device.name)}
						</strong>
						{picker?.footer && (
							<span data-tone={picker.footer.tone} className={styles.gate}>
								{picker.footer.text}
							</span>
						)}
						{state.gate.running < state.gate.max && (
							<Button
								appearance="primary"
								onClick={() => {
									void command(
										state.gate.lowMemory ? { kind: 'boot', anyway: true } : { kind: 'boot' }
									);
								}}>
								{t(locale, state.gate.lowMemory ? 'Start anyway' : 'Start')}
							</Button>
						)}
					</div>
				) : (
					<div
						className={styles.bezel}
						style={{ padding: bezel, borderRadius: Math.round(52 * fit) + bezel }}>
						<div
							className={styles.upright}
							style={{ width: upright!.width * fit, height: upright!.height * fit }}>
							<canvas
								ref={canvas}
								className={styles.screen}
								tabIndex={0}
								aria-label={t(locale, 'Simulator screen')}
								data-orientation={orientation}
								style={{
									width: screen!.width * fit,
									height: screen!.height * fit,
									borderRadius: Math.round(52 * fit),
									transform: angle
										? `translate(-50%,-50%) rotate(${angle}deg)`
										: 'translate(-50%,-50%)',
								}}
								onPointerDown={(event) => {
									event.currentTarget.focus();
									event.currentTarget.setPointerCapture(event.pointerId);
									pointer.current = event.pointerId;
									void command({ kind: 'touch', phase: 'down', ...point(event) });
								}}
								onPointerMove={(event) => {
									if (pointer.current === event.pointerId)
										void command({ kind: 'touch', phase: 'move', ...point(event) });
								}}
								onPointerUp={(event) => {
									if (pointer.current !== event.pointerId) return;
									pointer.current = null;
									void command({ kind: 'touch', phase: 'up', ...point(event) });
								}}
								onPointerCancel={(event) => {
									if (pointer.current !== event.pointerId) return;
									pointer.current = null;
									void command({ kind: 'touch', phase: 'up', ...point(event) });
								}}
								onKeyDown={(event) => {
									if (
										(event.metaKey || (!!remoteMachine && event.ctrlKey)) &&
										(event.key.toLowerCase() === 'v' || event.code === 'KeyV')
									) {
										event.preventDefault();
										paste();
										return;
									}
									if (event.metaKey) return;
									const usage = hidUsage(event.code);
									if (usage === null) return;
									event.preventDefault();
									if (!event.repeat) void command({ kind: 'key', usage, down: true });
								}}
								onKeyUp={(event) => {
									const usage = hidUsage(event.code);
									if (usage === null || event.metaKey) return;
									event.preventDefault();
									void command({ kind: 'key', usage, down: false });
								}}
							/>
							{/* spec/browser-and-simulator#simulator: an agent's touch shows as an accent ring with who pressed what; it fades by itself. */}
						</div>
						{taps.map((tap) => (
							<span
								key={tap.key}
								className={styles.tap}
								role="status"
								style={{
									left: bezel + tap.x * upright!.width * fit,
									top: bezel + tap.y * upright!.height * fit,
								}}>
								<span className={styles.tapLabel}>{tap.label}</span>
							</span>
						))}
					</div>
				)}
			</div>
			{/* spec/browser-and-simulator#simulator: without Metro the app shows the dev client launcher; Metro starts from a project command or the console. */}
			{live && !state?.metro && (
				<div className={styles.warning} data-size="s" role="status">
					<Glyph name="review-warning" size={13} />
					<span>{t(locale, 'Metro is not running in this task')}</span>
					{commandsOn && (
						<Button
							onClick={() =>
								dispatchEvent(new CustomEvent('brigadir:search', { detail: 'commands' }))
							}>
							<Glyph name="command-play" size={12} />
							{t(locale, 'Commands…')}
						</Button>
					)}
				</div>
			)}
		</section>
	);
}
