import { it, expect } from 'vitest';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { cliUpdateLabel, type CliUpdateStatus } from '@brigadir/core';
import { CliUpdates, type CliRun } from './cli-updates';
type Cli = { version: string; next?: string; fail?: boolean };
function world(
	root: string,
	clis: Partial<Record<'claude' | 'codex', Cli>>,
	options: { background?: boolean; providers?: ('claude' | 'codex')[] } = {}
) {
	const calls: string[] = [],
		changes: CliUpdateStatus[] = [];
	let clock = Date.parse('2026-10-05T16:00:00Z'),
		adapters = 0;
	let gate: Promise<void> = Promise.resolve();
	const run: CliRun = async (provider, args) => {
		const cli = clis[provider];
		if (!cli) return null;
		calls.push(`${provider} ${args.join(' ')}`);
		if (args[0] === '--version')
			return { code: 0, stdout: `${cli.version} (${provider})\n`, stderr: '' };
		await gate;
		if (cli.fail) return { code: 1, stdout: '', stderr: 'network' };
		if (cli.next) cli.version = cli.next;
		return { code: 0, stdout: '', stderr: '' };
	};
	const settings = {
		providers: options.providers ?? ['claude', 'codex'],
		background: options.background ?? true,
	};
	const updates = new CliUpdates(
		root,
		{
			run,
			settings: () => settings,
			refreshAdapters: async () => {
				adapters++;
			},
			changed: (status) => {
				changes.push(status);
			},
			log: () => {},
		},
		() => clock
	);
	return {
		updates,
		calls,
		changes,
		settings,
		tick: (ms: number) => {
			clock += ms;
		},
		adapters: () => adapters,
		hold: (value: Promise<void>) => {
			gate = value;
		},
	};
}
it('updates each CLI with its own command, compares versions and keeps a failure with its CLI', async () => {
	const root = await mkdtemp(join(tmpdir(), 'brigadir-cli-updates-'));
	try {
		const w = world(root, {
			claude: { version: '2.1.285', fail: true },
			codex: { version: '0.156.1', next: '0.160.0' },
		});
		const status = await w.updates.checkNow();
		expect(w.calls).toEqual([
			'claude --version',
			'claude update',
			'codex --version',
			'codex update',
			'codex --version',
		]);
		expect(status.results).toEqual([
			{ provider: 'claude', before: '2.1.285', after: '2.1.285', outcome: 'failed' },
			{ provider: 'codex', before: '0.156.1', after: '0.160.0', outcome: 'updated' },
		]);
		expect(w.changes.map((change) => change.running)).toEqual([true, false]);
		expect(w.adapters()).toBe(1);
		expect(JSON.parse(await readFile(join(root, 'cli-updates.json'), 'utf8'))).toEqual({
			schemaVersion: 1,
			status: { checkedAt: '2026-10-05T16:00:00.000Z', running: false, results: status.results },
		});
		expect(cliUpdateLabel('uk', status, new Date('2026-10-05T17:00:00Z'))).toEqual({
			text: expect.stringMatching(/^Не вдалося оновити Claude Code · сьогодні о \d\d:00$/),
			warning: true,
		});
	} finally {
		await rm(root, { recursive: true, force: true });
	}
});
it('runs in the background only with the switch on and once a day; «Check now» ignores both and is joined while it runs', async () => {
	const root = await mkdtemp(join(tmpdir(), 'brigadir-cli-updates-gate-'));
	try {
		const w = world(root, { codex: { version: '0.160.0' } }, { background: false });
		expect(await w.updates.maybeRun()).toBeNull();
		expect(w.calls).toEqual([]);
		w.settings.background = true;
		expect((await w.updates.maybeRun())!.results).toEqual([
			{ provider: 'codex', before: '0.160.0', after: '0.160.0', outcome: 'current' },
		]);
		expect(w.adapters()).toBe(0);
		w.calls.length = 0;
		w.tick(23 * 60 * 60_000);
		expect(await w.updates.maybeRun()).toBeNull();
		expect(w.calls).toEqual([]);
		let release = () => {};
		w.hold(
			new Promise<void>((resolve) => {
				release = resolve;
			})
		);
		w.settings.background = false;
		const first = w.updates.checkNow(),
			second = w.updates.checkNow();
		expect(second).toBe(first);
		await new Promise((resolve) => setTimeout(resolve, 10));
		expect((await w.updates.status()).running).toBe(true);
		release();
		await first;
		expect(w.calls.filter((call) => call === 'codex update')).toHaveLength(1);
		w.settings.background = true;
		w.tick(25 * 60 * 60_000);
		await w.updates.maybeRun();
		expect(w.calls.filter((call) => call === 'codex update')).toHaveLength(2);
		// The status survives a restart; a CLI that is not installed is skipped without a result.
		const again = world(root, {}, { providers: ['claude'] });
		expect((await again.updates.status()).checkedAt).not.toBeNull();
		expect((await again.updates.checkNow()).results).toEqual([]);
	} finally {
		await rm(root, { recursive: true, force: true });
	}
});
it('labels every state in both languages', () => {
	const now = new Date('2026-10-05T16:30:00'),
		at = '2026-10-05T16:20:00',
		base: CliUpdateStatus = { checkedAt: at, running: false, results: [] };
	expect(cliUpdateLabel('uk', { checkedAt: null, running: false, results: [] }).text).toBe(
		'Ще не перевірено'
	);
	expect(cliUpdateLabel('en', { ...base, running: true }).text).toBe('Checking…');
	expect(cliUpdateLabel('uk', base, now).text).toBe(
		'Перевірено сьогодні о 16:20 · нових версій немає'
	);
	expect(cliUpdateLabel('en', base, now).text).toBe('Checked today at 16:20 · no new versions');
	const both: CliUpdateStatus = {
		...base,
		results: [
			{ provider: 'claude', before: '2.1.285', after: '2.1.290', outcome: 'updated' },
			{ provider: 'codex', before: '0.156.1', after: '0.160.0', outcome: 'updated' },
		],
	};
	expect(cliUpdateLabel('uk', both, now)).toEqual({
		text: 'Claude Code оновлено до 2.1.290, Codex — до 0.160.0 · сьогодні о 16:20',
		warning: false,
	});
	expect(cliUpdateLabel('uk', base, new Date('2026-10-06T09:00:00')).text).toBe(
		'Перевірено вчора о 16:20 · нових версій немає'
	);
	expect(cliUpdateLabel('uk', base, new Date('2026-10-09T09:00:00')).text).toBe(
		'Перевірено 05.10.2026 о 16:20 · нових версій немає'
	);
});
