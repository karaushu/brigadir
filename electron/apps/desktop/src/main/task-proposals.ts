import {
	outsideProject,
	pendingInputs,
	scopeSelected,
	withAutoBranch,
	type ScopeChoice,
	taskSummaryPrefix,
	taskSummaryText,
	type AgentTask,
	type AttachmentOwner,
	type PromptAttachment,
	type SessionCommand,
	type TaskKey,
	type TaskLaunch,
	type TaskProposal,
	type TaskProposalDraft,
	type ScheduleDraft,
} from '@brigadir/core';
import { readRelayDiff } from '@brigadir/git';
import { Attachments, SessionStore } from '@brigadir/persistence';
import { randomUUID } from 'node:crypto';
import type { Changes } from './changes';
import type { LaunchSettingsStore } from './launch-settings';
import { attachPaths } from './pick-attachments';

type Deps = {
	dataDir?: string;
	settings: LaunchSettingsStore;
	changes: Pick<Changes, 'range'>;
	command(key: TaskKey, command: SessionCommand): Promise<unknown>;
	start(key: TaskKey): Promise<unknown>;
	emptyTitle(): string;
	/** spec/notifications-slack-notes-and-schedules#schedules: a proposed schedule becomes a schedule of the project. */ schedule?(
		projectId: string,
		draft: ScheduleDraft
	): Promise<{ id: string; name: string }>;
};

/** spec/tasks#agent-created-tasks: the agent the proposal names, as main resolved it; else the source's (spec/tasks#agent-created-tasks). */
function agentOf(source: AgentTask, proposal: TaskProposal) {
	if (proposal.agent)
		return {
			provider: proposal.agent.provider,
			options: proposal.agent.options,
			modelName: proposal.agent.modelName,
			effortName: proposal.agent.effortName,
		};
	return {
		provider: source.provider ?? 'claude',
		options:
			source.agentOptions?.map((option) => ({ id: option.id, value: option.value })) ??
			source.launchOptions,
		modelName: source.modelName,
		effortName: source.effortName,
	};
}

/**
 * spec/tasks#agent-created-tasks: the task an agent proposed with `create_task`. The host keeps the call waiting on its card; main creates the task
 * in the same project (the relay's launch rule, spec/tasks#relay, plus the proposed folders of spec/projects-and-board#external-folders) and answers the host with it.
 */
export class TaskProposals {
	private creations = new Map<string, Promise<AgentTask>>();
	constructor(private deps: Deps) {}
	/** The scheduler starts after the proposals; it hands its create here once it exists. */
	scheduleWith(schedule: NonNullable<Deps['schedule']>) {
		this.deps = { ...this.deps, schedule };
	}
	private async pending(key: TaskKey, id: string) {
		const store = await SessionStore.at(this.deps.dataDir),
			source = await store.task(key),
			journal = await store.journal(key);
		const proposal = pendingInputs(journal.records).proposals.find((item) => item.id === id);
		if (!proposal) throw new Error('The task proposal is already resolved');
		return { store, source, proposal };
	}
	/** The source's launch with a new branch: its repos, its chosen folders from outside and the proposed ones (spec/projects-and-board#external-folders). */
	private async launch(source: AgentTask, proposal: TaskProposal): Promise<TaskLaunch> {
		const defaults = await this.deps.settings.read(source.projectId),
			inherited = source.launch;
		const scopes: ScopeChoice[] = defaults.scopes.map((scope) => ({
			...scope,
			...inherited?.scopes.find((choice) => choice.id === scope.id || choice.name === scope.name),
			id: scope.id,
		}));
		for (const choice of inherited?.scopes ?? [])
			if (
				outsideProject(choice) &&
				scopeSelected(choice) &&
				!scopes.some((scope) => scope.id === choice.id)
			)
				scopes.push(choice);
		for (const path of proposal.folders) {
			const folder = await this.deps.settings.describeFolder(source.projectId, path, scopes),
				known = scopes.find((scope) => scope.id === folder.id);
			if (known) known.selected = true;
			else scopes.push(folder);
		}
		return this.deps.settings.resolve(source.projectId, {
			...defaults,
			...inherited,
			branch: '',
			scopes,
		});
	}
	/** The context as attachments of `owner`: a summary and a diff like the relay's, files by reference (spec/composer#paste), notes as text. */
	private async context(
		store: SessionStore,
		owner: AttachmentOwner,
		source: AgentTask,
		proposal: TaskProposal
	): Promise<PromptAttachment[]> {
		const assets = new Attachments(store),
			result: PromptAttachment[] = [],
			files = proposal.context.flatMap((item) => (item.kind === 'file' ? [item.path] : []));
		const needsDiff = proposal.context.some(
				(item) => item.kind === 'summary' || item.kind === 'diff'
			),
			diff = needsDiff ? await readRelayDiff(store, source, this.deps.changes.range(source)) : null;
		for (const item of proposal.context) {
			if (item.kind === 'summary') {
				const journal = await store.journal(source);
				result.push(
					await assets.create(owner, {
						kind: 'text',
						name: `${taskSummaryPrefix}${source.title}`.slice(0, 200),
						text: taskSummaryText(source, journal.records, diff!.stat).slice(0, 256 * 1024),
					})
				);
			}
			if (item.kind === 'diff')
				result.push(
					await assets.create(owner, {
						kind: 'text',
						name: `Diff · ${source.title}`.slice(0, 200),
						text: `Changes of the task «${source.title}» (snapshot):\n${diff!.stat}${item.full ? `\n${diff!.patch}` : ''}`.slice(
							0,
							256 * 1024
						),
					})
				);
			if (item.kind === 'text')
				result.push(await assets.create(owner, { kind: 'text', name: item.name, text: item.text }));
		}
		if (files.length) result.push(...(await attachPaths(owner, files, this.deps.dataDir)));
		return result;
	}
	/** `Створити`: one creation per proposal, however many clicks. */
	create(key: TaskKey, id: string) {
		const name = `${key.projectId}/${key.id}/${id}`,
			existing = this.creations.get(name);
		if (existing) return existing;
		const work = this.createNow(key, id);
		this.creations.set(name, work);
		void work.finally(() => this.creations.delete(name)).catch(() => {});
		return work;
	}
	private async createNow(key: TaskKey, id: string) {
		const { store, source, proposal } = await this.pending(key, id);
		if (proposal.start === 'schedule' && proposal.schedule && this.deps.schedule) {
			// spec/notifications-slack-notes-and-schedules#schedules: the card's «Schedule» — a schedule from the prompt; its runs inherit this task's agent and repos.
			const { provider, options } = agentOf(source, proposal),
				launch = await this.launch(source, proposal);
			const schedule = await this.deps.schedule(source.projectId, {
				name:
					(proposal.title ?? proposal.prompt.split('\n')[0] ?? '').trim().slice(0, 120) ||
					this.deps.emptyTitle(),
				timeZone: proposal.schedule.timeZone,
				rule: proposal.schedule.rule,
				missed: proposal.schedule.missed,
				inTasks: 'needs-you',
				task: {
					prompt: proposal.prompt,
					provider,
					transport: source.transport ?? 'gui',
					launch: { ...launch, branch: '' },
					...(options?.length
						? { options: options.map((option) => ({ id: option.id, value: String(option.value) })) }
						: {}),
				},
			});
			await this.deps.command(key, {
				kind: 'resolveTaskProposal',
				id,
				task: { projectId: source.projectId, id: schedule.id, title: schedule.name },
			});
			return source;
		}
		const launch = withAutoBranch(
			await this.launch(source, proposal),
			proposal.title ?? '',
			proposal.prompt,
			randomUUID()
		);
		const { provider, options, modelName, effortName } = agentOf(source, proposal),
			transport = source.transport ?? 'gui';
		// Created in the backlog: the context is attached before the task can start, as the relay does.
		let task = await store.createTask(
			source.projectId,
			proposal.prompt,
			provider,
			transport,
			this.deps.emptyTitle(),
			'backlog',
			launch
		);
		const attachments = await this.context(store, task, source, proposal);
		task = await store.updateTask(task, {
			originTaskId: source.id,
			...(proposal.title ? { title: proposal.title } : {}),
			...(attachments.length ? { attachments } : {}),
			...(options?.length ? { launchOptions: options } : {}),
			...(modelName ? { modelName } : {}),
			...(effortName ? { effortName } : {}),
		});
		await this.deps.command(key, {
			kind: 'resolveTaskProposal',
			id,
			task: { projectId: task.projectId, id: task.id, title: task.title },
		});
		if (proposal.start === 'now') void this.deps.start(task).catch(() => {});
		return store.task(task);
	}
	/** `Відкрити в аркуші…`: the sheet's draft gets the context; the folders join the project now, like `Додати теку…`. */
	async draft(key: TaskKey, id: string, owner: AttachmentOwner): Promise<TaskProposalDraft> {
		if (owner.draft !== true || owner.projectId !== key.projectId) throw new Error('Invalid draft');
		const { store, source, proposal } = await this.pending(key, id);
		const { provider, options } = agentOf(source, proposal);
		return {
			prompt: proposal.prompt,
			title: proposal.title,
			launch: await this.launch(source, proposal),
			provider,
			transport: source.transport ?? 'gui',
			options: options ?? [],
			attachments: await this.context(store, owner, source, proposal),
		};
	}
	/** The sheet created the task: it is linked to its source and the agent learns it. */
	async adopt(key: TaskKey, id: string, created: TaskKey) {
		if (created.projectId !== key.projectId || created.id === key.id)
			throw new Error('The task is not in this project');
		const { store } = await this.pending(key, id),
			task = await store.updateTask(created, { originTaskId: key.id });
		await this.deps.command(key, {
			kind: 'resolveTaskProposal',
			id,
			task: { projectId: task.projectId, id: task.id, title: task.title },
		});
	}
	async decline(key: TaskKey, id: string) {
		await this.deps.command(key, { kind: 'resolveTaskProposal', id, task: null });
	}
}
