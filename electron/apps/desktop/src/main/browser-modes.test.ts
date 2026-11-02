import { describe, expect, it } from 'vitest';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { BrowserModes } from './browser-modes';

const exists = (path: string) =>
	readFile(path, 'utf8').then(
		() => true,
		() => false
	);

describe('BrowserModes (spec/task-window-workspace#restore-window)', () => {
	it('each tab has its own mode; a new tab starts Desktop; a closed tab forgets its mode', async () => {
		const root = await mkdtemp(join(tmpdir(), 'brigadir-modes-'));
		try {
			const modes = new BrowserModes(root);
			expect(modes.of('p/t#b1')).toBe(false);
			modes.set('p/t#b1', true);
			expect(modes.of('p/t#b1')).toBe(true);
			expect(modes.of('p/t#b2')).toBe(false);
			modes.forget('p/t#b1');
			expect(modes.of('p/t#b1')).toBe(false);
		} finally {
			await rm(root, { recursive: true, force: true });
		}
	});
	it('restored tabs come back in the mode surface.json kept; a tab this run knows keeps its own', async () => {
		const root = await mkdtemp(join(tmpdir(), 'brigadir-modes-'));
		try {
			const modes = new BrowserModes(root);
			modes.set('p/t#b2', false);
			await modes.restore([
				{ id: 'p/t#b1', mobile: true },
				{ id: 'p/t#b2', mobile: true },
				{ id: 'p/t#b3', mobile: false },
			]);
			expect([modes.of('p/t#b1'), modes.of('p/t#b2'), modes.of('p/t#b3')]).toEqual([
				true,
				false,
				false,
			]);
		} finally {
			await rm(root, { recursive: true, force: true });
		}
	});
	it('the old app-wide setting is read once as the mode of the tabs brought back, then leaves the disk', async () => {
		const root = await mkdtemp(join(tmpdir(), 'brigadir-modes-'));
		const path = join(root, 'browser-preferences.json');
		try {
			await writeFile(path, JSON.stringify({ schemaVersion: 1, mobile: true }));
			const modes = new BrowserModes(root);
			await modes.restore([
				{ id: 'p/t#b1', mobile: false },
				{ id: 'p/t#b2', mobile: true },
			]);
			expect([modes.of('p/t#b1'), modes.of('p/t#b2')]).toEqual([true, true]);
			await modes.settled();
			expect(await exists(path)).toBe(false);
			// A new tab is Desktop even in this run; a tab chosen Desktop again stays Desktop over a later restore.
			expect(modes.of('p/t#b9')).toBe(false);
			modes.set('p/t#b1', false);
			await modes.restore([{ id: 'p/t#b1', mobile: true }]);
			expect(modes.of('p/t#b1')).toBe(false);
			// The next run has no old file: the tabs take their own records.
			const next = new BrowserModes(root);
			await next.restore([
				{ id: 'p/t#b1', mobile: false },
				{ id: 'p/t#b2', mobile: true },
			]);
			expect([next.of('p/t#b1'), next.of('p/t#b2')]).toEqual([false, true]);
		} finally {
			await rm(root, { recursive: true, force: true });
		}
	});
	it('an old file of another schemaVersion is neither read nor touched', async () => {
		const root = await mkdtemp(join(tmpdir(), 'brigadir-modes-'));
		const path = join(root, 'browser-preferences.json'),
			future = JSON.stringify({ schemaVersion: 99, mobile: true });
		try {
			await writeFile(path, future);
			const modes = new BrowserModes(root);
			await modes.restore([{ id: 'p/t#b1', mobile: false }]);
			expect(modes.of('p/t#b1')).toBe(false);
			await modes.settled();
			expect(await readFile(path, 'utf8')).toBe(future);
		} finally {
			await rm(root, { recursive: true, force: true });
		}
	});
});
