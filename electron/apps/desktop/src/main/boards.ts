import { promptDisplayText } from '@brigadir/core';
import {
	agentOptionKind,
	boardColumn,
	boardMove,
	pickerMenuIcons,
	t,
	type AgentOption,
	type AgentTask,
	type BoardColumn,
	type Locale,
	type TaskKey,
	type TaskLaunch,
	type PromptAttachment,
} from '@brigadir/core';
import { readRelayHandoff, readWorkspace, SessionStore } from '@brigadir/persistence';
import type { Sessions } from './sessions';
import type { ClientUi } from './client-ui';
import type { Client } from './clients';
import type { LaunchQueue } from './launch-queue';
export type BacklogSheet = {
	name?: string | null;
	options?: Pick<AgentTask, 'agentOptions' | 'launchOptions' | 'modelName' | 'effortName'>;
	attachments?: PromptAttachment[];
};
const delay = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
/** spec/projects-and-board#board: every drop is a task action, without navigation or eager journal reads. */
export class Boards {
	preparations?: import('./preparations').Preparations;
	/** spec/notifications-slack-notes-and-schedules#slack: a task moved to Completed — Slack's «Task completed». */
	onCompleted?: (key: TaskKey) => void;
	private pending = new Set<string>();
	constructor(
		private dataDir: string | undefined,
		private sessions: Sessions,
		private launches: LaunchQueue,
		private ui: ClientUi,
		private locale: () => Locale,
		private changed: (key: TaskKey) => void
	) {}
	isChanging(key: TaskKey) {
		return this.pending.has(`${key.projectId}/${key.id}`);
	}
	private async exclusive<T>(key: TaskKey, action: () => Promise<T>) {
		const id = `${key.projectId}/${key.id}`;
		if (this.pending.has(id)) throw new Error('Task is changing');
		this.pending.add(id);
		try {
			return await action();
		} finally {
			this.pending.delete(id);
			this.changed(key);
		}
	}
	move(input: TaskKey, column: BoardColumn) {
		const key = { projectId: input.projectId, id: input.id };
		return this.exclusive(key, async () => {
			const store = await SessionStore.at(this.dataDir),
				task = await store.task(key);
			const move = boardMove(boardColumn(task.status), column);
			if (!move) throw new Error('This move is not allowed');
			if (move === 'start') {
				await this.launches.request(key);
				return;
			}
			if (move === 'await-input') {
				await store.setStatus(key, 'done');
				return;
			}
			await this.stop(key);
			// Backlog releases the old agent, retaining its journal and baseline for resume.
			await this.sessions.stopForRemoval(key);
			await store.setStatus(key, move === 'stop-complete' ? 'completed' : 'backlog');
			if (move === 'stop-complete') this.onCompleted?.(key);
		});
	}
	/** spec/tasks#backlog-edit: the sheet rewrites a backlog task the agent has not seen yet. `sheet.name` null — the title follows the text
	 * again; `options` — the sheet's model choice; `attachments` — the task's own list, already checked on disk. */
	edit(
		key: TaskKey,
		text: string,
		provider: 'claude' | 'codex',
		transport: 'gui' | 'terminal',
		launch?: TaskLaunch,
		sheet: BacklogSheet = {}
	) {
		return this.exclusive(key, async () => {
			const store = await SessionStore.at(this.dataDir),
				task = await store.task(key);
			if (task.status !== 'backlog') throw new Error('Task is no longer in backlog');
			const journal = await store.journal(key);
			if (journal.issue) throw new Error(journal.issue);
			if (journal.records.some((record) => record.event.kind === 'turn.started'))
				throw new Error('A prompt already sent to an agent cannot be edited');
			if (task.preparation && launch && JSON.stringify(task.launch) !== JSON.stringify(launch))
				throw new Error(
					'Launch settings cannot change after workspace preparation. Create a new task.'
				);
			// spec/tasks#backlog-edit: with a relay's handoff the first prompt carries at most 10 attachments together.
			if (sheet.attachments?.length && task.continuesTaskId) {
				const handoff = await readRelayHandoff(store, key);
				if (sheet.attachments.length + (handoff ? handoff.attachmentIds.length : 2) > 10)
					throw new Error('Too many attachments');
			}
			const named = sheet.name?.trim(),
				title = named
					? named.slice(0, 80)
					: promptDisplayText(text).trim().slice(0, 80) || t(this.locale(), 'New task');
			const reset =
				task.provider !== provider || task.transport !== transport
					? { modelName: '', effortName: '', agentOptions: [], launchOptions: [] }
					: {};
			return store.updateTask(key, {
				prompt: text,
				title,
				provider,
				transport,
				...(launch ? { launch } : {}),
				...(sheet.options ? { modelName: '', effortName: '', ...sheet.options } : reset),
				...(sheet.attachments ? { attachments: sheet.attachments } : {}),
			});
		});
	}
	private async stop(key: TaskKey) {
		await this.preparations?.cancel(key);
		if (await this.launches.dequeue(key)) return;
		// The small host status answers "connected, still in a turn"; the journal never crosses the socket here.
		const activity = await this.sessions.activity(key);
		if (!activity.connected) return;
		const task = await (await SessionStore.at(this.dataDir)).task(key);
		if (task.transport !== 'terminal')
			await this.sessions.command(key, { kind: 'pausePromptQueue' });
		if (!activity.busy) return;
		await this.sessions.command(key, { kind: 'cancel' });
		const until = Date.now() + 15000;
		while (Date.now() < until) {
			if (!(await this.sessions.activity(key)).busy) {
				if (task.transport !== 'terminal')
					await this.sessions.command(key, { kind: 'pausePromptQueue' });
				return;
			}
			await delay(100);
		}
		throw new Error('The agent did not stop');
	}
	async optionMenu(
		input: TaskKey,
		kind: 'model' | 'effort',
		client: Client
	): Promise<string | null> {
		const key = { projectId: input.projectId, id: input.id },
			store = await SessionStore.at(this.dataDir),
			task = await store.task(key);
		if (task.transport === 'terminal') return null;
		let options: AgentOption[] = task.agentOptions ?? [];
		if (!options.length && task.status === 'backlog') {
			const tasks = (await readWorkspace(this.dataDir ? { dataDir: this.dataDir } : {})).tasks;
			options =
				tasks
					.filter(
						(item) =>
							item.provider === task.provider &&
							item.transport !== 'terminal' &&
							item.agentOptions?.length
					)
					.sort((a, b) => (b.updatedAt ?? '').localeCompare(a.updatedAt ?? ''))[0]?.agentOptions ??
				[];
		}
		const option = options.find((item) => agentOptionKind(item) === kind);
		if (!option || option.kind !== 'select' || !option.choices.length) return null;
		const current =
			task.launchOptions?.find((item) => item.id === option.id)?.value ?? option.value;
		const chosen = await this.ui.menu(client, [
			{
				id: ':header',
				label: t(this.locale(), kind === 'model' ? 'Model' : 'Effort'),
				icon: pickerMenuIcons[kind],
				enabled: false,
			},
			null,
			...option.choices.map((choice, index) => ({
				id: `choice:${index}`,
				label: choice.name,
				checked: choice.value === current,
			})),
		]);
		const value = chosen?.startsWith('choice:')
			? (option.choices[Number(chosen.slice(7))]?.value ?? null)
			: null;
		if (value === null) return null;
		await this.exclusive(key, async () => {
			const current = await store.task(key);
			if (current.status !== task.status) throw new Error('Task state changed');
			if (current.status === 'backlog' || !(await this.sessions.connected(key))) {
				const updated = options.map((item) =>
					item.id === option.id ? { ...option, value } : item
				);
				await store.updateTask(key, {
					agentOptions: updated,
					launchOptions: [
						...(current.launchOptions ?? []).filter((item) => item.id !== option.id),
						{ id: option.id, value },
					],
					...(kind === 'model'
						? { modelName: option.choices.find((item) => item.value === value)!.name }
						: { effortName: option.choices.find((item) => item.value === value)!.name }),
				});
			} else {
				await this.sessions.command(key, { kind: 'setOption', id: option.id, value });
			}
		});
		return value;
	}
}
