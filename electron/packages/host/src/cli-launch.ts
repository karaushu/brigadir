import { dirname, join } from 'node:path';
import { readFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { atomicJson, safePath, type SessionStore } from '@brigadir/persistence';
import { agentOptionKind, type AgentTask } from '@brigadir/core';
import type { HostIdentity } from './runtime';
export type CliLaunch = { command: string; args: string[]; env: Record<string, string> };
const quote = (value: string) => `'${value.replace(/'/g, "'\\''")}'`;
/** spec/agents-and-providers#quota-sources: the person's own statusline, in Claude Code's order (local, then project, then user settings; managed
 *  settings outrank our `--settings` anyway). Only the `statusLine` key is read, nothing else from those files. */
export async function userStatusLine(
	cwd: string,
	home = process.env.CLAUDE_CONFIG_DIR ?? join(homedir(), '.claude')
): Promise<{ command: string; padding?: number } | null> {
	for (const file of [
		join(cwd, '.claude', 'settings.local.json'),
		join(cwd, '.claude', 'settings.json'),
		join(home, 'settings.json'),
	]) {
		let line: unknown;
		try {
			const value = JSON.parse(await readFile(file, 'utf8')) as { statusLine?: unknown };
			if (!value || typeof value !== 'object' || !('statusLine' in value)) continue;
			line = value.statusLine;
		} catch {
			continue;
		}
		if (!line || typeof line !== 'object') return null;
		const entry = line as { type?: unknown; command?: unknown; padding?: unknown };
		if (
			entry.type !== 'command' ||
			typeof entry.command !== 'string' ||
			!entry.command.trim() ||
			entry.command.length > 8192
		)
			return null;
		return {
			command: entry.command,
			...(typeof entry.padding === 'number' && Number.isFinite(entry.padding)
				? { padding: entry.padding }
				: {}),
		};
	}
	return null;
}
/** spec/terminal-and-cli-agents#cli-args: the sheet's model and effort as the CLI's own flags on the first start. The values are the ACP catalog's, which
 *  both CLIs take as they are; Claude's `default` means the CLI's own setting and gives no flag. A resume keeps its model. */
export function cliChoiceArgs(task: AgentTask, resume: string | undefined): string[] {
	if (resume) return [];
	const chosen = (kind: 'model' | 'effort') => {
		for (const choice of task.launchOptions ?? []) {
			const option = task.agentOptions?.find((item) => item.id === choice.id);
			if (
				option &&
				agentOptionKind(option) === kind &&
				typeof choice.value === 'string' &&
				choice.value &&
				choice.value !== 'default'
			)
				return choice.value;
		}
		return undefined;
	};
	const model = chosen('model'),
		effort = chosen('effort');
	if (task.provider === 'codex')
		return [
			...(model ? ['-m', model] : []),
			...(effort ? ['-c', `model_reasoning_effort=${JSON.stringify(effort)}`] : []),
		];
	return [...(model ? ['--model', model] : []), ...(effort ? ['--effort', effort] : [])];
}
/**
 * The command a CLI runs for each hook and for its statusline. macOS: `zsh -f` with the shipped script (≈5 ms, TUI-06).
 * Elsewhere zsh is not a given (Fedora and Ubuntu do not install it), so the C relay next to `mcp-relay` speaks the same
 * contract (spec/architecture-and-platform#linux-package).
 */
export function relayCommand(
	mcpEntry: string,
	mode: 'hook' | 'statusline',
	platform: NodeJS.Platform = process.platform
): string {
	const services = dirname(mcpEntry);
	return (
		platform === 'darwin'
			? ['/bin/zsh', '-f', join(services, `${mode}.zsh`)]
			: [join(services, 'cli-relay'), mode]
	)
		.map(quote)
		.join(' ');
}
export async function cliLaunch(
	store: SessionStore,
	task: AgentTask,
	identity: HostIdentity,
	mcpEntry: string,
	runtime: string,
	resume: string | undefined,
	crewRole?: string,
	cwd?: string,
	platform: NodeJS.Platform = process.platform
): Promise<CliLaunch> {
	const dir = await store.taskDir(task);
	const hookCommand = relayCommand(mcpEntry, 'hook', platform);
	const env = {
		BRIGADIR_HOST_SOCKET: identity.socket,
		BRIGADIR_HOST_INSTANCE: identity.instance,
		BRIGADIR_PROJECT_ID: task.projectId,
		BRIGADIR_TASK_ID: task.id,
		BRIGADIR_HOOK_TOKEN: identity.hookToken!,
		BRIGADIR_MCP_TOKEN: identity.mcpToken,
		...(crewRole ? { BRIGADIR_ROLE: crewRole } : {}),
	};
	const events = [
		'SessionStart',
		'UserPromptSubmit',
		'PreToolUse',
		'PostToolUse',
		'Stop',
		'SessionEnd',
		...(task.provider === 'codex' ? ['Interrupt'] : ['PostToolUseFailure']),
	];
	const hooks = Object.fromEntries(
		events.map((event) => [
			event,
			[
				{
					hooks: [
						{
							type: 'command',
							command: hookCommand,
							timeout: event === 'SessionEnd' || event === 'Interrupt' ? 3 : 10,
						},
					],
				},
			],
		])
	);
	let args: string[],
		launchEnv: Record<string, string> = env;
	if (task.provider === 'claude') {
		// spec/agents-and-providers#quota-sources: the relay prints the person's statusline unchanged and passes `rate_limits` to the host. Without one of
		// their own nothing is added: any custom status line hides the TUI's key hints and an empty one leaves a blank row.
		const user = cwd ? await userStatusLine(cwd) : null;
		if (user) launchEnv = { ...env, BRIGADIR_USER_STATUSLINE: user.command };
		const statusLine = user
			? {
					statusLine: {
						type: 'command',
						command: relayCommand(mcpEntry, 'statusline', platform),
						...(user.padding !== undefined ? { padding: user.padding } : {}),
					},
				}
			: {};
		const settings = await safePath(dir, 'cli-settings.json');
		await atomicJson(settings, { hooks, ...statusLine });
		const mcp = await safePath(dir, 'cli-mcp.json');
		await atomicJson(mcp, {
			mcpServers: { brigadir: { command: mcpEntry, args: [], env, timeout: 604800 * 1000 } },
		});
		args = [
			'--settings',
			settings,
			'--mcp-config',
			mcp,
			...cliChoiceArgs(task, resume),
			...(resume ? ['--resume', resume] : []),
			...(resume || !task.prompt ? [] : ['--', task.prompt]),
		];
	} else {
		const handler = `{type="command",command=${JSON.stringify(hookCommand)},timeout=3}`;
		args = events.flatMap((event) => ['-c', `hooks.${event}=[{hooks=[${handler}]}]`]);
		args.push(
			'-c',
			`mcp_servers.brigadir={command=${JSON.stringify(mcpEntry)},args=[],env_vars=[${Object.keys(
				env
			)
				.filter((name) => name !== 'BRIGADIR_HOOK_TOKEN')
				.map((name) => JSON.stringify(name))
				.join(',')}],tool_timeout_sec=604800}`
		);
		args.push(...cliChoiceArgs(task, resume));
		if (resume) args.push('resume', '--', resume);
		else if (task.prompt) args.push('--', task.prompt);
	}
	await atomicJson(await safePath(dir, 'cli-launch.json'), {
		schemaVersion: 1,
		provider: task.provider,
		resume: resume ?? null,
		args,
		at: new Date().toISOString(),
	});
	return { command: task.provider!, args, env: launchEnv };
}
