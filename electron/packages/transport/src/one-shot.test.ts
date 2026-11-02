import { expect, it } from 'vitest';
import { mkdtemp, rm, readdir, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { oneShotText } from './one-shot';
it('generates only text without filesystem, terminals, MCP servers or task artifacts', async () => {
	const cwd = await mkdtemp(join(tmpdir(), 'brigadir-one-shot-')),
		log = join(cwd, 'wire.jsonl');
	try {
		expect(
			await oneShotText({
				cwd,
				prompt: 'Summarize the supplied text.',
				adapter: {
					command: process.execPath,
					args: [resolve('packages/transport/fixtures/agent.mjs'), 'normal', log],
				},
			})
		).toBe('hello world');
		const wire = (await readFile(log, 'utf8'))
			.trim()
			.split('\n')
			.map((line) => JSON.parse(line));
		expect(
			wire.find((entry) => entry.event === 'initialize').params.clientCapabilities
		).toMatchObject({ fs: { readTextFile: false, writeTextFile: false }, terminal: false });
		expect(wire.find((entry) => entry.event === 'new').params.mcpServers).toEqual([]);
		expect(await readdir(cwd)).toEqual(['wire.jsonl']);
	} finally {
		await rm(cwd, { recursive: true, force: true });
	}
});
it('refuses tools and incomplete/oversized output; cancels and times out without an automatic retry', async () => {
	const cwd = await mkdtemp(join(tmpdir(), 'brigadir-one-shot-fail-')),
		adapter = {
			command: process.execPath,
			args: [resolve('packages/transport/fixtures/agent.mjs')],
		};
	try {
		await expect(oneShotText({ cwd, adapter, prompt: 'permission' })).rejects.toThrow(
			'cannot use tools'
		);
		await expect(oneShotText({ cwd, adapter, prompt: 'hello', characterLimit: 3 })).rejects.toThrow(
			'exceeds'
		);
		await expect(oneShotText({ cwd, adapter, prompt: 'hold', timeoutMs: 500 })).rejects.toThrow(
			'timed out'
		);
		const controller = new AbortController(),
			pending = oneShotText({ cwd, adapter, prompt: 'hold', signal: controller.signal });
		setTimeout(() => controller.abort(), 100);
		await expect(pending).rejects.toThrow('cancelled');
	} finally {
		await rm(cwd, { recursive: true, force: true });
	}
});

it('requests the advertised fast model, tolerates missing/rejected options and aborts on quota warning', async () => {
	const cwd = await mkdtemp(join(tmpdir(), 'brigadir-one-shot-model-'));
	try {
		for (const scenario of ['ghost-model', 'normal', 'ghost-option-fail']) {
			const log = join(cwd, `${scenario}.jsonl`);
			expect(
				await oneShotText({
					cwd,
					prompt: 'Suggest next.',
					preferredModel: 'haiku',
					stopAtRateWarning: true,
					adapter: {
						command: process.execPath,
						args: [resolve('packages/transport/fixtures/agent.mjs'), scenario, log],
					},
				})
			).toBe('hello world');
			const events = (await readFile(log, 'utf8'))
					.trim()
					.split('\n')
					.map((line) => JSON.parse(line)),
				option = events.find((event) => event.event === 'option');
			if (scenario === 'normal') expect(option).toBeUndefined();
			else expect(option.params.value).toBe('advertised-haiku');
		}
		await expect(
			oneShotText({
				cwd,
				prompt: 'Suggest next.',
				stopAtRateWarning: true,
				adapter: {
					command: process.execPath,
					args: [resolve('packages/transport/fixtures/agent.mjs'), 'ghost-warning'],
				},
			})
		).rejects.toThrow('quota warning');
	} finally {
		await rm(cwd, { recursive: true, force: true });
	}
});

it('sets the exact model and its lowest effort; text the adapter sends before the prompt is not the answer (spec/composer-steering-queue-and-ghost#ghost-headless)', async () => {
	const cwd = await mkdtemp(join(tmpdir(), 'brigadir-one-shot-effort-'));
	try {
		const run = async (model: string) => {
			const log = join(cwd, `${model}.jsonl`);
			const text = await oneShotText({
				cwd,
				prompt: 'Suggest next.',
				model,
				lowestEffort: true,
				adapter: {
					command: process.execPath,
					args: [resolve('packages/transport/fixtures/agent.mjs'), 'ghost-notice', log],
				},
			});
			return {
				text,
				options: (await readFile(log, 'utf8'))
					.trim()
					.split('\n')
					.map((line) => JSON.parse(line))
					.filter((event) => event.event === 'option')
					.map((event) => [event.params.configId, event.params.value]),
			};
		};
		expect(await run('other')).toEqual({
			text: 'hello world',
			options: [
				['model', 'other'],
				['effort', 'low'],
			],
		});
		// A model without effort levels sets the model only; an exact value never falls back to a name match (effort still drops on the current model).
		expect(await run('lite')).toEqual({ text: 'hello world', options: [['model', 'lite']] });
		expect(await run('Lit')).toEqual({ text: 'hello world', options: [['effort', 'low']] });
	} finally {
		await rm(cwd, { recursive: true, force: true });
	}
});

it('deletes its session after an answer and after a cancel, without waiting for the delete (spec/agents-and-providers#one-shot)', async () => {
	const cwd = await mkdtemp(join(tmpdir(), 'brigadir-one-shot-delete-'));
	try {
		const events = async (log: string) => {
			for (let attempt = 0; attempt < 40; attempt++) {
				const lines = await readFile(log, 'utf8').then(
					(text) =>
						text
							.trim()
							.split('\n')
							.map((line) => JSON.parse(line)),
					() => []
				);
				if (lines.some((line) => line.event === 'delete')) return lines;
				await new Promise((resolve) => setTimeout(resolve, 50));
			}
			return await readFile(log, 'utf8').then((text) =>
				text
					.trim()
					.split('\n')
					.map((line) => JSON.parse(line))
			);
		};
		const answered = join(cwd, 'answered.jsonl');
		expect(
			await oneShotText({
				cwd,
				prompt: 'Suggest next.',
				adapter: {
					command: process.execPath,
					args: [resolve('packages/transport/fixtures/agent.mjs'), 'normal', answered],
				},
			})
		).toBe('hello world');
		expect((await events(answered)).find((line) => line.event === 'delete')?.params).toEqual({
			sessionId: 'fixture-session',
		});
		const cancelled = join(cwd, 'cancelled.jsonl'),
			controller = new AbortController(),
			started = Date.now();
		const pending = oneShotText({
			cwd,
			prompt: 'hold',
			signal: controller.signal,
			adapter: {
				command: process.execPath,
				args: [resolve('packages/transport/fixtures/agent.mjs'), 'normal', cancelled],
			},
		});
		setTimeout(() => controller.abort(), 300);
		await expect(pending).rejects.toThrow('cancelled');
		expect(Date.now() - started).toBeLessThan(2000);
		expect((await events(cancelled)).some((line) => line.event === 'delete')).toBe(true);
		// An agent without `sessionCapabilities.delete` is not asked.
		const kept = join(cwd, 'kept.jsonl');
		expect(
			await oneShotText({
				cwd,
				prompt: 'Suggest next.',
				adapter: {
					command: process.execPath,
					args: [resolve('packages/transport/fixtures/agent.mjs'), 'no-delete', kept],
				},
			})
		).toBe('hello world');
		await new Promise((resolve) => setTimeout(resolve, 300));
		expect((await readFile(kept, 'utf8')).includes('"delete"')).toBe(false);
	} finally {
		await rm(cwd, { recursive: true, force: true });
	}
});
