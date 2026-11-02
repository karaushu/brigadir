/**
 * spec/remote-access-and-mobile#phone-network: a strict CBOR decoder (RFC 8949) for what WebAuthn sends — the attestation object, a COSE key and the
 * extensions of the authenticator data. Only what they use: unsigned and negative integers, byte and text strings, arrays,
 * maps with integer or text keys, `false`, `true`, `null`. Definite lengths only; no tags, no floats; a duplicate map key,
 * a length past the end or nesting deeper than 16 is an error. The input comes from a phone, so every length is checked
 * against what is left before anything is allocated.
 */
export type CborValue =
	number | Uint8Array | string | boolean | null | CborValue[] | Map<number | string, CborValue>;
export class CborError extends Error {}
const maxDepth = 16;
const decoder = new TextDecoder('utf-8', { fatal: true });

/** Decodes one item at `offset`; returns it and where it ended. Trailing bytes are the caller's to judge. */
export function decodeCborItem(data: Uint8Array, offset = 0): { value: CborValue; end: number } {
	let at = offset;
	const need = (length: number) => {
		if (length > data.length - at) throw new CborError('CBOR: past the end');
	};
	const argument = (info: number): number => {
		if (info < 24) return info;
		const size = info === 24 ? 1 : info === 25 ? 2 : info === 26 ? 4 : info === 27 ? 8 : 0;
		if (!size) throw new CborError('CBOR: indefinite or reserved length');
		need(size);
		let value = 0;
		for (let index = 0; index < size; index++) value = value * 256 + data[at + index]!;
		at += size;
		if (!Number.isSafeInteger(value)) throw new CborError('CBOR: integer too large');
		return value;
	};
	const item = (depth: number): CborValue => {
		if (depth > maxDepth) throw new CborError('CBOR: nested too deep');
		need(1);
		const initial = data[at++]!,
			major = initial >> 5,
			info = initial & 31;
		switch (major) {
			case 0:
				return argument(info);
			case 1:
				return -1 - argument(info);
			case 2: {
				const length = argument(info);
				need(length);
				const bytes = data.slice(at, at + length);
				at += length;
				return bytes;
			}
			case 3: {
				const length = argument(info);
				need(length);
				let text: string;
				try {
					text = decoder.decode(data.subarray(at, at + length));
				} catch {
					throw new CborError('CBOR: invalid UTF-8');
				}
				at += length;
				return text;
			}
			case 4: {
				const length = argument(info);
				// Each item takes at least one byte: a length beyond what is left is a lie, not an allocation.
				need(length);
				const items: CborValue[] = [];
				for (let index = 0; index < length; index++) items.push(item(depth + 1));
				return items;
			}
			case 5: {
				const length = argument(info);
				need(length * 2);
				const map = new Map<number | string, CborValue>();
				for (let index = 0; index < length; index++) {
					const key = item(depth + 1);
					if (typeof key !== 'number' && typeof key !== 'string')
						throw new CborError('CBOR: a map key that is not an integer or text');
					if (map.has(key)) throw new CborError('CBOR: a duplicate map key');
					map.set(key, item(depth + 1));
				}
				return map;
			}
			case 7:
				if (info === 20) return false;
				if (info === 21) return true;
				if (info === 22) return null;
				throw new CborError('CBOR: an unsupported simple value or float');
			default:
				throw new CborError('CBOR: tags are not accepted');
		}
	};
	const value = item(0);
	return { value, end: at };
}
/** One item that must take the whole input. */
export function decodeCbor(data: Uint8Array): CborValue {
	const { value, end } = decodeCborItem(data);
	if (end !== data.length) throw new CborError('CBOR: trailing bytes');
	return value;
}
