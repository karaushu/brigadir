import { expect, it } from 'vitest';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import type { SimulatorFrame, SimulatorState, SimulatorVideoConfig } from '@brigadir/core';
import { Simulators } from './simulator';
// Live check of spec/browser-and-simulator#simulator on this Mac: the built sim-helper, a real iOS device booted without a window.
// Opt in with BRIGADIR_LIVE_SIMULATOR=<UDID>; BRIGADIR_RECORD_FRAME=1 also writes tests/fixtures/sim-frame.json.
const udid = process.env.BRIGADIR_LIVE_SIMULATOR;
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
			(_projectId, frame) => frames.push(frame)
		);
		const key = { projectId: 'project', id: 'task' };
		try {
			await simulators.command('project', { kind: 'select', device: udid! });
			await simulators.command('project', { kind: 'watch', on: true });
			expect(await simulators.agent(key, { tool: 'open' })).toMatch(/is running/);
			await expect.poll(() => frames.some((frame) => frame.key), { timeout: 10_000 }).toBe(true);
			expect(config).toMatchObject({ codec: expect.stringMatching(/^avc1\./) });
			const state = (await simulators.command('project', { kind: 'state' })) as SimulatorState;
			expect(state.status).toBe('on');
			expect(state.screen?.width).toBeGreaterThan(300);
			await simulators.agent(key, { tool: 'act', action: 'button', button: 'home' });
			const tree = (await simulators.agent(key, { tool: 'ui' })) as string;
			expect(tree).toMatch(/^Screen \d+×\d+ pt/);
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
				((await simulators.command('project', { kind: 'state' })) as SimulatorState).orientation
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
			await simulators.command('project', { kind: 'shutdown' });
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
			(_projectId, frame) => frames.push(frame),
			{ node: 'node' }
		);
		const key = { projectId: 'project', id: 'task' };
		try {
			await simulators.command('project', { kind: 'select', device: avd! });
			await simulators.command('project', { kind: 'watch', on: true });
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
			await simulators.command('project', { kind: 'shutdown' });
		} finally {
			simulators.close();
			await rm(root, { recursive: true, force: true });
		}
	},
	300_000
);
