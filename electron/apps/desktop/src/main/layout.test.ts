import { it, expect } from 'vitest';
import { mkdtemp, rm, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Layout } from './layout';
import { defaultSurfaceLayout } from '@brigadir/core';
it('serializes bounded geometry and preserves a newer schema', async () => {
	const root = await mkdtemp(join(tmpdir(), 'brigadir-layout-'));
	try {
		const layout = new Layout(root);
		expect(await layout.read()).toEqual(defaultSurfaceLayout);
		await Promise.all([
			layout.save({ ...defaultSurfaceLayout, changesWidth: 300 }),
			layout.save({ ...defaultSurfaceLayout, changesWidth: 400 }),
		]);
		expect((await layout.read()).changesWidth).toBe(400);
		expect(() => layout.save({ ...defaultSurfaceLayout, browserWidth: 100000 })).toThrow('Invalid');
		// spec/task-window#width-rules: the browser has no 1000 ceiling; the window bounds it when it is drawn.
		await layout.save({ ...defaultSurfaceLayout, browserWidth: 1600 });
		expect((await layout.read()).browserWidth).toBe(1600);
		const path = join(root, 'surface-layout.json');
		await writeFile(
			path,
			JSON.stringify({
				schemaVersion: 1,
				layout: { changesWidth: 300, browserWidth: 500, consoleHeight: 220 },
			})
		);
		expect(await layout.read()).toEqual({
			...defaultSurfaceLayout,
			changesWidth: 300,
			browserWidth: 500,
			consoleHeight: 220,
		});
		// spec/sidebar#section-rail: a file from before the rail opens Tasks; a section this build lacks (a newer module) does too.
		expect((await layout.read()).sidebarSection).toBe('tasks');
		await layout.save({ ...defaultSurfaceLayout, sidebarSection: 'prs' });
		expect((await layout.read()).sidebarSection).toBe('prs');
		await writeFile(
			path,
			JSON.stringify({
				schemaVersion: 1,
				layout: { ...defaultSurfaceLayout, sidebarSection: 'later' },
			})
		);
		expect((await layout.read()).sidebarSection).toBe('tasks');
		expect(() =>
			layout.save({ ...defaultSurfaceLayout, sidebarSection: 'later' as 'tasks' })
		).toThrow('Invalid');
		await writeFile(
			path,
			JSON.stringify({
				schemaVersion: 1,
				layout: { changesWidth: 300, browserWidth: 500, consoleHeight: 220 },
			})
		);
		// spec/sidebar#width: a file from before the sidebar handle reads the default width; the width is bounded like the others.
		expect((await layout.read()).sidebarWidth).toBe(280);
		await layout.save({ ...defaultSurfaceLayout, sidebarWidth: 360 });
		expect((await layout.read()).sidebarWidth).toBe(360);
		expect(() => layout.save({ ...defaultSurfaceLayout, sidebarWidth: 600 })).toThrow('Invalid');
		await layout.save({ ...defaultSurfaceLayout, chatWidth: 440 });
		expect(await layout.read()).toMatchObject({ chatWidth: 440 });
		// spec/task-window#width-rules: the chat has no 900 ceiling; the window is.
		await layout.save({ ...defaultSurfaceLayout, chatWidth: 1600 });
		expect(await layout.read()).toMatchObject({ chatWidth: 1600 });
		// spec/task-window-workspace#layout-switch: a file from the two / three columns setting reads without it.
		await writeFile(
			path,
			JSON.stringify({ schemaVersion: 1, layout: { ...defaultSurfaceLayout, columns: 3 } })
		);
		expect(await layout.read()).not.toHaveProperty('columns');
		// spec/git#commit-strip: the collapse toggles are booleans; a file without them reads the defaults (checked above).
		await layout.save({ ...defaultSurfaceLayout, composerCapsuleCompact: true });
		expect(await layout.read()).toMatchObject({ composerCapsuleCompact: true });
		// spec/composer#capsule-squeeze: the environment does not fold; an old file's `composerEnvironmentCollapsed` is read and dropped.
		await writeFile(
			path,
			JSON.stringify({
				schemaVersion: 1,
				layout: {
					...defaultSurfaceLayout,
					composerCapsuleCompact: undefined,
					composerEnvironmentCollapsed: true,
					// spec/git#commit-dialog: the commit strip does not fold; the old toggle is dropped too.
					commitCollapsed: true,
				},
			})
		);
		expect(await layout.read()).toEqual(defaultSurfaceLayout);
		expect(() =>
			layout.save({ ...defaultSurfaceLayout, composerCapsuleCompact: 'yes' as unknown as boolean })
		).toThrow('Invalid');
		const future = JSON.stringify({ schemaVersion: 99, layout: defaultSurfaceLayout });
		await writeFile(path, future);
		await expect(layout.save(defaultSurfaceLayout)).rejects.toThrow('unsupported_schema');
		expect(await readFile(path, 'utf8')).toBe(future);
	} finally {
		await rm(root, { recursive: true, force: true });
	}
});
it('keeps the window bounds beside the layout (spec/task-window-workspace#restore-window)', async () => {
	const root = await mkdtemp(join(tmpdir(), 'brigadir-layout-window-'));
	try {
		const layout = new Layout(root);
		expect(await layout.readWindow()).toBeNull();
		const bounds = { x: 40, y: 60, width: 1300, height: 820, maximized: false };
		await layout.saveWindow(bounds);
		expect(await layout.readWindow()).toEqual(bounds);
		// A layout save (a column dragged) keeps the window, a window save keeps the layout.
		await layout.save({ ...defaultSurfaceLayout, sidebarWidth: 360 });
		expect(await layout.readWindow()).toEqual(bounds);
		await layout.saveWindow({ ...bounds, maximized: true });
		expect((await layout.read()).sidebarWidth).toBe(360);
		expect((await layout.readWindow())?.maximized).toBe(true);
		expect(() => layout.saveWindow({ ...bounds, width: 0 })).toThrow('Invalid');
		const text = await readFile(join(root, 'surface-layout.json'), 'utf8');
		expect(JSON.parse(text).window).toEqual({ ...bounds, maximized: true });
	} finally {
		await rm(root, { recursive: true, force: true });
	}
});
