import { expect, it } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { selectOption } from '@brigadir/core';
import { probeAgentCatalog } from './catalog';
it('records the options the provider answers for every model, without a prompt (spec/agents-and-providers#catalog)', async () => {
	const cwd = await mkdtemp(join(tmpdir(), 'brigadir-catalog-'));
	try {
		const catalog = await probeAgentCatalog({
			provider: 'claude',
			cwd,
			adapter: {
				command: process.execPath,
				args: [resolve('packages/transport/fixtures/agent.mjs'), 'model-effort'],
			},
		});
		expect(catalog).not.toBeNull();
		expect(Object.keys(catalog!.byModel)).toEqual(['fixture', 'other', 'lite']);
		const effort = (model: string) => selectOption(catalog!.byModel[model]!, 'effort');
		expect(effort('fixture')?.choices.map((choice) => choice.value)).toEqual([
			'low',
			'medium',
			'high',
		]);
		expect(effort('fixture')?.value).toBe('high');
		expect(effort('other')?.choices.map((choice) => choice.value)).toEqual(['low', 'medium']);
		expect(effort('other')?.value).toBe('medium');
		expect(effort('lite')).toBeUndefined();
		// The advertised catalog stays the session's first answer, not the last model set.
		expect(selectOption(catalog!.options, 'model')?.value).toBe('fixture');
	} finally {
		await rm(cwd, { recursive: true, force: true });
	}
});
