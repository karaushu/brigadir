import {
	agentProviders,
	ghostDefaults,
	ghostModelPlan,
	helperEfforts,
	modelDisplayName,
	selectOption,
	t,
	type AgentProviderId,
	type AppSettings,
	type Locale,
} from '@brigadir/core';
import { SettingsRow } from './SettingsForm';
import { useNarrowWindow, useProviderCatalogs } from './HelperAgent';
import { ComposerOptions, type CapsuleModels } from './ComposerOptions';
const providerName: Record<AgentProviderId, string> = { claude: 'Claude', codex: 'Codex' };
/** spec/appearance#interface-font: below this window width Settings' labels are 110 px; the capsule shows its provider glyph alone (as per action). */
const NARROW = 560;
/**
 * spec/appearance#evolution-redesign (was «Suggestion model», spec/composer-steering-queue-and-ghost#ghost-headless): the Helper agent — model · effort for every short one-off job, from the
 * adapters' own catalogs (rule 7). spec/settings-modules-and-onboarding#module-settings-popup (rule 17): the same model · effort capsule and menu as the rows of Customize
 * per action, without `Same as …`. A choice that is off or gone stays shown, and the line under it names who writes instead.
 */
export function HelperAgentRow({
	settings,
	locale,
	busy,
	update,
}: {
	settings: AppSettings;
	locale: Locale;
	busy: boolean;
	update(patch: Partial<AppSettings>): void;
}) {
	const enabled = settings.agents.enabled,
		choice = settings.helperAgent;
	const catalogs = useProviderCatalogs(enabled);
	const plan = ghostModelPlan(
		choice,
		enabled,
		Object.fromEntries(
			agentProviders
				.filter((provider) => enabled[provider])
				.map((provider) => [provider, catalogs[provider]])
		)
	);
	const narrow = useNarrowWindow(NARROW);
	// The default without a Luna or Haiku entry is the provider's own model: the one its catalog has chosen.
	const defaultModel =
		plan.target?.model ??
		(plan.target && catalogs[plan.target.provider]
			? selectOption(catalogs[plan.target.provider]!.options, 'model')?.value
			: undefined);
	const shown = choice
		? { provider: choice.provider, model: choice.model }
		: plan.target && defaultModel
			? { provider: plan.target.provider, model: defaultModel }
			: null;
	// The effort levels of the shown model, lowest first; none chosen is the lowest.
	const efforts = shown ? helperEfforts(catalogs[shown.provider], shown.model) : [],
		effort = efforts.find((item) => item.value === choice?.effort) ?? efforts[0];
	const fallbackName = plan.target?.name ?? ghostDefaults[0]!.name;
	const providerOff = (provider: AgentProviderId) =>
		t(locale, '{provider} is off. Helper jobs are unavailable.').replace(
			'{provider}',
			providerName[provider]
		);
	const warning =
		plan.issue === 'provider-off'
			? plan.target
				? t(locale, '{provider} is off. The helper uses {model}.')
						.replace('{model}', fallbackName)
						.replace('{provider}', providerName[choice!.provider])
				: providerOff(choice!.provider)
			: plan.issue === 'model-gone'
				? plan.target
					? t(locale, 'Model “{model}” is unavailable in {provider}. The helper uses {default}.')
							.replace('{default}', fallbackName)
							.replace('{model}', choice!.name ?? choice!.model)
							.replace('{provider}', providerName[choice!.provider])
					: providerOff(ghostDefaults[0]!.provider)
				: !plan.target
					? providerOff(ghostDefaults[0]!.provider)
					: null;
	const catalogName = (provider: AgentProviderId, model: string) => {
		const own = catalogs[provider];
		return (own ? selectOption(own.options, 'model') : undefined)?.choices.find(
			(item) => item.value === model
		)?.name;
	};
	const modelName = shown
		? (catalogName(shown.provider, shown.model) ?? choice?.name ?? choice?.model ?? fallbackName)
		: fallbackName;
	const models: CapsuleModels = {
		groups: agentProviders
			.filter((provider) => enabled[provider])
			.map((provider) => {
				const own = catalogs[provider],
					model = own ? selectOption(own.options, 'model') : undefined;
				return {
					provider,
					name: providerName[provider],
					choices:
						own === undefined
							? null
							: (model?.choices ?? [])
									.filter((item) => item.value !== 'default')
									.map((item) => ({
										value: item.value,
										name: item.name,
										description: item.description,
									})),
					task: null,
					limit: null,
				};
			}),
		provider: shown?.provider ?? ghostDefaults[0]!.provider,
		value: shown?.model ?? '',
		label: modelDisplayName(modelName, shown?.provider ?? ghostDefaults[0]!.provider),
		note: '',
		title: t(locale, 'Helper agent'),
		side: 'bottom',
		narrow,
		onChoose: (provider, model) => {
			const levels = helperEfforts(catalogs[provider as AgentProviderId], model);
			update({
				helperAgent: {
					provider: provider as AgentProviderId,
					model,
					name: catalogName(provider as AgentProviderId, model) ?? null,
					// The effort carries over when the new model has it; otherwise the lowest.
					effort: levels.some((item) => item.value === choice?.effort)
						? (choice?.effort ?? null)
						: null,
				},
			});
		},
		...(shown && efforts.length
			? {
					effort: {
						choices: efforts,
						value: effort?.value ?? efforts[0]!.value,
						onChoose: (value: string) =>
							update({
								helperAgent: {
									provider: shown.provider,
									model: shown.model,
									name: modelName,
									effort: value,
								},
							}),
					},
				}
			: {}),
	};
	return (
		<SettingsRow
			label={t(locale, 'Helper agent')}
			wide
			warning={Boolean(warning)}
			hint={
				warning ??
				t(
					locale,
					'Short one-off jobs: PR summaries, commit and PR texts, branch names, prompt suggestions. Change it for one run where you start it.'
				)
			}>
			<span data-helper-agent>
				{/* A save in flight is a pending command, not a lock: the menu stays open on a choice (spec/settings-modules-and-onboarding#module-settings-popup). */}
				<ComposerOptions
					provider={models.provider}
					locale={locale}
					disabled={busy}
					locked={false}
					models={models}
				/>
			</span>
		</SettingsRow>
	);
}
