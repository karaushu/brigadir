import type { AgentEvent, AgentProvider } from './agent';
import type { Locale } from './messages';

/**
 * spec/settings-modules-and-onboarding#brigadir-chat: the Brigadir chat — the rail section's chats with Brigadir's own agent. Each chat is
 * `assistant/chats/<id>/chat.json` (title, times) and `events.jsonl`: the person's messages, the agent's normalized events (rule 2), the
 * cards its tools showed (each new state of a card is a new row with the same card id) and the end of each answer.
 */
export type BrigadirChatChoice = { provider: AgentProvider; model: string | null };
export type BrigadirCardValue = string | number | boolean | null;
export type BrigadirCard =
	| {
			type: 'setting';
			id: string;
			key: string;
			place: string;
			before: BrigadirCardValue;
			after: BrigadirCardValue;
			/** `pending` waits for Apply; `done` saved; `undone` put back; `cancelled` the person said no. */
			state: 'pending' | 'done' | 'undone' | 'cancelled';
			/** Set for a pending change: what turning it on or off removes or allows. */
			fact?: string;
	  }
	| { type: 'steps'; id: string; setup: BrigadirSetupKind; title: string; steps: BrigadirStep[] }
	| {
			type: 'secret';
			id: string;
			kind: BrigadirSecretKind;
			state: 'waiting' | 'checking' | 'connected' | 'scopes' | 'error' | 'closed';
			/** The check's result as the card says it: `@Jarvis · acme`, the missing scopes, Slack's error. Never the value. */
			result?: string;
			/** A link that fixes what the check found (the app's OAuth page). */
			link?: string;
	  }
	| {
			type: 'link';
			id: string;
			url: string;
			label: string;
			title: string;
			detail: string;
			opened: boolean;
	  }
	/** spec/todo-and-slack-inbox#todo-chat-tools: a to-do the agent added; `Open list` shows the list in the Todo section. */
	| {
			type: 'todo';
			id: string;
			list: string;
			item: string;
			title: string;
			listName: string;
			project: string | null;
	  }
	/** A note the agent saved; `Open note` shows it on the Notes screen. */
	| { type: 'note'; id: string; note: string; title: string; project: string | null }
	/** A watched event of a task: CI ended, its PR merged, a turn ended, the task completed. */
	| {
			type: 'event';
			id: string;
			text: string;
			tone: 'green' | 'red' | 'amber' | 'accent';
			link: string | null;
			task: { projectId: string; id: string } | null;
	  }
	| {
			type: 'task';
			id: string;
			project: string;
			title: string;
			prompt: string;
			base: string | null;
			state: 'proposed' | 'started' | 'declined';
			task?: { projectId: string; id: string };
	  };
export type BrigadirSetupKind = 'slack' | 'remoteAccess';
export type BrigadirSecretKind = 'slackBotToken' | 'slackAppToken';
export type BrigadirStep = { name: string; detail: string; done: boolean };
export type BrigadirChatEntry =
	| { kind: 'prompt'; text: string; choice?: BrigadirChatChoice }
	| { kind: 'event'; event: AgentEvent }
	| { kind: 'card'; card: BrigadirCard }
	| { kind: 'done'; milliseconds: number; stopped: boolean }
	| { kind: 'failed'; message: string };
export type BrigadirChatRow = { seq: number; at: string } & BrigadirChatEntry;
export type BrigadirChatMeta = {
	id: string;
	title: string;
	createdAt: string;
	updatedAt: string;
	archived: boolean;
};
export type BrigadirChatState = {
	meta: BrigadirChatMeta;
	rows: BrigadirChatRow[];
	busy: boolean;
	choice: BrigadirChatChoice | null;
};
export type BrigadirSetupState = {
	kind: BrigadirSetupKind;
	/** `Not set up`, `3 of 5 · Bot token`, `On · LAN`: the list's second line. */
	status: string;
	done: boolean;
	/** The chat that runs it, to open on a click. */
	chat: string | null;
};
export type BrigadirChatEvent =
	| { kind: 'row'; id: string; row: BrigadirChatRow }
	| { kind: 'busy'; id: string; busy: boolean }
	| {
			kind: 'list';
			chats: BrigadirChatMeta[];
			archived: BrigadirChatMeta[];
			setups: BrigadirSetupState[];
	  };
export const brigadirChatLimits = { message: 20_000, title: 80 } as const;
const record = (value: unknown): value is Record<string, unknown> =>
	typeof value === 'object' && value !== null && !Array.isArray(value);
const cardTypes = new Set(['setting', 'steps', 'secret', 'link', 'task', 'note', 'event', 'todo']);
export function isBrigadirChatRow(value: unknown): value is BrigadirChatRow {
	if (!record(value) || !Number.isSafeInteger(value.seq) || typeof value.at !== 'string')
		return false;
	switch (value.kind) {
		case 'prompt':
			return typeof value.text === 'string';
		case 'event':
			return record(value.event) && typeof value.event.kind === 'string';
		case 'card':
			return (
				record(value.card) &&
				cardTypes.has(value.card.type as string) &&
				typeof value.card.id === 'string'
			);
		case 'done':
			return typeof value.milliseconds === 'number' && typeof value.stopped === 'boolean';
		case 'failed':
			return typeof value.message === 'string';
		default:
			return false;
	}
}
export function isBrigadirChatMeta(value: unknown): value is BrigadirChatMeta {
	return (
		record(value) &&
		typeof value.id === 'string' &&
		/^[a-z0-9-]{8,64}$/.test(value.id) &&
		typeof value.title === 'string' &&
		typeof value.createdAt === 'string' &&
		typeof value.updatedAt === 'string' &&
		typeof value.archived === 'boolean'
	);
}
/** The latest state of each card, in the order the cards first appeared. */
export function brigadirCards(rows: readonly BrigadirChatRow[]): BrigadirCard[] {
	const cards = new Map<string, BrigadirCard>();
	for (const row of rows) if (row.kind === 'card') cards.set(row.card.id, row.card);
	return [...cards.values()];
}
/** A chat with no title yet is named from its first message. */
export function brigadirChatTitle(text: string): string {
	const line = text.trim().split('\n')[0]!.replace(/\s+/g, ' ');
	return line.length > brigadirChatLimits.title
		? `${line.slice(0, brigadirChatLimits.title - 1)}…`
		: line;
}
const cut = (text: string, limit: number) =>
	text.length > limit ? `${text.slice(0, limit)}…` : text;
/**
 * spec/settings-modules-and-onboarding#brigadir-chat-session: the first message of a chat's session (English, rule 12). Later messages go as
 * the person wrote them; the task list is refreshed with each one (`brigadirChatFollowUp`).
 */
export function brigadirChatPrompt(input: {
	text: string;
	language: Locale;
	today: string;
	project: string | null;
	projects: { name: string; path: string }[];
	facts: string;
	settings: string;
	setups: string;
	/** spec/todo-and-slack-inbox#todo-chat-tools: the Todo module is on, so todo_add and todo_lists are there. */
	todo?: boolean;
}): string {
	const fallback = input.language === 'uk' ? 'Ukrainian' : 'English';
	return [
		"You are Brigadir's own agent in its Brigadir chat. The person asks you about their tasks and code in any project, asks for work, or asks to change Brigadir itself (its settings, a Slack bot, remote access). Answer, look things up read-only, or act with Brigadir's tools.",
		input.project
			? `Open project: ${cut(input.project, 200)} — this directory.`
			: 'No project is open; this directory is the first project.',
		input.projects.length
			? `Every project (name — folder):\n${input.projects.map((item) => `- ${cut(item.name, 200)} — ${cut(item.path, 500)}`).join('\n')}`
			: 'No projects yet.',
		`Now: ${input.today}.`,
		`Brigadir's tasks (id, title, project, state, branch, PR, CI):\n${input.facts.trim() ? cut(input.facts, 12_000) : '(none)'}`,
		`Brigadir's settings you may change with settings_set (key (place): values; now):\n${input.settings}`,
		...(input.setups.trim()
			? [`Setups left unfinished — offer to go on with them when it fits:\n${input.setups}`]
			: []),
		'How to work:',
		'- Answer from the tasks above when they tell enough. Otherwise find it yourself: read the code and run commands that only read (git log, git show, gh pr list, gh run list, gh run view). Never tell the person to check what you can check. You may not edit files or run anything that changes state: such commands are declined.',
		'- To change Brigadir, use settings_set; to see the keys, settings_find. Change only what was asked. To set up Slack or remote access, use setup_start and follow the steps it returns; ask for every token with secret_request, never in the chat.',
		"- New work: create_task. A change to work a task covers: send_to_task. Why something was done in a task: ask_task. To save their words or a summary as a note: note. To tell them here later when a task's CI ends, its PR is merged or it is done: watch.",
		...(input.todo
			? [
					"- A to-do for the person (something they must do, not an agent): todo_add, in the list they name or the project's latest list. To see their lists and what is open: todo_lists.",
				]
			: []),
		'- Only what a tool returned happened: never say a setting changed, a task was made or a token connected before the tool said so. When a tool fails, say so in one line and what to do.',
		`- Answer in the language the person writes in (when it is unclear, ${fallback}), short, in Markdown. Code only where it helps.`,
		`Message:\n${cut(input.text, 20_000)}`,
	].join('\n\n');
}
/** spec/settings-modules-and-onboarding#brigadir-chat-entry: the Helper agent names a chat from its first message (English prompt, rule 12). */
export function brigadirTitlePrompt(text: string): string {
	return [
		'Name this chat in 2 to 6 words, in the language the message is written in. Write only the name: no quotes, no period, no emoji.',
		`Message:\n${cut(text, 2000)}`,
	].join('\n\n');
}
/** The Helper agent's name, cleaned; null when it gave nothing usable. */
export function brigadirTitleOf(said: string | null): string | null {
	const line = (said ?? '')
		.trim()
		.split('\n')[0]!
		.replace(/^["'«“]+|["'»”.]+$/g, '')
		.trim();
	return line && line.length <= brigadirChatLimits.title ? line : null;
}
/** A later message of the same chat: the refreshed tasks, then the message. */
export function brigadirChatFollowUp(input: { text: string; facts: string }): string {
	return [
		`Brigadir's tasks now:\n${input.facts.trim() ? cut(input.facts, 12_000) : '(none)'}`,
		`Message:\n${cut(input.text, 20_000)}`,
	].join('\n\n');
}
/**
 * spec/settings-modules-and-onboarding#slack-setup: the Slack app manifest of the person's own bot — every scope and event Brigadir uses,
 * Socket Mode and Interactivity on, the Messages tab for DMs — and the link that creates it at api.slack.com.
 */
export const slackBotScopes = [
	'chat:write',
	'users:read',
	'channels:read',
	'groups:read',
	'app_mentions:read',
	'channels:history',
	'groups:history',
	'im:history',
] as const;
export const slackBotEvents = [
	'app_mention',
	'message.channels',
	'message.groups',
	'message.im',
] as const;
export function slackManifest(name: string) {
	const shown = name.trim().slice(0, 35) || 'Brigadir';
	return {
		display_information: {
			name: shown,
			description: 'Brigadir on this computer: tasks, notes and answers in Slack.',
		},
		features: {
			app_home: {
				home_tab_enabled: false,
				messages_tab_enabled: true,
				messages_tab_read_only_enabled: false,
			},
			bot_user: { display_name: shown, always_online: true },
		},
		oauth_config: { scopes: { bot: [...slackBotScopes] } },
		settings: {
			event_subscriptions: { bot_events: [...slackBotEvents] },
			interactivity: { is_enabled: true },
			org_deploy_enabled: false,
			socket_mode_enabled: true,
			token_rotation_enabled: false,
		},
	};
}
export function slackManifestLink(name: string): string {
	return `https://api.slack.com/apps?new_app=1&manifest_json=${encodeURIComponent(JSON.stringify(slackManifest(name)))}`;
}
/** Only links a setup builds open from the chat: Slack's own app pages. */
export function isBrigadirSetupLink(url: string): boolean {
	return /^https:\/\/api\.slack\.com\/apps(?:[/?#]|$)/.test(url) && !/[\s<>"]/.test(url);
}
/** The scopes a bot token lacks, from Slack's `x-oauth-scopes` header. */
export function missingSlackScopes(granted: string | null): string[] {
	const have = new Set(
		(granted ?? '')
			.split(',')
			.map((scope) => scope.trim())
			.filter(Boolean)
	);
	return slackBotScopes.filter((scope) => !have.has(scope));
}
