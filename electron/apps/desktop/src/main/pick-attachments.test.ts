import { afterEach, describe, expect, it, vi } from 'vitest';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const decoded: number[] = [];
vi.mock('electron', () => ({
	dialog: {},
	nativeImage: {
		// The real one would allocate the picture: here it only counts that it was asked to.
		createFromBuffer: (bytes: Buffer) => {
			decoded.push(bytes.length);
			return { isEmpty: () => true };
		},
	},
}));
import { attachPaths, uploadAttachment } from './pick-attachments';

/** 33 bytes of a PNG that says 100 000 × 100 000 pixels. */
function bomb() {
	const bytes = new Uint8Array(33);
	bytes.set([137, 80, 78, 71, 13, 10, 26, 10, 0, 0, 0, 13, 73, 72, 68, 82]);
	new DataView(bytes.buffer).setUint32(16, 100_000);
	new DataView(bytes.buffer).setUint32(20, 100_000);
	return bytes;
}
const dirs: string[] = [];
afterEach(async () => {
	decoded.length = 0;
	for (const dir of dirs.splice(0)) await rm(dir, { recursive: true, force: true });
});
describe('security review R2–R4, P2: an image bomb is refused before main decodes it', () => {
	it('from a device (`attachment:upload`) and from a local file', async () => {
		const data = await mkdtemp(join(tmpdir(), 'brigadir-bomb-'));
		dirs.push(data);
		const owner = { projectId: 'project', id: 'draft', draft: true as const };
		await expect(uploadAttachment(owner, 'bomb.png', bomb(), true, data)).rejects.toThrow(
			/too large: 100000 × 100000/
		);
		const file = join(data, 'bomb.png');
		await writeFile(file, bomb());
		await expect(attachPaths(owner, [file], data)).rejects.toThrow(/too large/);
		expect(decoded).toEqual([]);
	});
});
