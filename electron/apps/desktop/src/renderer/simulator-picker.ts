import {
	devicesRunning,
	gateOpen,
	t,
	taskCount,
	type AgentTask,
	type Locale,
	type SimulatorDevice,
	type SimulatorState,
	type TaskKey,
} from '@brigadir/core';
import { crewLabel } from './Crew';
import { crewWorkers } from './McpToolRow';
/** spec/browser-and-simulator#simulator: the device picker lists iOS first, then Android; headers only when both platforms are there. */
export function pickerDevices(devices: readonly SimulatorDevice[]) {
	const ordered = [...devices].sort(
		(a, b) => Number(a.platform !== 'ios') - Number(b.platform !== 'ios')
	);
	return { devices: ordered, grouped: new Set(ordered.map((item) => item.platform)).size > 1 };
}
/** A task as the picker names it: `{role} · {title}` for a crew worker, its title otherwise. */
export function taskLabel(locale: Locale, tasks: readonly AgentTask[], key: TaskKey) {
	const task = tasks.find((item) => item.projectId === key.projectId && item.id === key.id);
	if (!task) return key.id;
	const worker = crewWorkers(tasks, task)(task.id);
	return worker ? `${crewLabel(locale, worker.name)} · ${worker.title}` : task.title;
}
export type PickerRow = {
	device: SimulatorDevice;
	running: boolean;
	/** The row's name: `name · OS`. */
	label: string;
	/** The row's tail: who holds the device; empty when nobody does. */
	tail: string;
	/** Off while the gate is closed: a device that is off cannot start. */
	disabled: boolean;
	/** «Shut down {device}»: a running device no other task is using now and that is not another task's copy. */
	canShutDown: boolean;
};
/**
 * spec/browser-and-simulator#sim-tab: the picker seen from one task — every device with who holds it, the trigger (with the task it waits for),
 * and the footer while the gate is closed. `anyway` — the person lifted the low-memory block while the list is open.
 */
export function pickerModel(
	state: SimulatorState,
	locale: Locale,
	tasks: readonly AgentTask[],
	anyway: boolean
) {
	const { devices, grouped } = pickerDevices(state.devices);
	const open = gateOpen(state.gate, anyway);
	const rows: PickerRow[] = devices.map((device) => {
		const running = device.booted || (device.id === state.device?.id && state.status === 'on'),
			use = state.uses[device.id];
		const tail = !use
			? ''
			: use.kind === 'mine'
				? t(locale, 'this task')
				: use.kind === 'queued'
					? t(locale, 'queued')
					: use.kind === 'task'
						? taskLabel(locale, tasks, use.task)
						: taskCount(locale, use.count);
		return {
			device,
			running,
			label: `${device.name} · ${device.os}`,
			tail,
			disabled: !running && !open,
			canShutDown:
				running &&
				(!use ||
					use.kind === 'tasks' ||
					(use.kind === 'mine' && !use.heldBy) ||
					(use.kind === 'task' && !use.busy)),
		};
	});
	const own = state.device ? state.uses[state.device.id] : undefined;
	const trigger = state.device
		? own?.kind === 'queued'
			? t(locale, '{device} · waits for {task}')
					.replace('{device}', state.device.name)
					.replace('{task}', taskLabel(locale, tasks, own.holder))
			: `${state.device.name} · ${state.device.os}`
		: null;
	const footer =
		state.gate.running >= state.gate.max
			? { text: devicesRunning(locale, state.gate.running, state.gate.max) }
			: state.gate.lowMemory
				? anyway
					? { text: t(locale, 'Memory is low.'), tone: 'warning' as const }
					: {
							text: t(locale, 'Memory is low. New devices are off.'),
							tone: 'warning' as const,
							lift: true,
						}
				: null;
	return {
		rows,
		grouped,
		trigger,
		queued: own?.kind === 'queued',
		footer,
		// spec/browser-and-simulator#sim-cap: a boot that waits at the gate says why, in the footer's words.
		waitReason: state.gateWait ? footer : null,
	};
}
