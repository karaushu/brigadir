import { boardColumn } from './board';
import { slackEscape } from './slack';
import { isRecord, type TaskStatus } from './workspace';
import { slackPRNumbers, type SlackWatchKind } from './slack-watches';
/**
 * spec/notifications-slack-notes-and-schedules#slack: what an `@bot` mention in Slack asks for, and the bot's replies. Pure: main/slack-mentions.ts reads Slack and
 * Brigadir, this file only reads text and writes text. The replies are mrkdwn in the watch-ci shape, in English
 * like every Slack message of the app; prompts to the helper model are English (rule 12).
 */

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
export type SlackStatusInput = {
	task: SlackTaskInfo;
	project: string;
	plan: { done: number; total: number; current: string | null } | null;
	ci: 'running' | 'pass' | 'fail' | 'cancelled' | null;
	now: number;
};
/** The bot's short answers in a thread (watch-ci shape: emoji, bold head, the subject after a dash). */
export const slackReply = {
	taskCreated: (project: string, title: string) =>
		`🆕 *Task created* — ${slackEscape(project)}\n📋 Task: ${slackEscape(title)}`,
	taskWaiting: (project: string, title: string) =>
		`⏳ *Waiting for approval in Brigadir* — ${slackEscape(project)}\n📋 Task: ${slackEscape(title)}`,
	noteSaved: (title: string) => `📝 *Note saved* — ${slackEscape(title)}`,
	unknownProject: (name: string, projects: readonly string[]) =>
		`🤔 *No project ${slackEscape(name)} in Brigadir*${projects.length ? `\nProjects: ${projects.slice(0, 20).map(slackEscape).join(', ')}` : ''}`,
	noTask: '🔎 *No task found* — create one?',
	severalTasks: '🔎 *Several tasks match* — which one?',
	notAllowed: 'Only the people in Brigadir’s Slack settings can create tasks.',
	notesOff: 'Notes are off in Brigadir.',
	expired: 'This choice has expired. Mention the bot again.',
	noText: '🤔 *What should I do?* Write the task after the mention.',
	askingAgent: (title: string) => `⏳ Asking the agent of «${slackEscape(title)}»…`,
	agentSilent: '🤷 *The agent did not answer* — ask in Brigadir.',
	handedTo: (title: string) => `📨 *Passed to the agent of* «${slackEscape(title)}»`,
	failed: (reason: string) => `⛔ *Could not do it* — ${slackEscape(reason)}`,
} as const;

/** The action ids of our buttons; Slack sends them back in `block_actions`. */
export const slackActions = {
	/** spec/notifications-slack-notes-and-schedules#slack: a Needs you or a schedule's «Ask» answered from Slack; the value says what (see `slackAnswerValue`). */
	answer: 'brigadir_answer',
	/** A watch: the value's index picks what to watch, which task or which PR. */
	watch: 'brigadir_watch',
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
	['Waiting for approval in Brigadir', 'Чекає погодження в Бригадирі'],
	['Notes are off in Brigadir.', 'Нотатки вимкнені в Бригадирі.'],
	['Several tasks match', 'Підходить кілька задач'],
	['Nothing in progress', 'Нічого в роботі'],
	['No task found', 'Задачу не знайдено'],
	['What should I do?', 'Що зробити?'],
	['Could not do it', 'Не вийшло'],
	['Asking the agent of', 'Питаю агента задачі'],
	['Passed to the agent of', 'Передав агенту задачі'],
	['The agent did not answer', 'Агент не відповів'],
	['Task created', 'Задачу створено'],
	['Note saved', 'Нотатку збережено'],
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
				`- task ${task.id} "${task.title}" (project ${project})`,
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
/** The model's answer as a Slack message: no `@channel`-like broadcasts, no runaway length. */
export function slackModelAnswer(text: string): string | null {
	const clean = text
		.replace(/<!(channel|here|everyone)[^>]*>|@(channel|here|everyone)\b/gi, '')
		.trim()
		.slice(0, 3000);
	return clean || null;
}

/** The agent's answer as a Slack message: fenced code is cut (Slack gets no code), broadcasts go, length is bounded. */
export function slackAgentAnswer(text: string): string | null {
	return slackModelAnswer(text.replace(/```[\s\S]*?(```|$)/g, '_(code omitted)_'));
}

/**
 * spec/notifications-slack-notes-and-schedules#slack-agent: what the Slack agent asks Brigadir to do, one `ACTION <name> <json>` line
 * each; the bot only runs them.
 */
export type SlackAgentStep =
	| { kind: 'create_task'; projects: string[]; title: string; prompt: string | null }
	| { kind: 'send_to_task'; task: string; text: string }
	| { kind: 'ask_task'; task: string; question: string }
	| { kind: 'note'; note: 'thread' | 'summary' }
	| { kind: 'watch'; kinds: SlackWatchKind[] }
	| { kind: 'unwatch' };
const text = (value: unknown, limit: number) =>
	typeof value === 'string' && value.trim() ? value.trim().slice(0, limit) : null;
function slackAgentStep(name: string, body: unknown): SlackAgentStep | null {
	const value = isRecord(body) ? body : {};
	if (name === 'create_task') {
		const projects = (Array.isArray(value.projects) ? value.projects : [value.project])
				.map((item) => text(item, 200))
				.filter((item): item is string => item !== null)
				.slice(0, 10),
			title = text(value.title, 200);
		return projects.length && title
			? { kind: name, projects, title, prompt: text(value.prompt, 20_000) }
			: null;
	}
	if (name === 'send_to_task') {
		const task = text(value.task, 200),
			said = text(value.text, 12_000);
		return task && said ? { kind: name, task, text: said } : null;
	}
	if (name === 'ask_task') {
		const task = text(value.task, 200),
			question = text(value.question, 4000);
		return task && question ? { kind: name, task, question } : null;
	}
	if (name === 'note') return { kind: name, note: value.kind === 'summary' ? 'summary' : 'thread' };
	if (name === 'watch') {
		const words = Array.isArray(value.kinds) ? value.kinds.map(String) : [],
			kinds: SlackWatchKind[] = [];
		if (words.includes('ci')) kinds.push('ci');
		if (words.some((word) => word.startsWith('merge') || word === 'pr-merged'))
			kinds.push('pr-merged');
		if (words.some((word) => word === 'done' || word === 'task-done')) kinds.push('task-done');
		return { kind: name, kinds };
	}
	if (name === 'unwatch') return { kind: name };
	return null;
}
/**
 * spec/notifications-slack-notes-and-schedules#slack-agent: the agent's answer as words for the thread and the actions for Brigadir.
 * An `ACTION` line that does not parse is dropped, never posted.
 */
export function slackAgentSteps(answer: string): { text: string; actions: SlackAgentStep[] } {
	const actions: SlackAgentStep[] = [],
		kept: string[] = [];
	for (const line of answer.split(/\r?\n/)) {
		const match = /^\s*`?ACTION\s+([a-z_]+)\s*(.*?)`?\s*$/.exec(line);
		if (!match) {
			kept.push(line);
			continue;
		}
		let body: unknown = {};
		try {
			body = match[2] ? JSON.parse(match[2]) : {};
		} catch {
			body = null;
		}
		const action = body === null ? null : slackAgentStep(match[1]!, body);
		if (action) actions.push(action);
	}
	return { text: kept.join('\n').trim(), actions };
}
/**
 * spec/notifications-slack-notes-and-schedules#slack-agent: «ACK: Пішов дивитись…» — the line the agent writes before it looks something
 * up; the bot posts it at once. `null` while the first line is not finished, or is no ACK.
 */
export function slackAckOf(streamed: string): { ack: string; rest: string } | null {
	const match = /^\s*ACK:\s*([^\n]*)\n([\s\S]*)$/.exec(streamed);
	return match && match[1]!.trim() ? { ack: match[1]!.trim(), rest: match[2]! } : null;
}
/** The final text without an ACK line it may still start with (an answer that ended right after it). */
export function slackWithoutAck(answer: string): string {
	return answer.replace(/^\s*ACK:[^\n]*(\n|$)/, '');
}
