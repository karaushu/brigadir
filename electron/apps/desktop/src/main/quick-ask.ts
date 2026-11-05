import { realpath } from 'node:fs/promises';
import { join, relative } from 'node:path';
import { AgentTransport, type AdapterCommand } from '@brigadir/transport';
import { readChanges, readSnapshots } from '@brigadir/git';
import { SessionStore } from '@brigadir/persistence';
import {
	quickAskDiffText,
	quickAskLimits,
	quickAskPrompt,
	quickTaskPrompt,
	quickCodePrompt,
	quickSlackFollowUpPrompt,
	quickAskToolPaths,
	quickAskWrites,
	quickSlackAllows,
	selectOption,
	visibleToAgent,
	type AgentEvent,
	type AgentOption,
	type AgentProvider,
	type ChangeRange,
	type EventRecord,
	type PermissionRequest,
	type QuickAskEvent,
	type QuickAskFile,
	type QuickAskMode,
	type QuickAskRequest,
	type SessionCommand,
	type SessionSnapshot,
	type TaskKey,
	type FileDiff,
	type ScopeLockView,
} from '@brigadir/core';
/** What a quick question needs from the rest of main; injected so the unit test runs without Electron. */
export type QuickAskDeps = {
	dataDir: string | undefined;
	read(key: TaskKey): Promise<SessionSnapshot>;
	command(key: TaskKey, command: SessionCommand): Promise<unknown>;
	revertFile(key: TaskKey, fileId: string, range: ChangeRange): Promise<unknown>;
	fileDiff(key: TaskKey, fileId: string): Promise<FileDiff>;
	scopes(key: TaskKey): Promise<ScopeLockView[]>;
	provider(): AgentProvider;
	send(event: QuickAskEvent): void;
	adapter?: AdapterCommand | undefined;
	idleMs?: number;
};
type Pending = { request: PermissionRequest; resolve(option: string | null): void };
type Thread = {
	id: string;
	key: TaskKey;
	request: QuickAskRequest;
	transport: AgentTransport | null;
	starting: Promise<AgentTransport> | null;
	readOnly: boolean;
	root: string;
	/** The root and its real path: an adapter may name files through either (/var and /private/var on macOS). */ roots: string[];
	busy: boolean;
	closed: boolean;
	permissions: Map<string, Pending>;
	timer?: ReturnType<typeof setTimeout>;
	controller: AbortController;
	forked: boolean;
	/** spec/notifications-slack-notes-and-schedules#slack: a question from Slack — about the whole task or the project's code — read-only, every permission declined,
	 *  its own prompt; `selection` is the popover's. */
	mode: QuickAskMode;
	context: { title: string; prompt: string; diff: string } | null;
	/** The session's own catalog, from `session.started` / `options.changed`. */
	options: AgentOption[];
	answering: boolean;
	tools: Map<string, { write: boolean; paths: Set<string> }>;
	quota: boolean;
	/** spec/composer-steering-queue-and-ghost#quick-question: when the rejected limit resets, Unix seconds; the popover shows it on the limit chip. */
	resetsAt: number | null;
	onTool?: ((paths: string[], write: boolean) => void) | undefined;
	onEnd?: ((reason: string) => void) | undefined;
};
const name = (key: TaskKey) => `${key.projectId}/${key.id}`;
const writeKinds = new Set(['allow_once', 'allow_always']);
/**
 * spec/composer-steering-queue-and-ghost#quick-question: a quick question from a selection. A separate session of the task's provider in the task's folder: a fork of the
 * task's session when the adapter can, else a new session with the context. Nothing reaches the task journal but the
 * `quick-before`/`quick-after` checkpoints and, when files changed, one `quick-ask.changed` row.
 */
export class QuickAsks {
	private threads = new Map<string, Thread>();
	constructor(private deps: QuickAskDeps) {}
	/**
	 * `aboutCode` (spec/notifications-slack-notes-and-schedules#slack): `key` is the project's main tree; a new session (never a fork of its chat) of the
	 * request's provider reads the code. `slackThread` — the Slack thread above the question, context of its prompt.
	 */
	async ask(
		key: TaskKey,
		request: QuickAskRequest,
		mode: QuickAskMode = 'selection',
		slackThread: string | null = null
	): Promise<void> {
		const slack = mode !== 'selection';
		if (this.threads.has(request.id)) throw new Error('This question already runs');
		const store = await SessionStore.at(this.deps.dataDir),
			task = await store.task(key);
		// spec/tasks#released-worktree: the worktree these changes lived in is gone, and an agent started in the project's own tree would answer (and could edit) the wrong files.
		if (await store.releasedWorktree(key)) {
			this.deps.send({
				id: request.id,
				kind: 'failed',
				message: 'The task worktree was removed, so there is no tree to ask about.',
				quota: false,
			});
			return;
		}
		const project = await store.projectForTask(key);
		const snapshot = await this.deps.read(key),
			records = snapshot.records,
			snapshots = await readSnapshots(store, key).catch(() => null);
		// The diff names a file inside its repo; the agent works from the project root.
		const roots = [
			...new Set([project.path, await realpath(project.path).catch(() => project.path)]),
		];
		if (request.selection.scopeId !== undefined) {
			const scope = snapshots?.scopes.find((item) => item.id === request.selection.scopeId);
			if (!scope) throw new Error('Repo is unavailable');
			const { scopeId: _, ...selection } = request.selection;
			request = {
				...request,
				selection: { ...selection, path: within(roots, join(scope.path, selection.path)) },
			};
		}
		const started = records.findLast((record) => record.event.kind === 'session.started')?.event;
		// spec/composer-steering-queue-and-ghost#quick-question: a task without isolation whose repo another task holds may not be changed from here.
		let lockedBy: string | null = null;
		if (!slack && task.launch?.isolation !== 'worktree' && task.readOnlyAgent !== true) {
			try {
				for (const scope of await this.deps.scopes(key)) {
					const other = scope.owners.find((owner) => name(owner.key) !== name(key));
					if (other) {
						lockedBy = other.title;
						break;
					}
				}
			} catch {
				/* no lock registry yet */
			}
		}
		const readOnly = slack || lockedBy !== null || task.readOnlyAgent === true;
		const thread: Thread = {
			id: request.id,
			key,
			request,
			transport: null,
			starting: null,
			readOnly,
			root: project.path,
			roots,
			busy: false,
			closed: false,
			permissions: new Map(),
			controller: new AbortController(),
			forked: false,
			mode,
			context: null,
			options: [],
			answering: false,
			quota: false,
			resetsAt: null,
			tools: new Map(),
		};
		this.threads.set(request.id, thread);
		const taskProvider = task.provider ?? this.deps.provider();
		const provider = request.provider ?? taskProvider;
		try {
			const directories = [
				...new Set(
					(snapshots?.scopes ?? [])
						.filter(
							(scope) => scope.kind !== 'root' && visibleToAgent(scope) && scope.available !== false
						)
						.map((scope) => scope.path)
				),
			];
			thread.starting = AgentTransport.start({
				provider,
				cwd: project.path,
				signal: thread.controller.signal,
				...(directories.length ? { additionalDirectories: directories } : {}),
				...(this.deps.adapter ? { adapter: this.deps.adapter } : {}),
				...(mode !== 'aboutCode' && provider === taskProvider && started?.kind === 'session.started'
					? { forkSessionId: started.sessionId }
					: {}),
				requestPermission: (permission, signal) => this.permission(thread, permission, signal),
				onEvent: (event) => this.event(thread, event),
			});
			const transport = await thread.starting;
			thread.transport = transport;
			thread.forked = transport.forked;
			if (thread.closed) {
				transport.close();
				return;
			}
			if (request.model) {
				const option = selectOption(thread.options, 'model');
				if (!option?.choices.some((choice) => choice.value === request.model))
					throw new Error('The selected model is unavailable.');
				await transport.send({ kind: 'setOption', id: option.id, value: request.model });
				// The chosen model's effort, when its catalog has that level; else the model's own.
				const effort = request.effort ? selectOption(thread.options, 'effort') : undefined;
				if (effort?.choices.some((choice) => choice.value === request.effort))
					await transport
						.send({ kind: 'setOption', id: effort.id, value: request.effort! })
						.catch(() => {});
			}
			await this.mirror(
				transport,
				thread.options,
				task.agentOptions ?? [],
				readOnly,
				records,
				mode === 'aboutCode' || provider !== taskProvider || Boolean(request.model)
			);
			if (!transport.forked && mode !== 'aboutCode')
				thread.context = {
					title: task.title,
					prompt: (task.prompt ?? firstPrompt(records)).slice(0, quickAskLimits.prompt),
					diff: slack
						? ''
						: await this.fileDiff(key, roots, request.selection.path).catch(() => ''),
				};
			this.deps.send({
				id: request.id,
				kind: 'started',
				provider,
				forked: transport.forked,
				readOnly,
				lockedBy,
			});
			await this.turn(
				thread,
				mode === 'aboutCode'
					? quickCodePrompt({
							question: request.question,
							language: request.language,
							project: project.name,
							thread: slackThread,
							today: slackToday(new Date()),
						})
					: mode === 'aboutTask'
						? quickTaskPrompt({
								question: request.question,
								language: request.language,
								context: thread.context ?? undefined,
							})
						: quickAskPrompt({
								selection: request.selection,
								question: request.question,
								language: request.language,
								readOnly,
								...(thread.context ? { context: thread.context } : {}),
							}),
				request.question
			);
		} catch (error) {
			this.fail(thread, error);
		}
	}
	/** `language` — a Slack follow-up's own language; the popover keeps the first question's. */
	async followUp(
		key: TaskKey,
		id: string,
		question: string,
		language?: QuickAskRequest['language']
	) {
		const thread = this.threads.get(id);
		if (!thread || name(thread.key) !== name(key) || !thread.transport)
			throw new Error('This quick question is closed');
		if (thread.busy) throw new Error('The agent is still answering');
		try {
			await this.turn(
				thread,
				thread.mode === 'selection'
					? quickAskPrompt({
							selection: thread.request.selection,
							question,
							language: thread.request.language,
							readOnly: thread.readOnly,
							followUp: true,
						})
					: quickSlackFollowUpPrompt({ question, language: language ?? thread.request.language }),
				question
			);
		} catch (error) {
			this.fail(thread, error);
		}
	}
	async stop(id: string) {
		const thread = this.threads.get(id);
		if (!thread) return;
		for (const pending of thread.permissions.values()) pending.resolve(null);
		thread.permissions.clear();
		if (thread.busy) await thread.transport?.send({ kind: 'cancel' }).catch(() => {});
	}
	close(id: string) {
		const thread = this.threads.get(id);
		if (!thread) return;
		thread.closed = true;
		this.threads.delete(id);
		clearTimeout(thread.timer);
		for (const pending of thread.permissions.values()) pending.resolve(null);
		thread.controller.abort();
		thread.transport?.close();
	}
	closeAll() {
		for (const id of [...this.threads.keys()]) this.close(id);
	}
	answer(id: string, requestId: string, optionId: string | null) {
		const thread = this.threads.get(id),
			pending = thread?.permissions.get(requestId);
		if (!thread || !pending) throw new Error('This permission is no longer pending');
		if (optionId !== null && !pending.request.options.some((option) => option.id === optionId))
			throw new Error('Unknown permission option');
		thread.permissions.delete(requestId);
		pending.resolve(optionId);
		this.deps.send({ id, kind: 'permission', request: null });
	}
	async revert(key: TaskKey, fileId: string, range: ChangeRange) {
		await this.deps.revertFile(key, fileId, range);
	}
	private async turn(thread: Thread, prompt: string, question: string) {
		const transport = thread.transport!;
		clearTimeout(thread.timer);
		thread.busy = true;
		const begun = Date.now();
		let before: number | null = null;
		const touched = new Set<string>();
		let wrote = false;
		let stopped = false;
		thread.onTool = (paths, write) => {
			if (write) {
				wrote = true;
				for (const path of paths) touched.add(path);
			}
		};
		try {
			if (!thread.readOnly) {
				await this.deps.command(thread.key, { kind: 'quickAsk', phase: 'before' });
				before = await this.latest(thread.key);
			}
			thread.answering = true;
			thread.onEnd = (reason) => {
				stopped = reason === 'cancelled';
			};
			thread.quota = false;
			try {
				await transport.send({ kind: 'prompt', text: prompt });
			} catch (error) {
				if (thread.quota) throw Object.assign(new Error('quota'), { quota: true });
				throw error;
			}
			thread.answering = false;
			if (thread.quota) throw Object.assign(new Error('quota'), { quota: true });
			if (wrote && before !== null && !thread.readOnly) {
				const files = [...touched];
				if (files.length)
					await this.deps.command(thread.key, {
						kind: 'quickAsk',
						phase: 'after',
						question: question.slice(0, quickAskLimits.journalQuestion),
						files,
						before,
					});
				else await this.deps.command(thread.key, { kind: 'checkpoint' });
				const after = await this.latest(thread.key);
				if (after !== null && after > before) {
					const range = { base: before, current: after },
						store = await SessionStore.at(this.deps.dataDir),
						changes = await readChanges(store, thread.key, range);
					const listed: QuickAskFile[] = changes.files
						.map((file) => {
							const scope = changes.scopes.find((item) => item.id === file.scopeId);
							const path = scope ? within(thread.roots, join(scope.path, file.path)) : file.path;
							return {
								path,
								fileId: file.id,
								scopeId: file.scopeId,
								scopePath: file.path,
								additions: file.additions,
								deletions: file.deletions,
							};
						})
						.filter((file) => !files.length || files.includes(file.path));
					if (listed.length)
						this.deps.send({ id: thread.id, kind: 'changes', files: listed, range });
				}
			}
			this.deps.send({ id: thread.id, kind: 'done', milliseconds: Date.now() - begun, stopped });
		} finally {
			thread.busy = false;
			thread.answering = false;
			thread.onTool = undefined;
			thread.onEnd = undefined;
			if (!thread.closed)
				thread.timer = setTimeout(() => this.close(thread.id), this.deps.idleMs ?? 600_000);
		}
	}
	private async latest(key: TaskKey) {
		const store = await SessionStore.at(this.deps.dataDir);
		return (await readSnapshots(store, key))?.checkpoints.at(-1)?.id ?? null;
	}
	private event(thread: Thread, event: AgentEvent) {
		if (thread.closed) return;
		if (event.kind === 'session.started' || event.kind === 'options.changed')
			thread.options = event.options;
		// A forked Claude session may replay its history on load; only the answer to our prompt counts.
		if (!thread.answering) return;
		if (
			event.kind === 'message.delta' &&
			event.role === 'assistant' &&
			event.content.kind === 'text' &&
			!event.subagentId
		)
			this.deps.send({ id: thread.id, kind: 'text', text: event.content.text });
		else if (event.kind === 'tool.changed') {
			// An update carries only what changed: the kind and the paths come with the first event of the call.
			const known = thread.tools.get(event.patch.id) ?? { write: false, paths: new Set<string>() };
			known.write ||= quickAskWrites(event.patch);
			for (const path of thread.roots.flatMap((root) => quickAskToolPaths(event.patch, root)))
				known.paths.add(path);
			thread.tools.set(event.patch.id, known);
			if (event.patch.status === 'completed') thread.onTool?.([...known.paths], known.write);
			if (event.patch.title || event.patch.status)
				this.deps.send({
					id: thread.id,
					kind: 'tool',
					title: event.patch.title ?? '',
					status: event.patch.status ?? '',
				});
		} else if (event.kind === 'turn.completed') thread.onEnd?.(event.reason);
		else if (event.kind === 'rate-limit.changed' && event.status === 'rejected') {
			thread.quota = true;
			thread.resetsAt = event.resetsAt;
		}
	}
	private permission(
		thread: Thread,
		request: PermissionRequest,
		signal: AbortSignal
	): Promise<string | null> {
		// spec/notifications-slack-notes-and-schedules#slack-side-commands: from Slack nobody is at the window to answer — main allows
		// reads and commands that read, and declines the rest.
		if (thread.mode !== 'selection')
			return Promise.resolve(
				(quickSlackAllows(request.tool)
					? request.options.find((option) => option.kind === 'allow_once')
					: undefined
				)?.id ??
					request.options.find((option) => !writeKinds.has(option.kind))?.id ??
					null
			);
		// spec/composer-steering-queue-and-ghost#quick-question: a repo another task holds — every write is declined, nothing to ask.
		if (thread.readOnly && quickAskWrites(request.tool))
			return Promise.resolve(
				request.options.find((option) => !writeKinds.has(option.kind))?.id ?? null
			);
		return new Promise((resolve) => {
			const finish = (option: string | null) => {
				signal.removeEventListener('abort', abort);
				thread.permissions.delete(request.id);
				resolve(option);
			};
			const abort = () => {
				finish(null);
				this.deps.send({ id: thread.id, kind: 'permission', request: null });
			};
			signal.addEventListener('abort', abort, { once: true });
			thread.permissions.set(request.id, { request, resolve: finish });
			this.deps.send({ id: thread.id, kind: 'permission', request });
		});
	}
	/** The task's model, effort and permission mode, when the new session's catalog has them; a held repo asks for the manual mode. */
	private async mirror(
		transport: AgentTransport,
		own: readonly AgentOption[],
		taskOptions: readonly AgentOption[],
		readOnly: boolean,
		records: readonly EventRecord[],
		otherProvider = false
	) {
		const last = records.findLast(
			(record) => record.event.kind === 'options.changed' || record.event.kind === 'session.started'
		)?.event;
		const current =
			last && (last.kind === 'options.changed' || last.kind === 'session.started')
				? last.options
				: taskOptions;
		for (const kind of ['model', 'effort', 'mode'] as const) {
			if (otherProvider && kind !== 'mode') continue;
			const target = selectOption(own, kind);
			if (!target) continue;
			let value = selectOption(current, kind)?.value;
			if (kind === 'mode' && readOnly)
				value =
					['read-only', 'default', 'manual'].find((choice) =>
						target.choices.some((item) => item.value === choice)
					) ?? value;
			if (
				value &&
				value !== target.value &&
				target.choices.some((choice) => choice.value === value)
			)
				await transport.send({ kind: 'setOption', id: target.id, value }).catch(() => {});
		}
	}
	private async fileDiff(key: TaskKey, roots: string[], path: string) {
		const store = await SessionStore.at(this.deps.dataDir),
			changes = await readChanges(store, key);
		const file = changes.files.find((file) => {
			const scope = changes.scopes.find((item) => item.id === file.scopeId);
			return scope && within(roots, join(scope.path, file.path)) === path;
		});
		if (!file) return '';
		const diff = await this.deps.fileDiff(key, file.id);
		return quickAskDiffText(diff.lines);
	}
	private fail(thread: Thread, error: unknown) {
		if (thread.closed) return;
		const quota = Boolean(error && typeof error === 'object' && 'quota' in error);
		this.deps.send({
			id: thread.id,
			kind: 'failed',
			message: error instanceof Error ? error.message.slice(0, 300) : String(error).slice(0, 300),
			quota,
			...(quota ? { resetsAt: thread.resetsAt } : {}),
		});
	}
}
/** A project-relative path through whichever spelling of the root holds it (/var and /private/var on macOS). */
function within(roots: readonly string[], path: string) {
	for (const root of roots) {
		const value = relative(root, path);
		if (!value.startsWith('..')) return value;
	}
	return relative(roots[0]!, path);
}
function firstPrompt(records: readonly EventRecord[]) {
	const started = records.find((record) => record.event.kind === 'turn.started')?.event;
	return started?.kind === 'turn.started' ? started.text : '';
}

/** `2026-11-05 (Thursday), 21:14 UTC+02:00` — «today» for a Slack project question, in the machine's own time zone. */
function slackToday(now: Date): string {
	const pad = (n: number) => String(n).padStart(2, '0'),
		offset = -now.getTimezoneOffset(),
		sign = offset < 0 ? '-' : '+',
		abs = Math.abs(offset),
		day = now.toLocaleDateString('en-US', { weekday: 'long' });
	return `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())} (${day}), ${pad(now.getHours())}:${pad(now.getMinutes())} UTC${sign}${pad(Math.floor(abs / 60))}:${pad(abs % 60)}`;
}
