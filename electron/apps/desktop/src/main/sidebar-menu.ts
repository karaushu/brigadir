import type { TaskLabels } from './task-labels';
import type { Preparations } from './preparations';
import type { Boards } from './boards';
import { boardColumn, boardMove, type BoardColumn } from '@brigadir/core';
import { app, shell } from 'electron';
import { SessionStore, safePath, readWorkspace } from '@brigadir/persistence';
import {
	selectLocale,
	t,
	taskCount,
	fileCount,
	taskDescendants,
	taskMenuIcons,
	commandMenuIcons,
	projectMenuIcons,
	commandAccelerator,
	defaultKeymap,
	menuCommands,
	type KeymapSettings,
	type AgentTask,
	type TaskKey,
	type MessageKey,
	type Locale,
	type MenuIcon,
} from '@brigadir/core';
import type { ClientUi } from './client-ui';
import type { Client } from './clients';
import type { Sessions } from './sessions';
import type { Files } from './files';
import type { Browsers } from './browser';
import type { LaunchQueue } from './launch-queue';
import type { TaskArchives } from './task-archive';
const name = (key: TaskKey) => `${key.projectId}/${key.id}`;
export class SidebarMenus {
	labels?: TaskLabels;
	boards?: Boards;
	preparations?: Preparations;
	archives?: TaskArchives;
	/** spec/notifications-slack-notes-and-schedules#schedules: whether the schedules module is on — the task menu then offers `Repeat…`. */
	schedules: () => boolean = () => false;
	/** The applied keymap: an item shows the key the menu bar has for its command on this platform. */
	keymap: () => KeymapSettings = () => defaultKeymap;
	private removing = new Set<string>();
	constructor(
		readonly dataDir: string | undefined,
		readonly ui: ClientUi,
		readonly sessions: Sessions,
		readonly files: Files,
		readonly browsers: Browsers,
		readonly launches: LaunchQueue,
		readonly settle: () => Promise<unknown>,
		readonly locale: () => Locale = () => selectLocale(app.getLocale())
	) {}
	busy(target: unknown) {
		if (typeof target === 'string') return this.removing.has(target);
		if (target && typeof target === 'object' && 'projectId' in target && 'id' in target) {
			const key = target as TaskKey;
			return this.removing.has(key.projectId) || this.removing.has(name(key));
		}
		return false;
	}
	/**
	 * `icons`: the menu's glyph per item id (spec/search-menus-and-commands#menu-glyphs). `accelerator` only shows the menu-bar shortcut beside the item
	 * (spec/tasks#archive: «Archive ⌃⌘A»), read from the keymap; the menu bar owns the key. `copy` and `reveal` finish where the menu shows (spec/remote-access-and-mobile#client-ui-seam):
	 * the clipboard of the machine the person sits at, the file manager only on this machine.
	 */
	private shortcut(id: string): { accelerator?: string } {
		const command = menuCommands.find((item) => item.id === id),
			key = command && commandAccelerator(command, this.keymap());
		return key ? { accelerator: key } : {};
	}
	private choose(
		client: Client,
		items: ({
			id: string;
			label: MessageKey;
			enabled?: boolean;
			accelerator?: string;
			copy?: string;
			reveal?: string;
		} | null)[],
		icons: Readonly<Record<string, MenuIcon>>
	) {
		const locale = this.locale();
		return this.ui.menu(
			client,
			items.map((item) =>
				item
					? {
							id: item.id,
							label: t(locale, item.label),
							...(icons[item.id] ? { icon: icons[item.id] } : {}),
							enabled: item.enabled ?? true,
							...(item.accelerator ? { accelerator: item.accelerator } : {}),
							...(item.copy !== undefined ? { copy: item.copy } : {}),
							...(item.reveal !== undefined ? { reveal: item.reveal } : {}),
						}
					: null
			)
		);
	}
	async task(
		key: TaskKey,
		client: Client
	): Promise<
		| 'open'
		| 'edit'
		| 'rename'
		| 'relay'
		| 'duplicate'
		| 'repeat'
		| 'diff'
		| 'deleted'
		| 'archived'
		| 'restored'
		| null
	> {
		const store = await SessionStore.at(this.dataDir),
			stored = await store.task(key);
		if (stored.archived) return this.archivedTask(key, stored, client);
		const task = this.labels ? await this.labels.task(stored) : stored,
			session = await this.sessions.activity(key),
			connected = session.connected;
		// spec/tasks#archive: Archive is there for every task, inactive while an agent works in it or its crew.
		const archivable = this.archives ? await this.archives.can(key) : false;
		const moves: ({ id: string; label: MessageKey; enabled?: boolean } | null)[] = this.boards
			? (['backlog', 'progress', 'completed'] as BoardColumn[])
					.filter((column) => boardMove(boardColumn(task.status), column))
					.map((column) => ({
						id: `move:${column}`,
						label:
							column === 'backlog'
								? 'Add to backlog'
								: column === 'completed'
									? 'Mark completed'
									: task.status === 'backlog'
										? 'Start task'
										: 'Move to in progress',
					}))
			: [];
		const canContinue =
			Boolean(task.provider) &&
			!connected &&
			!this.launches.isQueued(key) &&
			!['preparing', 'backlog', 'rate-limited'].includes(task.status);
		const action = await this.choose(
			client,
			[
				{ id: 'open', label: 'Open task' },
				null,
				...(canContinue
					? [
							{
								id: 'resume',
								label: session.started
									? ('Continue with a new agent' as const)
									: ('Start task' as const),
							},
						]
					: []),
				...(task.status !== 'backlog' && task.status !== 'preparing'
					? [{ id: 'relay', label: 'Continue in a new task' as const }]
					: []),
				null,
				{ id: 'duplicate', label: 'Duplicate task…' },
				...(this.schedules() ? [{ id: 'repeat', label: 'Repeat…' as const }] : []),
				{ id: 'diff', label: 'Show task diff' },
				null,
				...(task.status === 'backlog' && !task.hasStarted
					? [{ id: 'edit', label: 'Edit task…' as const }]
					: []),
				...moves,
				...(this.labels
					? [
							{ id: 'rename', label: 'Rename task…' as const },
							{ id: 'pin', label: task.pinned ? ('Unpin task' as const) : ('Pin task' as const) },
						]
					: []),
				{ id: 'copy', label: 'Copy task title', copy: task.title },
				...(connected ||
				['working', 'needs-you', 'preparing'].includes(task.status) ||
				this.launches.isQueued(key)
					? [{ id: 'stop', label: 'Stop' as const }]
					: []),
				null,
				...(this.archives
					? [
							{
								id: 'archive',
								label: 'Archive' as const,
								enabled: archivable,
								...this.shortcut('archive-task'),
							},
						]
					: []),
				{ id: 'delete', label: 'Delete task…' },
			],
			taskMenuIcons
		);
		if (action === 'archive') {
			await this.archives!.archive(key);
			return 'archived';
		}
		if (action === 'duplicate' || action === 'diff' || action === 'repeat') return action;
		if (action === 'rename') return 'rename';
		if (action === 'pin') await this.labels!.pin(key, !task.pinned);
		if (action === 'relay') return 'relay';
		if (action === 'edit') return 'edit';
		if (action?.startsWith('move:')) {
			await this.boards!.move(key, action.slice(5) as BoardColumn);
			return null;
		}
		if (action === 'open') return 'open';
		if (action === 'resume') {
			const current = await store.task(key);
			if (
				(await this.sessions.connected(key)) ||
				this.launches.isQueued(key) ||
				['preparing', 'backlog', 'rate-limited'].includes(current.status)
			)
				throw new Error('Task state changed');
			await this.launches.request(key);
			return 'open';
		}
		if (action === 'stop') {
			if (await this.preparations?.cancel(key)) return null;
			if (!(await this.launches.dequeue(key))) {
				if (connected && task.transport !== 'terminal')
					await this.sessions.command(key, { kind: 'pausePromptQueue' });
				await this.sessions.stopForRemoval(key);
				await store.setStatus(key, 'interrupted');
			}
		}
		if (action === 'delete') {
			const removed = await this.remove(client, key.projectId, key, true, false, false, archivable);
			if (removed === 'archive') {
				await this.archives!.archive(key);
				return 'archived';
			}
			if (removed) return 'deleted';
		}
		return null;
	}
	/** spec/tasks#archive: the menu of an archive row: open, restore, the diff, the title, delete. */
	private async archivedTask(
		key: TaskKey,
		task: AgentTask,
		client: Client
	): Promise<'open' | 'diff' | 'deleted' | 'restored' | null> {
		const action = await this.choose(
			client,
			[
				{ id: 'open', label: 'Open task' },
				{ id: 'restore', label: 'Restore from archive' },
				null,
				{ id: 'diff', label: 'Show task diff' },
				{ id: 'copy', label: 'Copy task title', copy: task.title },
				null,
				{ id: 'delete', label: 'Delete task…' },
			],
			taskMenuIcons
		);
		if (action === 'open' || action === 'diff') return action;
		if (action === 'restore') {
			await this.archives?.restore(key);
			return 'restored';
		}
		if (action === 'delete' && (await this.remove(client, key.projectId, key))) return 'deleted';
		return null;
	}
	/** spec/tasks#archive: the Archive window asked already in its own dialog, which named the uncommitted files too. */
	async deleteArchived(keys: readonly TaskKey[], client: Client): Promise<number> {
		let removed = 0;
		for (const key of keys) {
			const task = await (await SessionStore.at(this.dataDir)).task(key);
			if (!task.archived) continue;
			if (await this.remove(client, key.projectId, key, false, false, true)) removed++;
		}
		return removed;
	}
	/** spec/search-menus-and-commands#project-commands: the right-click menu of a command row; the set stays the same, what does not apply is disabled. */
	async command(
		state: {
			running: boolean;
			shown: boolean;
			port: boolean;
		},
		client: Client
	): Promise<
		'run' | 'stop' | 'restart' | 'show' | 'open' | 'edit' | 'duplicate' | 'delete' | null
	> {
		return (await this.choose(
			client,
			[
				state.running ? { id: 'stop', label: 'Stop' } : { id: 'run', label: 'Run' },
				{ id: 'restart', label: 'Restart', enabled: state.running },
				{ id: 'show', label: 'Show in console', enabled: state.shown },
				{ id: 'open', label: 'Open in browser', enabled: state.port },
				null,
				{ id: 'edit', label: 'Edit…' },
				{ id: 'duplicate', label: 'Duplicate' },
				{ id: 'delete', label: 'Delete' },
			],
			commandMenuIcons
		)) as 'run' | 'stop' | 'restart' | 'show' | 'open' | 'edit' | 'duplicate' | 'delete' | null;
	}
	async project(
		id: string,
		client: Client
	): Promise<'new-task' | 'main-tree' | 'knowledge' | 'icon' | 'review-notes' | 'removed' | null> {
		const project = await (await SessionStore.at(this.dataDir)).project(id);
		const action = await this.choose(
			client,
			[
				{ id: 'new-task', label: 'New task' },
				// spec/task-window#repo-line: the main tree's way in; the sidebar has no Repos block.
				{ id: 'main-tree', label: 'Open main tree' },
				{ id: 'knowledge', label: 'Project knowledge…' },
				// spec/sidebar#project-groups: the picker from the menu too, not only from the icon.
				{ id: 'icon', label: 'Project icon…' },
				// spec/pull-requests-and-ci#review-notes
				{ id: 'review-notes', label: 'Review notes…' },
				{ id: 'finder', label: 'Reveal in Finder', reveal: project.path },
				{ id: 'copy', label: 'Copy path', copy: project.path },
				null,
				{ id: 'remove', label: 'Remove project…' },
			],
			projectMenuIcons
		);
		if (
			action === 'new-task' ||
			action === 'main-tree' ||
			action === 'knowledge' ||
			action === 'icon' ||
			action === 'review-notes'
		)
			return action;
		if (action === 'remove' && (await this.remove(client, id))) return 'removed';
		return null;
	}
	/** Card trash (spec/projects-and-board#board): one visible task, no question, the same removal as the sidebar. */
	removeTask(key: TaskKey, client: Client) {
		return this.remove(
			client,
			key.projectId,
			{ projectId: key.projectId, id: key.id },
			false,
			true
		);
	}
	/** Header trash: one dialog names the count and the consequence, then removes every listed task. */
	async clearCompleted(tasks: TaskKey[], client: Client): Promise<number> {
		if (!tasks.length) return 0;
		const locale = this.locale();
		const all = (await readWorkspace(this.dataDir ? { dataDir: this.dataDir } : {})).tasks,
			workers = tasks.flatMap((task) => taskDescendants(task, all));
		const { uncommitted } = await this.worktreeLoss([...tasks, ...workers]);
		const answer = await this.ui.ask(client, {
			type: 'warning',
			message: `${t(locale, 'Clear the list…')} ${taskCount(locale, tasks.length)}`,
			detail: [
				t(locale, 'Their worktrees and diff snapshots are removed with them.'),
				...(workers.length
					? [t(locale, 'Crew workers are deleted too: {n}.').replace('{n}', String(workers.length))]
					: []),
				...(uncommitted
					? [
							t(locale, 'Uncommitted changes in worktrees will be lost: {files}.').replace(
								'{files}',
								fileCount(locale, uncommitted)
							),
						]
					: []),
				t(
					locale,
					'Local history will move to Trash. Repository files will stay in place. Running agents and terminals will stop.'
				),
			].join('\n'),
			buttons: [t(locale, 'Cancel'), t(locale, 'Clear the list')],
			defaultId: 0,
			cancelId: 0,
			danger: 1,
		});
		if (answer !== 1) return 0;
		let removed = 0;
		for (const task of tasks) {
			if ((await (await SessionStore.at(this.dataDir)).task(task)).status !== 'completed') continue;
			if (
				await this.remove(
					client,
					task.projectId,
					{ projectId: task.projectId, id: task.id },
					false,
					true,
					true
				)
			)
				removed++;
		}
		return removed;
	}
	/** Header archive button of the Completed column: one dialog, then every task that can go to the archive does; nothing is deleted. */
	async archiveCompleted(tasks: TaskKey[], client: Client): Promise<number> {
		if (!this.archives || !tasks.length) return 0;
		const locale = this.locale(),
			ready: TaskKey[] = [];
		for (const task of tasks)
			if (await this.archives.can(task)) ready.push({ projectId: task.projectId, id: task.id });
		if (!ready.length) return 0;
		const answer = await this.ui.ask(client, {
			type: 'question',
			message: `${t(locale, 'Archive the list…')} ${taskCount(locale, ready.length)}`,
			detail: t(locale, 'Archive hides the tasks and deletes nothing.'),
			buttons: [t(locale, 'Cancel'), t(locale, 'Archive')],
			defaultId: 1,
			cancelId: 0,
			danger: null,
		});
		if (answer !== 1) return 0;
		let archived = 0;
		for (const task of ready) {
			try {
				await this.archives.archive(task);
				archived++;
			} catch {}
		}
		return archived;
	}
	/** spec/tasks#delete-task: whether any of these tasks has a worktree, and how many uncommitted files removing them loses. */
	private async worktreeLoss(tasks: readonly TaskKey[]) {
		let worktree = false,
			uncommitted = 0;
		for (const task of tasks) {
			const count = await this.preparations?.uncommitted(task).catch(() => null);
			if (count === null || count === undefined) continue;
			worktree = true;
			uncommitted += count;
		}
		return { worktree, uncommitted };
	}
	/** `asked`: the caller's own dialog already named the uncommitted worktree changes (Clear the list). */
	/** `offerArchive` (spec/tasks#archive): the sheet adds Archive as its default button; choosing it returns 'archive' and removes nothing. */
	private async remove(
		client: Client,
		projectId: string,
		key?: TaskKey,
		confirm = true,
		completedOnly = false,
		asked = false,
		offerArchive = false
	): Promise<boolean | 'archive'> {
		if (this.busy(key ?? projectId)) throw new Error('Removal is in progress');
		// A project lock also covers new tasks and all of its existing task commands.
		const lock = projectId;
		let locked = false;
		try {
			const store = await SessionStore.at(this.dataDir),
				project = await store.project(projectId),
				task = key ? await store.task(key) : null;
			const workspace = await readWorkspace({
				...(this.dataDir ? { dataDir: this.dataDir } : {}),
				includeMainTrees: true,
			});
			if (workspace.issues.some((issue) => issue.path.includes(projectId)))
				throw new Error('Project data could not be read');
			// spec/tasks#delete-task: a task takes its crew workers and every task under it along.
			const withDescendants = (all: readonly AgentTask[]) =>
				key
					? [
							...all.filter((item) => item.projectId === key.projectId && item.id === key.id),
							...taskDescendants(key, all),
						]
					: all.filter((item) => item.projectId === projectId);
			let tasks = withDescendants(workspace.tasks);
			if (key && !tasks.some((item) => item.id === key.id))
				tasks = [await store.task(key), ...tasks];
			const locale = this.locale();
			const dirty = tasks.flatMap((task) => this.files.taskUnsavedPaths(task)),
				workers = key ? tasks.length - 1 : 0,
				loss = await this.worktreeLoss(tasks);
			const answer =
				confirm || dirty.length > 0 || (!asked && loss.uncommitted > 0)
					? await this.ui.ask(client, {
							type: 'warning',
							message: `${t(locale, key ? 'Delete task…' : 'Remove project…')} ${task?.title ?? project.name}`,
							detail: [
								...(loss.worktree
									? [t(locale, 'Task worktrees will be removed; branches stay.')]
									: []),
								...(workers
									? [
											t(locale, 'Crew workers are deleted too: {n}.').replace(
												'{n}',
												String(workers)
											),
										]
									: []),
								...(loss.uncommitted
									? [
											t(locale, 'Uncommitted changes in worktrees will be lost: {files}.').replace(
												'{files}',
												fileCount(locale, loss.uncommitted)
											),
										]
									: []),
								t(
									locale,
									'Local history will move to Trash. Repository files will stay in place. Running agents and terminals will stop.'
								),
								...(dirty.length ? [t(locale, 'There are unsaved changes.'), ...dirty] : []),
								...(offerArchive ? [t(locale, 'Archive hides the task and deletes nothing.')] : []),
							].join('\n'),
							// spec/tasks#archive: Archive first and default (↩), Delete in the middle at index 1 as before, Cancel last.
							buttons: offerArchive
								? [t(locale, 'Archive'), t(locale, 'Delete task'), t(locale, 'Cancel')]
								: [t(locale, 'Cancel'), t(locale, key ? 'Delete task' : 'Remove project')],
							defaultId: 0,
							cancelId: offerArchive ? 2 : 0,
							danger: 1,
						})
					: 1;
			if (offerArchive && answer === 0) return 'archive';
			if (answer !== 1) return false;
			if (this.removing.has(lock)) throw new Error('Removal is in progress');
			this.removing.add(lock);
			locked = true;
			if (tasks.some((task) => this.boards?.isChanging(task)))
				throw new Error('A task is changing');
			if (completedOnly && key && (await store.task(key)).status !== 'completed') return false;
			{
				const latest = await readWorkspace({
					...(this.dataDir ? { dataDir: this.dataDir } : {}),
					includeMainTrees: true,
				});
				if (latest.issues.some((issue) => issue.path.includes(projectId)))
					throw new Error('Project data could not be read');
				const current = withDescendants(latest.tasks);
				tasks =
					key && !current.some((item) => item.id === key.id)
						? [await store.task(key), ...current]
						: current;
			}
			if (
				tasks
					.flatMap((task) => this.files.taskUnsavedPaths(task))
					.some((path) => !dirty.includes(path))
			)
				throw new Error('Unsaved files changed during confirmation');
			await this.settle();
			for (const task of tasks) {
				await this.preparations?.cancel(task);
				await this.launches.dequeue(task);
				await this.sessions.stopForRemoval(task);
			}
			for (const task of tasks) {
				await this.browsers.command(task, { kind: 'discard' });
				await this.preparations?.remove(task);
			}
			await this.settle();
			if (key) for (const task of tasks) await shell.trashItem(await store.taskDir(task));
			else await shell.trashItem(await safePath(store.root, 'projects', projectId));
			for (const task of tasks) this.files.forgetTask(task);
			return true;
		} finally {
			if (locked) this.removing.delete(lock);
		}
	}
}
