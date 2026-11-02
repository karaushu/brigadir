import { test, expect } from 'vitest';
import { mkdtemp, mkdir, readFile, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { SessionStore } from '@brigadir/persistence';
import { SidebarState, isSidebarSelection } from './sidebar-state';
test('serial disclosure writes preserve other projects and reject unknown schemas', async () => {
	const root = await mkdtemp(join(tmpdir(), 'sidebar-state-'));
	try {
		const data = join(root, 'data'),
			repo = join(root, 'repo');
		await mkdir(repo);
		const store = await SessionStore.at(data),
			a = await store.addProject(repo),
			b = await store.addProject(repo),
			state = new SidebarState(data);
		await Promise.all([state.set(a.id, true), state.set(b.id, true), state.set(a.id, false)]);
		expect(await state.read()).toEqual([b.id]);
		const path = join(data, 'sidebar.json'),
			future = JSON.stringify({ schemaVersion: 99, collapsed: [] });
		await writeFile(path, future);
		await expect(state.set(a.id, true)).rejects.toThrow('unsupported_schema');
		expect(await readFile(path, 'utf8')).toBe(future);
	} finally {
		await rm(root, { recursive: true, force: true });
	}
});
test('the archive sections open per project and keep the collapsed projects (spec/tasks#archive)', async () => {
	const root = await mkdtemp(join(tmpdir(), 'sidebar-state-'));
	try {
		const data = join(root, 'data'),
			repo = join(root, 'repo');
		await mkdir(repo);
		const store = await SessionStore.at(data),
			a = await store.addProject(repo),
			state = new SidebarState(data);
		expect(await state.readArchive()).toEqual([]);
		await state.set(a.id, true);
		await state.setArchive(a.id, true);
		expect(await state.readArchive()).toEqual([a.id]);
		expect(await state.read()).toEqual([a.id]);
		await state.set(a.id, false);
		expect(await state.readArchive()).toEqual([a.id]);
		await state.setArchive(a.id, false);
		expect(JSON.parse(await readFile(join(data, 'sidebar.json'), 'utf8'))).toEqual({
			schemaVersion: 1,
			collapsed: [],
		});
	} finally {
		await rm(root, { recursive: true, force: true });
	}
});
test('a folded crew card persists per foreman task and keeps the other choices (spec/sidebar#crew-collapse)', async () => {
	const root = await mkdtemp(join(tmpdir(), 'sidebar-state-'));
	try {
		const data = join(root, 'data'),
			repo = join(root, 'repo');
		await mkdir(repo);
		const store = await SessionStore.at(data),
			a = await store.addProject(repo),
			state = new SidebarState(data);
		expect(await state.readCrews()).toEqual([]);
		await state.set(a.id, true);
		await Promise.all([state.setCrew('crew-b', true), state.setCrew('crew-a', true)]);
		expect(await state.readCrews()).toEqual(['crew-a', 'crew-b']);
		expect(await state.read()).toEqual([a.id]);
		expect(() => state.setCrew('../x', true)).toThrow('Invalid task');
		await state.setCrew('crew-a', false);
		await state.setCrew('crew-b', false);
		expect(JSON.parse(await readFile(join(data, 'sidebar.json'), 'utf8'))).toEqual({
			schemaVersion: 1,
			collapsed: [a.id],
		});
	} finally {
		await rm(root, { recursive: true, force: true });
	}
});
test('the project and task open last persist beside the other choices and are validated (spec/sidebar#open-last)', async () => {
	const root = await mkdtemp(join(tmpdir(), 'sidebar-state-'));
	try {
		const data = join(root, 'data'),
			repo = join(root, 'repo');
		await mkdir(repo);
		const store = await SessionStore.at(data),
			a = await store.addProject(repo),
			state = new SidebarState(data);
		expect(await state.readSelection()).toBeNull();
		await state.set(a.id, true);
		await state.select({ project: a.id, task: 'task-1' });
		expect(await state.readSelection()).toEqual({ project: a.id, task: 'task-1' });
		await state.setCrew('crew-a', true);
		expect(await state.readSelection()).toEqual({ project: a.id, task: 'task-1' });
		await state.select({ project: '*' });
		expect(JSON.parse(await readFile(join(data, 'sidebar.json'), 'utf8'))).toEqual({
			schemaVersion: 1,
			collapsed: [a.id],
			crewCollapsed: ['crew-a'],
			selected: { project: '*' },
		});
		for (const bad of [
			null,
			{},
			{ project: '../x' },
			{ project: '*', task: 't' },
			{ project: a.id, task: '../t' },
			{ project: a.id, extra: 1 },
		])
			expect(isSidebarSelection(bad)).toBe(false);
		expect(isSidebarSelection({ project: a.id, task: 't' })).toBe(true);
	} finally {
		await rm(root, { recursive: true, force: true });
	}
});
