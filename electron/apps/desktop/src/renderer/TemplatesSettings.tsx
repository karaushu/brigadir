import { useEffect, useRef, useState } from 'react';
import {
	catalogOptions,
	selectOption,
	builtinAgentCustomized,
	builtinCrewTemplates,
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
import { MenuItem, MenuPopover, MenuSeparator } from './ui/Popover';
import { effortOptions } from './ui/EffortIcon';
import { optionChoices } from './ui/OptionIcon';
import styles from './TemplatesSettings.module.css';
import { SkeletonText } from './ui/Loading';
type Selection = { kind: 'agent' | 'crew'; id: string };
/** SettingsTemplates (spec/crew-templates-and-editor#template-library): master-detail library. Built-ins duplicate only; own templates edit in place and save on change. */
export function TemplatesSettings({ locale, busy: outerBusy }: { locale: Locale; busy: boolean }) {
	const [library, setLibrary] = useState<CrewLibrary | null>(null),
		[selected, setSelected] = useState<Selection | null>(null),
		[error, setError] = useState(''),
		[busy, setBusy] = useState(false),
		[editing, setEditing] = useState<CrewTemplate | null>(null),
		[adding, setAdding] = useState(false);
	const [catalogs, setCatalogs] = useState<Record<string, ProviderCatalog | null>>({});
	const createButton = useRef<HTMLButtonElement>(null),
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
	const list = (kind: 'agent' | 'crew', items: (AgentTemplate | CrewTemplate)[]) =>
		items.map((item) => {
			const active = selected?.kind === kind && selected.id === item.id;
			return (
				<button
					key={item.id}
					type="button"
					role="option"
					aria-selected={active}
					className={styles.item}
					data-active={active}
					onClick={() => setSelected({ kind, id: item.id })}>
					{kind === 'agent' ? (
						<Glyph
							name={
								(item as AgentTemplate).role === 'foreman'
									? 'helmet'
									: ((item as AgentTemplate).provider ?? defaultProvider) === 'codex'
										? 'openai'
										: 'claude'
							}
							size={13}
						/>
					) : null}
					<span>{crewLabel(locale, item.name)}</span>
					{!item.builtin && <Glyph name="edit" size={11} />}
					{kind === 'crew' && <small>{crewTemplateTail(locale, item as CrewTemplate)}</small>}
				</button>
			);
		});
	return (
		<div className={styles.root} data-templates>
			<div className={styles.list} role="listbox" aria-label={t(locale, 'Templates')}>
				<div className={styles.items} data-size="s">
					<div className={styles.groupTitle}>{t(locale, 'Agents')}</div>
					{library && list('agent', library.agents)}
					<div className={styles.groupTitle}>{t(locale, 'Crews')}</div>
					{library && list('crew', library.crews)}
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
							{/* spec/crew-templates-and-editor#roster: what the foreman reads about agents of this template; built-ins have none, their role says it. */}
							{agent.role !== 'foreman' && !agent.builtin && (
								<div className={styles.row} data-size="m">
									<span className={styles.label}>{t(locale, 'Specialty')}</span>
									<TextInput
										aria-label={t(locale, 'Specialty')}
										value={agent.summary ?? ''}
										maxLength={crewSummaryLimit}
										placeholder={t(locale, 'What the foreman reads about this agent. In English.')}
										onChange={(event) => {
											const { summary: _, ...rest } = agent;
											const summary = event.target.value.replace(/[\r\n]+/g, ' ');
											saveAgent(summary ? { ...rest, summary } : rest);
										}}
									/>
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
								</div>
							)}
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
							{crew.builtin && (
								<span className={styles.tag}>{t(locale, 'built-in · read only')}</span>
							)}
							<span className={styles.space} />
							<Button
								disabled={disabled}
								onClick={() => {
									void duplicate();
								}}>
								{t(locale, 'Duplicate')}
							</Button>
							{!crew.builtin && (
								<Button
									disabled={disabled || crewIssues(crew, templateLookup(library.agents)).length > 0}
									onClick={() => setEditing(crew)}>
									{t(locale, 'Edit…')}
								</Button>
							)}
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
						void run(() => window.brigadir.saveCrewTemplate({ ...template, builtin: false }));
					}}
					libraryChanged={setLibrary}
				/>
			)}
		</div>
	);
}
