import { expect, it } from 'vitest';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import type { AgentEvent } from '@brigadir/core';
import {
	authAccess,
	claudeRateLimitReadings,
	claudeUsageReadings,
	codexRateLimitReadings,
	planLabel,
} from './quota';
import { AgentTransport } from './transport';
import { readClaudeUsage } from './usage';
import { CodexAccount } from './codex-account';
const agent = resolve('packages/transport/fixtures/agent.mjs'),
	codex = resolve('packages/transport/fixtures/codex-app-server.mjs'),
	usageCli = resolve('packages/transport/fixtures/claude-usage.mjs');
it('reads every Claude window from unifiedWindows and the limiting one from the top level', () => {
	// A live event (spec/agents-and-providers#quota-sources).
	expect(
		claudeRateLimitReadings({
			status: 'allowed',
			resetsAt: 1790252400,
			rateLimitType: 'five_hour',
			overageStatus: 'rejected',
			overageDisabledReason: 'out_of_credits',
			isUsingOverage: false,
			unifiedWindows: {
				five_hour: { utilization: 0.02, resetsAt: 1790252400 },
				seven_day: { utilization: 0.26, resetsAt: 1790690400 },
			},
		})
	).toEqual([
		{
			id: 'five_hour',
			kind: 'five-hour',
			model: null,
			minutes: 300,
			remaining: 0.98,
			resetsAt: 1790252400,
			exhausted: false,
		},
		{
			id: 'seven_day',
			kind: 'weekly',
			model: null,
			minutes: 10080,
			remaining: 0.74,
			resetsAt: 1790690400,
			exhausted: false,
		},
	]);
	expect(
		claudeRateLimitReadings({
			status: 'rejected',
			rateLimitType: 'seven_day_opus',
			utilization: 1,
			resetsAt: 10,
		})
	).toEqual([
		{
			id: 'model:Opus',
			kind: 'weekly-model',
			model: 'Opus',
			minutes: 10080,
			remaining: 0,
			resetsAt: 10,
			exhausted: true,
		},
	]);
	expect(
		claudeRateLimitReadings({ status: 'allowed', rateLimitType: 'five_hour', resetsAt: 10 })
	).toEqual([]);
});
it('maps the /usage report, Codex snapshots and plan names without the email', () => {
	expect(
		claudeUsageReadings({
			rate_limits: {
				limits: [
					{ kind: 'session', percent: 13, resets_at: '2026-09-24T12:19:59Z' },
					{
						kind: 'weekly_scoped',
						percent: 100,
						resets_at: null,
						scope: { model: { display_name: 'Fable' } },
					},
					{ kind: 'weekly_scoped', percent: 5, scope: { surface: 'x' } },
				],
			},
		})
	).toEqual([
		{
			id: 'five_hour',
			kind: 'five-hour',
			model: null,
			minutes: 300,
			remaining: 0.87,
			resetsAt: Date.UTC(2026, 8, 24, 12, 19, 59) / 1000,
			exhausted: false,
		},
		{
			id: 'model:Fable',
			kind: 'weekly-model',
			model: 'Fable',
			minutes: 10080,
			remaining: 0,
			resetsAt: null,
			exhausted: true,
		},
	]);
	expect(claudeUsageReadings(null)).toBeNull();
	expect(
		codexRateLimitReadings({
			primary: { usedPercent: 45, windowDurationMins: 10080, resetsAt: 1790580258 },
			secondary: null,
		})
	).toEqual([
		{
			id: 'codex:10080',
			kind: 'weekly',
			model: null,
			minutes: 10080,
			remaining: 0.55,
			resetsAt: 1790580258,
			exhausted: false,
		},
	]);
	expect(planLabel('self_serve_business_prolite')).toBe('Business');
	expect(planLabel('team')).toBe('Team');
	expect(planLabel('Claude Max')).toBe('Max');
	const access = authAccess({
		authStatus: {
			kind: 'account',
			label: 'Claude Team',
			account: { plan: 'team', email: 'someone@example.com' },
		},
	});
	expect(access).toEqual({ access: 'subscription', plan: 'Team' });
	expect(JSON.stringify(access)).not.toContain('example.com');
	expect(authAccess({ authStatus: { kind: 'api_key', label: 'Anthropic API key' } })).toEqual({
		access: 'api-key',
		plan: null,
	});
});
it('asks Claude for raw rate-limit events and emits one reading for a payload delivered twice', async () => {
	const cwd = await mkdtemp(join(tmpdir(), 'brigadir-quota-')),
		log = join(cwd, 'wire.jsonl'),
		events: AgentEvent[] = [];
	const transport = await AgentTransport.start({
		provider: 'claude',
		cwd,
		startupTimeoutMs: 3000,
		adapter: { command: process.execPath, args: [agent, 'normal', log] },
		onEvent: (event) => {
			events.push(event);
		},
	});
	try {
		await transport.send({ kind: 'prompt', text: 'quota' });
		const wire = (await readFile(log, 'utf8'))
			.trim()
			.split('\n')
			.map((line) => JSON.parse(line) as { event: string; params: { _meta?: unknown } });
		expect(wire.find((entry) => entry.event === 'new')?.params._meta).toEqual({
			claudeCode: {
				emitRawSDKMessages: [
					{ type: 'rate_limit_event' },
					{ type: 'system', subtype: 'session_state_changed' },
					{ type: 'system', subtype: 'task_started' },
					{ type: 'system', subtype: 'task_updated' },
					{ type: 'system', subtype: 'task_notification' },
				],
			},
		});
		expect(events.filter((event) => event.kind === 'rate-limit.changed')).toHaveLength(1);
		const quota = events.filter((event) => event.kind === 'quota.observed');
		expect(quota).toEqual([
			{
				kind: 'quota.observed',
				provider: 'claude',
				complete: false,
				windows: [
					expect.objectContaining({ id: 'five_hour', remaining: 0.38 }),
					expect.objectContaining({ id: 'seven_day', remaining: 0.74 }),
				],
			},
		]);
	} finally {
		transport.close();
		await transport.closed;
		await rm(cwd, { recursive: true, force: true });
	}
});
it('reads /usage through the unmodified CLI, without ACP, and keeps the per-model window', async () => {
	const cwd = await mkdtemp(join(tmpdir(), 'brigadir-usage-'));
	const cli = (scenario: string) => ({ command: process.execPath, args: [usageCli, scenario] });
	try {
		const usage = await readClaudeUsage({ cwd, timeoutMs: 5000, command: cli('normal') });
		expect(usage).toMatchObject({ access: 'subscription', plan: 'Team' });
		expect(JSON.stringify(usage)).not.toContain('someone@example.com');
		expect(usage?.windows.map((window) => [window.id, window.remaining])).toEqual([
			['five_hour', 0.87],
			['seven_day', 0.72],
			['model:Fable', 1],
		]);
		expect(await readClaudeUsage({ cwd, timeoutMs: 5000, command: cli('usage-null') })).toBeNull();
		expect(await readClaudeUsage({ cwd, timeoutMs: 5000, command: cli('api-key') })).toEqual({
			windows: [],
			access: 'api-key',
			plan: null,
		});
		expect(await readClaudeUsage({ cwd, command: null })).toBeNull();
		await expect(readClaudeUsage({ cwd, timeoutMs: 300, command: cli('hang') })).rejects.toThrow();
	} finally {
		await rm(cwd, { recursive: true, force: true });
	}
});
it('reads Codex limits from app-server by window length and reports an API key login', async () => {
	const account = await CodexAccount.start({
		command: { command: process.execPath, args: [codex] },
		env: { ...process.env, BRIGADIR_CODEX_FIXTURE: 'two' },
	});
	try {
		expect(await account.readLimits()).toEqual({
			plan: 'Business',
			access: 'subscription',
			windows: [
				{
					id: 'codex:10080',
					kind: 'weekly',
					model: null,
					minutes: 10080,
					remaining: 0.55,
					resetsAt: 1790580258,
					exhausted: false,
				},
				{
					id: 'codex:300',
					kind: 'five-hour',
					model: null,
					minutes: 300,
					remaining: expect.closeTo(0.09, 5),
					resetsAt: 1790260000,
					exhausted: false,
				},
			],
		});
	} finally {
		account.close();
	}
	const key = await CodexAccount.start({
		command: { command: process.execPath, args: [codex] },
		env: { ...process.env, BRIGADIR_CODEX_FIXTURE: 'api-key' },
	});
	try {
		expect(await key.readLimits()).toEqual({ windows: [], plan: null, access: 'api-key' });
	} finally {
		key.close();
	}
});
