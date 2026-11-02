import { selectOption } from './agent-options';
import type { ProviderCatalog } from './crew';
import type { AgentProviderId, HelperAgent, HelperRun } from './settings';
import type { AgentOption } from './agent';
import type { QuotaSnapshot } from './quota';
import { liveWindows } from './quota';
/**
 * spec/composer-steering-queue-and-ghost#ghost-headless: which provider and model write the next-prompt hint. The list is the adapters' own catalogs (rule 7);
 * the default is a catalog entry whose value or name says the word below (spec/agents-and-providers#provider-terms):
 * Codex Luna first — OpenAI's own path for local apps; Claude Haiku when Codex is off or has no Luna.
 */
export const ghostDefaults: readonly { provider: AgentProviderId; model: string; name: string }[] =
	[
		{ provider: 'codex', model: 'luna', name: 'Luna' },
		{ provider: 'claude', model: 'haiku', name: 'Haiku' },
	];
export const ghostDefaultProvider = ghostDefaults[0]!.provider;
export const ghostDefaultModel = ghostDefaults[0]!.model;
/** `provider-off`: the chosen provider is switched off in Settings ▸ Agents; `model-gone`: its catalog no longer lists the model. */
export type GhostModelIssue = 'provider-off' | 'model-gone';
/** `model` is an exact catalog value; `preferredModel` a name to match when the catalog is not known yet; `effort` an exact
 *  level of that model, null — the lowest it advertises (spec/appearance#evolution-redesign). */
export type GhostTarget = {
	provider: AgentProviderId;
	model: string | null;
	preferredModel: string | null;
	name: string | null;
	effort: string | null;
};
export type GhostModelPlan = {
	target: GhostTarget | null;
	issue: GhostModelIssue | null;
	fallback: boolean;
};
type Catalogs = Partial<Record<AgentProviderId, ProviderCatalog | null>>;

function defaultTarget(
	enabled: Record<AgentProviderId, boolean>,
	catalogs: Catalogs
): GhostTarget | null {
	let own: GhostTarget | null = null;
	for (const entry of ghostDefaults) {
		if (!enabled[entry.provider]) continue;
		const catalog = catalogs[entry.provider],
			model = catalog ? selectOption(catalog.options, 'model') : undefined;
		// The catalog is not known yet: matched by name during the call.
		if (!model)
			return {
				provider: entry.provider,
				model: null,
				preferredModel: entry.model,
				name: entry.name,
				effort: null,
			};
		const choice =
			model.choices.find((choice) => choice.value.toLowerCase() === entry.model) ??
			model.choices.find((choice) =>
				`${choice.value} ${choice.name}`.toLowerCase().includes(entry.model)
			);
		if (choice)
			return {
				provider: entry.provider,
				model: choice.value,
				preferredModel: null,
				name: choice.name,
				effort: null,
			};
		// No such entry: the next provider's cheap model first; otherwise the first provider's own model, named for Settings.
		own ??= {
			provider: entry.provider,
			model: null,
			preferredModel: null,
			name: model.choices.find((item) => item.value === model.value)?.name ?? null,
			effort: null,
		};
	}
	return own;
}
/** The provider whose catalog decides the target: the chosen one while it is on, else the first default that is on
 *  (spec/composer-steering-queue-and-ghost#ghost-headless: a known Codex catalog without Luna goes to Haiku, not to Codex's own model). */
export function helperCatalogProvider(
	choice: HelperAgent | null,
	enabled: Record<AgentProviderId, boolean>
): AgentProviderId | null {
	if (choice && enabled[choice.provider]) return choice.provider;
	return ghostDefaults.find((entry) => enabled[entry.provider])?.provider ?? null;
}
/** A catalog that is not known (not probed yet, the probe failed) never makes a choice unavailable: only a listed catalog can. */
export function ghostModelPlan(
	choice: HelperAgent | null,
	enabled: Record<AgentProviderId, boolean>,
	catalogs: Catalogs
): GhostModelPlan {
	if (choice) {
		let issue: GhostModelIssue | null = null;
		if (!enabled[choice.provider]) issue = 'provider-off';
		else {
			const catalog = catalogs[choice.provider],
				model = catalog ? selectOption(catalog.options, 'model') : undefined;
			if (model && !model.choices.some((item) => item.value === choice.model)) issue = 'model-gone';
			else
				return {
					target: {
						provider: choice.provider,
						model: choice.model,
						preferredModel: null,
						name: model?.choices.find((item) => item.value === choice.model)?.name ?? choice.name,
						effort: choice.effort,
					},
					issue: null,
					fallback: false,
				};
		}
		return { target: defaultTarget(enabled, catalogs), issue, fallback: true };
	}
	const target = defaultTarget(enabled, catalogs);
	return { target, issue: null, fallback: false };
}
/** spec/appearance#evolution-redesign: the capsule's one-time choice wins while its provider is on; otherwise the Helper agent of Settings. */
export function helperPlan(
	run: HelperRun | null | undefined,
	choice: HelperAgent | null,
	enabled: Record<AgentProviderId, boolean>,
	catalogs: Catalogs
): GhostModelPlan {
	if (run && enabled[run.provider])
		return {
			target: {
				provider: run.provider,
				model: run.model,
				preferredModel: null,
				name: null,
				effort: run.effort,
			},
			issue: null,
			fallback: false,
		};
	return ghostModelPlan(choice, enabled, catalogs);
}
/** spec/agents-and-providers#catalog, spec/appearance#evolution-redesign: the effort levels of one model, lowest first, without the provider's `default`. */
export function helperEfforts(
	catalog: ProviderCatalog | null | undefined,
	model: string | null
): { value: string; name: string }[] {
	if (!catalog) return [];
	const options: AgentOption[] = (model && catalog.byModel?.[model]) || catalog.options,
		effort = selectOption(options, 'effort');
	return (effort?.choices ?? [])
		.filter((choice) => choice.value !== 'default')
		.map((choice) => ({ value: choice.value, name: choice.name }));
}
/** spec/composer-steering-queue-and-ghost#ghost-headless: a Codex hint stops only while a Codex window is really exhausted; adapters send Codex no rate-limit events. */
export function quotaExhausted(
	snapshot: QuotaSnapshot,
	provider: AgentProviderId,
	now = Date.now()
): boolean {
	const entry = snapshot.providers.find((item) => item.provider === provider);
	return Boolean(entry && liveWindows(entry, now).some((window) => window.exhausted));
}
