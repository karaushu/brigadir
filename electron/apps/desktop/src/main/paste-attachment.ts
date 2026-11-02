import { clipboard, nativeImage, type NativeImage } from 'electron';
import { Attachments, SessionStore } from '@brigadir/persistence';
import { imageSizeRefusal, type AttachmentOwner, type PromptAttachment } from '@brigadir/core';

const imageLimit = 4 * 1024 * 1024,
	pngSignature = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);

// spec/composer#paste: ⌘V in the composer. Main reads the image from the system clipboard itself; the renderer only says a paste
// happened, so no image bytes cross the bridge. The platform offers a screenshot's TIFF as `image/png` too.
export async function pasteAttachment(
	key: AttachmentOwner,
	name: string,
	dataDir?: string
): Promise<PromptAttachment | null> {
	const store = await SessionStore.at(dataDir);
	await new Attachments(store).ownerDir(key);
	const png = await clipboardPng();
	if (!png) return null;
	return new Attachments(store).create(key, {
		kind: 'image',
		name,
		mimeType: 'image/png',
		data: png.toString('base64'),
	});
}

/** The image on this machine's clipboard as PNG, or null; a device reads its own for the machine it shows (spec/remote-access-and-mobile#client-ui-seam). */
export async function clipboardPng(): Promise<Buffer | null> {
	for (const item of await clipboard.read()) {
		const type = item.types.includes('image/png')
			? 'image/png'
			: item.types.find((value) => /^image\/(?:jpeg|webp|gif)$/.test(value));
		if (!type) continue;
		const blob = await item.getType(type);
		if (!(blob instanceof Blob)) continue;
		const bytes = Buffer.from(await blob.arrayBuffer());
		// Its header first: kept or decoded, a huge one would be decoded in main (security review R2–R4, P2).
		const refusal = imageSizeRefusal(bytes);
		if (refusal) throw new Error(refusal);
		if (
			type === 'image/png' &&
			bytes.length <= imageLimit &&
			bytes.subarray(0, 8).equals(pngSignature)
		)
			return bytes;
		const image = nativeImage.createFromBuffer(bytes);
		if (image.isEmpty()) throw new Error('Invalid image');
		return fittedPng(image);
	}
	return null;
}

/** A full-screen Retina screenshot can exceed the 4 MB image limit; it is scaled down until it fits instead of failing. */
export function fittedPng(image: NativeImage, limit = imageLimit): Buffer {
	let current = image,
		png = current.toPNG();
	for (let step = 0; png.length > limit && step < 6; step++) {
		const { width, height } = current.getSize(),
			scale = Math.min(0.9, Math.sqrt(limit / png.length) * 0.95),
			next = Math.max(1, Math.floor(width * scale));
		if (next >= width) break;
		current = current.resize({
			width: next,
			height: Math.max(1, Math.round((height * next) / width)),
			quality: 'best',
		});
		png = current.toPNG();
	}
	if (png.length > limit) throw new Error('Image is too large');
	return png;
}
