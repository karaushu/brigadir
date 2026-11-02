import { spawn } from 'node:child_process';
import type { QuotaAccess, QuotaReading } from '@brigadir/core';
import { claudeCommand, type AdapterCommand } from './adapter';
import { claudeUsageReadings, planLabel } from './quota';
export type ClaudeUsage = { windows: QuotaReading[]; access: QuotaAccess; plan: string | null };
/** spec/agents-and-providers#quota-sources (spec/agents-and-providers#provider-terms): weekly per-model limits exist only in `/api/oauth/usage`, and
 *  Brigadir never calls it. The unmodified `claude -p /usage` is a local command: no model turn, the CLI makes the
 *  request with its own login, and the stream-json `assistant` message carries the structured `usage_report`.
 *  No ACP adapter and no transcript. Null means no answer (no CLI, or the endpoint is rate limited); the caller
 *  keeps what it had. */
export async function readClaudeUsage(input: {
	cwd: string;
	command?: AdapterCommand | null;
	signal?: AbortSignal;
	timeoutMs?: number;
}): Promise<ClaudeUsage | null> {
	const command = input.command === undefined ? claudeCommand() : input.command;
	if (!command) return null;
	const controller = new AbortController(),
		signal = input.signal ? AbortSignal.any([input.signal, controller.signal]) : controller.signal;
	const timer = setTimeout(
		() => controller.abort(new Error('Usage read timed out')),
		input.timeoutMs ?? 30_000
	);
	try {
		const [stream, status] = await Promise.all([
			output(
				command,
				['-p', '/usage', '--output-format', 'stream-json', '--verbose', '--no-session-persistence'],
				input.cwd,
				signal
			),
			// The plan name only; the email of the answer is dropped here.
			output(command, ['auth', 'status', '--json'], input.cwd, signal).catch(() => ''),
		]);
		let report: unknown,
			seen = false,
			keySource: unknown;
		for (const line of stream.split('\n')) {
			const message = json(line);
			if (!message) continue;
			if (message.type === 'system' && message.subtype === 'init') keySource = message.apiKeySource;
			if (message.type === 'assistant' && 'usage_report' in message) {
				seen = true;
				report = message.usage_report;
			}
		}
		if (typeof keySource === 'string' && keySource !== 'none')
			return { windows: [], access: 'api-key', plan: null };
		const windows = seen ? claudeUsageReadings(report) : null;
		if (!windows) return null;
		const account = json(status),
			plan =
				account && typeof account.subscriptionType === 'string' ? account.subscriptionType : '';
		return { windows, access: 'subscription', plan: plan.trim() ? planLabel(plan) : null };
	} finally {
		clearTimeout(timer);
	}
}
function output(command: AdapterCommand, args: string[], cwd: string, signal: AbortSignal) {
	return new Promise<string>((resolve, reject) => {
		const child = spawn(command.command, [...command.args, ...args], {
			cwd,
			signal,
			stdio: ['ignore', 'pipe', 'ignore'],
		});
		let text = '';
		child.stdout.setEncoding('utf8');
		child.stdout.on('data', (chunk: string) => (text += chunk));
		child.on('error', reject);
		child.on('close', (code) =>
			code === 0 ? resolve(text) : reject(new Error(`claude ${args[0]} exited with ${code}`))
		);
	});
}
function json(line: string): Record<string, unknown> | null {
	try {
		const value: unknown = JSON.parse(line);
		return value && typeof value === 'object' && !Array.isArray(value)
			? (value as Record<string, unknown>)
			: null;
	} catch {
		return null;
	}
}
