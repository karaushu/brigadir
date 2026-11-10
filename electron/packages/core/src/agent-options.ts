import type { AgentOption } from './agent';
import type { ProviderCatalog } from './crew';
export type AgentOptionKind = 'model' | 'effort' | 'mode' | 'fast' | 'other';
/** Kind by a category or an option id alone: a crew snapshot keeps only ids (spec/crew-templates-and-editor#roster). */
export function agentOptionKindOf(value: string | null): AgentOptionKind {
	return value === 'model'
		? 'model'
		: ['thought_level', 'effort', 'reasoning_effort', 'thinking_level'].includes(value ?? '')
			? 'effort'
			: value === 'mode'
				? 'mode'
				: ['fast', 'fast-mode', 'fast_mode'].includes(value ?? '')
					? 'fast'
					: 'other';
}
export function agentOptionKind(option: AgentOption): AgentOptionKind {
	const category = agentOptionKindOf(option.category);
	return category === 'other' ? agentOptionKindOf(option.id) : category;
}
export function orderAgentOptions(options: readonly AgentOption[]): AgentOption[] {
	const rank = { model: 0, effort: 1, mode: 2, fast: 3, other: 4 };
	return [...options].sort((a, b) => rank[agentOptionKind(a)] - rank[agentOptionKind(b)]);
}
/** Cycle exactly the provider's advertised order; modern mode options take precedence. */
export function nextAgentMode(
	options: readonly AgentOption[],
	modes: readonly import('./agent').AgentMode[],
	modeId: string | null
): import('./session').SessionCommand | null {
	const option = options.find((option) => agentOptionKind(option) === 'mode');
	if (option) {
		if (option.kind !== 'select' || option.choices.length < 2) return null;
		const index = option.choices.findIndex((choice) => choice.value === option.value);
		return {
			kind: 'setOption',
			id: option.id,
			value: option.choices[(index + 1) % option.choices.length]!.value,
		};
	}
	if (modes.length < 2) return null;
	const index = modes.findIndex((mode) => mode.id === modeId);
	return { kind: 'setMode', modeId: modes[(index + 1) % modes.length]!.id };
}

/** Names the provider gave the chosen model and effort, for task.json and cards (spec/projects-and-board#board rule 6). */
export function chosenOptionNames(options: readonly AgentOption[]): {
	modelName: string | null;
	effortName: string | null;
} {
	const name = (kind: 'model' | 'effort') => {
		const option = options.find((item) => agentOptionKind(item) === kind);
		if (!option || option.kind !== 'select') return null;
		return option.choices.find((choice) => choice.value === option.value)?.name ?? option.value;
	};
	return { modelName: name('model'), effortName: name('effort') };
}

/** spec/agents-and-providers#catalog: the options the provider shows once `model` is set — effort levels differ per model. Unknown model: the catalog as advertised. */
export function catalogOptions(
	catalog: Pick<ProviderCatalog, 'options' | 'byModel'> | null | undefined,
	model?: string | boolean | null
): AgentOption[] {
	if (!catalog) return [];
	if (typeof model !== 'string') return catalog.options;
	return catalog.byModel?.[model] ?? catalog.options;
}
/** The select option of a kind (model, effort, mode) in a list of provider options. */
export function selectOption(
	options: readonly AgentOption[],
	kind: 'model' | 'effort' | 'mode'
): Extract<AgentOption, { kind: 'select' }> | undefined {
	return options.find(
		(option): option is Extract<AgentOption, { kind: 'select' }> =>
			agentOptionKind(option) === kind && option.kind === 'select'
	);
}
/** spec/crew#return-effort: an effort level of the session's current model by the catalog's value or name, whatever the case.
 *  `null` — the model has no effort levels; `choice: null` — no such level, `levels` names what there is. */
export function effortLevel(
	options: readonly AgentOption[],
	wanted: string
): {
	option: Extract<AgentOption, { kind: 'select' }>;
	choice: { value: string; name: string } | null;
	levels: string[];
} | null {
	const option = selectOption(options, 'effort');
	if (!option) return null;
	const same = (value: string) =>
		value.trim().toLocaleLowerCase('en') === wanted.trim().toLocaleLowerCase('en');
	const choice =
		option.choices.find((item) => item.value === wanted) ??
		option.choices.find((item) => same(item.name) || same(item.value)) ??
		null;
	return { option, choice, levels: option.choices.map((item) => item.name) };
}
/** spec/crew-templates-and-editor#library-list: where a level stands among the model's own levels (`default` is no level). `high` is the level
 *  whose value or name reads `high` — a presentation rule by the word, not a table of levels (rule 7); -1 when the model has none. */
export function effortRank(
	choices: readonly { value: string; name: string }[],
	value: string | boolean | null | undefined
): { count: number; index: number; high: number } {
	const levels = choices.filter((choice) => choice.value !== 'default'),
		reads = (text: string) => text.trim().toLowerCase() === 'high';
	return {
		count: levels.length,
		index: levels.findIndex((choice) => choice.value === value),
		high: levels.findIndex((choice) => reads(choice.value) || reads(choice.name)),
	};
}
export type TemplateFit = 'scoped' | 'hard' | 'lead';
/** spec/crew-templates-and-editor#library-list: the work a template fits. A foreman or a reviewer leads and checks; a developer takes hard parts
 *  from `high` effort up, scoped parts otherwise (spec/crew#model-ladder). */
export function templateFit(
	role: 'foreman' | 'developer' | 'reviewer',
	rank: { index: number; high: number } | null
): TemplateFit {
	if (role !== 'developer') return 'lead';
	return rank && rank.high >= 0 && rank.index >= rank.high ? 'hard' : 'scoped';
}
/** spec/composer#capsule-squeeze: beside the provider glyph the capsule does not repeat the provider — a leading `<provider>-` is not shown
 *  (`claude-opus-5` → `opus-5`). A presentation rule, not a table of names (rule 7): anything else stays as the agent named it. */
export function modelDisplayName(name: string, provider: string | null | undefined): string {
	if (!provider) return name;
	const prefix = `${provider}-`;
	return name.toLowerCase().startsWith(prefix.toLowerCase()) && name.length > prefix.length
		? name.slice(prefix.length)
		: name;
}
/** spec/composer#capsule-squeeze: whether a fast option is on — a boolean, or a select whose chosen value or name says `on`/`true`. */
export function fastOptionOn(option: AgentOption): boolean {
	if (option.kind !== 'select') return Boolean(option.value);
	const choice = option.choices.find((item) => item.value === option.value);
	return /\b(on|true)\b/i.test(`${option.value} ${choice?.name ?? ''}`);
}
/** spec/composer#capsule-segments: an on/off option — a boolean, or a select of exactly two choices that read `on`/`off` (`true`/`false`), as
 *  Claude's Ultracode. A presentation rule by the words, not a table of options (rule 7). */
export function onOffOption(option: AgentOption): boolean {
	if (option.kind !== 'select') return true;
	const words = option.choices.map((choice) => `${choice.value} ${choice.name}`.toLowerCase());
	return (
		words.length === 2 &&
		words.some((word) => /\b(on|true)\b/.test(word)) &&
		words.some((word) => /\b(off|false)\b/.test(word))
	);
}
/** spec/composer#agent-capsule: the typical choices of a select — the one whose value or name is `default`, else the first the agent lists
 *  (the agent lists its own default first); and any whose value or name is `auto` (`Auto mode`): the
 *  agent decides permissions itself, there is nothing to warn about. A presentation rule, not a table of modes (rule 7). */
export function typicalChoices(option: AgentOption): string[] {
	if (option.kind !== 'select' || !option.choices.length) return [];
	const is = (pattern: RegExp) =>
		option.choices.filter((choice) => pattern.test(choice.value) || pattern.test(choice.name));
	const named = is(/^default$/i)[0] ?? option.choices[0]!;
	return [
		named.value,
		...is(/^auto( mode)?$/i)
			.map((choice) => choice.value)
			.filter((value) => value !== named.value),
	];
}
/** spec/appearance#evolution-redesign, spec/composer#agent-capsule: whether the composer capsule shows a segment for the option. Model and effort always; the
 *  mode only off its typical choices; Fast and any other on/off option (a flag or an On/Off select, spec/composer#capsule-segments) only when on;
 *  any other select always. */
export function capsuleShows(option: AgentOption): boolean {
	const kind = agentOptionKind(option);
	if (kind === 'model' || kind === 'effort') return true;
	if (kind === 'fast') return fastOptionOn(option);
	if (option.kind !== 'select') return Boolean(option.value);
	if (onOffOption(option)) return fastOptionOn(option);
	if (kind === 'mode') return !typicalChoices(option).includes(option.value);
	return true;
}
