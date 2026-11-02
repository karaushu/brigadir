import type { AgentProvider } from './agent';
import type { EventRecord } from './session';
import { mcpCall } from './mcp-tools';
import { isId, isRecord } from './workspace';
/**
 * spec/composer#slash-menu: the `/` menu, apart from any text surface. The trigger is a function of the text and the caret, the
 * entries are a function of what the disk, the agent and the task log say. The task composer and the prompt editor
 * of the New task sheet use both; neither knows the other's DOM.
 */

/** A command or a skill as it lies on disk or as the agent announced it (`available_commands_update`, spec/agents-and-providers#transport). */
export type SlashCommandInfo = { name: string; description: string; inputHint: string | null };
/** What the agent of a task will see, read from disk before it starts (main `slash-catalog`). */
export type SlashCatalog = {
	provider: AgentProvider;
	/** Custom commands (Claude `.claude/commands`, plugin commands): the agent runs them in the text too. */
	commands: SlashCommandInfo[];
	/** Skills under the agent's own names (`name`, `plugin:name`, Codex `$name`). */
	skills: SlashCommandInfo[];
	/** Last parts of skills whose full name only the agent knows (claude.ai skills synced to `~/.claude/skills/synced`). */
	skillBasenames: string[];
	/** The tools our `brigadir` server gives this task: role, modules, PR review (spec/settings-modules-and-onboarding#modules, spec/pull-requests-and-ci#review-with-agent). */
	tools: { server: string; tool: string; description: string }[];
	/** MCP servers of the person's agent settings; their tools are known only to the agent. */
	servers: string[];
};
export type SlashKind = 'command' | 'skill' | 'tool' | 'action';
/** The menu's group order (spec/composer#slash-menu: actions above the MCP tools). */
export const slashKinds: readonly SlashKind[] = ['command', 'skill', 'action', 'tool'];
export type SlashAction = 'attach' | 'browser-screenshot' | 'simulator-screenshot';
export type SlashEntry = {
	kind: SlashKind;
	key: string;
	/** What the menu row shows: the text the pick inserts, or the action's name. */
	label: string;
	description: string;
	inputHint: string | null;
	/** The text a pick puts in place of `/query`; an action puts nothing and runs. */
	insert: string;
	/** It works in the middle of a message; built-in agent commands work only as its first word (spec/composer#slash-menu). */
	anywhere: boolean;
	action?: SlashAction;
	/** A server whose tools we do not know: the row's tail says it is a server. */
	server?: true;
};
export type SlashTrigger = {
	from: number;
	to: number;
	query: string;
	/** The `/` is the first character of the message. */ start: boolean;
};

/**
 * `/` at the start of a word opens the menu anywhere in the text: first, after a space or a line break. `a/b`, a second
 * `/` in the word (`/usr/bin`) and anything after a space in the query stay text. `to` ends the word the caret is in.
 */
export function slashTrigger(text: string, caret: number): SlashTrigger | null {
	const match = /(^|\s)\/([^\s/]*)$/.exec(text.slice(0, caret));
	if (!match) return null;
	const rest = /^\S*/.exec(text.slice(caret))![0];
	if (rest.includes('/')) return null;
	const from = caret - match[2]!.length - 1;
	return { from, to: caret + rest.length, query: match[2]!, start: from === 0 };
}

/** The commands the agent announced last, or `null` while it has announced none. */
export function agentSlashCommands(records: readonly EventRecord[]): SlashCommandInfo[] | null {
	const event = records.findLast((record) => record.event.kind === 'commands.changed')?.event;
	return event?.kind === 'commands.changed' ? event.commands : null;
}
/** Tools of other servers the agent already called in this task (spec/chat#mcp-calls), by their exact names. */
export function loggedMcpTools(
	records: readonly EventRecord[]
): { server: string; tool: string }[] {
	const seen = new Map<string, { server: string; tool: string }>();
	for (const record of records) {
		if (record.event.kind !== 'tool.changed') continue;
		const call = mcpCall(record.event.patch);
		if (call && !seen.has(`${call.server}\0${call.tool}`))
			seen.set(`${call.server}\0${call.tool}`, { server: call.server, tool: call.tool });
	}
	return [...seen.values()];
}

const lastPart = (name: string) => name.split(/:|__/).at(-1) ?? name;
const commandInsert = (name: string) => (name.startsWith('$') ? name : `/${name}`);
export const mcpToolName = (server: string, tool: string) => `mcp__${server}__${tool}`;

/**
 * The menu's entries. With the agent's list its commands and skills are the agent's; the disk only tells a skill or a
 * custom command (both work in the text) from a built-in command (only as the first word). Without it the disk is
 * the list, and `preliminary` says so: until the agent announces, its built-in commands are missing. Tools and actions come from the task, whatever the agent announced.
 */
export function slashEntries({
	catalog,
	agent,
	logged = [],
	actions = [],
}: {
	catalog: SlashCatalog | null;
	agent: readonly SlashCommandInfo[] | null;
	logged?: readonly { server: string; tool: string }[];
	actions?: readonly { action: SlashAction; label: string; description: string }[];
}): { entries: SlashEntry[]; preliminary: boolean } {
	const entries: SlashEntry[] = [];
	const skills = new Set(catalog?.skills.map((skill) => skill.name)),
		custom = new Set(catalog?.commands.map((command) => command.name)),
		basenames = new Set(catalog?.skillBasenames);
	const command = (
		kind: 'command' | 'skill',
		info: SlashCommandInfo,
		anywhere: boolean
	): SlashEntry => ({
		kind,
		key: `${kind}:${info.name}`,
		label: commandInsert(info.name),
		description: info.description,
		inputHint: info.inputHint,
		insert: commandInsert(info.name),
		anywhere,
	});
	if (agent) {
		for (const info of agent) {
			const skill =
				info.name.startsWith('$') ||
				skills.has(info.name) ||
				(info.name.includes(':') &&
					!info.name.startsWith('mcp:') &&
					basenames.has(lastPart(info.name)));
			entries.push(command(skill ? 'skill' : 'command', info, skill || custom.has(info.name)));
		}
	} else if (catalog) {
		for (const info of catalog.commands) entries.push(command('command', info, true));
		for (const info of catalog.skills) entries.push(command('skill', info, true));
	}
	const tools = new Map<string, SlashEntry>();
	const tool = (server: string, name: string, description: string) => {
		const insert = mcpToolName(server, name);
		if (!tools.has(insert))
			tools.set(insert, {
				kind: 'tool',
				key: `tool:${insert}`,
				label: insert,
				description,
				inputHint: null,
				insert,
				anywhere: true,
			});
	};
	for (const item of catalog?.tools ?? []) tool(item.server, item.tool, item.description);
	for (const item of logged) tool(item.server, item.tool, '');
	const known = new Set([...tools.values()].map((entry) => entry.insert.split('__')[1]));
	for (const server of catalog?.servers ?? [])
		if (!known.has(server)) {
			const insert = `mcp__${server}`;
			tools.set(insert, {
				kind: 'tool',
				key: `server:${server}`,
				label: insert,
				description: '',
				inputHint: null,
				insert,
				anywhere: true,
				server: true,
			});
		}
	entries.push(...tools.values());
	for (const item of actions)
		entries.push({
			kind: 'action',
			key: `action:${item.action}`,
			label: item.label,
			description: item.description,
			inputHint: null,
			insert: '',
			anywhere: true,
			action: item.action,
		});
	return { entries, preliminary: !agent };
}

/** spec/composer#slash-highlight: what a pick inserts → its entry; actions insert nothing and never stand in the text. */
export function slashIndex(entries: readonly SlashEntry[]): ReadonlyMap<string, SlashEntry> {
	const index = new Map<string, SlashEntry>();
	for (const entry of entries)
		if (entry.insert && !index.has(entry.insert)) index.set(entry.insert, entry);
	return index;
}
/**
 * spec/composer#slash-highlight: the words of `text` that name an entry of the `/` list, as a pick inserts it — a whole word, the brackets, quotes and
 * punctuation of the sentence around it aside. A built-in command counts only as the message's first word (`start`: `text` begins
 * the message), where the agent runs it. `/usr/bin`, `a/b` and a name the list does not have stay text.
 */
export function slashWords(
	text: string,
	index: ReadonlyMap<string, SlashEntry>,
	start: boolean
): { from: number; to: number; entry: SlashEntry }[] {
	const found: { from: number; to: number; entry: SlashEntry }[] = [];
	if (!index.size) return found;
	for (const match of text.matchAll(/\S+/g)) {
		const word = match[0],
			lead = /^[(\[{"'«“]*/.exec(word)![0].length,
			tail = /[.,;:!?)\]}"'»”…]*$/.exec(word.slice(lead))![0].length;
		const name = word.slice(lead, word.length - tail),
			entry = index.get(name);
		const from = match.index + lead;
		if (entry && (entry.anywhere || (start && from === 0)))
			found.push({ from, to: from + name.length, entry });
	}
	return found;
}

/**
 * What the menu shows for `query`: in the middle of a message only what works there. Groups in a fixed order
 * (Slash commands, Skills, Actions, MCP tools); inside one, a match at the start of the name or of its last part
 * (`use` → `figma:figma-use`, `open` → `mcp__brigadir__browser_open`), then in the name, then in the description,
 * in the source's order within a rank (spec/composer#mention-menu).
 */
export function matchSlash(
	entries: readonly SlashEntry[],
	query: string,
	start: boolean,
	limit = 200
): SlashEntry[] {
	const needle = query.toLocaleLowerCase(),
		ranked: { entry: SlashEntry; group: number; rank: number; index: number }[] = [];
	entries.forEach((entry, index) => {
		if (!start && !entry.anywhere) return;
		const name = (
			entry.kind === 'action' ? entry.label : entry.insert.replace(/^[/$]/, '')
		).toLocaleLowerCase();
		const rank =
			name.startsWith(needle) || lastPart(name).startsWith(needle)
				? 0
				: name.includes(needle)
					? 1
					: entry.description.toLocaleLowerCase().includes(needle)
						? 2
						: -1;
		if (rank >= 0) ranked.push({ entry, group: slashKinds.indexOf(entry.kind), rank, index });
	});
	return ranked
		.sort((a, b) => a.group - b.group || a.rank - b.rank || a.index - b.index)
		.slice(0, limit)
		.map((item) => item.entry);
}
/** What the composer asks main for: a task's catalog, or a project's from the New task sheet. */
export type SlashCatalogRequest = {
	projectId: string;
	provider: AgentProvider;
	taskId?: string;
	crew?: boolean;
};
export function isSlashCatalogRequest(value: unknown): value is SlashCatalogRequest {
	return (
		isRecord(value) &&
		isId(value.projectId) &&
		(value.provider === 'claude' || value.provider === 'codex') &&
		(value.taskId === undefined || isId(value.taskId)) &&
		(value.crew === undefined || typeof value.crew === 'boolean') &&
		Object.keys(value).every((key) => ['projectId', 'provider', 'taskId', 'crew'].includes(key))
	);
}
