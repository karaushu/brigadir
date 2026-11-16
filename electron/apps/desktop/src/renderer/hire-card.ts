import {
	autoHireable,
	catalogOptions,
	selectOption,
	type AgentProvider,
	type AutoHire,
	type AutoHireDecision,
	type AutoHirePart,
	type AutoModelAnswer,
	type ProviderCatalog,
} from '@brigadir/core';
/** spec/chat-turns-plans-and-questions#hire-card: what the person changed on a part; an edited chip takes the accent. */
export type PartEdits = { title: boolean; role: boolean; budget: boolean; prompt: boolean };
export function partEdits(proposed: AutoHirePart, current: AutoHirePart): PartEdits {
	return {
		title: proposed.title !== current.title,
		role: proposed.role !== current.role,
		budget:
			proposed.budget.minutes !== current.budget.minutes ||
			proposed.budget.tokens !== current.budget.tokens,
		prompt: proposed.prompt !== current.prompt,
	};
}
export function hireEdited(hire: AutoHire, parts: readonly AutoHirePart[]): boolean {
	return hire.parts.some((part, index) => {
		const current = parts[index];
		if (!current) return true;
		const edits = partEdits(part, current);
		return edits.title || edits.role || edits.budget || edits.prompt;
	});
}
/** `Hire {n}` approves with the edited parts (all of them, null when nothing changed); `Do it yourself` declines. */
export function hireDecision(
	hire: AutoHire,
	parts: readonly AutoHirePart[],
	approved: boolean
): AutoHireDecision {
	return {
		id: hire.id,
		approved,
		parts:
			approved && hireEdited(hire, parts)
				? parts.map((part) => ({ ...part, title: part.title.trim() || part.title }))
				: null,
	};
}
/** The parts that stay with the agent, by their 1-based number. */
export function refusedNumbers(parts: readonly AutoHirePart[]): number[] {
	return parts.flatMap((part, index) => (part.refused ? [index + 1] : []));
}
/** Hire needs at least one part the host lets through, and every part a title and a prompt. */
export function canHire(parts: readonly AutoHirePart[]): boolean {
	return (
		autoHireable(parts).length > 0 &&
		parts.every((part) => part.title.trim().length > 0 && part.prompt.trim().length > 0)
	);
}
/** spec/crew#auto-model: one catalog model of a provider, as the card lists it. */
export type ModelChoice = { provider: AgentProvider; value: string; name: string };
/** The catalog models of the providers given, in the providers' order; providers without a catalog give none. */
export function catalogModels(
	catalogs: Partial<Record<AgentProvider, ProviderCatalog | null | undefined>>,
	providers: readonly AgentProvider[]
): ModelChoice[] {
	return providers.flatMap((provider) => {
		const option = selectOption(catalogs[provider]?.options ?? [], 'model');
		return (option?.choices ?? []).map((choice) => ({
			provider,
			value: choice.value,
			name: choice.name,
		}));
	});
}
/** The effort levels of a model, from the catalog's answer for that model. */
export function modelEfforts(catalog: ProviderCatalog | null | undefined, model: string) {
	const option = selectOption(catalogOptions(catalog ?? null, model), 'effort');
	return option ? { id: option.id, choices: option.choices } : null;
}
/** The answer of `Use this model`: catalog option ids and values with their names (rule 7). */
export function modelAnswer(
	catalog: ProviderCatalog,
	model: ModelChoice,
	effort: string | null,
	saveAs: string | null
): AutoModelAnswer {
	const option = selectOption(catalog.options, 'model'),
		levels = modelEfforts(catalog, model.value),
		level = levels?.choices.find((choice) => choice.value === effort);
	return {
		provider: model.provider,
		model: option ? { id: option.id, value: model.value, name: model.name } : null,
		effort: levels && level ? { id: levels.id, value: level.value, name: level.name } : null,
		...(saveAs?.trim() ? { saveAs: saveAs.trim().slice(0, 80) } : {}),
	};
}
