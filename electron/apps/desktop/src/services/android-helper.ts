// android-helper: the screen and input of one booted Android device (spec/browser-and-simulator#simulator) through scrcpy-server v4.1
// (Apache-2.0, vendored as apps/desktop/native/scrcpy-server-v4.1). Main starts the emulator and waits for
// sys.boot_completed; this process only mirrors and drives it.
//
// Usage: android-helper --serial <adb serial> --adb <adb> --server <scrcpy-server jar> [--max-size <px>]
//
// It speaks exactly the protocol of sim-helper (apps/desktop/native/sim-helper.m), so main treats both alike:
// stdout carries only frames [u8 type][u32 BE length][payload]:
//   1 JSON event; 2 JSON video config for WebCodecs VideoDecoder.configure;
//   3 video chunk [u8 key][u64 BE timestamp µs][AVCC access unit].
// The timestamp is scrcpy's PTS moved onto the clock of Node's process.hrtime (the earliest arrival anchors it).
// stdin carries JSON lines; a numeric `id` gets a reply event. EOF or {"cmd":"quit"} exits, stopping the server on the
// device and removing the adb forward. Logs go to stderr.
//
// scrcpy v4.1 wire facts (server/src/main/java/com/genymobile/scrcpy/{device/DesktopConnection,device/Streamer,
// control/ControlMessageReader,control/DeviceMessageWriter}.java at tag v4.1): with tunnel_forward the device listens on
// localabstract:scrcpy_<scid %08x>; the video socket is accepted first and gets one dummy byte, then the control
// socket. Video: u32 codec id, then 12-byte headers — a session packet (MSB set: flags u32, width u32, height u32) per
// capture session (rotation, reset) or a media packet (u64 PTS with bit 62 config, bit 61 key; u32 size) + payload.
import { execFile, spawn, type ChildProcess } from 'node:child_process';
import { randomInt } from 'node:crypto';
import { connect, type Socket } from 'node:net';
import { deflateSync, inflateSync } from 'node:zlib';

const SCRCPY_VERSION = '4.1';
const H264 = 0x68323634;
const POINTER_FINGER = -2n; // scrcpy's POINTER_ID_GENERIC_FINGER
const MSG = { keycode: 0, text: 1, touch: 2, setClipboard: 9, resetVideo: 17 } as const;
const TEXT_MAX = 300; // ControlMessageReader.INJECT_TEXT_MAX_LENGTH, in UTF-8 bytes
const CLIPBOARD_MAX = (1 << 18) - 14;

// ---------------------------------------------------------------- arguments

function argument(name: string) {
	const index = process.argv.indexOf(`--${name}`);
	return index > 0 ? process.argv[index + 1] : undefined;
}
const serial = argument('serial'),
	adb = argument('adb'),
	jar = argument('server');
const maxSize = Math.max(0, Number(argument('max-size') ?? 0) || 0);

// ---------------------------------------------------------------- output

function frame(type: number, payload: Buffer) {
	const header = Buffer.allocUnsafe(5);
	header[0] = type;
	header.writeUInt32BE(payload.length, 1);
	process.stdout.write(header);
	process.stdout.write(payload);
}
const emit = (event: Record<string, unknown>) => frame(1, Buffer.from(JSON.stringify(event)));
const log = (message: string) => process.stderr.write(`android-helper: ${message}\n`);
function warn(message: string) {
	log(message);
	emit({ event: 'error', message, fatal: false });
}
function reply(id: number | undefined, result: unknown, error?: string) {
	if (id === undefined) {
		if (error) warn(error);
		return;
	}
	emit(error ? { event: 'reply', id, error } : { event: 'reply', id, result: result ?? true });
}

// ---------------------------------------------------------------- adb

type Run = { stdout: Buffer; stderr: string };
function run(args: string[], timeout = 15_000): Promise<Run> {
	return new Promise((resolve, reject) => {
		execFile(
			adb!,
			['-s', serial!, ...args],
			{ encoding: 'buffer', maxBuffer: 128 << 20, timeout },
			(error, stdout, stderr) => {
				if (error) reject(new Error((stderr.toString().trim() || error.message).split('\n')[0]));
				else resolve({ stdout, stderr: stderr.toString() });
			}
		);
	});
}
const shell = async (command: string, timeout?: number) =>
	(await run(['shell', command], timeout)).stdout.toString();

// ---------------------------------------------------------------- byte queue

class Bytes {
	private parts: Buffer[] = [];
	length = 0;
	push(data: Buffer) {
		this.parts.push(data);
		this.length += data.length;
	}
	/** The first `n` bytes without removing them; the caller checks `length` first. */
	peek(n: number): Buffer {
		if (this.parts[0]!.length < n) this.parts = [Buffer.concat(this.parts)];
		return this.parts[0]!.subarray(0, n);
	}
	/** Removes and returns `n` bytes; the caller checks `length` first. */
	take(n: number): Buffer {
		if (this.parts[0]!.length < n) this.parts = [Buffer.concat(this.parts)];
		const head = this.parts[0]!;
		const out = head.subarray(0, n);
		if (head.length === n) this.parts.shift();
		else this.parts[0] = head.subarray(n);
		this.length -= n;
		return out;
	}
}

// ---------------------------------------------------------------- state

const scid = randomInt(0, 0x7fffffff).toString(16).padStart(8, '0');
const remoteJar = `/data/local/tmp/brigadir-scrcpy-${scid}.jar`;
let server: ChildProcess | null = null,
	video: Socket | null = null,
	control: Socket | null = null;
let port = 0,
	closing = false,
	lastServerError = '';
let physical = { width: 0, height: 0 },
	density = 1;
let size = { width: 0, height: 0 }; // the current video size in pixels; touches are sent in it
let sps: Buffer | null = null,
	pps: Buffer | null = null,
	configDirty = false;
let clockOffset = Infinity,
	lastReset = 0,
	dropping = false;
let clipboardSequence = 1n;
const clipboardAcks = new Map<bigint, () => void>();
const heldModifiers = new Set<number>();
let input: Promise<unknown> = Promise.resolve();

const nowUs = () => Number(process.hrtime.bigint() / 1000n);
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

// ---------------------------------------------------------------- lifecycle

async function shutdown(code: number) {
	if (closing) return;
	closing = true;
	setTimeout(() => process.exit(code), 950); // exit within a second whatever the device does
	video?.destroy();
	control?.destroy();
	const exited =
		server && server.exitCode === null && server.signalCode === null
			? new Promise<boolean>((resolve) => {
					server!.once('exit', () => resolve(true));
					setTimeout(() => resolve(false), 450);
				})
			: Promise.resolve(true);
	const unforward = port
		? run(['forward', '--remove', `tcp:${port}`], 800).catch(() => {})
		: Promise.resolve();
	if (!(await exited) && server) {
		// The server exits on the closed sockets; a stuck one is killed by its unique scid.
		await shell(`pkill -f scid=${scid}; rm -f ${remoteJar}`, 400).catch(() => {});
		server.kill();
	}
	await unforward;
	process.stdout.write('', () => process.exit(code));
}

/** Thrown by fail() to unwind; the shutdown has already started. */
class Fatal extends Error {}
function fail(message: string): never {
	if (!closing) {
		log(message);
		emit({ event: 'error', message, fatal: true });
		void shutdown(1);
	}
	throw new Fatal(message);
}
function crashed(error: unknown) {
	if (error instanceof Fatal || closing) return;
	log(error instanceof Error ? (error.stack ?? error.message) : String(error));
	try {
		fail(error instanceof Error ? error.message : String(error));
	} catch {
		/* unwound */
	}
}

async function start() {
	if (!serial || !adb || !jar)
		fail('Usage: android-helper --serial <adb serial> --adb <adb> --server <scrcpy-server jar>.');
	const state = await run(['get-state'], 5000).then(
		(r) => r.stdout.toString().trim(),
		() => ''
	);
	if (state !== 'device') fail(`The device ${serial} is not connected to adb.`);

	const [sizeText, densityText] = await Promise.all([shell('wm size'), shell('wm density')]);
	const sizeMatch =
		/Override size: (\d+)x(\d+)/.exec(sizeText) ?? /Physical size: (\d+)x(\d+)/.exec(sizeText);
	const densityMatch =
		/Override density: (\d+)/.exec(densityText) ?? /Physical density: (\d+)/.exec(densityText);
	if (!sizeMatch) fail('The device did not report its screen size.');
	physical = { width: Number(sizeMatch[1]), height: Number(sizeMatch[2]) };
	density = densityMatch ? Number(densityMatch[1]) / 160 : 1;

	await run(['push', jar!, remoteJar], 30_000).catch((error) =>
		fail(`The screen server could not be copied to the device: ${error.message}`)
	);
	const forwarded = await run(['forward', 'tcp:0', `localabstract:scrcpy_${scid}`]).catch((error) =>
		fail(`The adb forward failed: ${error.message}`)
	);
	port = Number(forwarded.stdout.toString().trim());
	if (!port) fail('The adb forward returned no port.');

	const options = [
		`scid=${scid}`,
		'log_level=info',
		'tunnel_forward=true',
		'audio=false',
		'control=true',
		'video_codec=h264',
		'send_device_meta=false',
		'send_dummy_byte=true',
		'send_stream_meta=true',
		'send_frame_meta=true',
		'cleanup=true',
		'clipboard_autosync=false',
		'power_on=true',
		'max_fps=60',
		'video_bit_rate=8000000',
		...(maxSize ? [`max_size=${maxSize}`] : []),
	];
	server = spawn(
		adb!,
		[
			'-s',
			serial!,
			'shell',
			`CLASSPATH=${remoteJar} app_process / com.genymobile.scrcpy.Server ${SCRCPY_VERSION} ${options.join(' ')}`,
		],
		{ stdio: ['ignore', 'pipe', 'pipe'] }
	);
	const serverLog = (data: Buffer) => {
		for (const line of data.toString().split('\n')) {
			if (!line.trim()) continue;
			process.stderr.write(`scrcpy: ${line}\n`);
			const error = /ERROR:\s*(.*)/.exec(line);
			if (error) lastServerError = error[1]!.trim();
		}
	};
	server.stdout!.on('data', serverLog);
	server.stderr!.on('data', serverLog);
	server.on('exit', () => {
		if (!closing)
			fail(
				lastServerError
					? `The screen server stopped: ${lastServerError}`
					: 'The screen server stopped.'
			);
	});

	video = await connectVideo();
	control = await connectSocket();
	control.setNoDelay(true);
	readVideo(video);
	readControl(control);
	setTimeout(() => {
		if (!size.width && !closing) fail('The device screen did not appear.');
	}, 15_000);
}

function connectSocket(): Promise<Socket> {
	return new Promise((resolve, reject) => {
		const socket = connect(port, '127.0.0.1');
		socket.once('connect', () => {
			socket.off('error', reject);
			resolve(socket);
		});
		socket.once('error', reject);
	});
}

/** The forward accepts before the device listens; only the dummy byte proves the server is there. */
async function connectVideo(): Promise<Socket> {
	for (const started = Date.now(); Date.now() - started < 15_000; await sleep(100)) {
		if (closing) throw new Error('closing');
		const socket = await connectSocket().catch(() => null);
		if (!socket) continue;
		const ok = await new Promise<Buffer | null>((resolve) => {
			socket.once('data', (data) => resolve(data));
			socket.once('close', () => resolve(null));
			socket.once('error', () => resolve(null));
		});
		if (ok) {
			socket.pause();
			socket.removeAllListeners();
			if (ok.length > 1) socket.unshift(ok.subarray(1));
			return socket;
		}
		socket.destroy();
	}
	fail(
		lastServerError
			? `The screen server did not start: ${lastServerError}`
			: 'The screen server did not start.'
	);
}

// ---------------------------------------------------------------- video

function readVideo(socket: Socket) {
	const queue = new Bytes();
	let codecRead = false,
		header: { pts: bigint; config: boolean; key: boolean; size: number } | null = null;
	socket.on('data', (data) => {
		queue.push(data);
		for (;;) {
			if (!codecRead) {
				if (queue.length < 4) return;
				const codec = queue.take(4).readUInt32BE(0);
				if (codec !== H264)
					fail(
						codec === 1
							? 'The device could not start its video encoder.'
							: 'The device sent no H.264 stream.'
					);
				codecRead = true;
			}
			if (!header) {
				if (queue.length < 12) return;
				const bytes = queue.take(12);
				if (bytes[0]! & 0x80) {
					session(bytes.readUInt32BE(4), bytes.readUInt32BE(8));
					continue;
				}
				const value = bytes.readBigUInt64BE(0);
				header = {
					pts: value & ((1n << 61n) - 1n),
					config: (value & (1n << 62n)) !== 0n,
					key: (value & (1n << 61n)) !== 0n,
					size: bytes.readUInt32BE(8),
				};
			}
			if (queue.length < header.size) return;
			const payload = queue.take(header.size);
			if (header.config) parameterSets(nals(payload));
			else media(payload, header.pts, header.key);
			header = null;
		}
	});
	socket.on('close', () => {
		if (!closing) fail('The device stopped running.');
	});
	socket.on('error', (error) => log(`video socket: ${error.message}`));
	socket.resume();
}

/** Screen size in pixels and points for the orientation of the video. */
function screen() {
	const landscape = size.width > size.height;
	const long = Math.max(physical.width, physical.height),
		short = Math.min(physical.width, physical.height);
	const width = landscape ? long : short,
		height = landscape ? short : long;
	return { width, height, pointWidth: width / density, pointHeight: height / density };
}

function session(width: number, height: number) {
	const first = !size.width;
	const changed = width !== size.width || height !== size.height;
	size = { width, height };
	if (first) lastServerError = ''; // an encoder retry before the first session is not the reason of a later stop
	if (first) emit({ event: 'ready', ...screen(), videoWidth: width, videoHeight: height });
	else if (changed) emit({ event: 'size', ...screen(), videoWidth: width, videoHeight: height });
}

/** Annex-B → NAL units without start codes or trailing zero bytes. */
function nals(data: Buffer): Buffer[] {
	const out: Buffer[] = [];
	const code = Buffer.from([0, 0, 1]);
	let at = data.indexOf(code);
	while (at >= 0) {
		const start = at + 3;
		const next = data.indexOf(code, start);
		let end = next < 0 ? data.length : next;
		while (end > start && data[end - 1] === 0) end--;
		if (end > start) out.push(data.subarray(start, end));
		at = next;
	}
	return out;
}

/** SPS/PPS go into avcC; returns the other NAL units. */
function parameterSets(units: Buffer[]): Buffer[] {
	const rest: Buffer[] = [];
	for (const unit of units) {
		const type = unit[0]! & 0x1f;
		if (type === 7) {
			if (!sps || !sps.equals(unit)) {
				sps = Buffer.from(unit);
				configDirty = true;
			}
		} else if (type === 8) {
			if (!pps || !pps.equals(unit)) {
				pps = Buffer.from(unit);
				configDirty = true;
			}
		} else rest.push(unit);
	}
	return rest;
}

function sendConfig() {
	if (!sps || !pps || sps.length < 4) return;
	const profile = sps[1]!;
	const head = Buffer.from([
		1,
		sps[1]!,
		sps[2]!,
		sps[3]!,
		0xff,
		0xe1,
		sps.length >> 8,
		sps.length & 0xff,
	]);
	const middle = Buffer.from([1, pps.length >> 8, pps.length & 0xff]);
	// High profiles carry chroma format and bit depth (4:2:0, 8 bit: MediaCodec surface input).
	const tail = [100, 110, 122, 144].includes(profile)
		? Buffer.from([0xfd, 0xf8, 0xf8, 0])
		: Buffer.alloc(0);
	const description = Buffer.concat([head, sps, middle, pps, tail]);
	const codec = `avc1.${[sps[1]!, sps[2]!, sps[3]!]
		.map((byte) => byte.toString(16).padStart(2, '0'))
		.join('')
		.toUpperCase()}`;
	frame(
		2,
		Buffer.from(
			JSON.stringify({
				codec,
				width: size.width,
				height: size.height,
				description: description.toString('base64'),
			})
		)
	);
	configDirty = false;
}

function media(payload: Buffer, pts: bigint, key: boolean) {
	const units = parameterSets(nals(payload));
	if (configDirty) sendConfig();
	if (!sps || !pps || !units.length) return;
	// A reader that stalls must not grow memory without bound: drop deltas, resume on a new keyframe.
	if (process.stdout.writableLength > 8 << 20) {
		if (!dropping) log('stdout is full: dropping frames');
		dropping = true;
		return;
	}
	if (dropping) {
		if (!key) {
			requestKeyframe();
			return;
		}
		dropping = false;
	}
	const now = nowUs(),
		ptsUs = Number(pts);
	clockOffset = Math.min(clockOffset, now - ptsUs);
	const chunk = Buffer.allocUnsafe(9 + units.reduce((sum, unit) => sum + 4 + unit.length, 0));
	chunk[0] = key ? 1 : 0;
	chunk.writeBigUInt64BE(BigInt(Math.max(0, ptsUs + clockOffset)), 1);
	let offset = 9;
	for (const unit of units) {
		chunk.writeUInt32BE(unit.length, offset);
		unit.copy(chunk, offset + 4);
		offset += 4 + unit.length;
	}
	frame(3, chunk);
}

/** RESET_VIDEO restarts the capture: a session packet, SPS/PPS and an IDR follow (~0.1 s). */
function requestKeyframe() {
	const now = Date.now();
	if (now - lastReset < 250) return;
	lastReset = now;
	controlWrite(Buffer.from([MSG.resetVideo]));
}

// ---------------------------------------------------------------- control

function controlWrite(message: Buffer): Promise<void> {
	return new Promise((resolve, reject) => {
		if (!control || control.destroyed) {
			reject(new Error('The device is not connected.'));
			return;
		}
		control.write(message, (error) => (error ? reject(error) : resolve()));
	});
}

/** Device messages: clipboard (0), clipboard ack (1), UHID output (2). Only acks matter here. */
function readControl(socket: Socket) {
	const queue = new Bytes();
	socket.on('data', (data) => {
		queue.push(data);
		while (queue.length >= 1) {
			const type = queue.peek(1)[0]!;
			if (type === 1) {
				if (queue.length < 9) return;
				const sequence = queue.take(9).readBigUInt64BE(1);
				clipboardAcks.get(sequence)?.();
				clipboardAcks.delete(sequence);
			} else if (type === 0 || type === 2) {
				if (queue.length < 5) return;
				const head = queue.peek(5);
				const total = 5 + (type === 0 ? head.readUInt32BE(1) : head.readUInt16BE(3));
				if (queue.length < total) return;
				queue.take(total);
			} else {
				log(`unknown device message ${type}`);
				queue.take(queue.length);
			}
		}
	});
	socket.on('close', () => {
		if (!closing) fail('The device stopped running.');
	});
	socket.on('error', (error) => log(`control socket: ${error.message}`));
}

function touchMessage(action: 0 | 1 | 2, x: number, y: number) {
	const message = Buffer.alloc(32);
	message[0] = MSG.touch;
	message[1] = action; // MotionEvent.ACTION_DOWN, UP, MOVE
	message.writeBigInt64BE(POINTER_FINGER, 2);
	message.writeInt32BE(Math.min(size.width - 1, Math.max(0, Math.round(x * size.width))), 10);
	message.writeInt32BE(Math.min(size.height - 1, Math.max(0, Math.round(y * size.height))), 14);
	message.writeUInt16BE(size.width, 18); // the server drops events made for another video size
	message.writeUInt16BE(size.height, 20);
	message.writeUInt16BE(action === 1 ? 0 : 0xffff, 22); // pressure, u16 fixed point
	// action button and buttons stay 0 for a finger
	return message;
}
const touch = (action: 0 | 1 | 2, x: number, y: number) => controlWrite(touchMessage(action, x, y));

function keyMessage(down: boolean, keycode: number, metaState = 0) {
	const message = Buffer.alloc(14);
	message[0] = MSG.keycode;
	message[1] = down ? 0 : 1; // KeyEvent.ACTION_DOWN, ACTION_UP
	message.writeInt32BE(keycode, 2);
	message.writeInt32BE(0, 6); // repeat
	message.writeInt32BE(metaState, 10);
	return message;
}
async function press(keycode: number) {
	await controlWrite(keyMessage(true, keycode));
	await controlWrite(keyMessage(false, keycode));
}

async function injectText(text: string) {
	for (let at = 0; at < text.length; at += TEXT_MAX) {
		const bytes = Buffer.from(text.slice(at, at + TEXT_MAX), 'utf8');
		const message = Buffer.alloc(5 + bytes.length);
		message[0] = MSG.text;
		message.writeUInt32BE(bytes.length, 1);
		bytes.copy(message, 5);
		await controlWrite(message);
	}
}

/** SET_CLIPBOARD with paste: Android sets the clipboard and presses KEYCODE_PASTE; the ack comes after both. */
async function paste(text: string) {
	const bytes = Buffer.from(text, 'utf8');
	if (bytes.length > CLIPBOARD_MAX) throw new Error('The text is too long to paste.');
	const sequence = clipboardSequence++;
	const message = Buffer.alloc(14 + bytes.length);
	message[0] = MSG.setClipboard;
	message.writeBigUInt64BE(sequence, 1);
	message[9] = 1;
	message.writeUInt32BE(bytes.length, 10);
	bytes.copy(message, 14);
	const acked = new Promise<void>((resolve, reject) => {
		clipboardAcks.set(sequence, resolve);
		setTimeout(() => {
			clipboardAcks.delete(sequence);
			reject(new Error('The device did not take the text.'));
		}, 5000);
	});
	await controlWrite(message);
	await acked;
}

// USB HID usage page 7 → Android KeyEvent keycodes.
const KEYCODES = new Map<number, number>([
	[0x28, 66],
	[0x29, 111],
	[0x2a, 67],
	[0x2b, 61],
	[0x2c, 62],
	[0x2d, 69],
	[0x2e, 70],
	[0x2f, 71],
	[0x30, 72],
	[0x31, 73],
	[0x33, 74],
	[0x34, 75],
	[0x35, 68],
	[0x36, 55],
	[0x37, 56],
	[0x38, 76],
	[0x39, 115],
	[0x49, 124],
	[0x4a, 122],
	[0x4b, 92],
	[0x4c, 112],
	[0x4d, 123],
	[0x4e, 93],
	[0x4f, 22],
	[0x50, 21],
	[0x51, 20],
	[0x52, 19],
	[0xe0, 113],
	[0xe1, 59],
	[0xe2, 57],
	[0xe3, 117],
	[0xe4, 114],
	[0xe5, 60],
	[0xe6, 58],
	[0xe7, 118],
]);
for (let i = 0; i < 26; i++) KEYCODES.set(0x04 + i, 29 + i); // A–Z
for (let i = 0; i < 9; i++) KEYCODES.set(0x1e + i, 8 + i); // 1–9
KEYCODES.set(0x27, 7); // 0
for (let i = 0; i < 12; i++) KEYCODES.set(0x3a + i, 131 + i); // F1–F12
// Modifier usage → KeyEvent.META_* bits (the side bit and the generic bit).
const META = new Map<number, number>([
	[0xe0, 0x3000],
	[0xe4, 0x5000],
	[0xe1, 0x41],
	[0xe5, 0x81],
	[0xe2, 0x12],
	[0xe6, 0x22],
	[0xe3, 0x30000],
	[0xe7, 0x50000],
]);
const metaState = () =>
	[...heldModifiers].reduce((state, usage) => state | (META.get(usage) ?? 0), 0);

// ---------------------------------------------------------------- screenshot (PNG, scaled without dependencies)

const CRC_TABLE = Array.from({ length: 256 }, (_, n) => {
	let c = n;
	for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
	return c >>> 0;
});
function crc32(data: Buffer) {
	let c = 0xffffffff;
	for (const byte of data) c = CRC_TABLE[(c ^ byte) & 0xff]! ^ (c >>> 8);
	return (c ^ 0xffffffff) >>> 0;
}
function pngChunk(type: string, data: Buffer) {
	const body = Buffer.concat([Buffer.from(type, 'latin1'), data]);
	const out = Buffer.alloc(8 + data.length + 4);
	out.writeUInt32BE(data.length, 0);
	body.copy(out, 4);
	out.writeUInt32BE(crc32(body), 8 + data.length);
	return out;
}

/** Decodes an 8-bit RGB/RGBA non-interlaced PNG (what screencap writes); null for anything else. */
function decodePng(
	png: Buffer
): { width: number; height: number; channels: number; pixels: Buffer } | null {
	if (png.length < 33 || png.readUInt32BE(12) !== 0x49484452) return null;
	const width = png.readUInt32BE(16),
		height = png.readUInt32BE(20),
		depth = png[24],
		color = png[25],
		interlace = png[28];
	if (depth !== 8 || interlace !== 0 || (color !== 6 && color !== 2)) return null;
	const channels = color === 6 ? 4 : 3;
	const idat: Buffer[] = [];
	for (let at = 8; at + 8 <= png.length;) {
		const length = png.readUInt32BE(at),
			type = png.toString('latin1', at + 4, at + 8);
		if (type === 'IDAT') idat.push(png.subarray(at + 8, at + 8 + length));
		if (type === 'IEND') break;
		at += 12 + length;
	}
	const raw = inflateSync(Buffer.concat(idat));
	const stride = width * channels,
		pixels = Buffer.alloc(stride * height);
	for (let y = 0; y < height; y++) {
		const filter = raw[y * (stride + 1)]!,
			line = y * (stride + 1) + 1,
			row = y * stride,
			up = row - stride;
		for (let x = 0; x < stride; x++) {
			const a = x >= channels ? pixels[row + x - channels]! : 0,
				b = y ? pixels[up + x]! : 0,
				c = y && x >= channels ? pixels[up + x - channels]! : 0;
			let value = raw[line + x]!;
			if (filter === 1) value += a;
			else if (filter === 2) value += b;
			else if (filter === 3) value += (a + b) >> 1;
			else if (filter === 4) {
				const p = a + b - c,
					pa = Math.abs(p - a),
					pb = Math.abs(p - b),
					pc = Math.abs(p - c);
				value += pa <= pb && pa <= pc ? a : pb <= pc ? b : c;
			}
			pixels[row + x] = value & 0xff;
		}
	}
	return { width, height, channels, pixels };
}

/** Area-average downscale, then an RGB(A) PNG with the Sub filter. */
function scalePng(image: NonNullable<ReturnType<typeof decodePng>>, maxSide: number) {
	const { width, height, channels, pixels } = image;
	const scale = Math.min(1, maxSide / Math.max(width, height));
	const outWidth = Math.max(1, Math.round(width * scale)),
		outHeight = Math.max(1, Math.round(height * scale));
	const stride = outWidth * channels,
		raw = Buffer.alloc((stride + 1) * outHeight),
		sums = new Float64Array(channels);
	const row = Buffer.alloc(stride);
	for (let y = 0; y < outHeight; y++) {
		const y0 = Math.floor((y * height) / outHeight),
			y1 = Math.max(y0 + 1, Math.floor(((y + 1) * height) / outHeight));
		for (let x = 0; x < outWidth; x++) {
			const x0 = Math.floor((x * width) / outWidth),
				x1 = Math.max(x0 + 1, Math.floor(((x + 1) * width) / outWidth));
			sums.fill(0);
			for (let sy = y0; sy < y1; sy++)
				for (let sx = x0, at = (sy * width + x0) * channels; sx < x1; sx++)
					for (let k = 0; k < channels; k++) sums[k]! += pixels[at++]!;
			const count = (y1 - y0) * (x1 - x0);
			for (let k = 0; k < channels; k++) row[x * channels + k] = Math.round(sums[k]! / count);
		}
		const line = y * (stride + 1);
		raw[line] = 1;
		for (let x = 0; x < stride; x++)
			raw[line + 1 + x] = (row[x]! - (x >= channels ? row[x - channels]! : 0)) & 0xff;
	}
	const ihdr = Buffer.alloc(13);
	ihdr.writeUInt32BE(outWidth, 0);
	ihdr.writeUInt32BE(outHeight, 4);
	ihdr[8] = 8;
	ihdr[9] = channels === 4 ? 6 : 2;
	const png = Buffer.concat([
		Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
		pngChunk('IHDR', ihdr),
		pngChunk('IDAT', deflateSync(raw, { level: 6 })),
		pngChunk('IEND', Buffer.alloc(0)),
	]);
	return { png, width: outWidth, height: outHeight };
}

async function screenshot(maxSide: number) {
	const { stdout } = await run(['exec-out', 'screencap', '-p'], 15_000);
	if (stdout.readUInt32BE(0) !== 0x89504e47) throw new Error('The device sent no screenshot.');
	const image = decodePng(stdout);
	if (!image)
		return {
			png: stdout.toString('base64'),
			width: stdout.readUInt32BE(16),
			height: stdout.readUInt32BE(20),
		};
	if (Math.max(image.width, image.height) <= maxSide)
		return { png: stdout.toString('base64'), width: image.width, height: image.height };
	const scaled = scalePng(image, maxSide);
	return { png: scaled.png.toString('base64'), width: scaled.width, height: scaled.height };
}

// ---------------------------------------------------------------- accessibility tree

const unescapeXml = (value: string) =>
	value.replace(/&(#x[0-9a-f]+|#\d+|amp|lt|gt|quot|apos);/gi, (_, entity: string) =>
		entity[0] === '#'
			? String.fromCodePoint(
					entity[1] === 'x' || entity[1] === 'X'
						? parseInt(entity.slice(2), 16)
						: Number(entity.slice(1))
				)
			: ({ amp: '&', lt: '<', gt: '>', quot: '"', apos: "'" } as Record<string, string>)[
					entity.toLowerCase()
				]!
	);

async function uiTree() {
	let xml = '';
	for (let attempt = 0; attempt < 2 && !xml; attempt++) {
		const out = (
			await run(['exec-out', 'uiautomator', 'dump', '/dev/tty'], 30_000)
		).stdout.toString('utf8');
		const start = out.indexOf('<?xml'),
			end = out.lastIndexOf('</hierarchy>');
		if (start >= 0 && end > start) xml = out.slice(start, end + 12);
		else log(`uiautomator: ${out.trim().split('\n')[0]}`);
	}
	if (!xml) throw new Error('The device sent no accessibility tree.');
	const shown = screen();
	const elements: Record<string, unknown>[] = [];
	const round = (value: number) => Math.round((value / density) * 10) / 10;
	for (const match of xml.matchAll(/<node\b([^>]*?)\/?>/g)) {
		const attributes: Record<string, string> = {};
		for (const pair of match[1]!.matchAll(/([\w-]+)="([^"]*)"/g))
			attributes[pair[1]!] = unescapeXml(pair[2]!);
		const bounds = /\[(-?\d+),(-?\d+)\]\[(-?\d+),(-?\d+)\]/.exec(attributes.bounds ?? '');
		if (!bounds) continue;
		const [x1, y1, x2, y2] = bounds.slice(1).map(Number) as [number, number, number, number];
		if (x2 <= x1 || y2 <= y1) continue;
		const className = attributes.class ?? '';
		const role = className.slice(className.lastIndexOf('.') + 1);
		const text = attributes.text ?? '',
			description = attributes['content-desc'] ?? '';
		const editable = /EditText|TextField/.test(className);
		let label = editable ? description || attributes.hint || '' : text || description;
		let value = editable
			? text
			: attributes.checkable === 'true'
				? attributes.checked === 'true'
					? 'on'
					: 'off'
				: '';
		if (editable && value && value === attributes.hint) value = '';
		const id = (attributes['resource-id'] ?? '').replace(/^[^:/]+:id\//, '');
		const actionable =
			attributes.clickable === 'true' ||
			attributes.scrollable === 'true' ||
			attributes['long-clickable'] === 'true';
		if (!label && !value && !id && !actionable && !editable) continue; // layout only
		label = label.trim();
		elements.push({
			role,
			label,
			id,
			...(value ? { value } : {}),
			frame: [round(x1), round(y1), round(x2 - x1), round(y2 - y1)],
		});
	}
	return { width: shown.pointWidth, height: shown.pointHeight, elements };
}

// ---------------------------------------------------------------- commands

const unit = (value: unknown) =>
	typeof value === 'number' && Number.isFinite(value) ? Math.min(1, Math.max(0, value)) : null;
const seconds = (value: unknown, fallback: number) =>
	Math.min(
		10,
		Math.max(0.05, typeof value === 'number' && Number.isFinite(value) ? value : fallback)
	);

/** Input runs in order, one gesture at a time, like sim-helper's input queue. */
function queued(id: number | undefined, body: () => Promise<unknown>) {
	input = input
		.then(async () => {
			if (!size.width) throw new Error('The device screen is not ready.');
			return body();
		})
		.then(
			(result) => {
				if (id !== undefined) reply(id, result ?? true);
			},
			(error: Error) => reply(id, null, error.message)
		);
}

async function gesture(x1: number, y1: number, x2: number, y2: number, duration: number) {
	const steps = Math.max(2, Math.round(duration * 60));
	await touch(0, x1, y1);
	for (let i = 1; i <= steps; i++) {
		await sleep((duration * 1000) / steps);
		await touch(2, x1 + ((x2 - x1) * i) / steps, y1 + ((y2 - y1) * i) / steps);
	}
	await touch(1, x2, y2);
}

function handle(message: Record<string, unknown>) {
	const id = typeof message.id === 'number' ? message.id : undefined;
	const cmd = typeof message.cmd === 'string' ? message.cmd : '';
	const x = unit(message.x),
		y = unit(message.y);
	switch (cmd) {
		case 'touch': {
			const action = ({ down: 0, up: 1, move: 2 } as const)[
				message.phase as 'down' | 'up' | 'move'
			];
			if (action === undefined || x === null || y === null)
				return reply(id, null, 'A touch needs a phase and x, y from 0 to 1.');
			return queued(id, () => touch(action, x, y));
		}
		case 'tap':
			if (x === null || y === null) return reply(id, null, 'A tap needs x and y from 0 to 1.');
			return queued(id, async () => {
				await touch(0, x, y);
				await sleep(60);
				await touch(1, x, y);
			});
		case 'longpress': {
			if (x === null || y === null)
				return reply(id, null, 'A long press needs x and y from 0 to 1.');
			const duration = seconds(message.duration, 0.8);
			return queued(id, async () => {
				await touch(0, x, y);
				await sleep(duration * 1000);
				await touch(1, x, y);
			});
		}
		case 'swipe': {
			const x1 = unit(message.x1),
				y1 = unit(message.y1),
				x2 = unit(message.x2),
				y2 = unit(message.y2);
			if (x1 === null || y1 === null || x2 === null || y2 === null)
				return reply(id, null, 'A swipe needs x1, y1, x2, y2 from 0 to 1.');
			const duration = seconds(message.duration, 0.3);
			return queued(id, () => gesture(x1, y1, x2, y2, duration));
		}
		case 'button': {
			const keycode = ({ home: 3, back: 4, lock: 26 } as Record<string, number>)[
				String(message.name)
			];
			if (!keycode) return reply(id, null, 'The button must be home, back or lock.');
			return queued(id, () => press(keycode));
		}
		case 'key': {
			const usage = message.usage;
			if (typeof usage !== 'number' || !Number.isInteger(usage) || usage <= 0 || usage > 0xffff)
				return reply(id, null, 'A key needs a HID usage.');
			const keycode = KEYCODES.get(usage);
			if (keycode === undefined)
				return reply(
					id,
					null,
					`The key with HID usage 0x${usage.toString(16)} has no Android key.`
				);
			const down = message.down === true;
			if (META.has(usage)) {
				if (down) heldModifiers.add(usage);
				else heldModifiers.delete(usage);
			}
			const state = metaState();
			return queued(id, () => controlWrite(keyMessage(down, keycode, state)));
		}
		case 'text': {
			const text = typeof message.text === 'string' ? message.text : null;
			if (text === null) return reply(id, null, 'Text is missing.');
			// ASCII types as key events; anything else goes through the device clipboard and KEYCODE_PASTE (probe C0).
			return queued(id, () => (/^[\x20-\x7e\n\t]*$/.test(text) ? injectText(text) : paste(text)));
		}
		case 'keyframe':
			requestKeyframe();
			return reply(id, null);
		case 'ui':
			void uiTree().then(
				(tree) => reply(id, tree),
				(error: Error) => reply(id, null, error.message)
			);
			return;
		case 'screenshot': {
			const side =
				typeof message.maxSide === 'number' && message.maxSide >= 16 ? message.maxSide : 1000;
			void screenshot(side).then(
				(shot) => reply(id, shot),
				(error: Error) => reply(id, null, error.message)
			);
			return;
		}
		case 'quit':
			void shutdown(0);
			return;
		default:
			return reply(id, null, `Unknown command "${cmd}".`);
	}
}

function readCommands() {
	let pending = '';
	process.stdin.setEncoding('utf8');
	process.stdin.on('data', (data: string) => {
		pending += data;
		let newline: number;
		while ((newline = pending.indexOf('\n')) >= 0) {
			const line = pending.slice(0, newline).trim();
			pending = pending.slice(newline + 1);
			if (!line) continue;
			let message: unknown;
			try {
				message = JSON.parse(line);
			} catch {
				message = null;
			}
			if (message && typeof message === 'object' && !Array.isArray(message))
				handle(message as Record<string, unknown>);
			else warn('A command was not a JSON object.');
		}
	});
	// The app keeps stdin open: EOF means it is gone, even after a SIGKILL.
	process.stdin.on('end', () => void shutdown(0));
	process.stdin.on('error', () => void shutdown(0));
}

process.on('SIGTERM', () => void shutdown(0));
process.on('SIGINT', () => void shutdown(0));
process.stdout.on('error', () => void shutdown(0)); // EPIPE: main is gone
process.on('uncaughtException', crashed);
process.on('unhandledRejection', crashed);
readCommands();
start().catch(crashed);
