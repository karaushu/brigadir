/**
 * spec/remote-access-and-mobile#phone-app: the sheets of the home — the filter by state, the machine (link,
 * notifications, theme, signing out), the subscription limits, a new task.
 */
import { useEffect, useMemo, useState } from 'react';
import {
	agentOptionKind,
	catalogOptions,
	liveWindows,
	personTasks,
	projectColors,
	quotaAgeLabel,
	quotaObservedAt,
	quotaResetLabel,
	quotaWindowLabel,
	selectOption,
	sidebarMatches,
	suggestedBranch,
	t,
	type AgentOption,
	type AgentProvider,
	type Locale,
	type ProviderCatalog,
	type SidebarFilter,
} from '@brigadir/core';
import { Button, StatusIcon, Switch, Segments } from '../../renderer/ui/Controls';
import { Glyph } from '../../renderer/ui/Glyph';
import { Caption, Group, RowIcon, Sheet, SheetRow } from '../ui/Sheet';
import { Icon } from '../ui/Icon';
import { percent, quotaLevel, shownWindow } from '../ui/Header';
import { back, navigate } from '../router';
import { useMobile, type ThemeChoice } from '../store';
import { useConnection } from '../context';
import { pushSubscription, pushSupported, turnPushOff, turnPushOn } from '../push';
import s from './Sheets.module.css';

export function FilterSheet({ locale }: { locale: Locale }) {
	const workspace = useMobile((state) => state.workspace),
		filter = useMobile((state) => state.filter);
	const live = personTasks(workspace?.tasks ?? []).filter((task) => task.status !== 'completed');
	const rows: { value: SidebarFilter; label: string; icon: React.ReactNode }[] = [
		{ value: null, label: t(locale, 'All tasks'), icon: <Icon name="list" size={20} /> },
		{
			value: 'needs-you',
			label: t(locale, 'Needs you'),
			icon: <StatusIcon status="needs-you" label="" size={20} />,
		},
		{
			value: 'running',
			label: t(locale, 'Running'),
			icon: <StatusIcon status="working" label="" size={20} />,
		},
		{
			value: 'unreviewed',
			label: t(locale, 'Unreviewed'),
			icon: <StatusIcon status="done" label="" size={20} />,
		},
	];
	return (
		<Sheet
			label={t(locale, 'Filter by status')}
			title={t(locale, 'Filter by status')}
			locale={locale}
			close={back}>
			<Group>
				{rows.map((row) => (
					<SheetRow
						key={String(row.value)}
						role="menuitemradio"
						checked={filter === row.value}
						icon={
							<>
								<span className={s.check}>
									{filter === row.value && <Icon name="tick" size={18} />}
								</span>
								<span className={s.filterIcon}>{row.icon}</span>
							</>
						}
						title={row.label}
						tail={
							<span className={s.count}>
								{live.filter((task) => sidebarMatches(task, row.value)).length}
							</span>
						}
						onClick={() => {
							useMobile.getState().setFilter(row.value);
							back();
						}}
					/>
				))}
			</Group>
		</Sheet>
	);
}
export function MachineSheet({ locale, openTheme }: { locale: Locale; openTheme(): void }) {
	const connection = useConnection();
	const machine = useMobile((state) => state.machine),
		link = useMobile((state) => state.link),
		rtt = useMobile((state) => state.rtt),
		theme = useMobile((state) => state.theme);
	const [push, setPush] = useState<boolean | null>(null);
	useEffect(() => {
		void pushSubscription().then(
			(value) => setPush(Boolean(value)),
			() => setPush(false)
		);
	}, []);
	const linkTitle =
		link === 'off'
			? t(locale, 'Unavailable (machine)')
			: link === 'connecting'
				? t(locale, 'Connecting…')
				: t(locale, 'Connected');
	return (
		<Sheet
			label={machine}
			title={machine}
			icon={<Icon name="machine" size={22} className={s.headIcon} />}
			locale={locale}
			close={back}>
			<Group>
				<SheetRow
					icon={<i className={s.dot} data-link={link} />}
					title={linkTitle}
					sub={[
						'Tailscale',
						location.hostname,
						...(rtt !== null && link !== 'off' ? [`${rtt} ${t(locale, 'ms')}`] : []),
					].join(' · ')}
					data={{ link }}
				/>
				{pushSupported() && connection.welcome.push && (
					<SheetRow
						icon={
							<RowIcon>
								<Icon name="bell" size={18} />
							</RowIcon>
						}
						title={t(locale, 'Notifications')}
						sub={t(locale, 'When an agent is waiting for you')}
						tail={
							<span data-size="l" className={s.switchTail}>
								<Switch
									label={t(locale, 'Notifications')}
									checked={Boolean(push)}
									disabled={push === null}
									onChange={(on) => {
										setPush(null);
										void (
											on ? turnPushOn(connection) : turnPushOff(connection).then(() => false)
										).then(
											(value) => setPush(Boolean(value)),
											() => setPush(!on)
										);
									}}
								/>
							</span>
						}
					/>
				)}
				<SheetRow
					icon={
						<RowIcon>
							<Icon name="theme" size={18} />
						</RowIcon>
					}
					title={t(locale, 'Theme')}
					tail={<span className={s.value}>{themeName(locale, theme)}</span>}
					chevron
					onClick={openTheme}
				/>
			</Group>
			<Group className={s.gap14}>
				<SheetRow
					danger
					icon={
						<RowIcon danger>
							<Icon name="out" size={18} />
						</RowIcon>
					}
					title={t(locale, 'Sign out on this phone')}
					data={{ signout: '' }}
					onClick={() => connection.close('signed-out')}
				/>
			</Group>
			<Caption className={s.captionNote}>
				{connection.welcome.version &&
					`${t(locale, 'Brigadir {version} on {machine}.')
						.replace('{version}', connection.welcome.version)
						.replace('{machine}', machine)} `}
				{t(
					locale,
					'The passkey of this phone can be revoked on {machine} in Settings ▸ Remote.'
				).replace('{machine}', machine)}
			</Caption>
		</Sheet>
	);
}
const themeName = (locale: Locale, theme: ThemeChoice) =>
	t(locale, theme === 'system' ? 'Follow system' : theme === 'light' ? 'Light' : 'Dark');
export function ThemeSheet({ locale }: { locale: Locale }) {
	const theme = useMobile((state) => state.theme);
	return (
		<Sheet label={t(locale, 'Theme')} title={t(locale, 'Theme')} locale={locale} close={back}>
			<Group>
				{(['system', 'light', 'dark'] as const).map((value) => (
					<SheetRow
						key={value}
						role="menuitemradio"
						checked={theme === value}
						icon={<span className={s.radio} data-on={theme === value || undefined} />}
						title={themeName(locale, value)}
						onClick={() => {
							useMobile.getState().setTheme(value);
							back();
						}}
					/>
				))}
			</Group>
		</Sheet>
	);
}
/** The windows of the providers (or of one, in the limit's sheet) with % left, the reset and ⊙ «shown in the header». */
export function QuotaRows({ locale, only }: { locale: Locale; only?: AgentProvider }) {
	const quota = useMobile((state) => state.quota),
		shown = useMobile((state) => state.quotaShown);
	const now = Date.now();
	return (
		<>
			{(quota?.providers ?? [])
				.filter((entry) => !only || entry.provider === only)
				.map((entry) => {
					const windows = liveWindows(entry, now),
						header = shownWindow(entry, shown[entry.provider], now),
						observed = quotaObservedAt(entry);
					if (!windows.length) return null;
					return (
						<div key={entry.provider} data-quota-provider={entry.provider}>
							<div className={s.quotaHead}>
								<Glyph name={entry.provider === 'claude' ? 'claude' : 'openai'} size={16} />
								<b>{entry.provider === 'claude' ? 'Claude' : 'Codex'}</b>
								{entry.plan && <small>{entry.plan}</small>}
								<span className={s.space} />
								{observed !== null && <small>{quotaAgeLabel(locale, observed, now)}</small>}
							</div>
							<Group>
								{windows.map((window) => {
									const level = quotaLevel(window),
										on = header?.id === window.id;
									return (
										<div key={window.id} className={s.quotaRow} data-quota-window={window.id}>
											<div className={s.quotaTop}>
												<span>{quotaWindowLabel(locale, entry.provider, window)}</span>
												<span className={s.space} />
												<b>{percent(window.remaining)}%</b>
												<small>{t(locale, 'left')}</small>
												<button
													type="button"
													className={s.pin}
													data-on={on || undefined}
													aria-pressed={on}
													aria-label={t(locale, 'Show in the home header')}
													onClick={() =>
														useMobile.getState().showQuota(entry.provider, on ? null : window.id)
													}>
													<Icon name="eye" size={18} />
												</button>
											</div>
											<div className={s.bar}>
												<i data-level={level} style={{ width: `${percent(window.remaining)}%` }} />
											</div>
											<div className={s.reset}>{quotaResetLabel(locale, window, now)}</div>
										</div>
									);
								})}
							</Group>
						</div>
					);
				})}
		</>
	);
}
export function QuotaSheet({ locale }: { locale: Locale }) {
	useEffect(() => {
		void window.brigadir.refreshQuota().catch(() => {});
	}, []);
	return (
		<Sheet
			label={t(locale, 'Subscription limits')}
			title={t(locale, 'Subscription limits')}
			locale={locale}
			close={back}>
			<QuotaRows locale={locale} />
		</Sheet>
	);
}
/** spec/remote-access-and-mobile#phone: project, text, model, effort; the branch and isolation come from the project's last task. */
export function NewTaskSheet({
	locale,
	projectId: initial,
}: {
	locale: Locale;
	projectId: string | null;
}) {
	const workspace = useMobile((state) => state.workspace);
	const projects = workspace?.projects ?? [];
	const [chosen, setProjectId] = useState<string | null>(null);
	// The workspace may arrive after the sheet opens: the choice falls back to the sheet's project, then the first one.
	const projectId =
		[chosen, initial, projects[0]?.id].find(
			(id) => id && projects.some((item) => item.id === id)
		) ?? '';
	const last = useMemo(
		() =>
			(workspace?.tasks ?? [])
				.filter((task) => task.projectId === projectId)
				.sort((a, b) => (b.updatedAt ?? '').localeCompare(a.updatedAt ?? ''))[0],
		[workspace, projectId]
	);
	const [provider, setProvider] = useState<AgentProvider>(last?.provider ?? 'claude');
	const [catalogs, setCatalogs] = useState<Partial<Record<AgentProvider, ProviderCatalog>>>({});
	const [model, setModel] = useState<string | null>(null),
		[effort, setEffort] = useState<string | null>(null),
		[text, setText] = useState(''),
		[busy, setBusy] = useState(false),
		[error, setError] = useState<string | null>(null);
	useEffect(() => {
		for (const item of ['claude', 'codex'] as const)
			void window.brigadir.readProviderCatalog(item).then(
				(catalog) => setCatalogs((all) => ({ ...all, [item]: catalog })),
				() => {}
			);
	}, []);
	const catalog = catalogs[provider];
	const modelOption = catalog ? selectOption(catalog.options, 'model') : undefined;
	const chosenModel = model ?? modelOption?.value ?? null;
	const options: AgentOption[] = catalog ? catalogOptions(catalog, chosenModel ?? undefined) : [];
	const effortOption = options.find(
		(option): option is Extract<AgentOption, { kind: 'select' }> =>
			option.kind === 'select' && agentOptionKind(option) === 'effort'
	);
	const chosenEffort =
		effort && effortOption?.choices.some((choice) => choice.value === effort)
			? effort
			: (effortOption?.value ?? null);
	const colors = projectColors(projects.map((item) => item.id));
	const project = projects.find((item) => item.id === projectId);
	const models = (['claude', 'codex'] as const).flatMap((item) => {
		const option = catalogs[item] && selectOption(catalogs[item]!.options, 'model');
		return option ? option.choices.map((choice) => ({ provider: item, ...choice })) : [];
	});
	const modelName =
		modelOption?.choices.find((choice) => choice.value === chosenModel)?.name ?? chosenModel ?? '';
	const start = async () => {
		if (!project || !text.trim() || busy) return;
		setBusy(true);
		setError(null);
		try {
			const settings = await window.brigadir.readLaunchSettings(project.id);
			const launch = {
				isolation: settings.isolation,
				baseRef: settings.baseRef,
				setupCommand: settings.setupCommand,
				...(settings.copyEnvFiles === undefined ? {} : { copyEnvFiles: settings.copyEnvFiles }),
				scopes: settings.scopes,
				branch: suggestedBranch('', text, crypto.randomUUID()),
				branchAuto: true,
			};
			const choices = [
				...(modelOption && chosenModel ? [{ id: modelOption.id, value: chosenModel }] : []),
				...(effortOption && chosenEffort ? [{ id: effortOption.id, value: chosenEffort }] : []),
			];
			const task = await window.brigadir.createTask(
				project.id,
				text.trim(),
				provider,
				'gui',
				false,
				launch,
				undefined,
				choices.length ? { options: choices } : undefined
			);
			void window.brigadir.startSession(task).catch(() => {});
			useMobile.getState().setLastProject(project.id);
			navigate({ screen: 'task', projectId: task.projectId, taskId: task.id });
		} catch (failure) {
			setError(failure instanceof Error ? failure.message : String(failure));
			setBusy(false);
		}
	};
	return (
		<Sheet
			label={t(locale, 'New task')}
			title={t(locale, 'New task')}
			locale={locale}
			close={back}
			tall
			top={54}>
			<div className={s.form} data-new-task>
				<Group className={s.flush}>
					<label className={s.select}>
						<span className={s.selectLabel}>{t(locale, 'Project')}</span>
						<i
							className={s.projectDot}
							style={{ background: `var(--project-${colors.get(projectId) ?? 0})` }}
						/>
						<span>{project?.name}</span>
						<Icon name="chev" size={16} className={s.selectChevron} />
						<select
							aria-label={t(locale, 'Project')}
							value={projectId}
							onChange={(event) => setProjectId(event.target.value)}>
							{projects.map((item) => (
								<option key={item.id} value={item.id}>
									{item.name}
								</option>
							))}
						</select>
					</label>
				</Group>
				<div className={s.field}>
					<label className={s.fieldLabel} htmlFor="new-task-text">
						{t(locale, 'What to do')}
					</label>
					<textarea
						id="new-task-text"
						className={s.text}
						value={text}
						data-new-task-text
						onChange={(event) => setText(event.target.value)}
					/>
				</div>
				{models.length > 0 && (
					<Group className={s.flush}>
						<label className={s.select}>
							<span className={s.selectLabel}>{t(locale, 'Model')}</span>
							<Glyph name={provider === 'claude' ? 'claude' : 'openai'} size={14} />
							<span>{modelName}</span>
							<Icon name="chev" size={16} className={s.selectChevron} />
							<select
								aria-label={t(locale, 'Model')}
								value={`${provider}/${chosenModel ?? ''}`}
								onChange={(event) => {
									const [nextProvider, ...rest] = event.target.value.split('/');
									setProvider(nextProvider as AgentProvider);
									setModel(rest.join('/'));
									setEffort(null);
								}}>
								{models.map((item) => (
									<option
										key={`${item.provider}/${item.value}`}
										value={`${item.provider}/${item.value}`}>
										{item.provider === 'claude' ? 'Claude' : 'Codex'} · {item.name}
									</option>
								))}
							</select>
						</label>
					</Group>
				)}
				{effortOption && (
					<div className={s.field}>
						<span className={s.fieldLabel}>{t(locale, 'Effort')}</span>
						<Segments
							size="l"
							className={s.segments}
							label={t(locale, 'Effort')}
							value={chosenEffort ?? ''}
							options={effortOption.choices.map((choice) => ({
								value: choice.value,
								label: choice.name,
							}))}
							onChange={setEffort}
						/>
					</div>
				)}
				{error !== null && (
					<Caption className={s.error}>
						{/* spec/remote-access-and-mobile#remote-button: a translated line; the host's own words stay in the tooltip. */}
						<span title={error || undefined}>{t(locale, 'The task could not be created.')}</span>
					</Caption>
				)}
			</div>
			<span className={s.space} />
			<div className={s.footer} data-size="xl">
				<Button
					appearance="primary"
					className={s.wide}
					disabled={!text.trim() || !project || busy}
					data-new-task-start
					onClick={() => void start()}>
					{t(locale, 'Start')}
				</Button>
			</div>
		</Sheet>
	);
}
