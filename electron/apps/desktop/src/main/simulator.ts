import { execFile, spawn, type ChildProcess } from 'node:child_process';
import { access, readFile, readdir } from 'node:fs/promises';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import { promisify } from 'node:util';
import {
	devicePoint,
	findElement,
	formatUi,
	gateOpen,
	hidUsage,
	isLandscape,
	isRecord,
	matchDevices,
	simulatorLeases,
	simulatorOrientations,
	simulatorUi,
	simulatorDeviceLabel,
	type SimulatorOrientation,
	type ProjectSimulator,
	type SimulatorAgentCommand,
	type SimulatorActRequest,
	type SimulatorGate,
	type SimulatorLease,
	type SimulatorUi,
	type SimulatorUse,
	diffUi,
	formatUiDiff,
	type TaskKey,
	type SimulatorCommand,
	type SimulatorDevice,
	type SimulatorEvent,
	type SimulatorFrame,
	type SimulatorState,
	type SimulatorToolchain,
	type SimulatorVideoConfig,
} from '@brigadir/core';
import {
	atomicJson,
	forgetMetroPort,
	readDocument,
	readMetroPorts,
	safePath,
	SessionStore,
} from '@brigadir/persistence';
import {
	MetroSession,
	appRequests,
	appScheme,
	connectPort,
	devClientLink,
	formatLogs,
	formatRequest,
	formatRequests,
	type MetroDeps,
} from './metro';
import { isChange, ScreenWatch, settleLine, waitForElement } from './simulator-settle';
import { SimulatorQueue } from './simulator-queue';
import { lowMemory, passGate, shareReason } from './simulator-gate';
/** How long a tree read stays true on a screen that sends no frames (spec/browser-and-simulator#sim-act-settle). */
const treeKeepMs = 10_000;
/** How long a memory-pressure reading is reused (spec/browser-and-simulator#sim-cap). */
const memoryKeepMs = 2000;
const run = promisify(execFile);
const metroMissing =
	'Metro is not attached: start Metro in this task (a project command or the console), then open the app.';
/**
 * spec/browser-and-simulator#simulator: devices, their lifecycle and the frames of the simulator column. A task holds a lease on one device
 * (spec/browser-and-simulator#sim-lease); one helper per booted device streams H.264 and takes input: `sim-helper` for iOS, `android.cjs`
 * over scrcpy-server for an Android emulator; both speak the same stdout/stdin protocol. Devices the app booted itself are shut down
 * when the app quits or the module is switched off; devices booted by someone else are left as they are.
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
	/** spec/browser-and-simulator#sim-act-settle: the agent's calls that wait for the screen. */
	watches: Set<ScreenWatch>;
	/** Changing frames so far (`isChange`), and the last tree with the count it was read at. */
	changes: number;
	tree: { ui: SimulatorUi; changes: number; at: number } | null;
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
	/** The clock of the kept tree (spec/browser-and-simulator#sim-act-settle). */
	now: () => number;
	/** spec/browser-and-simulator#sim-cap: the cap of local devices (Settings), and whether the system reports memory pressure. */
	cap: () => number;
	lowMemory: () => Promise<boolean>;
	/** Waits between two looks at the gate. */
	sleep: (ms: number) => Promise<void>;
	gateWaitMs: number;
	readText: (path: string) => Promise<string>;
	/** `CoreSimulator/Devices`: where a device keeps the bundles of the apps installed on it (spec/browser-and-simulator#sim-own-device). */
	simulatorDevices: string;
	/** The task's own worktree, or null for a task in the project folder (spec/browser-and-simulator#metro-port). */
	worktree?: (key: TaskKey) => Promise<string | null>;
	/** A task's name for the agent's text; its title. */
	taskTitle: (key: TaskKey) => Promise<string>;
	/** spec/browser-and-simulator#sim-own-device: the task is removed, archived or completed. */
	taskEnded: (key: TaskKey) => Promise<boolean>;
	/** spec/browser-and-simulator#sim-chat-row: journals the task's device row. */
	record: (
		key: TaskKey,
		row: { device: string; metroPort: number | null; lowMemory: boolean }
	) => Promise<void>;
	/** spec/agents-and-providers#tools-awareness: the tasks of a project waiting for a device. */
	waiting: (projectId: string, ids: string[]) => void;
	/** The lane rules' timings (spec/browser-and-simulator#sim-lease). */
	queue?: { waitMs?: number; idleMs?: number };
};
/** iOS model and runtime of a device: what a new device of the same kind is made from (spec/browser-and-simulator#sim-own-device). */
type IosKind = { type: string; runtime: string };
const nameOf = (key: TaskKey) => `${key.projectId}/${key.id}`;
const same = (a: TaskKey | null | undefined, b: TaskKey) =>
	!!a && a.projectId === b.projectId && a.id === b.id;
const leaseFile = 'simulator-devices.json';
export class Simulators {
	private toolchain: SimulatorToolchain | null = null;
	private devices: SimulatorDevice[] = [];
	private kinds = new Map<string, IosKind>();
	private runtimes = new Map<string, Runtime>();
	/** project.json `simulator` of each project read so far: the project's default device. */
	private selected = new Map<string, string | null>();
	/** spec/browser-and-simulator#sim-lease: every task's record, by `projectId/taskId`, loaded from all projects at first use. */
	private leases = new Map<string, { key: TaskKey; lease: SimulatorLease }>();
	private leasesLoaded: Promise<void> | null = null;
	private leaseWrites = new Map<string, Promise<unknown>>();
	/** The tabs of tasks: how many watch, and the device each one shows now. */
	private views = new Map<string, { key: TaskKey; watchers: number; device: string | null }>();
	private closed = false;
	private metros = new Map<string, MetroSession>();
	/** spec/browser-and-simulator#metro-connect: the device and port a task's app was last pointed at. */
	private connected = new Map<string, string>();
	/** Tasks whose boot waits at the gate now (spec/browser-and-simulator#sim-cap). */
	private gateWaits = new Set<string>();
	/** One copy is made at a time, so two workers never pass the gate on the same free slot. */
	private copying: Promise<unknown> = Promise.resolve();
	private memory: { low: boolean; at: number } | null = null;
	private portCache: { ports: Record<string, number>; at: number } | null = null;
	/** Devices whose boot passed the gate and is not yet a booting runtime (spec/browser-and-simulator#sim-cap). */
	private reserved = new Set<string>();
	private queue: SimulatorQueue;
	private tools: Tools;
	private sdk: string | null = null;
	private publishing = false;
	constructor(
		private dataDir: string | undefined,
		helper: string,
		private emit: (event: SimulatorEvent) => void,
		private frame: (device: string, frame: SimulatorFrame) => void,
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
			now: Date.now,
			cap: () => 2,
			lowMemory: () =>
				lowMemory({
					platform: this.tools.platform,
					run: (file, args) => this.tools.run(file, args),
					read: (path) => readFile(path, 'utf8'),
				}),
			sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
			gateWaitMs: 60_000,
			readText: (path) => readFile(path, 'utf8'),
			simulatorDevices: join(homedir(), 'Library/Developer/CoreSimulator/Devices'),
			taskTitle: async (key) =>
				(await (await SessionStore.at(this.dataDir)).task(key).catch(() => null))?.title ?? key.id,
			taskEnded: async () => false,
			record: async () => {},
			waiting: () => {},
			...tools,
		};
		this.queue = new SimulatorQueue({
			...this.tools.queue,
			onWaiting: (projectId, ids) => this.tools.waiting(projectId, ids),
			onChange: () => this.publishAll(),
		});
	}
	/** The person's commands from a task's simulator tab. */
	async command(key: TaskKey, command: SimulatorCommand): Promise<unknown> {
		if (this.closed) throw new Error('The simulator is off in Settings.');
		switch (command.kind) {
			case 'state':
				this.view(key);
				return this.state(key);
			case 'refresh':
				this.toolchain = null;
				await this.refresh();
				return this.publish(key);
			case 'select':
				return this.select(key, command.device, true);
			case 'boot':
				return this.start(key, command.anyway === true);
			case 'shutdown':
				return this.shutdown(key, command.device);
			case 'watch': {
				const view = this.view(key);
				view.watchers = Math.max(0, view.watchers + (command.on ? 1 : -1));
				const runtime = await this.runtime(key);
				if (command.on && runtime?.config) {
					this.emit({ device: runtime.device.id, config: runtime.config });
					this.send(runtime, { cmd: 'keyframe' });
				}
				return null;
			}
			case 'keyframe': {
				const runtime = await this.runtime(key);
				if (runtime?.config) {
					this.emit({ device: runtime.device.id, config: runtime.config });
					this.send(runtime, { cmd: 'keyframe' });
				}
				return null;
			}
			case 'touch': {
				const runtime = await this.live(key);
				this.send(runtime, { cmd: 'touch', phase: command.phase, x: command.x, y: command.y });
				return null;
			}
			case 'key': {
				const runtime = await this.live(key);
				this.send(runtime, { cmd: 'key', usage: command.usage, down: command.down });
				return null;
			}
			case 'button':
				return this.request(await this.live(key), { cmd: 'button', name: command.name });
			case 'text':
				return this.request(await this.live(key), { cmd: 'text', text: command.text });
			case 'paste':
				return this.paste(await this.live(key), command.text);
			case 'screenshot':
				return this.screenshot(await this.live(key));
			case 'reload':
				return this.reload(key);
			case 'devtools':
				return this.devtools(key);
			case 'rotate': {
				const runtime = await this.live(key);
				await this.rotate(runtime);
				this.publishDevice(runtime.device.id);
				return null;
			}
		}
	}
	/**
	 * spec/browser-and-simulator#sim-tools: the agent's `simulator_*` tools, answered in compact text; the human sees every action in the column.
	 * `queued` — a crew worker: it waits behind the person, the foreman and solo agents in a device's lane, and gets a device of its own.
	 */
	async agent(key: TaskKey, command: SimulatorAgentCommand, queued = false): Promise<unknown> {
		if (this.closed) throw new Error('The simulator is off in Settings.');
		// spec/browser-and-simulator#sim-device: `booted` is read again, a device started in Xcode after launch counts.
		if (command.tool === 'state' || command.tool === 'open' || command.device)
			await (this.toolchain ? this.listDevices() : this.refresh());
		// spec/browser-and-simulator#sim-lease: `simulator_state` never waits in a lane.
		if (command.tool === 'state' && !command.device) return this.agentState(key);
		const { device, note } = await this.agentDevice(key, command, queued);
		const answer =
			command.tool === 'state'
				? await this.agentState(key)
				: await this.queue.run(device.id, key, queued, () => this.agentOn(key, device, command));
		return note && typeof answer === 'string' ? `${note}\n${answer}` : answer;
	}
	/** The turn of a task ended (or its session failed or stopped): the devices it holds go to the next task in their lanes. */
	release(key: TaskKey) {
		this.queue.release(key);
	}
	/** spec/browser-and-simulator#sim-tools: `simulator_state` in the agent's words. */
	private async agentState(key: TaskKey) {
		const state = await this.state(key),
			lease = (await this.lease(key))?.lease,
			running = state.status === 'on' || state.status === 'booting' || !!state.device?.booted,
			guessed = !lease?.device && !this.chosen(key.projectId),
			lines = [
				// spec/browser-and-simulator#sim-device: the column's fallback is not the agent's device.
				state.device && !(guessed && !running)
					? `${lease?.device ? 'Your device' : 'Project device'}: ${simulatorDeviceLabel(state.device)} · ${state.status === 'on' ? 'running' : state.status === 'off' && state.device.booted ? 'booted' : state.status}${state.screen ? ` · screen ${state.screen.width}×${state.screen.height} pt` : ''}${guessed ? ' · not chosen, simulator_open uses it' : ''}`
					: 'No device is chosen for this project.',
			];
		const waits = this.queue.waitsFor(key),
			holder = waits ? this.queue.holder(waits) : null;
		if (waits && holder)
			lines.push(
				`Waiting: ${this.devices.find((item) => item.id === waits)?.name ?? waits} is used by «${await this.tools.taskTitle(holder)}»; your calls wait in its lane.`
			);
		if (state.error) lines.push(`Error: ${state.error}`);
		if (state.orientation !== 'portrait')
			lines.push(
				`Orientation: ${state.orientation} (simulator_ui gives the interface as the app draws it)`
			);
		lines.push(
			`Local devices: ${state.gate.running} of ${state.gate.max} run${state.gate.lowMemory ? '; memory is low, so new devices wait' : ''}.`
		);
		if (state.metroPort)
			lines.push(
				`Metro port of this task: ${state.metroPort} (RCT_METRO_PORT is set in your session and terminals).`
			);
		const modules = await this.missingModules(key);
		if (modules) lines.push(modules);
		const metros = this.metros.get(nameOf(key))?.found ?? [];
		if (metros.length)
			lines.push(
				'Metro:',
				...metros.map(
					(item) =>
						`- :${item.port} ${item.root}${item.own ? ' · your tree' : ''}${item.attached ? ' · attached' : ''}${item.device ? ' · serves your device' : ''}`
				)
			);
		const holders = await Promise.all(
			state.devices.map(async (device) => {
				const use = state.uses[device.id];
				return !use
					? 'free'
					: use.kind === 'mine'
						? 'yours'
						: use.kind === 'queued'
							? `yours, waiting for «${await this.tools.taskTitle(use.holder)}»`
							: use.kind === 'task'
								? `used by «${await this.tools.taskTitle(use.task)}»`
								: `used by ${use.count} tasks`;
			})
		);
		lines.push(
			`Toolchain: ${state.toolchain.xcode ?? 'no Xcode'} · ${state.toolchain.android ?? 'no Android SDK'}`,
			'Simulators (pass device: a kind such as iPhone, iPad or Android, a model, or a name or id below):',
			...state.devices.map(
				(device, index) =>
					`- ${simulatorDeviceLabel(device)} (${device.id})${device.booted ? ' · booted' : ''} · ${holders[index]}`
			)
		);
		return lines.join('\n');
	}
	/** The agent's tools on its device, inside the device's lane. */
	private async agentOn(key: TaskKey, device: SimulatorDevice, command: SimulatorAgentCommand) {
		if (command.tool === 'open') {
			this.emit({ show: key });
			const runtime = await this.ready(key, device, false);
			const connected = await this.connect(key, runtime).catch(
				(error: unknown) =>
					`Could not connect ${device.name} to this task's Metro: ${reason(error)}.`
			);
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
			const modules = await this.missingModules(key);
			return [
				`${simulatorDeviceLabel(runtime.device)} is running${command.app ? `; launched ${command.app}` : ''}${command.url ? `; opened ${command.url}` : ''}.`,
				...(connected ? [connected] : []),
				...(modules ? [modules] : []),
			].join('\n');
		}
		const metro = this.metros.get(nameOf(key));
		if (command.tool === 'logs' && command.source !== 'native') {
			if (!metro?.target) throw new Error(metroMissing);
			return formatLogs(metro.logs, command.level, command.grep);
		}
		if (command.tool === 'network') {
			if (!metro?.target && !metro?.requests.size) throw new Error(metroMissing);
			if (command.requestId) {
				const item = await metro.body(command.requestId);
				if (!item)
					throw new Error(`No request ${command.requestId}. Call simulator_network for the list.`);
				return formatRequest(item);
			}
			return formatRequests(appRequests(metro), Date.now(), command.filter);
		}
		const runtime = this.runtimes.get(device.id);
		if (!runtime || runtime.status !== 'on' || !runtime.helper)
			throw new Error('The device is not running. Call simulator_open first.');
		if (command.tool === 'logs') return this.nativeLogs(key, runtime, command.level, command.grep);
		if (command.tool === 'screenshot') return this.screenshot(runtime);
		if (command.tool === 'ui')
			return formatUi(await this.ui(runtime, command.grid === true), command.offset ?? 0);
		if (command.tool === 'wait')
			return this.withWatch(runtime, (watch) =>
				waitForElement(command, () => this.ui(runtime, false, true), watch)
			);
		if (command.tool !== 'act') throw new Error('Unknown simulator tool.');
		return this.withWatch(runtime, (watch) => this.act(runtime, command, watch));
	}
	/**
	 * spec/browser-and-simulator#sim-lease: the device an agent call works on. Its lease, else the project's device for the person, the foreman
	 * and solo agents; a crew worker gets one nobody else holds or a copy of its own (spec/browser-and-simulator#sim-own-device). `note` — why a
	 * worker shares a device.
	 */
	private async agentDevice(
		key: TaskKey,
		command: SimulatorAgentCommand,
		queued: boolean
	): Promise<{ device: SimulatorDevice; note?: string }> {
		if (!this.toolchain) await this.refresh();
		const current = (await this.lease(key))?.lease,
			leased = current?.device
				? this.devices.find((item) => item.id === current.device)
				: undefined;
		if (leased && current?.own && !current.own.reinstalled) await this.finishCopy(key, leased);
		if (command.device) {
			const matches = matchDevices(
				this.devices.filter(
					(item) => item.id === command.device || !this.ownedByOther(item.id, key)
				),
				command.device
			);
			if (!matches.length)
				throw new Error(
					`No device matches "${command.device}". Call simulator_state for the list.`
				);
			if (leased && matches.some((item) => item.id === leased.id)) return { device: leased };
			const free = matches.find((item) => !this.heldByOther(item.id, key));
			if (free) {
				await this.setLease(key, free, !queued);
				return { device: free };
			}
			if (queued) return this.workerDevice(key, matches[0]!);
			await this.setLease(key, matches[0]!, true);
			return { device: matches[0]! };
		}
		// A worker that had to share tries again for a device of its own: the gate may have opened since.
		if (leased && queued && !current?.own && this.heldByOther(leased.id, key))
			return this.workerDevice(key, leased);
		if (leased) return { device: leased };
		// spec/browser-and-simulator#sim-device: without a choice only a running device is the project's; it becomes the choice.
		const device = await this.device(key.projectId),
			status = device ? this.runtimes.get(device.id)?.status : undefined,
			running = !!device && (device.booted || status === 'on' || status === 'booting');
		if (!device || (!this.chosen(key.projectId) && !running)) {
			if (command.tool === 'open')
				throw new Error(
					'No device is chosen for this project and none is running. Pass device: the one the app is built and installed on (simulator_state lists them).'
				);
			throw new Error('The device is not running. Call simulator_open first.');
		}
		if (!this.chosen(key.projectId) && !queued) await this.setDefault(key.projectId, device);
		if (queued) return this.workerDevice(key, device);
		// A call that only reads a device that is off takes no lease; `simulator_open` and a running device do.
		if (command.tool === 'open' || running) await this.setLease(key, device, false);
		return { device };
	}
	/** spec/browser-and-simulator#sim-lease: a crew worker never shares a device while it can have its own. */
	private async workerDevice(
		key: TaskKey,
		wanted: SimulatorDevice
	): Promise<{ device: SimulatorDevice; note?: string }> {
		if (!this.heldByOther(wanted.id, key)) {
			await this.setLease(key, wanted, false);
			return { device: wanted };
		}
		if (wanted.platform === 'android') {
			const other = matchDevices(this.devices, 'android').find(
				(item) => !this.heldByOther(item.id, key)
			);
			if (other) {
				await this.setLease(key, other, false);
				return { device: other };
			}
			await this.setLease(key, wanted, false);
			return {
				device: wanted,
				note: `Sharing ${wanted.name} with another task: an Android device cannot be copied, and no other is free.`,
			};
		}
		// One copy at a time: the gate is read again inside, so two workers never take the same free slot.
		const made = this.copying.then(async () => {
			const gate = await this.gate();
			if (!gateOpen(gate)) return { gate };
			return { device: await this.makeCopy(key, wanted) };
		});
		this.copying = made.catch(() => {});
		const result = await made;
		if ('device' in result) return { device: result.device };
		await this.setLease(key, wanted, false);
		return {
			device: wanted,
			note: `Sharing ${wanted.name} with another task: ${shareReason(result.gate)}.`,
		};
	}
	/**
	 * spec/browser-and-simulator#sim-own-device: a device of the task's own, copied from `source`. A shut-down source is cloned with its apps
	 * and their data; a booted one cannot be, so a new device of the same model and runtime is made. Either way the copy boots and the
	 * person's apps are installed on it again from the source's bundles before it is used.
	 */
	private async makeCopy(key: TaskKey, source: SimulatorDevice): Promise<SimulatorDevice> {
		const title = await this.tools.taskTitle(key),
			name = `${source.name} · ${title}`.slice(0, 60),
			sourceRuntime = this.runtimes.get(source.id),
			booted =
				source.booted || sourceRuntime?.status === 'on' || sourceRuntime?.status === 'booting';
		let udid: string;
		if (!booted)
			udid = (await this.tools.run('/usr/bin/xcrun', ['simctl', 'clone', source.id, name])).trim();
		else {
			const kind = this.kinds.get(source.id);
			if (!kind) throw new Error(`The model of ${source.name} is not known.`);
			udid = (
				await this.tools.run('/usr/bin/xcrun', ['simctl', 'create', name, kind.type, kind.runtime])
			).trim();
		}
		if (!/^[A-Za-z0-9-]{1,64}$/.test(udid)) throw new Error('simctl did not make the device.');
		// The record is written before the copy boots, so a crash in between still cleans it up.
		await this.writeLease(key, {
			...(await this.lease(key))?.lease,
			platform: 'ios',
			device: udid,
			own: { source: source.id, reinstalled: false },
		});
		await this.listDevices();
		let copy = this.devices.find((item) => item.id === udid);
		if (!copy) {
			copy = { id: udid, name, platform: 'ios', os: source.os, booted: false };
			this.devices.push(copy);
		}
		await this.finishCopy(key, copy);
		await this.tools
			.record(key, {
				device: copy.name,
				metroPort: await this.portOf(key),
				lowMemory: false,
			})
			.catch(() => {});
		this.publishAll();
		return copy;
	}
	/**
	 * spec/browser-and-simulator#sim-own-device: boots a copy and installs the source's apps on it again, then marks it reinstalled. A copy
	 * whose reinstall failed or was cut off (a crash, a failed `simctl install`) goes through this again before any use.
	 */
	private async finishCopy(key: TaskKey, copy: SimulatorDevice) {
		const lease = (await this.lease(key))?.lease;
		if (!lease?.own || lease.device !== copy.id || lease.own.reinstalled) return;
		await this.ready(key, copy, false);
		for (const app of await this.bundles(lease.own.source))
			await this.tools.run('/usr/bin/xcrun', ['simctl', 'install', copy.id, app]);
		await this.writeLease(key, { ...lease, own: { source: lease.own.source, reinstalled: true } });
	}
	/** The `.app` bundles the person installed on a device, read from its folder (works whether it runs or not). */
	private async bundles(udid: string): Promise<string[]> {
		const root = join(this.tools.simulatorDevices, udid, 'data/Containers/Bundle/Application');
		const containers = await readdir(root).catch(() => [] as string[]);
		const apps: string[] = [];
		for (const container of containers) {
			const entries = await readdir(join(root, container)).catch(() => [] as string[]);
			for (const entry of entries)
				if (entry.endsWith('.app')) apps.push(join(root, container, entry));
		}
		return apps;
	}
	/** spec/browser-and-simulator#sim-cap: booted devices against the cap, and the system's memory pressure (read at most every 2 s). */
	private async gate(): Promise<SimulatorGate> {
		const now = Date.now();
		if (!this.memory || now - this.memory.at > memoryKeepMs)
			this.memory = { low: await this.tools.lowMemory().catch(() => false), at: now };
		return this.count();
	}
	/** Booted devices, ours booting, and slots taken by boots that passed the gate but have not registered yet. */
	private count(): SimulatorGate {
		const running = new Set(this.devices.filter((item) => item.booted).map((item) => item.id));
		for (const [id, runtime] of this.runtimes)
			if (runtime.status === 'on' || runtime.status === 'booting') running.add(id);
		for (const id of this.reserved) running.add(id);
		return { running: running.size, max: this.tools.cap(), lowMemory: this.memory?.low ?? false };
	}
	/**
	 * spec/browser-and-simulator#sim-cap: one look at the gate for a boot. The device list is read again (a device started or shut down
	 * outside the app counts), then the slot is counted and taken in one step, so two boots never take the same free slot.
	 */
	private async tryBoot(device: string, anyway: boolean) {
		await this.listDevices().catch(() => {});
		await this.gate();
		const gate = this.count();
		if (gateOpen(gate, anyway)) this.reserved.add(device);
		return { open: gateOpen(gate, anyway), gate };
	}
	/** Another task holds the device's lane now, or holds a lease on it. */
	private heldByOther(device: string, key: TaskKey) {
		const holder = this.queue.holder(device);
		if (holder && !same(holder, key)) return true;
		for (const item of this.leases.values())
			if (item.lease.device === device && !same(item.key, key)) return true;
		return false;
	}
	/** A copy made for another task: never matched by a kind or a name for anyone else. */
	private ownedByOther(device: string, key: TaskKey) {
		for (const item of this.leases.values())
			if (item.lease.device === device && item.lease.own && !same(item.key, key)) return true;
		return false;
	}
	/** spec/browser-and-simulator#sim-tab: who holds each device, seen from one task. */
	private uses(key: TaskKey, shown: string | null): Record<string, SimulatorUse> {
		const uses: Record<string, SimulatorUse> = {},
			own = this.leases.get(nameOf(key))?.lease.device;
		for (const device of this.devices) {
			const holder = this.queue.holder(device.id);
			if (device.id === own) {
				uses[device.id] =
					holder && !same(holder, key)
						? this.queue.waitsFor(key) === device.id
							? { kind: 'queued', holder }
							: { kind: 'mine', heldBy: holder }
						: { kind: 'mine' };
				continue;
			}
			if (holder && !same(holder, key)) {
				uses[device.id] = { kind: 'task', task: holder, busy: true };
				continue;
			}
			const others = [...this.leases.values()].filter(
				(item) => item.lease.device === device.id && !same(item.key, key)
			);
			const owner = others.find((item) => item.lease.own);
			if (owner) uses[device.id] = { kind: 'task', task: owner.key, busy: true };
			else if (others.length === 1) uses[device.id] = { kind: 'task', task: others[0]!.key };
			else if (others.length > 1) uses[device.id] = { kind: 'tasks', count: others.length };
		}
		void shown;
		return uses;
	}
	/** spec/browser-and-simulator#sim-lease: every project's lease file, read once. */
	private async loadLeases() {
		this.leasesLoaded ??= (async () => {
			const store = await SessionStore.at(this.dataDir);
			const projects = await readdir(join(store.root, 'projects')).catch(() => [] as string[]);
			for (const projectId of projects) {
				const doc = await readDocument(
					await safePath(store.root, 'projects', projectId, leaseFile)
				).catch(() => null);
				if (!doc) continue;
				for (const [id, lease] of Object.entries(simulatorLeases(doc.tasks)))
					this.leases.set(`${projectId}/${id}`, { key: { projectId, id }, lease });
			}
		})().catch(() => {});
		await this.leasesLoaded;
	}
	private async lease(key: TaskKey) {
		await this.loadLeases();
		return this.leases.get(nameOf(key));
	}
	/** Writes one task's record (or removes it) and saves the project's file, one write at a time per project. */
	private async writeLease(key: TaskKey, lease: SimulatorLease | null) {
		await this.loadLeases();
		if (lease) this.leases.set(nameOf(key), { key, lease });
		else this.leases.delete(nameOf(key));
		const tasks: Record<string, SimulatorLease> = {};
		for (const item of this.leases.values())
			if (item.key.projectId === key.projectId) tasks[item.key.id] = item.lease;
		const write = (this.leaseWrites.get(key.projectId) ?? Promise.resolve()).then(async () => {
			const store = await SessionStore.at(this.dataDir);
			await atomicJson(await safePath(store.root, 'projects', key.projectId, leaseFile), {
				schemaVersion: 1,
				tasks,
			});
		});
		this.leaseWrites.set(
			key.projectId,
			write.catch(() => {})
		);
		await write;
	}
	/**
	 * spec/browser-and-simulator#sim-lease: the task's lease moves to `device`; its old lane lets it go. `asDefault` — the person's pick, or the
	 * foreman's or a solo agent's `device`: it sets the project's device too (never to a copy). The chat gets the device row.
	 */
	private async setLease(key: TaskKey, device: SimulatorDevice, asDefault: boolean, quiet = false) {
		const current = (await this.lease(key))?.lease;
		if (asDefault && !this.ownedByOther(device.id, key) && !current?.own)
			await this.setDefault(key.projectId, device);
		if (current?.device === device.id) return;
		if (current?.device) this.queue.leave(current.device, key);
		// spec/browser-and-simulator#metro: the task's Metro client follows its device; the old one's buffers go with it.
		this.metros.get(nameOf(key))?.stop();
		this.metros.delete(nameOf(key));
		this.connected.delete(nameOf(key));
		// spec/browser-and-simulator#sim-own-device: a copy the task leaves keeps its own record (`<taskId>.<udid>`) until it is deleted.
		if (current?.own)
			await this.writeLease(
				{ projectId: key.projectId, id: `${key.id}.${current.device}` },
				current
			);
		await this.writeLease(key, { platform: device.platform, device: device.id });
		if (current?.own) void this.reconcile().catch(() => {});
		if (!quiet)
			await this.tools
				.record(key, { device: device.name, metroPort: await this.portOf(key), lowMemory: false })
				.catch(() => {});
		this.publishAll();
	}
	private async setDefault(projectId: string, device: SimulatorDevice) {
		if (this.selected.get(projectId) === device.id) return;
		this.selected.set(projectId, device.id);
		const simulator: ProjectSimulator = { platform: device.platform, device: device.id };
		await (await SessionStore.at(this.dataDir)).setProjectSimulator(projectId, simulator);
	}
	/**
	 * spec/browser-and-simulator#metro-port: the Metro ports the hosts gave their tasks (`metro-ports.json`), read at most once a second.
	 * A host takes its task's port itself when it starts, crew workers' hosts included.
	 */
	private async ports(): Promise<Record<string, number>> {
		if (this.portCache && Date.now() - this.portCache.at < 1000) return this.portCache.ports;
		const store = await SessionStore.at(this.dataDir);
		this.portCache = { ports: await readMetroPorts(store.root), at: Date.now() };
		return this.portCache.ports;
	}
	private async portOf(key: TaskKey) {
		return (await this.ports())[nameOf(key)] ?? null;
	}
	/** The task's own worktree, or null for a task in the project folder. */
	private async ownTree(key: TaskKey): Promise<string | null> {
		if (this.tools.worktree) return this.tools.worktree(key).catch(() => null);
		try {
			const store = await SessionStore.at(this.dataDir),
				[tree, project] = await Promise.all([
					store.projectForTask(key),
					store.project(key.projectId),
				]);
			return tree.path !== project.path ? tree.path : null;
		} catch {
			return null;
		}
	}
	/** spec/browser-and-simulator#metro-port: a worktree without its own dependencies cannot start Metro. */
	private async missingModules(key: TaskKey) {
		const own = await this.ownTree(key);
		if (!own) return null;
		const has = (name: string) =>
			access(join(own, name)).then(
				() => true,
				() => false
			);
		if (!(await has('package.json')) || (await has('node_modules'))) return null;
		const port = await this.portOf(key);
		return `This task's worktree has no node_modules, so its Metro cannot start: install the dependencies in the worktree (the project's install command), then start Metro there${port ? `; it takes port ${port} from RCT_METRO_PORT` : ''}.`;
	}
	/**
	 * spec/browser-and-simulator#metro-connect: points the device's app at the task's own Metro when that Metro answers without a target for
	 * the device: the dev client's link (iOS `simctl openurl`, Android `adb reverse` and `am start`), once per device and port.
	 */
	private async connect(key: TaskKey, runtime: Runtime): Promise<string | null> {
		const metro = this.metro(key);
		await metro.discover().catch(() => null);
		const port = connectPort(metro.found);
		if (port === null) return null;
		const mark = `${runtime.device.id}:${port}`;
		if (this.connected.get(nameOf(key)) === mark) return null;
		const store = await SessionStore.at(this.dataDir),
			own = await this.ownTree(key),
			project = (await store.project(key.projectId).catch(() => null))?.path,
			scheme = await appScheme(
				[own, project].filter((root): root is string => !!root),
				this.tools.readText
			);
		if (!scheme)
			return `Could not read the app's URL scheme from app.json: open <scheme>://expo-development-client/?url=${encodeURIComponent(`http://127.0.0.1:${port}`)} with simulator_open url.`;
		const link = devClientLink(scheme, port);
		if (runtime.serial) {
			await this.adb(runtime, ['reverse', `tcp:${port}`, `tcp:${port}`]);
			await this.adb(runtime, [
				'shell',
				'am',
				'start',
				'-a',
				'android.intent.action.VIEW',
				'-d',
				link,
			]);
		} else {
			await this.tools.run('/usr/bin/xcrun', ['simctl', 'openurl', runtime.device.id, link]);
			// iOS may ask «Open in …?» for a link from outside the app.
			await this.tools.sleep(1500);
			const ui = await this.ui(runtime, false, true).catch(() => null),
				open = ui && findElement(ui, { label: 'Open' });
			if (open && /button/i.test(open.role)) {
				const [x, y, w, h] = open.frame,
					screen = this.interface(runtime);
				await this.request(runtime, {
					cmd: 'tap',
					x: (x + w / 2) / screen.width,
					y: (y + h / 2) / screen.height,
				}).catch(() => null);
			}
		}
		this.connected.set(nameOf(key), mark);
		return `Connected ${runtime.device.name} to Metro :${port}.`;
	}
	/**
	 * spec/browser-and-simulator#sim-own-device: copies whose task ended go (`key` — only that task's). A device that is the source of a copy
	 * not yet reinstalled is never deleted. Records of ended tasks go with them.
	 */
	async reconcile(key?: TaskKey) {
		await this.loadLeases();
		const store = await SessionStore.at(this.dataDir);
		// A copy a later deletion frees (its clone was reinstalled or deleted) goes in the next pass of the same call.
		for (let progress = true; progress;) {
			progress = false;
			for (const item of [...this.leases.values()]) {
				// A copy its task left (`<taskId>.<udid>`) belongs to that task.
				const owner = { projectId: item.key.projectId, id: item.key.id.split('.')[0]! };
				if (key && !same(owner, key)) continue;
				const left = item.key.id !== owner.id;
				if (!left && !(await this.tools.taskEnded(owner).catch(() => false))) continue;
				if (!left) {
					this.queue.release(owner);
					this.queue.leave(item.lease.device, owner);
					this.metros.get(nameOf(owner))?.stop();
					this.metros.delete(nameOf(owner));
				}
				// The record stays until its copy is really deleted.
				if (item.lease.own && !(await this.removeCopy(item.lease.device))) continue;
				await this.writeLease(item.key, null);
				progress = true;
			}
		}
		// spec/browser-and-simulator#metro-port: an ended task gives its port back.
		for (const name of Object.keys(await readMetroPorts(store.root))) {
			const [projectId, id] = name.split('/') as [string, string];
			if (key && !same({ projectId, id }, key)) continue;
			if (await this.tools.taskEnded({ projectId, id }).catch(() => false))
				await forgetMetroPort(store.root, { projectId, id }).catch(() => {});
		}
		this.portCache = null;
		this.publishAll();
	}
	/** Shuts down and deletes a copy, unless a copy not yet reinstalled still runs from it. */
	private async removeCopy(udid: string): Promise<boolean> {
		for (const item of this.leases.values())
			if (item.lease.own?.source === udid && !item.lease.own.reinstalled) return false;
		const runtime = this.runtimes.get(udid);
		if (runtime) {
			this.stopHelper(runtime);
			runtime.logs?.stop();
			this.runtimes.delete(udid);
		}
		await this.tools.run('/usr/bin/xcrun', ['simctl', 'shutdown', udid]).catch(() => {});
		const deleted = await this.tools.run('/usr/bin/xcrun', ['simctl', 'delete', udid]).then(
			() => true,
			// A device that is gone already counts as deleted.
			(error: unknown) => /Invalid device|not found/i.test(String(error))
		);
		if (deleted) this.devices = this.devices.filter((item) => item.id !== udid);
		return deleted;
	}
	/**
	 * spec/browser-and-simulator#sim-act-settle: one action, then the wait for a still screen and, on iOS, what changed in the tree. Android
	 * gives no diff: `uiautomator dump` takes seconds and sometimes comes back empty.
	 */
	private async act(runtime: Runtime, command: SimulatorActRequest, watch: ScreenWatch) {
		// iOS: the tree before the action, which also tells taps by points the interface the app draws (`turned`).
		const before = runtime.serial
			? null
			: await this.ui(runtime, false).then(
					(ui) => ({ ui }),
					(error: unknown) => ({ error: reason(error) })
				);
		const done = await this.perform(runtime, command, before && 'ui' in before ? before.ui : null);
		const settled = await watch.settle();
		const lines = [`${done} ${settleLine(settled)}`];
		let read = false;
		if (!before)
			lines.push(
				'No tree diff on Android: reading the tree takes seconds. Call simulator_ui when you need it.'
			);
		else if ('error' in before)
			lines.push(`No tree diff: the tree before the action could not be read (${before.error}).`);
		else
			lines.push(
				await this.ui(runtime, false).then(
					(after) => {
						read = true;
						return formatUiDiff(diffUi(before.ui, after));
					},
					(error: unknown) =>
						`No tree diff: the tree after the action could not be read (${reason(error)}).`
				)
			);
		// Only a tree read after the turn tells whether the app turned with the device.
		if (command.action === 'rotate' && !runtime.serial)
			lines[0] = `Rotated to ${runtime.orientation}; ${read ? `the app ${runtime.turned ? 'turned with the device' : 'stays in portrait'}` : 'whether the app turned is unknown (no tree after the turn)'}. ${settleLine(settled)}`;
		return lines.join('\n');
	}
	/** The action itself; `ui` is the tree just read (iOS), so a target by id or label is not read twice. */
	private async perform(
		runtime: Runtime,
		command: SimulatorActRequest,
		ui: SimulatorUi | null
	): Promise<string> {
		if (command.action === 'rotate') {
			await this.rotate(runtime);
			this.publishDevice(runtime.device.id);
			return `Rotated to ${runtime.orientation}. Call simulator_ui: it tells whether the app turned with the device.`;
		}
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
				const element = findElement(ui ?? (await this.ui(runtime, false)), command);
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
				this.emit({
					device: runtime.device.id,
					tap: { ...point, label: `${command.action} · ${label}` },
				});
				await this.request(runtime, { cmd: command.action, ...device(point) });
				return `${command.action === 'tap' ? 'Tapped' : 'Long-pressed'} ${label}.`;
			}
			case 'swipe': {
				const { point } = await target();
				if (command.x2 === undefined || command.y2 === undefined)
					throw new Error('Give x2 and y2 in points for the end of the swipe.');
				const end = device(unit(command.x2, command.y2)),
					start = device(point);
				this.emit({ device: runtime.device.id, tap: { ...point, label: 'swipe' } });
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
	/** A watch on the screen's frames for the length of one agent call. */
	private async withWatch<T>(runtime: Runtime, run: (watch: ScreenWatch) => Promise<T>) {
		const watch = new ScreenWatch(runtime.device.platform);
		runtime.watches.add(watch);
		try {
			return await run(watch);
		} finally {
			runtime.watches.delete(watch);
		}
	}
	/** spec/browser-and-simulator#metro: the task's own Metro client — its tree first, its device's target, the project's task ports. */
	private metro(key: TaskKey) {
		let metro = this.metros.get(nameOf(key));
		if (metro) return metro;
		let own: string | null = null;
		void this.ownTree(key).then((tree) => (own = tree));
		metro = new MetroSession(
			async () => {
				const store = await SessionStore.at(this.dataDir);
				own = await this.ownTree(key);
				return [
					...(own ? [own] : []),
					join(store.root, 'worktrees', key.projectId),
					(await store.project(key.projectId)).path,
				];
			},
			() => this.publishTask(key),
			this.tools.metro,
			() => {
				const id =
					this.views.get(nameOf(key))?.device ?? this.leases.get(nameOf(key))?.lease.device;
				return this.devices.find((device) => device.id === id)?.name ?? null;
			},
			() => own,
			() =>
				Object.entries(this.portCache?.ports ?? {})
					.filter(([name]) => name.startsWith(`${key.projectId}/`))
					.map(([, port]) => port)
		);
		this.metros.set(nameOf(key), metro);
		return metro;
	}
	/** Reload through Metro's message socket, the same as `r` in its terminal. */
	private async reload(key: TaskKey) {
		const target = this.metros.get(nameOf(key))?.target;
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
	private async devtools(key: TaskKey) {
		const target = this.metros.get(nameOf(key))?.target;
		if (!target) throw new Error(metroMissing);
		const response = await fetch(
			`http://127.0.0.1:${target.port}/open-debugger?appId=${encodeURIComponent(target.appId)}`,
			{ method: 'POST' }
		);
		if (!response.ok) throw new Error('Metro did not open React Native DevTools.');
		return null;
	}
	/** The app's native log of the last two minutes: the process of the app Metro serves (`appId`). */
	private async nativeLogs(key: TaskKey, runtime: Runtime, level?: string, grep?: string) {
		const appId = this.metros.get(nameOf(key))?.target?.appId;
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
	private async ui(runtime: Runtime, grid: boolean, fresh = false) {
		// spec/browser-and-simulator#sim-act-settle: a tree stays true while the screen sends no changing frame, for 10 s at most.
		const kept = runtime.tree;
		let ui: SimulatorUi | null;
		if (
			!grid &&
			!fresh &&
			kept &&
			kept.changes === runtime.changes &&
			this.tools.now() - kept.at < treeKeepMs
		)
			ui = kept.ui;
		else {
			const changes = runtime.changes,
				at = this.tools.now();
			ui = simulatorUi(await this.request(runtime, { cmd: 'ui', grid }, 40_000));
			if (!ui) throw new Error('The device sent no accessibility tree.');
			if (!grid) runtime.tree = { ui, changes, at };
		}
		const app = ui.elements.find((element) => element.role === 'Application');
		runtime.turned =
			!runtime.serial && isLandscape(runtime.orientation) && !!app && app.frame[2] > app.frame[3];
		return { ...ui, ...this.interface(runtime) };
	}
	/** Boots a device when needed (through the gate) and waits for its stream, like the column's Start. */
	private async ready(key: TaskKey, device: SimulatorDevice, person: boolean, anyway = false) {
		await this.bootDevice(key, device, person, anyway);
		for (let waited = 0; waited < 60_000; waited += 250) {
			const runtime = this.runtimes.get(device.id);
			if (runtime?.status === 'on' && runtime.helper) return runtime;
			if (runtime?.status === 'error')
				throw new Error(runtime.error ?? 'The device did not start.');
			await new Promise((resolve) => setTimeout(resolve, 250));
		}
		throw new Error('The device did not start in a minute.');
	}
	/** One task's view: its device, who holds every device, the gate and its Metro (spec/browser-and-simulator#sim-tab). */
	async state(key: TaskKey): Promise<SimulatorState> {
		if (!this.toolchain) await this.refresh();
		await this.loadLeases();
		const device = await this.deviceFor(key),
			runtime = device ? this.runtimes.get(device.id) : undefined,
			status = runtime?.status ?? 'off',
			view = this.views.get(nameOf(key));
		if (view) view.device = device?.id ?? null;
		// Metro is looked for while the device runs, so the buffers hold what happened before the agent asks.
		if (status === 'on') this.metro(key).start();
		else this.metros.get(nameOf(key))?.stop();
		const target = this.metros.get(nameOf(key))?.target;
		if (runtime && status === 'on' && target?.appId) void this.followLogs(runtime, target.appId);
		const waiting = this.gateWaits.has(nameOf(key));
		return {
			toolchain: this.toolchain!,
			devices: this.devices,
			device: device ? { ...device, booted: device.booted || status === 'on' } : null,
			// A boot that waits at the gate shows as starting (spec/browser-and-simulator#sim-tab).
			status: waiting && status === 'off' ? 'booting' : status,
			gateWait: waiting && status === 'off',
			error: runtime?.error ?? null,
			screen: runtime?.screen ?? null,
			orientation: runtime?.orientation ?? 'portrait',
			metro: target ? { port: target.port, appId: target.appId, root: target.root } : null,
			uses: this.uses(key, device?.id ?? null),
			gate: await this.gate(),
			metroPort: await this.portOf(key),
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
					.map((device) => {
						// spec/browser-and-simulator#sim-own-device: a copy of a booted device is a new one of the same model and runtime.
						if (typeof device.deviceTypeIdentifier === 'string')
							this.kinds.set(String(device.udid), { type: device.deviceTypeIdentifier, runtime });
						return device;
					})
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
	/** The project's device: saved in project.json, else a booted iPhone, else the first iPhone of the newest runtime. Never a task's copy. */
	private async device(projectId: string) {
		if (!this.selected.has(projectId)) {
			const saved = (await (await SessionStore.at(this.dataDir)).project(projectId)).simulator;
			this.selected.set(projectId, saved?.device ?? null);
		}
		await this.loadLeases();
		const id = this.selected.get(projectId),
			listed = this.devices.filter((device) => !this.isCopy(device.id));
		return (
			this.devices.find((device) => device.id === id) ??
			listed.find((device) => device.booted && device.name.startsWith('iPhone')) ??
			listed.find((device) => device.name.startsWith('iPhone')) ??
			listed[0] ??
			null
		);
	}
	private isCopy(device: string) {
		for (const item of this.leases.values())
			if (item.lease.own && item.lease.device === device) return true;
		return false;
	}
	/** spec/browser-and-simulator#sim-lease: the task's leased device, else the project's. */
	private async deviceFor(key: TaskKey) {
		const leased = (await this.lease(key))?.lease.device,
			device = leased ? this.devices.find((item) => item.id === leased) : undefined;
		return device ?? (await this.device(key.projectId));
	}
	/** A device saved in project.json and still listed; the fallbacks of `device` are not a choice (spec/browser-and-simulator#sim-device). */
	private chosen(projectId: string) {
		const id = this.selected.get(projectId);
		return !!id && this.devices.some((device) => device.id === id);
	}
	private async runtime(key: TaskKey) {
		const device = await this.deviceFor(key);
		return device ? (this.runtimes.get(device.id) ?? null) : null;
	}
	private async live(key: TaskKey) {
		const runtime = await this.runtime(key);
		if (!runtime || runtime.status !== 'on' || !runtime.helper)
			throw new Error('The device is not running.');
		return runtime;
	}
	private view(key: TaskKey) {
		let view = this.views.get(nameOf(key));
		if (!view) {
			view = { key, watchers: 0, device: null };
			this.views.set(nameOf(key), view);
		}
		return view;
	}
	/** The person picks a device in the task's tab: the task's lease moves to it, and the project's device follows (spec/browser-and-simulator#sim-lease). */
	private async select(key: TaskKey, id: string, person: boolean) {
		if (!this.toolchain) await this.refresh();
		const device = this.devices.find((item) => item.id === id);
		if (!device) throw new Error('The device is not available.');
		await this.setLease(key, device, person);
		const runtime = this.runtimes.get(device.id);
		if (runtime?.status === 'on') void this.connect(key, runtime).catch(() => null);
		return this.publish(key);
	}
	/** The tab's Start: the task takes its device and boots it; `anyway` — the person lifted the low-memory block (spec/browser-and-simulator#sim-cap). */
	private async start(key: TaskKey, anyway: boolean) {
		const device = await this.deviceFor(key);
		if (!device) throw new Error('No device is available.');
		const runtime = this.runtimes.get(device.id),
			off = !device.booted && runtime?.status !== 'on' && runtime?.status !== 'booting',
			low = anyway && off && (await this.gate()).lowMemory;
		// spec/browser-and-simulator#sim-chat-row: a start past low memory leaves its own row, once the gate let it through.
		await this.setLease(key, device, false, low);
		await this.bootDevice(key, device, true, anyway);
		if (low)
			await this.tools
				.record(key, {
					device: device.name,
					metroPort: await this.portOf(key),
					lowMemory: true,
				})
				.catch(() => {});
		void this.ready(key, device, true, anyway)
			.then((runtime) => this.connect(key, runtime))
			.catch(() => null);
		return this.state(key);
	}
	/**
	 * Boots a device that is off, after the gate (spec/browser-and-simulator#sim-cap): an agent waits for it; the person is refused at once,
	 * and `anyway` lifts only the low-memory block.
	 */
	private async bootDevice(key: TaskKey, device: SimulatorDevice, person: boolean, anyway = false) {
		const existing = this.runtimes.get(device.id);
		if (existing && (existing.status === 'on' || existing.status === 'booting')) return;
		if (!device.booted) {
			const name = nameOf(key);
			await passGate({
				attempt: () => this.tryBoot(device.id, anyway),
				device: device.name,
				waitMs: person ? 0 : this.tools.gateWaitMs,
				sleep: this.tools.sleep,
				waiting: (on) => {
					if (on) this.gateWaits.add(name);
					else this.gateWaits.delete(name);
					this.tools.waiting(key.projectId, [
						...new Set([
							...this.queue.waiting(key.projectId),
							...[...this.gateWaits]
								.filter((item) => item.startsWith(`${key.projectId}/`))
								.map((item) => item.slice(key.projectId.length + 1)),
						]),
					]);
					this.publishTask(key);
				},
			});
		}
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
			watches: new Set(),
			changes: 0,
			tree: null,
		};
		runtime.status = 'booting';
		runtime.error = null;
		this.runtimes.set(device.id, runtime);
		// The booting runtime counts from here on: the slot taken at the gate is no longer needed.
		this.reserved.delete(device.id);
		this.publishDevice(device.id);
		try {
			if (device.platform === 'android') {
				await this.bootAndroid(runtime);
				if (this.closed) return;
				this.startHelper(runtime);
				return;
			}
			if (!device.booted) {
				await this.tools.run('/usr/bin/xcrun', ['simctl', 'boot', device.id]).catch((error) => {
					if (!/current state: Booted/.test(String(error?.stderr ?? error))) throw error;
				});
				runtime.bootedByUs = true;
			}
			await this.tools.run('/usr/bin/xcrun', ['simctl', 'bootstatus', device.id, '-b']);
			device.booted = true;
			if (this.closed) return;
			this.startHelper(runtime);
		} catch (error) {
			runtime.status = 'error';
			runtime.error = `${device.name} did not start: ${error instanceof Error ? error.message.split('\n')[0] : String(error)}`;
			this.publishDevice(device.id);
		}
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
	/** `id` — a running device of the picker (spec/task-window-workspace#tool-tab-look.1); the task's own device otherwise. */
	private async shutdown(key: TaskKey, id?: string) {
		const device =
			id === undefined ? await this.deviceFor(key) : this.devices.find((item) => item.id === id);
		if (!device) return this.state(key);
		// spec/browser-and-simulator#sim-tab: a device another task is using now, or another task's own copy, is not shut down under it.
		const holder = this.queue.holder(device.id);
		if ((holder && !same(holder, key)) || this.ownedByOther(device.id, key))
			throw new Error(`${device.name} is in use by another task.`);
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
		return this.state(key);
	}
	/**
	 * ASCII types as keys; anything else lands on the device pasteboard for the device's own «Paste». The text is
	 * this Mac's clipboard, or the one a window of this machine on a device sent (spec/remote-access-and-mobile#browser-from-device).
	 */
	private async paste(runtime: Runtime, given?: string) {
		const text = given ?? (await this.tools.clipboard());
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
	keyframe(device: string) {
		const runtime = this.runtimes.get(device);
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
		runtime.tree = null;
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
			if (this.watched(runtime.device.id)) this.frame(runtime.device.id, frame);
			if (isChange(runtime.device.platform, frame)) runtime.changes++;
			for (const watch of runtime.watches) watch.frame(frame);
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
				this.emit({ device: runtime.device.id, config: runtime.config });
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
	/** Whether a tab that watches shows this device: its frames flow only then. */
	private watched(deviceId: string) {
		for (const view of this.views.values())
			if (view.watchers > 0 && view.device === deviceId) return true;
		return false;
	}
	private async publish(key: TaskKey) {
		const state = await this.state(key);
		this.emit({ key, state });
		return state;
	}
	private publishTask(key: TaskKey) {
		if (this.views.has(nameOf(key))) void this.publish(key).catch(() => {});
	}
	private publishDevice(deviceId: string) {
		for (const view of this.views.values())
			if (view.device === deviceId || view.device === null) this.publishTask(view.key);
	}
	/** Leases or lanes changed: every open tab redraws who holds what, once per tick. */
	private publishAll() {
		if (this.publishing) return;
		this.publishing = true;
		queueMicrotask(() => {
			this.publishing = false;
			for (const view of this.views.values()) this.publishTask(view.key);
		});
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
const reason = (error: unknown) =>
	error instanceof Error ? error.message.replace(/\.$/, '') : String(error);
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
