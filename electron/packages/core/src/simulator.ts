import { isRecord } from './workspace';
/**
 * spec/browser-and-simulator#simulator: the simulator column. A device belongs to the project, not the task: every task of the project shows the same
 * device and the same frames. `id` is the simctl UDID (iOS) or the AVD name (Android).
 */
export const simulatorPlatforms = ['ios', 'android'] as const;
export type SimulatorPlatform = (typeof simulatorPlatforms)[number];
/** project.json `simulator`: the device the project chose last. */
export type ProjectSimulator = { platform: SimulatorPlatform; device: string };
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
/** `metro` — the Metro of the project the client attached to, for the column's chip. */
/** `screen` is the device in its portrait points; `orientation` turns it; `metros` — every Metro of the project found. */
export type SimulatorState = {
	toolchain: SimulatorToolchain;
	devices: SimulatorDevice[];
	device: SimulatorDevice | null;
	status: SimulatorStatus;
	error: string | null;
	screen: { width: number; height: number } | null;
	orientation: SimulatorOrientation;
	metro: { port: number; appId: string; root: string } | null;
};
/** WebCodecs `VideoDecoder.configure` input: AVCC H.264, `description` is the avcC record in base64. */
export type SimulatorVideoConfig = {
	codec: string;
	width: number;
	height: number;
	description: string;
};
export type SimulatorFrame = { key: boolean; timestamp: number; data: Uint8Array };
/** `tap` marks an agent's touch for ~600 ms; `show` opens the column in the agent's task. */
export type SimulatorEvent =
	| { projectId: string; state: SimulatorState }
	| { projectId: string; config: SimulatorVideoConfig }
	| { projectId: string; tap: { x: number; y: number; label: string } }
	| { projectId: string; show: { projectId: string; id: string } }
	/** spec/agents-and-providers#tools-awareness: the tasks of the project whose agent waits for the device, in queue order. */
	| { projectId: string; waiting: string[] };
/** `back` is Android's; iOS has no hardware Back. */
export type SimulatorButton = 'home' | 'lock' | 'back';
export type SimulatorCommand =
	| { kind: 'state' }
	| { kind: 'refresh' }
	| { kind: 'select'; device: string }
	| { kind: 'boot' }
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
