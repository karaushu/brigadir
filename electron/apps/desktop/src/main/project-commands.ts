import { SessionStore } from '@brigadir/persistence';
import {
	commandRunSpec,
	isProjectCommands,
	onceRunSpec,
	isCommandRunRef,
	type CommandRunRef,
	type ProjectCommand,
	type TaskKey,
	type TerminalCommand,
	type TerminalInfo,
} from '@brigadir/core';
export { isCommandRunRef, type CommandRunRef };
export async function saveProjectCommands(
	dataDir: string | undefined,
	projectId: string,
	commands: ProjectCommand[]
) {
	if (!isProjectCommands(commands)) throw new Error('Invalid project commands');
	return (await SessionStore.at(dataDir)).setProjectCommands(projectId, commands);
}
export async function runProjectCommand(
	dataDir: string | undefined,
	terminal: (key: TaskKey, command: TerminalCommand) => Promise<unknown>,
	key: TaskKey,
	ref: CommandRunRef
): Promise<TerminalInfo> {
	if ('line' in ref)
		return (await terminal(key, {
			kind: 'run',
			run: onceRunSpec(ref.line, ref.directory),
		})) as TerminalInfo;
	const command = (await (await SessionStore.at(dataDir)).project(key.projectId)).commands?.find(
		(item) => item.id === ref.commandId
	);
	if (!command) throw new Error('The command is no longer saved');
	return (await terminal(key, { kind: 'run', run: commandRunSpec(command) })) as TerminalInfo;
}
