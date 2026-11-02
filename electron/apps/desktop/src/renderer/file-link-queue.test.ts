import { expect, it, vi } from 'vitest';
import type { FilePathLink, FilePathText } from '@brigadir/core';
import { readFileLinksQueued } from './file-link-queue';
const task = { projectId: 'p', id: 't' };
it('sends link checks one at a time, so a long transcript never fills the main queue (spec/diff-and-review#scope-kinds)', async () => {
	let inFlight = 0,
		peak = 0;
	const sent: string[] = [];
	// Mirrors Files.links: more than 12 pending requests reject with 'File link queue is full'.
	const readFileLinks = vi.fn(
		async (_key: unknown, texts: FilePathText[]): Promise<FilePathLink[][]> => {
			if (inFlight >= 12) throw new Error('File link queue is full');
			inFlight++;
			peak = Math.max(peak, inFlight);
			sent.push(texts[0]!.text);
			try {
				await new Promise((resolve) => setTimeout(resolve, 1));
				if (texts[0]!.text === 'fail') throw new Error('Invalid');
				return texts.map(() => []);
			} finally {
				inFlight--;
			}
		}
	);
	(globalThis as any).window = { brigadir: { readFileLinks } };
	// 98 blocks mount in one commit, as in a real log; block 3 unmounts before its turn and block 5 fails.
	const texts = Array.from({ length: 98 }, (_, i) => (i === 5 ? 'fail' : `src/${i}.ts`));
	const results = await Promise.allSettled(
		texts.map((text, i) => readFileLinksQueued(task, [{ text, literal: false }], () => i !== 3))
	);
	expect(peak).toBe(1);
	expect(sent).toEqual(texts.filter((_, i) => i !== 3));
	expect(results[3]).toEqual({ status: 'fulfilled', value: null });
	expect(results[5]).toMatchObject({ status: 'rejected', reason: { message: 'Invalid' } });
	expect(
		results.filter((result) => result.status === 'fulfilled' && result.value !== null)
	).toHaveLength(96);
});
