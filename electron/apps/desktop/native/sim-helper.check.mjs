// Manual check of sim-helper against a booted iOS Simulator device (spec/browser-and-simulator#simulator).
// Usage: node apps/desktop/native/sim-helper.check.mjs [UDID]   (default: the first booted device)
// Build first (pnpm build:services or the clang line in scripts/build-services.mjs).
// It presses Home, opens Settings, scrolls, types into search and goes Home again.
import { spawn, execFileSync } from 'node:child_process';
import { existsSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const helper = join(dirname(fileURLToPath(import.meta.url)), '../out/services/sim-helper');
const udid =
	process.argv[2] ??
	Object.values(
		JSON.parse(execFileSync('xcrun', ['simctl', 'list', '-j', 'devices', 'booted'])).devices
	).flat()[0]?.udid;
if (!existsSync(helper)) throw new Error(`build ${helper} first`);
if (!udid) throw new Error('boot a simulator device first: xcrun simctl boot <udid>');

const nowUs = () => Number(process.hrtime.bigint() / 1000n);
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const child = spawn(helper, ['--udid', udid], { stdio: ['pipe', 'pipe', 'inherit'] });
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
const call = (message, timeout = 10000) =>
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
const ui = async () => (await call({ cmd: 'ui' })).result;
const find = (tree, test) => tree.elements.find(test);
// Settings reopens on the last subpage: go back to its root.
const settingsRoot = async () => {
	for (let i = 0; i < 4; i++) {
		const tree = await ui(),
			back = find(tree, (e) => e.id === 'BackButton');
		if (!back) return tree;
		await call({ cmd: 'tap', ...center(tree, back) });
		await sleep(1000);
	}
	return ui();
};
const center = (tree, element) => ({
	x: (element.frame[0] + element.frame[2] / 2) / tree.width,
	y: (element.frame[1] + element.frame[3] / 2) / tree.height,
});

try {
	const started = Date.now();
	await until(() => events.some((e) => e.event === 'ready'), 15000, 'ready');
	const ready = events.find((e) => e.event === 'ready');
	check(
		ready.width > 0 && ready.pointWidth > 0,
		'ready',
		`${ready.width}×${ready.height} px, ${ready.pointWidth}×${ready.pointHeight} pt, ${Date.now() - started} ms after spawn`
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
		`${chunks[0].data.length} bytes, ${Date.now() - started} ms after spawn`
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
	check(
		chunks.length - idleFrom <= 4,
		'static screen sends (almost) nothing',
		`${chunks.length - idleFrom} chunks in 2 s`
	);

	const keyFrom = chunks.length;
	send({ cmd: 'keyframe' });
	await until(() => chunks.slice(keyFrom).some((c) => c.key), 2000, 'keyframe on demand');
	check(true, 'keyframe on demand on a static screen');

	const shot = await call({ cmd: 'screenshot', maxSide: 1000 });
	check(
		shot.result && Math.max(shot.result.width, shot.result.height) <= 1000,
		'screenshot',
		shot.error ??
			`${shot.result.width}×${shot.result.height}, ${Math.round((shot.result.jpeg.length * 3) / 4 / 1024)} KB`
	);

	let t0 = Date.now();
	let tree = await ui();
	const settings = find(tree, (e) => e.label === 'Settings');
	check(
		settings,
		'ui on the home screen',
		`${tree.elements.length} elements in ${Date.now() - t0} ms, ${tree.width}×${tree.height} pt`
	);
	if (!settings) throw new Error('no Settings icon on the home screen');

	const tapFrom = chunks.length;
	const tapAt = nowUs();
	await call({ cmd: 'tap', ...center(tree, settings) });
	await until(() => chunks.length > tapFrom, 3000, 'frames after tap');
	check(
		true,
		'tap changes the screen',
		`first chunk ${((chunks[tapFrom].arrived - tapAt) / 1000).toFixed(1)} ms after the tap command`
	);
	await sleep(1500);
	const shot2 = await call({ cmd: 'screenshot', maxSide: 600 });
	check(
		shot2.result && shot2.result.jpeg !== shot.result.jpeg,
		'screenshot differs after tap',
		`${shot2.result.width}×${shot2.result.height}`
	);
	await settingsRoot();
	t0 = Date.now();
	tree = await ui();
	check(
		find(tree, (e) => e.id === 'com.apple.settings.general'),
		'Settings opened (ui sees General)',
		`${tree.elements.length} elements in ${Date.now() - t0} ms`
	);
	t0 = Date.now();
	const gridTree = (await call({ cmd: 'ui', grid: true }, 20000)).result;
	check(
		gridTree.elements.length >= tree.elements.length,
		'ui with grid',
		`${gridTree.elements.length} elements in ${Date.now() - t0} ms`
	);

	// Human pointer: raw touch events at 120 Hz; measure fps, frame age at arrival and bitrate.
	const scrollFrom = chunks.length,
		scrollStart = nowUs(),
		cpuStart = cpuSeconds();
	for (let round = 0; round < 6; round++) {
		const [from, to] = round % 2 ? [0.3, 0.75] : [0.75, 0.3];
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
		`${(scroll.length / seconds).toFixed(1)} fps avg over ${seconds.toFixed(1)} s, frame age p50 ${pct(ages, 0.5).toFixed(1)} ms p95 ${pct(ages, 0.95).toFixed(1)} ms, ${((bytes * 8) / seconds / 1e6).toFixed(2)} Mbit/s`
	);
	const perSecond = new Map();
	for (const c of scroll)
		perSecond.set(
			Math.floor(c.timestamp / 1e6),
			(perSecond.get(Math.floor(c.timestamp / 1e6)) ?? 0) + 1
		);
	console.log(
		`     per-second frames: ${[...perSecond.values()].join(' ')}; helper CPU ${Math.round(((cpuSeconds() - cpuStart) / seconds) * 100)} % of a core, RSS ${Math.round(rssMB())} MB`
	);

	// Touch-up → first changed frame (tapping the Back button of a subpage and General again).
	const latencies = [];
	for (let i = 0; i < 4; i++) {
		tree = await ui();
		const target =
			find(tree, (e) => e.id === 'com.apple.settings.general') ??
			find(tree, (e) => e.id === 'BackButton');
		if (!target) break;
		const { x, y } = center(tree, target);
		send({ cmd: 'touch', phase: 'down', x, y });
		await sleep(60);
		const from = chunks.length,
			at = nowUs();
		send({ cmd: 'touch', phase: 'up', x, y });
		await until(() => chunks.length > from, 3000, 'frame after touch up').catch(() => {});
		if (chunks.length > from) latencies.push((chunks[from].arrived - at) / 1000);
		await sleep(1200);
	}
	check(
		latencies.length > 0,
		'touch up → first chunk',
		latencies.map((v) => v.toFixed(1)).join(', ') + ' ms'
	);

	const swipe = await call({ cmd: 'swipe', x1: 0.5, y1: 0.7, x2: 0.5, y2: 0.4, duration: 0.3 });
	check(swipe.result === true, 'swipe reply');
	const press = await call({ cmd: 'longpress', x: 0.5, y: 0.5, duration: 0.3 });
	check(press.result === true, 'longpress reply');

	// Search field of Settings, then type.
	await call({ cmd: 'button', name: 'home' });
	await sleep(1200);
	tree = await ui();
	await call({
		cmd: 'tap',
		...center(
			tree,
			find(tree, (e) => e.label === 'Settings')
		),
	});
	await sleep(2000);
	tree = await settingsRoot();
	const search = find(tree, (e) => e.role === 'TextField');
	check(search, 'Settings search field in ui', search && JSON.stringify(search));
	if (search) {
		await call({ cmd: 'tap', ...center(tree, search) });
		await sleep(1200);
		t0 = Date.now();
		const typed = await call({ cmd: 'text', text: 'Wi-Fi' });
		check(typed.result === true, 'text reply', `${Date.now() - t0} ms for 5 characters`);
		await sleep(1000);
		tree = await ui();
		check(
			tree.elements.some((e) => e.value?.includes('Wi-Fi') || e.label?.includes('Wi-Fi')),
			'typed text reached the field',
			JSON.stringify(tree.elements.find((e) => e.value))
		);
		for (let i = 0; i < 5; i++) {
			send({ cmd: 'key', usage: 0x2a, down: true });
			send({ cmd: 'key', usage: 0x2a, down: false });
		}
	}
	const cyrillic = await call({ cmd: 'text', text: 'Привіт' });
	check(
		cyrillic.error === 'Only ASCII text can be typed; paste the rest.',
		'non-ASCII text is refused',
		cyrillic.error
	);
	const bad = await call({ cmd: 'nope' });
	check(typeof bad.error === 'string', 'unknown command gets an error reply', bad.error);

	await call({ cmd: 'button', name: 'home' });
	await sleep(1200);
	tree = await ui();
	check(
		find(tree, (e) => e.label === 'Settings'),
		'button home returns to the home screen'
	);

	// The stream decodes: AVCC → Annex-B with SPS/PPS from avcC, then ffmpeg.
	try {
		const config = configs.at(-1),
			avcC = Buffer.from(config.description, 'base64');
		const start = Buffer.from([0, 0, 0, 1]),
			out = [];
		let offset = 6;
		for (let sets = avcC[5] & 31, pps = false; ;) {
			for (let i = 0; i < sets; i++) {
				const n = avcC.readUInt16BE(offset);
				out.push(start, avcC.subarray(offset + 2, offset + 2 + n));
				offset += 2 + n;
			}
			if (pps) break;
			sets = avcC[offset++];
			pps = true;
		}
		for (const chunk of chunks.slice(config.index))
			for (let o = 0; o + 4 <= chunk.data.length;) {
				const n = chunk.data.readUInt32BE(o);
				out.push(start, chunk.data.subarray(o + 4, o + 4 + n));
				o += 4 + n;
			}
		const file = join(mkdtempSync(join(tmpdir(), 'sim-helper-')), 'stream.h264');
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
			Number(probe.split(',').at(-1)) === chunks.length - config.index,
			'ffprobe decodes every chunk',
			`${probe} (width,height,has_b_frames,frames) of ${chunks.length - config.index} chunks`
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
} catch (error) {
	failures++;
	console.log('FAIL', error.message);
	child.kill();
}
console.log(failures ? `${failures} failed` : 'all passed');
process.exit(failures ? 1 : 0);
