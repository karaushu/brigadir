import { isRecord } from './workspace';
import type { TaskKey } from './session';
/**
 * spec/browser-and-simulator#simulator: the simulator column. A task shows the device it holds a lease on, else the project's device
 * (spec/browser-and-simulator#sim-lease). `id` is the simctl UDID (iOS) or the AVD name (Android).
 */
export const simulatorPlatforms = ['ios', 'android'] as const;
export type SimulatorPlatform = (typeof simulatorPlatforms)[number];
/** project.json `simulator`: the project's default device (spec/browser-and-simulator#sim-device). */
export type ProjectSimulator = { platform: SimulatorPlatform; device: string };
/**
 * spec/browser-and-simulator#sim-lease: one task's record in `projects/<id>/simulator-devices.json`: its lease (`platform`, `device`). `own` — a copy made for this task
 * (spec/browser-and-simulator#sim-own-device), `reinstalled` once its apps run from its own folders.
 */
export type SimulatorLease = {
	platform: SimulatorPlatform;
	device: string;
	own?: { source: string; reinstalled: boolean };
};
export type SimulatorLeases = Record<string, SimulatorLease>;
const deviceId = (value: unknown) =>
	typeof value === 'string' && /^[A-Za-z0-9._-]{1,128}$/.test(value);
export function isSimulatorLease(value: unknown): value is SimulatorLease {
	if (!isRecord(value)) return false;
	return (
		Object.keys(value).every((key) => ['platform', 'device', 'own'].includes(key)) &&
		simulatorPlatforms.includes(value.platform as SimulatorPlatform) &&
		deviceId(value.device) &&
		(value.own === undefined ||
			(isRecord(value.own) &&
				Object.keys(value.own).length === 2 &&
				deviceId(value.own.source) &&
				typeof value.own.reinstalled === 'boolean'))
	);
}
/** Leases of a document read from disk; an entry that does not validate is dropped, the others stay. */
export function simulatorLeases(value: unknown): SimulatorLeases {
	const leases: SimulatorLeases = {};
	if (!isRecord(value)) return leases;
	for (const [taskId, lease] of Object.entries(value))
		// `<taskId>.<udid>`: a copy its task left, kept until it is deleted (spec/browser-and-simulator#sim-own-device).
		if (/^[A-Za-z0-9_-]{1,128}(\.[A-Za-z0-9-]{1,64})?$/.test(taskId) && isSimulatorLease(lease))
			leases[taskId] = lease;
	return leases;
}
/**
 * spec/browser-and-simulator#sim-tab: who holds a device, seen from one task. `mine` — the task's own device; `queued` — its own device while
 * another task holds the lane; `task` — another task holds, owns or alone leases it; `tasks` — several other leases, none using it now.
 * A device missing from `uses` is free.
 */
export type SimulatorUse =
	/** `heldBy` — another task with a lease on it is using it now; `busy` — it is another task's own copy. Either: no Shut down. */
	| { kind: 'mine'; heldBy?: TaskKey; busy?: true }
	| { kind: 'queued'; holder: TaskKey }
	/** `busy` — that task is using the device now or it is that task's own copy: no Shut down. */
	| { kind: 'task'; task: TaskKey; busy?: true }
	| { kind: 'tasks'; count: number };
/** spec/browser-and-simulator#sim-cap: booted devices against the cap, and whether the system reports memory pressure. */
export type SimulatorGate = { running: number; max: number; lowMemory: boolean };
/** The fewest and most local devices the setting allows (spec/browser-and-simulator#sim-cap). */
export const simulatorDeviceLimits = { min: 1, max: 8, default: 2 } as const;
export function isSimulatorDeviceLimit(value: unknown): value is number {
	return (
		Number.isSafeInteger(value) &&
		Number(value) >= simulatorDeviceLimits.min &&
		Number(value) <= simulatorDeviceLimits.max
	);
}
/** Whether a device that is off may start now: under the cap, and memory not low unless the person lifted that block. */
export function gateOpen(gate: SimulatorGate, anyway = false) {
	return gate.running < gate.max && (!gate.lowMemory || anyway);
}
/**
 * spec/browser-and-simulator#sim-lease: the devices a `device` argument names, best first. Exact id, then exact name, then a kind (`iPhone`,
 * `iPad`, `Android`) or a part of the name, ignoring case; among equals a running device and a newer OS come first.
 */
export function matchDevices(
	devices: readonly SimulatorDevice[],
	wanted: string
): SimulatorDevice[] {
	const text = wanted.trim().toLocaleLowerCase();
	if (!text) return [];
	const exact = devices.filter((device) => device.id === wanted.trim());
	if (exact.length) return exact;
	const order = (list: SimulatorDevice[]) =>
		[...list].sort(
			(a, b) =>
				Number(b.booted) - Number(a.booted) ||
				osNumber(b.os) - osNumber(a.os) ||
				a.name.localeCompare(b.name)
		);
	const named = devices.filter((device) => device.name.toLocaleLowerCase() === text);
	if (named.length) return order(named);
	const kind = devices.filter((device) =>
		text === 'android'
			? device.platform === 'android'
			: text === 'ios'
				? device.platform === 'ios'
				: device.name.toLocaleLowerCase().includes(text)
	);
	return order(kind);
}
const osNumber = (os: string) => Number(/(\d+(?:\.\d+)?)/.exec(os)?.[1] ?? 0);
export type SimulatorDevice = {
	id: string;
	name: string;
	platform: SimulatorPlatform;
	os: string;
	booted: boolean;
};
/** What main found on this Mac; a label like `Xcode 27` or null when missing (spec/browser-and-simulator#simulator). */
export type SimulatorToolchain = {
	xcode: string | null;
	android: string | null;
	/** spec/architecture-and-platform#linux-package: whether this machine can run iOS simulators at all — macOS only. */
	ios: boolean;
};
export type SimulatorStatus = 'off' | 'booting' | 'on' | 'error';
/**
 * How the interface stands on the device. The iOS frame stays in the device's portrait pixels with the content turned,
 * and touches go in those pixels too; the accessibility tree speaks interface points. Android's stream turns itself,
 * so an Android device is always `portrait` here.
 */
export const simulatorOrientations = [
	'portrait',
	'landscapeLeft',
	'landscapeRight',
	'portraitUpsideDown',
] as const;
export type SimulatorOrientation = (typeof simulatorOrientations)[number];
/** Degrees the column turns the device frame so the interface stands upright. */
export function orientationAngle(orientation: SimulatorOrientation) {
	return orientation === 'landscapeLeft'
		? -90
		: orientation === 'landscapeRight'
			? 90
			: orientation === 'portraitUpsideDown'
				? 180
				: 0;
}
export function isLandscape(orientation: SimulatorOrientation) {
	return orientation === 'landscapeLeft' || orientation === 'landscapeRight';
}
/** A point of the upright interface (0..1) as a point of the device frame (0..1), where touches land. */
export function devicePoint(orientation: SimulatorOrientation, x: number, y: number) {
	switch (orientation) {
		case 'landscapeLeft':
			return { x: 1 - y, y: x };
		case 'landscapeRight':
			return { x: y, y: 1 - x };
		case 'portraitUpsideDown':
			return { x: 1 - x, y: 1 - y };
		default:
			return { x, y };
	}
}
/**
 * One task's view of the simulator. `device` — the task's lease, else the project's device; `screen` is the device in its portrait points;
 * `orientation` turns it; `metro` — the Metro the task's client attached to, for the column's chip; `uses` — who holds each device
 * (spec/browser-and-simulator#sim-tab); `gate` — spec/browser-and-simulator#sim-cap; `metroPort` — the task's own port (spec/browser-and-simulator#metro-port).
 */
export type SimulatorState = {
	toolchain: SimulatorToolchain;
	devices: SimulatorDevice[];
	device: SimulatorDevice | null;
	status: SimulatorStatus;
	error: string | null;
	screen: { width: number; height: number } | null;
	orientation: SimulatorOrientation;
	metro: { port: number; appId: string; root: string } | null;
	uses: Record<string, SimulatorUse>;
	gate: SimulatorGate;
	metroPort: number | null;
	/** spec/browser-and-simulator#sim-cap: this task's boot waits at the gate (the cap or low memory); the tab says why. */
	gateWait?: boolean;
};
/** WebCodecs `VideoDecoder.configure` input: AVCC H.264, `description` is the avcC record in base64. */
export type SimulatorVideoConfig = {
	codec: string;
	width: number;
	height: number;
	description: string;
};
export type SimulatorFrame = { key: boolean; timestamp: number; data: Uint8Array };
/**
 * `state` — one task's view; `config` and `tap` belong to a device (every tab showing it takes them); `tap` marks an agent's touch for
 * ~600 ms; `show` opens the column in the agent's task.
 */
export type SimulatorEvent =
	| { key: TaskKey; state: SimulatorState }
	| { device: string; config: SimulatorVideoConfig }
	| { device: string; tap: { x: number; y: number; label: string } }
	| { show: TaskKey }
	/** spec/agents-and-providers#tools-awareness: the tasks of the project whose agent waits for a device, in queue order. */
	| { projectId: string; waiting: string[] };
/** `back` is Android's; iOS has no hardware Back. */
export type SimulatorButton = 'home' | 'lock' | 'back';
export type SimulatorCommand =
	| { kind: 'state' }
	| { kind: 'refresh' }
	/** spec/browser-and-simulator#sim-lease: the task's lease moves to this device (the person's pick also sets the project's). */
	| { kind: 'select'; device: string }
	/** spec/browser-and-simulator#sim-cap: `anyway` — the person lifted the low-memory block for this start. */
	| { kind: 'boot'; anyway?: true }
	/** spec/task-window-workspace#tool-tab-look.1: `device` shuts that running device down from the picker; without it, the project's device. */
	| { kind: 'shutdown'; device?: string }
	/** The column is on screen: frames flow while at least one column of the project watches. */
	| { kind: 'watch'; on: boolean }
	/** The decoder lost the stream: the config again and a key frame. */
	| { kind: 'keyframe' }
	| { kind: 'touch'; phase: 'down' | 'move' | 'up'; x: number; y: number }
	| { kind: 'key'; usage: number; down: boolean }
	| { kind: 'text'; text: string }
	/**
	 * ⌘V in the column: main reads the Mac clipboard (the renderer never does). A window of another machine sends the
	 * device's clipboard text instead (spec/remote-access-and-mobile#browser-from-device).
	 */
	| { kind: 'paste'; text?: string }
	| { kind: 'button'; name: SimulatorButton }
	| { kind: 'screenshot' }
	/** Through Metro: reload the JS, open React Native DevTools. */
	| { kind: 'reload' }
	| { kind: 'devtools' }
	/** Turn right, like ⌘→ in Simulator.app. */
	| { kind: 'rotate' };
const unit = (value: unknown) =>
	typeof value === 'number' && Number.isFinite(value) && value >= 0 && value <= 1;
export function isProjectSimulator(value: unknown): value is ProjectSimulator {
	return (
		isRecord(value) &&
		Object.keys(value).length === 2 &&
		simulatorPlatforms.includes(value.platform as SimulatorPlatform) &&
		typeof value.device === 'string' &&
		/^[A-Za-z0-9._-]{1,128}$/.test(value.device)
	);
}
export function isSimulatorCommand(value: unknown): value is SimulatorCommand {
	if (!isRecord(value)) return false;
	switch (value.kind) {
		case 'state':
		case 'refresh':
		case 'shutdown':
			return (
				Object.keys(value).length === 1 ||
				(Object.keys(value).length === 2 &&
					typeof value.device === 'string' &&
					/^[A-Za-z0-9._-]{1,128}$/.test(value.device))
			);
		case 'boot':
			return (
				Object.keys(value).length === 1 ||
				(Object.keys(value).length === 2 && value.anyway === true)
			);
		case 'paste':
			return (
				Object.keys(value).length === 1 ||
				(Object.keys(value).length === 2 &&
					typeof value.text === 'string' &&
					value.text.length > 0 &&
					value.text.length <= 10_000)
			);
		case 'screenshot':
		case 'keyframe':
		case 'reload':
		case 'devtools':
		case 'rotate':
			return Object.keys(value).length === 1;
		case 'select':
			return typeof value.device === 'string' && /^[A-Za-z0-9._-]{1,128}$/.test(value.device);
		case 'watch':
			return typeof value.on === 'boolean';
		case 'touch':
			return (
				['down', 'move', 'up'].includes(value.phase as string) && unit(value.x) && unit(value.y)
			);
		case 'key':
			return (
				Number.isSafeInteger(value.usage) &&
				Number(value.usage) >= 0 &&
				Number(value.usage) <= 0xffff &&
				typeof value.down === 'boolean'
			);
		case 'text':
			return typeof value.text === 'string' && value.text.length > 0 && value.text.length <= 10_000;
		case 'button':
			return value.name === 'home' || value.name === 'lock' || value.name === 'back';
		default:
			return false;
	}
}
/** `iPhone 17 Pro · iOS 27`, the label of the device picker (spec/browser-and-simulator#simulator). */
export function simulatorDeviceLabel(device: SimulatorDevice) {
	return `${device.name} · ${device.os}`;
}
/** USB HID usage (page 7) of a `KeyboardEvent.code`; the device gets physical keys, the layout is the device's. */
export function hidUsage(code: string): number | null {
	const letter = /^Key([A-Z])$/.exec(code);
	if (letter) return 0x04 + letter[1]!.charCodeAt(0) - 65;
	const digit = /^Digit([0-9])$/.exec(code);
	if (digit) return digit[1] === '0' ? 0x27 : 0x1e + Number(digit[1]) - 1;
	const named: Record<string, number> = {
		Enter: 0x28,
		Escape: 0x29,
		Backspace: 0x2a,
		Tab: 0x2b,
		Space: 0x2c,
		Minus: 0x2d,
		Equal: 0x2e,
		BracketLeft: 0x2f,
		BracketRight: 0x30,
		Backslash: 0x31,
		Semicolon: 0x33,
		Quote: 0x34,
		Backquote: 0x35,
		Comma: 0x36,
		Period: 0x37,
		Slash: 0x38,
		CapsLock: 0x39,
		ArrowRight: 0x4f,
		ArrowLeft: 0x50,
		ArrowDown: 0x51,
		ArrowUp: 0x52,
		Delete: 0x4c,
		Home: 0x4a,
		End: 0x4d,
		PageUp: 0x4b,
		PageDown: 0x4e,
		ControlLeft: 0xe0,
		ShiftLeft: 0xe1,
		AltLeft: 0xe2,
		MetaLeft: 0xe3,
		ControlRight: 0xe4,
		ShiftRight: 0xe5,
		AltRight: 0xe6,
		MetaRight: 0xe7,
	};
	return named[code] ?? null;
}
