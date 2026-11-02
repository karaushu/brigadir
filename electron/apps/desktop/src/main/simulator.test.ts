import { expect, it } from 'vitest';
import { chmod, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { SimulatorEvent, SimulatorFrame, SimulatorState } from '@brigadir/core';
import { androidSdk, Simulators } from './simulator';
// A stand-in for sim-helper that speaks the same stdout framing: ready, a video config, one key frame, replies.
const helperSource = `#!/usr/bin/env node
const out=(type,payload)=>{const body=Buffer.isBuffer(payload)?payload:Buffer.from(JSON.stringify(payload));const head=Buffer.alloc(5);head[0]=type;head.writeUInt32BE(body.length,1);process.stdout.write(Buffer.concat([head,body]));};
const fs=require('node:fs');const log={write:line=>fs.appendFileSync(process.env.HELPER_LOG,line)};log.write(JSON.stringify({argv:process.argv.slice(2)})+'\\n');
out(1,{event:'ready',width:1206,height:2622,pointWidth:402,pointHeight:874});
out(2,{codec:'avc1.640028',width:1206,height:2622,description:'AQID'});
const frame=Buffer.alloc(12);frame[0]=1;frame.writeBigUInt64BE(1000n,1);frame.set([7,8,9],9);out(3,frame);
let buffer='';process.stdin.on('data',chunk=>{buffer+=chunk;let index;while((index=buffer.indexOf('\\n'))>=0){const line=buffer.slice(0,index);buffer=buffer.slice(index+1);log.write(line+'\\n');const message=JSON.parse(line);
  if(message.cmd==='keyframe')out(3,frame);
  if(typeof message.id==='number')out(1,message.cmd==='text'&&/[^\\x20-\\x7e]/.test(message.text)?{event:'reply',id:message.id,error:'Only ASCII text can be typed; paste the rest.'}:{event:'reply',id:message.id,result:message.cmd==='screenshot'?{jpeg:'/9j/',width:10,height:20}:message.cmd==='ui'?{width:402,height:874,elements:[...(fs.existsSync(process.env.HELPER_LOG+'.turned')?[{role:'Application',label:'App',frame:[0,0,874,402]}]:[]),{role:'Button',label:'Take order',id:'take-order',frame:[12,622,378,48]}]}:null});}});
process.stdin.on('end',()=>process.exit(0));
`;
const simctl = JSON.stringify({
	devices: {
		'com.apple.CoreSimulator.SimRuntime.iOS-27-0': [
			{ udid: 'AAAA-1', name: 'iPhone 17 Pro', state: 'Shutdown', isAvailable: true },
			{ udid: 'AAAA-2', name: 'iPad Air 11-inch (M4)', state: 'Shutdown' },
			{ udid: 'AAAA-3', name: 'Apple Watch', state: 'Shutdown' },
		],
		'com.apple.CoreSimulator.SimRuntime.iOS-26-5': [
			{ udid: 'BBBB-1', name: 'iPhone 16', state: 'Booted' },
		],
		'com.apple.CoreSimulator.SimRuntime.watchOS-12-0': [
			{ udid: 'CCCC-1', name: 'Apple Watch Ultra', state: 'Shutdown' },
		],
	},
});
it('lists iOS devices, remembers the project device, boots it, streams frames and shuts down what it booted (spec/browser-and-simulator#simulator)', async () => {
	const root = await mkdtemp(join(tmpdir(), 'brigadir-simulator-')),
		data = join(root, 'data'),
		helper = join(root, 'sim-helper'),
		log = join(root, 'helper.log');
	await mkdir(join(data, 'projects/project'), { recursive: true });
	await writeFile(
		join(data, 'projects/project/project.json'),
		JSON.stringify({
			schemaVersion: 1,
			project: { id: 'project', name: 'repo', path: '/tmp/repo' },
		})
	);
	await writeFile(helper, helperSource);
	await chmod(helper, 0o755);
	process.env.HELPER_LOG = log;
	const calls: string[][] = [],
		events: SimulatorEvent[] = [],
		frames: [string, SimulatorFrame][] = [];
	let orientation = 'portrait',
		streamed: ((line: string) => void) | null = null;
	const simulators = new Simulators(
		data,
		helper,
		(event) => events.push(event),
		(projectId, frame) => frames.push([projectId, frame]),
		{
			android: async () => null,
			clipboard: async () => 'привіт',
			detach: (file, args) => calls.push(['detach', file, ...args]),
			stream: (file, args, line) => {
				calls.push(['stream', file, ...args]);
				streamed = line;
				return () => calls.push(['stream-stop']);
			},
			metro: {
				fetch: async (url) => {
					if (!url.startsWith('http://127.0.0.1:8081/')) throw new Error('refused');
					return {
						ok: true,
						headers: {
							get: (name) => (name === 'x-react-native-project-root' ? '/tmp/repo' : null),
						},
						json: async () => [
							{
								appId: 'com.example.couriers',
								deviceName: 'iPhone 17 Pro',
								webSocketDebuggerUrl: 'ws://localhost:8081/inspector/debug',
							},
						],
					};
				},
				socket: () => {
					const socket: any = {
						onopen: null,
						onclose: null,
						onerror: null,
						onmessage: null,
						send() {},
						close() {
							socket.onclose?.();
						},
					};
					queueMicrotask(() => socket.onopen?.());
					return socket;
				},
				now: () => Date.now(),
			},
			platform: 'darwin',
			run: async (file, args) => {
				calls.push([file, ...args]);
				if (args[0] === 'xcodebuild') return 'Xcode 27.0\nBuild version 27A266a\n';
				if (args[0] === 'devicectl' && args[3] === 'get')
					return `Current Device Orientation: ${orientation}\n`;
				if (args[0] === 'devicectl' && args[3] === 'rotate') {
					orientation = 'landscapeLeft';
					return '';
				}
				if (args[1] === 'appinfo') return '{\n    CFBundleExecutable = Couriers;\n}';
				if (args.join(' ') === 'simctl list -j devices available') return simctl;
				return '';
			},
		}
	);
	try {
		const state = (await simulators.command('project', { kind: 'state' })) as SimulatorState;
		expect(state.toolchain).toEqual({ xcode: 'Xcode 27', android: null, ios: true });
		// iPhones and iPads of iOS runtimes only, the newest runtime first; a booted iPhone wins the default.
		expect(state.devices.map((device) => `${device.name} · ${device.os}`)).toEqual([
			'iPhone 17 Pro · iOS 27',
			'iPad Air 11-inch (M4) · iOS 27',
			'iPhone 16 · iOS 26.5',
		]);
		expect(state.device?.id).toBe('BBBB-1');
		expect(state.status).toBe('off');
		await simulators.command('project', { kind: 'select', device: 'AAAA-1' });
		expect(
			JSON.parse(await readFile(join(data, 'projects/project/project.json'), 'utf8')).project
				.simulator
		).toEqual({ platform: 'ios', device: 'AAAA-1' });
		await simulators.command('project', { kind: 'watch', on: true });
		await simulators.command('project', { kind: 'boot' });
		expect(calls).toContainEqual(['/usr/bin/xcrun', 'simctl', 'boot', 'AAAA-1']);
		expect(calls).toContainEqual(['/usr/bin/xcrun', 'simctl', 'bootstatus', 'AAAA-1', '-b']);
		await expect.poll(() => frames.length).toBeGreaterThan(0);
		expect(frames[0]).toEqual([
			'project',
			{ key: true, timestamp: 1000, data: new Uint8Array([7, 8, 9]) },
		]);
		expect(events).toContainEqual({
			projectId: 'project',
			config: { codec: 'avc1.640028', width: 1206, height: 2622, description: 'AQID' },
		});
		await expect
			.poll(
				async () =>
					((await simulators.command('project', { kind: 'state' })) as SimulatorState).status
			)
			.toBe('on');
		expect(
			((await simulators.command('project', { kind: 'state' })) as SimulatorState).screen
		).toEqual({ width: 402, height: 874 });
		await simulators.command('project', { kind: 'touch', phase: 'down', x: 0.5, y: 0.25 });
		expect(await simulators.command('project', { kind: 'screenshot' })).toEqual({
			image: '/9j/',
			mimeType: 'image/jpeg',
		});
		await expect(simulators.command('project', { kind: 'text', text: 'é' })).rejects.toThrow(
			'Only ASCII'
		);
		// The agent's tools: the tree in compact text, a tap by testID lands in the element's centre and is marked for the human.
		const key = { projectId: 'project', id: 'task' };
		expect(await simulators.agent(key, { tool: 'ui' })).toBe(
			'Screen 402×874 pt · 1 elements\nButton "Take order" #take-order 12,622 378×48'
		);
		expect(await simulators.agent(key, { tool: 'act', action: 'tap', id: 'take-order' })).toBe(
			'Tapped #take-order.'
		);
		expect(events).toContainEqual({
			projectId: 'project',
			tap: { x: 201 / 402, y: 646 / 874, label: 'tap · #take-order' },
		});
		await expect(
			simulators.agent(key, { tool: 'act', action: 'tap', id: 'missing' })
		).rejects.toThrow('No element #missing on the screen.');
		expect(await simulators.agent(key, { tool: 'screenshot' })).toEqual({
			image: '/9j/',
			mimeType: 'image/jpeg',
		});
		expect(await simulators.agent(key, { tool: 'state' })).toContain(
			'iPhone 17 Pro · iOS 27 · running · screen 402×874 pt'
		);
		const sent = (await readFile(log, 'utf8'))
			.trim()
			.split('\n')
			.map((line) => JSON.parse(line));
		expect(sent[0]).toEqual({ argv: ['--udid', 'AAAA-1'] });
		expect(sent).toContainEqual({ cmd: 'touch', phase: 'down', x: 0.5, y: 0.25 });
		expect(sent.find((entry) => entry.cmd === 'tap')).toMatchObject({ x: 201 / 402, y: 646 / 874 });
		// Rotate: devicectl turns the device; the tree speaks interface points, the touch lands in the device frame.
		await simulators.command('project', { kind: 'rotate' });
		expect(calls).toContainEqual([
			'/usr/bin/xcrun',
			'devicectl',
			'device',
			'orientation',
			'rotate',
			'--device',
			'AAAA-1',
			'right',
		]);
		expect(
			((await simulators.command('project', { kind: 'state' })) as SimulatorState).orientation
		).toBe('landscapeLeft');
		// The fake app does not turn first (portrait tree): points pass as they are; then it turns with the device.
		expect(await simulators.agent(key, { tool: 'ui' })).toMatch(/^Screen 402×874 pt/);
		await writeFile(log + '.turned', '');
		expect(await simulators.agent(key, { tool: 'ui' })).toMatch(/^Screen 874×402 pt/);
		await simulators.agent(key, { tool: 'act', action: 'tap', x: 150, y: 32 });
		expect(
			(await readFile(log, 'utf8'))
				.trim()
				.split('\n')
				.map((line) => JSON.parse(line))
				.filter((entry) => entry.cmd === 'tap')
				.at(-1)
		).toMatchObject({ x: 1 - 32 / 402, y: 150 / 874 });
		await simulators.command('project', { kind: 'screenshot' });
		expect(await readFile(log, 'utf8')).toContain(
			'"cmd":"screenshot","maxSide":1000,"orientation":"landscapeLeft"'
		);
		// Metro named the app: a steady log stream of its process, read by simulator_logs native.
		await expect
			.poll(() => calls.find((call) => call[0] === 'stream'))
			.toEqual([
				'stream',
				'/usr/bin/xcrun',
				'simctl',
				'spawn',
				'AAAA-1',
				'log',
				'stream',
				'--style',
				'compact',
				'--predicate',
				'process == "Couriers"',
			]);
		streamed!('Filtering the log data using "process == Couriers"');
		streamed!('2026-09-28 16:00:00.001 Df Couriers[42:1] take order');
		expect(await simulators.agent(key, { tool: 'logs', source: 'native' })).toBe(
			'2026-09-28 16:00:00.001 Df Couriers[42:1] take order'
		);
		expect(await simulators.agent(key, { tool: 'state' })).toContain(
			'- :8081 /tmp/repo · attached · serves this device'
		);
		simulators.close();
		expect(calls).toContainEqual(['detach', '/usr/bin/xcrun', 'simctl', 'shutdown', 'AAAA-1']);
		expect(calls).toContainEqual(['stream-stop']);
		await expect(simulators.command('project', { kind: 'state' })).rejects.toThrow(
			'The simulator is off in Settings.'
		);
	} finally {
		simulators.close();
		await rm(root, { recursive: true, force: true });
	}
});
it('the agent does not guess a device: no choice and none running refuses, a booted one becomes the choice (spec/browser-and-simulator#sim-device)', async () => {
	const root = await mkdtemp(join(tmpdir(), 'brigadir-simulator-')),
		data = join(root, 'data'),
		helper = join(root, 'sim-helper');
	await mkdir(join(data, 'projects/project'), { recursive: true });
	await writeFile(
		join(data, 'projects/project/project.json'),
		JSON.stringify({
			schemaVersion: 1,
			project: { id: 'project', name: 'repo', path: '/tmp/repo' },
		})
	);
	await writeFile(helper, helperSource);
	await chmod(helper, 0o755);
	process.env.HELPER_LOG = join(root, 'helper.log');
	const calls: string[][] = [];
	let booted = 'Shutdown';
	const simulators = new Simulators(
		data,
		helper,
		() => {},
		() => {},
		{
			android: async () => null,
			detach: () => {},
			platform: 'darwin',
			run: async (file, args) => {
				calls.push([file, ...args]);
				if (args[0] === 'xcodebuild') return 'Xcode 27.0\n';
				if (args.join(' ') === 'simctl list -j devices available')
					return JSON.stringify({
						devices: {
							'com.apple.CoreSimulator.SimRuntime.iOS-27-0': [
								{ udid: 'PRO-MAX', name: 'iPhone 18 Pro Max', state: 'Shutdown' },
								{ udid: 'SEVENTEEN', name: 'iPhone 17', state: booted },
							],
						},
					});
				return '';
			},
		}
	);
	const key = { projectId: 'project', id: 'task' };
	try {
		// The column still falls back to the newest iPhone; the agent is told nothing is chosen.
		expect(
			((await simulators.command('project', { kind: 'state' })) as SimulatorState).device?.id
		).toBe('PRO-MAX');
		expect(await simulators.agent(key, { tool: 'state' })).toMatch(
			/^No device is chosen for this project\.\n/
		);
		await expect(simulators.agent(key, { tool: 'open' })).rejects.toThrow(
			'No device is chosen for this project and none is running. Pass device'
		);
		expect(calls.some((call) => call[2] === 'boot')).toBe(false);
		// Booted in Xcode after the app started: the list is read again, the booted iPhone is used and saved.
		booted = 'Booted';
		expect(await simulators.agent(key, { tool: 'state' })).toMatch(
			/^iPhone 17 · iOS 27 · booted · not chosen, simulator_open uses it\n/
		);
		expect(await simulators.agent(key, { tool: 'open' })).toBe('iPhone 17 · iOS 27 is running.');
		expect(
			JSON.parse(await readFile(join(data, 'projects/project/project.json'), 'utf8')).project
				.simulator
		).toEqual({ platform: 'ios', device: 'SEVENTEEN' });
		expect(calls.some((call) => call[2] === 'boot' && call[3] === 'PRO-MAX')).toBe(false);
		expect(await simulators.agent(key, { tool: 'state' })).toMatch(/^iPhone 17 · iOS 27 · running/);
	} finally {
		simulators.close();
		await rm(root, { recursive: true, force: true });
	}
});
it('lists AVDs, starts the emulator without a window, runs the Android helper with adb and kills what it started (spec/browser-and-simulator#simulator)', async () => {
	const root = await mkdtemp(join(tmpdir(), 'brigadir-simulator-android-')),
		data = join(root, 'data'),
		helper = join(root, 'android.cjs'),
		log = join(root, 'helper.log'),
		avd = join(root, 'avd');
	await mkdir(join(data, 'projects/project'), { recursive: true });
	await writeFile(
		join(data, 'projects/project/project.json'),
		JSON.stringify({
			schemaVersion: 1,
			project: {
				id: 'project',
				name: 'repo',
				path: '/tmp/repo',
				simulator: { platform: 'android', device: 'Pixel_9_Pro' },
			},
		})
	);
	await mkdir(join(avd, 'Pixel_9_Pro.avd'), { recursive: true });
	await writeFile(
		join(avd, 'Pixel_9_Pro.avd', 'config.ini'),
		'avd.ini.displayname=Pixel 9 Pro\nimage.sysdir.1=system-images/android-36/google_apis_playstore/arm64-v8a/\n'
	);
	await writeFile(
		helper,
		helperSource
			.replace(
				"result:message.cmd==='screenshot'?{jpeg:'/9j/',width:10,height:20}",
				"result:message.cmd==='screenshot'?{png:'iVBOR',width:10,height:20}"
			)
			.replace("message.cmd==='text'&&", 'false&&')
	);
	process.env.HELPER_LOG = log;
	const calls: string[][] = [];
	let started = false;
	const simulators = new Simulators(
		data,
		join(root, 'sim-helper'),
		() => {},
		() => {},
		{
			androidHelper: helper,
			node: process.execPath,
			avdHome: avd,
			android: async () => '/sdk',
			clipboard: async () => 'привіт',
			detach: (file, args) => {
				calls.push(['detach', file, ...args]);
				if (args[0] === '-avd') started = true;
			},
			metro: {
				fetch: async () => {
					throw new Error('no Metro');
				},
				socket: () => {
					throw new Error('no Metro');
				},
				now: () => Date.now(),
			},
			// spec/architecture-and-platform#linux-package: the Android path as a Linux machine runs it — xcrun is never called there.
			platform: 'linux',
			run: async (file, args) => {
				calls.push([file, ...args]);
				if (args[0] === 'xcodebuild') throw new Error('no Xcode');
				if (args[0] === '-list-avds') return 'INFO    | Storing crashdata\nPixel_9_Pro\n';
				if (args[0] === 'devices')
					return started
						? 'List of devices attached\nemulator-5554\tdevice\n'
						: 'List of devices attached\n';
				if (args.join(' ') === '-s emulator-5554 emu avd name') return 'Pixel_9_Pro\nOK\n';
				if (args.includes('sys.boot_completed')) return '1\n';
				return '';
			},
		}
	);
	try {
		const state = (await simulators.command('project', { kind: 'state' })) as SimulatorState;
		expect(state.toolchain).toEqual({ xcode: null, android: 'Android SDK', ios: false });
		expect(calls.some((call) => call[0] === '/usr/bin/xcrun')).toBe(false);
		expect(state.devices).toEqual([
			{
				id: 'Pixel_9_Pro',
				name: 'Pixel 9 Pro',
				platform: 'android',
				os: 'Android 16',
				booted: false,
			},
		]);
		await simulators.command('project', { kind: 'boot' });
		expect(calls).toContainEqual([
			'detach',
			'/sdk/emulator/emulator',
			'-avd',
			'Pixel_9_Pro',
			'-no-window',
			'-no-audio',
			'-gpu',
			'host',
			'-no-boot-anim',
		]);
		await expect
			.poll(
				async () =>
					((await simulators.command('project', { kind: 'state' })) as SimulatorState).status
			)
			.toBe('on');
		const sent = (await readFile(log, 'utf8'))
			.trim()
			.split('\n')
			.map((line) => JSON.parse(line));
		expect(sent[0]).toEqual({
			argv: [
				'--serial',
				'emulator-5554',
				'--adb',
				'/sdk/platform-tools/adb',
				'--server',
				join(root, 'scrcpy-server'),
			],
		});
		// Any text goes to the Android helper (scrcpy pastes it); the screenshot is a PNG.
		await simulators.command('project', { kind: 'paste' });
		expect(await readFile(log, 'utf8')).toContain('"cmd":"text","text":"привіт"');
		expect(await simulators.command('project', { kind: 'screenshot' })).toEqual({
			image: 'iVBOR',
			mimeType: 'image/png',
		});
		expect(
			await simulators.agent(
				{ projectId: 'project', id: 'task' },
				{ tool: 'act', action: 'button', button: 'back' }
			)
		).toBe('Pressed back.');
		simulators.close();
		expect(calls).toContainEqual([
			'detach',
			'/sdk/platform-tools/adb',
			'-s',
			'emulator-5554',
			'emu',
			'kill',
		]);
	} finally {
		simulators.close();
		await rm(root, { recursive: true, force: true });
	}
});
it('finds the Android SDK where Android Studio puts it on macOS and on Linux (spec/architecture-and-platform#linux-package)', async () => {
	const root = await mkdtemp(join(tmpdir(), 'brigadir-android-sdk-'));
	try {
		expect(await androidSdk({}, root)).toBeNull();
		await mkdir(join(root, 'Android/Sdk/emulator'), { recursive: true });
		await writeFile(join(root, 'Android/Sdk/emulator/emulator'), '');
		expect(await androidSdk({}, root)).toBe(join(root, 'Android/Sdk'));
		expect(await androidSdk({ ANDROID_HOME: join(root, 'missing') }, root)).toBe(
			join(root, 'Android/Sdk')
		);
		await mkdir(join(root, 'custom/emulator'), { recursive: true });
		await writeFile(join(root, 'custom/emulator/emulator'), '');
		expect(await androidSdk({ ANDROID_SDK_ROOT: join(root, 'custom') }, root)).toBe(
			join(root, 'custom')
		);
	} finally {
		await rm(root, { recursive: true, force: true });
	}
});
