import type { ToolPatch } from './agent';
import type { Locale } from './messages';
import { isRecord } from './workspace';
import {
	commandCount,
	commentCount,
	fileCount,
	isMessageKey,
	planLinesLabel,
	planPartCountLabel,
	selectedLineCount,
	t,
	taskCount,
	type MessageKey,
} from './messages';
import { isBuiltinCrewName } from './crew';
import { toolOutput } from './tool-output';
/**
 * spec/chat#mcp-calls: a call of an MCP tool, read from the provider's own spelling. Claude names it `mcp__<server>__<tool>`
 * (`_meta.claudeCode.toolName`); Codex sends no name and titles it `mcp.<server>.<tool>` with `rawInput`
 * `{server, tool, arguments}`. Nothing here knows the provider: both spellings are parsed the same way.
 */
export type McpCall = { server: string; tool: string; args: Record<string, unknown> };
const claudeName = /^mcp__(.+?)__(.+)$/,
	codexTitle = /^mcp\.([^.\s]+)\.(\S+)$/;
function parse(text: string | undefined): unknown {
	if (!text) return undefined;
	try {
		return JSON.parse(text);
	} catch {
		return undefined;
	}
}
export function mcpCall(tool: ToolPatch): McpCall | null {
	const input = parse(tool.input);
	const claude = (tool.name ?? tool.title ?? '').match(claudeName);
	if (claude) return { server: claude[1]!, tool: claude[2]!, args: isRecord(input) ? input : {} };
	const codex = (tool.title ?? '').trim().match(codexTitle);
	if (codex) {
		const args = isRecord(input) && isRecord(input.arguments) ? input.arguments : {};
		return { server: codex[1]!, tool: codex[2]!, args };
	}
	return null;
}
/** The text the tool answered with; our server answers JSON, another server whatever it likes. */
export function mcpResultText(tool: ToolPatch): string {
	return toolOutput(tool).text.trim();
}
export function mcpResult(tool: ToolPatch): unknown {
	const text = mcpResultText(tool);
	return text ? (parse(text) ?? text) : undefined;
}

export type McpModule =
	'crew' | 'human' | 'browser' | 'simulator' | 'pr' | 'editor' | 'commands' | 'console';
export type McpState = 'running' | 'done' | 'failed' | 'interrupted';
/** Second-line segments: plain text, code (paths, URLs, ids), change counts. */
export type McpSegment = { kind: 'text' | 'code' | 'added' | 'removed'; text: string };
export type McpRow = {
	/** `null` — another server: its name and the tool name stay as the server spelled them (rule 7). */
	module: McpModule | null;
	title: string;
	who: string | null;
	detail: McpSegment[];
	fields: { label: string; value: string }[];
	text: string | null;
	/** A worker report (`read_report`): its files with counts and the worker's last message. */
	files: { path: string; status: string; added: number; removed: number }[];
	message: string | null;
	/** `text` is a unified diff (`read_diff` of one file): the row colours its lines. */
	diff: boolean;
};
/** The person who reads the log knows the crew by its agents; the host speaks of task ids. */
export type McpWorker = { name: string; title: string };

type Verbs = readonly [MessageKey, MessageKey, MessageKey];
const verbs = {
	propose_plan: ['Proposing a split', 'Proposed a split', 'Could not propose a split'],
	create_worker_task: ['Assigning a part', 'Assigned a part', 'Could not assign the part'],
	prompt_task: ['Sending a prompt', 'Sent a prompt', 'Could not send the prompt'],
	task_status: ['Checking the status', 'Checked the status', 'Could not get the status'],
	read_report: ['Reading the report', 'Read the report', 'Could not read the report'],
	read_transcript: ['Reading the chat', 'Read the chat', 'Could not read the chat'],
	read_diff: ['Reading the changes', 'Read the changes', 'Could not read the changes'],
	submit_review: ['Sending the review', 'Sent the review', 'Could not send the review'],
	approve: ['Approving the work', 'Approved the work', 'Could not approve the work'],
	accept_task: ['Accepting the part', 'Accepted the part', 'Could not accept the part'],
	ask_foreman: ['Asking the foreman', 'Asked the foreman', 'Could not ask the foreman'],
	post_note: ['Writing a log entry', 'Left a log entry', 'Could not leave the log entry'],
	read_notes: ['Reading the crew log', 'Read the crew log', 'Could not read the crew log'],
	ask_user: ['Asking you', 'Asked you', 'Could not ask you'],
	create_task: ['Proposing a task', 'Proposed a task', 'Could not propose a task'],
	add_folder: ['Adding a folder', 'Added a folder', 'Could not add the folder'],
	slack_post: ['Posting to Slack', 'Posted to Slack', 'Could not post to Slack'],
	tasks_list: ['Looking up tasks', 'Looked up tasks', 'Could not look up tasks'],
	task_send: ['Writing to a task', 'Wrote to a task', 'Could not write to the task'],
	propose_review: ['Offering a review', 'Offered a review', 'Could not offer a review'],
	browser_open: ['Opening the page', 'Opened the page', 'Could not open the page'],
	browser_state: ['Checking the browser', 'Checked the browser', 'Could not check the browser'],
	browser_read: ['Reading the page', 'Read the page', 'Could not read the page'],
	browser_console: [
		'Reading the page console',
		'Read the page console',
		'Could not read the page console',
	],
	browser_network: [
		'Reading the page requests',
		'Read the page requests',
		'Could not read the page requests',
	],
	browser_screenshot: [
		'Taking a page screenshot',
		'Took a page screenshot',
		'Could not take a page screenshot',
	],
	browser_ui: [
		'Reading the page elements',
		'Read the page elements',
		'Could not read the page elements',
	],
	browser_act: ['Acting on the page', 'Acted on the page', 'Could not act on the page'],
	browser_show: ['Asking to show the page', 'Asked to show the page', 'Could not show the page'],
	simulator_state: [
		'Checking the simulator',
		'Checked the simulator',
		'Could not check the simulator',
	],
	simulator_open: [
		'Starting the simulator',
		'Started the simulator',
		'Could not start the simulator',
	],
	simulator_ui: ['Reading the screen', 'Read the screen', 'Could not read the screen'],
	simulator_act: ['Tapping', 'Tapped', 'Could not act on the simulator'],
	simulator_screenshot: [
		'Taking a simulator screenshot',
		'Took a simulator screenshot',
		'Could not take a simulator screenshot',
	],
	simulator_logs: ['Reading the app logs', 'Read the app logs', 'Could not read the app logs'],
	simulator_network: [
		'Reading the app requests',
		'Read the app requests',
		'Could not read the app requests',
	],
	pr_comment: [
		'Writing a draft comment',
		'Left a draft comment',
		'Could not save the draft comment',
	],
	pr_comment_reply: [
		'Replying in the thread',
		'Replied in the thread',
		'Could not reply in the thread',
	],
	editor_state: ['Looking at your editor', 'Looked at your editor', 'Could not see your editor'],
	editor_restart_language_servers: [
		'Restarting the language servers',
		'Restarted the language servers',
		'Could not restart the language servers',
	],
	pr_state: ['Looking at the PR', 'Looked at the PR', 'Could not read the PR'],
	commands_list: [
		'Checking the project commands',
		'Checked the project commands',
		'Could not read the project commands',
	],
	commands_run: ['Running a command', 'Ran a command', 'Could not run the command'],
	commands_output: [
		'Reading the command output',
		'Read the command output',
		'Could not read the command output',
	],
	commands_stop: ['Stopping a command', 'Stopped a command', 'Could not stop the command'],
	console_list: ['Checking the console', 'Checked the console', 'Could not read the console'],
	console_read: ['Reading the console', 'Read the console', 'Could not read the console'],
} as const satisfies Record<string, Verbs>;
export type BrigadirTool = keyof typeof verbs;
export const brigadirTools = Object.keys(verbs) as BrigadirTool[];
const answerVerbs: Verbs = [
	'Answering the worker',
	'Answered the worker',
	'Could not send the answer',
];
/** spec/browser-and-simulator#browser-ui-act: the browser's actions; typing and keys read as on the device. */
const pageVerbs: Record<string, readonly [MessageKey, MessageKey]> = {
	click: ['Clicking', 'Clicked'],
	hover: ['Hovering', 'Hovered'],
	type: ['Typing text', 'Typed text'],
	key: ['Pressing a key', 'Pressed a key'],
	scroll: ['Scrolling the page', 'Scrolled the page'],
	select: ['Choosing an option', 'Chose an option'],
	back: ['Going back', 'Went back'],
	forward: ['Going forward', 'Went forward'],
	reload: ['Reloading the page', 'Reloaded the page'],
	dialog: ['Setting the dialog answer', 'Set the dialog answer'],
	clipboard: ['Reading the task clipboard', 'Read the task clipboard'],
	paste: ['Pasting text', 'Pasted text'],
};
const actVerbs: Record<string, readonly [MessageKey, MessageKey]> = {
	tap: ['Tapping', 'Tapped'],
	longpress: ['Long-pressing', 'Long-pressed'],
	swipe: ['Swiping', 'Swiped'],
	type: ['Typing text', 'Typed text'],
	key: ['Pressing a key', 'Pressed a key'],
	button: ['Pressing a button', 'Pressed a button'],
	rotate: ['Rotating the simulator', 'Rotated the simulator'],
};
export function mcpModule(tool: string): McpModule {
	if (
		tool === 'ask_user' ||
		tool === 'create_task' ||
		tool === 'add_folder' ||
		tool === 'slack_post' ||
		tool === 'tasks_list' ||
		tool === 'task_send' ||
		tool === 'propose_review'
	)
		return 'human';
	if (tool === 'editor_state' || tool === 'editor_restart_language_servers') return 'editor';
	if (tool.startsWith('browser_')) return 'browser';
	if (tool.startsWith('simulator_')) return 'simulator';
	if (tool.startsWith('pr_')) return 'pr';
	if (tool.startsWith('commands_')) return 'commands';
	if (tool.startsWith('console_')) return 'console';
	return 'crew';
}
/** Ours: the app's own server `brigadir` (spec/crew#task-type). Its tools have our names; any other server keeps its own. */
export function isBrigadirTool(call: McpCall): call is McpCall & { tool: BrigadirTool } {
	return call.server === 'brigadir' && Object.hasOwn(verbs, call.tool);
}
/** spec/agents-and-providers#tool-permissions: the agent's permission card never stands before our tools; where the person must agree, the host asks with its own card. */
export function skipsAgentPermission(tool: ToolPatch): boolean {
	const call = mcpCall(tool);
	return !!call && isBrigadirTool(call);
}

function verbsOf(call: McpCall & { tool: BrigadirTool }): Verbs {
	if (
		call.tool === 'prompt_task' &&
		typeof call.args.questionId === 'string' &&
		call.args.questionId
	)
		return answerVerbs;
	if (call.tool === 'browser_act') {
		const act = pageVerbs[String(call.args.action)];
		if (act) return [act[0], act[1], verbs.browser_act[2]];
	}
	if (call.tool === 'simulator_act') {
		const act = actVerbs[String(call.args.action)];
		if (act) return [act[0], act[1], verbs.simulator_act[2]];
	}
	return verbs[call.tool];
}
/** The row's first line by state: `Приймає частину` → `Прийняв частину`; a failed or stopped call says what did not happen. */
export function mcpVerb(locale: Locale, call: McpCall, state: McpState): string {
	if (!isBrigadirTool(call)) {
		const words = call.tool.replace(/_+/g, ' ').trim();
		return `${call.server} · ${words.charAt(0).toUpperCase()}${words.slice(1)}`;
	}
	const [running, done, failed] = verbsOf(call);
	return t(locale, state === 'running' ? running : state === 'done' ? done : failed);
}
/** The running verb from a bare title (the sidebar card keeps only the title of the current tool, spec/sidebar#layout). */
export function mcpActivityTitle(locale: Locale, title: string): string | null {
	const call = mcpCall({ id: '', name: title, title });
	return call ? mcpVerb(locale, call, 'running') : null;
}

const str = (value: unknown): string | null =>
	typeof value === 'string' && value.trim() ? value.trim() : null;
const num = (value: unknown): number | null =>
	typeof value === 'number' && Number.isFinite(value) ? value : null;
const firstLine = (value: unknown, limit = 160): string | null => {
	const text = str(value);
	if (!text) return null;
	const line = text
		.split(/\r?\n/)
		.find((item) => item.trim())!
		.trim();
	return line.length > limit ? `${line.slice(0, limit - 1)}…` : line;
};
const plain = (text: string | null | undefined): McpSegment[] =>
	text ? [{ kind: 'text', text }] : [];
const code = (text: string | null | undefined): McpSegment[] =>
	text ? [{ kind: 'code', text }] : [];
const changes = (added: unknown, removed: unknown): McpSegment[] =>
	num(added) === null || num(removed) === null
		? []
		: [
				{ kind: 'added', text: `+${num(added)}` },
				{ kind: 'removed', text: `−${num(removed)}` },
			];
const yesNo = (locale: Locale, value: unknown) => t(locale, value ? 'yes' : 'no');
function plural(
	locale: Locale,
	count: number,
	uk: { one: string; few: string; many: string; other: string },
	en: readonly [string, string]
): string {
	const number = new Intl.NumberFormat(locale).format(count);
	if (locale === 'en') return `${number} ${count === 1 ? en[0] : en[1]}`;
	return `${number} ${uk[new Intl.PluralRules('uk').select(count) as keyof typeof uk] ?? uk.other}`;
}
export const turnCount = (locale: Locale, n: number) =>
	plural(locale, n, { one: 'турн', few: 'турни', many: 'турнів', other: 'турну' }, [
		'turn',
		'turns',
	]);
export const entryCount = (locale: Locale, n: number) =>
	plural(locale, n, { one: 'запис', few: 'записи', many: 'записів', other: 'запису' }, [
		'entry',
		'entries',
	]);
export const requestCount = (locale: Locale, n: number) =>
	plural(locale, n, { one: 'запит', few: 'запити', many: 'запитів', other: 'запиту' }, [
		'request',
		'requests',
	]);
export const threadCount = (locale: Locale, n: number) =>
	plural(locale, n, { one: 'тред', few: 'треди', many: 'тредів', other: 'треду' }, [
		'thread',
		'threads',
	]);
/** spec/terminal-and-cli-agents#agent-console-tools: console sessions and output lines of `console_*`. */
export const sessionCount = (locale: Locale, n: number) =>
	plural(locale, n, { one: 'сеанс', few: 'сеанси', many: 'сеансів', other: 'сеансу' }, [
		'session',
		'sessions',
	]);
export const lineCount = (locale: Locale, n: number) =>
	plural(locale, n, { one: 'рядок', few: 'рядки', many: 'рядків', other: 'рядка' }, [
		'line',
		'lines',
	]);
export const elementCount = (locale: Locale, n: number) =>
	plural(locale, n, { one: 'елемент', few: 'елементи', many: 'елементів', other: 'елемента' }, [
		'element',
		'elements',
	]);
/** spec/search-menus-and-commands#agent-command-tools: the run states of spec/search-menus-and-commands#project-commands as the toolbar names them. */
const commandRunWord: Record<string, MessageKey> = {
	'not run': 'not run yet',
	starting: 'starting',
	running: 'running',
	failed: 'crashed',
	done: 'finished',
	stopped: 'stopped',
};
const statusWord: Record<string, MessageKey> = {
	backlog: 'in the backlog',
	queued: 'in the queue',
	preparing: 'preparing',
	working: 'is working',
	'needs-you': 'waits for you',
	done: 'is finished',
	interrupted: 'interrupted',
	failed: 'stopped with an error',
	'rate-limited': 'at the limit',
	completed: 'accepted',
};
/** A built-in agent name (`Developer 1`) in the interface language; a person's own name stays as typed. */
export function crewAgentLabel(locale: Locale, name: string): string {
	return isBuiltinCrewName(name) ? t(locale, name) : name;
}
const lines = (text: string) => text.split(/\r?\n/).filter((line) => line.trim()).length;
/** Page console and network entries as lines (`error · TypeError: …`), not as JSON. */
const entries = (value: unknown): string | null =>
	Array.isArray(value) && value.length
		? value
				.map((item) =>
					isRecord(item)
						? [
								str(item.level) ?? (item.error ? 'error' : null),
								str(item.text) ?? JSON.stringify(item),
							]
								.filter(Boolean)
								.join(' · ')
						: String(item)
				)
				.join('\n')
		: null;
const join = (...parts: McpSegment[][]) =>
	parts
		.filter((part) => part.length)
		.flatMap((part, index) => (index ? [{ kind: 'text' as const, text: ' · ' }, ...part] : part));

/**
 * Everything the row shows for one MCP call (spec/chat#mcp-calls): the verb by state, the crew agent, a second line with the target
 * or the outcome, and human fields for the expanded row. `worker` finds the agent and part of a crew task id.
 */
export function mcpRow(
	locale: Locale,
	tool: ToolPatch,
	state: McpState,
	worker: (taskId: string) => McpWorker | null = () => null
): McpRow | null {
	const call = mcpCall(tool);
	if (!call) return null;
	const resultText = mcpResultText(tool),
		result = state === 'done' ? mcpResult(tool) : undefined,
		r = isRecord(result) ? result : {},
		a = call.args;
	const failure =
		state === 'failed'
			? plain(firstLine(resultText) ?? t(locale, 'Error'))
			: state === 'interrupted'
				? plain(t(locale, 'interrupted'))
				: null;
	if (!isBrigadirTool(call)) {
		const target =
			Object.values(a)
				.map((value) => firstLine(value, 200))
				.find(Boolean) ?? null;
		let text: string | null = resultText || null;
		const parsed = parse(resultText);
		if (parsed !== undefined && typeof parsed === 'object') text = JSON.stringify(parsed, null, 2);
		return {
			module: null,
			title: mcpVerb(locale, call, state),
			who: null,
			detail: failure ?? code(target),
			fields: [],
			text,
			files: [],
			message: null,
			diff: false,
		};
	}
	const id = str(a.taskId) ?? str(r.taskId),
		known = id ? worker(id) : null;
	const who = (name: unknown) => {
		const own = str(name);
		return own ? crewAgentLabel(locale, own) : known ? crewAgentLabel(locale, known.name) : null;
	};
	let agent: string | null = null,
		detail: McpSegment[] = [],
		fields: McpRow['fields'] = [],
		text: string | null = null,
		files: McpRow['files'] = [],
		message: string | null = null;
	const status = (value: unknown) => {
		const key = statusWord[String(value)];
		return key ? t(locale, key) : null;
	};
	switch (call.tool) {
		case 'propose_plan': {
			const parts = Array.isArray(a.parts) ? a.parts.filter(isRecord) : [];
			detail = join(
				plain(parts.length ? planPartCountLabel(locale, parts.length) : null),
				plain(
					state === 'running'
						? t(locale, 'waits for you')
						: typeof r.approved === 'boolean'
							? t(locale, r.approved ? 'agreed' : 'rejected')
							: null
				)
			);
			text =
				parts
					.map(
						(part) =>
							`${crewAgentLabel(locale, String(part.agent ?? ''))} · ${String(part.title ?? '')}`
					)
					.join('\n') || null;
			break;
		}
		case 'create_worker_task':
			agent = who(a.agent ?? r.agent);
			detail = join(
				plain(str(a.title) ?? str(r.title)),
				plain(status(r.status)),
				plain(
					num(r.part) && num(r.part)! > 1
						? t(locale, 'part {n}').replace('{n}', String(r.part))
						: null
				)
			);
			fields = [
				...(Array.isArray(a.files) && a.files.length
					? [{ label: t(locale, 'Zone'), value: a.files.map(String).join(', ') }]
					: []),
			];
			text = str(a.prompt);
			break;
		case 'prompt_task':
			agent = who(null);
			detail = plain(firstLine(a.text));
			text = str(a.text);
			break;
		case 'task_status': {
			agent = who(r.agent);
			const part = num(r.part),
				turns = num(r.turns),
				files = num(r.changedFiles);
			detail = join(
				plain(status(r.status)),
				plain(part && part > 1 ? t(locale, 'part {n}').replace('{n}', String(part)) : null),
				plain(turns === null ? null : turnCount(locale, turns)),
				plain(files === null ? null : fileCount(locale, files))
			);
			if (state === 'done')
				fields = [
					{ label: t(locale, 'Status'), value: status(r.status) ?? String(r.status ?? '') },
					{ label: t(locale, 'Part'), value: String(part ?? 1) },
					{ label: t(locale, 'Turns'), value: String(turns ?? 0) },
					{ label: t(locale, 'Changed files'), value: String(files ?? 0) },
					{ label: t(locale, 'Working now'), value: yesNo(locale, r.busy) },
					{
						label: t(locale, 'Question'),
						value: isRecord(r.pendingQuestion)
							? String(r.pendingQuestion.question ?? '')
							: t(locale, 'none'),
					},
					{ label: t(locale, 'Accepted'), value: yesNo(locale, r.accepted) },
				];
			break;
		}
		case 'read_report': {
			const report = str(r.report),
				head = report?.match(/^Report from `([^`]+)` · (.+?) \(task /),
				counts = report?.match(/Changed files: (\d+), \+(\d+) −(\d+)/);
			agent = who(head?.[1]);
			detail = join(
				plain(head?.[2] ?? known?.title ?? null),
				plain(counts ? fileCount(locale, Number(counts[1])) : null),
				counts ? changes(Number(counts[2]), Number(counts[3])) : []
			);
			// The report is ours (crew host): `Files:` lines `- path S +a −d`, then `Worker's last message:`.
			const list = report?.match(/\nFiles:\n((?:- .+\n?)+)/)?.[1] ?? '';
			files = [...list.matchAll(/^- (.+) (\S) \+(\d+) −(\d+)$/gm)].map((m) => ({
				path: m[1]!,
				status: m[2]!,
				added: Number(m[3]),
				removed: Number(m[4]),
			}));
			message = report?.split(/\nWorker's last message:\n/)[1]?.trim() || null;
			text = files.length || message ? null : report;
			break;
		}
		case 'read_transcript':
			agent = who(null);
			detail = plain(Array.isArray(r.lines) ? planLinesLabel(locale, r.lines.length) : null);
			text = Array.isArray(r.lines) ? r.lines.map(String).join('\n') : null;
			break;
		case 'read_diff':
			agent = who(null);
			if (str(a.path)) detail = join(code(str(a.path)), changes(r.additions, r.deletions));
			else
				detail = plain(
					Array.isArray(r.files) ? fileCount(locale, r.files.length + (num(r.more) ?? 0)) : null
				);
			text =
				str(r.diff) ??
				(Array.isArray(r.files)
					? r.files
							.filter(isRecord)
							.map(
								(file) =>
									`${String(file.status ?? '')} ${String(file.path ?? '')} +${String(file.additions ?? 0)} −${String(file.deletions ?? 0)}`
							)
							.join('\n')
					: null);
			break;
		case 'submit_review': {
			const comments = Array.isArray(a.comments) ? a.comments.filter(isRecord) : [];
			agent = who(null);
			detail = join(
				plain(known?.title ?? null),
				plain(comments.length ? commentCount(locale, comments.length) : null)
			);
			text =
				comments
					.map(
						(item) =>
							`${String(item.path ?? '')}${item.start ? `:${String(item.start)}` : ''}${item.end && item.end !== item.start ? `–${String(item.end)}` : ''}  ${String(item.text ?? '')}`
					)
					.join('\n\n') || null;
			break;
		}
		case 'approve':
			agent = who(null);
			detail = plain(known?.title ?? null);
			break;
		case 'accept_task': {
			agent = who(null);
			const committed = Array.isArray(r.committed) ? r.committed.filter(isRecord) : [],
				conflicts = Array.isArray(r.conflicts) ? r.conflicts.map(String) : [];
			detail = join(
				plain(known?.title ?? null),
				committed.length
					? [
							{ kind: 'text', text: t(locale, 'commit {sha}').split('{sha}')[0]! },
							{
								kind: 'code',
								text: committed
									.map(
										(item) =>
											`${item.name && item.name !== '.' ? `${String(item.name)} ` : ''}${String(item.sha ?? '').slice(0, 7)}`
									)
									.join(', '),
							},
						]
					: [],
				plain(conflicts.length ? `${t(locale, 'Conflicts')}: ${conflicts.join(', ')}` : null)
			);
			if (state === 'done')
				fields = [
					...committed.map((item) => ({
						label: t(locale, 'Commit'),
						value: `${item.name && item.name !== '.' ? `${String(item.name)} · ` : ''}${String(item.sha ?? '')}`,
					})),
					{
						label: t(locale, 'Conflicts'),
						value: conflicts.length ? conflicts.join(', ') : t(locale, 'none'),
					},
				];
			break;
		}
		case 'ask_foreman':
			detail = join(
				plain(firstLine(a.question)),
				plain(state === 'running' ? t(locale, 'waiting for the foreman') : null)
			);
			fields = str(r.answer) ? [{ label: t(locale, 'Response'), value: str(r.answer)! }] : [];
			text = str(a.question);
			break;
		case 'post_note':
			detail = plain(firstLine(a.text));
			fields =
				Array.isArray(a.files) && a.files.length
					? [{ label: t(locale, 'Files'), value: a.files.map(String).join(', ') }]
					: [];
			text = str(a.text);
			break;
		case 'read_notes': {
			const notes = Array.isArray(r.notes) ? r.notes.filter(isRecord) : null;
			detail = plain(notes ? entryCount(locale, notes.length) : null);
			text =
				notes
					?.map(
						(note) =>
							`${crewAgentLabel(locale, String(note.author ?? ''))} · ${String(note.text ?? '')}`
					)
					.join('\n\n') || null;
			break;
		}
		// spec/tasks#agent-created-tasks: the proposal's title; the card itself answers, the row says how it ended.
		case 'create_task':
			detail = join(
				plain(str(a.title) ?? firstLine(a.prompt)),
				plain(
					state === 'running'
						? t(locale, 'waits for you')
						: r.created === true
							? t(locale, 'Task created')
							: r.created === false
								? t(locale, 'Task not created')
								: null
				)
			);
			text = str(a.prompt);
			break;
		// spec/projects-and-board#folders-mid-task: the folder by its path; a refusal says why, in the person's language when the reason is ours.
		case 'add_folder': {
			const reason = str(r.reason);
			detail = join(
				code(str(r.path) ?? str(a.path)),
				plain(
					r.added === false
						? reason && isMessageKey(reason)
							? t(locale, reason)
							: reason
						: r.writable === false
							? t(locale, 'reading only')
							: null
				)
			);
			break;
		}
		// spec/notifications-slack-notes-and-schedules#slack-agent-post: where it went, the text, and why Slack or the person refused.
		case 'slack_post': {
			const reason = str(r.reason);
			detail = join(
				plain(str(a.channel) ?? (str(a.thread) ? null : t(locale, 'the task’s Slack thread'))),
				plain(
					r.posted === false ? (reason && isMessageKey(reason) ? t(locale, reason) : reason) : null
				)
			);
			text = str(a.text);
			break;
		}
		// spec/tasks#task-messages: the other task by title, the text sent, and why it did not go.
		case 'tasks_list': {
			const tasks = Array.isArray(r.tasks) ? r.tasks.filter(isRecord) : null;
			detail = plain(tasks ? taskCount(locale, tasks.length) : null);
			text = tasks?.map((task) => String(task.title ?? '')).join('\n') || null;
			break;
		}
		case 'task_send': {
			const reason = str(r.reason),
				target = isRecord(r.task) ? str(r.task.title) : null;
			detail = join(
				plain(target ?? str(a.taskId)),
				plain(
					r.sent === false ? (reason && isMessageKey(reason) ? t(locale, reason) : reason) : null
				)
			);
			text = str(a.text);
			break;
		}
		// spec/diff-and-review#agent-review-start: the summary the card shows.
		case 'propose_review': {
			text = str(a.summary);
			break;
		}
		case 'ask_user': {
			detail = join(
				plain(str(a.header) ?? firstLine(a.question)),
				plain(state === 'running' ? t(locale, 'waits for you') : null)
			);
			text = str(a.question);
			const answer = [
				...(Array.isArray(r.labels) ? r.labels.map(String) : []),
				...(str(r.text) ? [str(r.text)!] : []),
			].join(' · ');
			if (answer) fields = [{ label: t(locale, 'Response'), value: answer }];
			break;
		}
		case 'browser_open':
			detail = code(str(a.url));
			break;
		case 'browser_state':
			detail = code(str(r.url) ?? str(a.url));
			fields =
				state === 'done'
					? [
							{ label: t(locale, 'Address'), value: String(r.url ?? '') },
							{ label: t(locale, 'Page title'), value: String(r.title ?? '') },
						]
					: [];
			break;
		case 'browser_read':
			detail = code(str(a.selector) ?? str(r.url) ?? str(a.url));
			text = str(r.text);
			break;
		case 'browser_console':
			detail = plain(Array.isArray(result) ? entryCount(locale, result.length) : null);
			text = entries(result);
			break;
		case 'browser_network':
			detail = str(a.requestId)
				? code(str(a.requestId))
				: plain(Array.isArray(result) ? requestCount(locale, result.length) : null);
			text = entries(result);
			break;
		case 'browser_ui':
			detail = plain(
				typeof result === 'string' && /· (\d+) elements/.test(result)
					? elementCount(locale, Number(/· (\d+) elements/.exec(result)![1]))
					: null
			);
			text = typeof result === 'string' ? result : null;
			break;
		case 'browser_act':
			detail = code(
				str(a.label) ??
					str(a.ref) ??
					str(a.selector) ??
					str(a.key) ??
					str(a.value) ??
					str(a.text) ??
					(num(a.x) !== null ? `${a.x},${a.y}` : null)
			);
			text = typeof result === 'string' ? result : null;
			break;
		case 'simulator_open':
			detail = join(plain(str(a.device)), code(str(a.app) ?? str(a.url)));
			break;
		case 'simulator_ui':
			detail = plain(typeof result === 'string' ? elementCount(locale, lines(result)) : null);
			break;
		case 'simulator_act':
			detail = code(
				str(a.id) ??
					str(a.label) ??
					str(a.text) ??
					str(a.key) ??
					str(a.button) ??
					(num(a.x) !== null ? `${a.x},${a.y}` : null)
			);
			break;
		case 'simulator_logs':
			detail = join(plain(str(a.source)), plain(str(a.level)), code(str(a.grep)));
			break;
		case 'simulator_network':
			detail =
				(str(a.requestId) ?? str(a.filter))
					? code(str(a.requestId) ?? str(a.filter))
					: plain(typeof result === 'string' ? requestCount(locale, lines(result)) : null);
			break;
		case 'pr_comment':
			detail = code(str(a.path) ? `${a.path}:${String(a.line ?? '')}` : null);
			text = str(a.body);
			break;
		case 'pr_comment_reply':
			detail = plain(firstLine(a.body));
			text = str(a.body);
			break;
		case 'editor_state': {
			// spec/agents-and-providers#context-tools: the active tab as `path:line` and the selection, or why nothing is seen; spec/agents-and-providers#editor-state: a console or browser tab
			// by its title, the PR overview by its number.
			const active = isRecord(r.active) ? r.active : null,
				selections =
					active && Array.isArray(active.selections) ? active.selections.filter(isRecord) : [],
				selection =
					active && isRecord(active.selection) ? active.selection : (selections[0] ?? null);
			const lines = selection && Array.isArray(selection.lines) ? selection.lines.map(Number) : [],
				count = lines.length ? lines.at(-1)! - lines[0]! + 1 : 0;
			if (r.window === 'closed') detail = plain(t(locale, 'the window is closed'));
			else if (!active) detail = plain(state === 'done' ? t(locale, 'nothing is open') : null);
			else
				detail = join(
					code(
						active.kind === 'file' && isRecord(active.cursor)
							? `${String(active.path ?? '')}:${String(active.cursor.line ?? '')}`
							: (str(active.path) ??
									str(active.title) ??
									(num(active.pullRequest) !== null ? `#${String(active.pullRequest)}` : null))
					),
					plain(count > 0 ? selectedLineCount(locale, count) : null)
				);
			text = selection ? str(selection.text) : null;
			break;
		}
		// spec/editor-code-intelligence#language-server-restart: the servers restarted, or the note why there was none.
		case 'editor_restart_language_servers': {
			const names = Array.isArray(r.restarted) ? r.restarted.map(String) : null;
			detail = plain(
				names?.length ? names.join(', ') : names ? t(locale, 'nothing to restart') : null
			);
			break;
		}
		case 'pr_state':
			if (r.window === 'closed') detail = plain(t(locale, 'the window is closed'));
			else if (r.open === false) detail = plain(t(locale, 'no PR is open'));
			else if (num(r.number) !== null)
				detail = join(
					code(`#${String(r.number)}`),
					plain(firstLine(r.title, 80)),
					plain(Array.isArray(r.threads) ? threadCount(locale, r.threads.length) : null)
				);
			break;
		// spec/search-menus-and-commands#agent-command-tools: the command by its name, its address or how it ended; the output stays in the expanded row.
		case 'commands_list': {
			const commands = Array.isArray(r.commands) ? r.commands.filter(isRecord) : null;
			detail = plain(commands ? commandCount(locale, commands.length) : null);
			text =
				commands
					?.map(
						(item) =>
							`${String(item.name ?? '')} · ${String(item.command ?? '')} · ${String(item.state ?? '')}${item.url ? ` · ${String(item.url)}` : ''}`
					)
					.join('\n') || null;
			break;
		}
		case 'commands_run':
		case 'commands_output':
		case 'commands_stop': {
			const run = commandRunWord[String(r.state)],
				exit = num(r.exitCode);
			detail = join(
				code(str(r.name) ?? str(a.id)),
				code(str(r.url)),
				plain(
					state === 'running' && call.tool === 'commands_run' ? null : run ? t(locale, run) : null
				),
				plain(r.state === 'failed' && exit !== null ? `exit ${exit}` : null)
			);
			text = str(r.output);
			break;
		}
		// spec/terminal-and-cli-agents#agent-console-tools: how many sessions there are; a read names its tab and the lines it got, the text stays in the expanded row.
		case 'console_list': {
			const consoles = Array.isArray(r.consoles) ? r.consoles.filter(isRecord) : null;
			detail = plain(
				consoles
					? consoles.length
						? sessionCount(locale, consoles.length)
						: t(locale, 'no console is open')
					: null
			);
			text =
				consoles
					?.map(
						(item) =>
							`${String(item.title ?? '')} · ${String(item.folder ?? '')} · ${String(item.state ?? '')}`
					)
					.join('\n') || null;
			break;
		}
		case 'console_read': {
			// The raw text: a log's first line keeps its indent.
			const output = typeof r.output === 'string' ? r.output : null;
			detail = join(
				code(str(r.title)),
				plain(output !== null ? lineCount(locale, output ? output.split('\n').length : 0) : null)
			);
			text = output || null;
			break;
		}
		default:
			break;
	}
	if (!text && typeof result === 'string') text = result;
	return {
		module: mcpModule(call.tool),
		// The call succeeded, but the folder did not join: the title must not say it was added.
		title:
			call.tool === 'add_folder' && r.added === false
				? t(locale, 'Did not add the folder')
				: mcpVerb(locale, call, state),
		who: agent,
		detail: failure ?? detail,
		fields,
		text,
		files,
		message,
		diff: call.tool === 'read_diff' && Boolean(str(r.diff)),
	};
}

/**
 * spec/chat#mcp-calls: the crew event a call of ours already tells about. `create_worker_task` and `accept_task` rows say who got
 * the part and what was accepted, so their `воркер` / `прийнято` service rows would show it twice. Events nobody called
 * a tool for (the host starts the reviewer, a person accepts by hand) keep their service row.
 */
export function foldedCrewEvents(records: readonly import('./session').EventRecord[]): Set<number> {
	const folded = new Set<number>(),
		tools = new Map<string, ToolPatch>();
	const created = new Map<string, number>(),
		accepted = new Map<string, number>();
	for (const record of records) {
		const e = record.event;
		if (e.kind === 'turn.started') {
			created.clear();
			accepted.clear();
			continue;
		}
		if (e.kind === 'tool.changed') {
			const patch = { ...tools.get(e.patch.id), ...e.patch };
			tools.set(e.patch.id, patch);
			const call = mcpCall(patch);
			if (!call || call.server !== 'brigadir') continue;
			if (call.tool === 'create_worker_task') {
				const title = str(call.args.title);
				if (title && !created.has(`#${patch.id}`)) {
					created.set(title, (created.get(title) ?? 0) + 1);
					created.set(`#${patch.id}`, 1);
				}
			}
			if (call.tool === 'accept_task') {
				const id = str(call.args.taskId);
				if (id && !accepted.has(`#${patch.id}`)) {
					accepted.set(id, (accepted.get(id) ?? 0) + 1);
					accepted.set(`#${patch.id}`, 1);
				}
			}
			continue;
		}
		if (
			(e.kind === 'crew.worker.created' || e.kind === 'crew.part.started') &&
			(created.get(e.title) ?? 0) > 0
		) {
			created.set(e.title, created.get(e.title)! - 1);
			folded.add(record.seq);
		}
		if (e.kind === 'crew.accepted' && (accepted.get(e.taskId) ?? 0) > 0) {
			accepted.set(e.taskId, accepted.get(e.taskId)! - 1);
			folded.add(record.seq);
		}
	}
	return folded;
}
/** Who each crew task id is, from the crew events of this log: a worker's agent and its latest part (spec/crew#parts). */
export function crewWorkersFromLog(
	records: readonly import('./session').EventRecord[]
): Map<string, McpWorker> {
	const workers = new Map<string, McpWorker>();
	for (const record of records) {
		const e = record.event;
		if (e.kind === 'crew.worker.created' || e.kind === 'crew.part.started')
			workers.set(e.taskId, { name: e.name, title: e.title });
	}
	return workers;
}
