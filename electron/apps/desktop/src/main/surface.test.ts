import { describe, expect, it } from 'vitest';
import { mkdtemp, mkdir, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { SurfaceDraft, TaskSurface, TerminalInfo } from '@brigadir/core';
import { TaskSurfaces, draftName, type SurfaceSources } from './surface';

const key = { projectId: 'project', id: 'task' };
const fileId = 'f'.repeat(64);
async function fixture() {
	const root = await mkdtemp(join(tmpdir(), 'brigadir-surface-'));
	const dir = join(root, 'projects/project/tasks/task');
	await mkdir(dir, { recursive: true });
	await writeFile(
		join(root, 'projects/project/project.json'),
		JSON.stringify({ schemaVersion: 1, project: { id: 'project', name: 'repo', path: root } })
	);
	await writeFile(
		join(dir, 'task.json'),
		JSON.stringify({
			schemaVersion: 1,
			task: { ...key, title: 'Surface', status: 'done', provider: 'claude' },
		})
	);
	const restored: { tab: string; url: string; title: string; mobile: boolean }[] = [];
	let live: TerminalInfo[] | null = [
		{
			id: '11111111-2222-3333-4444-555555555555',
			role: 'console',
			title: 'zsh',
			cols: 80,
			rows: 24,
			exited: false,
			exitCode: null,
			directory: 'packages/app',
		},
	];
	let pageMobile = true;
	const sources: SurfaceSources = {
		filePath: (_key, id) => (id === fileId ? 'src/a.ts' : null),
		fileId: async (_key, path) => (path === 'src/a.ts' ? fileId : null),
		terminals: async () => live,
		browser: (_key, tab) =>
			tab === 'bpage1'
				? { url: 'http://127.0.0.1:5173/', title: 'Person page', mobile: pageMobile }
				: null,
		restoreBrowsers: (_key, tabs) => {
			restored.push(...tabs);
		},
		device: async () => 'iphone-17',
	};
	const surfaces = new TaskSurfaces(sources, root, () => {});
	return {
		root,
		dir,
		surfaces,
		restored,
		setLive: (value: TerminalInfo[] | null) => {
			live = value;
		},
		setPageMobile: (value: boolean) => {
			pageMobile = value;
		},
	};
}
const surface: TaskSurface = {
	groups: {
		root: {
			kind: 'split',
			id: 's3',
			direction: 'down',
			ratio: 0.6,
			first: {
				kind: 'group',
				id: 'g1',
				tabs: [
					{
						kind: 'file',
						id: fileId,
						path: 'src/a.ts',
						place: {
							anchor: { line: 3, column: 2 },
							head: { line: 3, column: 2 },
							scrollTop: 40,
							scrollLeft: 0,
						},
					},
					{ kind: 'diff', scope: 'root', path: 'src/b.ts', range: null },
					{ kind: 'file', id: 'e'.repeat(64), path: 'outside.ts' },
				],
				active: 1,
			},
			second: {
				kind: 'group',
				id: 'g2',
				tabs: [
					{
						kind: 'terminal',
						session: '11111111-2222-3333-4444-555555555555',
						title: 'zsh',
						directory: null,
					},
					{ kind: 'browser', tab: 'bpage1', title: '', url: '', mobile: false },
					{ kind: 'browser', tab: 'bpage2', title: 'Later', url: '', mobile: false },
					{ kind: 'simulator', title: 'Simulator', device: null },
				],
				active: 1,
			},
		},
		focused: 'g2',
		next: 4,
	},
	columns: { chat: true, work: true, panel: true },
	widths: { chat: 460, panel: 320, bottom: 260 },
	panel: { tab: 'changes', mode: 'history' },
	toolPlace: 'bottom',
	bottomUnderChat: false,
};

describe('TaskSurfaces (spec/task-window-workspace#restore-window)', () => {
	it('writes paths for ids and main’s own facts, pretty and sorted; reads ids back and waits the pages', async () => {
		const { root, dir, surfaces, restored } = await fixture();
		try {
			await surfaces.write(key, surface);
			const text = await readFile(join(dir, 'surface.json'), 'utf8');
			expect(text).toMatch(/^\{\n  "schemaVersion": 1,\n  "surface": \{\n    "bottomUnderChat"/);
			expect(text).not.toContain(fileId);
			const stored = JSON.parse(text).surface;
			const top = stored.groups.root.first,
				bottom = stored.groups.root.second;
			// The file the app cannot reopen by path left the group; the diff stays active.
			expect(top.tabs.map((tab: { path: string }) => tab.path)).toEqual(['src/a.ts', 'src/b.ts']);
			expect(top.active).toBe(1);
			expect(top.tabs[0].place.anchor).toEqual({ line: 3, column: 2 });
			expect(bottom.tabs[0].directory).toBe('packages/app');
			expect(bottom.tabs[1]).toMatchObject({
				url: 'http://127.0.0.1:5173/',
				title: 'Person page',
				mobile: true,
			});
			expect(bottom.tabs[3].device).toBe('iphone-17');
			const fresh = new TaskSurfaces(
				{
					filePath: () => null,
					fileId: async (_key, path) => (path === 'src/a.ts' ? fileId : null),
					terminals: async () => null,
					browser: () => null,
					restoreBrowsers: (_key, tabs) => {
						restored.push(...tabs);
					},
					device: async () => null,
				},
				root,
				() => {}
			);
			const read = await fresh.read(key);
			expect(read.drafts).toEqual([]);
			expect(read.surface?.groups.root.kind).toBe('split');
			const first =
				read.surface!.groups.root.kind === 'split' ? read.surface!.groups.root.first : null;
			expect(first?.kind === 'group' && first.tabs[0]).toMatchObject({
				kind: 'file',
				id: fileId,
				path: 'src/a.ts',
			});
			// The person's page waits for its tab; the page without an address waits for nothing.
			expect(restored).toEqual([
				{ tab: 'bpage1', url: 'http://127.0.0.1:5173/', title: 'Person page', mobile: true },
			]);
		} finally {
			await rm(root, { recursive: true, force: true });
		}
	});
	it('a page’s new Desktop / Mobile is written again over the last surface, with nothing else changed', async () => {
		const { root, dir, surfaces, setPageMobile } = await fixture();
		try {
			await surfaces.refresh(key);
			await expect(readFile(join(dir, 'surface.json'), 'utf8')).rejects.toThrow();
			await surfaces.write(key, { ...surface, toolPlace: 'focused' });
			setPageMobile(false);
			await surfaces.refresh(key);
			const stored = JSON.parse(await readFile(join(dir, 'surface.json'), 'utf8')).surface;
			expect(stored.groups.root.second.tabs[1]).toMatchObject({ tab: 'bpage1', mobile: false });
			expect(stored.toolPlace).toBe('focused');
			expect(stored.groups.root.first.tabs.map((tab: { path: string }) => tab.path)).toEqual([
				'src/a.ts',
				'src/b.ts',
			]);
		} finally {
			await rm(root, { recursive: true, force: true });
		}
	});
	it('without a live host a terminal keeps the folder it had', async () => {
		const { root, dir, surfaces, setLive } = await fixture();
		try {
			await surfaces.write(key, surface);
			setLive(null);
			await surfaces.write(key, { ...surface, toolPlace: 'focused' });
			const stored = JSON.parse(await readFile(join(dir, 'surface.json'), 'utf8')).surface;
			expect(stored.toolPlace).toBe('focused');
			expect(stored.groups.root.second.tabs[0].directory).toBe('packages/app');
			expect(stored.groups.root.second.tabs[1].url).toBe('http://127.0.0.1:5173/');
		} finally {
			await rm(root, { recursive: true, force: true });
		}
	});
	it('never writes over a surface.json of an unknown schema version', async () => {
		const { root, dir, surfaces } = await fixture();
		try {
			const newer = JSON.stringify({ schemaVersion: 2, surface: { tomorrow: true } });
			await writeFile(join(dir, 'surface.json'), newer);
			expect((await surfaces.read(key)).surface).toBeNull();
			await surfaces.write(key, surface);
			expect(await readFile(join(dir, 'surface.json'), 'utf8')).toBe(newer);
			// Written by a newer copy after this one read an older file: still not overwritten.
			const older = new TaskSurfaces(
				{
					filePath: () => null,
					fileId: async () => null,
					terminals: async () => null,
					browser: () => null,
					restoreBrowsers: () => {},
					device: async () => null,
				},
				root,
				() => {}
			);
			await rm(join(dir, 'surface.json'));
			await older.read(key);
			await writeFile(join(dir, 'surface.json'), newer);
			await older.write(key, surface);
			expect(await readFile(join(dir, 'surface.json'), 'utf8')).toBe(newer);
		} finally {
			await rm(root, { recursive: true, force: true });
		}
	});
	it('drafts of a hot exit: written by path, read once with ids, gone from the disk after', async () => {
		const { root, dir, surfaces } = await fixture();
		try {
			const draft: SurfaceDraft = {
				id: fileId,
				path: 'src/a.ts',
				version: '0'.repeat(64),
				state: { doc: 'unsaved\n', selection: { ranges: [{ anchor: 3, head: 3 }], main: 0 } },
				scrollTop: 12,
				scrollLeft: 0,
			};
			await surfaces.writeDrafts(key, [draft, { ...draft, id: 'e'.repeat(64) }]);
			const names = await readdir(join(dir, 'drafts'));
			expect(names).toEqual([draftName('src/a.ts')]);
			const text = await readFile(join(dir, 'drafts', names[0]!), 'utf8');
			expect(text).not.toContain(fileId);
			expect(JSON.parse(text)).toMatchObject({
				schemaVersion: 1,
				draft: { path: 'src/a.ts', state: { doc: 'unsaved\n' } },
			});
			const read = await surfaces.read(key);
			expect(read.drafts).toEqual([{ ...draft, id: fileId }]);
			expect(await readdir(join(dir, 'drafts'))).toEqual([]);
			// The next quit with nothing unsaved leaves the folder empty.
			await surfaces.writeDrafts(key, [draft]);
			await surfaces.writeDrafts(key, []);
			expect(await readdir(join(dir, 'drafts'))).toEqual([]);
		} finally {
			await rm(root, { recursive: true, force: true });
		}
	});
});
