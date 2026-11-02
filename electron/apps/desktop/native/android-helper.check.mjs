// Manual check of android-helper against a booted Android emulator (spec/browser-and-simulator#simulator).
// Usage: node apps/desktop/native/android-helper.check.mjs [serial]   (default: the first emulator-* in `adb devices`)
// Build first (pnpm build:services). Start the device headless yourself, e.g.
//   ~/Library/Android/sdk/emulator/emulator -avd Pixel_9_Pro -no-window -no-audio -gpu host -no-boot-anim -no-snapshot-save
// and wait for `adb shell getprop sys.boot_completed` = 1. The check opens Settings from the app list, scrolls, types
// ASCII and Cyrillic into the settings search, presses Back and Home, and makes sure nothing stays on the device.
import { spawn, execFileSync } from 'node:child_process';
import { existsSync, mkdtempSync, writeFileSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const services = join(dirname(fileURLToPath(import.meta.url)), '../out/services');
const helper = join(services, 'android.cjs'),
	jar = join(services, 'scrcpy-server');
const sdk = [
	process.env.ANDROID_HOME,
	process.env.ANDROID_SDK_ROOT,
	join(homedir(), 'Library/Android/sdk'),
].find((root) => root && existsSync(join(root, 'platform-tools/adb')));
if (!existsSync(helper) || !existsSync(jar))
	throw new Error(`build ${helper} first (pnpm build:services)`);
if (!sdk) throw new Error('no Android SDK with platform-tools/adb');
const adbPath = join(sdk, 'platform-tools/adb');
const serial =
	process.argv[2] ??
	execFileSync(adbPath, ['devices'])
		.toString()
		.split('\n')
		.map((line) => line.split('\t'))
		.find(([name, state]) => name.startsWith('emulator-') && state === 'device')?.[0];
if (!serial) throw new Error('boot an emulator first (see the header of this file)');
const adb = (...args) => execFileSync(adbPath, ['-s', serial, ...args]).toString();

const nowUs = () => Number(process.hrtime.bigint() / 1000n);
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const spawnedAt = Date.now();
const child = spawn(
	process.execPath,
	[helper, '--serial', serial, '--adb', adbPath, '--server', jar],
	{ stdio: ['pipe', 'pipe', 'pipe'] }
);
const serverLog = [];
child.stderr.on('data', (data) => serverLog.push(...data.toString().split('\n').filter(Boolean)));
const events = [],
	chunks = [],
	configs = [],
	waiters = new Map();
let buffer = Buffer.alloc(0),
	nextId = 1,
	failures = 0;

child.stdout.on('data', (data) => {
	buffer = Buffer.concat([buffer, data]);
	while (buffer.length >= 5) {
		const length = buffer.readUInt32BE(1);
		if (buffer.length < 5 + length) break;
		const type = buffer[0],
			payload = buffer.subarray(5, 5 + length);
		buffer = buffer.subarray(5 + length);
		if (type === 1) {
			const event = JSON.parse(payload);
			events.push(event);
			if (event.event === 'reply') {
				waiters.get(event.id)?.(event);
				waiters.delete(event.id);
			}
			if (event.event === 'error') console.log('  error event:', event);
		} else if (type === 2) configs.push({ ...JSON.parse(payload), index: chunks.length });
		else if (type === 3)
			chunks.push({
				key: payload[0] === 1,
				timestamp: Number(payload.readBigUInt64BE(1)),
				arrived: nowUs(),
				data: Buffer.from(payload.subarray(9)),
			});
		else throw new Error(`unknown frame type ${type}`);
	}
});

const send = (message) => child.stdin.write(JSON.stringify(message) + '\n');
const call = (message, timeout = 15000) =>
	new Promise((resolve, reject) => {
		const id = nextId++;
		const timer = setTimeout(() => reject(new Error(`no reply to ${message.cmd}`)), timeout);
		waiters.set(id, (event) => {
			clearTimeout(timer);
			resolve(event);
		});
		send({ ...message, id });
	});
const until = async (test, timeout, what) => {
	for (const start = Date.now(); Date.now() - start < timeout; await sleep(20)) if (test()) return;
	throw new Error(`timed out waiting for ${what}`);
};
const check = (ok, what, detail = '') => {
	console.log(`${ok ? 'ok  ' : 'FAIL'} ${what}${detail ? ` — ${detail}` : ''}`);
	if (!ok) failures++;
};
const cpuSeconds = () =>
	execFileSync('ps', ['-o', 'time=', '-p', String(child.pid)])
		.toString()
		.trim()
		.split(':')
		.reduce((sum, part) => sum * 60 + Number(part), 0);
const rssMB = () => Number(execFileSync('ps', ['-o', 'rss=', '-p', String(child.pid)])) / 1024;
const pct = (values, p) =>
	values.length
		? [...values].sort((a, b) => a - b)[
				Math.min(values.length - 1, Math.round(p * (values.length - 1)))
			]
		: NaN;
let lastUiMs = 0;
const ui = async () => {
	const t0 = Date.now();
	const answer = await call({ cmd: 'ui' }, 40000);
	lastUiMs = Date.now() - t0;
	if (answer.error) throw new Error(answer.error);
	return answer.result;
};
const find = (tree, test) => tree.elements.find(test);
const center = (tree, element) => ({
	x: (element.frame[0] + element.frame[2] / 2) / tree.width,
	y: (element.frame[1] + element.frame[3] / 2) / tree.height,
});
const byLabel = (label) => (element) => element.label === label;
/** Chunks whose arrival is after `at` (µs) and which are not a quiet repeat of the previous frame. */
const changedAfter = (from, at) =>
	chunks.slice(from).find((c) => c.arrived > at && c.data.length > 200);

try {
	await until(() => events.some((e) => e.event === 'ready'), 20000, 'ready');
	const ready = events.find((e) => e.event === 'ready');
	check(
		ready.width > 0 && ready.pointWidth > 0,
		'ready',
		`${ready.width}×${ready.height} px, ${ready.pointWidth.toFixed(1)}×${ready.pointHeight.toFixed(1)} dp, video ${ready.videoWidth}×${ready.videoHeight}, ${Date.now() - spawnedAt} ms after spawn`
	);
	await until(() => chunks.length > 0, 5000, 'first chunk');
	check(
		configs.length > 0 &&
			configs[0].index === 0 &&
			/^avc1\.[0-9A-F]{6}$/.test(configs[0].codec) &&
			configs[0].description,
		'config before the first chunk',
		`${configs[0]?.codec} ${configs[0]?.width}×${configs[0]?.height}`
	);
	check(
		chunks[0].key,
		'first chunk is a keyframe',
		`${chunks[0].data.length} bytes, ${Date.now() - spawnedAt} ms after spawn`
	);
	const age = nowUs() - chunks[0].timestamp;
	check(
		age >= 0 && age < 5e6,
		'timestamps share process.hrtime clock',
		`first chunk age ${(age / 1000).toFixed(1)} ms`
	);

	await call({ cmd: 'button', name: 'home' });
	await sleep(1500);
	const idleFrom = chunks.length;
	await sleep(2000);
	const idle = chunks.slice(idleFrom);
	check(
		idle.length <= 4,
		'static screen sends (almost) nothing',
		`${idle.length} chunks in 2 s, ${idle.reduce((s, c) => s + c.data.length, 0)} bytes`
	);

	const keyFrom = chunks.length,
		keyAt = Date.now();
	send({ cmd: 'keyframe' });
	await until(() => chunks.slice(keyFrom).some((c) => c.key), 3000, 'keyframe on demand');
	check(true, 'keyframe on demand on a static screen', `${Date.now() - keyAt} ms`);

	let t0 = Date.now();
	const shot = await call({ cmd: 'screenshot', maxSide: 1000 });
	check(
		shot.result && Math.max(shot.result.width, shot.result.height) <= 1000 && shot.result.png,
		'screenshot',
		shot.error ??
			`${shot.result.width}×${shot.result.height} PNG, ${Math.round((shot.result.png.length * 3) / 4 / 1024)} KB, ${Date.now() - t0} ms`
	);

	let tree = await ui();
	const homeIds = new Set(tree.elements.map((e) => e.id).filter(Boolean));
	check(
		tree.elements.some((e) => e.label),
		'ui on the home screen',
		`${tree.elements.length} elements in ${lastUiMs} ms, ${tree.width.toFixed(1)}×${tree.height.toFixed(1)} dp; e.g. ${JSON.stringify(tree.elements.find((e) => e.label))}`
	);

	// App list: swipe up from the bottom of the home screen, then Settings.
	const swipe = await call({ cmd: 'swipe', x1: 0.5, y1: 0.85, x2: 0.5, y2: 0.3, duration: 0.3 });
	check(swipe.result === true, 'swipe reply');
	await sleep(1200);
	tree = await ui();
	const settings = find(tree, byLabel('Settings'));
	check(settings, 'app list shows Settings', settings && JSON.stringify(settings));
	if (!settings) throw new Error('no Settings in the app list');

	const tapFrom = chunks.length,
		tapAt = nowUs();
	const shotBefore = shot.result.png;
	await call({ cmd: 'tap', ...center(tree, settings) });
	await until(() => changedAfter(tapFrom, tapAt), 3000, 'frames after tap');
	check(
		true,
		'tap changes the screen',
		`first chunk ${((changedAfter(tapFrom, tapAt).arrived - tapAt) / 1000).toFixed(1)} ms after the tap command`
	);
	await sleep(1800);
	const shot2 = await call({ cmd: 'screenshot', maxSide: 600 });
	check(
		shot2.result && shot2.result.png !== shotBefore,
		'screenshot differs after tap',
		`${shot2.result.width}×${shot2.result.height}`
	);
	tree = await ui();
	const searchEntry = find(tree, (e) => /search/i.test(e.id) || /^Search/.test(e.label));
	check(
		searchEntry,
		'Settings opened (ui sees its search)',
		`${tree.elements.length} elements in ${lastUiMs} ms; ${JSON.stringify(searchEntry)}`
	);

	// Human pointer: raw touch events at ~120 Hz over the Settings list; fps, frame age at arrival, bitrate.
	const scrollFrom = chunks.length,
		scrollStart = nowUs(),
		cpuStart = cpuSeconds();
	for (let round = 0; round < 6; round++) {
		const [from, to] = round % 2 ? [0.35, 0.75] : [0.75, 0.35];
		send({ cmd: 'touch', phase: 'down', x: 0.5, y: from });
		for (let i = 1; i <= 24; i++) {
			await sleep(8);
			send({ cmd: 'touch', phase: 'move', x: 0.5, y: from + ((to - from) * i) / 24 });
		}
		send({ cmd: 'touch', phase: 'up', x: 0.5, y: to });
		await sleep(600);
	}
	const scroll = chunks.slice(scrollFrom),
		seconds = (nowUs() - scrollStart) / 1e6;
	const ages = scroll.map((c) => (c.arrived - c.timestamp) / 1000);
	const bytes = scroll.reduce((sum, c) => sum + c.data.length, 0);
	check(
		scroll.length / seconds > 20,
		'scroll by touch events',
		`${(scroll.length / seconds).toFixed(1)} fps avg over ${seconds.toFixed(1)} s, frame age p50 ${pct(ages, 0.5).toFixed(1)} ms p95 ${pct(ages, 0.95).toFixed(1)} ms (above the fastest frame), ${((bytes * 8) / seconds / 1e6).toFixed(2)} Mbit/s`
	);
	const perSecond = new Map();
	for (const c of scroll)
		perSecond.set(
			Math.floor(c.arrived / 1e6),
			(perSecond.get(Math.floor(c.arrived / 1e6)) ?? 0) + 1
		);
	console.log(
		`     per-second frames: ${[...perSecond.values()].join(' ')}; helper CPU ${Math.round(((cpuSeconds() - cpuStart) / seconds) * 100)} % of a core, RSS ${Math.round(rssMB())} MB`
	);

	// Touch down on the search entry, then touch up → first changed chunk (the search page opens).
	tree = await ui();
	const search = find(tree, (e) => /search/i.test(e.id) || /^Search/.test(e.label));
	if (!search) throw new Error('no search entry in Settings');
	{
		const { x, y } = center(tree, search);
		send({ cmd: 'touch', phase: 'down', x, y });
		await sleep(60);
		await sleep(300);
		const from = chunks.length,
			at = nowUs();
		send({ cmd: 'touch', phase: 'up', x, y });
		await until(() => changedAfter(from, at), 3000, 'frame after touch up').catch(() => {});
		const first = changedAfter(from, at);
		check(
			first,
			'touch up → first chunk',
			first ? `${((first.arrived - at) / 1000).toFixed(1)} ms` : 'none'
		);
	}
	await sleep(1500);
	tree = await ui();
	let field = find(tree, (e) => e.role === 'EditText');
	check(field, 'Settings search field in ui', field && JSON.stringify(field));
	if (field) {
		t0 = Date.now();
		const typed = await call({ cmd: 'text', text: 'wifi' });
		check(typed.result === true, 'text reply (ASCII)', `${Date.now() - t0} ms for 4 characters`);
		await sleep(1200);
		tree = await ui();
		field = find(tree, (e) => e.role === 'EditText');
		check(field?.value?.includes('wifi'), 'typed ASCII reached the field', JSON.stringify(field));
		for (let i = 0; i < 4; i++) {
			send({ cmd: 'key', usage: 0x2a, down: true });
			send({ cmd: 'key', usage: 0x2a, down: false });
		}
		await sleep(600);
		t0 = Date.now();
		const cyrillic = await call({ cmd: 'text', text: 'Привіт' });
		check(
			cyrillic.result === true,
			'text reply (Cyrillic via clipboard + paste)',
			`${Date.now() - t0} ms`
		);
		await sleep(1200);
		tree = await ui();
		field = find(tree, (e) => e.role === 'EditText');
		check(
			field?.value?.includes('Привіт') && !field.value.includes('wifi'),
			'Backspace keys and Cyrillic reached the field',
			JSON.stringify(field)
		);
		// Shift+letter through key events: the field gets a capital.
		for (let i = 0; i < 6; i++) {
			send({ cmd: 'key', usage: 0x2a, down: true });
			send({ cmd: 'key', usage: 0x2a, down: false });
		}
		send({ cmd: 'key', usage: 0xe1, down: true });
		send({ cmd: 'key', usage: 0x05, down: true });
		send({ cmd: 'key', usage: 0x05, down: false });
		send({ cmd: 'key', usage: 0xe1, down: false });
		send({ cmd: 'key', usage: 0x12, down: true });
		send({ cmd: 'key', usage: 0x12, down: false });
		await sleep(1000);
		tree = await ui();
		field = find(tree, (e) => e.role === 'EditText');
		check(field?.value === 'Bo', 'keys with Shift', JSON.stringify(field));
	}

	// Rotation (emulator console; Settings follows auto-rotate): a size event and a new config with swapped dimensions.
	// `emu rotate` turns the virtual device by 90°; four of them bring it back to where it was.
	const sizeFrom = events.length,
		configFrom = configs.length;
	adb('emu', 'rotate');
	await until(
		() => events.slice(sizeFrom).some((e) => e.event === 'size'),
		4000,
		'size after rotation'
	).catch(() => {});
	const rotated = events.slice(sizeFrom).find((e) => e.event === 'size');
	if (rotated) {
		await until(() => configs.length > configFrom, 3000, 'config after rotation').catch(() => {});
		check(
			rotated.width > rotated.height &&
				configs.length > configFrom &&
				configs.at(-1).width > configs.at(-1).height,
			'rotation sends size and a new config',
			`${rotated.width}×${rotated.height} px, ${rotated.pointWidth.toFixed(1)}×${rotated.pointHeight.toFixed(1)} dp, config ${configs.at(-1).width}×${configs.at(-1).height}`
		);
		tree = await ui();
		field = find(tree, (e) => e.role === 'EditText');
		check(
			tree.width > tree.height && field && field.frame[2] > 426,
			'ui in landscape',
			`${tree.width.toFixed(1)}×${tree.height.toFixed(1)} dp, field ${JSON.stringify(field?.frame)}`
		);
	} else console.log('skip rotation: the screen did not rotate (auto-rotate off?)');
	for (let i = 0; i < 3; i++) {
		adb('emu', 'rotate');
		await sleep(1500);
	}
	await sleep(1000);
	const lastSize = events.filter((e) => e.event === 'ready' || e.event === 'size').at(-1);
	check(
		lastSize.width < lastSize.height,
		'back to portrait after a full turn',
		`${lastSize.width}×${lastSize.height}`
	);

	const press = await call({ cmd: 'longpress', x: 0.5, y: 0.6, duration: 0.3 });
	check(press.result === true, 'longpress reply');
	const bad = await call({ cmd: 'nope' });
	check(typeof bad.error === 'string', 'unknown command gets an error reply', bad.error);
	const badButton = await call({ cmd: 'button', name: 'volume' });
	check(typeof badButton.error === 'string', 'unknown button gets an error reply', badButton.error);

	await call({ cmd: 'button', name: 'back' });
	await sleep(300);
	await call({ cmd: 'button', name: 'back' });
	await sleep(1200);
	tree = await ui();
	check(
		!find(tree, (e) => e.role === 'EditText') &&
			find(tree, (e) => /search/i.test(e.id) || /^Search/.test(e.label)),
		'button back leaves the search page'
	);
	await call({ cmd: 'button', name: 'home' });
	await sleep(1500);
	tree = await ui();
	const overlap = tree.elements.filter((e) => homeIds.has(e.id)).length;
	check(
		overlap >= Math.min(3, homeIds.size),
		'button home returns to the home screen',
		`${overlap} of ${homeIds.size} home ids present`
	);

	// The stream decodes: AVCC → Annex-B with SPS/PPS from each avcC, then ffprobe.
	try {
		const start = Buffer.from([0, 0, 0, 1]),
			out = [];
		configs.forEach((config, n) => {
			const avcC = Buffer.from(config.description, 'base64');
			let offset = 6;
			for (let sets = avcC[5] & 31, pps = false; ;) {
				for (let i = 0; i < sets; i++) {
					const length = avcC.readUInt16BE(offset);
					out.push(start, avcC.subarray(offset + 2, offset + 2 + length));
					offset += 2 + length;
				}
				if (pps) break;
				sets = avcC[offset++];
				pps = true;
			}
			for (const chunk of chunks.slice(config.index, configs[n + 1]?.index ?? chunks.length))
				for (let o = 0; o + 4 <= chunk.data.length;) {
					const length = chunk.data.readUInt32BE(o);
					out.push(start, chunk.data.subarray(o + 4, o + 4 + length));
					o += 4 + length;
				}
		});
		const file = join(mkdtempSync(join(tmpdir(), 'android-helper-')), 'stream.h264');
		writeFileSync(file, Buffer.concat(out));
		const probe = execFileSync('ffprobe', [
			'-v',
			'error',
			'-count_frames',
			'-select_streams',
			'v:0',
			'-show_entries',
			'stream=width,height,has_b_frames,nb_read_frames',
			'-of',
			'csv=p=0',
			file,
		])
			.toString()
			.trim();
		check(
			Number(probe.split(',').at(-1)) === chunks.length,
			'ffprobe decodes every chunk',
			`${probe} (width,height,has_b_frames,frames) of ${chunks.length} chunks`
		);
	} catch (error) {
		console.log(`skip ffprobe decode: ${error.message}`);
	}

	const endAt = Date.now();
	const exited = new Promise((resolve) => child.once('exit', (code) => resolve(code)));
	child.stdin.end();
	const code = await Promise.race([exited, sleep(3000).then(() => 'timeout')]);
	check(
		code === 0 && Date.now() - endAt < 1000,
		'stdin EOF exits',
		`code ${code} in ${Date.now() - endAt} ms`
	);
	const processes = adb('shell', 'ps -A -o PID,ARGS')
		.split('\n')
		.filter((line) => /scrcpy/.test(line));
	check(processes.length === 0, 'no scrcpy server left on the device', processes.join('; '));
	const forwards = adb('forward', '--list')
		.split('\n')
		.filter((line) => line.startsWith(serial) && /scrcpy/.test(line));
	check(forwards.length === 0, 'no adb forward left', forwards.join('; '));
	const jars = adb('shell', 'ls /data/local/tmp')
		.split('\n')
		.filter((line) => /brigadir-scrcpy/.test(line));
	check(jars.length === 0, 'no server jar left in /data/local/tmp', jars.join(' '));
} catch (error) {
	failures++;
	console.log('FAIL', error.message);
	console.log(serverLog.slice(-15).join('\n'));
	child.kill();
}
console.log(failures ? `${failures} failed` : 'all passed');
process.exit(failures ? 1 : 0);
