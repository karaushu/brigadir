import { useState, type MouseEvent } from 'react';
import {
	agentProviders,
	changedActionCount,
	changedActions,
	crewLabel,
	helperActions,
	isCrewAction,
	helperEfforts,
	inheritsDefaultAgent,
	modelDisplayName,
	selectOption,
	slackAgentActions,
	t,
	taskActions,
	withActionAgent,
	withActionCrew,
	type ActionCrew,
	type AgentAction,
	type AgentProviderId,
	type AppSettings,
	type HelperAgent,
	type Locale,
	type ProviderCatalog,
} from '@brigadir/core';
import { ComposerOptions, type CapsuleModels } from './ComposerOptions';
import { actionNames, helperShown, useNarrowWindow, useProviderCatalogs } from './HelperAgent';
import { Button, Chevron } from './ui/Controls';
import styles from './ActionAgents.module.css';

type Catalogs = Partial<Record<AgentProviderId, ProviderCatalog | null>>;
const providerName: Record<AgentProviderId, string> = { claude: 'Claude', codex: 'Codex' };
/** spec/appearance#interface-font: below this window width Settings' labels are 110 px; a changed capsule shows its provider glyph alone. */
const NARROW = 560;

/** The model and effort a catalog runs by itself: the Default agent of a task (`Opus 5.5 · High`). */
function catalogDefault(catalog: ProviderCatalog | null | undefined, provider: AgentProviderId) {
	if (!catalog) return '';
	const model = selectOption(catalog.options, 'model'),
		name = model?.choices.find((choice) => choice.value === model.value)?.name,
		effort = selectOption((model && catalog.byModel?.[model.value]) || catalog.options, 'effort'),
		level = effort?.choices.find((choice) => choice.value === effort.value)?.name;
	return [name ? modelDisplayName(name, provider) : null, level].filter(Boolean).join(' · ');
}

/**
 * spec/appearance#evolution-redesign: `Customize per action ▸` under Default agent and Helper agent. Each action inherits —
 * tasks from the Default agent, one-off texts from the Helper agent — shown as the grey `Same as …` capsule; a changed one has
 * the composer's model · effort capsule (both catalogs) and `Reset` on the row's hover. Above the list: `N changed · Reset all`.
 */
export function ActionAgentsRows({
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
	const [open, setOpen] = useState(false);
	const enabled = settings.agents.enabled,
		catalogs = useProviderCatalogs(open ? enabled : null),
		narrow = useNarrowWindow(NARROW),
		// spec/pull-requests-and-ci#review-crew: an action that remembers a crew is changed too.
		changed = changedActions(settings.actionAgents).concat(
			taskActions.filter(
				(action) =>
					isCrewAction(action) && settings.actionCrews[action] && !settings.actionAgents[action]
			)
		);
	const save = (action: AgentAction, agent: HelperAgent | null) =>
		update({ actionAgents: withActionAgent(settings.actionAgents, action, agent) });
	const resetCrew = (action: AgentAction) =>
		isCrewAction(action) &&
		update({ actionCrews: withActionCrew(settings.actionCrews, action, null) });
	const helperDefault = helperShown(
		{
			choice: settings.helperAgent,
			enabled,
			defaultProvider: settings.agents.provider,
			actionAgents: {},
			actionCrews: {},
		},
		catalogs,
		null
	);
	const defaults = {
		task: catalogDefault(catalogs[settings.agents.provider], settings.agents.provider),
		helper: helperDefault
			? [helperDefault.modelName, helperDefault.effortName].filter(Boolean).join(' · ')
			: '',
	};
	const row = (action: AgentAction) => (
		<ActionRow
			key={action}
			action={action}
			locale={locale}
			busy={busy}
			narrow={narrow}
			catalogs={catalogs}
			enabled={enabled}
			agent={settings.actionAgents[action] ?? null}
			crew={(isCrewAction(action) && settings.actionCrews[action]) || null}
			resetCrew={() => resetCrew(action)}
			defaultName={inheritsDefaultAgent(action) ? defaults.task : defaults.helper}
			defaultProvider={
				inheritsDefaultAgent(action)
					? settings.agents.provider
					: (helperDefault?.provider ?? 'claude')
			}
			save={(agent) => save(action, agent)}
		/>
	);
	return (
		<>
			<div
				className={styles.disclosure}
				data-size="m"
				data-open={open || undefined}
				data-settings-row={t(locale, 'Customize per action')}>
				<button
					type="button"
					className={styles.toggle}
					aria-expanded={open}
					onClick={() => setOpen((value) => !value)}>
					<span>{t(locale, 'Customize per action')}</span>
					<span className={styles.chevron}>
						<Chevron />
					</span>
				</button>
				<span className={styles.space} />
				{changed.length > 0 && (
					<>
						<span className={styles.count}>{changedActionCount(locale, changed.length)}</span>
						{open && (
							<>
								<span className={styles.count} aria-hidden="true">
									·
								</span>
								<Button
									variant="ghost"
									disabled={busy}
									onClick={() => update({ actionAgents: {}, actionCrews: {} })}>
									{t(locale, 'Reset all')}
								</Button>
							</>
						)}
					</>
				)}
			</div>
			{open && (
				<>
					<div className={styles.heading}>{t(locale, 'Tasks')}</div>
					{taskActions.map(row)}
					<div className={styles.heading}>{t(locale, 'One-off texts')}</div>
					{helperActions.map(row)}
					{/* spec/notifications-slack-notes-and-schedules#slack: the @ mentions' answers and the agent of code questions. */}
					<div className={styles.heading}>{t(locale, 'Slack')}</div>
					{slackAgentActions.map(row)}
				</>
			)}
		</>
	);
}

function ActionRow({
	action,
	locale,
	busy,
	narrow,
	catalogs,
	enabled,
	agent,
	crew,
	resetCrew,
	defaultName,
	defaultProvider,
	save,
}: {
	action: AgentAction;
	locale: Locale;
	busy: boolean;
	narrow: boolean;
	catalogs: Catalogs;
	enabled: Record<AgentProviderId, boolean>;
	agent: HelperAgent | null;
	/** spec/pull-requests-and-ci#review-crew: the crew a review action remembers; it shows `Crew · <name>` and `Reset` instead of the capsule. */
	crew: ActionCrew | null;
	resetCrew(): void;
	defaultName: string;
	defaultProvider: AgentProviderId;
	save(agent: HelperAgent | null): void;
}) {
	const task = inheritsDefaultAgent(action),
		sameAs = t(locale, task ? 'Same as Default agent' : 'Same as Helper agent');
	const catalog = agent ? catalogs[agent.provider] : undefined,
		modelOption = catalog ? selectOption(catalog.options, 'model') : undefined,
		modelName =
			agent &&
			modelDisplayName(
				modelOption?.choices.find((choice) => choice.value === agent.model)?.name ??
					agent.name ??
					agent.model,
				agent.provider
			);
	// A task's effort null is the model's own level; a one-off text's — the lowest, as for the Helper agent.
	const efforts = agent ? helperEfforts(catalog, agent.model) : [],
		ownLevel = agent
			? selectOption(catalog?.byModel?.[agent.model] ?? catalog?.options ?? [], 'effort')?.value
			: undefined,
		effort =
			efforts.find((item) => item.value === agent?.effort) ??
			(task ? efforts.find((item) => item.value === ownLevel) : undefined) ??
			efforts[0];
	const choose = (provider: AgentProviderId, value: string) => {
		const levels = helperEfforts(catalogs[provider], value),
			name =
				(catalogs[provider]
					? selectOption(catalogs[provider]!.options, 'model')
					: undefined
				)?.choices.find((choice) => choice.value === value)?.name ?? null;
		save({
			provider,
			model: value,
			name,
			// The effort carries over when the new model has it; otherwise the model's own (a task) or the lowest.
			effort: levels.some((item) => item.value === agent?.effort) ? (agent?.effort ?? null) : null,
		});
	};
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
									.filter((choice) => choice.value !== 'default')
									.map((choice) => ({
										value: choice.value,
										name: choice.name,
										description: choice.description,
									})),
					task: null,
					limit: null,
				};
			}),
		provider: agent?.provider ?? defaultProvider,
		value: agent?.model ?? '',
		label: modelName ?? sameAs,
		note: '',
		title: t(locale, actionNames[action]),
		side: 'bottom',
		narrow: narrow && Boolean(agent),
		inherit: { label: sameAs, detail: defaultName, active: !agent, onChoose: () => save(null) },
		onChoose: choose,
		...(agent && efforts.length
			? {
					effort: {
						choices: efforts,
						value: effort?.value ?? efforts[0]!.value,
						onChoose: (value: string) => save({ ...agent, effort: value }),
					},
				}
			: {}),
	};
	if (crew && !agent)
		return (
			<div className={styles.action} data-size="m" data-action={action} data-changed data-crew>
				<span className={styles.name}>
					<span>{t(locale, actionNames[action])}</span>
				</span>
				<Button
					variant="ghost"
					className={styles.reset}
					disabled={busy}
					aria-label={`${t(locale, 'Reset')} · ${t(locale, actionNames[action])}`}
					onClick={resetCrew}>
					{t(locale, 'Reset')}
				</Button>
				<span className={styles.crew}>
					{t(locale, 'Crew')} · {crewLabel(locale, crew.name)}
				</span>
			</div>
		);
	// Rule 15: the whole row is the target — a click on its empty part opens the capsule's menu.
	const openCapsule = (event: MouseEvent<HTMLDivElement>) => {
		if ((event.target as HTMLElement).closest('button, a, input, [role="dialog"]')) return;
		[
			...event.currentTarget.querySelectorAll<HTMLButtonElement>(
				'[data-option-kind="model"] > button, [data-agent-compact]'
			),
		]
			.find((button) => button.offsetParent !== null)
			?.click();
	};
	return (
		<div
			className={styles.action}
			data-size="m"
			data-action={action}
			data-changed={agent ? true : undefined}
			onClick={openCapsule}>
			<span className={styles.name}>
				<span>{t(locale, actionNames[action])}</span>
				{action === 'reviewDrafts' && <small>{t(locale, 'And the verdict hint')}</small>}
				{action === 'slackCode' && <small>{t(locale, 'And questions about a task')}</small>}
			</span>
			{agent && (
				<Button
					variant="ghost"
					className={styles.reset}
					disabled={busy}
					aria-label={`${t(locale, 'Reset')} · ${t(locale, actionNames[action])}`}
					onClick={() => save(null)}>
					{t(locale, 'Reset')}
				</Button>
			)}
			{/* A save in flight is a pending command, not a lock: the menu stays open on a choice (spec/settings-modules-and-onboarding#module-settings-popup). */}
			<ComposerOptions
				provider={models.provider}
				locale={locale}
				disabled={busy}
				locked={false}
				models={models}
			/>
		</div>
	);
}
