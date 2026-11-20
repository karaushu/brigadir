import { z } from 'zod';
import { servedTools, serveToolSet, text, type McpCall, type Served, type Tool } from './mcp';

export { serveToolSet, type McpCall } from './mcp';

/**
 * spec/settings-modules-and-onboarding#brigadir-chat-tools: the tools of the Brigadir chat's agent, served by main through `mcp-relay` the way
 * a task's host serves its own. Each tool hands its arguments to main (`call(name, args)`) and returns main's answer as text. English by rule 12.
 */
const relay =
	(name: string): Tool['run'] =>
	async (args, call, signal) =>
		text(await call(name, args, signal));
const tool = (name: string, description: string, shape: z.ZodRawShape, when?: string): Tool => ({
	name,
	description,
	shape,
	...(when ? { when } : {}),
	run: relay(name),
});
const task = z.string().trim().min(1).max(200);

export const brigadirChatTools: readonly Tool[] = [
	tool(
		'settings_find',
		"Find Brigadir's settings by words in any language, by key or by place in Settings. Returns each setting's key, place, allowed values, current value and whether the person must confirm a change.",
		{ query: z.string().max(200).optional() },
		'Call it before settings_set when you are not sure of the key or the values.'
	),
	tool(
		'settings_set',
		"Change one of Brigadir's settings. The person sees a card with the old and the new value and Undo; a setting that removes part of the app or lets agents act without asking first shows Apply and Cancel, and the call waits for that.",
		{
			key: z.string().trim().min(1).max(200),
			value: z.union([z.string().max(200), z.number(), z.boolean(), z.null()]),
		},
		'Use it when the person asks to change how Brigadir looks or works. Change only what they asked for.'
	),
	tool(
		'settings_open',
		'Open the Settings window at the row of a setting, lit for a moment.',
		{ key: z.string().trim().min(1).max(200) },
		'Use it when the person wants to see or set something themselves.'
	),
	tool(
		'setup_start',
		'Start or continue a guided setup and show its steps in the chat. kind: "slack" — the person\'s own Slack bot; "remoteAccess" — control of this machine from another computer (opens its settings, which ask for a password). Returns the steps and which are done.',
		{ kind: z.enum(['slack', 'remoteAccess']), name: z.string().trim().min(1).max(80).optional() },
		'Use it when the person asks to set up, connect or turn on one of these. For slack, pass name: what the bot is called (ask them if they did not say; Brigadir by default).'
	),
	tool(
		'secret_request',
		'Show a secret field in the chat for the person to paste a token into. The value goes from the field to Brigadir and the system key store; you never see it. kind: "slackBotToken" (xoxb-…), "slackAppToken" (xapp-…) or "slackUserToken" (xoxp-…, the person\'s own User OAuth Token for the Slack section). Waits until the person pastes it or closes the card, then returns the check: connected as @bot, the scopes that are missing, or Slack\'s error.',
		{ kind: z.enum(['slackBotToken', 'slackAppToken', 'slackUserToken']) },
		'Never ask the person to paste a token, key or password into the chat itself: use this card.'
	),
	tool(
		'open_link',
		'Show a button for a link a setup built (the Slack app pages); it opens in the browser when the person clicks it. Other links are refused.',
		{ url: z.string().url().max(8000), label: z.string().trim().min(1).max(80) }
	),
	tool(
		'create_task',
		'Propose a new task: a card with Start and Decline in the chat; waits for the person. projects: the main project first, the others join as folders. base: the branch to start from, only when the person named one. Returns the task id, or declined.',
		{
			projects: z.array(z.string().trim().min(1).max(200)).min(1).max(10),
			title: z.string().trim().min(1).max(80),
			prompt: z.string().trim().min(1).max(20000),
			base: z.string().trim().min(1).max(200).optional(),
		},
		'Use it for new work no task covers. The prompt must be complete on its own.'
	),
	tool(
		'send_to_task',
		"Send a message to another task's agent, as the person would from that task's composer.",
		{ task, text: z.string().trim().min(1).max(12000) },
		'Use it when the person asks to change or tell something to work a task already covers.'
	),
	tool(
		'ask_task',
		"Ask a task's agent a question in its own side session, without stopping or steering it. Returns its answer.",
		{ task, question: z.string().trim().min(1).max(4000) },
		'Use it for why something was done or what was decided in a task.'
	),
	tool(
		'open_task',
		'Open a task in Brigadir.',
		{ task },
		'Use it when the person wants to look at a task.'
	),
	tool(
		'note',
		"Save a note in Brigadir's Notes: the person's own words, or a summary of this chat they asked for. project: a project's name, or none.",
		{
			text: z.string().trim().min(1).max(20000),
			title: z.string().trim().min(1).max(200).optional(),
			project: z.string().trim().min(1).max(200).optional(),
		},
		'Use it when the person asks to save, note or remember something. Keep their words as they wrote them.'
	),
	tool(
		'watch',
		'Tell the person in this chat when something happens to a task: kinds "ci" (a CI run of its PR ends), "merged" (its PR is merged), "done" (a turn ends or the task is completed). Each kind tells once.',
		{
			task,
			kinds: z
				.array(z.enum(['ci', 'merged', 'done']))
				.min(1)
				.max(3),
		},
		'Use it when the person asks to let them know, ping or tell them about a task later.'
	),
	tool('unwatch', 'Stop telling about a task in this chat; without task, about every task.', {
		task: task.optional(),
	}),
];
let served: Served | null = null;
export function brigadirChatServed(): Served {
	return (served ??= servedTools(brigadirChatTools));
}
export const brigadirChatInstructions =
	"These are Brigadir's own tools: its settings, guided setups, secret fields and tasks. Use them instead of editing Brigadir's files or asking the person to do it in Settings. A token, key or password never goes through the chat: ask for it with secret_request. Only what a tool returned happened.";
/** Serves the Brigadir chat's tools on a socket `mcp-relay` handed over. */
export function serveBrigadirChat(socket: Parameters<typeof serveToolSet>[0], call: McpCall) {
	return serveToolSet(
		socket,
		{
			tools: brigadirChatServed,
			instructions: () => brigadirChatInstructions,
			subscribe: () => () => {},
		},
		call
	);
}
