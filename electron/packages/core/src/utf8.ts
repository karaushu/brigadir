/** UTF-8 size without the DOM or Node, equal to `Buffer.byteLength(value, 'utf8')` (a lone surrogate counts as U+FFFD). */
export function utf8Bytes(value: string): number {
	let bytes = 0;
	for (const char of value) {
		const code = char.codePointAt(0)!;
		bytes += code < 0x80 ? 1 : code < 0x800 ? 2 : code < 0x10000 ? 3 : 4;
	}
	return bytes;
}
/** `utf8Bytes(value) <= limit`, without walking a text that is surely under or over it. */
export function fitsUtf8(value: string, limit: number): boolean {
	if (value.length > limit) return false;
	if (value.length * 3 <= limit) return true;
	let bytes = 0;
	for (let index = 0; index < value.length; index++) {
		const code = value.charCodeAt(index);
		if (code < 0x80) bytes += 1;
		else if (code < 0x800) bytes += 2;
		else if (code >= 0xd800 && code < 0xdc00 && index + 1 < value.length) {
			const next = value.charCodeAt(index + 1);
			if (next >= 0xdc00 && next < 0xe000) {
				bytes += 4;
				index++;
			} else bytes += 3;
		} else bytes += 3;
		if (bytes > limit) return false;
	}
	return true;
}
