import { execFile, spawn, type ChildProcess } from 'node:child_process';
import { access, readFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import { promisify } from 'node:util';
import {
	devicePoint,
	findElement,
	formatUi,
	hidUsage,
	isLandscape,
	isRecord,
	simulatorOrientations,
	simulatorUi,
	simulatorDeviceLabel,
	type SimulatorOrientation,
	type ProjectSimulator,
	type SimulatorAgentCommand,
	type TaskKey,
	type SimulatorCommand,
	type SimulatorDevice,
	type SimulatorEvent,
	type SimulatorFrame,
	type SimulatorState,
	type SimulatorToolchain,
	type SimulatorVideoConfig,
} from '@brigadir/core';
import { SessionStore } from '@brigadir/persistence';
import {
	MetroSession,
	appRequests,
	formatLogs,
	formatRequest,
	formatRequests,
	type MetroDeps,
} from './metro';
const run = promisify(execFile);
const metroMissing =
	'Metro is not attached: start Metro in this task (a project command or the console), then open the app.';
/**
 * spec/browser-and-simulator#simulator: devices, their lifecycle and the frames of the simulator column. A device belongs to the project; one
 * helper per booted device streams H.264 and takes input: `sim-helper` for iOS, `android.cjs` over
 * scrcpy-server for an Android emulator; both speak the same stdout/stdin protocol. Devices the app booted itself are shut
 * down when the app quits or the module is switched off; devices booted by someone else are left as they are.
 */
type LogStream = { appId: string; lines: string[]; stop(): void };
type Runtime = {
	device: SimulatorDevice;
	serial: string | null;
	orientation: SimulatorOrientation;
	turned: boolean;
	logs: LogStream | null;
	helper: ChildProcess | null;
	status: SimulatorState['status'];
	error: string | null;
	screen: SimulatorState['screen'];
	config: SimulatorVideoConfig | null;
	bootedByUs: boolean;
	replies: Map<number, { resolve(value: unknown): void; reject(error: Error): void }>;
	nextId: number;
};
type Tools = {
	run: (file: string, args: string[]) => Promise<string>;
	helper: string;
	androidHelper: string;
	node: string;
	android: () => Promise<string | null>;
	avdHome: string;
	clipboard: () => Promise<string>;
	detach: (file: string, args: string[]) => void;
	stream: (file: string, args: string[], line: (text: string) => void) => () => void;
	metro?: MetroDeps;
	/** iOS needs macOS (spec/architecture-and-platform#linux-package); elsewhere `xcrun` is never run. */
	platform: NodeJS.Platform;
};
export class Simulators {
	private toolchain: SimulatorToolchain | null = null;
	private devices: SimulatorDevice[] = [];
	private runtimes = new Map<string, Runtime>();
	private selected = new Map<string, string | null>();
	private resolved = new Map<string, string | null>();
	private watchers = new Map<string, number>();
	private closed = false;
	private metros = new Map<string, MetroSession>();
	private tools: Tools;
	private sdk: string | null = null;
	constructor(
		private dataDir: string | undefined,
		helper: string,
		private emit: (event: SimulatorEvent) => void,
		private frame: (projectId: string, frame: SimulatorFrame) => void,
		tools?: Partial<Tools>
	) {
		this.tools = {
			run: async (file, args) =>
				(await run(file, args, { maxBuffer: 32 * 1024 * 1024, timeout: 120_000 })).stdout,
			helper,
			androidHelper: join(dirname(helper), 'android.cjs'),
			node: process.execPath,
			android: androidSdk,
			avdHome: join(homedir(), '.android', 'avd'),
			clipboard: async () => (await import('electron')).clipboard.readText(),
			detach: (file, args) => spawn(file, args, { detached: true, stdio: 'ignore' }).unref(),
			stream: lineStream,
			platform: process.platform,
			...tools,
		};
	}
	async command(projectId: string, command: SimulatorCommand): Promise<unknown> {
		if (this.closed) throw new Error('The simulator is off in Settings.');
		switch (command.kind) {
			case 'state':
				return this.state(projectId);
			case 'refresh':
				this.toolchain = null;
				await this.refresh();
				return this.publish(projectId);
			case 'select':
				return this.select(projectId, command.device);
			case 'boot':
				return this.boot(projectId);
			case 'shutdown':
				return this.shutdown(projectId, command.device);
			case 'watch': {
				const count = Math.max(0, (this.watchers.get(projectId) ?? 0) + (command.on ? 1 : -1));
				this.watchers.set(projectId, count);
				const runtime = await this.runtime(projectId);
				if (command.on && runtime?.config) {
					this.emit({ projectId, config: runtime.config });
					this.send(runtime, { cmd: 'keyframe' });
				}
				return null;
			}
			case 'keyframe': {
				const runtime = await this.runtime(projectId);
				if (runtime?.config) {
					this.emit({ projectId, config: runtime.config });
					this.send(runtime, { cmd: 'keyframe' });
				}
				return null;
			}
			case 'touch': {
				const runtime = await this.live(projectId);
				this.send(runtime, { cmd: 'touch', phase: command.phase, x: command.x, y: command.y });
				return null;
			}
			case 'key': {
				const runtime = await this.live(projectId);
				this.send(runtime, { cmd: 'key', usage: command.usage, down: command.down });
				return null;
			}
			case 'button':
				return this.request(await this.live(projectId), { cmd: 'button', name: command.name });
			case 'text':
				return this.request(await this.live(projectId), { cmd: 'text', text: command.text });
			case 'paste':
				return this.paste(projectId, command.text);
			case 'screenshot':
				return this.screenshot(await this.live(projectId));
			case 'reload':
				return this.reload(projectId);
			case 'devtools':
				return this.devtools(projectId);
			case 'rotate':
				await this.rotate(await this.live(projectId));
				return this.publish(projectId);
		}
	}
	/** spec/browser-and-simulator#simulator: the agent's `simulator_*` tools, answered in compact text; the human sees every action in the column. */
	async agent(key: TaskKey, command: SimulatorAgentCommand): Promise<unknown> {
		if (this.closed) throw new Error('The simulator is off in Settings.');
		const projectId = key.projectId;
		// The agent's task tree wins when several Metros serve this device.
		void SessionStore.at(this.dataDir).then((store) =>
			this.metro(projectId).prefer(join(store.root, 'worktrees', projectId, key.id))
		);
		// spec/browser-and-simulator#sim-device: `booted` is read again, a device started in Xcode after launch counts.
		if (command.tool === 'state' || command.tool === 'open')
			await (this.toolchain ? this.listDevices() : this.refresh());
		if (command.tool === 'state') {
			const state = await this.state(projectId),
				running = state.status === 'on' || state.status === 'booting' || !!state.device?.booted,
				guessed = !this.chosen(projectId),
				lines = [
					// spec/browser-and-simulator#sim-device: the column's fallback is not the agent's device.
					state.device && !(guessed && !running)
						? `${simulatorDeviceLabel(state.device)} · ${state.status === 'on' ? 'running' : state.status === 'off' && state.device.booted ? 'booted' : state.status}${state.screen ? ` · screen ${state.screen.width}×${state.screen.height} pt` : ''}${guessed ? ' · not chosen, simulator_open uses it' : ''}`
						: 'No device is chosen for this project.',
				];
			if (state.error) lines.push(`Error: ${state.error}`);
			if (state.orientation !== 'portrait')
				lines.push(
					`Orientation: ${state.orientation} (simulator_ui gives the interface as the app draws it)`
				);
			const metros = this.metros.get(projectId)?.found ?? [];
			if (metros.length)
				lines.push(
					'Metro:',
					...metros.map(
						(item) =>
							`- :${item.port} ${item.root}${item.attached ? ' · attached' : ''}${item.device ? ' · serves this device' : ''}`
					)
				);
			lines.push(
				`Toolchain: ${state.toolchain.xcode ?? 'no Xcode'} · ${state.toolchain.android ?? 'no Android SDK'}`,
				'Simulators:',
				...state.devices.map(
					(device) =>
						`- ${simulatorDeviceLabel(device)} (${device.id})${device.booted ? ' · booted' : ''}`
				)
			);
			return lines.join('\n');
		}
		if (command.tool === 'open') {
			if (command.device) {
				if (!this.toolchain) await this.refresh();
				const wanted = command.device.toLocaleLowerCase(),
					device =
						this.devices.find((item) => item.id === command.device) ??
						this.devices.find((item) => item.name.toLocaleLowerCase() === wanted);
				if (!device)
					throw new Error(`No device named ${command.device}. Call simulator_state for the list.`);
				await this.select(projectId, device.id);
			} else {
				// spec/browser-and-simulator#sim-device: without a choice only a running device is the project's; it becomes the choice.
				const device = await this.device(projectId),
					status = device ? this.runtimes.get(device.id)?.status : undefined;
				if (!this.chosen(projectId)) {
					if (!device || !(device.booted || status === 'on' || status === 'booting'))
						throw new Error(
							'No device is chosen for this project and none is running. Pass device: the one the app is built and installed on (simulator_state lists them).'
						);
					await this.select(projectId, device.id);
				}
			}
			this.emit({ projectId, show: key });
			const runtime = await this.ready(projectId);
			if (command.app)
				await (runtime.serial
					? this.adb(runtime, [
							'shell',
							'monkey',
							'-p',
							command.app,
							'-c',
							'android.intent.category.LAUNCHER',
							'1',
						])
					: this.tools.run('/usr/bin/xcrun', ['simctl', 'launch', runtime.device.id, command.app]));
			if (command.url)
				await (runtime.serial
					? this.adb(runtime, [
							'shell',
							'am',
							'start',
							'-a',
							'android.intent.action.VIEW',
							'-d',
							command.url,
						])
					: this.tools.run('/usr/bin/xcrun', [
							'simctl',
							'openurl',
							runtime.device.id,
							command.url,
						]));
			return `${simulatorDeviceLabel(runtime.device)} is running${command.app ? `; launched ${command.app}` : ''}${command.url ? `; opened ${command.url}` : ''}.`;
		}
		if (command.tool === 'logs' && command.source !== 'native') {
			const metro = this.metros.get(projectId);
			if (!metro?.target) throw new Error(metroMissing);
			return formatLogs(metro.logs, command.level, command.grep);
		}
		if (command.tool === 'network') {
			const metro = this.metros.get(projectId);
			if (!metro?.target && !metro?.requests.size) throw new Error(metroMissing);
			if (command.requestId) {
				const item = await metro.body(command.requestId);
				if (!item)
					throw new Error(`No request ${command.requestId}. Call simulator_network for the list.`);
				return formatRequest(item);
			}
			return formatRequests(appRequests(metro), Date.now(), command.filter);
		}
		const runtime = await this.live(projectId).catch(() => {
			throw new Error('The device is not running. Call simulator_open first.');
		});
		if (command.tool === 'logs')
			return this.nativeLogs(projectId, runtime, command.level, command.grep);
		if (command.tool === 'screenshot') return this.screenshot(runtime);
		if (command.tool === 'ui')
			return formatUi(await this.ui(runtime, command.grid === true), command.offset ?? 0);
		if (command.action === 'rotate') {
			await this.rotate(runtime);
			await this.publish(projectId);
			return `Rotated to ${runtime.orientation}. Call simulator_ui: it tells whether the app turned with the device.`;
		}
		// Taps by points use the interface the last tree saw; with the device turned, read it first.
		if (
			!runtime.serial &&
			isLandscape(runtime.orientation) &&
			command.x !== undefined &&
			!command.id &&
			!command.label
		)
			await this.ui(runtime, false).catch(() => {});
		// Agent points are interface points; the marker is drawn upright, the touch lands in the device frame.
		const screen = this.interface(runtime);
		const clamp = (value: number) => Math.min(1, Math.max(0, value));
		const unit = (x: number, y: number) => ({
			x: clamp(x / screen.width),
			y: clamp(y / screen.height),
		});
		const device = (point: { x: number; y: number }) =>
			runtime.turned ? devicePoint(runtime.orientation, point.x, point.y) : point;
		const target = async () => {
			if (command.id || command.label) {
				const element = findElement(await this.ui(runtime, false), command);
				if (!element)
					throw new Error(
						`No element ${command.id ? `#${command.id}` : JSON.stringify(command.label)} on the screen. Call simulator_ui.`
					);
				const [x, y, w, h] = element.frame;
				return {
					point: unit(x + w / 2, y + h / 2),
					label: command.id ? `#${command.id}` : element.label,
				};
			}
			if (command.x === undefined || command.y === undefined)
				throw new Error('Give x and y in points, or id, or label.');
			return {
				point: unit(command.x, command.y),
				label: `${Math.round(command.x)},${Math.round(command.y)}`,
			};
		};
		switch (command.action) {
			case 'tap':
			case 'longpress': {
				const { point, label } = await target();
				this.emit({ projectId, tap: { ...point, label: `${command.action} · ${label}` } });
				await this.request(runtime, { cmd: command.action, ...device(point) });
				return `${command.action === 'tap' ? 'Tapped' : 'Long-pressed'} ${label}.`;
			}
			case 'swipe': {
				const { point } = await target();
				if (command.x2 === undefined || command.y2 === undefined)
					throw new Error('Give x2 and y2 in points for the end of the swipe.');
				const end = device(unit(command.x2, command.y2)),
					start = device(point);
				this.emit({ projectId, tap: { ...point, label: 'swipe' } });
				await this.request(runtime, {
					cmd: 'swipe',
					x1: start.x,
					y1: start.y,
					x2: end.x,
					y2: end.y,
				});
				return 'Swiped.';
			}
			case 'type': {
				if (!command.text) throw new Error('Give the text to type.');
				if (runtime.serial || /^[\x20-\x7e\n\t]*$/.test(command.text)) {
					await this.request(runtime, { cmd: 'text', text: command.text });
					return `Typed ${command.text.length} characters.`;
				}
				await this.pasteboard(runtime, command.text);
				return 'The text is on the device pasteboard: long-press the field and tap Paste.';
			}
			case 'key': {
				const usage = command.key
					? hidUsage(command.key.length === 1 ? `Key${command.key.toUpperCase()}` : command.key)
					: null;
				if (usage === null)
					throw new Error(
						'Unknown key. Use a KeyboardEvent code such as Enter, Backspace, Escape or ArrowDown.'
					);
				this.send(runtime, { cmd: 'key', usage, down: true });
				this.send(runtime, { cmd: 'key', usage, down: false });
				return `Pressed ${command.key}.`;
			}
			case 'button': {
				if (!command.button) throw new Error('Give the button: home, back or lock.');
				if (command.button === 'back' && !runtime.serial)
					throw new Error('iOS has no Back button: tap the back control on the screen.');
				await this.request(runtime, { cmd: 'button', name: command.button });
				return `Pressed ${command.button}.`;
			}
		}
	}
	private metro(projectId: string) {
		let metro = this.metros.get(projectId);
		if (metro) return metro;
		// The task trees of the project (worktrees) and the project itself: Metro started in either counts.
		metro = new MetroSession(
			async () => {
				const store = await SessionStore.at(this.dataDir);
				return [join(store.root, 'worktrees', projectId), (await store.project(projectId)).path];
			},
			() => void this.publish(projectId),
			this.tools.metro,
			() => this.devices.find((device) => device.id === this.resolved.get(projectId))?.name ?? null
		);
		this.metros.set(projectId, metro);
		return metro;
	}
	/** Reload through Metro's message socket, the same as `r` in its terminal. */
	private async reload(projectId: string) {
		const target = this.metros.get(projectId)?.target;
		if (!target) throw new Error(metroMissing);
		await new Promise<void>((resolve, reject) => {
			const socket = new WebSocket(`ws://127.0.0.1:${target.port}/message`, {
				headers: { Origin: `http://127.0.0.1:${target.port}` },
			} as unknown as string[]);
			socket.onopen = () => {
				socket.send(JSON.stringify({ version: 2, method: 'reload' }));
				socket.close();
				resolve();
			};
			socket.onerror = () => reject(new Error('Metro did not take the reload.'));
		});
		return null;
	}
	/** React Native DevTools of the app, opened by Metro itself (`/open-debugger`). */
	private async devtools(projectId: string) {
		const target = this.metros.get(projectId)?.target;
		if (!target) throw new Error(metroMissing);
		const response = await fetch(
			`http://127.0.0.1:${target.port}/open-debugger?appId=${encodeURIComponent(target.appId)}`,
			{ method: 'POST' }
		);
		if (!response.ok) throw new Error('Metro did not open React Native DevTools.');
		return null;
	}
	/** The app's native log of the last two minutes: the process of the app Metro serves (`appId`). */
	private async nativeLogs(projectId: string, runtime: Runtime, level?: string, grep?: string) {
		const appId = this.metros.get(projectId)?.target?.appId;
		if (!appId)
			throw new Error('The app is not known yet: start Metro and open the app, or read js logs.');
		if (runtime.serial) {
			const pid = (await this.adb(runtime, ['shell', 'pidof', '-s', appId])).trim();
			if (!/^\d+$/.test(pid)) throw new Error(`${appId} is not running on ${runtime.device.name}.`);
			return keep(
				(await this.adb(runtime, ['logcat', '-d', '-t', '500', `--pid=${pid}`]))
					.split('\n')
					.filter(
						(line) =>
							line &&
							(!grep || line.toLocaleLowerCase().includes(grep.toLocaleLowerCase())) &&
							(level !== 'error' || / [EF] /.test(line))
					),
				'No native log entries for the app.'
			);
		}
		const filter = (lines: string[]) =>
			lines.filter(
				(line) =>
					line &&
					(!grep || line.toLocaleLowerCase().includes(grep.toLocaleLowerCase())) &&
					(level !== 'error' || / (E|F|Error|Fault) /.test(line))
			);
		if (runtime.logs?.appId === appId)
			return keep(filter(runtime.logs.lines), 'No native log entries since the app started.');
		const executable = await this.executable(runtime, appId);
		const out = await this.tools.run('/usr/bin/xcrun', [
			'simctl',
			'spawn',
			runtime.device.id,
			'log',
			'show',
			'--last',
			'2m',
			'--style',
			'compact',
			'--predicate',
			`process == "${executable.replace(/"/g, '')}"`,
		]);
		return keep(filter(out.split('\n').slice(1)), 'No native log entries in the last two minutes.');
	}
	private async executable(runtime: Runtime, appId: string) {
		const info = await this.tools.run('/usr/bin/xcrun', [
				'simctl',
				'appinfo',
				runtime.device.id,
				appId,
			]),
			executable = /CFBundleExecutable = "?([^";\n]+)"?;/.exec(info)?.[1];
		if (!executable) throw new Error(`${appId} is not installed on ${runtime.device.name}.`);
		return executable.replace(/"/g, '');
	}
	/** iOS: a steady `log stream` of the app Metro named, 2000 lines, restarted when the app changes. */
	private async followLogs(runtime: Runtime, appId: string) {
		if (runtime.serial || runtime.logs?.appId === appId) return;
		runtime.logs?.stop();
		const logs: LogStream = { appId, lines: [], stop: () => {} };
		runtime.logs = logs;
		try {
			const executable = await this.executable(runtime, appId);
			if (runtime.logs !== logs || runtime.status !== 'on') return;
			logs.stop = this.tools.stream(
				'/usr/bin/xcrun',
				[
					'simctl',
					'spawn',
					runtime.device.id,
					'log',
					'stream',
					'--style',
					'compact',
					'--predicate',
					`process == "${executable}"`,
				],
				(line) => {
					if (!line || line.startsWith('Filtering the log data')) return;
					logs.lines.push(line);
					if (logs.lines.length > 2000) logs.lines.splice(0, logs.lines.length - 2000);
				}
			);
		} catch {
			if (runtime.logs === logs) runtime.logs = null;
		}
	}
	/**
	 * The screen as the interface sees it. An app that does not turn (the iPhone home screen, a portrait-only app) keeps
	 * portrait points while the device lies on its side, as in Simulator.app; `turned` comes from the tree's application.
	 */
	private interface(runtime: Runtime) {
		const screen = runtime.screen!;
		return runtime.turned ? { width: screen.height, height: screen.width } : screen;
	}
	/** Turn right like ⌘→ in Simulator.app: iOS through devicectl (the frame stays portrait), Android by the emulator. */
	private async rotate(runtime: Runtime) {
		if (runtime.serial) {
			await this.adb(runtime, ['emu', 'rotate']);
			return;
		}
		await this.tools.run('/usr/bin/xcrun', [
			'devicectl',
			'device',
			'orientation',
			'rotate',
			'--device',
			runtime.device.id,
			'right',
		]);
		await this.readOrientation(runtime);
		runtime.turned = false;
	}
	private async readOrientation(runtime: Runtime) {
		const out = await this.tools
			.run('/usr/bin/xcrun', [
				'devicectl',
				'device',
				'orientation',
				'get',
				'--device',
				runtime.device.id,
			])
			.catch(() => '');
		const value = /Orientation: (\w+)/.exec(out)?.[1];
		runtime.orientation = simulatorOrientations.includes(value as SimulatorOrientation)
			? (value as SimulatorOrientation)
			: 'portrait';
	}
	/** The helper waits up to 25 s for the device's accessibility service after a boot (it answers «no app» meanwhile). */
	private async ui(runtime: Runtime, grid: boolean) {
		const ui = simulatorUi(await this.request(runtime, { cmd: 'ui', grid }, 40_000));
		if (!ui) throw new Error('The device sent no accessibility tree.');
		const app = ui.elements.find((element) => element.role === 'Application');
		runtime.turned =
			!runtime.serial && isLandscape(runtime.orientation) && !!app && app.frame[2] > app.frame[3];
		return { ...ui, ...this.interface(runtime) };
	}

	/** Boots the project's device when needed and waits for its stream, like the column's Start. */
	private async ready(projectId: string) {
		await this.boot(projectId);
		for (let waited = 0; waited < 60_000; waited += 250) {
			const runtime = await this.runtime(projectId);
			if (runtime?.status === 'on' && runtime.helper) return runtime;
			if (runtime?.status === 'error')
				throw new Error(runtime.error ?? 'The device did not start.');
			await new Promise((resolve) => setTimeout(resolve, 250));
		}
		throw new Error('The device did not start in a minute.');
	}
	/** The toolchain and the device list are read once per start, then on `refresh` (the picker reopens). */
	async state(projectId: string): Promise<SimulatorState> {
		if (!this.toolchain) await this.refresh();
		const device = await this.device(projectId),
			runtime = device ? this.runtimes.get(device.id) : undefined,
			status = runtime?.status ?? 'off';
		// Metro is looked for while the device runs, so the buffers hold what happened before the agent asks.
		if (status === 'on') this.metro(projectId).start();
		else this.metros.get(projectId)?.stop();
		const target = this.metros.get(projectId)?.target;
		if (runtime && status === 'on' && target?.appId) void this.followLogs(runtime, target.appId);
		return {
			toolchain: this.toolchain!,
			devices: this.devices,
			device: device ? { ...device, booted: device.booted || status === 'on' } : null,
			status,
			error: runtime?.error ?? null,
			screen: runtime?.screen ?? null,
			orientation: runtime?.orientation ?? 'portrait',
			metro: target ? { port: target.port, appId: target.appId, root: target.root } : null,
		};
	}
	/** Quit and module off: helpers stop; devices this app booted shut down after it exits (detached simctl). */
	close() {
		this.closed = true;
		for (const metro of this.metros.values()) metro.stop();
		this.metros.clear();
		for (const runtime of this.runtimes.values()) {
			this.stopHelper(runtime);
			runtime.logs?.stop();
			if (!runtime.bootedByUs) continue;
			if (runtime.serial && this.sdk)
				this.tools.detach(join(this.sdk, 'platform-tools', 'adb'), [
					'-s',
					runtime.serial,
					'emu',
					'kill',
				]);
			else if (!runtime.serial)
				this.tools.detach('/usr/bin/xcrun', ['simctl', 'shutdown', runtime.device.id]);
		}
		this.runtimes.clear();
	}
	reopen() {
		this.closed = false;
	}
	/** Settings ▸ Modules shows what was found even while the module is off (spec/settings-modules-and-onboarding#modules). */
	async found() {
		if (!this.toolchain) await this.refresh();
		return this.toolchain!;
	}
	private async refresh() {
		const apple = this.tools.platform === 'darwin';
		const [xcode, android] = await Promise.all([apple ? this.xcode() : null, this.tools.android()]);
		this.sdk = android;
		this.toolchain = { xcode, android: android ? 'Android SDK' : null, ios: apple };
		await this.listDevices();
	}
	private async listDevices() {
		const [ios, avds] = await Promise.all([
			this.toolchain?.xcode ? this.iosDevices().catch(() => []) : [],
			this.sdk ? this.androidDevices(this.sdk).catch(() => []) : [],
		]);
		this.devices = [...ios, ...avds];
	}
	private async xcode() {
		try {
			const out = await this.tools.run('/usr/bin/xcrun', ['xcodebuild', '-version']);
			const version = /^Xcode (\d+)/m.exec(out);
			return version ? `Xcode ${version[1]}` : null;
		} catch {
			return null;
		}
	}
	private async iosDevices(): Promise<SimulatorDevice[]> {
		const list = JSON.parse(
			await this.tools.run('/usr/bin/xcrun', ['simctl', 'list', '-j', 'devices', 'available'])
		) as unknown;
		if (!isRecord(list) || !isRecord(list.devices)) return [];
		return Object.entries(list.devices)
			.flatMap(([runtime, devices]) => {
				const version = /SimRuntime\.iOS-(\d+)-(\d+)/.exec(runtime);
				if (!version || !Array.isArray(devices)) return [];
				const os = `iOS ${version[1]}${version[2] === '0' ? '' : `.${version[2]}`}`;
				return devices
					.filter(isRecord)
					.filter(
						(device) =>
							typeof device.udid === 'string' &&
							typeof device.name === 'string' &&
							/^(iPhone|iPad)/.test(device.name)
					)
					.map((device) => ({
						id: String(device.udid),
						name: String(device.name),
						platform: 'ios' as const,
						os,
						booted: device.state === 'Booted',
					}));
			})
			.sort(
				(a, b) =>
					Number(b.os.slice(4).split('.')[0]) - Number(a.os.slice(4).split('.')[0]) ||
					Number(b.name.startsWith('iPhone')) - Number(a.name.startsWith('iPhone'))
			);
	}
	/** AVDs of the SDK; the running ones by `adb emu avd name` of each emulator serial. OS from the system image API level. */
	private async androidDevices(sdk: string): Promise<SimulatorDevice[]> {
		const names = (await this.tools.run(join(sdk, 'emulator', 'emulator'), ['-list-avds']))
			.split('\n')
			.map((line) => line.trim())
			.filter((line) => /^[A-Za-z0-9._-]+$/.test(line));
		const running = await this.androidSerials(sdk);
		return Promise.all(
			names.map(async (name) => {
				const config = await readFile(
						join(this.tools.avdHome, `${name}.avd`, 'config.ini'),
						'utf8'
					).catch(() => ''),
					api = Number(/android-(\d+)/.exec(config)?.[1]);
				return {
					id: name,
					name:
						/^avd\.ini\.displayname=(.+)$/m.exec(config)?.[1]?.trim() ?? name.replace(/_/g, ' '),
					platform: 'android' as const,
					os: api ? `Android ${androidVersions[api] ?? `API ${api}`}` : 'Android',
					booted: running.has(name),
				};
			})
		);
	}
	private async androidSerials(sdk: string) {
		const adb = join(sdk, 'platform-tools', 'adb'),
			serials = new Map<string, string>();
		const lines = (await this.tools.run(adb, ['devices']).catch(() => ''))
			.split('\n')
			.map((line) => /^(emulator-\d+)\s+device$/.exec(line.trim())?.[1])
			.filter((serial): serial is string => !!serial);
		await Promise.all(
			lines.map(async (serial) => {
				const name = (
					await this.tools.run(adb, ['-s', serial, 'emu', 'avd', 'name']).catch(() => '')
				)
					.split('\n')[0]
					?.trim();
				if (name) serials.set(name, serial);
			})
		);
		return serials;
	}
	private adb(runtime: Runtime, args: string[]) {
		return this.tools.run(join(this.sdk!, 'platform-tools', 'adb'), [
			'-s',
			runtime.serial!,
			...args,
		]);
	}
	/** A JPEG from sim-helper or a PNG from the Android helper, for the chat and for the agent. */
	private async screenshot(runtime: Runtime) {
		const shot = await this.request(runtime, {
			cmd: 'screenshot',
			maxSide: 1000,
			orientation: runtime.orientation,
		});
		if (isRecord(shot) && typeof shot.jpeg === 'string')
			return { image: shot.jpeg, mimeType: 'image/jpeg' };
		if (isRecord(shot) && typeof shot.png === 'string')
			return { image: shot.png, mimeType: 'image/png' };
		throw new Error('The device sent no screenshot.');
	}
	/** The project's device: saved in project.json, else a booted iPhone, else the first iPhone of the newest runtime. */
	private async device(projectId: string) {
		if (!this.selected.has(projectId)) {
			const saved = (await (await SessionStore.at(this.dataDir)).project(projectId)).simulator;
			this.selected.set(projectId, saved?.device ?? null);
		}
		const id = this.selected.get(projectId);
		const device =
			this.devices.find((device) => device.id === id) ??
			this.devices.find((device) => device.booted && device.name.startsWith('iPhone')) ??
			this.devices.find((device) => device.name.startsWith('iPhone')) ??
			this.devices[0] ??
			null;
		this.resolved.set(projectId, device?.id ?? null);
		return device;
	}
	/** A device saved in project.json and still listed; the fallbacks of `device` are not a choice (spec/browser-and-simulator#sim-device). */
	private chosen(projectId: string) {
		const id = this.selected.get(projectId);
		return !!id && this.devices.some((device) => device.id === id);
	}
	private async runtime(projectId: string) {
		const device = await this.device(projectId);
		return device ? (this.runtimes.get(device.id) ?? null) : null;
	}
	private async live(projectId: string) {
		const runtime = await this.runtime(projectId);
		if (!runtime || runtime.status !== 'on' || !runtime.helper)
			throw new Error('The device is not running.');
		return runtime;
	}
	private async select(projectId: string, id: string) {
		if (!this.toolchain) await this.refresh();
		const device = this.devices.find((item) => item.id === id);
		if (!device) throw new Error('The device is not available.');
		this.selected.set(projectId, id);
		const simulator: ProjectSimulator = { platform: device.platform, device: id };
		await (await SessionStore.at(this.dataDir)).setProjectSimulator(projectId, simulator);
		return this.publish(projectId);
	}
	private async boot(projectId: string) {
		const device = await this.device(projectId);
		if (!device) throw new Error('No device is available.');
		const existing = this.runtimes.get(device.id);
		if (existing && (existing.status === 'on' || existing.status === 'booting'))
			return this.state(projectId);
		const runtime: Runtime = existing ?? {
			device,
			serial: null,
			orientation: 'portrait',
			turned: false,
			logs: null,
			helper: null,
			status: 'booting',
			error: null,
			screen: null,
			config: null,
			bootedByUs: false,
			replies: new Map(),
			nextId: 1,
		};
		runtime.status = 'booting';
		runtime.error = null;
		this.runtimes.set(device.id, runtime);
		this.publishDevice(device.id);
		try {
			if (device.platform === 'android') {
				await this.bootAndroid(runtime);
				if (this.closed) return this.state(projectId);
				this.startHelper(runtime);
				return this.state(projectId);
			}
			if (!device.booted) {
				await this.tools.run('/usr/bin/xcrun', ['simctl', 'boot', device.id]).catch((error) => {
					if (!/current state: Booted/.test(String(error?.stderr ?? error))) throw error;
				});
				runtime.bootedByUs = true;
			}
			await this.tools.run('/usr/bin/xcrun', ['simctl', 'bootstatus', device.id, '-b']);
			device.booted = true;
			if (this.closed) return this.state(projectId);
			this.startHelper(runtime);
		} catch (error) {
			runtime.status = 'error';
			runtime.error = `${device.name} did not start: ${error instanceof Error ? error.message.split('\n')[0] : String(error)}`;
			this.publishDevice(device.id);
		}
		return this.state(projectId);
	}
	/** The emulator without a window (`-gpu host`: headless otherwise renders in software, 1–5 fps), then boot_completed. */
	private async bootAndroid(runtime: Runtime) {
		const sdk = this.sdk;
		if (!sdk) throw new Error('The Android SDK is not found.');
		let serial = (await this.androidSerials(sdk)).get(runtime.device.id);
		if (!serial) {
			this.tools.detach(join(sdk, 'emulator', 'emulator'), [
				'-avd',
				runtime.device.id,
				'-no-window',
				'-no-audio',
				'-gpu',
				'host',
				'-no-boot-anim',
			]);
			runtime.bootedByUs = true;
			for (let waited = 0; !serial; waited += 1000) {
				if (waited > 120_000) throw new Error('the emulator did not appear in two minutes');
				await new Promise((resolve) => setTimeout(resolve, 1000));
				serial = (await this.androidSerials(sdk)).get(runtime.device.id);
			}
		}
		runtime.serial = serial;
		for (
			let waited = 0;
			(
				await this.adb(runtime, ['shell', 'getprop', 'sys.boot_completed']).catch(() => '')
			).trim() !== '1';
			waited += 1000
		) {
			if (waited > 180_000) throw new Error('Android did not finish booting in three minutes');
			await new Promise((resolve) => setTimeout(resolve, 1000));
		}
		runtime.device.booted = true;
	}
	/** `id` — a running device of the picker (spec/task-window-workspace#tool-tab-look.1); the project's own device otherwise. */
	private async shutdown(projectId: string, id?: string) {
		const device =
			id === undefined ? await this.device(projectId) : this.devices.find((item) => item.id === id);
		if (!device) return this.state(projectId);
		const runtime = this.runtimes.get(device.id);
		if (runtime) {
			this.stopHelper(runtime);
			runtime.logs?.stop();
		}
		this.runtimes.delete(device.id);
		if (device.platform === 'android') {
			const serial =
				runtime?.serial ??
				(this.sdk ? (await this.androidSerials(this.sdk)).get(device.id) : undefined);
			if (serial && this.sdk)
				await this.tools
					.run(join(this.sdk, 'platform-tools', 'adb'), ['-s', serial, 'emu', 'kill'])
					.catch(() => {});
		} else
			await this.tools.run('/usr/bin/xcrun', ['simctl', 'shutdown', device.id]).catch(() => {});
		device.booted = false;
		this.publishDevice(device.id);
		return this.state(projectId);
	}
	/**
	 * ASCII types as keys; anything else lands on the device pasteboard for the device's own «Paste». The text is
	 * this Mac's clipboard, or the one a window of this machine on a device sent (spec/remote-access-and-mobile#browser-from-device).
	 */
	private async paste(projectId: string, given?: string) {
		const runtime = await this.live(projectId),
			text = given ?? (await this.tools.clipboard());
		if (!text) return null;
		// The Android helper pastes any text through scrcpy's clipboard; sim-helper types ASCII only.
		if (runtime.serial || /^[\x20-\x7e\n\t]*$/.test(text))
			return this.request(runtime, { cmd: 'text', text });
		await this.pasteboard(runtime, text);
		return { pasteboard: true };
	}
	private async pasteboard(runtime: Runtime, text: string) {
		await new Promise<void>((resolve, reject) => {
			const child = spawn('/usr/bin/xcrun', ['simctl', 'pbcopy', runtime.device.id], {
				env: { ...process.env, LANG: 'en_US.UTF-8' },
			});
			child.on('error', reject);
			child.on('close', (code) =>
				code === 0 ? resolve() : reject(new Error('The text could not reach the device.'))
			);
			child.stdin.end(text);
		});
	}
	/** spec/remote-access-and-mobile#browser-from-device: a key frame for a device that missed frames; the decoder config stays as it was. */
	async keyframe(projectId: string) {
		const runtime = await this.runtime(projectId);
		if (runtime?.config) this.send(runtime, { cmd: 'keyframe' });
	}
	private startHelper(runtime: Runtime) {
		const helper = runtime.serial
			? spawn(
					this.tools.node,
					[
						this.tools.androidHelper,
						'--serial',
						runtime.serial,
						'--adb',
						join(this.sdk!, 'platform-tools', 'adb'),
						'--server',
						join(dirname(this.tools.androidHelper), 'scrcpy-server'),
					],
					{ stdio: ['pipe', 'pipe', 'pipe'], env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' } }
				)
			: spawn(this.tools.helper, ['--udid', runtime.device.id], {
					stdio: ['pipe', 'pipe', 'pipe'],
				});
		runtime.helper = helper;
		let buffer: Buffer = Buffer.alloc(0);
		helper.stdout!.on('data', (chunk: Buffer) => {
			buffer = buffer.length ? Buffer.concat([buffer, chunk]) : chunk;
			while (buffer.length >= 5) {
				const size = buffer.readUInt32BE(1);
				if (buffer.length < 5 + size) break;
				const type = buffer[0]!,
					payload = buffer.subarray(5, 5 + size);
				buffer = buffer.subarray(5 + size);
				this.receive(runtime, type, payload);
			}
		});
		helper.stderr!.resume();
		helper.on('exit', (code) => {
			if (runtime.helper !== helper) return;
			runtime.helper = null;
			for (const reply of runtime.replies.values())
				reply.reject(new Error('The device stream stopped.'));
			runtime.replies.clear();
			if (runtime.status !== 'error') {
				runtime.status = code === 0 ? 'off' : 'error';
				runtime.error = code === 0 ? null : (runtime.error ?? 'The device stream stopped.');
			}
			this.publishDevice(runtime.device.id);
		});
		helper.on('error', (error) => {
			runtime.status = 'error';
			runtime.error = error.message;
			this.publishDevice(runtime.device.id);
		});
	}
	private stopHelper(runtime: Runtime) {
		const helper = runtime.helper;
		runtime.helper = null;
		if (!helper) return;
		helper.stdin?.end();
		const timer = setTimeout(() => helper.kill('SIGKILL'), 2000);
		timer.unref();
		helper.once('exit', () => clearTimeout(timer));
	}
	private receive(runtime: Runtime, type: number, payload: Buffer) {
		if (type === 3) {
			if (payload.length < 9) return;
			const frame: SimulatorFrame = {
				key: payload[0] === 1,
				timestamp: Number(payload.readBigUInt64BE(1)),
				data: new Uint8Array(payload.subarray(9)),
			};
			for (const projectId of this.watching(runtime.device.id)) this.frame(projectId, frame);
			return;
		}
		let message: unknown;
		try {
			message = JSON.parse(payload.toString('utf8'));
		} catch {
			return;
		}
		if (!isRecord(message)) return;
		if (type === 2) {
			if (
				typeof message.codec === 'string' &&
				typeof message.description === 'string' &&
				Number.isFinite(message.width) &&
				Number.isFinite(message.height)
			) {
				runtime.config = {
					codec: message.codec,
					description: message.description,
					width: Number(message.width),
					height: Number(message.height),
				};
				for (const projectId of this.watching(runtime.device.id))
					this.emit({ projectId, config: runtime.config });
			}
			return;
		}
		// The device may stand turned already when the helper starts (iOS keeps its orientation across boots).
		if (message.event === 'ready' && !runtime.serial)
			void this.readOrientation(runtime).then(() => this.publishDevice(runtime.device.id));
		if (message.event === 'ready' || message.event === 'size') {
			runtime.status = 'on';
			runtime.error = null;
			runtime.screen = {
				width: Number(message.pointWidth) || Number(message.width),
				height: Number(message.pointHeight) || Number(message.height),
			};
			this.publishDevice(runtime.device.id);
			return;
		}
		if (message.event === 'reply' && typeof message.id === 'number') {
			const reply = runtime.replies.get(message.id);
			runtime.replies.delete(message.id);
			if (typeof message.error === 'string') reply?.reject(new Error(message.error));
			else reply?.resolve(message.result ?? null);
			return;
		}
		if (message.event === 'error' && typeof message.message === 'string') {
			runtime.error = message.message;
			if (message.fatal === true) runtime.status = 'error';
			this.publishDevice(runtime.device.id);
		}
	}
	private send(runtime: Runtime, message: Record<string, unknown>) {
		if (runtime.helper?.stdin?.writable) runtime.helper.stdin.write(`${JSON.stringify(message)}\n`);
	}
	private request(runtime: Runtime, message: Record<string, unknown>, timeout = 15_000) {
		const id = runtime.nextId++;
		return new Promise<unknown>((resolve, reject) => {
			const timer = setTimeout(() => {
				runtime.replies.delete(id);
				reject(new Error('The device did not answer.'));
			}, timeout);
			timer.unref();
			runtime.replies.set(id, {
				resolve: (value) => {
					clearTimeout(timer);
					resolve(value);
				},
				reject: (error) => {
					clearTimeout(timer);
					reject(error);
				},
			});
			this.send(runtime, { ...message, id });
		});
	}
	private *watching(deviceId: string) {
		for (const [projectId, count] of this.watchers)
			if (count > 0 && this.resolved.get(projectId) === deviceId) yield projectId;
	}
	private async publish(projectId: string) {
		const state = await this.state(projectId);
		this.emit({ projectId, state });
		return state;
	}
	private publishDevice(deviceId: string) {
		for (const [projectId, id] of this.resolved) if (id === deviceId) void this.publish(projectId);
	}
}
/** A child whose stdout is read line by line; the returned function stops it. */
function lineStream(file: string, args: string[], line: (text: string) => void) {
	const child = spawn(file, args, { stdio: ['ignore', 'pipe', 'ignore'] });
	let rest = '';
	child.stdout.setEncoding('utf8');
	child.stdout.on('data', (chunk: string) => {
		const parts = (rest + chunk).split('\n');
		rest = parts.pop() ?? '';
		for (const part of parts) line(part);
	});
	child.on('error', () => {});
	return () => {
		child.kill('SIGTERM');
	};
}
const androidVersions: Record<number, string> = {
	36: '16',
	35: '15',
	34: '14',
	33: '13',
	32: '12L',
	31: '12',
	30: '11',
	29: '10',
};
/** The newest 100 lines within 32 KiB (spec/architecture-and-platform#perf-agent-responses). */
function keep(lines: string[], empty: string) {
	let size = 0;
	const kept: string[] = [];
	for (const line of lines.slice(-100).reverse()) {
		if (size + line.length + 1 > 32 * 1024) break;
		kept.unshift(line);
		size += line.length + 1;
	}
	return kept.length ? kept.join('\n') : empty;
}
/**
 * ANDROID_HOME, ANDROID_SDK_ROOT, then the Android Studio default of macOS and of Linux (spec/architecture-and-platform#linux-package); the SDK counts when
 * it has the emulator (spec/browser-and-simulator#simulator).
 */
export async function androidSdk(
	env: Record<string, string | undefined> = process.env,
	home = homedir()
) {
	for (const root of [
		env.ANDROID_HOME,
		env.ANDROID_SDK_ROOT,
		join(home, 'Library/Android/sdk'),
		join(home, 'Android/Sdk'),
	])
		if (
			root &&
			(await access(join(root, 'emulator', 'emulator')).then(
				() => true,
				() => false
			))
		)
			return root;
	return null;
}
