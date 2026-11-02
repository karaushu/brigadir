import { parentPort } from 'node:worker_threads';
import { diffable, diffLines, lineHunks, reanchor, textLines, normalizeLine } from './index';
import type { Anchor } from '@brigadir/core';
type Request = {
	before: string;
	after: string;
	anchors?: Anchor[];
	oldBlob?: string | null;
	newBlob?: string | null;
	hunks?: boolean;
};
function compute({ before, after, anchors, oldBlob, newBlob, hunks }: Request) {
	// spec/editor#change-marks: the editor gutter asks for line runs only.
	if (hunks)
		return diffable(before) && diffable(after)
			? { hunks: lineHunks(before, after), tooLarge: false }
			: { hunks: [], tooLarge: true };
	if (anchors) {
		const oldLines = textLines(before).map(normalizeLine),
			newLines = textLines(after).map(normalizeLine);
		return anchors.map((a) =>
			reanchor(
				a,
				(a.side === 'old' ? oldBlob : newBlob) ?? null,
				a.side === 'old' ? before : after,
				a.side === 'old' ? oldLines : newLines
			)
		);
	}
	return diffable(before) && diffable(after)
		? { ...diffLines(before, after), tooLarge: false }
		: { lines: [], pairs: [], tooLarge: true };
}
// A keep-alive worker (main/worker.ts): one request at a time; an error answers the request instead of ending the worker.
parentPort!.on('message', (request: Request) => {
	try {
		parentPort!.postMessage({ value: compute(request) });
	} catch (error) {
		parentPort!.postMessage({ error: String(error) });
	}
});
