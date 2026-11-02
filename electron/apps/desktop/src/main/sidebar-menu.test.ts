import { afterEach, expect, it, vi } from 'vitest';
import { mkdtemp, mkdir, writeFile, rm, lstat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
const electron = vi.hoisted(() => ({
	dialogs: [] as { message: string; detail: string }[],
	response: 1,
}));
vi.mock('electron', () => ({
	app: { getLocale: () => 'en' },
	clipboard: { writeText: () => {} },
	Menu: {
		buildFromTemplate: (items: { label?: string; click?: () => void }[]) => ({
			popup: () => items.find((item) => item.label === 'Delete task…')?.click?.(),
		}),
	},
	dialog: {
		showMessageBox: async (_window: unknown, options: { message: string; detail: string }) => {
			electron.dialogs.push(options);
			return { response: electron.response };
		},
	},
	shell: {
		trashItem: async (path: string) => rm(path, { recursive: true, force: true }),
		showItemInFolder: () => {},
	},
}));
import { SessionStore } from '@brigadir/persistence';
import { Preparations } from './preparations';
import { LaunchSettingsStore } from './launch-settings';
import { SidebarMenus } from './sidebar-menu';
import { ClientUi } from './client-ui';
import type { Client } from './clients';
/** The local window: native menus and dialogs over it (the mocks above). */
const local: Client = {
	id: 'local',
	local: true,
	send: () => false,
	owns: () => false,
	window: () => ({}) as never,
};
const roots: string[] = [];
afterEach(async () => {
	electron.dialogs.length = 0;
	electron.response = 1;
	for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true });
});
async function setup() {
	const root = await mkdtemp(join(tmpdir(), 'brigadir-sidebar-menu-'));
	roots.push(root);
	const repo = join(root, 'repo');
	await mkdir(repo);
	const git = (...args: string[]) => promisify(execFile)('git', args, { cwd: repo });
	await git('init', '-b', 'main');
	await git('config', 'user.name', 'Fixture');
	await git('config', 'user.email', 'fixture@example.invalid');
	await writeFile(join(repo, 'file.txt'), 'original\n');
	await git('add', '.');
	await git('commit', '-m', 'Initial');
	const store = await SessionStore.at(join(root, 'data')),
		project = await store.addProject(repo),
		settings = new LaunchSettingsStore(store.root);
	const preparations = new Preparations(store.root, resolve('apps/desktop/out/services'), () => {});
	const isolated = async (title: string, branch: string) => {
		const task = await store.createTask(project.id, title, 'claude', 'gui', title, 'queued', {
			...(await settings.read(project.id)),
			isolation: 'worktree',
			branch,
			baseRef: 'main',
			setupCommand: '',
		});
		await preparations.prepare(task);
		await store.setStatus(task, 'completed');
		return task;
	};
	const menus = new SidebarMenus(
		store.root,
		new ClientUi(),
		{
			activity: async () => ({ connected: false, started: true }),
			stopForRemoval: async () => {},
			connected: async () => false,
		} as never,
		{ taskUnsavedPaths: () => [], forgetTask: () => {} } as never,
		{ command: async () => null } as never,
		{ dequeue: async () => false, isQueued: () => false } as never,
		async () => {},
		() => 'en'
	);
	menus.preparations = preparations;
	return { git, store, project, preparations, isolated, menus };
}
const exists = (path: string) =>
	lstat(path).then(
		() => true,
		() => false
	);
it('deletes a foreman with its workers and their worktrees, and names what is lost (spec/tasks#delete-task)', async () => {
	const { git, store, project, isolated, menus } = await setup();
	const lead = await isolated('Lead', 'brigadir/lead'),
		dev = await isolated('Dev', 'brigadir/lead-dev'),
		sub = await isolated('Sub', 'brigadir/lead-sub');
	await store.updateTask(dev, {
		crewTaskId: lead.id,
		crewNodeId: 'node-dev',
		parentTaskId: lead.id,
	});
	await store.updateTask(sub, {
		crewTaskId: lead.id,
		crewNodeId: 'node-sub',
		parentTaskId: dev.id,
	});
	const devTree = join(store.root, 'worktrees', project.id, dev.id);
	await writeFile(join(devTree, 'file.txt'), 'agent edit\n');
	await writeFile(join(devTree, 'new.txt'), 'new\n');
	electron.response = 0;
	expect(await menus.task(lead, local)).toBeNull();
	expect(electron.dialogs[0]!.detail).toContain('Task worktrees will be removed; branches stay.');
	expect(electron.dialogs[0]!.detail).toContain('Crew workers are deleted too: 2.');
	expect(electron.dialogs[0]!.detail).toContain(
		'Uncommitted changes in worktrees will be lost: 2 files.'
	);
	expect(await exists(devTree)).toBe(true);
	electron.response = 1;
	expect(await menus.task(lead, local)).toBe('deleted');
	for (const task of [lead, dev, sub]) {
		expect(await exists(await store.taskDir(task))).toBe(false);
		expect(await exists(join(store.root, 'worktrees', project.id, task.id))).toBe(false);
	}
	expect((await git('branch', '--list', 'brigadir/lead*')).stdout).toContain('brigadir/lead-dev');
}, 30000);
it('asks before the card trash loses uncommitted worktree changes, and stays silent when nothing is lost (spec/tasks#delete-task)', async () => {
	const { store, project, isolated, menus } = await setup();
	const clean = await isolated('Clean', 'brigadir/clean'),
		dirty = await isolated('Dirty', 'brigadir/dirty');
	expect(await menus.removeTask(clean, local)).toBe(true);
	expect(electron.dialogs).toHaveLength(0);
	await writeFile(join(store.root, 'worktrees', project.id, dirty.id, 'file.txt'), 'agent edit\n');
	electron.response = 0;
	expect(await menus.removeTask(dirty, local)).toBe(false);
	expect(electron.dialogs[0]!.detail).toContain(
		'Uncommitted changes in worktrees will be lost: 1 file.'
	);
	expect(await exists(await store.taskDir(dirty))).toBe(true);
}, 30000);
