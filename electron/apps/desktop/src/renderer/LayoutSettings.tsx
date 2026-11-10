import { TypographySettings } from './TypographySettings';
import { NotificationSettings } from './NotificationSettings';
import { EditorSettings } from './EditorSettings';
import { TemplatesSettings } from './TemplatesSettings';
import { KeymapDialog } from './KeymapEditor';
import { AgentStatus } from './AgentStatus';
import { ModuleList } from './ModuleList';
import { useEnvironment } from './use-environment';
import { useEffect, useId, useRef, useState } from 'react';
import {
	settingLocation,
	agentProviders,
	archiveAfterDayOptions,
	maxConcurrentLimit,
	t,
	type ArchiveAfterDays,
	type AppSettings,
	type Locale,
	type SettingsSnapshot,
} from '@brigadir/core';
import { useSurfaceLayout } from './surface-layout';
import { Button, Choice, Popup, PopupMarks, Segments, Stepper, Switch } from './ui/Controls';
import { HelperAgentRow } from './HelperAgentRow';
import { SubagentModelRow } from './SubagentModelRow';
import { ActionAgentsRows } from './ActionAgents';
import { CliUpdatesRow } from './CliUpdatesRow';
import { AppUpdateRow } from './AppUpdates';
import { KeepAwakeRow } from './KeepAwakeRow';
import { Glyph } from './ui/Glyph';
import { PopupClose } from './ui/PopupClose';
import { useKeepFocusWhileBusy } from './ui/keep-focus';
import {
	ModuleSettingsDialog,
	modulesWithSettings,
	type ModuleSettingsTarget,
} from './ModuleSettings';
import { AccentPicker } from './ui/AccentPicker';
import { SettingsOption, SettingsRow, SettingsSection } from './SettingsForm';
import { type RemoteDialog, type RemotePart } from './RemoteSettings';
import styles from './LayoutSettings.module.css';
import { SkeletonRows } from './ui/Loading';
const sections = [
	'appearance',
	'editor',
	'language',
	'notifications',
	'agents',
	'templates',
	'modules',
] as const;
type Tab = (typeof sections)[number];
const sectionLabels = {
	appearance: 'Appearance',
	editor: 'Editor',
	language: 'Language',
	notifications: 'Notifications',
	agents: 'Agents',
	templates: 'Templates',
	modules: 'Modules',
} as const;
/** spec/search-menus-and-commands#search-tabs: a row Search Everywhere asked for, found by its section and label as the page shows them. */
function settingRow(
	root: HTMLElement,
	place: { section: string | null; label: string }
): HTMLElement | null {
	const section = (node: HTMLElement) => {
		const box = node.closest('section');
		return (
			box?.querySelector('h2')?.textContent ??
			box?.querySelector('fieldset')?.getAttribute('aria-label') ??
			null
		);
	};
	const rows = [...root.querySelectorAll<HTMLElement>('[data-settings-row]')];
	return (
		rows.find(
			(row) =>
				row.dataset.settingsRow === place.label &&
				(!place.section || section(row) === place.section)
		) ??
		rows.find((row) => row.dataset.settingsRow === place.label) ??
		[...root.querySelectorAll<HTMLElement>('section')].find(
			(box) => box.querySelector('h2')?.textContent === place.label
		) ??
		rows.find((row) => row.textContent?.includes(place.label)) ??
		null
	);
}
export function LayoutSettings({
	locale,
	close,
	initialTab = 'appearance',
	highlight,
	keymapQuery,
	remoteDialog,
	remotePart,
}: {
	locale: Locale;
	close(): void;
	/** spec/settings-modules-and-onboarding#module-settings-popup: `remote` is Modules with the remote access popup open. */ initialTab?:
		Tab | 'remote';
	/** spec/search-menus-and-commands#search-tabs: a setting row to show. */ highlight?:
		string | undefined;
	/** spec/search-menus-and-commands#search-tabs: open the keymap on this command. */ keymapQuery?:
		string | undefined;
	/** spec/remote-access-and-mobile#module-and-settings: a dialog of remote access settings to open with them (the window chip's menu, a toast). */ remoteDialog?:
		RemoteDialog | undefined;
	/** spec/remote-access-and-mobile#remote-button: the part of remote access settings to show. */ remotePart?:
		RemotePart | undefined;
}) {
	const dialog = useRef<HTMLDialogElement>(null),
		tabs = useRef<HTMLDivElement>(null),
		mounted = useRef(false),
		id = useId();
	const { error: layoutError } = useSurfaceLayout();
	// spec/settings-modules-and-onboarding#module-settings-popup: a module's settings are a popup over Settings ▸ Modules, opened from the module's row; `remote` opens
	// remote access's (a toast, the chip's menu, Search Everywhere).
	const remoteFirst = initialTab === 'remote';
	const [tab, setTab] = useState<Tab>(initialTab === 'remote' ? 'modules' : initialTab),
		[moduleSettings, setModuleSettings] = useState<ModuleSettingsTarget | null>(
			remoteFirst
				? {
						module: 'remoteAccess',
						...(remoteDialog ? { remoteDialog } : {}),
						...(remotePart ? { remotePart } : {}),
					}
				: null
		),
		[snapshot, setSnapshot] = useState<SettingsSnapshot | null>(null),
		[busy, setBusy] = useState(false),
		[error, setError] = useState('');
	async function load() {
		setError('');
		try {
			const value = await window.brigadir.readSettings();
			if (mounted.current) setSnapshot(value);
		} catch {
			if (mounted.current) setError(t(locale, 'The settings could not be loaded.'));
		}
	}
	useEffect(() => {
		mounted.current = true;
		const previous = document.activeElement,
			node = dialog.current!;
		node.showModal();
		void load();
		return () => {
			mounted.current = false;
			node.close();
			if (previous instanceof HTMLElement && previous.isConnected) previous.focus();
		};
	}, []);
	// spec/settings-modules-and-onboarding#module-settings-popup: a save disables the form; the control that started it keeps focus (the capsule's menu, a switch, a segment).
	useKeepFocusWhileBusy(dialog, busy);
	async function update(patch: Partial<AppSettings>) {
		await apply(patch);
	}
	async function apply(patch: Partial<AppSettings>): Promise<boolean> {
		if (!snapshot || busy) return false;
		setBusy(true);
		setError('');
		try {
			const value = await window.brigadir.saveSettings({ ...snapshot.settings, ...patch });
			if (mounted.current) setSnapshot(value);
			return true;
		} catch {
			if (mounted.current) setError(t(locale, 'The settings could not be saved.'));
			return false;
		} finally {
			if (mounted.current) setBusy(false);
		}
	}
	// spec/appearance#accent: arrows move the accent faster than a save finishes, so the latest choice waits for the running one.
	const [accentDraft, setAccentDraft] = useState<AppSettings['accent'] | null>(null);
	useEffect(() => {
		if (!snapshot || busy || accentDraft === null) return;
		if (accentDraft === snapshot.settings.accent) {
			setAccentDraft(null);
			return;
		}
		void apply({ accent: accentDraft }).then((saved) => {
			if (!saved && mounted.current) setAccentDraft(null);
		});
	}, [accentDraft, busy, snapshot]);
	const [keymapOpen, setKeymapOpen] = useState(Boolean(keymapQuery));
	useEffect(() => {
		if (!snapshot || !highlight) return;
		const place = settingLocation(highlight, locale);
		if (!place || place.tab !== tab) return;
		let timer = 0;
		const frame = requestAnimationFrame(() => {
			const row = dialog.current && settingRow(dialog.current, place);
			if (!row) return;
			row.dataset.highlight = 'true';
			row.scrollIntoView({ block: 'center' });
			timer = window.setTimeout(() => {
				delete row.dataset.highlight;
			}, 1500);
		});
		return () => {
			cancelAnimationFrame(frame);
			clearTimeout(timer);
		};
	}, [snapshot !== null, highlight, tab]);
	// spec/settings-modules-and-onboarding#module-settings-popup (revises spec/remote-access-and-mobile#module-and-settings): no Remote tab — seven tabs, 76 wide; spec/architecture-and-platform#packaging: no client-only copy either.
	const visible: readonly Tab[] = sections;
	const tabStep = 80;
	// The popup goes with its module: turned off (here or elsewhere) it closes.
	const moduleOn = moduleSettings
		? (snapshot?.settings.modules[moduleSettings.module] ?? false)
		: false;
	useEffect(() => {
		if (snapshot && moduleSettings && !moduleOn) setModuleSettings(null);
	}, [snapshot !== null, moduleOn]);
	const environment = useEnvironment();
	async function restart() {
		setBusy(true);
		setError('');
		try {
			await window.brigadir.restartApp();
		} catch {
			setError(t(locale, 'The app could not restart.'));
		} finally {
			if (mounted.current) setBusy(false);
		}
	}
	return (
		<dialog
			ref={dialog}
			data-section={tab}
			data-tabs={visible.length}
			className={styles.dialog}
			aria-label={t(locale, 'Settings')}
			onCancel={(event) => {
				event.preventDefault();
				close();
			}}>
			<PopupMarks.Provider value={true}>
				<header>
					<div className={styles.titlebar}>
						<h1>{t(locale, 'Settings')}</h1>
						<PopupClose locale={locale} close={close} />
					</div>
					<div className={styles.tabbar}>
						<div
							ref={tabs}
							role="tablist"
							aria-label={t(locale, 'Settings sections')}
							className={styles.tabs}>
							<span
								className={styles.indicator}
								aria-hidden="true"
								style={{ transform: `translateX(${visible.indexOf(tab) * tabStep}px)` }}
							/>
							{visible.map((value) => (
								<button
									key={value}
									id={`${id}-${value}`}
									role="tab"
									type="button"
									aria-selected={tab === value}
									aria-controls={`${id}-panel`}
									tabIndex={tab === value ? 0 : -1}
									onClick={() => setTab(value)}
									onKeyDown={(event) => {
										if (['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(event.key)) {
											event.preventDefault();
											const index =
												event.key === 'Home'
													? 0
													: event.key === 'End'
														? visible.length - 1
														: (visible.indexOf(tab) +
																(event.key === 'ArrowRight' ? 1 : -1) +
																visible.length) %
															visible.length;
											setTab(visible[index]!);
											tabs.current
												?.querySelectorAll<HTMLButtonElement>('[role=tab]')
												[index]?.focus();
										}
									}}>
									<Glyph
										name={
											value === 'appearance'
												? 'settings-appearance'
												: value === 'editor'
													? 'settings-editor'
													: value === 'language'
														? 'settings-language'
														: value === 'notifications'
															? 'settings-notifications'
															: value === 'templates'
																? 'settings-templates'
																: value === 'modules'
																	? 'settings-modules'
																	: 'settings-agents'
										}
										size={17}
									/>
									<span>{t(locale, sectionLabels[value])}</span>
								</button>
							))}
						</div>
					</div>
				</header>
				<section
					role="tabpanel"
					id={`${id}-panel`}
					aria-labelledby={`${id}-${tab}`}
					key={tab}
					className={styles.page}>
					{!snapshot ? (
						error ? (
							<div className={styles.loadError}>
								<p role="alert">{error}</p>
								<Button
									onClick={() => {
										void load();
									}}>
									{t(locale, 'Retry')}
								</Button>
							</div>
						) : (
							<SkeletonRows count={5} height={34} />
						)
					) : (
						<>
							{tab === 'appearance' ? (
								<>
									<SettingsSection label={t(locale, 'Appearance')}>
										<SettingsRow label={t(locale, 'Theme')}>
											<Popup
												label={t(locale, 'Theme')}
												disabled={busy}
												value={snapshot.settings.appearance}
												options={(['system', 'light', 'dark'] as const).map((value) => ({
													value,
													label: t(
														locale,
														value === 'system' ? 'System' : value === 'light' ? 'Light' : 'Dark'
													),
												}))}
												onChange={(value) => {
													void update({ appearance: value as AppSettings['appearance'] });
												}}
											/>
										</SettingsRow>
										<SettingsRow label={t(locale, 'Accent')}>
											<AccentPicker
												locale={locale}
												value={accentDraft ?? snapshot.settings.accent}
												onChange={setAccentDraft}
											/>
										</SettingsRow>
									</SettingsSection>
									<SettingsSection title={t(locale, 'Toolbar labels')} role="radiogroup">
										{(['icons', 'labels'] as const).map((value) => (
											<SettingsOption
												key={value}
												title={t(locale, value === 'icons' ? 'Icons only' : 'Icons and names')}
												detail={t(
													locale,
													value === 'icons'
														? 'Compact toolbar. Hover over an icon to see its name.'
														: 'Names beside surface icons. Labels collapse in narrow windows.'
												)}>
												<Choice
													type="radio"
													name="toolbar-labels"
													label={t(locale, value === 'icons' ? 'Icons only' : 'Icons and names')}
													disabled={busy}
													checked={snapshot.settings.toolbarLabels === value}
													onChange={() => {
														void update({ toolbarLabels: value });
													}}
												/>
											</SettingsOption>
										))}
									</SettingsSection>
									{/* spec/task-window-workspace#two-columns: two columns (the chat a pinned tab of the work area) or three; radios with icons. */}
									<SettingsSection title={t(locale, 'Task layout')} role="radiogroup">
										{(['two', 'three'] as const).map((value) => (
											<SettingsOption
												key={value}
												title={t(locale, value === 'two' ? 'Two columns' : 'Three columns')}
												detail={t(
													locale,
													value === 'two'
														? 'The chat is the first tab of the work area.'
														: 'The chat, the work area and the panel side by side.'
												)}
												icon={
													<Glyph name={value === 'two' ? 'layout-two' : 'layout-three'} size={16} />
												}>
												<Choice
													type="radio"
													name="task-columns"
													label={t(locale, value === 'two' ? 'Two columns' : 'Three columns')}
													disabled={busy}
													checked={snapshot.settings.taskColumns === value}
													onChange={() => {
														void update({ taskColumns: value });
													}}
												/>
											</SettingsOption>
										))}
									</SettingsSection>
									{/* spec/settings-modules-and-onboarding#settings-keys: projects without a saved view open as this. */}
									<SettingsSection title={t(locale, 'Tasks')} disabled={busy}>
										<SettingsRow label={t(locale, 'View')}>
											<Segments
												label={`${t(locale, 'Tasks')} · ${t(locale, 'View')}`}
												value={snapshot.settings.projects.defaultView}
												options={[
													{
														value: 'board',
														label: t(locale, 'Board'),
														icon: <Glyph name="board" size={13} />,
													},
													{
														value: 'list',
														label: t(locale, 'List'),
														icon: <Glyph name="list" size={13} />,
													},
												]}
												onChange={(value) => {
													void update({
														projects: {
															defaultView: value as AppSettings['projects']['defaultView'],
														},
													});
												}}
											/>
										</SettingsRow>
									</SettingsSection>
									<TypographySettings
										settings={snapshot.settings}
										locale={locale}
										busy={busy}
										update={update}
										reload={() => {
											void load();
										}}
									/>
									{/* spec/settings-modules-and-onboarding#intro: the keymap editor of the intro, in a popup. */}
									<SettingsSection title={t(locale, 'Keyboard')} disabled={busy}>
										<SettingsRow label={t(locale, 'Keymap')}>
											<span className={styles.inline} data-keymap-summary>
												<span>
													{t(
														locale,
														snapshot.settings.keymap.preset === 'brigadir'
															? 'Brigadir'
															: snapshot.settings.keymap.preset === 'vscode'
																? 'VS Code'
																: 'IntelliJ'
													)}
													{Object.keys(snapshot.settings.keymap.overrides).length > 0 &&
														` · ${Object.keys(snapshot.settings.keymap.overrides).length} ${t(locale, 'changed')}`}
												</span>
												<Button disabled={busy} onClick={() => setKeymapOpen(true)}>
													{t(locale, 'Customize…')}
												</Button>
											</span>
										</SettingsRow>
									</SettingsSection>
									{keymapOpen && (
										<KeymapDialog
											keymap={snapshot.settings.keymap}
											initialQuery={keymapQuery}
											locale={locale}
											busy={busy}
											save={(keymap) => {
												void update({ keymap });
											}}
											close={() => setKeymapOpen(false)}
										/>
									)}
								</>
							) : tab === 'templates' ? (
								<TemplatesSettings locale={locale} busy={busy} />
							) : tab === 'notifications' ? (
								<NotificationSettings
									settings={snapshot.settings}
									locale={locale}
									busy={busy}
									update={update}
								/>
							) : tab === 'editor' ? (
								<EditorSettings
									settings={snapshot.settings}
									locale={locale}
									busy={busy}
									update={update}
								/>
							) : tab === 'agents' ? (
								<>
									{/* spec/settings-modules-and-onboarding#settings-keys: a provider can be turned off; the last one on stays on, the default moves to one that is on. */}
									{/* spec/settings-modules-and-onboarding#module-settings-popup: the providers card, then the agents card under its own title. */}
									<SettingsSection title={t(locale, 'Providers')} disabled={busy}>
										{agentProviders.map((provider) => {
											const agents = snapshot.settings.agents,
												on = agents.enabled[provider],
												last =
													on && agentProviders.filter((item) => agents.enabled[item]).length === 1,
												name = provider === 'claude' ? 'Claude Code' : 'Codex';
											const found = environment.check?.agents.find(
												(agent) => agent.provider === provider
											);
											return (
												<SettingsRow key={provider} label={name}>
													<span className={styles.inline}>
														<Switch
															label={name}
															checked={on}
															disabled={busy || last || (!on && found?.found === false)}
															onChange={(value) => {
																const enabled = { ...agents.enabled, [provider]: value };
																const fallback = agentProviders.find((item) => enabled[item])!;
																void update({
																	agents: {
																		...agents,
																		enabled,
																		provider: enabled[agents.provider] ? agents.provider : fallback,
																	},
																});
															}}
														/>
														<AgentStatus
															agent={found}
															locale={locale}
															checking={environment.checking}
															failed={environment.failed}
															refresh={() => {
																void environment.refresh();
															}}
														/>
													</span>
												</SettingsRow>
											);
										})}
										{/* spec/agents-and-providers#cli-updates: `claude update` / `codex update` once a day; «Check now» any time. */}
										<CliUpdatesRow
											settings={snapshot.settings}
											locale={locale}
											busy={busy}
											update={(patch) => {
												void update(patch);
											}}
											checked={() => {
												void environment.refresh();
											}}
										/>
									</SettingsSection>
									<SettingsSection title={t(locale, 'Agents')} disabled={busy}>
										<SettingsRow
											label={t(locale, 'Default agent')}
											hint={t(
												locale,
												'New tasks, Review with an agent, Agent fixes it, resolving conflicts.'
											)}>
											<Segments
												label={t(locale, 'Default agent')}
												value={snapshot.settings.agents.provider}
												options={[
													{
														value: 'claude',
														label: 'Claude',
														icon: <Glyph name="claude" />,
														disabled: !snapshot.settings.agents.enabled.claude,
													},
													{
														value: 'codex',
														label: 'Codex',
														icon: <Glyph name="openai" />,
														disabled: !snapshot.settings.agents.enabled.codex,
													},
												]}
												onChange={(value) => {
													void update({
														agents: {
															...snapshot.settings.agents,
															provider: value as AppSettings['agents']['provider'],
														},
													});
												}}
											/>
										</SettingsRow>
										{/* spec/appearance#evolution-redesign: the Helper agent writes every short one-off text, the prompt hint among them. */}
										<HelperAgentRow
											settings={snapshot.settings}
											locale={locale}
											busy={busy}
											update={(patch) => {
												void update(patch);
											}}
										/>
										<SubagentModelRow
											settings={snapshot.settings}
											locale={locale}
											busy={busy}
											update={(patch) => {
												void update(patch);
											}}
										/>
										{/* spec/appearance#evolution-redesign: an agent per action on top of «one for all». */}
										<ActionAgentsRows
											settings={snapshot.settings}
											locale={locale}
											busy={busy}
											update={(patch) => {
												void update(patch);
											}}
										/>
										<SettingsRow label={t(locale, 'Launch in')}>
											<Segments
												label={t(locale, 'Launch in')}
												value={snapshot.settings.agents.transport}
												options={[
													{ value: 'gui', label: 'GUI' },
													{ value: 'terminal', label: t(locale, 'Terminal') },
												]}
												onChange={(value) => {
													void update({
														agents: {
															...snapshot.settings.agents,
															transport: value as AppSettings['agents']['transport'],
														},
													});
												}}
											/>
										</SettingsRow>
										<SettingsRow label={t(locale, 'Isolation for new tasks')}>
											<Segments
												label={t(locale, 'Isolation for new tasks')}
												value={snapshot.settings.agents.isolation}
												options={[
													{ value: 'in-place', label: t(locale, 'No isolation') },
													{ value: 'worktree', label: 'Worktree' },
												]}
												onChange={(value) => {
													void update({
														agents: {
															...snapshot.settings.agents,
															isolation: value as AppSettings['agents']['isolation'],
														},
													});
												}}
											/>
										</SettingsRow>
										<SettingsRow label={t(locale, 'Max concurrent')}>
											<Stepper
												label={t(locale, 'Max concurrent')}
												min={0}
												max={maxConcurrentLimit}
												automaticLabel={t(locale, 'Unlimited')}
												value={snapshot.settings.agents.maxConcurrent ?? 0}
												onChange={(value) => {
													void update({
														agents: {
															...snapshot.settings.agents,
															maxConcurrent: value > 0 ? value : null,
														},
													});
												}}
												increaseLabel={`${t(locale, 'Max concurrent')} · ${t(locale, 'Increase')}`}
												decreaseLabel={`${t(locale, 'Max concurrent')} · ${t(locale, 'Decrease')}`}
											/>
										</SettingsRow>
										{/* spec/architecture-and-platform#keep-awake: no idle sleep while an agent works; the display and the lid behave as usual. */}
										<KeepAwakeRow
											settings={snapshot.settings}
											locale={locale}
											busy={busy}
											update={(patch) => {
												void update(patch);
											}}
										/>
										<SettingsRow
											label={t(locale, 'Prompt suggestion')}
											hint={t(locale, 'Written by the helper agent.')}>
											<label className={styles.inline}>
												<Switch
													label={t(locale, 'Suggest the next prompt')}
													checked={snapshot.settings.suggestNextPrompt}
													disabled={busy}
													onChange={(suggestNextPrompt) => {
														void update({ suggestNextPrompt });
													}}
												/>
												<span>{t(locale, 'Suggest the next prompt')}</span>
											</label>
										</SettingsRow>
									</SettingsSection>
									{/* spec/tasks#archive: completed tasks go to the archive after N days; Never turns only the timer off. */}
									<SettingsSection title={t(locale, 'Tasks')} disabled={busy}>
										<SettingsRow
											label={t(locale, 'Archive completed')}
											hint={t(
												locale,
												'Only tasks you marked completed. Stopped and failed tasks stay in the sidebar.'
											)}>
											<Popup
												label={t(locale, 'Archive completed')}
												disabled={busy}
												value={String(snapshot.settings.agents.archiveAfterDays)}
												options={[
													{ value: 'null', label: t(locale, 'Never') },
													...archiveAfterDayOptions.map((days) => ({
														value: String(days),
														label: t(
															locale,
															days === 1
																? 'After 1 day'
																: days === 3
																	? 'After 3 days'
																	: days === 7
																		? 'After 7 days'
																		: 'After 30 days'
														),
													})),
												]}
												onChange={(value) => {
													void update({
														agents: {
															...snapshot.settings.agents,
															archiveAfterDays:
																value === 'null' ? null : (Number(value) as ArchiveAfterDays),
														},
													});
												}}
											/>
										</SettingsRow>
									</SettingsSection>
								</>
							) : tab === 'modules' ? (
								<>
									{/* spec/settings-modules-and-onboarding#modules: a module switched off takes its column, menu items, processes and MCP tools with it;
									    spec/settings-modules-and-onboarding#intro-remote: the same rows as the intro's Modules step, a second line under each. */}
									<section className={styles.section}>
										<ModuleList
											locale={locale}
											modules={snapshot.settings.modules}
											disabled={busy}
											// spec/remote-access-and-mobile#architecture: a device's window never turns the working machine's remote access off.
											locked={window.brigadir.remoteMachine ? ['remoteAccess'] : []}
											// spec/settings-modules-and-onboarding#module-settings-popup: a module's settings open in a popup over Settings.
											onSettings={Object.fromEntries(
												modulesWithSettings.map((module) => [
													module,
													() => setModuleSettings({ module }),
												])
											)}
											onChange={(modules) => {
												void update({ modules });
											}}
										/>
									</section>
								</>
							) : (
								<>
									<SettingsSection label={t(locale, 'Language')}>
										<SettingsRow label={t(locale, 'Interface language')}>
											<Popup
												label={t(locale, 'Interface language')}
												disabled={busy}
												value={snapshot.settings.language}
												options={[
													{ value: 'system', label: t(locale, 'Follow system') },
													{ value: 'uk', label: 'Українська' },
													{ value: 'en', label: 'English' },
												]}
												onChange={(value) => {
													void update({ language: value as AppSettings['language'] });
												}}
											/>
										</SettingsRow>
										{snapshot.restartRequired && (
											<div className={styles.restart}>
												<span>{t(locale, 'The language will change after restart.')}</span>
												{/* spec/remote-access-and-mobile#browser-from-device: a device does not restart the working machine. */}
												{!window.brigadir.remoteMachine && (
													<Button
														disabled={busy}
														onClick={() => {
															void restart();
														}}>
														{t(locale, 'Restart')}
													</Button>
												)}
											</div>
										)}
									</SettingsSection>
									{/* spec/architecture-and-platform#auto-update: Brigadir's own updates; a device window updates the app on this computer. */}
									<SettingsSection title={t(locale, 'Updates')} disabled={busy}>
										<AppUpdateRow
											settings={snapshot.settings}
											locale={locale}
											busy={busy}
											update={(patch) => {
												void update(patch);
											}}
										/>
									</SettingsSection>
								</>
							)}
							{error && (
								<p className={styles.error} role="alert">
									{error}
								</p>
							)}
							{layoutError && (
								<p className={styles.error} role="alert">
									{t(locale, 'The layout could not be saved or restored.')}
								</p>
							)}
						</>
					)}
				</section>
				{/* spec/settings-modules-and-onboarding#module-settings-popup: Settings ▸ Modules ▸ ⚙ — the module's settings in a popup; Esc goes back to Modules. It mounts after
				    the settings load, so it opens above Settings. */}
				{moduleSettings && snapshot && moduleOn && (
					<ModuleSettingsDialog
						target={moduleSettings}
						settings={snapshot.settings}
						locale={locale}
						busy={busy}
						update={(patch) => {
							void update(patch);
						}}
						close={() => setModuleSettings(null)}
					/>
				)}
			</PopupMarks.Provider>
		</dialog>
	);
}
