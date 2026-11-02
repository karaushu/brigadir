import { describe, expect, it } from 'vitest';
import {
	commandDirectory,
	commandFolder,
	isProjectCommands,
	isTerminalCommand,
	onceRunSpec,
	outputPort,
	runState,
	type ProjectCommand,
} from './index';
const admin: ProjectCommand = {
	id: 'admin',
	name: 'Admin dev',
	command: 'pnpm --filter admin dev',
	repo: 'apps/admin',
	directory: '',
};
describe('project commands (spec/search-menus-and-commands#project-commands)', () => {
	it('validates the saved list', () => {
		expect(
			isProjectCommands([
				admin,
				{ ...admin, id: 'seed', name: 'Seed DB', command: 'npx tsx scripts/seed.mjs', repo: '' },
			])
		).toBe(true);
		expect(isProjectCommands([admin, admin])).toBe(false);
		// spec/search-menus-and-commands#agent-command-tools: the agents' mark is optional and only a boolean.
		expect(isProjectCommands([{ ...admin, agentRuns: true }])).toBe(true);
		expect(isProjectCommands([{ ...admin, agentRuns: 'yes' }])).toBe(false);
		for (const bad of [
			{ repo: '../x' },
			{ repo: '/abs' },
			{ directory: 'a/../b' },
			{ directory: '.git/hooks' },
			{ name: '' },
			{ name: 'a\nb' },
			{ command: '  ' },
			{ id: '../x' },
		])
			expect(isProjectCommands([{ ...admin, ...bad }])).toBe(false);
	});
	it('joins the repo and the folder, normalizing what a person types', () => {
		expect(commandDirectory(admin)).toBe('apps/admin');
		expect(commandDirectory({ repo: '', directory: 'scripts' })).toBe('scripts');
		expect(commandDirectory({ repo: '', directory: '' })).toBe('');
		expect(commandFolder(' ./apps//admin/ ')).toBe('apps/admin');
		expect(commandFolder('.')).toBe('');
	});
	it('names a «Run once» tab by its line', () => {
		expect(onceRunSpec('pnpm   test --filter kit')).toEqual({
			commandId: null,
			name: 'pnpm test --filter kit',
			line: 'pnpm   test --filter kit',
			directory: '',
		});
		expect(onceRunSpec('x'.repeat(60)).name).toHaveLength(40);
	});
	it('finds a local address through ANSI colors and ignores other hosts', () => {
		expect(
			outputPort(
				'  \x1b[32m➜\x1b[39m  Local:   \x1b[36mhttp://localhost:\x1b[1m5173\x1b[22m/\x1b[39m'
			)
		).toBe(5173);
		expect(outputPort('Listening on http://127.0.0.1:3000')).toBe(3000);
		expect(outputPort('see https://example.com:8080 and http://192.168.1.4:6006')).toBeNull();
		expect(outputPort('http://localhost:99999')).toBeNull();
	});
	it('derives the state of a command tab', () => {
		const run = {
			commandId: 'admin',
			name: 'Admin dev',
			line: 'pnpm dev',
			port: null,
			stopped: false,
		};
		expect(runState({ exited: false, exitCode: null })).toBeNull();
		expect(runState({ exited: false, exitCode: null, run })).toBe('starting');
		expect(runState({ exited: false, exitCode: null, run: { ...run, port: 5173 } })).toBe(
			'running'
		);
		expect(runState({ exited: true, exitCode: 0, run })).toBe('done');
		expect(runState({ exited: true, exitCode: 2, run })).toBe('failed');
		expect(runState({ exited: true, exitCode: 130, run })).toBe('stopped');
		expect(runState({ exited: true, exitCode: 143, run: { ...run, stopped: true } })).toBe(
			'stopped'
		);
	});
	it('accepts run and stop terminal commands only with a safe folder', () => {
		expect(
			isTerminalCommand({
				kind: 'run',
				run: { commandId: 'admin', name: 'Admin dev', line: 'pnpm dev', directory: 'apps/admin' },
			})
		).toBe(true);
		expect(
			isTerminalCommand({
				kind: 'run',
				run: { commandId: null, name: 'x', line: 'x', directory: '../up' },
			})
		).toBe(false);
		expect(isTerminalCommand({ kind: 'stop', id: 'abc' })).toBe(true);
		expect(isTerminalCommand({ kind: 'stop' })).toBe(false);
	});
});
