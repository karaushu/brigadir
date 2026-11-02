import { describe, expect, it } from 'vitest';
import { imageSize, imageSizeRefusal } from './image-size';

/** The first bytes of a PNG whose IHDR says this size: all an image bomb needs to be refused. */
function pngHeader(width: number, height: number): Uint8Array {
	const bytes = new Uint8Array(33);
	bytes.set([137, 80, 78, 71, 13, 10, 26, 10, 0, 0, 0, 13, 73, 72, 68, 82]);
	new DataView(bytes.buffer).setUint32(16, width);
	new DataView(bytes.buffer).setUint32(20, height);
	return bytes;
}
function jpegHeader(width: number, height: number): Uint8Array {
	// SOI, an APP0 of 16 bytes, then SOF0 with the size.
	const app0 = [0xff, 0xe0, 0, 16, ...Array(14).fill(0)];
	const sof = [0xff, 0xc0, 0, 17, 8, height >> 8, height & 255, width >> 8, width & 255, 3];
	return new Uint8Array([0xff, 0xd8, ...app0, ...sof, ...Array(12).fill(0)]);
}
function webpHeader(kind: 'VP8 ' | 'VP8L' | 'VP8X', width: number, height: number): Uint8Array {
	const bytes = new Uint8Array(40);
	bytes.set([...'RIFF'].map((c) => c.charCodeAt(0)));
	bytes.set(
		[...'WEBP'].map((c) => c.charCodeAt(0)),
		8
	);
	bytes.set(
		[...kind].map((c) => c.charCodeAt(0)),
		12
	);
	const view = new DataView(bytes.buffer);
	if (kind === 'VP8 ') {
		view.setUint16(26, width, true);
		view.setUint16(28, height, true);
	} else if (kind === 'VP8L') {
		bytes[20] = 0x2f;
		view.setUint32(21, ((width - 1) & 0x3fff) | (((height - 1) & 0x3fff) << 14), true);
	} else {
		view.setUint32(24, width - 1, true);
		view.setUint32(27, height - 1, true);
	}
	return bytes;
}

describe('security review R2–R4, P2: an image is measured before it is decoded', () => {
	it('reads the size of PNG, JPEG, WebP and GIF from the header', () => {
		expect(imageSize(pngHeader(800, 600))).toEqual({ width: 800, height: 600 });
		expect(imageSize(jpegHeader(4032, 3024))).toEqual({ width: 4032, height: 3024 });
		expect(imageSize(webpHeader('VP8 ', 1200, 900))).toEqual({ width: 1200, height: 900 });
		expect(imageSize(webpHeader('VP8L', 1200, 900))).toEqual({ width: 1200, height: 900 });
		expect(imageSize(webpHeader('VP8X', 20_000, 9000))).toEqual({ width: 20_000, height: 9000 });
		expect(imageSize(new Uint8Array([71, 73, 70, 56, 57, 97, 64, 1, 200, 0]))).toEqual({
			width: 320,
			height: 200,
		});
		expect(imageSize(new TextEncoder().encode('not an image at all'))).toBeNull();
	});
	it('refuses a small file that says it is huge, and anything it cannot measure', () => {
		expect(imageSizeRefusal(pngHeader(6016, 6016))).toBeNull();
		// 33 bytes that would decode into 40 GB.
		expect(imageSizeRefusal(pngHeader(100_000, 100_000))).toMatch(/too large: 100000 × 100000/);
		expect(imageSizeRefusal(pngHeader(16_385, 10))).toMatch(/too large/);
		expect(imageSizeRefusal(pngHeader(8000, 8000))).toMatch(/40 megapixels/);
		expect(imageSizeRefusal(jpegHeader(65_535, 65_535))).toMatch(/too large/);
		expect(imageSizeRefusal(webpHeader('VP8X', 16_000, 16_000))).toMatch(/too large/);
		expect(imageSizeRefusal(new Uint8Array(10))).toBe('The image cannot be read.');
	});
});
