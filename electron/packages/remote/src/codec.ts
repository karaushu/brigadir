/**
 * spec/remote-access-and-mobile#pairing: the gateway's text frames are JSON that keeps what Electron's structured clone keeps and JSON drops —
 * `undefined` (an argument a validator tells from `null`) and bytes (`Uint8Array`, `simulator:frame`). Both become a
 * one-key object under the NUL key, which no table validator accepts as data, and turn back on decoding.
 *
 * spec/remote-access-and-mobile#browser-from-device: a frame whose value carries bytes may go as a binary WebSocket frame instead — `[version u8 = 1]
 * [header length u32 BE][header: the same JSON, each byte array a reference `p<offset>:<length>`][the bytes]` — so a
 * video or screencast frame crosses without base64 and without a big JSON string.
 *
 * spec/remote-access-and-mobile#phone-network: the text frames are the same in a phone's browser (`@brigadir/remote/web`); a phone gets text frames only.
 */
import { fromBase64, toBase64 } from './base64';

const tag = '\u0000';
type Tagged = { [tag]: string };
/** What a byte array becomes in the JSON: inline base64 (text frames) or a reference into the binary frame's tail. */
type Bytes = (value: Uint8Array) => string;
const inline: Bytes = (value) => `b${toBase64(value)}`;
function encodeValue(value: unknown, depth: number, bytes: Bytes): unknown {
	if (depth > 64) throw new Error('Value nests too deep');
	if (value === undefined) return { [tag]: 'u' };
	if (value instanceof Uint8Array) return { [tag]: bytes(value) };
	if (Array.isArray(value)) return value.map((item) => encodeValue(item, depth + 1, bytes));
	if (value !== null && typeof value === 'object') {
		if (typeof (value as { toJSON?: unknown }).toJSON === 'function')
			return encodeValue((value as { toJSON(): unknown }).toJSON(), depth + 1, bytes);
		const out: Record<string, unknown> = {};
		for (const [key, item] of Object.entries(value)) out[key] = encodeValue(item, depth + 1, bytes);
		return out;
	}
	if (typeof value === 'bigint' || typeof value === 'function' || typeof value === 'symbol')
		throw new Error(`A ${typeof value} cannot cross the gateway`);
	return value;
}
export function encodeFrame(value: unknown): string {
	return JSON.stringify(encodeValue(value, 0, inline));
}
/** The bytes a reference points at; null — no binary tail (a text frame). */
type Tail = Uint8Array | null;
function decodeValue(value: unknown, tail: Tail): unknown {
	if (Array.isArray(value)) return value.map((item) => decodeValue(item, tail));
	if (value !== null && typeof value === 'object') {
		const keys = Object.keys(value);
		if (keys.length === 1 && keys[0] === tag) {
			const text = (value as Tagged)[tag];
			if (text === 'u') return undefined;
			if (typeof text === 'string' && text.startsWith('b')) return fromBase64(text.slice(1));
			const part = typeof text === 'string' ? /^p(\d{1,10}):(\d{1,10})$/.exec(text) : null;
			if (part && tail) {
				const start = Number(part[1]),
					length = Number(part[2]);
				if (start + length > tail.length) throw new Error('A byte reference is out of the frame');
				// A copy: a view would keep (and send on to the window) the whole frame's buffer.
				return new Uint8Array(tail.subarray(start, start + length));
			}
			throw new Error('Unknown tag');
		}
		const out: Record<string, unknown> = {};
		for (const key of keys) {
			// A prototype key from the wire would land on the object's prototype chain through assignment.
			if (key === '__proto__') continue;
			out[key] = decodeValue((value as Record<string, unknown>)[key], tail);
		}
		return out;
	}
	return value;
}
export function decodeFrame(text: string): unknown {
	return decodeValue(JSON.parse(text), null);
}
export const binaryFrameVersion = 1;
/** A binary frame of `value`, or null when it carries no bytes (it goes as text then). */
export function encodeBinaryFrame(value: unknown): Buffer | null {
	const parts: Uint8Array[] = [];
	let offset = 0;
	const header = Buffer.from(
		JSON.stringify(
			encodeValue(value, 0, (bytes) => {
				parts.push(bytes);
				const reference = `p${offset}:${bytes.length}`;
				offset += bytes.length;
				return reference;
			})
		)
	);
	if (!parts.length) return null;
	const head = Buffer.alloc(5);
	head[0] = binaryFrameVersion;
	head.writeUInt32BE(header.length, 1);
	return Buffer.concat([head, header, ...parts], 5 + header.length + offset);
}
export function decodeBinaryFrame(frame: Uint8Array): unknown {
	if (frame.length < 5 || frame[0] !== binaryFrameVersion) throw new Error('Unknown binary frame');
	const length = Buffer.from(frame.buffer, frame.byteOffset, frame.length).readUInt32BE(1);
	if (5 + length > frame.length) throw new Error('The binary frame is cut');
	const header = Buffer.from(frame.buffer, frame.byteOffset + 5, length).toString('utf8');
	return decodeValue(JSON.parse(header), frame.subarray(5 + length));
}
