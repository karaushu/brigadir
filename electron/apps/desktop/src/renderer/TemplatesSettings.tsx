import { useEffect, useRef, useState } from 'react';
import {
	catalogOptions,
	selectOption,
	builtinAgentCustomized,
	designerTemplateId,
	developerTemplateId,
	effortRank,
	foremanTemplateId,
	reviewerTemplateId,
	roleModelPick,
	securityReviewerTemplateId,
	seniorDeveloperTemplateId,
	technicalWriterTemplateId,
	testerTemplateId,
	templateFit,
	builtinCrewTemplates,
	builtinCrewCustomized,
	crewSummaryLimit,
	crewAgents,
	crewDepth,
	crewIssues,
	duplicateCrewTemplate,
	templateLookup,
	t,
	type AgentProvider,
	type AgentTemplate,
	type CrewLibrary,
	type CrewTemplate,
	type Locale,
	type MessageKey,
	type ProviderCatalog,
} from '@brigadir/core';
import { crewLabel, crewTemplateTail } from './Crew';
import { CrewEditor } from './CrewEditor';
import { Button, IconButton, Popup, Segments, Switch } from './ui/Controls';
import { TextArea, TextInput } from './ui/Input';
import { Glyph } from './ui/Glyph';
import { LevelDots } from './ui/LevelDots';
import { OptionCard } from './ui/OptionCard';
import { MenuItem, MenuPopover, MenuSeparator } from './ui/Popover';
import { effortOptions } from './ui/EffortIcon';
import { optionChoices } from './ui/OptionIcon';
import { templateWork } from './template-work';
import styles from './TemplatesSettings.module.css';
import { SkeletonText } from './ui/Loading';
type Selection = { kind: 'agent' | 'crew'; id: string };
/** SettingsTemplates (spec/crew-templates-and-editor#template-library): master-detail library. Built-ins duplicate only; own templates edit in place and save on change. */
/** spec/crew-templates-and-editor#agent-cards: the role guide — the app's advice for each built-in role (spec/crew#model-ladder), no model named (rule 7). */
const roleGuide: readonly {
	id: string;
	name: string;
	glyph:
		'helmet' | 'code' | 'review' | 'check-pass' | 'note' | 'settings-appearance' | 'scope-lock';
	strength: number;
	hint: MessageKey;
}[] = [
	{
		id: foremanTemplateId,
		name: 'Foreman',
		glyph: 'helmet',
		strength: 3,
		hint: 'Strongest model · Medium',
	},
	{
		id: developerTemplateId,
		name: 'Developer',
		glyph: 'code',
		strength: 1,
		hint: 'Faster model · Medium',
	},
	{
		id: seniorDeveloperTemplateId,
		name: 'Senior developer',
		glyph: 'code',
		strength: 2,
		hint: 'Strong model · High',
	},
	{
		id: reviewerTemplateId,
		name: 'Reviewer',
		glyph: 'review',
		strength: 2,
		hint: "Author's model or stronger",
	},
	{
		id: testerTemplateId,
		name: 'Tester',
		glyph: 'check-pass',
		strength: 1,
		hint: 'Faster model · Medium',
	},
	{
		id: technicalWriterTemplateId,
		name: 'Technical writer',
		glyph: 'note',
		strength: 1,
		hint: 'Faster model · Medium',
	},
	{
		id: designerTemplateId,
		name: 'Designer',
		glyph: 'settings-appearance',
		strength: 2,
		hint: "Author's model or stronger",
	},
	{
		id: securityReviewerTemplateId,
		name: 'Security reviewer',
		glyph: 'scope-lock',
		strength: 2,
		hint: 'Strong model · High',
	},
];
/** spec/crew-templates-and-editor#library-list: the provider glyph and the catalog name of the model for a role; nothing for a provider that is off or has no such model. */
function RolePicks({
	id,
	enabled,
	catalogs,
}: {
	id: string;
	enabled: Record<'claude' | 'codex', boolean>;
	catalogs: Record<string, ProviderCatalog | null>;
}) {
	const picks = (['claude', 'codex'] as const).flatMap((provider) => {
		const name = enabled[provider] ? roleModelPick(id, provider, catalogs[provider]) : null;
		return name ? [{ provider, name }] : [];
	});
	if (!picks.length) return null;
	return (
		<span className={styles.picks} data-role-picks>
			{picks.map((pick) => (
				<span key={pick.provider}>
					<Glyph name={pick.provider === 'codex' ? 'openai' : 'claude'} size={11} />
					{pick.name}
				</span>
			))}
		</span>
	);
}
const fits: readonly { fit: 'scoped' | 'hard' | 'lead'; label: MessageKey }[] = [
	{ fit: 'scoped', label: 'Clear parts' },
	{ fit: 'hard', label: 'Hard parts' },
	{ fit: 'lead', label: 'Leading and checking' },
];
export function TemplatesSettings({ locale, busy: outerBusy }: { locale: Locale; busy: boolean }) {
	const [library, setLibrary] = useState<CrewLibrary | null>(null),
		[selected, setSelected] = useState<Selection | null>(null),
		[error, setError] = useState(''),
		[busy, setBusy] = useState(false),
		[editing, setEditing] = useState<CrewTemplate | null>(null),
		[adding, setAdding] = useState(false);
	const [catalogs, setCatalogs] = useState<Record<string, ProviderCatalog | null>>({});
	const createButton = useRef<HTMLButtonElement>(null),
		listItems = useRef<HTMLDivElement>(null),
		mounted = useRef(true),
		saveTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
	// spec/settings-modules-and-onboarding#settings-keys: a provider turned off in Settings ▸ Agents is not offered for a template; a template that has it keeps it.
	const [enabledProviders, setEnabledProviders] = useState<Record<'claude' | 'codex', boolean>>({
		claude: true,
		codex: true,
	});
	// A template without a provider launches with the Default agent (crew.ts `context.defaultProvider`): the form shows it.
	const [defaultProvider, setDefaultProvider] = useState<AgentProvider>('claude');
	useEffect(() => {
		void window.brigadir
			.readSettings()
			.then(({ settings }) => {
				setEnabledProviders(settings.agents.enabled);
				setDefaultProvider(settings.agents.provider);
			})
			.catch(() => {});
	}, []);
	useEffect(() => {
		mounted.current = true;
		void window.brigadir.readTemplates().then(
			(value) => {
				if (mounted.current) {
					setLibrary(value);
					setSelected((current) => current ?? { kind: 'agent', id: value.agents[0]!.id });
				}
			},
			() => {
				if (mounted.current) setError(t(locale, 'The settings could not be loaded.'));
			}
		);
		for (const p of ['claude', 'codex'] as const)
			void window.brigadir.readProviderCatalog(p).then(
				(catalog) => {
					if (mounted.current) setCatalogs((current) => ({ ...current, [p]: catalog }));
				},
				() => {}
			);
		return () => {
			mounted.current = false;
		};
	}, []);
	const agent =
			selected?.kind === 'agent'
				? library?.agents.find((item) => item.id === selected.id)
				: undefined,
		crew =
			selected?.kind === 'crew'
				? library?.crews.find((item) => item.id === selected.id)
				: undefined;
	// spec/notifications-slack-notes-and-schedules#message-classes: Settings is modal, so a failure stays a line here; it names the action.
	async function run(
		work: () => Promise<CrewLibrary | null>,
		failure: MessageKey = 'The template could not be saved.'
	) {
		setBusy(true);
		setError('');
		try {
			const next = await work();
			if (next && mounted.current) setLibrary(next);
			return next;
		} catch {
			if (mounted.current) setError(t(locale, failure));
			return null;
		} finally {
			if (mounted.current) setBusy(false);
		}
	}
	function saveAgent(next: AgentTemplate) {
		setLibrary((current) =>
			current
				? { ...current, agents: current.agents.map((item) => (item.id === next.id ? next : item)) }
				: current
		);
		if (saveTimer.current) clearTimeout(saveTimer.current);
		saveTimer.current = setTimeout(() => {
			// An autosave is quiet: no busy state, so the focused field stays enabled and focused, and the reply keeps edits typed since.
			void window.brigadir.saveAgentTemplate(next).then(
				(saved) => {
					if (mounted.current)
						setLibrary((current) =>
							current
								? {
										...saved,
										agents: saved.agents.map(
											(item) => current.agents.find((own) => own.id === item.id) ?? item
										),
									}
								: saved
						);
				},
				() => {
					if (mounted.current) setError(t(locale, 'The template could not be saved.'));
				}
			);
		}, 300);
	}
	async function create(kind: 'agent' | 'crew') {
		setAdding(false);
		const id = crypto.randomUUID();
		if (kind === 'agent') {
			const item: AgentTemplate = {
				id,
				name: t(locale, 'New agent'),
				role: 'developer',
				instructions: '',
				builtin: false,
			};
			const next = await run(
				() => window.brigadir.saveAgentTemplate(item),
				'Could not create the template.'
			);
			if (next) setSelected({ kind: 'agent', id });
			return;
		}
		const item: CrewTemplate = {
			...structuredClone(builtinCrewTemplates[0]!),
			id,
			name: t(locale, 'New crew'),
			builtin: false,
		};
		const next = await run(
			() => window.brigadir.saveCrewTemplate(item),
			'Could not create the template.'
		);
		if (next) setSelected({ kind: 'crew', id });
	}
	async function duplicate() {
		if (agent) {
			const copy: AgentTemplate = {
				...agent,
				id: crypto.randomUUID(),
				name: `${crewLabel(locale, agent.name)} 2`,
				builtin: false,
			};
			const next = await run(
				() => window.brigadir.saveAgentTemplate(copy),
				'Could not duplicate the template.'
			);
			if (next) setSelected({ kind: 'agent', id: copy.id });
		}
		if (crew) {
			const copy = duplicateCrewTemplate(
				crew,
				crypto.randomUUID(),
				`${crewLabel(locale, crew.name)} 2`
			);
			const next = await run(
				() => window.brigadir.saveCrewTemplate(copy),
				'Could not duplicate the template.'
			);
			if (next) setSelected({ kind: 'crew', id: copy.id });
		}
	}
	async function remove() {
		// spec/pull-requests-and-ci#review-crew: a built-in crew is hidden and comes back from `+ ▾`; built-in agents only duplicate.
		if (!selected || agent?.builtin) return;
		const next = await run(
			() => window.brigadir.deleteTemplate(selected.kind, selected.id),
			'Could not delete the template.'
		);
		if (next) setSelected({ kind: 'agent', id: next.agents[0]!.id });
	}
	const disabled = busy || outerBusy;
	const provider = agent?.provider ?? defaultProvider;
	const catalog = agent ? (catalogs[provider] ?? null) : null;
	// spec/agents-and-providers#catalog: effort levels belong to the template's model.
	const option = (kind: 'model' | 'effort' | 'mode') => {
		const model = selectOption(catalog?.options ?? [], 'model');
		return selectOption(
			kind === 'model'
				? (catalog?.options ?? [])
				: catalogOptions(catalog, model ? agent?.choices?.configOptions?.[model.id] : undefined),
			kind
		);
	};
	const setChoice = (key: string, value: string) => {
		if (!agent) return;
		const item =
			option('model')?.id === key
				? option('model')
				: option('effort')?.id === key
					? option('effort')
					: option('mode');
		const name = item?.choices.find((choice) => choice.value === value)?.name;
		const configOptions = { ...agent.choices?.configOptions, [key]: value },
			choiceNames = { ...agent.choiceNames, ...(name ? { [key]: name } : {}) };
		// spec/agents-and-providers#catalog: a new model drops an effort it does not have.
		const effort = option('effort');
		if (
			key === option('model')?.id &&
			effort &&
			configOptions[effort.id] !== undefined &&
			!selectOption(catalogOptions(catalog, value), 'effort')?.choices.some(
				(choice) => choice.value === configOptions[effort.id]
			)
		) {
			delete configOptions[effort.id];
			delete choiceNames[effort.id];
		}
		saveAgent({ ...agent, choices: { ...agent.choices, configOptions }, choiceNames });
	};
	// spec/agents-and-providers#catalog: a built-in role keeps the person's provider, model and effort; `Reset` returns the provider defaults.
	const customized = Boolean(agent && builtinAgentCustomized(agent));
	// spec/crew-templates-and-editor#library-list: the chosen effort among the model's levels, and the work the template fits.
	const effort = option('effort'),
		rank = effort ? effortRank(effort.choices, agent?.choices?.configOptions?.[effort.id]) : null,
		pastHigh = Boolean(rank && rank.high >= 0 && rank.index > rank.high),
		fit = agent ? templateFit(agent.role, rank) : null;
	const reset = () => {
		if (!agent) return;
		const { provider: _provider, choices: _choices, choiceNames: _names, ...base } = agent;
		saveAgent(base);
	};
	const exportSelected = () => {
		if (selected)
			void window.brigadir
				.exportTemplate(selected.kind, selected.id)
				.catch(() => setError(t(locale, 'Could not export the template.')));
	};
	// A template chosen from elsewhere (a new one, a duplicate, an import) comes into view in the list.
	useEffect(() => {
		listItems.current
			?.querySelector('[data-checked], [data-active="true"]')
			?.scrollIntoView({ block: 'nearest' });
	}, [selected?.kind, selected?.id, library?.agents.length, library?.crews.length]);
	const crewRows = (items: CrewTemplate[]) =>
		items.map((item) => {
			const active = selected?.kind === 'crew' && selected.id === item.id;
			return (
				<button
					key={item.id}
					type="button"
					role="option"
					aria-selected={active}
					className={styles.item}
					data-active={active}
					onClick={() => setSelected({ kind: 'crew', id: item.id })}>
					<span>{crewLabel(locale, item.name)}</span>
					{!item.builtin && <Glyph name="edit" size={11} />}
					<small>{crewTemplateTail(locale, item)}</small>
				</button>
			);
		});
	// spec/crew-templates-and-editor#agent-cards: a built-in card is the role guide; an own one shows its specialty and the model it names.
	const agentCards = (items: AgentTemplate[]) =>
		items.map((item) => {
			const guide = item.builtin ? roleGuide.find((role) => role.id === item.id) : undefined,
				names = Object.values(item.choiceNames ?? {});
			return (
				<OptionCard
					key={item.id}
					name="agent-template"
					radio={false}
					checked={selected?.kind === 'agent' && selected.id === item.id}
					disabled={disabled}
					glyph={
						guide?.glyph ??
						(item.role === 'foreman' ? 'helmet' : item.role === 'reviewer' ? 'review' : 'code')
					}
					title={crewLabel(locale, item.name)}
					{...(item.builtin ? {} : { mark: <Glyph name="edit" size={11} /> })}
					description={templateWork(locale, item)}
					onChange={() => setSelected({ kind: 'agent', id: item.id })}>
					{guide ? (
						<>
							<LevelDots count={3} filled={guide.strength} label={t(locale, guide.hint)} />
							{t(locale, guide.hint)}
							{/* The model each enabled provider has for this work, by its catalog name. */}
							<RolePicks id={item.id} enabled={enabledProviders} catalogs={catalogs} />
						</>
					) : (
						<span className={styles.picks} data-role-picks>
							<span>
								<Glyph
									name={(item.provider ?? defaultProvider) === 'codex' ? 'openai' : 'claude'}
									size={11}
								/>
								{names.length ? names.join(' · ') : t(locale, 'Default model')}
							</span>
						</span>
					)}
				</OptionCard>
			);
		});
	return (
		<div className={styles.root} data-templates>
			<div className={styles.list}>
				<div ref={listItems} className={styles.items}>
					<div className={styles.groupTitle}>{t(locale, 'Agents')}</div>
					<div className={styles.cards} role="radiogroup" aria-label={t(locale, 'Agents')}>
						{library && agentCards(library.agents)}
					</div>
					<div className={styles.groupTitle}>{t(locale, 'Crews')}</div>
					<div className={styles.rows} role="listbox" aria-label={t(locale, 'Crews')} data-size="s">
						{library && crewRows(library.crews)}
					</div>
				</div>
				<div className={styles.listFooter} data-size="s">
					<span className={styles.addWrap}>
						<IconButton
							ref={createButton}
							size="s"
							shape="auto"
							variant="soft"
							label={t(locale, 'Create')}
							aria-haspopup="menu"
							aria-expanded={adding}
							disabled={disabled}
							onClick={() => setAdding((value) => !value)}>
							<Glyph name="plus" size={11} />
							<Glyph name="sidebar-chevron" size={8} />
						</IconButton>
						<MenuPopover
							open={adding}
							onClose={() => setAdding(false)}
							anchor={createButton}
							side="top"
							size="s"
							label={t(locale, 'Create')}
							locale={locale}>
							<MenuItem
								onSelect={() => {
									void create('agent');
								}}>
								{t(locale, 'New agent')}
							</MenuItem>
							<MenuItem
								onSelect={() => {
									void create('crew');
								}}>
								{t(locale, 'New crew')}
							</MenuItem>
							<MenuSeparator />
							<MenuItem
								onSelect={() => {
									void run(
										() => window.brigadir.importTemplate(),
										'Could not import the template.'
									);
								}}>
								{t(locale, 'Import…')}
							</MenuItem>
							{library?.hiddenCrews.length ? (
								<>
									<MenuSeparator />
									<MenuItem
										onSelect={() => {
											void run(
												() => window.brigadir.restoreCrewTemplates(),
												'Could not restore the default crews.'
											);
										}}>
										{t(locale, 'Restore default crews')}
									</MenuItem>
								</>
							) : null}
						</MenuPopover>
					</span>
					<IconButton
						size="s"
						variant="soft"
						label={t(locale, 'Delete')}
						disabled={disabled || !selected || Boolean(agent?.builtin)}
						onClick={() => {
							void remove();
						}}>
						−
					</IconButton>
				</div>
			</div>
			<div className={styles.detail}>
				{!library && !error && <SkeletonText lines={6} />}
				{agent && (
					<>
						<div className={styles.head}>
							<Glyph
								name={
									agent.role === 'foreman' ? 'helmet' : provider === 'codex' ? 'openai' : 'claude'
								}
								size={16}
							/>
							<strong>{crewLabel(locale, agent.name)}</strong>
							{agent.builtin && <span className={styles.tag}>{t(locale, 'built-in')}</span>}
							<span className={styles.space} />
							{customized && (
								<Button disabled={disabled} onClick={reset}>
									{t(locale, 'Reset')}
								</Button>
							)}
							<Button
								disabled={disabled}
								onClick={() => {
									void duplicate();
								}}>
								{t(locale, 'Duplicate')}
							</Button>
							<Button disabled={disabled} onClick={exportSelected}>
								{t(locale, 'Export…')}
							</Button>
						</div>
						<fieldset className={styles.group} disabled={disabled}>
							<div className={styles.row} data-size="m">
								<span className={styles.label}>{t(locale, 'Name')}</span>
								<TextInput
									aria-label={t(locale, 'Name')}
									disabled={agent.builtin}
									value={crewLabel(locale, agent.name)}
									maxLength={80}
									onChange={(event) =>
										saveAgent({ ...agent, name: event.target.value || agent.name })
									}
								/>
							</div>
							{/* spec/crew-templates-and-editor#roster: what the foreman reads about agents of this template; a built-in's is the app's, shown as text. */}
							{agent.role !== 'foreman' && (!agent.builtin || agent.summary) && (
								<div className={styles.row} data-size="m">
									<span className={styles.label}>{t(locale, 'Specialty')}</span>
									{agent.builtin ? (
										// The app's line reads in full: text, not a field cut at its width.
										<span className={styles.value}>{agent.summary}</span>
									) : (
										<TextInput
											aria-label={t(locale, 'Specialty')}
											value={agent.summary ?? ''}
											maxLength={crewSummaryLimit}
											placeholder={t(
												locale,
												'What the foreman reads about this agent. In English.'
											)}
											onChange={(event) => {
												const { summary: _, ...rest } = agent;
												const summary = event.target.value.replace(/[\r\n]+/g, ' ');
												saveAgent(summary ? { ...rest, summary } : rest);
											}}
										/>
									)}
								</div>
							)}
							<div className={styles.row} data-size="m">
								<span className={styles.label}>{t(locale, 'Provider')}</span>
								<Segments
									label={t(locale, 'Provider')}
									value={provider}
									options={[
										{
											value: 'claude',
											label: 'Claude',
											icon: <Glyph name="claude" size={12} />,
											disabled: !enabledProviders.claude && provider !== 'claude',
										},
										{
											value: 'codex',
											label: 'Codex',
											icon: <Glyph name="openai" size={12} />,
											disabled: !enabledProviders.codex && provider !== 'codex',
										},
									]}
									onChange={(value) =>
										saveAgent({
											...agent,
											provider: value as AgentProvider,
											choices: {},
											choiceNames: {},
										})
									}
								/>
							</div>
							<div className={styles.row} data-size="m">
								<span className={styles.label}>{t(locale, 'Model')}</span>
								{option('model') ? (
									<>
										<Popup
											label={t(locale, 'Model')}
											value={String(agent.choices?.configOptions?.[option('model')!.id] ?? '')}
											displayValue={
												agent.choiceNames?.[option('model')!.id] ?? t(locale, 'from the catalog')
											}
											options={option('model')!.choices.map((choice) => ({
												value: choice.value,
												label: choice.name,
											}))}
											onChange={(value) => setChoice(option('model')!.id, value)}
										/>
										<small className={styles.cap}>{t(locale, 'from the catalog')}</small>
									</>
								) : (
									<small className={styles.dim}>
										{Object.values(agent.choiceNames ?? {})[0] ??
											t(locale, 'the catalog appears after the first launch')}
									</small>
								)}
							</div>
							{option('effort') && (
								<div className={styles.row} data-size="m">
									<span className={styles.label}>{t(locale, 'Effort')}</span>
									<Popup
										label={t(locale, 'Effort')}
										value={String(agent.choices?.configOptions?.[option('effort')!.id] ?? '')}
										displayValue={agent.choiceNames?.[option('effort')!.id] ?? '—'}
										options={effortOptions(option('effort')!.choices)}
										onChange={(value) => setChoice(option('effort')!.id, value)}
									/>
									{rank && rank.index >= 0 && (
										<LevelDots
											count={rank.count}
											filled={rank.index + 1}
											{...(rank.high >= 0 ? { warnFrom: rank.high + 1 } : {})}
											label={agent.choiceNames?.[option('effort')!.id] ?? ''}
										/>
									)}
								</div>
							)}
							{pastHigh && (
								<div className={styles.row} data-size="m">
									<span className={styles.label} />
									<small className={styles.warn}>
										{t(locale, 'An effort above High costs about as much as a stronger model.')}
									</small>
								</div>
							)}
							<div className={styles.row} data-size="m">
								<span className={styles.label}>{t(locale, 'Best for')}</span>
								<span className={styles.fits}>
									{fits.map((item) => (
										<span key={item.fit} data-fit={item.fit === fit || undefined}>
											{t(locale, item.label)}
										</span>
									))}
								</span>
							</div>
							{option('mode') && (
								<div className={styles.row} data-size="m">
									<span className={styles.label}>{t(locale, 'Mode')}</span>
									<Popup
										label={t(locale, 'Mode')}
										disabled={agent.builtin}
										value={String(agent.choices?.configOptions?.[option('mode')!.id] ?? '')}
										displayValue={
											agent.choiceNames?.[option('mode')!.id] ?? t(locale, 'from the catalog')
										}
										options={optionChoices('mode', option('mode')!.choices)}
										onChange={(value) => setChoice(option('mode')!.id, value)}
									/>
								</div>
							)}
						</fieldset>
						{agent.role !== 'foreman' && (
							<fieldset
								className={styles.group}
								disabled={disabled || agent.builtin}
								data-read-only={agent.builtin || undefined}>
								<div className={styles.row} data-size="m">
									<span className={styles.label}>{t(locale, 'Rights')}</span>
									<Switch
										label={t(locale, 'Checker')}
										checked={agent.role === 'reviewer'}
										disabled={disabled || agent.builtin}
										onChange={(value) =>
											saveAgent({ ...agent, role: value ? 'reviewer' : 'developer' })
										}
									/>
									<div className={styles.rights}>
										<span>{t(locale, 'Checker')}</span>
										<small>
											{t(
												locale,
												'writes no code · read_report · read_diff · submit_review · approve on the agents it checks'
											)}
										</small>
									</div>
								</div>
							</fieldset>
						)}
						<fieldset className={`${styles.group} ${styles.instructionsGroup}`} disabled={disabled}>
							<div className={styles.row} data-size="m">
								<span className={styles.label}>{t(locale, 'Instructions')}</span>
								<small className={styles.cap}>
									{t(locale, 'in English: who you are, not what to do')}
								</small>
							</div>
							{/* A built-in's role reads in full (and copies): read-only, not a dimmed disabled field. */}
							<TextArea
								aria-label={t(locale, 'Instructions')}
								className={styles.instructions}
								readOnly={agent.builtin}
								value={agent.instructions}
								onChange={(event) => saveAgent({ ...agent, instructions: event.target.value })}
							/>
						</fieldset>
					</>
				)}
				{crew && library && (
					<>
						<div className={styles.head}>
							<strong>{crewLabel(locale, crew.name)}</strong>
							{crew.builtin && <span className={styles.tag}>{t(locale, 'built-in')}</span>}
							<span className={styles.space} />
							{/* spec/crew-templates-and-editor#builtin-templates: an edited built-in crew goes back to the app's tree. */}
							{builtinCrewCustomized(crew) && (
								<Button
									disabled={disabled}
									onClick={() => {
										const base = builtinCrewTemplates.find((item) => item.id === crew.id);
										if (base) void run(() => window.brigadir.saveCrewTemplate(base));
									}}>
									{t(locale, 'Reset')}
								</Button>
							)}
							<Button
								disabled={disabled}
								onClick={() => {
									void duplicate();
								}}>
								{t(locale, 'Duplicate')}
							</Button>
							<Button
								disabled={disabled || crewIssues(crew, templateLookup(library.agents)).length > 0}
								onClick={() => setEditing(crew)}>
								{t(locale, 'Edit…')}
							</Button>
							<Button disabled={disabled} onClick={exportSelected}>
								{t(locale, 'Export…')}
							</Button>
						</div>
						<div className={styles.group}>
							<div className={styles.row} data-size="m">
								<span className={styles.label}>{t(locale, 'Agents')}</span>
								<span className={styles.value}>
									{crewAgents(crew.root)
										.slice(1)
										.map((item) => crewLabel(locale, item.name))
										.join(', ')}
								</span>
							</div>
							<div className={styles.row} data-size="m">
								<span className={styles.label}>
									{t(locale, 'Levels: {n}').replace(': {n}', '')}
								</span>
								<span className={styles.value}>{crewDepth(crew.root)}</span>
							</div>
						</div>
					</>
				)}
				{error && (
					<p className={styles.error} role="alert">
						{error}
					</p>
				)}
			</div>
			{editing && library && (
				<CrewEditor
					key={editing.id}
					template={editing}
					library={library}
					locale={locale}
					oneOff={false}
					close={() => setEditing(null)}
					done={(template) => {
						setEditing(null);
						// A built-in crew is saved as its edit; `Save as crew template` inside the editor has already made a copy its own.
						void run(() => window.brigadir.saveCrewTemplate(template));
					}}
					libraryChanged={setLibrary}
				/>
			)}
		</div>
	);
}
