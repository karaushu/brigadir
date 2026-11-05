import type { Socket } from 'node:net';
import { z } from 'zod';
import {
	defaultModules,
	isRecord,
	moduleOffMessages,
	toolModule,
	type AppModules,
} from '@brigadir/core';
import {
	crewTools,
	humanToolsAllowed,
	isWorkspaceTool,
	toolsInstructions,
	type CrewProcessRole,
	type CrewToolName,
} from '@brigadir/orchestrator';
import { framer } from './peer';
/**
 * The MCP server of a task (spec/crew#task-type). The agent spawns `mcp-relay`, which hands its stdio to this socket
 * after the usual handshake, and the host answers MCP itself, with no Electron-as-node MCP SDK process per agent session
 * (~75 MB, ~105 ms to `initialize`). Tool names, schemas, defaults, validation texts and the per-role list match the SDK
 * server byte for byte (fixtures/mcp-sdk-1.30.json); the host still re-checks every call.
 */
export type McpCall = (method: string, params: unknown, signal: AbortSignal) => Promise<unknown>;
type Content = {
	content: ({ type: 'text'; text: string } | { type: 'image'; data: string; mimeType: string })[];
	isError?: true;
};
type Tool = {
	name: string;
	description: string;
	shape: z.ZodRawShape;
	run(
		args: Record<string, unknown>,
		call: McpCall,
		signal: AbortSignal,
		id: string | number
	): Promise<Content>;
};
const text = (value: unknown): Content => ({
	content: [{ type: 'text', text: typeof value === 'string' ? value : JSON.stringify(value) }],
});
const toolError = (message: string): Content => ({
	content: [{ type: 'text', text: message }],
	isError: true,
});
/** spec/task-window-workspace#work-area: every browser tool takes the tab; without it the call goes to the tab you opened. */
const browserTab = z
	.string()
	.regex(/^b[0-9a-z]{1,16}$/)
	.optional()
	.describe(
		'The browser tab (browser_state lists the tabs of this task); default: the tab you opened.'
	);
// spec/browser-and-simulator#network-streams: what an agent can learn from browser_network, open requests and streams included.
const networkDescription =
	'Requests of the page in the browser of this task (Fetch, XHR, EventSource, WebSocket), newest last; an open request shows its state (pending or streaming), how long it has been open, bytes received and messages so far. With requestId: response headers and the body (text up to 16 KiB); for an event stream or a WebSocket, its newest messages. The human sees the same page.';
/** spec/agents-and-providers#tool-permissions: tools that only read; `readOnlyHint` lets Claude call them in plan mode as it calls Read. */
const readOnlyTools = new Set([
	'browser_state',
	'browser_read',
	'browser_console',
	'browser_network',
	'browser_screenshot',
	'browser_ui',
	'simulator_state',
	'simulator_ui',
	'simulator_screenshot',
	'simulator_logs',
	'simulator_network',
	'editor_state',
	'pr_state',
	'commands_list',
	'commands_output',
	'console_list',
	'console_read',
	'task_status',
	'read_report',
	'read_transcript',
	'read_diff',
	'read_notes',
]);
/**
 * spec/agents-and-providers#tools-awareness: when to call each tool, added after what it does. One table, so the descriptions below stay as their
 * features wrote them; a tool whose own description already says when (`commands_list`, `editor_state`, `pr_state`) has no entry.
 */
const whenToUse: Record<string, string> = {
	editor_restart_language_servers:
		'Call it when the person sees errors in the editor that are already fixed, or after you replace node_modules or change tsconfig/jsconfig. Do not install packages again or replace node_modules only to refresh the editor.',
	browser_show:
		'Call it only when the page has to be on screen for the step: a file upload, an OAuth or sign-in window, a passkey or a CAPTCHA; everything else works while the page is hidden.',
	ask_user:
		'Do not use it to ask the person to check a page, the app or a command you can check with your own tools.',
	create_task:
		'Use it when the person asks for a separate task, or when you find work outside this task that another agent should do.',
	add_folder: 'Use it when the work needs files outside the project, such as a sibling repository.',
	slack_post:
		'Use it when the person asks to post to Slack as Brigadir or as the bot. Never read a Slack token from env files or call the Slack API yourself.',
	browser_open:
		'Use it after you change anything a person sees in a web app: open the local page and check it yourself instead of asking the person to.',
	browser_state: 'Call it to see which page is open and whether it finished loading.',
	browser_read:
		'Use it to read the text of the page, or of one element by selector, after it loads.',
	browser_console:
		'Call it after the page loads or after an action, to catch JavaScript errors and warnings.',
	browser_network:
		'Call it when the page shows wrong or missing data, to see which request failed and what it returned.',
	browser_screenshot:
		'Use it to check how the page looks after a UI change; to find elements, prefer browser_ui.',
	browser_ui:
		'Call it to find what to click or type into, and again after an action to check the result.',
	browser_act:
		'Use it to go through the flow you changed the way the person would, instead of giving them steps to try.',
	commands_run:
		'Use it for a dev server, a build or the tests when a saved command fits, instead of your shell.',
	commands_output: 'Call it when a command fails, or to read what a running server printed.',
	commands_stop:
		'Use it when a command must stop, for example when the person asks; to restart one, pass restart to commands_run.',
	console_list:
		'Call it when the person speaks of the console, a terminal, a log or a server they started, before you ask them for its output.',
	console_read:
		'Call it to read an error or a log the person sees in the console, and again after a change to see the new lines.',
	simulator_state: 'Call it before simulator_open to see the selected device and whether it runs.',
	simulator_open: 'Call it before you check a React Native or mobile change on the device.',
	simulator_ui: 'Call it to find what to tap, and again after an action to check the result.',
	simulator_act:
		'Use it to go through the flow you changed on the device yourself, instead of asking the person to tap through it.',
	simulator_screenshot: 'Use it to check how the screen looks after a UI change.',
	simulator_logs: 'Call it after an action or a reload to catch JS errors and warnings.',
	simulator_network:
		'Call it when the app shows wrong or missing data, to see which request failed.',
	pr_comment: 'Use it for each finding of your review, on the lines it is about.',
	pr_comment_reply: 'Use it when the person answers in the thread of your draft.',
	propose_plan: 'Call it first, before you create any worker task.',
	create_worker_task: 'Call it for each part of the approved plan, wave by wave.',
	prompt_task: 'Use it when a part needs changes or a worker asked you a question.',
	task_status: 'Call it only when a worker seems stuck.',
	read_report: 'Call it when a report arrives, before you accept or return the part.',
	read_transcript: 'Use it only when the report does not explain what happened.',
	read_diff: 'Call it when the report is not enough to judge a change.',
	submit_review: 'Use it when the work needs changes before it is accepted.',
	approve: 'Call it when your check found nothing to fix.',
	accept_task: 'Call it once the report and the diff show the part is done.',
	ask_foreman: 'Use it when the task or a shared decision is unclear, not for permissions.',
	post_note: 'Call it when you change something other agents rely on.',
	read_notes: 'Call it before you touch a shared type or config.',
};
const humanTools: Tool[] = [
	{
		name: 'ask_user',
		description:
			'Ask the human a question and wait for their explicit answer. Use this tool whenever you need the human to choose or clarify. The wait has no human-response timeout. Returns the selected labels and free text.',
		shape: {
			question: z.string().trim().min(1).max(100_000),
			header: z.string().max(100).default(''),
			options: z
				.array(z.object({ label: z.string().min(1), description: z.string().default('') }))
				.max(100)
				.default([]),
			allowsFreeText: z.boolean().default(true),
			allowsMultiple: z.boolean().default(false),
		},
		run: async (args, call, signal) => text(await call('ask_user', args, signal)),
	},
	// spec/tasks#agent-created-tasks: a new task in this project, with context and extra folders; the person creates it from a card or declines.
	{
		name: 'create_task',
		description:
			'Propose a new task in this project for another agent session, with the context it needs. The human sees a card and creates the task, edits it first, or declines; the call waits for that. Write the prompt in English as a complete brief: the new agent sees only the prompt and the context. context: summary (an overview of this task: its prompt, turns and changed files), diff (the changes of this task as a stat; full adds the patch), file (an absolute path the new agent can read), text (a named note). folders: absolute paths of folders outside the project root to add to the new task (a git repository is edited in place; a folder without git is read-only). Repos and isolation are inherited from this task; the branch is new. agent: the provider (claude or codex) and optionally its model and effort, by value or name as that provider lists them, when the human asks for another agent or model; without it the agent, model and effort are inherited from this task, and with it whatever is left out is that provider default. An unknown model or effort fails with the available ones. start: now starts the task after it is created, backlog leaves it in the backlog, schedule proposes a schedule instead — every run of it is a new task with this prompt (context and folders are not kept for a schedule). schedule.rule: once {at: ISO time}, hourly {minute}, interval {hours 1–12, between?: {from, to} as HH:MM}, weekly {days: 1–7 Monday first, times: [HH:MM]}, or cron {expr: five fields}; timeZone is IANA (default: this computer); missed: catch-up (default), skip or ask. Returns the created task (or schedule) or created: false.',
		shape: {
			title: z.string().trim().min(1).max(80).optional(),
			prompt: z.string().trim().min(1).max(100_000),
			context: z
				.array(
					z.discriminatedUnion('kind', [
						z.object({ kind: z.literal('summary') }),
						z.object({ kind: z.literal('diff'), full: z.boolean().default(false) }),
						z.object({ kind: z.literal('file'), path: z.string().min(1).max(4096) }),
						z.object({
							kind: z.literal('text'),
							name: z.string().trim().min(1).max(200),
							text: z.string().min(1).max(262_144),
						}),
					])
				)
				.max(10)
				.default([]),
			folders: z.array(z.string().min(1).max(4096)).max(5).default([]),
			agent: z
				.object({
					provider: z.enum(['claude', 'codex']),
					model: z.string().trim().min(1).max(200).optional(),
					effort: z.string().trim().min(1).max(200).optional(),
				})
				.strict()
				.optional(),
			start: z.enum(['now', 'backlog', 'schedule']).default('now'),
			schedule: z
				.object({
					rule: z.discriminatedUnion('kind', [
						z.object({ kind: z.literal('once'), at: z.string().min(10).max(40) }),
						z.object({ kind: z.literal('hourly'), minute: z.number().int().min(0).max(59) }),
						z.object({
							kind: z.literal('interval'),
							hours: z.number().int().min(1).max(12),
							between: z
								.object({
									from: z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/),
									to: z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/),
								})
								.optional(),
						}),
						z.object({
							kind: z.literal('weekly'),
							days: z.array(z.number().int().min(1).max(7)).min(1).max(7),
							times: z
								.array(z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/))
								.min(1)
								.max(12),
						}),
						z.object({ kind: z.literal('cron'), expr: z.string().min(9).max(120) }),
					]),
					timeZone: z.string().min(1).max(64).optional(),
					missed: z.enum(['catch-up', 'skip', 'ask']).optional(),
				})
				.strict()
				.optional(),
		},
		run: async (args, call, signal) => text(await call('create_task', args, signal)),
	},
	// spec/projects-and-board#folders-mid-task: a folder from outside the project joins this task while it runs.
	{
		name: 'add_folder',
		description:
			'Add a folder from outside the project to this task. A git repository becomes writable after the human allows it; a folder without git joins read-only at once. The folder shows in the diff and the workspace repositories. Use its absolute path right away; your workspace roots include it from your next turn. Folders inside the project are already in the repo list. Returns added: true with name, path and writable, or added: false with the reason.',
		shape: { path: z.string().min(1).max(4096) },
		run: async (args, call, signal) => text(await call('add_folder', args, signal)),
	},
	// spec/notifications-slack-notes-and-schedules#slack-agent-post: a message from Brigadir's Slack bot; the token stays in the app.
	{
		name: 'slack_post',
		description:
			"Post a message to Slack as Brigadir's bot, not as the person. The human sees the text and allows or denies it; the call waits for that. text: Slack mrkdwn. channel: #name, a name, or a channel ID; without it the message goes to this task's Slack thread. thread: the ts or the Slack link of a message to reply under. Returns posted: true with channel, ts and permalink, or posted: false with the reason (for example, the bot is not in the channel).",
		shape: {
			text: z.string().trim().min(1).max(12_000),
			channel: z.string().trim().min(1).max(200).optional(),
			thread: z.string().trim().min(1).max(500).optional(),
		},
		run: async (args, call, signal) => text(await call('slack_post', args, signal)),
	},
	...(['open', 'state', 'read', 'console', 'network', 'screenshot'] as const).map((kind): Tool => ({
		name: `browser_${kind}`,
		description:
			kind === 'network'
				? networkDescription
				: kind === 'open'
					? 'Open a page in your own browser tab of this task, on screen or not: the first call makes the tab and later calls navigate it; tab "new" makes another one. The human sees the tab in the work area when they open the task. External navigation requires domain permission.'
					: kind === 'state'
						? 'The state of your browser tab (address, title, loading) and tabs: every browser tab of this task with its address, title, whether you opened it and whether it is on screen.'
						: `${kind} the browser of this task, on screen or not; the human sees the same page when they open the task. External navigation requires domain permission.`,
		shape: {
			tab:
				kind === 'open'
					? z
							.string()
							.regex(/^(b[0-9a-z]{1,16}|new)$/)
							.optional()
							.describe(
								'A tab from browser_state to navigate, or "new" for another tab; default: your tab.'
							)
					: browserTab,
			url: z.string().max(8192).optional(),
			selector: z.string().max(500).optional(),
			requestId: z
				.string()
				.regex(/^network-[0-9]{1,12}$/)
				.optional(),
		},
		run: async (args, call, signal) => {
			const result = await call(`browser_${kind}`, args, signal);
			if (
				result &&
				typeof result === 'object' &&
				'image' in result &&
				typeof result.image === 'string'
			)
				return { content: [{ type: 'image', data: result.image, mimeType: 'image/png' }] };
			return text(result);
		},
	})),
	// spec/browser-and-simulator#browser-ui-act: the agent clicks and types in the same page the human sees, like simulator_ui and simulator_act (spec/browser-and-simulator#simulator).
	{
		name: 'browser_ui',
		description:
			'The accessibility tree of the page in the browser of this task, one element a line: role, accessible name, = value, @ref, box in CSS px of the viewport (x,y width×height) and states (focused, disabled, checked, expanded, offscreen). Use it before browser_act: a @ref is the most exact target. Refs last until the page navigates. Long pages come in pages: pass offset.',
		shape: { offset: z.number().int().min(0).optional(), tab: browserTab },
		run: async (args, call, signal) => text(await call('browser_ui', args, signal)),
	},
	{
		name: 'browser_act',
		description:
			"One action in the browser of this task, on screen or not, as real mouse and keyboard input: click (count 2 for a double click), hover, type (text into the target or the focused field; clear empties it first; submit presses Enter; a color input takes a color like #3366ff), key (Enter, Escape, Tab, ArrowDown, a character, or a combination like Meta+A or Shift+Tab), scroll (dx, dy in px, at the target or the middle of the page), select (an option of a <select> by value or text), back, forward, reload; dialog (accept, and text for a prompt: the answer to the next alert, confirm or prompt of the page — dialogs never show while you work with the page, they get Cancel unless you set this); clipboard (what the page copied to the task clipboard); paste (text: puts it in the task clipboard and pastes it into the focused field, as Meta+V); notifications (permission granted, denied or default: allows, blocks or asks again about the notifications of the page's domain, answering a request the page is waiting on, as the human's browser strip does; the project keeps it for the domain). The page copies to and pastes from the task clipboard, never the human's. Target: ref from browser_ui, a CSS selector, label (accessible name) or x,y in CSS px of the viewport. If another element covers the target, nothing happens and the answer names it. Password, one-time code and payment card fields are refused: ask the human to fill them. File uploads are not supported. Local pages need no permission; acting on another domain asks the human. The human sees each action marked on the page. Returns what was done, the page address and title when they changed, and what the page did meanwhile (dialogs, copies, the human using the page); call browser_ui again for the new tree.",
		shape: {
			action: z.enum([
				'click',
				'hover',
				'type',
				'key',
				'scroll',
				'select',
				'back',
				'forward',
				'reload',
				'dialog',
				'clipboard',
				'paste',
				'notifications',
			]),
			ref: z
				.string()
				.regex(/^@?e[0-9]{1,12}$/)
				.optional(),
			selector: z.string().min(1).max(500).optional(),
			label: z.string().min(1).max(500).optional(),
			x: z.number().min(0).max(20_000).optional(),
			y: z.number().min(0).max(20_000).optional(),
			text: z.string().max(10_000).optional(),
			clear: z.boolean().optional(),
			submit: z.boolean().optional(),
			key: z.string().min(1).max(40).optional(),
			count: z.number().int().min(1).max(2).optional(),
			dx: z.number().min(-100_000).max(100_000).optional(),
			dy: z.number().min(-100_000).max(100_000).optional(),
			value: z.string().min(1).max(1000).optional(),
			accept: z.boolean().optional(),
			permission: z.enum(['granted', 'denied', 'default']).optional(),
			tab: browserTab,
		},
		run: async (args, call, signal) => text(await call('browser_act', args, signal)),
	},
	// spec/browser-and-simulator#background: what does not work in the background (a file upload, an OAuth window, a passkey, a CAPTCHA) needs the page on screen.
	{
		name: 'browser_show',
		description:
			'Ask the human to show the page of this task on screen, for what does not work while the page is hidden: uploading a file, an OAuth or sign-in window, a passkey, a CAPTCHA. The human sees a request and shows the page or declines. Returns whether the page is on screen; keep working with the same page either way.',
		shape: {},
		run: async (args, call, signal) => text(await call('browser_show', args, signal)),
	},
	// spec/search-menus-and-commands#agent-command-tools: the person's saved project commands; running one is the toolbar's Run, in the console of this task.
	{
		name: 'commands_list',
		description:
			'The saved commands of this project (dev servers, watchers, scripts, tests) the person runs from the toolbar: id, name, the shell line, repo, folder, the absolute cwd in the tree of this task, agentRuns (true: you run it without asking), and its state in this task (not run, starting, running, failed, done, stopped) with the local address once the output names one, or the exit code. Call it before you start a server or a script yourself. Read-only.',
		shape: {},
		run: async (args, call, signal) => text(await call('commands_list', args, signal)),
	},
	{
		name: 'commands_run',
		description:
			"Run a saved project command by id (from commands_list) in the console of this task, in the person's login shell, as a tab the person sees and can stop. A running command is left as it is unless restart is true. Without agentRuns the person allows it first, once per task. Waits up to wait seconds (default 20) until the output names a local address (http://localhost:N) or the command exits, and returns its state, url, exit code and the last output lines.",
		shape: {
			id: z.string().min(1).max(128),
			restart: z.boolean().default(false),
			wait: z.number().int().min(0).max(120).default(20),
			lines: z.number().int().min(1).max(400).default(40),
		},
		run: async (args, call, signal) => text(await call('commands_run', args, signal)),
	},
	{
		name: 'commands_output',
		description:
			'The last output lines of a saved project command in this task, as plain text, with its state, url and exit code. Read-only.',
		shape: { id: z.string().min(1).max(128), lines: z.number().int().min(1).max(400).default(80) },
		run: async (args, call, signal) => text(await call('commands_output', args, signal)),
	},
	{
		name: 'commands_stop',
		description:
			"Stop a saved project command running in this task, as the person's Stop button does: Ctrl-C, then SIGTERM and SIGKILL to its process group. Without agentRuns the person allows it first, once per task. Returns its state and the last output lines.",
		shape: { id: z.string().min(1).max(128), lines: z.number().int().min(1).max(400).default(40) },
		run: async (args, call, signal) => text(await call('commands_stop', args, signal)),
	},
	// spec/terminal-and-cli-agents#agent-console-tools: the person's console sessions of this task; no module, read only.
	{
		name: 'console_list',
		description:
			'The console of this task: the terminal tabs the person opened beside you (shells, dev servers, watchers, saved command runs), each with id, title, folder, the absolute cwd, whether its process runs or exited with a code, the saved command when the tab runs one, and the last shell command with its state and exit code. An empty list means no console is open. Read-only.',
		shape: {},
		run: async (args, call, signal) => text(await call('console_list', args, signal)),
	},
	{
		name: 'console_read',
		description:
			'The last output lines of a console session of this task as plain text (no ANSI; wrapped lines joined), newest last, as the person sees them, with the state of the session. Without id: the only session, or the newest of several. Read-only.',
		shape: {
			id: z.string().min(1).max(128).optional(),
			lines: z.number().int().min(1).max(400).default(80),
		},
		run: async (args, call, signal) => text(await call('console_read', args, signal)),
	},
	// spec/agents-and-providers#context-tools, spec/agents-and-providers#editor-state: what the person is looking at in this task's window, every editor group; read-only, no arguments.
	{
		name: 'editor_state',
		description:
			'What the person is looking at in the window of this task: the open tabs of every editor group (files, diffs, console and browser tabs; paths relative to your working directory, the repo of each file, unsaved changes), the focused tab and its view (editor, diff or Markdown preview), the cursor (line and column from 1), every selection with its line range and text, and the visible lines; for a diff, its repo, its base and the selected diff lines with their side and whether they are added, removed or unchanged; with a split editor, what each group shows. Call it when the person says "this", "here", "this file" or "the selected code" without naming it. Read-only.',
		shape: {},
		run: async (args, call, signal) => text(await call('editor_state', args, signal)),
	},
	// spec/editor-code-intelligence#language-server-restart: the same restart as Editor ▸ Restart language servers, for this task's open files.
	{
		name: 'editor_restart_language_servers',
		description:
			"Restart the language servers behind the person's editor in this task (TypeScript and others): a new process re-reads node_modules, tsconfig and the project, reopens the open files and reports their problems again. Returns the servers restarted. After an install that finishes, the app restarts the TypeScript server by itself.",
		shape: {},
		run: async (args, call, signal) =>
			text(await call('editor_restart_language_servers', args, signal)),
	},
	{
		name: 'pr_state',
		description:
			"The pull request open in the Pull requests panel of this task (or in the active tab): number, title, state, branches, the panel tab, its files with the ones the person marked Viewed and the ones open in tabs, the PR file on screen with its visible and selected lines, the GitHub review threads (file and lines, resolved, comments), the PR comments and reviews, with the person's own marked mine, and their draft review comments not sent yet, with the replies under them. Call it when the person speaks of a pull request, its comments or the file they are reviewing. Read-only.",
		shape: {},
		run: async (args, call, signal) => text(await call('pr_state', args, signal)),
	},
];
// spec/browser-and-simulator#simulator: seven simulator tools — five see and drive the screen (points, not pixels), two read the app through Metro.
const point = z.number().min(0).max(10_000);
const simulatorTools: Tool[] = (
	[
		[
			'state',
			'State of the project simulator: the selected device, whether it runs, its screen size in points, the devices available.',
			{},
		],
		[
			'open',
			'Start the project simulator device (or the one named by device: a name or id from simulator_state) and wait until it runs; optionally launch an app by bundle id or open a URL or deep link on it. The human sees the device in the task window.',
			{
				device: z
					.string()
					.min(1)
					.max(128)
					.optional()
					.describe(
						'Pass the device the app is built and installed on when simulator_state says no device is chosen; the device you pass becomes the project device.'
					),
				app: z
					.string()
					.regex(/^[A-Za-z0-9._-]{1,255}$/)
					.optional(),
				url: z.string().max(8192).optional(),
			},
		],
		[
			'ui',
			'The accessibility tree of the device screen, one element a line: role, label, #testID and frame in points. Use it before simulator_screenshot: it is cheaper and gives exact targets. Long screens come in pages: pass offset.',
			{ grid: z.boolean().optional(), offset: z.number().int().min(0).optional() },
		],
		[
			'act',
			'One action on the device: tap, longpress or swipe at x,y (points) or at an element by id (testID) or label; swipe ends at x2,y2; type text into the focused field; key presses a KeyboardEvent code (Enter, Backspace, ArrowDown); button presses home, lock or (Android) back; rotate turns the device right (simulator_ui then gives the turned screen). The human sees each touch marked on the screen.',
			{
				action: z.enum(['tap', 'longpress', 'swipe', 'type', 'key', 'button', 'rotate']),
				x: point.optional(),
				y: point.optional(),
				x2: point.optional(),
				y2: point.optional(),
				id: z.string().min(1).max(500).optional(),
				label: z.string().min(1).max(500).optional(),
				text: z.string().min(1).max(10_000).optional(),
				key: z.string().min(1).max(32).optional(),
				button: z.enum(['home', 'lock', 'back']).optional(),
			},
		],
		[
			'screenshot',
			'A JPEG of the device screen as the human sees it, the longer side up to 1000 px. Prefer simulator_ui for finding elements.',
			{},
		],
		[
			'logs',
			'Logs of the React Native app on the device, newest last (up to 100): source js (console and errors with stacks, through Metro; default) or native (the app process, last 2 minutes). Filter by the lowest level and by text.',
			{
				source: z.enum(['js', 'native']).optional(),
				level: z.enum(['debug', 'log', 'info', 'warn', 'error']).optional(),
				grep: z.string().min(1).max(500).optional(),
			},
		],
		[
			'network',
			'Requests of the React Native app through Metro, one a line (id, method, status, time, size, URL), newest last; filter by URL text. With requestId: headers and the body (text up to 16 KiB).',
			{
				requestId: z
					.string()
					.regex(/^[A-Za-z0-9._-]{1,128}$/)
					.optional(),
				filter: z.string().min(1).max(2000).optional(),
			},
		],
	] as const
).map(([kind, description, shape]): Tool => ({
	name: `simulator_${kind}`,
	description,
	shape: shape as z.ZodRawShape,
	run: async (args, call, signal) => {
		const result = await call(`simulator_${kind}`, args, signal);
		if (
			result &&
			typeof result === 'object' &&
			'image' in result &&
			typeof result.image === 'string'
		)
			return {
				content: [
					{
						type: 'image',
						data: result.image,
						mimeType:
							'mimeType' in result && typeof result.mimeType === 'string'
								? result.mimeType
								: 'image/png',
					},
				],
			};
		return text(result);
	},
}));
// spec/pull-requests-and-ci#review-with-agent: a review task's agent leaves its findings as drafts of the person's review; nothing reaches GitHub without them.
const reviewTools: Tool[] = [
	{
		name: 'pr_comment',
		description:
			'Leave a draft review comment on lines of the pull request under review. path is the file path in the repository, line the last line in the new file (side RIGHT) or the old file (side LEFT), startLine the first line of a range. The person sees it in their review and decides what to send.',
		shape: {
			path: z.string().min(1).max(4096),
			line: z.number().int().min(1),
			startLine: z.number().int().min(1).optional(),
			side: z.enum(['LEFT', 'RIGHT']).default('RIGHT'),
			body: z.string().trim().min(1).max(65_536),
		},
		run: async (args, call, signal) => text(await call('pr_comment', args, signal)),
	},
	{
		// spec/pull-requests-and-ci#review-with-agent: the person answers a draft in its thread; the agent answers there and may rewrite the draft.
		name: 'pr_comment_reply',
		description:
			'Answer the person in the thread of one of your draft review comments. id is the draft id from their message, body your answer. Pass text to rewrite the draft itself when you agree it should change; the person removes drafts, not you.',
		shape: {
			id: z.string().min(1).max(128),
			body: z.string().trim().min(1).max(65_536),
			text: z.string().trim().min(1).max(65_536).optional(),
		},
		run: async (args, call, signal) => text(await call('pr_comment_reply', args, signal)),
	},
];
const taskId = z.string().min(1).max(128);
const crewShapes: Record<CrewToolName, { description: string; shape: z.ZodRawShape }> = {
	propose_plan: {
		description:
			'Show the human your split of the work before any worker starts. One part per agent: title, agent name (one of your agents), the files that part owns (project-relative paths or globs) and the full prompt for that agent. When your brief says you compose your crew, also pass crew: the agents the parts go to; the human approves crew and parts together. Wait for the result even if this call runs asynchronously; do not end your turn while it is pending. Returns approved and the possibly edited parts. When approved is true, immediately call create_worker_task for the approved parts without another human message. When false, revise the plan or ask what to change.',
		shape: {
			summary: z.string().max(20_000).default(''),
			crew: z
				.array(
					z.object({
						name: z.string().min(1).max(80),
						template: z.string().min(1).max(200),
						summary: z.string().max(240).optional(),
						zone: z.array(z.string().max(1024)).max(256).optional(),
						provider: z.string().max(40).optional(),
						model: z.string().max(200).optional(),
						effort: z.string().max(200).optional(),
						checkedBy: z.array(z.string().max(80)).max(64).optional(),
					})
				)
				.min(1)
				.max(64)
				.optional(),
			parts: z
				.array(
					z.object({
						title: z.string().min(1).max(80),
						agent: z.string().min(1).max(80),
						prompt: z.string().min(1).max(100_000),
						files: z.array(z.string().max(1024)).max(1024).default([]),
						scopes: z.array(z.string().max(4096)).max(512).default([]),
					})
				)
				.min(1)
				.max(64),
		},
	},
	create_worker_task: {
		description:
			'Give one of your agents a part after the plan was approved. The prompt must state which files the part owns. Each agent has one task for the whole crew: the first part creates it; a later part, once you accepted the previous one, continues in the same task and session after your tree is merged into its branch. While a part is open, change or return it with prompt_task. Returns the taskId you use in the other tools.',
		shape: {
			agent: z.string().max(80).optional(),
			title: z.string().min(1).max(80),
			prompt: z.string().min(1).max(200_000),
			files: z.array(z.string().max(1024)).max(1024).default([]),
			scopes: z.array(z.string().max(4096)).max(512).default([]),
		},
	},
	prompt_task: {
		description:
			'Send a prompt to a worker task about its open part: return work with instructions, or answer its question by passing the questionId from the question message. A next part goes through create_worker_task.',
		shape: {
			taskId,
			text: z.string().min(1).max(200_000),
			questionId: z.string().max(128).optional(),
		},
	},
	task_status: {
		description:
			'Status of a worker task: state, whether it is working, turns, changed files and a pending question. Reports arrive by themselves; do not poll.',
		shape: { taskId },
	},
	read_report: {
		description:
			'The structured report of a worker task built from its journal and diff: files, +N −M, changes outside its zone, checks and its last message. A reviewer passes the reviewId of the check it was asked to do.',
		shape: { taskId, reviewId: z.string().max(128).optional() },
	},
	read_transcript: {
		description:
			'The worker transcript with a line limit, for finding where a worker got stuck. Prefer read_report.',
		shape: { taskId, limit: z.number().int().min(1).max(200).default(40) },
	},
	read_diff: {
		description:
			'Changed files of a worker task (up to 200); with path, the unified diff of one file with line numbers in the @@ headers. full:true returns the before and after text instead (up to 64 KiB each). Read one file at a time.',
		shape: {
			taskId,
			path: z.string().max(1024).optional(),
			full: z.boolean().optional(),
			reviewId: z.string().max(128).optional(),
		},
	},
	submit_review: {
		description:
			'Send review comments to a worker task. Each comment names a changed file (project-relative path), start and end lines on the new side, and the text. The worker receives them as review comments.',
		shape: {
			taskId,
			reviewId: z.string().max(128).optional(),
			comments: z
				.array(
					z.object({
						path: z.string().min(1).max(1024),
						start: z.number().int().min(1).optional(),
						end: z.number().int().min(1).optional(),
						text: z.string().min(1).max(10_000),
					})
				)
				.min(1)
				.max(200),
		},
	},
	approve: {
		description:
			'Approve the checked work: nothing is left to fix. Requires the reviewId of the report you were asked to check.',
		shape: { taskId, reviewId: z.string().min(1).max(128) },
	},
	accept_task: {
		description:
			'Accept the finished part of a worker task: commits its changes and squashes the part into this task as one commit. Merge conflicts are left for the human.',
		shape: { taskId },
	},
	ask_foreman: {
		description:
			'Ask the agent you work for a substantive question and wait for the answer. Blocks your turn until it arrives. Permissions are decided by the human, not through this tool.',
		shape: {
			question: z.string().min(1).max(100_000),
			options: z.array(z.string().max(1000)).max(100).default([]),
		},
	},
	post_note: {
		description:
			'Share a short fact other agents of the crew need, such as a changed shared type. Not a chat: no replies, no addressees. Up to 8 KiB.',
		shape: {
			text: z.string().min(1).max(8192),
			files: z.array(z.string().max(1024)).max(64).default([]),
		},
	},
	read_notes: {
		description:
			'Read crew notes after the given sequence number (exclusive). Returns up to 100 notes, nextCursor and hasMore.',
		shape: { since: z.number().int().min(0).default(0) },
	},
};
/** The request id doubles as the idempotency key of crew calls (`post_note` after a retry), as it did through the SDK. */
const crewTool = (name: CrewToolName): Tool => ({
	name,
	...crewShapes[name],
	run: async (args, call, signal, id) =>
		text(await call('crew_tool', { tool: name, params: { ...args, callId: String(id) } }, signal)),
});
type Served = {
	tools: Map<string, Tool & { schema: z.ZodObject }>;
	list: { tools: unknown[] };
	modules: AppModules;
};
const served = new Map<string, Served>();
/**
 * Registration order of the SDK server: the human's tools, then the crew tools of the role. Built once per role and set
 * of modules; a module switched off in Settings takes its tools out of the list (spec/settings-modules-and-onboarding#modules).
 */
export function mcpTools(
	role: CrewProcessRole | null,
	modules: AppModules = defaultModules,
	review = false
): Served {
	const key = `${role ?? ''}|${Object.entries(modules)
		.filter(([, on]) => on)
		.map(([name]) => name)
		.join(',')}|${review}`;
	const cached = served.get(key);
	if (cached) return cached;
	// spec/agents-and-providers#tools-awareness: a crew worker keeps the browser, the simulator and the project commands; the person's other tools stay up the tree.
	const human = [...humanTools, ...simulatorTools].filter((tool) => {
		const module = toolModule(tool.name);
		return (!module || modules[module]) && (humanToolsAllowed(role) || isWorkspaceTool(tool.name));
	});
	const tools = [
		...human,
		// spec/pull-requests-and-ci#review-crew: a crew worker of a PR review never drafts comments — the foreman leaves the merged findings.
		...(review && modules.pullRequests && humanToolsAllowed(role) ? reviewTools : []),
		...(role ? crewTools(role).map(crewTool) : []),
	].map((tool) => ({ ...tool, schema: z.object(tool.shape) }));
	const value = {
		modules: { ...modules },
		tools: new Map(tools.map((tool) => [tool.name, tool])),
		list: {
			tools: tools.map((tool) => ({
				name: tool.name,
				description: whenToUse[tool.name]
					? `${tool.description} ${whenToUse[tool.name]}`
					: tool.description,
				inputSchema: z.toJSONSchema(tool.schema, { target: 'draft-7', io: 'input' }),
				...(readOnlyTools.has(tool.name) ? { annotations: { readOnlyHint: true } } : {}),
				execution: { taskSupport: 'forbidden' },
			})),
		},
	};
	served.set(key, value);
	return value;
}
/** Where a session reads the modules that are on and learns about a switch (`ModuleSettings` in the host). */
export type ModuleSource = {
	current(): AppModules;
	subscribe(listener: (value: AppModules) => void): () => void;
};
const fixedModules: ModuleSource = { current: () => defaultModules, subscribe: () => () => {} };
const versions = ['2025-11-25', '2025-06-18', '2025-03-26', '2024-11-05', '2024-10-07'];
type RpcError = Error & { code?: number };
/** Below every client's idle limit for a tool call; exported for the test. */
export const progressBeatMs = 60_000;
const rpcError = (code: number, message: string): RpcError =>
	Object.assign(new Error(message), { code });
const dotPath = (path: readonly PropertyKey[]) =>
	path.length
		? path.reduce<string>(
				(text, part, index) =>
					index === 0
						? String(part)
						: typeof part === 'number'
							? `${text}[${part}]`
							: `${text}.${String(part)}`,
				''
			)
		: 'object root';
async function callTool(
	served: Served,
	params: unknown,
	call: McpCall,
	signal: AbortSignal,
	id: string | number
): Promise<Content> {
	if (
		!isRecord(params) ||
		typeof params.name !== 'string' ||
		(params.arguments !== undefined && !isRecord(params.arguments))
	)
		throw rpcError(-32602, 'Invalid tools/call parameters');
	const tool = served.tools.get(params.name);
	// Codex keeps the list it read at start (spec/settings-modules-and-onboarding#modules): a tool of a module switched off since then answers with a sentence.
	if (!tool) {
		const module = toolModule(params.name);
		return toolError(
			module && !served.modules[module]
				? moduleOffMessages[module]
				: `MCP error -32602: Tool ${params.name} not found`
		);
	}
	// spec/agents-and-providers#context-tools: a tool without parameters (editor_state, pr_state) may be called without `arguments`; the rest keep the SDK's answer.
	const parsed = await tool.schema.safeParseAsync(
		params.arguments ?? (Object.keys(tool.shape).length ? undefined : {})
	);
	if (!parsed.success)
		return toolError(
			`MCP error -32602: Input validation error: Invalid arguments for tool ${tool.name}: ${parsed.error.issues.map((issue) => (issue.path.length ? `${issue.message} at ${dotPath(issue.path)}` : issue.message)).join('\n')}`
		);
	// Errors from the host become an error result with the host's own message.
	try {
		return await tool.run(parsed.data, call, signal, id);
	} catch (error) {
		return toolError(error instanceof Error ? error.message : String(error));
	}
}
/**
 * Serves MCP JSON-RPC on a socket whose handshake already authenticated the `mcp` token. Returns the data handler for
 * `Peer.handOff`. A cancelled request and a closed socket abort the call's signal (questions, plans, `ask_foreman`
 * resolve as unanswered in the host) and, like the SDK, a cancelled request gets no response.
 */
export function serveMcp(
	socket: Socket,
	role: CrewProcessRole | null,
	call: McpCall,
	modules: ModuleSource = fixedModules,
	review = false
): (chunk: string) => void {
	const tools = () => mcpTools(role, modules.current(), review),
		running = new Map<string | number, AbortController>();
	const send = (value: unknown) => {
		if (socket.destroyed) return;
		if (socket.writableLength > 32 * 1024 * 1024) {
			socket.destroy();
			return;
		}
		socket.write(`${JSON.stringify(value)}\n`);
	};
	// spec/settings-modules-and-onboarding#modules: a switch in Settings changes the list; agents that follow the notification re-read it (Claude does, Codex does not).
	let initialized = false;
	const unsubscribe = modules.subscribe(() => {
		if (initialized) send({ jsonrpc: '2.0', method: 'notifications/tools/list_changed' });
	});
	socket.once('close', () => {
		unsubscribe();
		for (const controller of running.values()) controller.abort();
		running.clear();
	});
	async function respond(
		method: string,
		params: unknown,
		signal: AbortSignal,
		id: string | number
	): Promise<unknown> {
		if (method === 'initialize') {
			const requested = isRecord(params) ? params.protocolVersion : undefined;
			// spec/agents-and-providers#tools-awareness: what the agent has besides its own tools, from the modules on now and the role of the session.
			const instructions = toolsInstructions(role, modules.current());
			return {
				protocolVersion:
					typeof requested === 'string' && versions.includes(requested) ? requested : versions[0],
				capabilities: { tools: { listChanged: true } },
				serverInfo: { name: 'brigadir', version: '0.1.0' },
				...(instructions ? { instructions } : {}),
			};
		}
		if (method === 'ping') return {};
		if (method === 'tools/list') return tools().list;
		if (method === 'tools/call') return callTool(tools(), params, call, signal, id);
		throw rpcError(-32601, 'Method not found');
	}
	function receive(message: unknown) {
		// Like the SDK's stdio transport: a malformed line is dropped, responses to us are ignored (we send no requests).
		if (!isRecord(message) || message.jsonrpc !== '2.0' || typeof message.method !== 'string')
			return;
		if (message.id === undefined) {
			if (message.method === 'notifications/initialized') initialized = true;
			if (
				message.method === 'notifications/cancelled' &&
				isRecord(message.params) &&
				(typeof message.params.requestId === 'string' ||
					typeof message.params.requestId === 'number')
			)
				running.get(message.params.requestId)?.abort();
			return;
		}
		const id = message.id;
		if (typeof id !== 'string' && typeof id !== 'number') return;
		const controller = new AbortController();
		running.set(id, controller);
		// A plan or a question waits for the person for as long as it takes; Claude drops a call silent for 30 minutes
		// unless progress arrives, so a call that asked for progress gets a heartbeat until it answers.
		const token =
			message.method === 'tools/call' && isRecord(message.params) && isRecord(message.params._meta)
				? message.params._meta.progressToken
				: undefined;
		let beats = 0;
		const heartbeat =
			typeof token === 'string' || typeof token === 'number'
				? setInterval(() => {
						if (!controller.signal.aborted)
							send({
								jsonrpc: '2.0',
								method: 'notifications/progress',
								params: { progressToken: token, progress: ++beats },
							});
					}, progressBeatMs)
				: null;
		heartbeat?.unref?.();
		void respond(message.method, message.params, controller.signal, id)
			.then(
				(result) => {
					if (!controller.signal.aborted) send({ result, jsonrpc: '2.0', id });
				},
				(error: RpcError) => {
					if (!controller.signal.aborted)
						send({
							jsonrpc: '2.0',
							id,
							error: {
								code: Number.isSafeInteger(error.code) ? error.code : -32603,
								message: error.message ?? 'Internal error',
							},
						});
				}
			)
			.finally(() => {
				if (heartbeat) clearInterval(heartbeat);
				if (running.get(id) === controller) running.delete(id);
			});
	}
	const read = framer(
		(line) => {
			try {
				receive(JSON.parse(line.endsWith('\r') ? line.slice(0, -1) : line));
			} catch {
				/* not JSON: dropped */
			}
			return true;
		},
		() => socket.destroy(new Error('Frame too large'))
	);
	return (chunk) => {
		read(chunk);
	};
}
