import { isId, isRecord } from './workspace';
/** spec/search-menus-and-commands#project-commands: a saved shell line of a project. `repo` is relative to the project root (`''` = the root), `directory` is a folder inside it.
 *  spec/search-menus-and-commands#agent-command-tools: `agentRuns` lets the agents of every task run and stop it without a permission card; absent means false. */
export type ProjectCommand = {
	id: string;
	name: string;
	command: string;
	repo: string;
	directory: string;
	agentRuns?: boolean;
};
/** What the host runs: the line, a tab name and the folder relative to the task tree. `commandId` is null for «Run once». */
export type CommandRunSpec = {
	commandId: string | null;
	name: string;
	line: string;
	directory: string;
};
export const projectCommandLimit = 64;
const isObject = (value: unknown): value is Record<string, unknown> =>
	typeof value === 'object' && value !== null && !Array.isArray(value);
const isCommandId = (value: unknown): value is string =>
	typeof value === 'string' && /^[a-zA-Z0-9][a-zA-Z0-9_-]{0,127}$/.test(value);
export const isCommandName = (value: unknown): value is string =>
	typeof value === 'string' &&
	value.trim().length > 0 &&
	value.length <= 80 &&
	!/[\r\n\0]/.test(value);
export const isCommandLine = (value: unknown): value is string =>
	typeof value === 'string' &&
	value.trim().length > 0 &&
	value.length <= 8000 &&
	!value.includes('\0');
/** The same rule as a console `directory`: relative, no `..`, never into `.git` or `.brigadir`. */
/** spec/search-menus-and-commands#project-commands: what the renderer may ask to run. The line and folder of a saved command come from project.json, never from the renderer.
 *  spec/search-menus-and-commands#package-scripts: a «Run once» line may name a folder of the task tree (the folder of a `package.json`). */
export type CommandRunRef = { commandId: string } | { line: string; directory?: string };
export function isCommandRunRef(value: unknown): value is CommandRunRef {
	if (!isRecord(value)) return false;
	const keys = Object.keys(value);
	if (keys.length === 1 && isId(value.commandId)) return true;
	return (
		isCommandLine(value.line) &&
		keys.every((key) => key === 'line' || key === 'directory') &&
		(value.directory === undefined || isRelativeFolder(value.directory))
	);
}

export function isRelativeFolder(value: unknown): value is string {
	return (
		typeof value === 'string' &&
		value.length <= 4096 &&
		!value.startsWith('/') &&
		!value.includes('\0') &&
		(value === '' ||
			value
				.split('/')
				.every(
					(part) =>
						part !== '' && part !== '.' && part !== '..' && part !== '.git' && part !== '.brigadir'
				))
	);
}
export function isProjectCommand(value: unknown): value is ProjectCommand {
	return (
		isObject(value) &&
		isCommandId(value.id) &&
		isCommandName(value.name) &&
		isCommandLine(value.command) &&
		isRelativeFolder(value.repo) &&
		isRelativeFolder(value.directory) &&
		(value.agentRuns === undefined || typeof value.agentRuns === 'boolean')
	);
}
export function isProjectCommands(value: unknown): value is ProjectCommand[] {
	return (
		Array.isArray(value) &&
		value.length <= projectCommandLimit &&
		value.every(isProjectCommand) &&
		new Set(value.map((command) => command.id)).size === value.length
	);
}
/** A folder typed by a person: `./apps/admin/`, `apps//admin` and `.` all normalize; anything leaving the repo stays invalid. */
export function commandFolder(value: string) {
	return value
		.trim()
		.split('/')
		.filter((part) => part !== '' && part !== '.')
		.join('/');
}
export function commandDirectory(command: Pick<ProjectCommand, 'repo' | 'directory'>) {
	return [command.repo, command.directory].filter(Boolean).join('/');
}
export function commandRunSpec(command: ProjectCommand): CommandRunSpec {
	return {
		commandId: command.id,
		name: command.name,
		line: command.command,
		directory: commandDirectory(command),
	};
}
/** A «Run once» line: the tab is named by the line itself. */
export function onceRunSpec(line: string, directory = ''): CommandRunSpec {
	const name = line.trim().replace(/\s+/g, ' ');
	return {
		commandId: null,
		name: name.length > 40 ? `${name.slice(0, 39)}…` : name,
		line,
		directory,
	};
}
export function isCommandRunSpec(value: unknown): value is CommandRunSpec {
	return (
		isObject(value) &&
		(value.commandId === null || isCommandId(value.commandId)) &&
		isCommandName(value.name) &&
		isCommandLine(value.line) &&
		isRelativeFolder(value.directory)
	);
}
const ansi = /\x1b\[[0-?]*[ -/]*[@-~]|\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)|\x1b[@-Z\\-_]/g;
/** spec/search-menus-and-commands#project-commands: the first `http://localhost:N` or `http://127.0.0.1:N` in the output marks a server as ready. */
export function outputPort(text: string): number | null {
	const match = /https?:\/\/(?:localhost|127\.0\.0\.1):(\d{2,5})(?![\d])/.exec(
		text.replace(ansi, '')
	);
	const port = match ? Number(match[1]) : NaN;
	return Number.isInteger(port) && port > 0 && port < 65536 ? port : null;
}
