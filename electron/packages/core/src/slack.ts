import { isRecord } from './workspace';
import type { AgentProviderId, HelperRun } from './settings';
/**
 * spec/notifications-slack-notes-and-schedules#slack: Slack — the team's own CI bot (the watch-ci skill) posts the app's events. Settings live in `settings.json`;
 * the bot token never does — it is sealed in the Keychain or read from `SLACK_CI_BOT_TOKEN` / a project's `.env.local`.
 */
/** `taskDone` is the end of a turn (shown «Turn ended»); `taskCompleted` — the task moved to Completed. */
export const slackEvents = [
	'ci',
	'prMerged',
	'needsYou',
	'taskDone',
	'taskCompleted',
	'scheduleFailed',
] as const;
export type SlackEvent = (typeof slackEvents)[number];
/** Where a project's messages go: `channel` empty — a DM to the member ID; `mention` — a user group like `<!subteam^S…>`. */
export type SlackRoute = { channel: string; mention: string };
/**
 * spec/notifications-slack-notes-and-schedules#slack: `@ mentions in Slack` — `on` listens over Socket Mode; `who` — the listed people (and the person's own member
 * ID) or anyone in the channel; `start` — a new task starts at once or waits for the person in Brigadir.
 */
export type SlackMentions = {
	on: boolean;
	who: 'people' | 'anyone';
	people: string[];
	start: 'start' | 'ask';
	/**
	 * spec/notifications-slack-notes-and-schedules#slack: the agent of a task made from Slack — provider, model, effort (null: the model's own);
	 * `null` — the same as the app (the Default agent with its catalog's own model).
	 */
	agent: HelperRun | null;
};
export type SlackSettings = {
	/** The person's Slack member ID (`U…`) — the DM target; empty until set. */
	memberId: string;
	events: Record<SlackEvent, boolean>;
	/** Project id → its route; a project without one sends DMs. */
	projects: Record<string, SlackRoute>;
	mentions: SlackMentions;
};
export const defaultSlackMentions: SlackMentions = {
	on: false,
	who: 'people',
	people: [],
	start: 'start',
	agent: null,
};
export const defaultSlackSettings: SlackSettings = {
	memberId: '',
	events: {
		ci: true,
		prMerged: true,
		needsYou: true,
		taskDone: false,
		taskCompleted: true,
		scheduleFailed: true,
	},
	projects: {},
	mentions: defaultSlackMentions,
};
const peopleLimit = 200;
const memberIdPattern = /^[UW][A-Z0-9]{2,}$/;
export function isSlackMemberId(value: string): boolean {
	return memberIdPattern.test(value);
}
function isRoute(value: unknown): value is SlackRoute {
	return (
		isRecord(value) &&
		Object.keys(value).length === 2 &&
		typeof value.channel === 'string' &&
		value.channel.length <= 80 &&
		typeof value.mention === 'string' &&
		value.mention.length <= 80
	);
}
const agentText = (value: unknown) =>
	typeof value === 'string' && value.length > 0 && value.length <= 200;
function isSlackAgent(value: unknown): value is HelperRun {
	return (
		isRecord(value) &&
		Object.keys(value).length === 3 &&
		(value.provider === 'claude' || value.provider === 'codex') &&
		agentText(value.model) &&
		(value.effort === null || agentText(value.effort))
	);
}
function isMentions(value: unknown): value is SlackMentions {
	return (
		isRecord(value) &&
		Object.keys(value).length === 5 &&
		(value.agent === null || isSlackAgent(value.agent)) &&
		typeof value.on === 'boolean' &&
		(value.who === 'people' || value.who === 'anyone') &&
		(value.start === 'start' || value.start === 'ask') &&
		Array.isArray(value.people) &&
		value.people.length <= peopleLimit &&
		value.people.every((id) => typeof id === 'string' && isSlackMemberId(id)) &&
		new Set(value.people).size === value.people.length
	);
}
export function isSlackSettings(value: unknown): value is SlackSettings {
	return (
		isRecord(value) &&
		Object.keys(value).length === 4 &&
		isMentions(value.mentions) &&
		typeof value.memberId === 'string' &&
		(value.memberId === '' || isSlackMemberId(value.memberId)) &&
		isRecord(value.events) &&
		Object.keys(value.events).length === slackEvents.length &&
		slackEvents.every(
			(event) => typeof (value.events as Record<string, unknown>)[event] === 'boolean'
		) &&
		isRecord(value.projects) &&
		Object.values(value.projects).every(isRoute)
	);
}
/** A file from before an event existed takes its default; anything that is not settings is kept as read. */
export function withSlackDefaults(value: unknown): unknown {
	return isRecord(value)
		? {
				...defaultSlackSettings,
				...value,
				events: { ...defaultSlackSettings.events, ...(isRecord(value.events) ? value.events : {}) },
				mentions: {
					...defaultSlackMentions,
					people: [],
					...(isRecord(value.mentions) ? value.mentions : {}),
				},
			}
		: value;
}

/**
 * The agent of a task made from Slack: the Slack setting while its provider is on and a known catalog still lists its model,
 * else the app's Default agent (`run: null` — the catalog's own model and effort).
 */
export function slackTaskAgent(
	mentions: Pick<SlackMentions, 'agent'>,
	enabled: Record<AgentProviderId, boolean>,
	defaultProvider: AgentProviderId,
	models: Partial<Record<AgentProviderId, readonly string[] | null>> = {}
): { provider: AgentProviderId; run: HelperRun | null } {
	const own = mentions.agent;
	if (own && enabled[own.provider]) {
		const known = models[own.provider];
		if (!known || known.includes(own.model)) return { provider: own.provider, run: own };
	}
	return { provider: defaultProvider, run: null };
}

/** Where the bot token came from; the token itself never leaves main. */
export type SlackTokenSource = 'keychain' | 'env' | 'file';
/**
 * spec/notifications-slack-notes-and-schedules#slack: `@ mentions in Slack` — `off` (the switch or the module off), `no-token` (no App-Level Token yet),
 * `connecting`, `on` (Socket Mode said hello), `token` (Slack refused the app token), `down` (reconnecting).
 */
export type SlackListen =
	| { state: 'off' }
	| { state: 'no-token' }
	| { state: 'connecting' }
	| { state: 'on' }
	| { state: 'token'; error: string }
	| { state: 'down' };
/**
 * Settings ▸ Modules ▸ Slack ▸ Bot: `off` — no token anywhere; `checking`; `on` — `auth.test` passed; `token` — Slack said
 * the token is no longer valid; `down` — Slack could not be reached, messages wait (`waiting`). `listen` — the mentions;
 * `appToken` — an App-Level Token is sealed (never the token itself).
 */
export type SlackState = SlackBotState & { listen: SlackListen; appToken: boolean };
export type SlackBotState =
	| { state: 'off' }
	| { state: 'checking'; source: SlackTokenSource; file: string | null }
	| { state: 'on'; source: SlackTokenSource; file: string | null; bot: string; team: string }
	| { state: 'token'; source: SlackTokenSource; file: string | null; error: string }
	| { state: 'down'; source: SlackTokenSource; file: string | null; waiting: number };

/** `SLACK_CI_BOT_TOKEN=…` from a dotenv file; quotes and `export` are allowed, comments are not values. */
export function dotenvToken(text: string, name = 'SLACK_CI_BOT_TOKEN'): string | null {
	for (const line of text.split(/\r?\n/)) {
		const match = /^\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$/.exec(line);
		if (!match || match[1] !== name) continue;
		let value = match[2]!.trim();
		if (/^(['"]).*\1$/.test(value)) value = value.slice(1, -1);
		else value = value.replace(/\s+#.*$/, '');
		return isBotToken(value) ? value : null;
	}
	return null;
}
export function isBotToken(value: string): boolean {
	return /^xoxb-[A-Za-z0-9-]{10,}$/.test(value);
}
/** spec/notifications-slack-notes-and-schedules#slack: the App-Level Token of Socket Mode (`connections:write`). */
export function isAppToken(value: string): boolean {
	return /^xapp-[A-Za-z0-9-]{10,}$/.test(value);
}

/** The task a message is about: its title stands in `📋 Task`, the thread is keyed by it. */
export type SlackTaskRef = { projectId: string; id: string; title: string };
export type SlackNotice =
	| {
			kind: 'ci';
			state: 'pass' | 'fail' | 'cancelled';
			repo: string;
			branch: string;
			/** The deployment's environment when the run had one; else it follows the branch. */
			environment: string | null;
			task: SlackTaskRef | null;
			seconds: number | null;
			link: string;
			/** The first failure annotation, 1–3 lines. */
			error: string | null;
	  }
	| {
			kind: 'prMerged';
			repo: string;
			head: string;
			base: string;
			task: SlackTaskRef | null;
			number: number;
			url: string;
	  }
	| {
			kind: 'needsYou';
			repo: string;
			branch: string;
			task: SlackTaskRef;
			reason: string;
			/** spec/notifications-slack-notes-and-schedules#slack: the request Slack can answer — its buttons; without it the message says «answer in Brigadir». */
			ask?: SlackAsk;
	  }
	| { kind: 'taskDone'; repo: string; branch: string; task: SlackTaskRef; summary: string | null }
	| { kind: 'taskCompleted'; repo: string; branch: string; task: SlackTaskRef }
	| { kind: 'scheduleFailed'; schedule: string; project: string; reason: string }
	/** spec/notifications-slack-notes-and-schedules#schedules: a schedule's «Ask» — missed runs wait for `Run now` · `Skip`; posted under the Needs you event. */
	| {
			kind: 'scheduleAsk';
			projectId: string;
			scheduleId: string;
			schedule: string;
			project: string;
			count: number;
	  };
/**
 * spec/notifications-slack-notes-and-schedules#slack: a Needs you request with buttons in Slack — a permission's one-time `Allow` · `Deny` (the options the OS
 * notification offers) or a question's few single choices. `tool` — the tool's title, as the OS notification shows it.
 */
export type SlackAsk =
	| { kind: 'permission'; request: string; tool: string | null; options: ('allow' | 'deny')[] }
	| { kind: 'question'; request: string; question: string; options: string[] };
export function slackNoticeEvent(notice: SlackNotice): SlackEvent {
	return notice.kind === 'scheduleAsk' ? 'needsYou' : notice.kind;
}

/** A user group's mention from its ID (`S…`) or a pasted `<!subteam^S…>`; anything else mentions no one. */
export function slackMention(value: string): string {
	const id = /^<!subteam\^([A-Z0-9]+)(?:\|[^>]*)?>$/.exec(value.trim())?.[1] ?? value.trim();
	return /^S[A-Z0-9]{2,}$/.test(id) ? `<!subteam^${id}>` : '';
}
/** Slack mrkdwn escapes only these three. */
export function slackEscape(text: string): string {
	return text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}
function link(url: string, label: string): string {
	return `<${url.replace(/[<>|]/g, '')}|${slackEscape(label).replace(/\|/g, '¦')}>`;
}
/** watch-ci: staging → Staging, main/master → Production, anything else is the branch. */
export function slackEnvironment(branch: string): string {
	return branch === 'staging'
		? 'Staging'
		: branch === 'main' || branch === 'master'
			? 'Production'
			: branch;
}
/** `⏱️ Duration`: `6m 12s`, `45s`, `1h 2m`. */
export function slackDuration(seconds: number): string {
	const s = Math.max(0, Math.round(seconds));
	if (s < 60) return `${s}s`;
	if (s < 3600) return `${Math.floor(s / 60)}m ${s % 60}s`;
	return `${Math.floor(s / 3600)}h ${Math.floor((s % 3600) / 60)}m`;
}
const code = (text: string) => `\`${text.replace(/`/g, "'")}\``;
const clip = (text: string, limit: number) =>
	text.length > limit ? `${text.slice(0, limit - 1).trimEnd()}…` : text;
/** `repo (branch)`; a task without a branch of its own (the project's tree) names the repo only. */
const where = (repo: string, branch: string) =>
	branch.trim() ? `${slackEscape(repo)} (${code(branch)})` : slackEscape(repo);
const taskLine = (task: SlackTaskRef | null) =>
	task ? `📋 Task: ${slackEscape(task.title)}` : null;

/**
 * spec/notifications-slack-notes-and-schedules#slack: the watch-ci lines — status — repo (branch), 🌐 Environment, 📋 Task, ⏱️ Duration; 🔗 View run and the error
 * only when the run did not pass. The other events use the same shape. No code, no diff. Text only (mrkdwn), no blocks.
 */
export function slackText(notice: SlackNotice, mention = ''): string {
	const lines: (string | null)[] = mention ? [mention] : [];
	switch (notice.kind) {
		case 'ci': {
			const head =
				notice.state === 'pass'
					? '✅ *CI passed*'
					: notice.state === 'fail'
						? '❌ *CI failed*'
						: '⚠️ *CI cancelled*';
			lines.push(
				`${head} — ${where(notice.repo, notice.branch)}`,
				`🌐 Environment: *${slackEscape(notice.environment ?? slackEnvironment(notice.branch))}*`,
				taskLine(notice.task),
				notice.seconds === null ? null : `⏱️ Duration: ${slackDuration(notice.seconds)}`
			);
			if (notice.state !== 'pass') {
				lines.push(`🔗 ${link(notice.link, 'View run')}`);
				const error = notice.error
					?.split(/\r?\n/)
					.filter((line) => line.trim())
					.slice(0, 3)
					.join('\n')
					.replace(/```/g, "'''");
				if (error) lines.push('```' + error + '```');
			}
			break;
		}
		case 'prMerged':
			lines.push(
				`🔀 *PR merged* — ${slackEscape(notice.repo)} (${code(`${notice.head} → ${notice.base}`)})`,
				taskLine(notice.task),
				`🔗 ${link(notice.url, `#${notice.number} on GitHub`)}`
			);
			break;
		case 'needsYou':
			lines.push(
				`🙋 *Needs you* — ${where(notice.repo, notice.branch)}`,
				taskLine(notice.task),
				notice.ask?.kind === 'permission'
					? `🔐 ${slackEscape(notice.reason)}${notice.ask.tool ? `: ${code(slackEscape(clip(notice.ask.tool.replace(/\s+/g, ' '), 200)))}` : ''}`
					: notice.ask?.kind === 'question'
						? `❓ ${slackEscape(clip(notice.ask.question, 500))}`
						: `💬 ${slackEscape(notice.reason)} · answer in Brigadir`
			);
			break;
		case 'taskDone':
			lines.push(
				`🏁 *Turn ended* — ${where(notice.repo, notice.branch)}`,
				taskLine(notice.task),
				notice.summary ? `📝 ${slackEscape(notice.summary)}` : null
			);
			break;
		case 'taskCompleted':
			lines.push(
				`✅ *Task completed* — ${where(notice.repo, notice.branch)}`,
				taskLine(notice.task)
			);
			break;
		case 'scheduleFailed':
			lines.push(
				`⛔ *Scheduled run failed* — ${slackEscape(notice.project)}`,
				`🗓️ Schedule: ${slackEscape(notice.schedule)}`,
				`💬 ${slackEscape(notice.reason)}`
			);
			break;
		case 'scheduleAsk':
			lines.push(
				`🙋 *Needs you* — ${slackEscape(notice.project)}`,
				`🗓️ Schedule: ${slackEscape(notice.schedule)}`,
				`💬 ${notice.count === 1 ? '1 run missed' : `${notice.count} runs missed`} · run once now or skip?`
			);
			break;
	}
	return lines.filter((line): line is string => line !== null).join('\n');
}
