import { expect, it } from 'vitest';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { execFileSync } from 'node:child_process';
import { appendFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import type { SimulatorFrame, SimulatorState, SimulatorVideoConfig } from '@brigadir/core';
import { Simulators } from './simulator';
// Live check of spec/browser-and-simulator#simulator on this Mac: the built sim-helper, a real iOS device booted without a window.
// Opt in with BRIGADIR_LIVE_SIMULATOR=<UDID>; BRIGADIR_RECORD_FRAME=1 also writes tests/fixtures/sim-frame.json.
const udid = process.env.BRIGADIR_LIVE_SIMULATOR;
// BRIGADIR_LIVE_LOG=<file>: the agent answers and their timings, for the report of a live run.
const report = (text: string) => {
	if (process.env.BRIGADIR_LIVE_LOG) appendFileSync(process.env.BRIGADIR_LIVE_LOG, `${text}\n`);
};
it.skipIf(!udid)(
	'boots a real device, streams H.264 and answers the agent tools',
	async () => {
		const root = await mkdtemp(join(tmpdir(), 'brigadir-simulator-live-')),
			data = join(root, 'data');
		await mkdir(join(data, 'projects/project'), { recursive: true });
		await writeFile(
			join(data, 'projects/project/project.json'),
			JSON.stringify({ schemaVersion: 1, project: { id: 'project', name: 'live', path: root } })
		);
		let config: SimulatorVideoConfig | null = null;
		const frames: SimulatorFrame[] = [];
		const simulators = new Simulators(
			data,
			resolve('apps/desktop/out/services/sim-helper'),
			(event) => {
				if ('config' in event) config = event.config;
			},
			(_device, frame) => frames.push(frame)
		);
		const key = { projectId: 'project', id: 'task' };
		try {
			await simulators.command(key, { kind: 'select', device: udid! });
			await simulators.command(key, { kind: 'watch', on: true });
			expect(await simulators.agent(key, { tool: 'open' })).toMatch(/is running/);
			await expect.poll(() => frames.some((frame) => frame.key), { timeout: 10_000 }).toBe(true);
			expect(config).toMatchObject({ codec: expect.stringMatching(/^avc1\./) });
			const state = (await simulators.command(key, { kind: 'state' })) as SimulatorState;
			expect(state.status).toBe('on');
			expect(state.screen?.width).toBeGreaterThan(300);
			await simulators.agent(key, { tool: 'act', action: 'button', button: 'home' });
			const tree = (await simulators.agent(key, { tool: 'ui' })) as string;
			expect(tree).toMatch(/^Screen \d+×\d+ pt/);
			// spec/browser-and-simulator#sim-act-settle, #sim-wait: one call acts, waits for a still screen and says what changed.
			const timed = async (command: Parameters<Simulators['agent']>[1]) => {
				const start = Date.now(),
					answer = (await simulators.agent(key, command)) as string;
				report(
					`${JSON.stringify(command)} → ${Date.now() - start} ms\n${answer.split('\n').slice(0, 6).join('\n')}`
				);
				return answer;
			};
			await timed({ tool: 'act', action: 'button', button: 'home' });
			expect(await timed({ tool: 'act', action: 'tap', label: 'Settings' })).toMatch(
				/^Tapped Settings\. (Screen settled in|The screen was still changing after) [\d.]+ s.*\n(Changes: |No changes)/
			);
			expect(await timed({ tool: 'wait', text: 'General' })).toMatch(/^Found .*"General"/);
			expect(await timed({ tool: 'act', action: 'tap', label: 'General' })).toMatch(/\nChanges: /);
			expect(await timed({ tool: 'wait', text: 'no such text', timeoutMs: 1500 })).toMatch(
				/^Timed out after 1\.5 s: no element with text "no such text" appeared\.\nScreen /
			);
			await timed({ tool: 'act', action: 'button', button: 'home' });
			expect(await timed({ tool: 'wait', label: 'General', gone: true })).toMatch(/is gone after/);
			// Turned: the home screen stays portrait, Safari turns; a tap by label lands in the turned interface.
			expect(await simulators.agent(key, { tool: 'act', action: 'rotate' })).toMatch(
				/^Rotated to landscapeRight/
			);
			expect(await simulators.agent(key, { tool: 'ui' })).toMatch(/^Screen 402×874 pt/);
			await simulators.agent(key, { tool: 'open', app: 'com.apple.mobilesafari' });
			await expect
				.poll(
					async () => ((await simulators.agent(key, { tool: 'ui' })) as string).split('\n')[0],
					{ timeout: 20_000 }
				)
				.toMatch(/^Screen 874×402 pt/);
			// A tap by id lands in the turned interface: the Start Page card opens its customisation sheet.
			if (
				((await simulators.agent(key, { tool: 'ui' })) as string).includes(
					'#onboardingButton-CustomizeStartPage'
				)
			) {
				await simulators.agent(key, {
					tool: 'act',
					action: 'tap',
					id: 'onboardingButton-CustomizeStartPage',
				});
				await expect
					.poll(async () => (await simulators.agent(key, { tool: 'ui' })) as string, {
						timeout: 10_000,
					})
					.not.toContain('#onboardingButton-CustomizeStartPage');
			}
			await simulators.agent(key, { tool: 'act', action: 'rotate' });
			await simulators.agent(key, { tool: 'act', action: 'rotate' });
			await simulators.agent(key, { tool: 'act', action: 'rotate' });
			expect(
				((await simulators.command(key, { kind: 'state' })) as SimulatorState).orientation
			).toBe('portrait');
			const shot = (await simulators.agent(key, { tool: 'screenshot' })) as { image: string };
			expect(Buffer.from(shot.image, 'base64').subarray(0, 2)).toEqual(Buffer.from([0xff, 0xd8]));
			if (process.env.BRIGADIR_RECORD_FRAME === '1') {
				const frame = frames.findLast((item) => item.key)!;
				await writeFile(
					resolve('tests/fixtures/sim-frame.json'),
					JSON.stringify({
						config,
						frame: Buffer.concat([
							Buffer.from([1]),
							Buffer.alloc(8),
							Buffer.from(frame.data),
						]).toString('base64'),
					})
				);
			}
			console.log(tree.split('\n').slice(0, 8).join('\n'), `\nframes: ${frames.length}`);
			await simulators.command(key, { kind: 'shutdown' });
		} finally {
			simulators.close();
			await rm(root, { recursive: true, force: true });
		}
	},
	180_000
);
// BRIGADIR_LIVE_ANDROID=<AVD name>: the same through the emulator and scrcpy-server.
const avd = process.env.BRIGADIR_LIVE_ANDROID;
it.skipIf(!avd)(
	'starts a real emulator without a window, streams H.264 over scrcpy and answers the agent tools',
	async () => {
		const root = await mkdtemp(join(tmpdir(), 'brigadir-android-live-')),
			data = join(root, 'data');
		await mkdir(join(data, 'projects/project'), { recursive: true });
		await writeFile(
			join(data, 'projects/project/project.json'),
			JSON.stringify({ schemaVersion: 1, project: { id: 'project', name: 'live', path: root } })
		);
		let config: SimulatorVideoConfig | null = null;
		const frames: SimulatorFrame[] = [];
		const simulators = new Simulators(
			data,
			resolve('apps/desktop/out/services/sim-helper'),
			(event) => {
				if ('config' in event) config = event.config;
			},
			(_device, frame) => frames.push(frame),
			{ node: 'node' }
		);
		const key = { projectId: 'project', id: 'task' };
		try {
			await simulators.command(key, { kind: 'select', device: avd! });
			await simulators.command(key, { kind: 'watch', on: true });
			expect(await simulators.agent(key, { tool: 'open' })).toMatch(/is running/);
			await expect.poll(() => frames.some((frame) => frame.key), { timeout: 15_000 }).toBe(true);
			expect(config).toMatchObject({ codec: expect.stringMatching(/^avc1\./) });
			await simulators.agent(key, { tool: 'act', action: 'button', button: 'home' });
			const tree = (await simulators.agent(key, { tool: 'ui' })) as string;
			expect(tree).toMatch(/^Screen \d+×\d+ pt/);
			// Android turns its own stream when the app turns (the Pixel launcher does not): Settings does.
			await simulators.agent(key, { tool: 'open', app: 'com.android.settings' });
			await new Promise((resolve) => setTimeout(resolve, 2000));
			// The AVD keeps its rotation in the snapshot: compare with the side it started on, and leave it as it was.
			const wide = () => config!.width > config!.height,
				before = wide();
			await simulators.agent(key, { tool: 'act', action: 'rotate' });
			await expect.poll(wide, { timeout: 15_000 }).toBe(!before);
			await simulators.agent(key, { tool: 'act', action: 'rotate' });
			await simulators.agent(key, { tool: 'act', action: 'rotate' });
			await simulators.agent(key, { tool: 'act', action: 'rotate' });
			await expect.poll(wide, { timeout: 15_000 }).toBe(before);
			const shot = (await simulators.agent(key, { tool: 'screenshot' })) as {
				image: string;
				mimeType: string;
			};
			expect(shot.mimeType).toBe('image/png');
			console.log(tree.split('\n').slice(0, 8).join('\n'), `\nframes: ${frames.length}`);
			await simulators.command(key, { kind: 'shutdown' });
		} finally {
			simulators.close();
			await rm(root, { recursive: true, force: true });
		}
	},
	300_000
);

// BRIGADIR_LIVE_DEVICES=<UDID A>,<UDID B> and BRIGADIR_LIVE_APP=<a simulator .app>: spec/browser-and-simulator#sim-lease and #sim-own-device on
// this Mac — two tasks on two devices at once, then a crew worker's own copies (a new device while A runs, a clone once A is off), each
// with the app installed again, driven by simulator_act. Times and the memory the system counts as used go to BRIGADIR_LIVE_LOG.
const pair = process.env.BRIGADIR_LIVE_DEVICES?.split(',');
const usedGb = () => {
	const out = execFileSync('/usr/bin/vm_stat', { encoding: 'utf8' }),
		page = Number(/page size of (\d+)/.exec(out)?.[1] ?? 16384),
		count = (name: string) => Number(new RegExp(`${name}:\\s+(\\d+)`).exec(out)?.[1] ?? 0);
	return (
		((count('Pages active') + count('Pages wired down') + count('Pages occupied by compressor')) *
			page) /
		2 ** 30
	);
};
it.skipIf(!pair || !process.env.BRIGADIR_LIVE_APP)(
	'runs two leases on two devices at once and gives a worker its own copy with the app reinstalled',
	async () => {
		const [first, second] = pair!;
		const root = await mkdtemp(join(tmpdir(), 'brigadir-devices-live-')),
			data = join(root, 'data');
		await mkdir(join(data, 'projects/project'), { recursive: true });
		await writeFile(
			join(data, 'projects/project/project.json'),
			JSON.stringify({
				schemaVersion: 1,
				project: {
					id: 'project',
					name: 'live',
					path: root,
					simulator: { platform: 'ios', device: first },
				},
			})
		);
		const ended = new Set<string>();
		const simulators = new Simulators(
			data,
			resolve('apps/desktop/out/services/sim-helper'),
			() => {},
			() => {},
			{
				cap: () => 4,
				taskEnded: async (key) => ended.has(key.id),
				taskTitle: async (key) => key.id,
			}
		);
		const task = (id: string) => ({ projectId: 'project', id });
		const timed = async <T>(label: string, work: () => Promise<T>) => {
			const start = Date.now(),
				before = usedGb(),
				value = await work();
			report(
				`${label}: ${Date.now() - start} ms, used memory ${before.toFixed(1)} → ${usedGb().toFixed(1)} GB`
			);
			return value;
		};
		try {
			report(
				`pressure level ${execFileSync('/usr/sbin/sysctl', ['-n', 'kern.memorystatus_vm_pressure_level'], { encoding: 'utf8' }).trim()}`
			);
			await timed('open A (solo, project device)', () =>
				simulators.agent(task('solo'), { tool: 'open' })
			);
			execFileSync('/usr/bin/xcrun', ['simctl', 'install', first!, process.env.BRIGADIR_LIVE_APP!]);
			await timed('open B (second task, by id)', () =>
				simulators.agent(task('second'), { tool: 'open', device: second! })
			);
			const state = (await simulators.command(task('solo'), { kind: 'state' })) as SimulatorState;
			expect(state.uses[first!]).toEqual({ kind: 'mine' });
			expect(state.uses[second!]).toEqual({ kind: 'task', task: task('second') });
			// Both act at the same time, each on its own device.
			const [a, b] = await timed('act home on A and B at once', () =>
				Promise.all([
					simulators.agent(task('solo'), { tool: 'act', action: 'button', button: 'home' }),
					simulators.agent(task('second'), { tool: 'act', action: 'button', button: 'home' }),
				])
			);
			report(`A: ${String(a).split('\n')[0]}\nB: ${String(b).split('\n')[0]}`);
			expect(a).toMatch(/^Pressed home\./);
			expect(b).toMatch(/^Pressed home\./);
			// A worker while A runs: a new device of A's model, the app installed before use.
			const made = (await timed('worker 1: own copy (A runs: create + boot + install)', () =>
				simulators.agent(task('worker1'), { tool: 'open' }, true)
			)) as string;
			report(made);
			const copy = (
				(await simulators.command(task('worker1'), { kind: 'state' })) as SimulatorState
			).device!;
			expect(copy.id).not.toBe(first);
			const apps = execFileSync('/usr/bin/xcrun', ['simctl', 'listapps', copy.id], {
				encoding: 'utf8',
			});
			expect(apps).toContain(copy.id);
			report(
				`worker 1 act: ${String(await timed('worker 1 act home', () => simulators.agent(task('worker1'), { tool: 'act', action: 'button', button: 'home' }, true))).split('\n')[0]}`
			);
			// A is off: the next worker's copy is a clone of it, then the app is installed on the clone.
			await simulators.command(task('solo'), { kind: 'shutdown', device: first! });
			const cloned = (await timed('worker 2: clone of A (A off: clone + boot + install)', () =>
				simulators.agent(task('worker2'), { tool: 'open' }, true)
			)) as string;
			report(cloned);
			const clone = (
				(await simulators.command(task('worker2'), { kind: 'state' })) as SimulatorState
			).device!;
			const cloneApps = execFileSync('/usr/bin/xcrun', ['simctl', 'listapps', clone.id], {
				encoding: 'utf8',
			});
			// After the reinstall the clone's apps live in its own folder, not the source's.
			expect(cloneApps).toContain(clone.id);
			report(
				`worker 2 act: ${String(await timed('worker 2 act home', () => simulators.agent(task('worker2'), { tool: 'act', action: 'button', button: 'home' }, true))).split('\n')[0]}`
			);
			ended.add('worker1');
			ended.add('worker2');
			await timed('cleanup of both copies', () => simulators.reconcile());
			const left = execFileSync('/usr/bin/xcrun', ['simctl', 'list', 'devices'], {
				encoding: 'utf8',
			});
			expect(left).not.toContain(copy.id);
			expect(left).not.toContain(clone.id);
		} finally {
			simulators.close();
			await rm(root, { recursive: true, force: true });
		}
	},
	600_000
);
