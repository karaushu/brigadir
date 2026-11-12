import { useEffect, useRef, useState, type ReactNode } from 'react';
import {
	actionChoice,
	agentProviders,
	helperEfforts,
	helperPlan,
	modelDisplayName,
	selectOption,
	t,
	type ActionAgents,
	type ActionCrew,
	type ActionCrews,
	type AgentAction,
	type AppSettings,
	type CrewAction,
	type AgentProviderId,
	type HelperAgent,
	type HelperRun,
	type Locale,
	type MessageKey,
	type ProviderCatalog,
} from '@brigadir/core';
import { ComposerOptions, ModelGroups, type CapsuleModels } from './ComposerOptions';
import { SplitButton } from './ui/Controls';
import { Glyph } from './ui/Glyph';
import { Popover } from './ui/Popover';
import composer from './ComposerOptions.module.css';

/**
 * spec/appearance#evolution-redesign: the Helper agent — who writes the short one-off texts — and its in-place capsule. The capsule is the composer's
 * model · effort capsule (rule 17); a choice in it serves one run and never changes Settings.
 */
type Catalogs = Partial<Record<AgentProviderId, ProviderCatalog | null>>;
const providerName: Record<AgentProviderId, string> = { claude: 'Claude', codex: 'Codex' };
const catalogCache = new Map<
	AgentProviderId,
	{ at: number; value: Promise<ProviderCatalog | null> }
>();
/** One read per provider a minute: every capsule on screen shares it. A refused read (handlers still registering) asks again. */
export function readCatalog(provider: AgentProviderId): Promise<ProviderCatalog | null> {
	const hit = catalogCache.get(provider);
	if (hit && Date.now() - hit.at < 60_000) return hit.value;
	const ask = (attempt: number): Promise<ProviderCatalog | null> =>
		window.brigadir
			.readProviderCatalog(provider)
			.catch(() =>
				attempt < 3
					? new Promise<ProviderCatalog | null>((resolve) =>
							setTimeout(() => resolve(ask(attempt + 1)), 1000)
						)
					: null
			);
	const value = ask(0);
	catalogCache.set(provider, { at: Date.now(), value });
	return value;
}
/** undefined — still asking; null — the provider gave no catalog (no CLI, not signed in). */
export function useProviderCatalogs(enabled: Record<AgentProviderId, boolean> | null): Catalogs {
	const [catalogs, setCatalogs] = useState<Catalogs>({});
	useEffect(() => {
		let live = true;
		for (const provider of agentProviders)
			if (enabled?.[provider])
				void readCatalog(provider).then((catalog) => {
					if (live) setCatalogs((current) => ({ ...current, [provider]: catalog }));
				});
		return () => {
			live = false;
		};
	}, [enabled?.claude, enabled?.codex]);
	return catalogs;
}
export type HelperSettings = {
	choice: HelperAgent | null;
	enabled: Record<AgentProviderId, boolean>;
	defaultProvider: AgentProviderId;
	/** spec/appearance#evolution-redesign: Customize per action — the changed actions only. */
	actionAgents: ActionAgents;
	/** spec/pull-requests-and-ci#review-crew: the review actions that run by a crew. */
	actionCrews: ActionCrews;
};
/** Every surface on screen hears a `Remember for …` of another one, so two capsules of one action never disagree. */
const actionListeners = new Set<(settings: AppSettings) => void>();
/** spec/appearance#evolution-redesign: `Remember for …` (an agent) or `Reset` (null) of one action; main changes only that entry. */
export async function saveActionAgent(action: AgentAction, agent: HelperAgent | null) {
	const snapshot = await window.brigadir.saveActionAgent(action, agent);
	for (const listener of actionListeners) listener(snapshot.settings);
	return snapshot;
}
/** spec/pull-requests-and-ci#review-crew: `Remember for …` on the Crew segment (a crew) or `Reset` (null); main forgets the action's agent with it. */
export async function saveActionCrew(action: CrewAction, crew: ActionCrew | null) {
	const snapshot = await window.brigadir.saveActionCrew(action, crew);
	for (const listener of actionListeners) listener(snapshot.settings);
	return snapshot;
}
/** The Helper agent and the Default agent of Settings, read once per surface. */
export function useHelperSettings(): HelperSettings | null {
	const [value, setValue] = useState<HelperSettings | null>(null);
	useEffect(() => {
		let live = true;
		void window.brigadir.readSettings().then(
			(snapshot) => {
				if (live)
					setValue({
						choice: snapshot.settings.helperAgent,
						enabled: snapshot.settings.agents.enabled,
						defaultProvider: snapshot.settings.agents.provider,
						actionAgents: snapshot.settings.actionAgents,
						actionCrews: snapshot.settings.actionCrews,
					});
			},
			() => {}
		);
		const heard = ({ actionAgents, actionCrews }: AppSettings) =>
			setValue((current) => (current ? { ...current, actionAgents, actionCrews } : current));
		actionListeners.add(heard);
		return () => {
			live = false;
			actionListeners.delete(heard);
		};
	}, []);
	return value;
}
/** spec/appearance#evolution-redesign: the actions' names in Customize per action. */
export const actionNames: Record<AgentAction, MessageKey> = {
	review: 'Review with an agent',
	reviewSuggestions: 'Suggestions in review',
	taskReview: 'Review before PR',
	agentFix: 'Agent fixes it',
	conflicts: 'Resolve conflicts',
	prSummary: 'PR summary',
	reviewDrafts: 'Generate from the drafts',
	commitMessage: 'Commit message',
	prText: 'PR title and description',
	branchName: 'Branch name',
	split: 'Split with the agent',
	projectIcon: 'Project icon',
	promptHint: 'Prompt hint',
	slackAnswers: 'Slack: answers',
	slackCode: 'Slack: code questions',
};
/** spec/appearance#evolution-redesign: the checkbox of a capsule — only the actions that have one. */
const rememberLabels: Partial<Record<AgentAction, MessageKey>> = {
	review: 'Remember for reviews with an agent',
	reviewSuggestions: 'Remember for agent suggestions in review',
	prSummary: 'Remember for PR summaries',
	commitMessage: 'Remember for commit messages',
	prText: 'Remember for PR titles and descriptions',
	split: 'Remember for splitting with the agent',
};
/** The model's catalog name for a remembered choice, so Settings can name it while the provider is off. */
function rememberedAgent(run: HelperRun, catalogs: Catalogs): HelperAgent {
	const catalog = catalogs[run.provider],
		model = catalog ? selectOption(catalog.options, 'model') : undefined;
	return {
		provider: run.provider,
		model: run.model,
		name: model?.choices.find((choice) => choice.value === run.model)?.name ?? null,
		effort: run.effort,
	};
}
export type HelperShown = {
	provider: AgentProviderId;
	model: string | null;
	modelName: string;
	effort: string | null;
	effortName: string | null;
};
/** Who writes this run: the capsule's choice, else the action's own agent (spec/appearance#evolution-redesign), else Settings' Helper agent, else
 *  the default (Codex Luna, then Claude Haiku, spec/composer-steering-queue-and-ghost#ghost-headless); with the names to show. */
export function helperShown(
	settings: HelperSettings | null,
	catalogs: Catalogs,
	run: HelperRun | null,
	action?: AgentAction
): HelperShown | null {
	if (!settings) return null;
	const pick = action
		? actionChoice(action, run, settings.actionAgents, settings.enabled, catalogs).run
		: run;
	const target = helperPlan(pick, settings.choice, settings.enabled, catalogs).target;
	if (!target) return null;
	const catalog = catalogs[target.provider],
		models = catalog ? selectOption(catalog.options, 'model') : undefined,
		model = target.model ?? models?.value ?? null,
		efforts = helperEfforts(catalog, model),
		effort = efforts.find((item) => item.value === target.effort) ?? efforts[0] ?? null;
	const name =
		models?.choices.find((item) => item.value === model)?.name ?? target.name ?? model ?? '';
	return {
		provider: target.provider,
		model,
		modelName: modelDisplayName(name, target.provider),
		effort: effort?.value ?? null,
		effortName: effort?.name ?? null,
	};
}
/** The capsule's data: both providers' catalogs, the effort of the shown model, the «Only this time» line; spec/appearance#evolution-redesign:
 *  `Remember for <action>` above it, and «Saved in Settings ▸ Agents» instead of it while that is checked. */
export function helperModels({
	locale,
	settings,
	catalogs,
	run,
	onRun,
	title,
	note,
	side,
	narrow,
	action,
	remember,
}: {
	locale: Locale;
	settings: HelperSettings | null;
	catalogs: Catalogs;
	run: HelperRun | null;
	onRun(run: HelperRun): void;
	title: string;
	note?: string;
	side?: 'top' | 'bottom';
	narrow?: boolean;
	action?: AgentAction;
	remember?: { checked: boolean; onChange(checked: boolean): void };
}): { models: CapsuleModels; shown: HelperShown } | null {
	const shown = helperShown(settings, catalogs, run, action);
	const rememberLabel = action ? rememberLabels[action] : undefined;
	if (!settings || !shown) return null;
	const efforts = helperEfforts(catalogs[shown.provider], shown.model);
	return {
		shown,
		models: {
			groups: agentProviders
				.filter((provider) => settings.enabled[provider])
				.map((provider) => {
					const catalog = catalogs[provider],
						model = catalog ? selectOption(catalog.options, 'model') : undefined;
					return {
						provider,
						name: providerName[provider],
						choices:
							catalog === undefined
								? null
								: (model?.choices ?? []).map((choice) => ({
										value: choice.value,
										name: choice.name,
										description: choice.description,
									})),
						task: null,
						limit: null,
					};
				}),
			provider: shown.provider,
			value: shown.model ?? '',
			label: shown.modelName,
			note:
				remember?.checked && rememberLabel
					? t(locale, 'Saved in Settings ▸ Agents.')
					: (note ?? t(locale, 'Only this time. Default: Helper agent in Settings ▸ Agents.')),
			...(remember && rememberLabel
				? { remember: { label: t(locale, rememberLabel), ...remember } }
				: {}),
			title,
			side,
			narrow,
			onChoose: (provider, value) => {
				const levels = helperEfforts(catalogs[provider], value);
				onRun({
					provider,
					model: value,
					effort: levels.some((item) => item.value === shown.effort)
						? shown.effort
						: (levels[0]?.value ?? null),
				});
			},
			...(efforts.length
				? {
						effort: {
							choices: efforts,
							value: shown.effort ?? efforts[0]!.value,
							onChoose: (value: string) =>
								onRun({ provider: shown.provider, model: shown.model ?? '', effort: value }),
						},
					}
				: {}),
		},
	};
}
/** spec/appearance#evolution-redesign: below this width a capsule shows the provider glyph alone, the model in its tooltip. */
export function useNarrowWindow(width = 960) {
	const query = `(max-width: ${width}px)`;
	const [narrow, setNarrow] = useState(() => window.matchMedia(query).matches);
	useEffect(() => {
		const list = window.matchMedia(query),
			change = () => setNarrow(list.matches);
		list.addEventListener('change', change);
		return () => list.removeEventListener('change', change);
	}, [query]);
	return narrow;
}
/**
 * The Helper agent's state on one surface for one action: Settings, catalogs, the one-time choice and spec/appearance#evolution-redesign's
 * `Remember for …`. `choose` is the capsule's choice: one-time, and also the action's own agent while Remember is checked;
 * checking Remember after a one-time choice saves that choice.
 */
export function useHelperRun(action: AgentAction) {
	const settings = useHelperSettings(),
		catalogs = useProviderCatalogs(settings?.enabled ?? null),
		[run, setRun] = useState<HelperRun | null>(null),
		[remember, setRemember] = useState(false);
	const choose = (next: HelperRun) => {
		setRun(next);
		if (remember) void saveActionAgent(action, rememberedAgent(next, catalogs)).catch(() => {});
	};
	const rememberChange = (checked: boolean) => {
		setRemember(checked);
		if (checked && run)
			void saveActionAgent(action, rememberedAgent(run, catalogs)).catch(() => {});
	};
	return {
		action,
		settings,
		catalogs,
		run,
		setRun: choose,
		remember: { checked: remember, onChange: rememberChange },
	};
}
/** The capsule in a summary header: `Haiku 4.5 · Low ▾`; a choice calls `onRun` (the summary then writes itself again). */
export function HelperCapsule({
	locale,
	title,
	state,
	disabled = false,
	narrow: narrowBox = false,
	onRun,
}: {
	locale: Locale;
	title: string;
	state: ReturnType<typeof useHelperRun>;
	disabled?: boolean;
	/** The glyph alone in a narrow surface of a wide window, e.g. a PR Overview in a 400 px workspace. */
	narrow?: boolean;
	onRun?(run: HelperRun): void;
}) {
	const narrow = useNarrowWindow() || narrowBox;
	const data = helperModels({
		locale,
		settings: state.settings,
		catalogs: state.catalogs,
		run: state.run,
		onRun: (run) => {
			state.setRun(run);
			onRun?.(run);
		},
		title,
		side: 'bottom',
		narrow,
		action: state.action,
		remember: state.remember,
	});
	if (!data) return null;
	return (
		<span data-helper-capsule>
			<ComposerOptions
				provider={data.shown.provider}
				locale={locale}
				disabled={disabled}
				models={data.models}
			/>
		</span>
	);
}
/** `Generate | ✳ Haiku 4.5 ▾`: the action and, in its second part, the agent of this run. */
export function HelperSplit({
	locale,
	state,
	disabled = false,
	label,
	title,
	onClick,
	children,
}: {
	locale: Locale;
	state: ReturnType<typeof useHelperRun>;
	disabled?: boolean;
	label: string;
	title?: string;
	onClick(): void;
	children?: ReactNode;
}) {
	const narrow = useNarrowWindow(),
		[open, setOpen] = useState(false),
		toggle = useRef<HTMLButtonElement>(null);
	const data = helperModels({
		locale,
		settings: state.settings,
		catalogs: state.catalogs,
		run: state.run,
		onRun: state.setRun,
		title: t(locale, 'Agent for this run'),
		action: state.action,
		remember: state.remember,
	});
	const name = data
		? [data.shown.modelName, data.shown.effortName].filter(Boolean).join(' · ')
		: '';
	return (
		<SplitButton
			disabled={disabled}
			title={title}
			onClick={onClick}
			data-helper-split
			second={{
				label: name
					? `${t(locale, 'Agent for this run')} · ${name}`
					: t(locale, 'Agent for this run'),
				ref: toggle,
				expanded: open,
				disabled: !data,
				onClick: () => setOpen((value) => !value),
				content: data ? (
					<>
						<span className={composer.provider} data-provider={data.shown.provider}>
							<Glyph name={data.shown.provider === 'codex' ? 'openai' : 'claude'} size={12} />
						</span>
						{!narrow && <span>{data.shown.modelName}</span>}
					</>
				) : undefined,
			}}
			menu={
				data && (
					<Popover
						open={open}
						onClose={() => setOpen(false)}
						anchor={toggle}
						align="end"
						width={260}
						headerSize="s"
						label={t(locale, 'Agent for this run')}
						locale={locale}
						className={composer.menu}
						initialFocus={(panel) => panel.querySelector<HTMLElement>('[aria-checked=true]')}>
						<ModelGroups models={data.models} section="model" locale={locale} />
					</Popover>
				)
			}>
			{children ?? (
				<>
					<span className={composer.generate}>
						<Glyph name="generate" size={12} />
					</span>
					<span>{label}</span>
				</>
			)}
		</SplitButton>
	);
}
