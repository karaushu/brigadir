import type { Socket } from 'node:net';
import { z } from 'zod';
import {
	defaultModules,
	designCheckPrompt,
	isRecord,
	moduleOffMessages,
	toolModule,
	type AppModules,
} from '@brigadir/core';
import {
	crewTools,
	humanToolsAllowed,
	isWorkspaceTool,
	slackRule,
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
	/** Its own when-to-use line instead of `whenToUse[name]` (a solo agent's `prompt_task`). */
	when?: string;
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
/** spec/design-review#shots: the id the host kept a screenshot under. */
const shotLine = (result: object): { type: 'text'; text: string }[] =>
	'shot' in result && typeof result.shot === 'string'
		? [
				{
					type: 'text',
					text: `Saved as ${result.shot}. Pass it as shot to submit_design_review.`,
				},
			]
		: [];
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
	'simulator_wait',
	'simulator_screenshot',
	'simulator_logs',
	'simulator_network',
	'editor_state',
	'pr_state',
	'commands_list',
	'commands_output',
	'console_list',
	'console_read',
	'tasks_list',
	'task_status',
	'read_report',
	'read_transcript',
	'read_diff',
	'read_notes',
	'read_plan',
	'read_sources',
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
	save_source:
		'Call it when the task comes from a ticket, a spec or a contract you were given or fetched (for example from Notion, Jira or Linear), before you present a plan.',
	submit_design_review:
		'Call it when the task has a design source (a Figma node or frame): after the screen is built and again after a fix, before you propose a review or the person creates a PR; in a review, before you approve. Every call is the whole screen: all its nodes, each with a screenshot taken after the last change.',
	smoke_start:
		'Call it once the work is done and before the review before the pull request, when your change shows in the running app: list the flows the change touches, then go through them once. Not per part, not per device, and not again to be sure.',
	smoke_report:
		'Call it when the steps of your smoke run are done, or at once when a browser or simulator tool says the report is due.',
	ready_to_look:
		'Call it as soon as a screen you build is assembled and shows in the browser or on the simulator, before your own checks of it; once per screen.',
	read_plan: 'Call it first in a plan review, with the reviewId of the check you were asked to do.',
	read_sources:
		'Call it in a plan review after read_plan, to check the plan against the ticket and the contract.',
	submit_plan_review:
		'Call it once per check of a plan review; when nothing must change, call approve instead.',
	create_task:
		'Use it when the person asks for a separate task, or when you find work outside this task that another agent should do.',
	tasks_list:
		'Call it when the person names another task and you do not have its task ID, before task_send.',
	task_send:
		'Use it when the person asks you to send, hand over or tell something to another task. Never use your own messaging or agent tools for Brigadir tasks: they do not reach them.',
	review_reply:
		'Call it only for a finding of a review batch of this task, when you do not fix it as asked.',
	set_task_class:
		'Call it once, after you read the task and the code it touches and before your first edit; call it again only when the task turns out larger or smaller.',
	request_review:
		'Call it after you finish a layer that other work builds on, such as the data layer, a shared API, a schema or a migration, before you build on top of it. Do not call it after small steps or at the end of the task: the review before the pull request covers that.',
	propose_review:
		'Call it once the work of this task is done and your own checks passed, before the person creates a pull request. Do not call it while a review runs, after a small question, or for work that is not finished.',
	add_folder: 'Use it when the work needs files outside the project, such as a sibling repository.',
	slack_post: `${slackRule} Never read a Slack token from env files or call the Slack API yourself.`,
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
	simulator_state:
		'Call it before simulator_open to see your device, whether it runs, and which devices are free; pass device to any simulator tool to take another kind.',
	simulator_open: 'Call it before you check a React Native or mobile change on the device.',
	simulator_ui:
		'Call it to find what to tap. After simulator_act you do not need it: the answer already lists what changed.',
	simulator_act:
		'Use it to go through the flow you changed on the device yourself, instead of asking the person to tap through it. It already waits for the screen and reports what changed: do not sleep, take a screenshot or read the tree after it to check that a tap worked.',
	simulator_wait:
		'Use it instead of sleep when something comes later than the action: a network response, a toast, a spinner going away.',
	simulator_screenshot:
		'Use it to look at pixels after a UI change (layout, colors, images), not to check that a tap worked.',
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
	hire_workers:
		'Call it only for two or more independent parts that are each large enough for a session of their own; do a small task yourself.',
	dismiss_worker: 'Call it when a worker’s part is not needed any more.',
	request_model: 'Call it only when no role fits a part.',
};
/** spec/design-review#tool: where something is on a screenshot, as fractions of its width and height. */
const designArea = z.object({
	x: z.number().min(0).max(1),
	y: z.number().min(0).max(1),
	width: z.number().min(0).max(1),
	height: z.number().min(0).max(1),
});
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
	// spec/tasks#task-messages: the other tasks of this project, and a message to one of them as a steering prompt.
	{
		name: 'tasks_list',
		description:
			"The other live tasks of this project, newest first: id (the task ID for task_send), title, state, branch and agent. Crew workers are not listed; write to their crew's task.",
		shape: {},
		run: async (args, call, signal) => text(await call('tasks_list', args, signal)),
	},
	{
		name: 'task_send',
		description:
			"Send a message to another task of this project. Its agent gets the text at once, inside its running turn or as a new turn (a stopped agent is started), with your task's title and ID so it can answer with task_send. taskId: the task ID from a task summary, create_task or tasks_list. text: in English, complete on its own: the other agent does not see this conversation. Returns sent: true with the task id and title, or sent: false with the reason.",
		shape: {
			taskId: z.string().trim().min(1).max(200),
			text: z.string().trim().min(1).max(100_000),
		},
		run: async (args, call, signal) => text(await call('task_send', args, signal)),
	},
	// spec/reviews#start: a card in the chat that offers the person a review of this task's changes by other agents.
	{
		name: 'propose_review',
		description:
			"Offer the person a review of this task's changes by another agent before the pull request. The person sees a card and starts the review or dismisses it; the call does not wait. When the person starts it, the reviewer reads your changes once and its findings come back to you as a review batch: fix each one once, or object to it with review_reply; the reviewer then checks only whether each finding is closed. summary: one or two sentences on what was done and what the reviewer should look at. Returns proposed: true, or the reason it was refused.",
		shape: { summary: z.string().trim().max(4000).default('') },
		run: async (args, call, signal) => text(await call('propose_review', args, signal)),
	},
	// spec/reviews#request-tool: the host decides and runs a mid-task review; the agent works on.
	{
		name: 'request_review',
		description:
			"Ask Brigadir for a mid-task review of this task's changes by another agent. Brigadir decides: it refuses while a review of the task runs, when nothing changed since the last review, or when no reviewer is available. A started review reads the task's state now, so keep working; its findings arrive later as a review batch: fix each one once, or object to it with review_reply. reason: what you just finished, e.g. 'the data layer'. Returns started: true with the reviewer, or started: false with the reason.",
		shape: { reason: z.string().trim().min(1).max(500) },
		run: async (args, call, signal) => text(await call('request_review', args, signal)),
	},
	// spec/reviews#class-tool: the agent states the task's class; the answer says what the class needs next.
	{
		name: 'set_task_class',
		description:
			"State this task's class in Brigadir: small (one chain of steps, no contract change), medium (a source ticket or contract, or the data layer, an API or migrations are touched) or large (workers are going to be hired, or the work comes in layers that other work builds on). The person sees it in the chat. reason: one line on why, e.g. 'one screen, no contract change'. Returns the class and next: what the class needs from you now — follow it.",
		shape: {
			class: z.enum(['small', 'medium', 'large']),
			reason: z.string().trim().min(1).max(200),
		},
		run: async (args, call, signal) => text(await call('set_task_class', args, signal)),
	},
	// spec/reviews#save-source: the plan's author saves the ticket or contract text, so a reviewer on any provider reads the same version.
	{
		name: 'save_source',
		description:
			"Save the text of a source this task's plan is written from — a ticket, a spec, an API contract — into the task's folder, so the plan's reviewer reads the same version. title: its name (for example 'CRM-412 Client notes'); url: where it lives, if anywhere; text: the source as it reads, up to 200 000 characters. A source with the same title replaces the earlier one. Returns saved: true with its id.",
		shape: {
			title: z.string().trim().min(1).max(200),
			url: z.string().trim().max(2000).optional(),
			text: z.string().min(1).max(200_000),
		},
		run: async (args, call, signal) => text(await call('save_source', args, signal)),
	},
	// spec/design-review#tool: a screen checked against its design node by node; the host verifies the images and screenshots itself.
	{
		name: 'submit_design_review',
		description: `File a design review of one screen: per design node its Figma reference, its image from the design and a device screenshot of this task, with a table of properties. ${designCheckPrompt} screen: the screen or state checked. nodes[].figma: the node's Figma link with node-id, or its id; figmaImage: an absolute path of a PNG, JPEG or WebP file with the node's image from the design, or an http(s) address of it; shot: the id simulator_screenshot or browser_screenshot gave (s12); area: the node's frame on the screenshot, tight around the node (its frame from simulator_ui or browser_ui), never the screen or a section around it, as fractions 0–1 of the screenshot's width and height; rows[].area: the element a row is about, the same way. verdict: passed only when every row matches. reviewId: when you file it as part of a review you were asked to do. The host checks every node itself: a node without a readable design image, without a screenshot of this task, or whose screenshot was taken before the task's files changed is not accepted, with all its rows. Returns the state (passed, mismatch or refused) and exactly which nodes to redo.`,
		shape: {
			screen: z.string().trim().min(1).max(80),
			nodes: z
				.array(
					z.object({
						name: z.string().trim().min(1).max(80),
						figma: z.string().trim().min(1).max(500),
						figmaImage: z.string().trim().min(1).max(8192),
						shot: z.string().trim().min(1).max(20),
						area: designArea.optional(),
						rows: z
							.array(
								z.object({
									property: z.string().trim().min(1).max(80),
									expected: z.string().trim().min(1).max(200),
									actual: z.string().trim().min(1).max(200),
									match: z.boolean(),
									area: designArea.optional(),
								})
							)
							.min(1)
							.max(40),
					})
				)
				.min(1)
				.max(24),
			verdict: z.enum(['passed', 'mismatch']),
			reviewId: z.string().trim().min(1).max(128).optional(),
		},
		run: async (args, call, signal) => text(await call('submit_design_review', args, signal)),
	},
	// spec/smoke-run#start: one pass through the flows a change touches, under the limit the person set; the host stops it at the limit.
	{
		name: 'smoke_start',
		description:
			"Start a smoke run of this task: one pass through the flows your change touches, in the browser or on the simulator, under a time limit the person sets. The person sees it running above the composer. steps: the flows in the order you go through them, e.g. 'Clients list', 'Client card · tabs'. At the limit Brigadir stops the run: the browser and simulator tools stop answering until you file the report with smoke_report. Returns started: true with the limit in minutes and when it ends.",
		shape: {
			steps: z.array(z.string().trim().min(1).max(120)).min(1).max(12),
		},
		run: async (args, call, signal) => text(await call('smoke_start', args, signal)),
	},
	{
		name: 'smoke_report',
		description:
			"File the report of this task's smoke run: each step with its result — passed, failed (note: what goes wrong, on which screen) or unchecked (note: why it was not checked) — and a summary of a few sentences for the person and the reviewer. A started step you leave out counts as unchecked. The review before the pull request reads the report: a failed step you do not fix becomes a finding. Returns reported: true with the counts and what to do next.",
		shape: {
			steps: z
				.array(
					z.object({
						step: z.string().trim().min(1).max(120),
						result: z.enum(['passed', 'failed', 'unchecked']),
						note: z.string().trim().max(500).optional(),
					})
				)
				.min(1)
				.max(24),
			summary: z.string().trim().min(1).max(2000),
		},
		run: async (args, call, signal) => text(await call('smoke_report', args, signal)),
	},
	// spec/smoke-run#ready: the person hears that a screen can be looked at; the agent goes on.
	{
		name: 'ready_to_look',
		description:
			"Tell the person that a screen is assembled and can be looked at: they get a notification and a row in the chat that opens it. It does not wait and asks nothing; keep working. screen: what to look at, e.g. 'Details screen'. where: simulator (the task's device) or browser. tab: the browser tab (default: the tab you opened). The same screen again is not announced twice. Returns notified: true, or notified: false with the reason.",
		shape: {
			screen: z.string().trim().min(1).max(80),
			where: z.enum(['simulator', 'browser']),
			tab: browserTab,
		},
		run: async (args, call, signal) => text(await call('ready_to_look', args, signal)),
	},
	{
		name: 'review_reply',
		description:
			"Object to a reviewer's finding from a review batch of this task's own review: the reply joins the finding's thread, and the reviewer reads it in its closure check. Use it for a finding you do not fix as asked, with your reason. commentId: the comment id from the batch. Returns replied: true, or the reason it failed.",
		shape: {
			commentId: z.string().trim().min(1).max(100),
			text: z.string().trim().min(1).max(10_000),
		},
		run: async (args, call, signal) => text(await call('review_reply', args, signal)),
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
				return {
					content: [
						{ type: 'image', data: result.image, mimeType: 'image/png' },
						...shotLine(result),
					],
				};
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
// spec/browser-and-simulator#sim-tools: eight simulator tools — six see and drive the screen (points, not pixels), two read the app through Metro.
// spec/browser-and-simulator#sim-lease: every tool takes `device`; without it the task's own device, else the project's.
const point = z.number().min(0).max(10_000);
const device = z
	.string()
	.min(1)
	.max(128)
	.optional()
	.describe(
		"The device to use: a kind (iPhone, iPad, Android), a model (iPhone 17 Pro, Pixel 9), or a name or id from simulator_state. It becomes your task's device. Leave it out to keep your task's device, else the project's. A crew worker gets a device of its own (an iOS copy with the app installed) when one can start, and its own Metro port."
	);
const simulatorTools: Tool[] = (
	[
		[
			'state',
			"State of your task's simulator device (or the project's, until you use one): whether it runs, its screen size in points, the local devices running against the cap, low memory, your task's Metro port, and every device with who holds it.",
			{ device },
		],
		[
			'open',
			"Start your task's simulator device (or the one named by device) and wait until it runs, then point the app at your task's Metro when it runs in your worktree; optionally launch an app by bundle id or open a URL or deep link on it. The human sees the device in the task window. When simulator_state says no device is chosen, pass the device the app is built and installed on.",
			{
				device,
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
			{ device, grid: z.boolean().optional(), offset: z.number().int().min(0).optional() },
		],
		[
			'act',
			'One action on the device: tap, longpress or swipe at x,y (points) or at an element by id (testID) or label; swipe ends at x2,y2; type text into the focused field; key presses a KeyboardEvent code (Enter, Backspace, ArrowDown); button presses home, lock or (Android) back; rotate turns the device right. Answers once the screen has been still for 0.4 s (5 s at most, and it says so when the screen was still moving), with what changed in the accessibility tree: elements that appeared (+), disappeared (-) or changed label or value (~); on Android it gives no tree changes. The human sees each touch marked on the screen.',
			{
				device,
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
			'wait',
			'Waits on the device until an element appears, or with gone: true disappears: text (in a label or value, ignoring case), id (testID) or label, exactly one. Reads the accessibility tree each time the screen changes, up to timeoutMs (default 10000, at most 30000). Answers with the element found, or a timeout and the screen as it was last read.',
			{
				device,
				text: z.string().min(1).max(500).optional(),
				id: z.string().min(1).max(500).optional(),
				label: z.string().min(1).max(500).optional(),
				gone: z.boolean().optional(),
				timeoutMs: z.number().int().min(0).max(30_000).optional(),
			},
		],
		[
			'screenshot',
			'A JPEG of the device screen as the human sees it, the longer side up to 1000 px: for looking at pixels. Prefer simulator_ui for finding elements; simulator_act already says whether an action worked.',
			{ device },
		],
		[
			'logs',
			'Logs of the React Native app on the device, newest last (up to 100): source js (console and errors with stacks, through Metro; default) or native (the app process, last 2 minutes). Filter by the lowest level and by text.',
			{
				device,
				source: z.enum(['js', 'native']).optional(),
				level: z.enum(['debug', 'log', 'info', 'warn', 'error']).optional(),
				grep: z.string().min(1).max(500).optional(),
			},
		],
		[
			'network',
			'Requests of the React Native app through Metro, one a line (id, method, status, time, size, URL), newest last; filter by URL text. With requestId: headers and the body (text up to 16 KiB).',
			{
				device,
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
					...shotLine(result),
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
			"Give one of your agents a part after the plan was approved. The prompt must state which files the part owns and the command that proves the part is done. acceptance: what must hold for the part to count as done; the agent's reviewers check the change against it and the prompt. Each agent has one task for the whole crew: the first part creates it; a later part, once you accepted the previous one, continues in the same task and session after your tree is merged into its branch. While a part is open, change or return it with prompt_task. Returns the taskId you use in the other tools.",
		shape: {
			agent: z.string().max(80).optional(),
			title: z.string().min(1).max(80),
			prompt: z.string().min(1).max(200_000),
			files: z.array(z.string().max(1024)).max(1024).default([]),
			scopes: z.array(z.string().max(4096)).max(512).default([]),
			acceptance: z.string().max(20_000).optional(),
		},
	},
	prompt_task: {
		description:
			'Send a prompt to a worker task about its open part: return work with instructions, or answer its question by passing the questionId from the question message. When the same part comes back wrong again, pass effort one level higher (a level name of its model, like High); it stays for the rest of its task. A next part goes through create_worker_task.',
		shape: {
			taskId,
			text: z.string().min(1).max(200_000),
			questionId: z.string().max(128).optional(),
			effort: z.string().max(64).optional(),
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
			"Send review comments to a worker task. Each comment names a changed file (project-relative path), start and end lines on the new side, and the text. The worker receives them as review comments. In a closure check of a task's own review, an item is either {replyTo: <finding id>, text} for a finding still open, or {path, start, text, introduced: true} for a problem the fix brought in.",
		shape: {
			taskId,
			reviewId: z.string().max(128).optional(),
			// spec/reviews#loop: a closure check names an open finding by `replyTo` (no path) or flags a problem the fix introduced.
			comments: z
				.array(
					z
						.object({
							path: z.string().min(1).max(1024).optional(),
							start: z.number().int().min(1).optional(),
							end: z.number().int().min(1).optional(),
							text: z.string().min(1).max(10_000),
							replyTo: z.string().min(1).max(100).optional(),
							introduced: z.boolean().optional(),
						})
						.refine((item) => item.path !== undefined || item.replyTo !== undefined, {
							message: 'Each comment needs a path, or replyTo for a finding still open',
						})
				)
				.min(1)
				.max(200),
		},
	},
	approve: {
		description:
			'Approve the checked work: nothing is left to fix. Requires the reviewId of the report you were asked to check. note: an optional remark for the person that needs no fix (a risk to watch, the check you ran); it starts no fix.',
		shape: {
			taskId,
			reviewId: z.string().min(1).max(128),
			note: z.string().min(1).max(2000).optional(),
		},
	},
	// spec/reviews#plan-inputs, spec/reviews#plan-verdict: a plan review reads the plan and the sources through the host, on any provider.
	read_plan: {
		description:
			"The plan of a plan review, as the author presented it (a foreman's split as Markdown with its parts and crew). In a closure check it also returns diff: the line diff from the revision you read before.",
		shape: { taskId, reviewId: z.string().min(1).max(128) },
	},
	read_sources: {
		description:
			'The sources the plan was written from, as its author saved them: the ticket, a spec, an API contract. Texts are cut when one call passes 200 000 characters; pass sourceId to read one source whole.',
		shape: {
			taskId,
			reviewId: z.string().min(1).max(128),
			sourceId: z.string().max(128).optional(),
		},
	},
	submit_plan_review: {
		description:
			"The verdict of a plan review. First read: findings [{kind, text, where?}] with kind missed, contradicts, out-of-scope (the plan against the ticket), assumption, left-open, unverifiable (against the repo and the contract), split (a foreman's split), and gaps [{text, where?}]: what the ticket itself leaves open, questions for the person. At most 12 items in all, the most severe first. Closure check: findings only, each {replyTo: <finding id>, text} for a finding still open or {kind, text, where?, introduced: true} for a problem the revision brought in.",
		shape: {
			taskId,
			reviewId: z.string().min(1).max(128),
			findings: z
				.array(
					z.object({
						kind: z.string().max(40).optional(),
						text: z.string().min(1).max(10_000),
						where: z.string().max(200).optional(),
						replyTo: z.string().min(1).max(100).optional(),
						introduced: z.boolean().optional(),
					})
				)
				.max(48)
				.default([]),
			gaps: z
				.array(
					z.object({ text: z.string().min(1).max(2000), where: z.string().max(200).optional() })
				)
				.max(12)
				.default([]),
		},
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
	// spec/crew#auto-tools: the Auto agent's hire; the card waits for the person like a plan.
	hire_workers: {
		description:
			'Hire workers for independent parts of this task: each part becomes a worker task in its own worktree, started from a commit of your edits so far. Per part: title, role (the name of the role whose when-to-use line fits the part), zone (the paths or globs it writes; zones of parts never overlap, and you no longer write inside them), lines and files (your estimate of what it changes), the full prompt for the worker (it sees nothing of this conversation: the goal, the expected behaviour, what stays untouched, the command that proves it), optionally acceptance, scopes, minutes and tokens (its budget; the default applies otherwise). summary says on the card what each part is and why the parts are independent. The person approves, edits or declines; wait for the result even if this call runs asynchronously. A part that overlaps another or is too small for a worker stays with you, and the rest are hired. Declined means you do the parts yourself.',
		shape: {
			summary: z.string().max(20_000).default(''),
			parts: z
				.array(
					z.object({
						title: z.string().min(1).max(80),
						role: z.string().min(1).max(80),
						zone: z.array(z.string().min(1).max(1024)).min(1).max(256),
						lines: z.number().int().min(0).max(10_000_000),
						files: z.number().int().min(1).max(100_000).optional(),
						prompt: z.string().min(1).max(100_000),
						acceptance: z.string().max(20_000).optional(),
						scopes: z.array(z.string().max(4096)).max(512).default([]),
						minutes: z.number().int().min(1).max(600).optional(),
						tokens: z.number().int().min(1).max(20_000_000).optional(),
					})
				)
				.min(1)
				.max(16),
		},
	},
	dismiss_worker: {
		description:
			'Dismiss a hired worker without accepting its part: its session stops, its task keeps its diff, nothing of it is merged, and the part is yours again. accept_task dismisses a worker by itself.',
		shape: { taskId },
	},
	request_model: {
		description:
			'Ask for a model outside your roles when no role fits a part. reason says why; role is the base role the part keeps if the person declines (Developer by default); provider, model and effort are what you would like. The person chooses on a card (or, when the settings allow, the names you pass are checked against the catalog at once). The result names the role to hire the part with.',
		shape: {
			reason: z.string().min(1).max(2000),
			role: z.string().max(80).optional(),
			part: z.string().max(80).optional(),
			provider: z.string().max(40).optional(),
			model: z.string().max(200).optional(),
			effort: z.string().max(200).optional(),
		},
	},
};
/** The request id doubles as the idempotency key of crew calls (`post_note` after a retry), as it did through the SDK. */
const crewTool = (name: CrewToolName): Tool => ({
	name,
	...crewShapes[name],
	run: async (args, call, signal, id) =>
		text(await call('crew_tool', { tool: name, params: { ...args, callId: String(id) } }, signal)),
});
/**
 * spec/reviews#reviewer-questions: a solo task's agent answers its own reviewers' `ask_foreman` questions. Listed from the first session (a review
 * starts mid-session and Codex does not read the list again); the host takes only an answer to an open question of the task's own reviewer.
 */
const soloAnswerTool: Tool = {
	name: 'prompt_task',
	description:
		"Answer a question that a reviewer of this task's review asked you: taskId is the reviewer's task and questionId comes from the question message. The answer returns into the reviewer's waiting call. It answers nothing else and prompts no other task.",
	when: 'Use it only when a reviewer of this task asked you a question.',
	shape: {
		taskId,
		text: z.string().min(1).max(200_000),
		questionId: z.string().min(1).max(128),
	},
	run: async (args, call, signal, id) =>
		text(
			await call(
				'crew_tool',
				{ tool: 'prompt_task', params: { ...args, callId: String(id) } },
				signal
			)
		),
};
type Served = {
	tools: Map<string, Tool & { schema: z.ZodObject }>;
	list: { tools: unknown[] };
	modules: AppModules;
	hidden: ReadonlySet<string>;
};
/** spec/crew#roles: what a hidden tool answers when an agent calls it from a list it read before. English by rule 12. */
export const hiddenToolMessages: Record<string, string> = {
	create_task:
		'create_task is not available while your crew plan exists: run the plan in this task with create_worker_task.',
};
const noHidden: ReadonlySet<string> = new Set();
const ownReviewTools: ReadonlySet<string> = new Set(['request_review', 'review_reply']);
const smokeTools: ReadonlySet<string> = new Set(['smoke_start', 'smoke_report', 'ready_to_look']);
const served = new Map<string, Served>();
/**
 * Registration order of the SDK server: the human's tools, then the crew tools of the role. Built once per role and set
 * of modules; a module switched off in Settings takes its tools out of the list (spec/settings-modules-and-onboarding#modules).
 */
export function mcpTools(
	role: CrewProcessRole | null,
	modules: AppModules = defaultModules,
	review = false,
	/** spec/crew#roles: tools the session does not have right now (`create_task` while the root foreman's crew plan exists). */
	hidden: ReadonlySet<string> = noHidden
): Served {
	const key = `${role ?? ''}|${Object.entries(modules)
		.filter(([, on]) => on)
		.map(([name]) => name)
		.join(',')}|${review}|${[...hidden].sort().join(',')}`;
	const cached = served.get(key);
	if (cached) return cached;
	// spec/agents-and-providers#tools-awareness: a crew worker keeps the browser, the simulator and the project commands; the person's other tools stay up the tree.
	const human = [...humanTools, ...simulatorTools].filter((tool) => {
		const module = toolModule(tool.name);
		return (
			(!module || modules[module]) &&
			// spec/reviews#classes: a named crew's foreman has no class — its split gets the plan review.
			!(role === 'foreman' && tool.name === 'set_task_class') &&
			// spec/design-review#who: any agent with the simulator or the browser files a design review.
			(tool.name !== 'submit_design_review' || modules.simulator || modules.browser) &&
			// spec/smoke-run#start: a solo agent, an Auto agent and a crew developer, with the simulator or the browser.
			(!smokeTools.has(tool.name) ||
				((modules.simulator || modules.browser) &&
					(role === null || role === 'auto' || role === 'developer'))) &&
			(humanToolsAllowed(role) ||
				isWorkspaceTool(tool.name) ||
				tool.name === 'submit_design_review' ||
				smokeTools.has(tool.name) ||
				// spec/reviews#points: a crew developer's part is a task with reviews of its own.
				(role === 'developer' && ownReviewTools.has(tool.name)))
		);
	});
	const tools = [
		...human,
		// spec/pull-requests-and-ci#review-crew: a crew worker of a PR review never drafts comments — the foreman leaves the merged findings.
		...(review && modules.pullRequests && humanToolsAllowed(role) ? reviewTools : []),
		...(role ? crewTools(role).map(crewTool) : [soloAnswerTool]),
	]
		.filter((tool) => !hidden.has(tool.name))
		.map((tool) => ({ ...tool, schema: z.object(tool.shape) }));
	const value = {
		modules: { ...modules },
		hidden,
		tools: new Map(tools.map((tool) => [tool.name, tool])),
		list: {
			tools: tools.map((tool) => ({
				name: tool.name,
				description:
					(tool.when ?? whenToUse[tool.name])
						? `${tool.description} ${tool.when ?? whenToUse[tool.name]}`
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
/** spec/crew#roles: the tools a session lacks right now and a notice when that changes. */
export type HiddenToolSource = {
	current(): ReadonlySet<string>;
	subscribe(listener: () => void): () => void;
};
const nothingHidden: HiddenToolSource = { current: () => noHidden, subscribe: () => () => {} };
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
		const hidden = served.hidden.has(params.name) ? hiddenToolMessages[params.name] : undefined;
		if (hidden) return toolError(hidden);
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
	review = false,
	hidden: HiddenToolSource = nothingHidden
): (chunk: string) => void {
	const tools = () => mcpTools(role, modules.current(), review, hidden.current()),
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
	const unsubscribeHidden = hidden.subscribe(() => {
		if (initialized) send({ jsonrpc: '2.0', method: 'notifications/tools/list_changed' });
	});
	socket.once('close', () => {
		unsubscribe();
		unsubscribeHidden();
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
