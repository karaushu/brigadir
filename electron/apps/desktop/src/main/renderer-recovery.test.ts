import { expect, test, vi } from 'vitest';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { isRendererErrorReport } from '@brigadir/core';
import { RendererLog, RendererRestarts } from './renderer-recovery';
const report = {
	kind: 'boundary' as const,
	surface: 'console' as const,
	message: 'TypeError: x is undefined',
	stack: 'at TerminalPanel',
	componentStack: 'in TerminalPanel',
};
test('the bridge accepts only a bounded report with known fields', () => {
	expect(isRendererErrorReport(report)).toBe(true);
	expect(isRendererErrorReport({ ...report, surface: 'sidebar' })).toBe(false);
	expect(isRendererErrorReport({ ...report, extra: 'x' })).toBe(false);
	expect(isRendererErrorReport({ ...report, stack: 'x'.repeat(20001) })).toBe(false);
	expect(isRendererErrorReport([report])).toBe(false);
});
test('the renderer log appends sorted JSONL lines and trims past 512 KB', async () => {
	const root = await mkdtemp(join(tmpdir(), 'brigadir-renderer-log-'));
	const file = join(root, 'logs/renderer.jsonl');
	vi.spyOn(console, 'error').mockImplementation(() => {});
	try {
		const log = new RendererLog(
			async () => file,
			'abc123',
			() => new Date('2026-10-02T12:07:05Z')
		);
		log.report(report);
		log.processGone('failed', 5);
		await log.flushed();
		const lines = (await readFile(file, 'utf8'))
			.trim()
			.split('\n')
			.map((line) => JSON.parse(line));
		expect(lines[0]).toEqual({
			build: 'abc123',
			componentStack: 'in TerminalPanel',
			kind: 'boundary',
			message: 'TypeError: x is undefined',
			stack: 'at TerminalPanel',
			surface: 'console',
			time: '2026-10-02T12:07:05.000Z',
		});
		expect(Object.keys(lines[0])).toEqual(Object.keys(lines[0]).sort());
		expect(lines[1]).toMatchObject({ kind: 'process-gone', message: 'failed', exitCode: 5 });
		await writeFile(file, `${JSON.stringify({ filler: 'x'.repeat(3000) })}\n`.repeat(200));
		log.report(report);
		await log.flushed();
		const kept = (await readFile(file, 'utf8')).trim().split('\n');
		expect(kept).toHaveLength(200);
		expect(JSON.parse(kept.at(-1)!).kind).toBe('boundary');
	} finally {
		vi.restoreAllMocks();
		await rm(root, { recursive: true, force: true });
	}
});
test('a second lost renderer within a minute asks instead of reloading again', () => {
	let now = 0;
	const restarts = new RendererRestarts(() => now);
	expect(restarts.next()).toBe('reload');
	now = 30_000;
	expect(restarts.next()).toBe('ask');
	now = 200_000;
	expect(restarts.next()).toBe('reload');
});
