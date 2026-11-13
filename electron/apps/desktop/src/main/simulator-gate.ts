import { gateOpen, type SimulatorGate } from '@brigadir/core';
/**
 * spec/browser-and-simulator#sim-cap: before a device boots, the cap of local devices and the system's own memory-pressure signal.
 * Free memory is not a signal on macOS (the file cache fills it), so the kernel's pressure level is read instead.
 */
export type GateTools = {
	platform: NodeJS.Platform;
	run: (file: string, args: string[]) => Promise<string>;
	read: (path: string) => Promise<string>;
};
/** True while the system reports memory pressure; a signal that cannot be read counts as none. */
export async function lowMemory(tools: GateTools): Promise<boolean> {
	try {
		if (tools.platform === 'darwin') {
			// 1 normal, 2 warn, 4 critical.
			const level = Number(
				(await tools.run('/usr/sbin/sysctl', ['-n', 'kern.memorystatus_vm_pressure_level'])).trim()
			);
			return level >= 2;
		}
		if (tools.platform === 'linux') {
			const pressure = await tools.read('/proc/pressure/memory').catch(() => null);
			const some = pressure ? /^some avg10=([\d.]+)/m.exec(pressure)?.[1] : undefined;
			if (some !== undefined) return Number(some) >= 10;
			const info = await tools.read('/proc/meminfo'),
				field = (name: string) => Number(new RegExp(`^${name}:\\s+(\\d+)`, 'm').exec(info)?.[1]);
			const available = field('MemAvailable'),
				total = field('MemTotal');
			return Number.isFinite(available) && total > 0 && available / total < 0.1;
		}
	} catch {
		/* no signal */
	}
	return false;
}
/** The sentence an agent gets when its boot gave up at the gate. */
export function gateRefusal(device: string, gate: SimulatorGate) {
	return gate.running >= gate.max
		? `Cannot start ${device}: ${gate.running} of ${gate.max} local devices run (Settings ▸ Modules ▸ Simulator settings). Use a running device (simulator_state lists them) or retry later.`
		: `Cannot start ${device}: memory is low. Retry later, or ask the person to start it.`;
}
/** Why a worker shares a device instead of getting its own (spec/browser-and-simulator#sim-lease). */
export function shareReason(gate: SimulatorGate) {
	return gate.running >= gate.max
		? `${gate.running} of ${gate.max} local devices run`
		: 'memory is low';
}
/**
 * Waits until a device may start: every `stepMs` the gate is read again, up to `waitMs`. `waiting` is called once when the wait
 * begins (the task's card and tab say why) and once with `false` when it ends.
 */
export async function passGate(options: {
	read(): Promise<SimulatorGate>;
	device: string;
	anyway?: boolean;
	waitMs?: number;
	stepMs?: number;
	sleep?: (ms: number) => Promise<void>;
	waiting?: (on: boolean, gate: SimulatorGate) => void;
}): Promise<SimulatorGate> {
	const waitMs = options.waitMs ?? 60_000,
		stepMs = options.stepMs ?? 2000,
		sleep = options.sleep ?? ((ms: number) => new Promise((resolve) => setTimeout(resolve, ms)));
	let gate = await options.read();
	if (gateOpen(gate, options.anyway)) return gate;
	options.waiting?.(true, gate);
	try {
		for (let waited = 0; waited < waitMs; waited += stepMs) {
			await sleep(stepMs);
			gate = await options.read();
			if (gateOpen(gate, options.anyway)) return gate;
		}
	} finally {
		options.waiting?.(false, gate);
	}
	throw new Error(gateRefusal(options.device, gate));
}
