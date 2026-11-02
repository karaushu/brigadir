import { expect, it } from 'vitest';
import { mkdtemp, mkdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { SessionStore } from '@brigadir/persistence';
import type { AgentOption, AgentTask } from '@brigadir/core';
import { cliChoiceArgs, cliLaunch, relayCommand } from './cli-launch';
const select = (id: string, category: string, values: string[]): AgentOption => ({
	id,
	name: id,
	description: null,
	category,
	kind: 'select',
	value: values[0]!,
	choices: values.map((value) => ({ value, name: value, description: null, group: null })),
});
const codexOptions = [
	select('model', 'model', ['gpt-6.1-sol', 'gpt-6-astra']),
	select('reasoning_effort', 'thought_level', ['medium', 'high']),
	select('mode', 'mode', ['read-only', 'agent']),
];
const claudeOptions = [
	select('model', 'model', ['default', 'opus[1m]']),
	select('effort', 'thought_level', ['default', 'high']),
	select('fast', 'model_config', ['off', 'on']),
];
const base = {
	id: 't',
	projectId: 'p',
	title: 't',
	status: 'queued',
	transport: 'terminal',
	prompt: 'Hello',
} as AgentTask;
it("turns the sheet model and effort into each CLI's own flags on the first start (spec/terminal-and-cli-agents#cli-args)", () => {
	const codex = {
		...base,
		provider: 'codex',
		agentOptions: codexOptions,
		launchOptions: [
			{ id: 'model', value: 'gpt-6-astra' },
			{ id: 'reasoning_effort', value: 'high' },
			{ id: 'mode', value: 'agent' },
		],
	} as AgentTask;
	expect(cliChoiceArgs(codex, undefined)).toEqual([
		'-m',
		'gpt-6-astra',
		'-c',
		'model_reasoning_effort="high"',
	]);
	const claude = {
		...base,
		provider: 'claude',
		agentOptions: claudeOptions,
		launchOptions: [
			{ id: 'model', value: 'opus[1m]' },
			{ id: 'effort', value: 'high' },
			{ id: 'fast', value: 'on' },
		],
	} as AgentTask;
	expect(cliChoiceArgs(claude, undefined)).toEqual(['--model', 'opus[1m]', '--effort', 'high']);
	// `default` is the CLI's own setting; a resume keeps the session's model; no catalog — no guess.
	expect(
		cliChoiceArgs(
			{
				...claude,
				launchOptions: [
					{ id: 'model', value: 'default' },
					{ id: 'effort', value: 'default' },
				],
			},
			undefined
		)
	).toEqual([]);
	expect(cliChoiceArgs(codex, 'session-1')).toEqual([]);
	expect(cliChoiceArgs({ ...codex, agentOptions: [] }, undefined)).toEqual([]);
});
it('puts the flags before the prompt and records them in cli-launch.json', async () => {
	const root = await mkdtemp(join(tmpdir(), 'brigadir-cli-launch-'));
	try {
		const repo = join(root, 'repo');
		await mkdir(repo);
		const store = await SessionStore.at(join(root, 'data'));
		const project = await store.addProject(repo);
		const created = await store.createTask(project.id, 'Hello', 'codex', 'terminal');
		const task = await store.updateTask(created, {
			agentOptions: codexOptions,
			launchOptions: [{ id: 'model', value: 'gpt-6-astra' }],
		});
		const identity = { socket: 's', instance: 'i', hookToken: 'h', mcpToken: 'm' } as Parameters<
			typeof cliLaunch
		>[2];
		const launch = await cliLaunch(
			store,
			task,
			identity,
			join(root, 'mcp-relay'),
			process.execPath,
			undefined
		);
		expect(launch.args.slice(-4)).toEqual(['-m', 'gpt-6-astra', '--', 'Hello']);
		const resumed = await cliLaunch(
			store,
			task,
			identity,
			join(root, 'mcp-relay'),
			process.execPath,
			'session-1'
		);
		expect(resumed.args.slice(-3)).toEqual(['resume', '--', 'session-1']);
	} finally {
		await rm(root, { recursive: true, force: true });
	}
});
it('runs CLI hooks and the statusline through zsh on macOS and through cli-relay elsewhere (spec/architecture-and-platform#linux-package)', () => {
	const entry = "/opt/Brig'adir/resources/services/mcp-relay";
	expect(relayCommand(entry, 'hook', 'darwin')).toBe(
		`'/bin/zsh' '-f' '/opt/Brig'\\''adir/resources/services/hook.zsh'`
	);
	expect(relayCommand(entry, 'statusline', 'linux')).toBe(
		`'/opt/Brig'\\''adir/resources/services/cli-relay' 'statusline'`
	);
	expect(relayCommand(entry, 'hook', 'linux')).toBe(
		`'/opt/Brig'\\''adir/resources/services/cli-relay' 'hook'`
	);
});
