import { expect, it } from 'vitest';
import {
	ghostModelPlan,
	helperCatalogProvider,
	helperEfforts,
	helperPlan,
	quotaExhausted,
} from './ghost-model';
import { migrateHelperAgent } from './settings';
import { emptyQuota, mergeQuota } from './quota';
import type { ProviderCatalog } from './crew';
const catalog = (provider: 'claude' | 'codex', choices: [string, string][]): ProviderCatalog => ({
	provider,
	modes: [],
	options: [
		{
			kind: 'select',
			id: 'model',
			category: 'model',
			name: 'Model',
			description: null,
			value: choices[0]![0],
			choices: choices.map(([value, name]) => ({ value, name, description: null, group: null })),
		},
	],
});
const claude = catalog('claude', [
		['default', 'Default (recommended)'],
		['sonnet', 'Sonnet 5'],
		['haiku', 'Haiku 4.5'],
	]),
	codex = catalog('codex', [
		['gpt-6.1-sol', '6.1 Sol'],
		['gpt-6-luna', '6 Luna'],
	]);
const both = { claude: true, codex: true },
	luna = { provider: 'codex' as const, model: 'gpt-6-luna', name: '6 Luna', effort: null };
it('defaults to Codex Luna, then Claude Haiku, by value or by name, and matches by name while the catalog is unknown (spec/composer-steering-queue-and-ghost#ghost-headless.10.2026)', () => {
	expect(ghostModelPlan(null, both, { claude, codex })).toEqual({
		target: {
			provider: 'codex',
			model: 'gpt-6-luna',
			preferredModel: null,
			name: '6 Luna',
			effort: null,
		},
		issue: null,
		fallback: false,
	});
	expect(ghostModelPlan(null, both, {}).target).toEqual({
		provider: 'codex',
		model: null,
		preferredModel: 'luna',
		name: 'Luna',
		effort: null,
	});
	// Codex off: Haiku.
	expect(ghostModelPlan(null, { claude: true, codex: false }, { claude }).target).toEqual({
		provider: 'claude',
		model: 'haiku',
		preferredModel: null,
		name: 'Haiku 4.5',
		effort: null,
	});
	expect(ghostModelPlan(null, { claude: true, codex: false }, {}).target).toEqual({
		provider: 'claude',
		model: null,
		preferredModel: 'haiku',
		name: 'Haiku',
		effort: null,
	});
	expect(
		ghostModelPlan(
			null,
			{ claude: true, codex: false },
			{
				claude: catalog('claude', [
					['default', 'Default'],
					['fast-1', 'Claude Haiku'],
				]),
			}
		).target
	).toMatchObject({ model: 'fast-1', name: 'Claude Haiku' });
	// A known Codex catalog without Luna: Haiku before Codex's own model.
	const solOnly = catalog('codex', [['gpt-6.1-sol', '6.1 Sol']]);
	expect(ghostModelPlan(null, both, { claude, codex: solOnly }).target).toMatchObject({
		provider: 'claude',
		model: 'haiku',
	});
	// No cheap entry anywhere: the first provider's own model.
	expect(
		ghostModelPlan(null, both, {
			claude: catalog('claude', [['default', 'Default']]),
			codex: solOnly,
		}).target
	).toEqual({
		provider: 'codex',
		model: null,
		preferredModel: null,
		name: '6.1 Sol',
		effort: null,
	});
});
it('uses the chosen model; a switched-off provider or a model the catalog no longer lists falls back to the default and says why', () => {
	const sonnet = { provider: 'claude' as const, model: 'sonnet', name: 'Sonnet 5', effort: null };
	expect(ghostModelPlan(luna, both, { claude, codex })).toEqual({
		target: {
			provider: 'codex',
			model: 'gpt-6-luna',
			preferredModel: null,
			name: '6 Luna',
			effort: null,
		},
		issue: null,
		fallback: false,
	});
	expect(ghostModelPlan(luna, both, { claude, codex: null }).target).toMatchObject({
		provider: 'codex',
		model: 'gpt-6-luna',
	});
	// A saved Claude choice stays Claude.
	expect(ghostModelPlan(sonnet, both, { claude, codex })).toMatchObject({
		target: { provider: 'claude', model: 'sonnet' },
		issue: null,
		fallback: false,
	});
	expect(ghostModelPlan(luna, { claude: true, codex: false }, { claude, codex })).toMatchObject({
		target: { provider: 'claude', model: 'haiku' },
		issue: 'provider-off',
		fallback: true,
	});
	expect(
		ghostModelPlan(luna, both, { claude, codex: catalog('codex', [['gpt-6.1-sol', '6.1 Sol']]) })
	).toMatchObject({ target: { model: 'haiku' }, issue: 'model-gone', fallback: true });
	expect(ghostModelPlan(sonnet, { claude: false, codex: true }, { codex })).toMatchObject({
		target: { provider: 'codex', model: 'gpt-6-luna' },
		issue: 'provider-off',
		fallback: true,
	});
	// Main probes the chosen provider's catalog; the default only reads one that is already known.
	expect(helperCatalogProvider(sonnet, both)).toBe('claude');
	expect(helperCatalogProvider(sonnet, { claude: false, codex: true })).toBe('codex');
	expect(helperCatalogProvider(null, both)).toBe('codex');
	expect(helperCatalogProvider(null, { claude: true, codex: false })).toBe('claude');
});
it('counts a provider exhausted only while one of its live windows is exhausted', () => {
	const reading = (exhausted: boolean, resetsAt: number | null) =>
		mergeQuota(
			emptyQuota(),
			{
				provider: 'codex',
				complete: true,
				windows: [
					{
						id: 'codex:300',
						kind: 'five-hour',
						model: null,
						minutes: 300,
						remaining: exhausted ? 0 : 0.1,
						resetsAt,
						exhausted,
					},
				],
			},
			1
		);
	expect(quotaExhausted(reading(false, null), 'codex')).toBe(false);
	expect(quotaExhausted(reading(true, null), 'codex')).toBe(true);
	expect(quotaExhausted(reading(true, 100), 'codex', 200_000)).toBe(false);
	expect(quotaExhausted(reading(true, null), 'claude')).toBe(false);
});

it("takes the capsule's one-time choice while its provider is on and lists a model's effort levels without default (spec/appearance#evolution-redesign)", () => {
	const run = { provider: 'codex' as const, model: 'gpt-6-luna', effort: 'high' };
	expect(helperPlan(run, null, both, {}).target).toEqual({
		provider: 'codex',
		model: 'gpt-6-luna',
		preferredModel: null,
		name: null,
		effort: 'high',
	});
	expect(helperPlan(run, null, { claude: true, codex: false }, { claude }).target).toMatchObject({
		provider: 'claude',
		model: 'haiku',
		effort: null,
	});
	const withEffort = {
		...claude,
		options: [
			...claude.options,
			{
				id: 'effort',
				category: 'thought_level',
				name: 'Effort',
				description: null,
				kind: 'select' as const,
				value: 'default',
				choices: [
					{ value: 'default', name: 'Default', description: null, group: null },
					{ value: 'low', name: 'Low', description: null, group: null },
					{ value: 'high', name: 'High', description: null, group: null },
				],
			},
		],
	};
	expect(helperEfforts(withEffort, 'haiku')).toEqual([
		{ value: 'low', name: 'Low' },
		{ value: 'high', name: 'High' },
	]);
	expect(helperEfforts(null, 'haiku')).toEqual([]);
});
it('migrates the stored suggestion model to the Helper agent with the lowest effort (spec/appearance#evolution-redesign)', () => {
	expect(
		migrateHelperAgent({
			suggestModel: { provider: 'codex', model: 'gpt-6-luna', name: '6 Luna' },
			a: 1,
		})
	).toEqual({
		a: 1,
		helperAgent: { provider: 'codex', model: 'gpt-6-luna', name: '6 Luna', effort: null },
	});
	expect(migrateHelperAgent({ suggestModel: null })).toEqual({ helperAgent: null });
	expect(migrateHelperAgent({})).toEqual({ helperAgent: null });
	const current = { helperAgent: null, suggestModel: 'x' };
	expect(migrateHelperAgent(current)).toBe(current);
});
