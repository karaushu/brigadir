/**
 * spec/remote-access-and-mobile#client-ui-seam, security review R2–R4, P2: the size of an image read from its header, before anything decodes it. A
 * small file may say 100 000 × 100 000 pixels — decoded, that is tens of gigabytes in main. PNG, JPEG, WebP and GIF.
 */
export type ImageSize = { width: number; height: number };
/** At most this many pixels (a 40 MP camera picture fits; a Retina screenshot of 6K is 20 MP)… */
export const imagePixelLimit = 40_000_000;
/** …and at most this long on either side. */
export const imageSideLimit = 16_384;

const u16be = (bytes: Uint8Array, at: number) => (bytes[at]! << 8) | bytes[at + 1]!;
const u16le = (bytes: Uint8Array, at: number) => bytes[at]! | (bytes[at + 1]! << 8);
const u24le = (bytes: Uint8Array, at: number) => u16le(bytes, at) | (bytes[at + 2]! << 16);
const u32be = (bytes: Uint8Array, at: number) => u16be(bytes, at) * 65_536 + u16be(bytes, at + 2);
const ascii = (bytes: Uint8Array, at: number, text: string) =>
	[...text].every((char, index) => bytes[at + index] === char.charCodeAt(0));

/** The width and height the header gives; null — not an image of these formats, or a header cut short. */
export function imageSize(bytes: Uint8Array): ImageSize | null {
	// PNG: the signature, then IHDR first.
	if (bytes.length >= 24 && ascii(bytes, 1, 'PNG') && ascii(bytes, 12, 'IHDR'))
		return { width: u32be(bytes, 16), height: u32be(bytes, 20) };
	// GIF: the logical screen.
	if (bytes.length >= 10 && ascii(bytes, 0, 'GIF8'))
		return { width: u16le(bytes, 6), height: u16le(bytes, 8) };
	// WebP: VP8 (lossy), VP8L (lossless) or VP8X (extended).
	if (bytes.length >= 30 && ascii(bytes, 0, 'RIFF') && ascii(bytes, 8, 'WEBP')) {
		if (ascii(bytes, 12, 'VP8 '))
			return { width: u16le(bytes, 26) & 0x3fff, height: u16le(bytes, 28) & 0x3fff };
		if (ascii(bytes, 12, 'VP8L')) {
			const bits = bytes[21]! | (bytes[22]! << 8) | (bytes[23]! << 16) | (bytes[24]! << 24);
			return { width: (bits & 0x3fff) + 1, height: ((bits >>> 14) & 0x3fff) + 1 };
		}
		if (ascii(bytes, 12, 'VP8X'))
			return { width: u24le(bytes, 24) + 1, height: u24le(bytes, 27) + 1 };
		return null;
	}
	// JPEG: the first start-of-frame marker (SOF0–SOF15 but DHT, JPG and DAC).
	if (bytes.length >= 4 && bytes[0] === 0xff && bytes[1] === 0xd8) {
		let at = 2;
		while (at + 9 < bytes.length) {
			if (bytes[at] !== 0xff) return null;
			const marker = bytes[at + 1]!;
			if (marker === 0xff) {
				at++;
				continue;
			}
			if (marker === 0xd8 || marker === 0x01 || (marker >= 0xd0 && marker <= 0xd7)) {
				at += 2;
				continue;
			}
			if (marker >= 0xc0 && marker <= 0xcf && ![0xc4, 0xc8, 0xcc].includes(marker))
				return { width: u16be(bytes, at + 7), height: u16be(bytes, at + 5) };
			at += 2 + u16be(bytes, at + 2);
		}
		return null;
	}
	return null;
}
/** Why an image may not be decoded here, or null when it may. */
export function imageSizeRefusal(bytes: Uint8Array): string | null {
	const size = imageSize(bytes);
	if (!size || !size.width || !size.height) return 'The image cannot be read.';
	if (
		size.width > imageSideLimit ||
		size.height > imageSideLimit ||
		size.width * size.height > imagePixelLimit
	)
		return `The image is too large: ${size.width} × ${size.height} pixels (at most ${imagePixelLimit / 1_000_000} megapixels and ${imageSideLimit} pixels a side).`;
	return null;
}
