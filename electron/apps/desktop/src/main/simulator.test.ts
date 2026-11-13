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
let buffer='',taken=false;process.stdin.on('data',chunk=>{buffer+=chunk;let index;while((index=buffer.indexOf('\\n'))>=0){const line=buffer.slice(0,index);buffer=buffer.slice(index+1);log.write(line+'\\n');const message=JSON.parse(line);
  if(message.cmd==='keyframe')out(3,frame);
  if(message.cmd==='tap'){taken=true;out(3,frame);}
  if(typeof message.id==='number')out(1,message.cmd==='ui'&&fs.existsSync(process.env.HELPER_LOG+'.noui')?{event:'reply',id:message.id,error:'The device did not describe its screen.'}:message.cmd==='text'&&/[^\\x20-\\x7e]/.test(message.text)?{event:'reply',id:message.id,error:'Only ASCII text can be typed; paste the rest.'}:{event:'reply',id:message.id,result:message.cmd==='screenshot'?{jpeg:'/9j/',width:10,height:20}:message.cmd==='ui'?{width:402,height:874,elements:[...(fs.existsSync(process.env.HELPER_LOG+'.turned')?[{role:'Application',label:'App',frame:[0,0,874,402]}]:[]),...(taken?[{role:'Text',label:'Order taken',id:'status',frame:[12,560,378,40]}]:[]),...(fs.existsSync(process.env.HELPER_LOG+'.extra')?[{role:'Text',label:'Extra',id:'extra',frame:[12,500,378,40]}]:[]),{role:'Button',label:'Take order',id:'take-order',frame:[12,622,378,48]}]}:null});}});
process.stdin.on('end',()=>process.exit(0));
`;
/** The task whose simulator tab sends the person's commands. */
const view = { projectId: 'project', id: 'task' };
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
		streamed: ((line: string) => void) | null = null,
		skew = 0;
	const simulators = new Simulators(
		data,
		helper,
		(event) => events.push(event),
		(device, frame) => frames.push([device, frame]),
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
			now: () => Date.now() + skew,
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
		const state = (await simulators.command(view, { kind: 'state' })) as SimulatorState;
		expect(state.toolchain).toEqual({ xcode: 'Xcode 27', android: null, ios: true });
		// iPhones and iPads of iOS runtimes only, the newest runtime first; a booted iPhone wins the default.
		expect(state.devices.map((device) => `${device.name} · ${device.os}`)).toEqual([
			'iPhone 17 Pro · iOS 27',
			'iPad Air 11-inch (M4) · iOS 27',
			'iPhone 16 · iOS 26.5',
		]);
		expect(state.device?.id).toBe('BBBB-1');
		expect(state.status).toBe('off');
		await simulators.command(view, { kind: 'select', device: 'AAAA-1' });
		expect(
			JSON.parse(await readFile(join(data, 'projects/project/project.json'), 'utf8')).project
				.simulator
		).toEqual({ platform: 'ios', device: 'AAAA-1' });
		await simulators.command(view, { kind: 'watch', on: true });
		await simulators.command(view, { kind: 'boot' });
		expect(calls).toContainEqual(['/usr/bin/xcrun', 'simctl', 'boot', 'AAAA-1']);
		expect(calls).toContainEqual(['/usr/bin/xcrun', 'simctl', 'bootstatus', 'AAAA-1', '-b']);
		await expect.poll(() => frames.length).toBeGreaterThan(0);
		expect(frames[0]).toEqual([
			'AAAA-1',
			{ key: true, timestamp: 1000, data: new Uint8Array([7, 8, 9]) },
		]);
		expect(events).toContainEqual({
			device: 'AAAA-1',
			config: { codec: 'avc1.640028', width: 1206, height: 2622, description: 'AQID' },
		});
		await expect
			.poll(
				async () => ((await simulators.command(view, { kind: 'state' })) as SimulatorState).status
			)
			.toBe('on');
		expect(((await simulators.command(view, { kind: 'state' })) as SimulatorState).screen).toEqual({
			width: 402,
			height: 874,
		});
		await simulators.command(view, { kind: 'touch', phase: 'down', x: 0.5, y: 0.25 });
		expect(await simulators.command(view, { kind: 'screenshot' })).toEqual({
			image: '/9j/',
			mimeType: 'image/jpeg',
		});
		await expect(simulators.command(view, { kind: 'text', text: 'é' })).rejects.toThrow(
			'Only ASCII'
		);
		// The agent's tools: the tree in compact text, a tap by testID lands in the element's centre and is marked for the human.
		const key = { projectId: 'project', id: 'task' };
		expect(await simulators.agent(key, { tool: 'ui' })).toBe(
			'Screen 402×874 pt · 1 elements\nButton "Take order" #take-order 12,622 378×48'
		);
		// spec/browser-and-simulator#sim-act-settle: the answer waits for a still screen and lists what changed.
		expect(await simulators.agent(key, { tool: 'act', action: 'tap', id: 'take-order' })).toMatch(
			/^Tapped #take-order\. Screen settled in 0\.\d s\.\nChanges: 1 appeared, 0 disappeared, 0 changed\.\n\+ Text "Order taken" #status 12,560 378×40$/
		);
		// A still screen keeps the last tree: no frame since the tap, so the key reads none (spec/browser-and-simulator#sim-act-settle).
		const reads = async () => (await readFile(log, 'utf8')).split('"cmd":"ui"').length;
		const readsBefore = await reads();
		expect(await simulators.agent(key, { tool: 'act', action: 'key', key: 'Enter' })).toMatch(
			/^Pressed Enter\. Screen settled in 0\.\d s\.\nNo changes in the accessibility tree\.$/
		);
		expect(await reads()).toBe(readsBefore);
		// spec/browser-and-simulator#sim-wait: found at once, or a timeout with the screen as last read.
		expect(await simulators.agent(key, { tool: 'wait', text: 'order taken' })).toMatch(
			/^Found Text "Order taken" #status 12,560 378×40 after 0(\.\d)? s\.$/
		);
		expect(
			await simulators.agent(key, { tool: 'wait', id: 'take-order', gone: true, timeoutMs: 300 })
		).toBe(
			'Timed out after 0.3 s: #take-order is still on the screen.\nScreen 402×874 pt · 2 elements\nText "Order taken" #status 12,560 378×40\nButton "Take order" #take-order 12,622 378×48'
		);
		expect(events).toContainEqual({
			device: 'AAAA-1',
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
		// spec/browser-and-simulator#sim-act-settle: a tree that changed without a frame shows only once the kept one is 10 s old;
		// simulator_wait reads afresh at once.
		await writeFile(log + '.extra', '');
		expect(await simulators.agent(key, { tool: 'ui' })).not.toContain('Extra');
		skew += 10_000;
		expect(await simulators.agent(key, { tool: 'ui' })).toContain('Text "Extra" #extra');
		await rm(log + '.extra');
		expect(await simulators.agent(key, { tool: 'ui' })).toContain('Text "Extra" #extra');
		expect(
			await simulators.agent(key, { tool: 'wait', id: 'extra', gone: true, timeoutMs: 2000 })
		).toMatch(/^#extra is gone after 0(\.\d)? s\.$/);
		await writeFile(log + '.extra', '');
		expect(await simulators.agent(key, { tool: 'wait', text: 'extra', timeoutMs: 2000 })).toMatch(
			/^Found Text "Extra" #extra 12,500 378×40 after 0(\.\d)? s\.$/
		);
		await rm(log + '.extra');
		// A turn says whether the app turned only from a tree read after it.
		await writeFile(log + '.noui', '');
		skew += 10_000;
		expect(await simulators.agent(key, { tool: 'act', action: 'rotate' })).toMatch(
			/^Rotated to landscapeLeft; whether the app turned is unknown \(no tree after the turn\)\. Screen settled in 0\.\d s\.\nNo tree diff: the tree before the action could not be read \(The device did not describe its screen\)\.$/
		);
		await rm(log + '.noui');
		expect(await simulators.agent(key, { tool: 'act', action: 'rotate' })).toMatch(
			/^Rotated to landscapeLeft; the app stays in portrait\. Screen settled in 0\.\d s\.\n/
		);
		// Rotate: devicectl turns the device; the tree speaks interface points, the touch lands in the device frame.
		await simulators.command(view, { kind: 'rotate' });
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
			((await simulators.command(view, { kind: 'state' })) as SimulatorState).orientation
		).toBe('landscapeLeft');
		// The fake app does not turn first (portrait tree): points pass as they are; then it turns with the device.
		expect(await simulators.agent(key, { tool: 'ui' })).toMatch(/^Screen 402×874 pt/);
		await writeFile(log + '.turned', '');
		// The app turning draws: a frame ends the tree read before it.
		const drawn = frames.length;
		await simulators.command(view, { kind: 'keyframe' });
		await expect.poll(() => frames.length).toBeGreaterThan(drawn);
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
		await simulators.command(view, { kind: 'screenshot' });
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
			'- :8081 /tmp/repo · attached · serves your device'
		);
		simulators.close();
		expect(calls).toContainEqual(['detach', '/usr/bin/xcrun', 'simctl', 'shutdown', 'AAAA-1']);
		expect(calls).toContainEqual(['stream-stop']);
		await expect(simulators.command(view, { kind: 'state' })).rejects.toThrow(
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
		expect(((await simulators.command(view, { kind: 'state' })) as SimulatorState).device?.id).toBe(
			'PRO-MAX'
		);
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
			/^Project device: iPhone 17 · iOS 27 · booted · not chosen, simulator_open uses it\n/
		);
		expect(await simulators.agent(key, { tool: 'open' })).toBe('iPhone 17 · iOS 27 is running.');
		expect(
			JSON.parse(await readFile(join(data, 'projects/project/project.json'), 'utf8')).project
				.simulator
		).toEqual({ platform: 'ios', device: 'SEVENTEEN' });
		expect(calls.some((call) => call[2] === 'boot' && call[3] === 'PRO-MAX')).toBe(false);
		expect(await simulators.agent(key, { tool: 'state' })).toMatch(
			/^Your device: iPhone 17 · iOS 27 · running/
		);
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
		const state = (await simulators.command(view, { kind: 'state' })) as SimulatorState;
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
		await simulators.command(view, { kind: 'boot' });
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
				async () => ((await simulators.command(view, { kind: 'state' })) as SimulatorState).status
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
		await simulators.command(view, { kind: 'paste' });
		expect(await readFile(log, 'utf8')).toContain('"cmd":"text","text":"привіт"');
		expect(await simulators.command(view, { kind: 'screenshot' })).toEqual({
			image: 'iVBOR',
			mimeType: 'image/png',
		});
		expect(
			await simulators.agent(
				{ projectId: 'project', id: 'task' },
				{ tool: 'act', action: 'button', button: 'back' }
			)
		).toMatch(
			/^Pressed back\. Screen settled in 0\.\d s\.\nNo tree diff on Android: reading the tree takes seconds\. Call simulator_ui when you need it\.$/
		);
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
/**
 * A fake machine for spec/browser-and-simulator#sim-lease: simctl keeps a list that boot, clone, create and delete change; every booted
 * device runs the stand-in helper. `low` — memory pressure; `cap` — the setting.
 */
async function devicesWorld(options: { cap?: number; worktrees?: Record<string, string> } = {}) {
	const root = await mkdtemp(join(tmpdir(), 'brigadir-devices-')),
		data = join(root, 'data'),
		helper = join(root, 'sim-helper'),
		simDevices = join(root, 'CoreSimulator');
	await mkdir(join(data, 'projects/project'), { recursive: true });
	await writeFile(
		join(data, 'projects/project/project.json'),
		JSON.stringify({
			schemaVersion: 1,
			project: {
				id: 'project',
				name: 'repo',
				path: join(root, 'repo'),
				simulator: { platform: 'ios', device: 'PHONE' },
			},
		})
	);
	await writeFile(helper, helperSource);
	await chmod(helper, 0o755);
	process.env.HELPER_LOG = join(root, 'helper.log');
	// The person's app on the project iPhone, as CoreSimulator keeps it.
	await mkdir(join(simDevices, 'PHONE/data/Containers/Bundle/Application/C1/Couriers.app'), {
		recursive: true,
	});
	const list = [
		{
			udid: 'PHONE',
			name: 'iPhone 17 Pro',
			state: 'Shutdown',
			deviceTypeIdentifier: 'type.iPhone-17-Pro',
		},
		{
			udid: 'PAD',
			name: 'iPad Air 11-inch (M4)',
			state: 'Shutdown',
			deviceTypeIdentifier: 'type.iPad-Air',
		},
		{ udid: 'AIR', name: 'iPhone Air', state: 'Shutdown', deviceTypeIdentifier: 'type.iPhone-Air' },
	];
	const world = {
		root,
		calls: [] as string[][],
		rows: [] as { key: string; device: string; metroPort: number | null; lowMemory: boolean }[],
		low: false,
		cap: options.cap ?? 2,
		ended: new Set<string>(),
		waiting: [] as string[][],
		list,
		made: 0,
	};
	const runtime = 'com.apple.CoreSimulator.SimRuntime.iOS-27-0';
	const simulators = new Simulators(
		data,
		helper,
		() => {},
		() => {},
		{
			android: async () => null,
			detach: (file, args) => world.calls.push(['detach', file, ...args]),
			platform: 'darwin',
			simulatorDevices: simDevices,
			cap: () => world.cap,
			lowMemory: async () => world.low,
			sleep: async () => {},
			gateWaitMs: 20,
			queue: { waitMs: 2000, idleMs: 60_000 },
			taskTitle: async (key) => `Task ${key.id}`,
			taskEnded: async (key) => world.ended.has(key.id),
			worktree: async (key) => options.worktrees?.[key.id] ?? null,
			portFree: async () => true,
			record: async (key, row) => {
				world.rows.push({ key: key.id, ...row });
			},
			waiting: (_project, ids) => world.waiting.push(ids),
			metro: {
				fetch: async () => {
					throw new Error('refused');
				},
				socket: () => {
					throw new Error('not used');
				},
				now: () => Date.now(),
			},
			run: async (file, args) => {
				world.calls.push([file, ...args]);
				const [tool, verb, ...rest] = args;
				if (tool === 'xcodebuild') return 'Xcode 27.0\n';
				if (tool === 'sysctl' || file.endsWith('sysctl')) return '1';
				if (tool !== 'simctl') return '';
				const find = (udid: string) => list.find((item) => item.udid === udid);
				switch (verb) {
					case 'list':
						return JSON.stringify({ devices: { [runtime]: list } });
					case 'boot':
						find(rest[0]!)!.state = 'Booted';
						return '';
					case 'shutdown':
						if (find(rest[0]!)) find(rest[0]!)!.state = 'Shutdown';
						return '';
					case 'clone': {
						const source = find(rest[0]!)!;
						if (source.state === 'Booted')
							throw new Error('Unable to clone device in current state: Booted');
						const udid = `COPY-${++world.made}`;
						list.push({ ...source, udid, name: rest[1]!, state: 'Shutdown' });
						return `${udid}\n`;
					}
					case 'create': {
						const udid = `NEW-${++world.made}`;
						list.push({ udid, name: rest[0]!, state: 'Shutdown', deviceTypeIdentifier: rest[1]! });
						return `${udid}\n`;
					}
					case 'delete':
						for (const udid of rest)
							list.splice(
								list.findIndex((item) => item.udid === udid),
								1
							);
						return '';
					default:
						return '';
				}
			},
		}
	);
	return { simulators, world };
}
const task = (id: string) => ({ projectId: 'project', id });
const run = (world: { calls: string[][] }, verb: string) =>
	world.calls.filter((call) => call[1] === 'simctl' && call[2] === verb);
it('gives two tasks two devices at once and lets each tab show its own; a kind picks a free device (spec/browser-and-simulator#sim-lease)', async () => {
	const { simulators, world } = await devicesWorld();
	try {
		// The solo task uses the project iPhone; the second asks for an iPad by kind.
		expect(await simulators.agent(task('solo'), { tool: 'open' })).toContain(
			'iPhone 17 Pro · iOS 27 is running.'
		);
		expect(await simulators.agent(task('tablet'), { tool: 'open', device: 'iPad' })).toContain(
			'iPad Air 11-inch (M4) · iOS 27 is running.'
		);
		// Both act at once: each call goes to its own device.
		const [a, b] = await Promise.all([
			simulators.agent(task('solo'), { tool: 'act', action: 'tap', id: 'take-order' }),
			simulators.agent(task('tablet'), { tool: 'act', action: 'tap', id: 'take-order' }),
		]);
		expect(a).toMatch(/^Tapped #take-order\./);
		expect(b).toMatch(/^Tapped #take-order\./);
		const solo = (await simulators.command(task('solo'), { kind: 'state' })) as SimulatorState,
			tablet = (await simulators.command(task('tablet'), { kind: 'state' })) as SimulatorState;
		expect(solo.device?.id).toBe('PHONE');
		expect(tablet.device?.id).toBe('PAD');
		expect(solo.uses).toEqual({
			PHONE: { kind: 'mine' },
			PAD: { kind: 'task', task: task('tablet') },
		});
		expect(tablet.uses.PHONE).toEqual({ kind: 'task', task: task('solo') });
		expect(solo.gate).toEqual({ running: 2, max: 2, lowMemory: false });
		// The leases are saved per project; the person's tasks moved the project device only to devices they picked.
		const saved = JSON.parse(
			await readFile(join(world.root, 'data/projects/project/simulator-devices.json'), 'utf8')
		);
		expect(saved).toEqual({
			schemaVersion: 1,
			tasks: {
				solo: { platform: 'ios', device: 'PHONE' },
				tablet: { platform: 'ios', device: 'PAD' },
			},
		});
		expect(world.rows.map((row) => `${row.key} ${row.device}`)).toEqual([
			'solo iPhone 17 Pro',
			'tablet iPad Air 11-inch (M4)',
		]);
		// The agent's state names its device and who holds the others.
		const text = String(await simulators.agent(task('tablet'), { tool: 'state' }));
		expect(text).toMatch(/^Your device: iPad Air 11-inch \(M4\) · iOS 27 · running/);
		expect(text).toContain('Local devices: 2 of 2 run.');
		expect(text).toContain('- iPhone 17 Pro · iOS 27 (PHONE) · booted · used by «Task solo»');
		expect(text).toContain('- iPhone Air · iOS 27 (AIR) · free');
		await expect(simulators.agent(task('solo'), { tool: 'ui', device: 'Pixel' })).rejects.toThrow(
			'No device matches "Pixel". Call simulator_state for the list.'
		);
	} finally {
		simulators.close();
		await rm(world.root, { recursive: true, force: true });
	}
});
it('makes a crew worker a device of its own: a new one of the same model when the source runs, the apps installed before use (spec/browser-and-simulator#sim-own-device)', async () => {
	const { simulators, world } = await devicesWorld({ cap: 3 });
	try {
		await simulators.agent(task('foreman'), { tool: 'open' });
		// The worker gets its own device: the iPhone runs, so it cannot be cloned; a new one of its model and runtime is made.
		expect(await simulators.agent(task('worker'), { tool: 'open' }, true)).toContain(
			'iPhone 17 Pro · Task worker · iOS 27 is running.'
		);
		expect(run(world, 'clone')).toEqual([]);
		expect(run(world, 'create')).toEqual([
			[
				'/usr/bin/xcrun',
				'simctl',
				'create',
				'iPhone 17 Pro · Task worker',
				'type.iPhone-17-Pro',
				'com.apple.CoreSimulator.SimRuntime.iOS-27-0',
			],
		]);
		// The person's app is installed on the copy from the source's own bundle, after the copy booted and before any use.
		const boot = world.calls.findIndex((call) => call[2] === 'boot' && call[3] === 'NEW-1'),
			install = world.calls.findIndex((call) => call[2] === 'install');
		expect(world.calls[install]).toEqual([
			'/usr/bin/xcrun',
			'simctl',
			'install',
			'NEW-1',
			join(world.root, 'CoreSimulator/PHONE/data/Containers/Bundle/Application/C1/Couriers.app'),
		]);
		expect(install).toBeGreaterThan(boot);
		const saved = JSON.parse(
			await readFile(join(world.root, 'data/projects/project/simulator-devices.json'), 'utf8')
		);
		expect(saved.tasks.worker).toEqual({
			platform: 'ios',
			device: 'NEW-1',
			own: { source: 'PHONE', reinstalled: true },
		});
		// The copy is the worker's: nobody else matches it by kind, and the project device stays the iPhone.
		const foreman = (await simulators.command(task('foreman'), {
			kind: 'state',
		})) as SimulatorState;
		expect(foreman.device?.id).toBe('PHONE');
		expect(foreman.uses['NEW-1']).toEqual({ kind: 'task', task: task('worker') });
		// The worker acts on its copy while the foreman acts on the iPhone.
		await Promise.all([
			simulators.agent(task('worker'), { tool: 'act', action: 'tap', id: 'take-order' }, true),
			simulators.agent(task('foreman'), { tool: 'act', action: 'tap', id: 'take-order' }),
		]);
		// A shut-down source is cloned with its data instead.
		await simulators.command(task('foreman'), { kind: 'shutdown', device: 'PHONE' });
		await simulators
			.agent(task('second'), { tool: 'ui', device: 'iPhone 17 Pro' }, true)
			.catch(() => null);
		expect(run(world, 'clone')[0]?.slice(0, 4)).toEqual([
			'/usr/bin/xcrun',
			'simctl',
			'clone',
			'PHONE',
		]);
		// The worker's task ended: its copy is shut down and deleted, its record goes.
		world.ended.add('worker');
		await simulators.reconcile(task('worker'));
		expect(run(world, 'delete')).toEqual([['/usr/bin/xcrun', 'simctl', 'delete', 'NEW-1']]);
		expect(
			JSON.parse(
				await readFile(join(world.root, 'data/projects/project/simulator-devices.json'), 'utf8')
			).tasks.worker
		).toBeUndefined();
	} finally {
		simulators.close();
		await rm(world.root, { recursive: true, force: true });
	}
});
it('never deletes the source of a clone that was not reinstalled, and cleans up copies of tasks gone on start (spec/browser-and-simulator#sim-own-device)', async () => {
	const { simulators, world } = await devicesWorld();
	try {
		// Records as a crash would leave them: a clone (not reinstalled) of a copy whose task is gone.
		await writeFile(
			join(world.root, 'data/projects/project/simulator-devices.json'),
			JSON.stringify({
				schemaVersion: 1,
				tasks: {
					gone: { platform: 'ios', device: 'AIR', own: { source: 'PHONE', reinstalled: true } },
					fresh: { platform: 'ios', device: 'PAD', own: { source: 'AIR', reinstalled: false } },
					broken: { platform: 'ios', device: '../../etc' },
				},
			})
		);
		world.ended.add('gone');
		await simulators.reconcile();
		// AIR still runs PAD's apps: it stays, and so does the record of its gone task until PAD is reinstalled.
		expect(run(world, 'delete')).toEqual([]);
		world.ended.add('fresh');
		await simulators.reconcile();
		expect(run(world, 'delete').map((call) => call[3])).toEqual(['PAD']);
		const tasks = JSON.parse(
			await readFile(join(world.root, 'data/projects/project/simulator-devices.json'), 'utf8')
		).tasks;
		// The broken entry was dropped on load; the others stay readable.
		expect(Object.keys(tasks)).toEqual([]);
	} finally {
		simulators.close();
		await rm(world.root, { recursive: true, force: true });
	}
});
it('lets a worker share when the cap is reached, makes an agent boot wait at the gate, and lifts only low memory for the person (spec/browser-and-simulator#sim-cap)', async () => {
	const { simulators, world } = await devicesWorld({ cap: 1 });
	try {
		await simulators.agent(task('foreman'), { tool: 'open' });
		simulators.release(task('foreman'));
		// No room for a copy: the worker shares the iPhone in its lane and is told why.
		expect(await simulators.agent(task('worker'), { tool: 'ui' }, true)).toMatch(
			/^Sharing iPhone 17 Pro with another task: 1 of 1 local devices run\.\n/
		);
		expect(run(world, 'create')).toEqual([]);
		// An agent asking for a device that is off waits at the gate, then gives up with the cap.
		await expect(
			simulators.agent(task('tablet'), { tool: 'open', device: 'iPad' })
		).rejects.toThrow(
			'Cannot start iPad Air 11-inch (M4): 1 of 1 local devices run (Settings ▸ Modules ▸ Simulator settings).'
		);
		expect(world.waiting.some((ids) => ids.includes('tablet'))).toBe(true);
		expect(world.waiting.at(-1)).not.toContain('tablet');
		// Low memory under the cap: the agent waits and gives up; the person's Start is refused; Start anyway starts it and leaves the row.
		world.cap = 3;
		world.low = true;
		await new Promise((resolve) => setTimeout(resolve, 2100));
		await expect(
			simulators.agent(task('tablet'), { tool: 'open', device: 'iPad' })
		).rejects.toThrow('Cannot start iPad Air 11-inch (M4): memory is low.');
		await simulators.command(task('person'), { kind: 'select', device: 'AIR' });
		const state = (await simulators.command(task('person'), { kind: 'state' })) as SimulatorState;
		expect(state.gate).toEqual({ running: 1, max: 3, lowMemory: true });
		await expect(simulators.command(task('person'), { kind: 'boot' })).rejects.toThrow(
			'memory is low'
		);
		await simulators.command(task('person'), { kind: 'boot', anyway: true });
		expect(run(world, 'boot').map((call) => call[3])).toContain('AIR');
		expect(world.rows.at(-1)).toEqual({
			key: 'person',
			device: 'iPhone Air',
			metroPort: null,
			lowMemory: true,
		});
		// No way past the cap, not even for the person.
		world.cap = 2;
		await simulators.command(task('person'), { kind: 'select', device: 'PAD' });
		await expect(
			simulators.command(task('person'), { kind: 'boot', anyway: true })
		).rejects.toThrow('2 of 2 local devices run');
	} finally {
		simulators.close();
		await rm(world.root, { recursive: true, force: true });
	}
});
it('puts tasks wanting the same device in its lane, the person and solo agents ahead of workers (spec/browser-and-simulator#sim-lease)', async () => {
	const { simulators, world } = await devicesWorld({ cap: 1 });
	try {
		await simulators.agent(task('w1'), { tool: 'open' }, true);
		// w1 holds the iPhone; w2 and the foreman want it too.
		const w2 = simulators.agent(task('w2'), { tool: 'ui' }, true);
		await new Promise((resolve) => setTimeout(resolve, 20));
		const foreman = simulators.agent(task('foreman'), { tool: 'ui' });
		await new Promise((resolve) => setTimeout(resolve, 20));
		const view = (await simulators.command(task('w2'), { kind: 'state' })) as SimulatorState;
		expect(view.uses.PHONE).toEqual({ kind: 'queued', holder: task('w1') });
		expect(world.waiting.at(-1)).toEqual(['foreman', 'w2']);
		simulators.release(task('w1'));
		await foreman;
		simulators.release(task('foreman'));
		expect(await w2).toMatch(/^Sharing iPhone 17 Pro with another task/);
	} finally {
		simulators.close();
		await rm(world.root, { recursive: true, force: true });
	}
});
it('gives a worktree task a Metro port and points its device at its own Metro with the dev-client link (spec/browser-and-simulator#metro-connect)', async () => {
	const tree = await mkdtemp(join(tmpdir(), 'brigadir-tree-'));
	await writeFile(join(tree, 'app.json'), JSON.stringify({ expo: { scheme: 'couriers' } }));
	await writeFile(join(tree, 'package.json'), '{}');
	const { simulators, world } = await devicesWorld({ worktrees: { tree: tree } });
	try {
		expect(await simulators.metroPort(task('solo'))).toBe(null);
		const port = await simulators.metroPort(task('tree'));
		expect(port).toBe(8082);
		// The port is kept for the task and named to the agent with the missing dependencies.
		expect(await simulators.metroPort(task('tree'))).toBe(8082);
		expect(String(await simulators.agent(task('tree'), { tool: 'state' }))).toContain(
			"This task's worktree has no node_modules, so its Metro cannot start"
		);
		// Its own Metro answers on that port without the device: open connects the app to it once.
		(simulators as unknown as { tools: { metro: unknown } }).tools.metro = {
			fetch: async (url: string) => {
				if (!url.startsWith('http://127.0.0.1:8082/')) throw new Error('refused');
				return {
					ok: true,
					headers: {
						get: (name: string) => (name === 'x-react-native-project-root' ? tree : null),
					},
					json: async () => [],
				};
			},
			socket: () => {
				throw new Error('not used');
			},
			now: () => Date.now(),
		};
		await mkdir(join(tree, 'node_modules'));
		const answer = String(await simulators.agent(task('tree'), { tool: 'open' }));
		expect(answer).toContain('Connected iPhone 17 Pro to Metro :8082.');
		expect(answer).not.toContain('node_modules');
		expect(run(world, 'openurl')).toEqual([
			[
				'/usr/bin/xcrun',
				'simctl',
				'openurl',
				'PHONE',
				'couriers://expo-development-client/?url=http%3A%2F%2F127.0.0.1%3A8082',
			],
		]);
		await simulators.agent(task('tree'), { tool: 'open' });
		expect(run(world, 'openurl')).toHaveLength(1);
		expect(world.rows[0]).toEqual({
			key: 'tree',
			device: 'iPhone 17 Pro',
			metroPort: 8082,
			lowMemory: false,
		});
	} finally {
		simulators.close();
		await rm(world.root, { recursive: true, force: true });
		await rm(tree, { recursive: true, force: true });
	}
});
