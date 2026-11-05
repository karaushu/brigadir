import { boardColumn } from './board';
import { slackEscape } from './slack';
import type { TaskStatus } from './workspace';
import {
	slackPRNumbers,
	slackWatchKindsOf,
	slackWatchWords,
	type SlackWatchKind,
} from './slack-watches';
/**
 * spec/notifications-slack-notes-and-schedules#slack: what an `@bot` mention in Slack asks for, and the bot's replies. Pure: main/slack-mentions.ts reads Slack and
 * Brigadir, this file only reads text and writes text. The replies are mrkdwn in the watch-ci shape, in English
 * like every Slack message of the app; prompts to the helper model are English (rule 12).
 */

/** What the mention asks for: a task, the state of one, a note (the thread as it is, or its summary), or not clear. */
export type SlackIntent =
	| { kind: 'task' }
	| { kind: 'status' }
	/** A question about the project's code — how it works, where something is; a new read-only agent in its main tree answers. */
	| { kind: 'code' }
	| { kind: 'note'; note: 'thread' | 'summary' | 'unclear' }
	/** Write in this thread when it happens; no kinds — the message does not say what. */
	| { kind: 'watch'; watch: SlackWatchKind[] }
	| { kind: 'unwatch' }
	| { kind: 'unsure' };

/** Slack's markup as plain text: `<@U1>` → `@U1`, `<#C1|deploys>` → `#deploys`, `<url|label>` → `label (url)`. */
export function slackPlain(text: string): string {
	return text
		.replace(/<@([A-Z0-9]+)(?:\|([^>]*))?>/g, (_, id: string, name?: string) => `@${name || id}`)
		.replace(/<#([A-Z0-9]+)(?:\|([^>]*))?>/g, (_, id: string, name?: string) => `#${name || id}`)
		.replace(/<!subteam\^[A-Z0-9]+(?:\|([^>]*))?>/g, (_, name?: string) => (name ? name : '@group'))
		.replace(/<!(here|channel|everyone)(?:\|[^>]*)?>/g, '@$1')
		.replace(/<((?:https?|mailto):[^|>]+)\|([^>]+)>/g, '$2 ($1)')
		.replace(/<((?:https?|mailto):[^>]+)>/g, '$1')
		.replace(/&lt;/g, '<')
		.replace(/&gt;/g, '>')
		.replace(/&amp;/g, '&');
}

/** The mention's own words: the bot's `<@U…>` goes, the rest is plain text. */
export function slackMentionText(text: string, botUser: string | null): string {
	const bot = botUser
		? new RegExp(`<@${botUser}(?:\\|[^>]*)?>`, 'g')
		: /^\s*<@[A-Z0-9]+(?:\|[^>]*)?>/;
	return slackPlain(text.replace(bot, ' '))
		.replace(/[ \t]+/g, ' ')
		.replace(/^\s+|\s+$/g, '');
}

/**
 * `in <project>: …` (also `в` / `у`) at the start picks the project by name or id, case aside. `project` — found; `unknown`
 * — the prefix names no project; `null` — no prefix.
 */
export function slackProjectPrefix(
	text: string,
	projects: readonly { id: string; name: string }[]
): { project: string; rest: string } | { unknown: string; rest: string } | null {
	const match = /^\s*(?:in|в|у)\s+([^:\n]{1,80}?)\s*:\s*/i.exec(text);
	if (!match) return null;
	const name = match[1]!.trim().replace(/^[`*_"'«]+|[`*_"'»]+$/g, ''),
		rest = text.slice(match[0].length).trim(),
		key = name.toLowerCase(),
		project =
			projects.find((item) => item.name.toLowerCase() === key) ??
			projects.find((item) => item.id.toLowerCase() === key);
	return project ? { project: project.id, rest } : { unknown: name, rest };
}

/** A project named anywhere in the text as a whole word («що в роботі в business?»); only when exactly one is named. */
export function slackNamedProject(
	text: string,
	projects: readonly { id: string; name: string }[]
): string | null {
	const words = new Set(
		text
			.toLowerCase()
			.split(/[^\p{L}\p{N}_.-]+/u)
			.filter(Boolean)
	);
	const named = projects.filter((project) => words.has(project.name.toLowerCase()));
	return named.length === 1 ? named[0]!.id : null;
}

/** A project as the dispatch reads it: its id, its name and the name of its folder. */
export type SlackProjectRef = { id: string; name: string; folder?: string };
/** spec/notifications-slack-notes-and-schedules#slack-dispatch: the projects a task is in (the first is the task's) and its title. */
export type SlackDispatch = { projects: string[]; title: string | null };
/**
 * spec/notifications-slack-notes-and-schedules#slack-dispatch: one request to the helper model for a task mention — which projects the work
 * is in and what the task is called. English (rule 12); the answer is one JSON line.
 */
export function slackDispatchPrompt(input: {
	text: string;
	thread: string | null;
	projects: readonly SlackProjectRef[];
	channelProject: string | null;
}): string {
	return [
		'You route a request from Slack to a coding agent. Pick the projects the work is in and name the task.',
		'Answer with exactly one line of JSON and nothing else: {"projects": ["<id>", ...], "title": "<title>"}',
		'- projects: ids from the list below. People name projects loosely: in another language, in slang, transliterated, by a part of the name or the folder (for example «адмінка» or «админка» → admin, «чой» → choice). List every project the request names, the main one first. When the words name none, use the project of the channel if there is one; otherwise an empty list. Never guess a project the request does not point to.',
		'- title: what is to be done, at most 80 characters, in the language of the request. When the message only says to make a task, take the work from the thread above it. No project names, no quotes, no trailing period.',
		'',
		'Projects (id · name · folder):',
		...input.projects.map(
			(project) =>
				`- ${project.id} · ${project.name}${project.folder && project.folder !== project.name ? ` · ${project.folder}` : ''}`
		),
		input.channelProject
			? `Project of this channel: ${input.channelProject}`
			: 'This channel has no project.',
		'',
		'Message:',
		input.text.slice(0, 2000),
		...(input.thread
			? ['', 'Thread above the message (context only):', input.thread.slice(-4000)]
			: []),
	].join('\n');
}
/** The dispatch answer: known ids only (by id or name, case aside), no repeats; `null` when it is not the JSON line. */
export function parseSlackDispatch(
	answer: string | null,
	projects: readonly SlackProjectRef[]
): SlackDispatch | null {
	const json = /\{[\s\S]*\}/.exec(answer ?? '')?.[0];
	if (!json) return null;
	let value: unknown;
	try {
		value = JSON.parse(json);
	} catch {
		return null;
	}
	if (typeof value !== 'object' || value === null) return null;
	const record = value as Record<string, unknown>,
		ids: string[] = [];
	for (const item of Array.isArray(record.projects) ? record.projects : []) {
		if (typeof item !== 'string') continue;
		const key = item.trim().toLowerCase(),
			project =
				projects.find((entry) => entry.id.toLowerCase() === key) ??
				projects.find((entry) => entry.name.toLowerCase() === key);
		if (project && !ids.includes(project.id)) ids.push(project.id);
	}
	const title =
		typeof record.title === 'string'
			? slackTaskTitle(record.title.replace(/^[\s"'«»„“”]+|[\s"'«»„“”.]+$/g, ''))
			: '';
	return { projects: ids, title: title || null };
}

/** One request to the helper model; the answer is one of six words (see `parseSlackIntent`). */
export function slackIntentPrompt(text: string, thread: string | null): string {
	return [
		'You sort one Slack message that mentions a coding-task bot. Answer with exactly one line from this list and nothing else:',
		'task — the person asks for work on code: fix, build, change, add, investigate',
		'status — any question about the tasks or about the bot itself: how a task is going, what is in progress, where a PR, branch or task stands, why something was done or took long, how long, what was decided, what is left, who, when; what the bot can do, its features, help',
		'code — something to look up in the project itself, not in the task list: how its code works or where something is in it (a flow, a function, a file, an endpoint, a config); what was merged, released or deployed (to prod, staging) and when; git history, commits, CI runs and their logs, GitHub issues; and any request to check, verify or look something up ("check it", "перевір", "глянь", "проверь")',
		'note thread — the person asks to save this thread as it is',
		'note summary — the person asks to save a summary, the decision or the conclusion of the thread',
		'note unclear — the person asks for a note but does not say which of the two',
		'watch <what> — the person asks to be told later, here, when something happens ("let me know when", "ping me when", "напиши, коли"); <what> is one or more of: ci (a CI run, checks or a build of a PR finishes or passes), merged (a PR is merged), done (a task is finished); plain `watch` when it does not say which',
		'unwatch — the person asks to stop watching, to stop these updates in this thread',
		'unsure — none of these is clear',
		'',
		'Message:',
		text.slice(0, 2000),
		...(thread ? ['', 'Thread above the message (context only):', thread.slice(-3000)] : []),
	].join('\n');
}
/** The model's answer as an intent; anything else is `null` (the keyword rules decide then). */
export function parseSlackIntent(answer: string | null): SlackIntent | null {
	const line = (answer ?? '')
		.split(/\r?\n/)
		.map((item) =>
			item
				.trim()
				.toLowerCase()
				.replace(/[`*_."'«»]/g, '')
		)
		.find((item) => item.length > 0);
	if (!line) return null;
	if (/^unwatch\b/.test(line)) return { kind: 'unwatch' };
	const watch = /^watch\b(.*)$/.exec(line);
	if (watch) {
		const words = watch[1]!.split(/[^a-z-]+/),
			kinds: SlackWatchKind[] = [];
		if (words.includes('ci')) kinds.push('ci');
		if (words.some((word) => word.startsWith('merge'))) kinds.push('pr-merged');
		if (words.includes('done')) kinds.push('task-done');
		return { kind: 'watch', watch: kinds };
	}
	const match = /^(task|status|code|unsure|note)(?:\s*[-—:]?\s*(thread|summary|unclear))?\b/.exec(
		line
	);
	if (!match) return null;
	if (match[1] === 'note')
		return { kind: 'note', note: (match[2] as 'thread' | 'summary') ?? 'unclear' };
	return { kind: match[1] as 'task' | 'status' | 'code' | 'unsure' };
}

const noteWords =
		/\b(note|notes|jot down|write down)\b|нотатк|занотуй|запиши|записати|зберегти тред|збережи тред/i,
	saveWords = /\b(save|record|keep)\b|збережи|зберегти/i,
	summaryWords =
		/\b(summary|summari[sz]e|conclusion|decision|outcome|tl;?dr|recap)\b|висновок|висновк|підсум|резюм|рішення/i,
	threadWords = /\b(thread|verbatim|as is|whole conversation)\b|тред|дослівно|розмову/i,
	statusWords =
		/\b(status|progress|in progress|how is|how's|where is|where's|what's|what is|done yet|state of|any news|eta)\b|стан|статус|етап|що в роботі|як там|як справи|чи готов|готово\?/i,
	codeWords =
		/\bhow (does|do|is)\b.{1,120}\b(work|works|handled|implemented|done|wired|built)\b|\bwhere (is|are|do|does)\b.{1,120}\b(handled|defined|implemented|declared|configured|processed|called|validated|checked|stored|registered|parsed)\b|\b(which|what) (file|function|module|class|component|endpoint|handler|service)\b|\b(in the code|codebase|source code)\b|(^|[^\p{L}])як(?=[^\p{L}]).{0,80}працю(є|ють)|(^|[^\p{L}])де(?=[^\p{L}]).{0,80}(обробляєть?ся|оброблюєть?ся|визначен|описан|реалізован|лежить|знаходиться|викликаєть?ся|налаштован|зберігаєть?ся|перевіряєть?ся|парситься|реєструєть?ся)|(в|у) якому файлі|який файл|яка функція|(в|у) коді/iu,
	taskVerbs =
		/^(please\s+)?(fix|add|implement|create|make|build|change|update|remove|delete|refactor|investigate|write|support|rename|move|migrate|bump|check|look into|debug|test)\b|^(будь ласка,?\s+)?(зроби|додай|виправ|полагодь|реалізуй|створи|зміни|онови|прибери|видали|напиши|перевір|переглянь|перенеси|подивись|розберись)/i;
/** No helper agent (or its answer is not one of the words): the same six from plain keyword rules. */
export function slackIntentFallback(text: string): SlackIntent {
	const value = text.trim();
	// «Напиши, коли …» starts like a task and ends like a question: the watch words go first.
	const watch = slackWatchWords(value);
	if (watch === 'unwatch') return { kind: 'unwatch' };
	if (watch === 'watch') return { kind: 'watch', watch: slackWatchKindsOf(value) };
	const thread = threadWords.test(value),
		summary = summaryWords.test(value);
	if (noteWords.test(value) || (saveWords.test(value) && (thread || summary)))
		return {
			kind: 'note',
			note: summary && !thread ? 'summary' : thread && !summary ? 'thread' : 'unclear',
		};
	if (taskVerbs.test(value)) return { kind: 'task' };
	if (codeWords.test(value)) return { kind: 'code' };
	if (statusWords.test(value) || slackAsksActive(value) || /#\d+\b/.test(value))
		return { kind: 'status' };
	if (slackAsksQuestion(value)) return { kind: 'status' };
	return { kind: 'unsure' };
}
const questionWords =
	/(^|[^\p{L}])(чому|навіщо|нащо|скільки|як довго|коли|що|хто|де|почему|зачем|сколько|когда|что|кто|где|умієш|вмієш|умеешь|можеш|можешь|допоможи|помоги|розкажи|расскажи|help|why|how long|how come|how|what|when|who|which)(?=[^\p{L}]|$)/iu;
/** A question (a question word, or `?` at the end): it goes to the status answer, never to «not sure» buttons. */
export function slackAsksQuestion(text: string): boolean {
	const value = text.trim();
	return value.endsWith('?') || questionWords.test(value);
}
/** A task's title as a search key: quotes around it („…", «…», "…") and case aside, spaces collapsed. */
export function slackTitleKey(text: string): string {
	return text
		.trim()
		.replace(/^[„“”"«»'`*_]+|[„“”"«»'`*_]+$/g, '')
		.replace(/\s+/g, ' ')
		.trim()
		.toLowerCase();
}
/** The titles quoted in a message: „…", «…», "…", “…”. */
function quotedTitles(text: string): string[] {
	return [...text.matchAll(/[„“"«]([^„“”"«»\n]{2,120})[“”"»]/g)].map((match) =>
		slackTitleKey(match[1]!)
	);
}
/** `what's in progress` / `що в роботі`: the answer is the project's active tasks, not one task. */
export function slackAsksActive(text: string): boolean {
	return /\b(in progress|in work|what('s| is) (running|going on|being worked on)|what are you working on|active tasks)\b|[ув] роботі|що зараз робиться|що робиться|активні задачі/i.test(
		text
	);
}

/** One message of a thread as `conversations.replies` gives it (only what the text needs). */
export type SlackThreadMessage = {
	user: string;
	ts: string;
	text: string;
	files?: { name: string; url: string }[];
};
const threadLimit = 8 * 1024;
/** UTF-8 length — core runs in the renderer too, without Buffer. */
function bytes(text: string) {
	let size = 0;
	for (const char of text) {
		const point = char.codePointAt(0)!;
		size += point < 0x80 ? 1 : point < 0x800 ? 2 : point < 0x10000 ? 3 : 4;
	}
	return size;
}
/** `2026-10-30 14:02 UTC` from Slack's `ts` (seconds with a fraction). */
export function slackTime(ts: string): string {
	const date = new Date(Math.floor(Number(ts) * 1000));
	return Number.isNaN(date.getTime())
		? ts
		: `${date.toISOString().slice(0, 16).replace('T', ' ')} UTC`;
}
/**
 * The thread as plain text, `author · time` then the text, files as links; at most 8 KB — the first message (the topic)
 * stays, then the latest that fit, with `[… N messages left out …]` between.
 */
export function slackThreadText(messages: readonly SlackThreadMessage[]): string {
	const blocks = messages.map((message) =>
		[
			`${message.user} · ${slackTime(message.ts)}`,
			slackPlain(message.text).trim(),
			...(message.files ?? []).map((file) => `📎 ${file.name}: ${file.url}`),
		]
			.filter((line) => line.length > 0)
			.join('\n')
	);
	const join = (items: string[]) => items.join('\n\n');
	if (bytes(join(blocks)) <= threadLimit) return join(blocks);
	const [first = '', ...rest] = blocks,
		head = truncateBytes(first, threadLimit / 2),
		tail: string[] = [];
	let size = bytes(head) + 64;
	for (let index = rest.length - 1; index >= 0; index--) {
		const next = bytes(rest[index]!) + 2;
		if (size + next > threadLimit) break;
		size += next;
		tail.unshift(rest[index]!);
	}
	const skipped = rest.length - tail.length;
	return join([head, ...(skipped ? [`[… ${skipped} messages left out …]`] : []), ...tail]);
}
function truncateBytes(text: string, limit: number) {
	if (bytes(text) <= limit) return text;
	let cut = text.slice(0, limit);
	while (bytes(cut) > limit - 1) cut = cut.slice(0, -16);
	return `${cut}…`;
}
/** The task's name: the first line of the mention, at most 80 characters. */
export function slackTaskTitle(text: string): string {
	const line =
		text
			.split(/\r?\n/)
			.find((item) => item.trim())
			?.trim() ?? '';
	return line.length > 80 ? `${line.slice(0, 79).trimEnd()}…` : line;
}
/** A note's name: the thread's topic (its first message) when there is a thread, else the mention's first line. */
export function slackNoteTitle(mention: string, root: string | null): string {
	return slackTaskTitle(root ? slackPlain(root) : mention) || 'Slack thread';
}
/** spec/notifications-slack-notes-and-schedules#notes: the note's text — the title, the link back to the thread, then the thread or its summary. */
export function slackNoteText(input: {
	title: string;
	channel: string;
	permalink: string | null;
	body: string;
}): string {
	const label = `${input.channel.startsWith('#') ? input.channel : `#${input.channel}`} thread`;
	return [
		`# ${input.title.replace(/\n/g, ' ')}`,
		'',
		input.permalink
			? `From Slack: [${label.replace(/[[\]]/g, '')}](${input.permalink})`
			: `From Slack: ${label}`,
		'',
		input.body.trim(),
		'',
	].join('\n');
}
/** spec/notifications-slack-notes-and-schedules#slack «Summary»: one request to the helper model, the three sections in this order. */
export function slackSummaryPrompt(thread: string): string {
	return [
		'Summarize this Slack thread for a project note. Use only what the thread says; do not invent facts.',
		'Write Markdown with exactly these three sections, in this order:',
		'## Decision',
		'## Open questions',
		'## Next steps',
		'Under each, short bullet points; write "None." when the thread has nothing for it. No preamble, no closing words.',
		'',
		'Thread:',
		thread,
	].join('\n');
}

/** What the status answer may know about a task — Brigadir's own data, never its code or chat. */
export type SlackTaskInfo = {
	projectId: string;
	id: string;
	title: string;
	status: TaskStatus;
	branch: string | null;
	/** `scopeId` — the repo of the task that has the PR; a watch reads the PR through it. */
	prs: { number: number; url: string; state: 'OPEN' | 'CLOSED' | 'MERGED'; scopeId?: string }[];
	updatedAt: string | null;
	archived?: boolean;
};
/** «In progress» as the board's column says it (spec/tasks#archive): everything but Backlog and Completed. */
export function slackActive(task: SlackTaskInfo): boolean {
	return !task.archived && boardColumn(task.status) === 'progress';
}
const stopWords = new Set(
	'the a an of to in on for and or is are was be it its this that what whats where wheres how hows status state progress task tasks pr branch with about any news done yet please can you tell me show let know ping when write here notify watch стан статус задача задачі задачу що як де на якому етапі там чи по про напиши повідом скажи коли тут треді цьому буде'.split(
		' '
	)
);
const words = (text: string) =>
	text
		.toLowerCase()
		.split(/[^\p{L}\p{N}]+/u)
		.filter((word) => word.length >= 3 && !stopWords.has(word));
/**
 * The tasks a status question names: by PR number (`#123`, `PR 123`), by branch (a word with `/` or the exact branch), else
 * by title words (the best score wins; ties are all returned). Newest first; archived tasks last.
 */
export function slackFindTasks(query: string, tasks: readonly SlackTaskInfo[]): SlackTaskInfo[] {
	const order = (items: SlackTaskInfo[]) =>
		[...items].sort(
			(a, b) =>
				Number(!!a.archived) - Number(!!b.archived) ||
				(b.updatedAt ?? '').localeCompare(a.updatedAt ?? '')
		);
	const numbers = slackPRNumbers(query);
	if (numbers.length) {
		const found = tasks.filter((task) => task.prs.some((pr) => numbers.includes(pr.number)));
		if (found.length) return order(found);
	}
	const quoted = quotedTitles(query).filter(Boolean);
	if (quoted.length) {
		const exact = tasks.filter((task) => quoted.includes(slackTitleKey(task.title)));
		if (exact.length) return order(exact);
		const within = tasks.filter((task) =>
			quoted.some((title) => slackTitleKey(task.title).includes(title))
		);
		if (within.length) return order(within);
	}
	const tokens = query.split(/[\s`'"«»,]+/).filter(Boolean);
	const byBranch = tasks.filter(
		(task) =>
			task.branch &&
			tokens.some(
				(token) => token === task.branch || (token.includes('/') && task.branch!.endsWith(token))
			)
	);
	if (byBranch.length) return order(byBranch);
	const asked = [...new Set(words(query))];
	if (!asked.length) return [];
	let best = 0;
	const scored = tasks.map((task) => {
		const own = words(task.title);
		const score = asked.filter((word) =>
			own.some((item) => item.startsWith(word) || word.startsWith(item))
		).length;
		best = Math.max(best, score);
		return { task, score };
	});
	// One matching word of several asked is a guess; it counts only when it was the one word asked.
	if (best === 0 || (best === 1 && asked.length > 2)) return [];
	return order(scored.filter((item) => item.score === best).map((item) => item.task));
}

const statusLines: Record<TaskStatus, string> = {
	backlog: '📥 *Backlog*',
	queued: '⏳ *Queued*',
	preparing: '🔧 *Preparing*',
	working: '⚙️ *Working*',
	'needs-you': '🙋 *Needs you*',
	done: '🏁 *Done*',
	interrupted: '⏸️ *Interrupted*',
	failed: '❌ *Failed*',
	'rate-limited': '🚦 *Rate limited*',
	completed: '✅ *Completed*',
};
const statusWord: Record<TaskStatus, string> = {
	backlog: 'Backlog',
	queued: 'Queued',
	preparing: 'Preparing',
	working: 'Working',
	'needs-you': 'Needs you',
	done: 'Done',
	interrupted: 'Interrupted',
	failed: 'Failed',
	'rate-limited': 'Rate limited',
	completed: 'Completed',
};
/** `just now`, `5m ago`, `3h ago`, `2d ago`. */
export function slackAgo(at: string, now: number): string {
	const seconds = Math.max(0, Math.round((now - Date.parse(at)) / 1000));
	if (!Number.isFinite(seconds) || seconds < 60) return 'just now';
	if (seconds < 3600) return `${Math.floor(seconds / 60)}m ago`;
	if (seconds < 86_400) return `${Math.floor(seconds / 3600)}h ago`;
	return `${Math.floor(seconds / 86_400)}d ago`;
}
const code = (text: string) => `\`${text.replace(/`/g, "'")}\``;
const link = (url: string, label: string) =>
	`<${url.replace(/[<>|]/g, '')}|${slackEscape(label).replace(/\|/g, '¦')}>`;
export type SlackStatusInput = {
	task: SlackTaskInfo;
	project: string;
	plan: { done: number; total: number; current: string | null } | null;
	ci: 'running' | 'pass' | 'fail' | 'cancelled' | null;
	now: number;
};
/**
 * spec/notifications-slack-notes-and-schedules#slack, state question: the state — project (branch), the task, the plan N of M and its step, the PR and CI, when it
 * changed. Only Brigadir's data: no code, no diff, no retelling of the chat.
 */
export function slackStatusText({ task, project, plan, ci, now }: SlackStatusInput): string {
	const pr = task.prs.find((item) => item.state === 'OPEN') ?? task.prs.at(-1);
	const lines = [
		`${statusLines[task.status]} — ${slackEscape(project)}${task.branch ? ` (${code(task.branch)})` : ''}`,
		`📋 Task: ${slackEscape(task.title)}`,
		plan && plan.total > 0
			? `🗺️ Plan: ${plan.done} of ${plan.total}${plan.current ? ` · ${slackEscape(plan.current)}` : ''}`
			: null,
		pr
			? `🔀 PR: ${link(pr.url, `#${pr.number}`)} · ${pr.state === 'OPEN' ? 'open' : pr.state === 'MERGED' ? 'merged' : 'closed'}`
			: null,
		ci
			? `🧪 CI: ${ci === 'running' ? 'running' : ci === 'pass' ? 'passed' : ci === 'fail' ? 'failed' : 'cancelled'}`
			: null,
		task.updatedAt ? `🕒 Updated ${slackAgo(task.updatedAt, now)}` : null,
	];
	return lines.filter((line): line is string => line !== null).join('\n');
}
/** `what's in progress`: the project's active tasks, newest first, at most ten. */
export function slackActiveText(project: string, tasks: readonly SlackTaskInfo[]): string {
	const active = tasks.filter(slackActive);
	if (!active.length) return `💤 *Nothing in progress* — ${slackEscape(project)}`;
	return [
		`🛠️ *In progress* — ${slackEscape(project)}`,
		...active
			.slice(0, 10)
			.map(
				(task) =>
					`• ${slackEscape(task.title)} — ${statusWord[task.status]}${task.branch ? ` (${code(task.branch)})` : ''}`
			),
		...(active.length > 10 ? [`… and ${active.length - 10} more`] : []),
	].join('\n');
}
/** The bot's short answers in a thread (watch-ci shape: emoji, bold head, the subject after a dash). */
export const slackReply = {
	taskCreated: (project: string, title: string) =>
		`🆕 *Task created* — ${slackEscape(project)}\n📋 Task: ${slackEscape(title)}`,
	taskWaiting: (project: string, title: string) =>
		`⏳ *Waiting for approval in Brigadir* — ${slackEscape(project)}\n📋 Task: ${slackEscape(title)}`,
	noteSaved: (title: string) => `📝 *Note saved* — ${slackEscape(title)}`,
	whichProjectShort: '🤔 *Which project?*',
	whichProject: (projects: readonly string[]) =>
		`🤔 *Which project?* Write \`in <project>: …\`${projects.length ? `\nProjects: ${projects.slice(0, 20).map(slackEscape).join(', ')}` : ''}`,
	unknownProject: (name: string, projects: readonly string[]) =>
		`🤔 *No project ${slackEscape(name)} in Brigadir*${projects.length ? `\nProjects: ${projects.slice(0, 20).map(slackEscape).join(', ')}` : ''}`,
	noTask: '🔎 *No task found* — create one?',
	severalTasks: '🔎 *Several tasks match* — which one?',
	unsure: '🤔 *Not sure what you need*',
	noteKind: '📝 *Save this thread as a note* — which kind?',
	notAllowed: 'Only the people in Brigadir’s Slack settings can create tasks.',
	notesOff: 'Notes are off in Brigadir.',
	expired: 'This choice has expired. Mention the bot again.',
	noText: '🤔 *What should I do?* Write the task after the mention.',
	askingAgent: (title: string) => `⏳ Asking the agent of «${slackEscape(title)}»…`,
	agentSilent: '🤷 *The agent did not answer* — ask in Brigadir.',
	askingCode: (project: string) => `⏳ Asking an agent in ${slackEscape(project)}…`,
	failed: (reason: string) => `⛔ *Could not do it* — ${slackEscape(reason)}`,
} as const;

/** The action ids of our buttons; Slack sends them back in `block_actions`. */
export const slackActions = {
	status: 'brigadir_status',
	task: 'brigadir_task',
	summary: 'brigadir_note_summary',
	thread: 'brigadir_note_thread',
	show: 'brigadir_show',
	/** spec/notifications-slack-notes-and-schedules#slack: a Needs you or a schedule's «Ask» answered from Slack; the value says what (see `slackAnswerValue`). */
	answer: 'brigadir_answer',
	/** A watch: the value's index picks what to watch, which task or which PR. */
	watch: 'brigadir_watch',
	/** spec/notifications-slack-notes-and-schedules#slack-which-project: the project of a task that waits for one. */
	project: 'brigadir_project',
} as const;
export type SlackAction = (typeof slackActions)[keyof typeof slackActions];
export type SlackButton = {
	action: SlackAction;
	label: string;
	value: string;
	style?: 'primary' | 'danger';
};
/** A message with buttons: the text as a section, then one `actions` block (ids unique within it). */
export function slackButtons(text: string, buttons: readonly SlackButton[]) {
	return {
		text,
		blocks: [
			{ type: 'section', text: { type: 'mrkdwn', text } },
			{
				type: 'actions',
				elements: buttons.map((button, index) => ({
					type: 'button',
					action_id: `${button.action}:${index}`,
					text: { type: 'plain_text', text: button.label.slice(0, 75), emoji: true },
					value: button.value.slice(0, 2000),
					...(button.style ? { style: button.style } : {}),
				})),
			},
		],
	};
}
/** `brigadir_show:1` → `brigadir_show`; an id that is not ours → `null`. */
export function slackActionOf(actionId: string): SlackAction | null {
	const base = actionId.split(':')[0];
	return (Object.values(slackActions) as string[]).includes(base ?? '')
		? (base as SlackAction)
		: null;
}

/** The language of the bot's answer: the request's — Ukrainian when it is written in Cyrillic, else English. */
export type SlackLanguage = 'en' | 'uk';
export function slackLanguage(text: string): SlackLanguage {
	return /[а-яіїєґ]/i.test(text) ? 'uk' : 'en';
}
/** The answers' fixed words in Ukrainian; names, titles, branches and code stay as they are. Longest first. */
const ukPhrases: [string, string][] = [
	[
		'Only the people in Brigadir’s Slack settings can create tasks.',
		'Ставити задачі можуть лише люди зі Slack-налаштувань Бригадира.',
	],
	['This choice has expired. Mention the bot again.', 'Вибір застарів. Звернись до бота ще раз.'],
	['Write the task after the mention.', 'Напиши задачу після згадки.'],
	['Stop some: «stop watching».', 'Зупини якісь: «не стеж».'],
	['no watches in this thread', 'у цьому треді я ні за чим не стежу'],
	['I’ll write here when:', 'напишу тут, коли:'],
	['PR closed without merge', 'PR закрито без мерджу'],
	['Stopped watching after', 'Перестав стежити через'],
	['on Brigadir’s tasks', 'серед задач Бригадира'],
	['What should I watch?', 'За чим стежити?'],
	['Too many watches', 'Забагато стежень'],
	['Stopped watching', 'Більше не стежу'],
	['Nothing to stop', 'Нема що зупиняти'],
	['Already completed', 'Вже завершено'],
	['name it as `#123`', 'назви його як `#123`'],
	['🏁 *Turn ended*', '🏁 *Кінець турну*'],
	['✅ *Task completed*', '✅ *Задачу завершено*'],
	['🔀 *PR merged*', '🔀 *PR змержено*'],
	['✅ *CI passed*', '✅ *CI пройшов*'],
	['❌ *CI failed*', '❌ *CI впав*'],
	['⚠️ *CI cancelled*', '⚠️ *CI скасовано*'],
	['🌐 Environment:', '🌐 Середовище:'],
	['⏱️ Duration:', '⏱️ Тривалість:'],
	['|View run>', '|Відкрити run>'],
	[' on GitHub>', ' на GitHub>'],
	['CI finishes', 'CI завершиться'],
	['PR is merged', 'PR змержать'],
	['Task is done', 'Задачу закінчать'],
	['Several PRs', 'Кілька PR'],
	['No open PR', 'Немає відкритого PR'],
	['*No PR', '*Немає PR'],
	['— at most', '— щонайбільше'],
	['*Watching*', '*Стежу*'],
	[' days*', ' днів*'],
	['Save this thread as a note', 'Зберегти тред як нотатку'],
	['Waiting for approval in Brigadir', 'Чекає погодження в Бригадирі'],
	['Notes are off in Brigadir.', 'Нотатки вимкнені в Бригадирі.'],
	['Not sure what you need', 'Не зрозумів, що треба'],
	['Several tasks match', 'Підходить кілька задач'],
	['Nothing in progress', 'Нічого в роботі'],
	['No task found', 'Задачу не знайдено'],
	['Which project?', 'Який проєкт?'],
	['What should I do?', 'Що зробити?'],
	['Could not do it', 'Не вийшло'],
	['Asking the agent of', 'Питаю агента задачі'],
	['Asking an agent in', 'Питаю агента в'],
	['The agent did not answer', 'Агент не відповів'],
	['Task created', 'Задачу створено'],
	['Note saved', 'Нотатку збережено'],
	['Save a summary', 'Зберегти висновок'],
	['Save the thread', 'Зберегти тред'],
	['Show state', 'Показати стан'],
	['Create task', 'Створити задачу'],
	['create one?', 'створити?'],
	['which one?', 'яку саме?'],
	['which kind?', 'як саме?'],
	['📋 Task:', '📋 Задача:'],
	['🗺️ Plan:', '🗺️ План:'],
	['🕒 Updated', '🕒 Оновлено'],
	['Projects:', 'Проєкти:'],
	['Write `in <project>: …`', 'Напиши `in <проєкт>: …`'],
	['No project', 'Немає проєкту'],
	['in Brigadir', 'у Бригадирі'],
	['just now', 'щойно'],
];
/** Task states — only where the bot writes them: in bold (`*Working*`) or after a dash (`— Working`), never in a title. */
const ukStates: [string, string][] = [
	['In progress', 'В роботі'],
	['Rate limited', 'Ліміт'],
	['Needs you', 'Потрібен ти'],
	['Interrupted', 'Перервано'],
	['Preparing', 'Підготовка'],
	['Completed', 'Завершено'],
	['Working', 'Працює'],
	['Backlog', 'Беклог'],
	['Queued', 'У черзі'],
	['Failed', 'Помилка'],
	['Done', 'Готово'],
];
/** Puts a reply into the request's language; English passes through. */
export function slackLocalize(text: string, language: SlackLanguage): string {
	if (language === 'en') return text;
	let out = text;
	for (const [en, uk] of ukPhrases) out = out.split(en).join(uk);
	for (const [en, uk] of ukStates)
		out = out.split(`*${en}*`).join(`*${uk}*`).split(`— ${en}`).join(`— ${uk}`);
	return out
		.replace(/… and (\d+) more/g, '… і ще $1')
		.replace(/(\d+) of (\d+)/g, '$1 з $2')
		.replace(/(\d+)m ago/g, '$1 хв тому')
		.replace(/(\d+)h ago/g, '$1 год тому')
		.replace(/(\d+)d ago/g, '$1 дн тому')
		.replace(
			/(⏱️ Тривалість: )(.+)/,
			(_, head: string, value: string) =>
				head +
				value
					.replace(/(\d+)h\b/, '$1 год')
					.replace(/(\d+)m\b/, '$1 хв')
					.replace(/(\d+)s\b/, '$1 с')
		);
}

/** One task as the helper model reads it for a free question. */
export type SlackTaskFacts = {
	task: SlackTaskInfo;
	project: string;
	plan: SlackStatusInput['plan'];
	ci: SlackStatusInput['ci'];
};
const columnName = { backlog: 'Backlog', progress: 'In progress', completed: 'Completed' } as const;
/** The facts as plain lines — states, plans, PRs, CI, times; no code, no diff, no chat. */
export function slackFactsText(facts: readonly SlackTaskFacts[], now: number): string {
	return facts
		.map(({ task, project, plan, ci }) => {
			const pr = task.prs.find((item) => item.state === 'OPEN') ?? task.prs.at(-1);
			return [
				`- "${task.title}" (project ${project})`,
				`state ${statusWord[task.status]}${task.archived ? ', archived' : ''}`,
				`board column ${columnName[boardColumn(task.status)]}`,
				task.branch ? `branch ${task.branch}` : null,
				plan && plan.total > 0
					? `plan ${plan.done} of ${plan.total}${plan.current ? `, current step: ${plan.current}` : ''}`
					: null,
				pr ? `PR #${pr.number} ${pr.state.toLowerCase()} <${pr.url}>` : null,
				ci ? `CI ${ci}` : null,
				task.updatedAt ? `updated ${slackAgo(task.updatedAt, now)}` : null,
			]
				.filter(Boolean)
				.join('; ');
		})
		.join('\n');
}
/** What the bot can do — the answer to «what can you do?», in the model's own words and the question's language. */
const slackAbilities = [
	'start a coding task from a message (the text is the task, the thread is its context; `in <project>:` or the channel picks the project);',
	'answer how tasks stand — in progress, waiting for you, plans, branches, PRs, CI — from Brigadir’s data;',
	'ask a task’s agent when the data does not answer (why, what was decided, what is left);',
	'look things up in a project through an agent — how the code works, what was merged or deployed and when, history, CI runs — and answer in words, no code in Slack;',
	'save a thread, or a summary of it, as a note;',
	'watch and write in the thread when a PR’s CI ends, a PR is merged or a task is done;',
	'pass a reply in a task’s thread to its agent; Allow · Deny and answers to the agent’s questions, Run now · Skip for scheduled runs, from buttons;',
	'post CI results, merged PRs, «needs you» and completed tasks. Push and merge stay in the app.',
].join(' ');
/**
 * spec/notifications-slack-notes-and-schedules#slack: the helper model answers a free question about the tasks from Brigadir's
 * facts only, in the question's language, as a short Slack message.
 */
export function slackAnswerPrompt(question: string, facts: string, thread: string | null): string {
	return [
		'You are Brigadir, a bot that runs coding agents. A teammate asked you a question in Slack about their tasks.',
		'Answer it using ONLY the facts below. Do not invent tasks, states, plans or links. If the facts do not answer it, say so briefly and say what you do know.',
		'If the facts cannot answer it and the question is about one task listed below — why, what was decided, what is left, how something works, an estimate — reply with exactly one line `ASK_AGENT: <the task title exactly as listed>` and nothing else: Brigadir will ask that task’s agent.',
		'If the facts cannot answer it otherwise — what was deployed or released and when, git history, CI runs, the code, anything the project itself can tell — or the person asks you to check, verify or look again, reply with exactly one line `ASK_PROJECT: <project name>` and nothing else: an agent in that project will look it up with git and GitHub. Never answer that there is no data when the project can tell.',
		`If the question is about you — what you can do, your features, help — answer from this list (not from the facts): ${slackAbilities}`,
		'Reply in the language of the question. Write Slack mrkdwn: *bold*, bullet lines starting with •, links as <url|#123>. At most 12 lines. No headings, no code blocks, no greeting, no sign-off.',
		'Board columns: Backlog — not started; In progress — in work, including Done (the agent finished its turn and waits for review), Needs you and Failed; Completed — closed.',
		'Say states and columns in the language of the question (in Ukrainian: Backlog → Беклог, In progress → В роботі, Completed → Завершено, Done → Готово, Working → Працює, Needs you → Потрібен ти, Failed → Помилка). Never write the field names of the facts. When you list tasks, list every task that fits and give the right count.',
		'',
		`Question: ${question.slice(0, 1000)}`,
		thread ? `\nThe Slack thread above the question:\n${thread.slice(0, 4000)}` : '',
		'',
		'Facts (one task per line):',
		facts || '(no tasks)',
	].join('\n');
}
/** The model's answer as a Slack message: no `@channel`-like broadcasts, no runaway length. */
export function slackModelAnswer(text: string): string | null {
	const clean = text
		.replace(/<!(channel|here|everyone)[^>]*>|@(channel|here|everyone)\b/gi, '')
		.trim()
		.slice(0, 3000);
	return clean || null;
}

/**
 * spec/notifications-slack-notes-and-schedules#slack-project-questions: the helper's `ASK_PROJECT: <name>` — the project to look it up
 * in (`''` when the model named none); `null` for an ordinary answer.
 */
export function slackAskProjectOf(answer: string): string | null {
	const match = /^\s*ASK_PROJECT:?\s*(.*?)\s*$/m.exec(answer);
	return match && answer.trim().split('\n').length === 1
		? match[1]!.trim().replace(/^[„“”"«»'`<]+|[„“”"«»'`>]+$/g, '')
		: null;
}
/** The helper's `ASK_AGENT: <title>` — the task whose agent should answer; `null` for an ordinary answer. */
export function slackAskAgentOf(answer: string): string | null {
	const match = /^\s*ASK_AGENT:\s*(.+?)\s*$/m.exec(answer);
	return match && answer.trim().split('\n').length === 1
		? match[1]!.trim().replace(/^[„“”"«»']+|[„“”"«»']+$/g, '')
		: null;
}
/** The agent's answer as a Slack message: fenced code is cut (Slack gets no code), broadcasts go, length is bounded. */
export function slackAgentAnswer(text: string): string | null {
	return slackModelAnswer(text.replace(/```[\s\S]*?(```|$)/g, '_(code omitted)_'));
}
