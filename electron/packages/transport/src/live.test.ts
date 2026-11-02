import { expect, it } from 'vitest';
import { mkdtemp, mkdir, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { AgentTransport } from './transport';
import type { AgentEvent, AgentProvider } from '@brigadir/core';

for (const provider of ['claude', 'codex'] as AgentProvider[]) {
	it.skipIf(process.env.BRIGADIR_LIVE_TRANSPORT !== provider)(
		`live ${provider} read-only conversation (not G1/G2)`,
		async () => {
			const directory = await mkdtemp(join(tmpdir(), `brigadir-live-${provider}-`));
			const events: AgentEvent[] = [];
			const startedAt = new Date().toISOString();
			let transport: AgentTransport | undefined;
			const result: {
				provider: AgentProvider;
				startedAt: string;
				sdk: string;
				purpose: string;
				adapter: unknown;
				status: string;
				command: string;
				expected: string;
				actual?: string;
				exitCode: number;
				eventKinds?: string[];
				error?: string;
			} = {
				provider,
				startedAt,
				sdk: '1.4.0',
				purpose: 'Read-only ACP conversation; does not prove G1 or G2',
				adapter: null,
				status: 'failed',
				command: `BRIGADIR_LIVE_TRANSPORT=${provider} pnpm exec vitest run packages/transport/src/live.test.ts`,
				expected: 'READY, end_turn, empty fixture directory',
				exitCode: 1,
			};
			try {
				transport = await AgentTransport.start({
					provider,
					cwd: directory,
					startupTimeoutMs: 90000,
					onEvent: (event) => {
						events.push(event);
					},
				});
				result.adapter = transport.info;
				await Promise.race([
					transport.send({
						kind: 'prompt',
						text: 'Reply with the single word READY. Do not call tools or change any files.',
					}),
					new Promise<never>((_, reject) => {
						const timer = setTimeout(() => reject(new Error('Live prompt timed out')), 90000);
						timer.unref();
					}),
				]);
				const reply = events
					.flatMap((event) =>
						event.kind === 'message.delta' &&
						event.role === 'assistant' &&
						event.content.kind === 'text'
							? [event.content.text]
							: []
					)
					.join('');
				result.actual = reply.slice(0, 1000);
				expect(reply).toContain('READY');
				expect(events.at(-1)).toEqual({ kind: 'turn.completed', reason: 'end_turn' });
				expect(events.some((event) => event.kind === 'permission.requested')).toBe(false);
				expect(await readdir(directory)).toEqual([]);
				result.status = 'passed';
				result.exitCode = 0;
			} catch (error) {
				result.error =
					error instanceof Error
						? error.message.replace(/\/Users\/[^/\s]+/g, '/fixture/home')
						: String(error);
				throw error;
			} finally {
				result.eventKinds = events.map((event) => event.kind);
				transport?.close();
				if (transport) await transport.closed;
				await rm(directory, { recursive: true, force: true });
				const results = resolve('test-results/live');
				await mkdir(results, { recursive: true });
				await writeFile(
					join(results, `transport-${provider}.json`),
					JSON.stringify(result, null, 2) + '\n'
				);
			}
		},
		190000
	);
}
