import { useEffect, useState } from 'react';
import {
	catalogOptions,
	isAppToken,
	isBotToken,
	isSlackMemberId,
	selectOption,
	slackEvents,
	t,
	type AgentProviderId,
	type AppSettings,
	type Locale,
	type MessageKey,
	type Project,
	type SlackEvent,
	type SlackRoute,
	type SlackSettings as Settings,
	type SlackState,
} from '@brigadir/core';
import { Button, Choice, Popup, Segments, Switch } from './ui/Controls';
import { Glyph } from './ui/Glyph';
import { optionChoices } from './ui/OptionIcon';
import { Spinner } from './ui/Loading';
import { readCatalog, useProviderCatalogs } from './HelperAgent';
import { TextInput } from './ui/Input';
import { SettingsOption, SettingsRow, SettingsSection } from './SettingsForm';
import styles from './RemoteSettings.module.css';

const eventNames: Record<SlackEvent, MessageKey> = {
	ci: 'CI finished',
	prMerged: 'PR merged (event)',
	needsYou: 'Needs you',
	taskDone: 'Turn ended',
	taskCompleted: 'Task completed',
	scheduleFailed: 'Scheduled run failed',
};
const sourceText = (locale: Locale, state: Exclude<SlackState, { state: 'off' }>) =>
	state.source === 'keychain'
		? t(locale, 'Token in Keychain')
		: state.source === 'env'
			? t(locale, 'From SLACK_CI_BOT_TOKEN')
			: `${t(locale, 'From SLACK_CI_BOT_TOKEN')} · ${state.file ?? ''}`;

/**
 * spec/notifications-slack-notes-and-schedules#slack: Settings ▸ Modules ▸ Slack — the bot, where messages go and which events. The token is
 * typed in once and sent to main; nothing here ever shows it again.
 */
export function SlackSettings({
	locale,
	settings,
	busy,
	update,
}: {
	locale: Locale;
	settings: AppSettings;
	busy: boolean;
	update(patch: Partial<AppSettings>): void;
}) {
	const [state, setState] = useState<SlackState | null>(null);
	const [projects, setProjects] = useState<Project[]>([]);
	const [token, setToken] = useState('');
	const [replacing, setReplacing] = useState(false);
	const [working, setWorking] = useState(false);
	const [error, setError] = useState<string | null>(null);
	const slack = settings.slack;
	useEffect(() => {
		let live = true;
		void window.brigadir.readSlack().then(
			(value) => live && setState(value),
			() => {}
		);
		void window.brigadir.readWorkspace().then(
			(value) => live && setProjects(value.projects),
			() => {}
		);
		const off = window.brigadir.onSlack((value) => setState(value));
		return () => {
			live = false;
			off();
		};
	}, []);
	const save = (next: Partial<Settings>) => update({ slack: { ...slack, ...next } });
	const run = async (action: () => Promise<SlackState>) => {
		setWorking(true);
		setError(null);
		try {
			setState(await action());
			setToken('');
			setReplacing(false);
		} catch (reason) {
			setError(
				reason instanceof Error
					? reason.message.replace(/^Error invoking remote method '[^']+': (Error: )?/, '')
					: String(reason)
			);
		} finally {
			setWorking(false);
		}
	};
	const still = busy || working;
	const tokenField = (
		<SettingsRow
			label={t(locale, 'Bot token')}
			hint={t(
				locale,
				'Your own CI bot: api.slack.com/apps · bot scope chat:write · Install to Workspace'
			)}>
			<span className={styles.inline}>
				<TextInput
					size="m"
					type="password"
					autoComplete="off"
					spellCheck={false}
					placeholder="xoxb-…"
					value={token}
					disabled={still}
					onChange={(event) => setToken(event.currentTarget.value)}
					aria-label={t(locale, 'Bot token')}
					data-slack-token
				/>
				<Button
					size="m"
					appearance="primary"
					disabled={still || !isBotToken(token.trim())}
					onClick={() => void run(() => window.brigadir.connectSlack(token))}
					data-slack-connect>
					{t(locale, 'Connect')}
				</Button>
				{replacing && (
					<Button
						size="m"
						disabled={working}
						onClick={() => {
							setReplacing(false);
							setToken('');
						}}>
						{t(locale, 'Cancel')}
					</Button>
				)}
			</span>
		</SettingsRow>
	);
	const memberRow = (
		<MemberRow
			locale={locale}
			value={slack.memberId}
			busy={still}
			save={(memberId) => save({ memberId })}
		/>
	);
	let bot;
	if (!state || state.state === 'off' || replacing)
		bot = (
			<SettingsSection
				title={t(locale, 'Bot')}
				disabled={still}
				footnote={
					!replacing &&
					t(locale, 'No token in Keychain, in SLACK_CI_BOT_TOKEN or in a project’s .env.local.')
				}>
				{tokenField}
				{memberRow}
			</SettingsSection>
		);
	else {
		const tone =
			state.state === 'on'
				? 'on'
				: state.state === 'token'
					? 'error'
					: state.state === 'down'
						? 'warn'
						: 'idle';
		const line =
			state.state === 'on'
				? `${state.bot}${state.team ? ` · ${state.team}` : ''}`
				: state.state === 'token'
					? t(locale, 'The bot token is no longer valid')
					: state.state === 'down'
						? t(locale, 'Slack is unreachable')
						: t(locale, 'Checking…');
		const detail =
			state.state === 'token'
				? `${state.error} · ${t(locale, 'messages are not sent')}`
				: state.state === 'down'
					? t(locale, 'Retrying in 30 s · {count} waiting').replace(
							'{count}',
							String(state.waiting)
						)
					: sourceText(locale, state);
		const action =
			state.state === 'token' ? (
				<Button size="m" appearance="primary" onClick={() => setReplacing(true)}>
					{t(locale, 'Replace token…')}
				</Button>
			) : state.state === 'down' ? (
				<Button size="m" onClick={() => void run(() => window.brigadir.retrySlack())}>
					{t(locale, 'Retry now')}
				</Button>
			) : (
				// A token found in the environment or a file is kept or swapped for another bot's; a pasted one wins.
				<>
					{state.source !== 'keychain' ? (
						<Button size="m" onClick={() => void run(() => window.brigadir.moveSlackToKeychain())}>
							{t(locale, 'Move to Keychain')}
						</Button>
					) : (
						<Button size="m" onClick={() => void run(() => window.brigadir.disconnectSlack())}>
							{t(locale, 'Disconnect')}
						</Button>
					)}
					<Button size="m" onClick={() => setReplacing(true)}>
						{t(locale, 'Replace token…')}
					</Button>
				</>
			);
		bot = (
			<SettingsSection title={t(locale, 'Bot')} disabled={still}>
				<SettingsRow
					label={t(locale, 'Bot')}
					hint={detail}
					warning={tone === 'warn' || tone === 'error'}>
					<span className={styles.inline} data-slack-state={state.state}>
						<span className={styles.status}>
							<span className={styles.dot} data-on={tone === 'on'} data-tone={tone} />
							<span>{line}</span>
						</span>
						{action}
					</span>
				</SettingsRow>
				{memberRow}
			</SettingsSection>
		);
	}
	return (
		<>
			{bot}
			{error && <p className={styles.error}>{error}</p>}
			{projects.length > 0 && (
				<SettingsSection
					title={t(locale, 'Where')}
					disabled={busy}
					footnote={t(
						locale,
						'Without a channel, messages come to you as direct messages. One task, one thread.'
					)}>
					{projects.map((project) => (
						<RouteRow
							key={project.id}
							locale={locale}
							name={project.name}
							route={slack.projects[project.id] ?? { channel: '', mention: '' }}
							save={(route) => {
								const next = { ...slack.projects };
								if (route.channel || route.mention) next[project.id] = route;
								else delete next[project.id];
								save({ projects: next });
							}}
						/>
					))}
				</SettingsSection>
			)}
			<MentionsSection
				locale={locale}
				enabled={settings.agents.enabled}
				slack={slack}
				state={state}
				busy={busy}
				save={save}
				run={run}
				working={working}
			/>
			<SettingsSection title={t(locale, 'Events')} disabled={busy}>
				{slackEvents.map((event) => (
					<SettingsRow key={event} label={t(locale, eventNames[event])}>
						<Switch
							label={t(locale, eventNames[event])}
							checked={slack.events[event]}
							disabled={busy}
							onChange={(on) => save({ events: { ...slack.events, [event]: on } })}
						/>
					</SettingsRow>
				))}
			</SettingsSection>
			{/* spec/notifications-slack-notes-and-schedules#slack-agent-post: without it, every `slack_post` asks `Post to Slack as …`. */}
			<SettingsSection title={t(locale, 'Agents')} disabled={busy}>
				<SettingsOption
					title={t(locale, 'Agents can post without confirmation')}
					detail={t(
						locale,
						"No permission card before an agent's message. The message still shows in the chat."
					)}>
					<Choice
						type="checkbox"
						label={t(locale, 'Agents can post without confirmation')}
						checked={settings.agents.slackPostWithoutAsking}
						disabled={busy}
						onChange={(event) => {
							update({
								agents: { ...settings.agents, slackPostWithoutAsking: event.currentTarget.checked },
							});
						}}
					/>
				</SettingsOption>
			</SettingsSection>
		</>
	);
}

/** The DM target; saved when it is a member ID (`U…`) and the field loses focus. */
function MemberRow({
	locale,
	value,
	busy,
	save,
}: {
	locale: Locale;
	value: string;
	busy: boolean;
	save(value: string): void;
}) {
	const [draft, setDraft] = useState(value);
	useEffect(() => setDraft(value), [value]);
	const bad = draft.trim() !== '' && !isSlackMemberId(draft.trim());
	return (
		<SettingsRow
			label={t(locale, 'Your member ID')}
			hint={
				bad
					? t(locale, 'A member ID starts with U.')
					: t(locale, 'Profile ▸ ⋯ ▸ Copy member ID — for direct messages')
			}
			warning={bad}>
			<TextInput
				size="m"
				spellCheck={false}
				placeholder="U0…"
				value={draft}
				disabled={busy}
				aria-label={t(locale, 'Your member ID')}
				onChange={(event) => setDraft(event.currentTarget.value)}
				onBlur={() => {
					const next = draft.trim();
					if (next !== value && (next === '' || isSlackMemberId(next))) save(next);
				}}
				data-slack-member
			/>
		</SettingsRow>
	);
}

/** A project's channel (empty — DM) and the user group to mention in a thread's first message (`S…`). */
function RouteRow({
	locale,
	name,
	route,
	save,
}: {
	locale: Locale;
	name: string;
	route: SlackRoute;
	save(route: SlackRoute): void;
}) {
	const [draft, setDraft] = useState(route);
	useEffect(() => setDraft(route), [route.channel, route.mention]);
	const commit = () => {
		const next = { channel: draft.channel.trim(), mention: draft.mention.trim() };
		if (next.channel !== route.channel || next.mention !== route.mention) save(next);
	};
	return (
		<SettingsRow label={name}>
			<span className={styles.inline}>
				<TextInput
					size="m"
					spellCheck={false}
					placeholder={t(locale, 'Direct message')}
					value={draft.channel}
					aria-label={`${name} · ${t(locale, 'Channel')}`}
					onChange={(event) => setDraft({ ...draft, channel: event.currentTarget.value })}
					onBlur={commit}
				/>
				<TextInput
					size="m"
					spellCheck={false}
					placeholder={t(locale, 'Mention group (S…)')}
					value={draft.mention}
					aria-label={`${name} · ${t(locale, 'Mention group (S…)')}`}
					onChange={(event) => setDraft({ ...draft, mention: event.currentTarget.value })}
					onBlur={commit}
				/>
			</span>
		</SettingsRow>
	);
}

/**
 * spec/notifications-slack-notes-and-schedules#slack: `@ mentions in Slack` — the switch, the App-Level Token (typed once, never shown back), who may ask and
 * whether a new task starts. The three setup steps stay in sight until the app listens.
 */
function MentionsSection({
	locale,
	enabled,
	slack,
	state,
	busy,
	working,
	save,
	run,
}: {
	locale: Locale;
	enabled: Record<AgentProviderId, boolean>;
	slack: Settings;
	state: SlackState | null;
	busy: boolean;
	working: boolean;
	save(next: Partial<Settings>): void;
	run(action: () => Promise<SlackState>): Promise<void>;
}) {
	const [token, setToken] = useState('');
	const [person, setPerson] = useState('');
	const mentions = slack.mentions,
		listen = state?.listen ?? { state: 'off' as const },
		still = busy || working,
		botOff = !state || state.state === 'off';
	const set = (next: Partial<Settings['mentions']>) => save({ mentions: { ...mentions, ...next } });
	const tone =
		listen.state === 'on'
			? 'on'
			: listen.state === 'token'
				? 'error'
				: listen.state === 'down'
					? 'warn'
					: 'idle';
	const line = !mentions.on
		? null
		: botOff
			? t(locale, 'Needs the bot token above.')
			: listen.state === 'on'
				? t(locale, 'Listening for mentions')
				: listen.state === 'connecting'
					? t(locale, 'Connecting…')
					: listen.state === 'down'
						? t(locale, 'Slack is unreachable')
						: listen.state === 'token'
							? `${t(locale, 'Slack refused the app-level token')} · ${listen.error}`
							: t(locale, 'No app-level token');
	const next = person.trim(),
		canAdd = isSlackMemberId(next) && !mentions.people.includes(next);
	const replacing = !state?.appToken || listen.state === 'token';
	return (
		<SettingsSection
			title={t(locale, '@ mentions in Slack')}
			disabled={busy}
			footnote={
				listen.state !== 'on' && (
					<ol className={styles.steps} data-slack-steps>
						<li>{t(locale, 'Socket Mode: on, with an app-level token (connections:write).')}</li>
						<li>
							{t(
								locale,
								'Bot scopes: app_mentions:read, channels:history, groups:history, im:history.'
							)}
						</li>
						<li>
							{t(
								locale,
								'Bot events app_mention, message.channels, message.groups, message.im and Interactivity on, then Reinstall to Workspace.'
							)}
						</li>
					</ol>
				)
			}>
			<SettingsRow
				label={t(locale, '@ mentions')}
				hint={
					line && (
						<span className={styles.status} data-slack-listen={listen.state}>
							<span className={styles.dot} data-on={tone === 'on'} data-tone={tone} />
							<span>{line}</span>
						</span>
					)
				}
				warning={tone === 'warn' || tone === 'error'}>
				<label className={styles.inline}>
					<Switch
						label={t(locale, 'Create tasks from Slack')}
						checked={mentions.on}
						disabled={busy}
						onChange={(on) => set({ on })}
					/>
					<span>{t(locale, 'Create tasks from Slack')}</span>
				</label>
			</SettingsRow>
			<SettingsRow
				label={t(locale, 'App-level token')}
				hint={t(locale, 'api.slack.com/apps ▸ Basic Information ▸ App-Level Tokens')}>
				{replacing ? (
					<span className={styles.inline}>
						<TextInput
							size="m"
							type="password"
							autoComplete="off"
							spellCheck={false}
							placeholder="xapp-…"
							value={token}
							disabled={still}
							onChange={(event) => setToken(event.currentTarget.value)}
							aria-label={t(locale, 'App-level token')}
							data-slack-app-token
						/>
						<Button
							size="m"
							appearance="primary"
							disabled={still || botOff || !isAppToken(token.trim())}
							onClick={() =>
								void run(() => window.brigadir.connectSlackApp(token)).then(() => setToken(''))
							}
							data-slack-app-connect>
							{t(locale, 'Connect')}
						</Button>
					</span>
				) : (
					<span className={styles.inline}>
						<span className={styles.status}>{t(locale, 'Token in Keychain')}</span>
						<Button
							size="m"
							disabled={still}
							onClick={() => void run(() => window.brigadir.disconnectSlackApp())}>
							{t(locale, 'Disconnect')}
						</Button>
					</span>
				)}
			</SettingsRow>
			<SettingsRow
				label={t(locale, 'Who')}
				hint={
					mentions.who === 'people' ? t(locale, 'Your member ID is always on the list.') : null
				}>
				<Segments
					label={t(locale, 'Who')}
					value={mentions.who}
					disabled={busy}
					options={[
						{ value: 'people', label: t(locale, 'These people') },
						{ value: 'anyone', label: t(locale, 'Anyone in the channel') },
					]}
					onChange={(who) => set({ who: who as Settings['mentions']['who'] })}
				/>
			</SettingsRow>
			{mentions.who === 'people' &&
				mentions.people.map((id) => (
					<SettingsRow key={id} label={id}>
						<Button
							size="m"
							disabled={busy}
							onClick={() => set({ people: mentions.people.filter((item) => item !== id) })}
							data-slack-person={id}>
							{t(locale, 'Remove')}
						</Button>
					</SettingsRow>
				))}
			{mentions.who === 'people' && (
				<SettingsRow
					label={t(locale, 'Add person')}
					hint={next && !isSlackMemberId(next) ? t(locale, 'A member ID starts with U.') : null}
					warning={!!next && !isSlackMemberId(next)}>
					<span className={styles.inline}>
						<TextInput
							size="m"
							spellCheck={false}
							placeholder="U0…"
							value={person}
							disabled={busy}
							aria-label={t(locale, 'Add person')}
							onChange={(event) => setPerson(event.currentTarget.value)}
							onKeyDown={(event) => {
								if (event.key === 'Enter' && canAdd) {
									set({ people: [...mentions.people, next] });
									setPerson('');
								}
							}}
							data-slack-add-person
						/>
						<Button
							size="m"
							disabled={busy || !canAdd}
							onClick={() => {
								set({ people: [...mentions.people, next] });
								setPerson('');
							}}>
							{t(locale, 'Add')}
						</Button>
					</span>
				</SettingsRow>
			)}
			<SettingsRow label={t(locale, 'New task')}>
				<Segments
					label={t(locale, 'New task')}
					value={mentions.start}
					disabled={busy}
					options={[
						{ value: 'start', label: t(locale, 'Start') },
						{ value: 'ask', label: t(locale, 'Ask in Brigadir') },
					]}
					onChange={(start) => set({ start: start as Settings['mentions']['start'] })}
				/>
			</SettingsRow>
			<AgentRow
				locale={locale}
				enabled={enabled}
				agent={mentions.agent}
				busy={busy}
				save={(agent) => set({ agent })}
			/>
		</SettingsSection>
	);
}

/**
 * spec/notifications-slack-notes-and-schedules#slack: the agent of a task made from Slack — the New task sheet's Agent · Model · Effort popups
 * (rule 17), with `Same as Default agent` first. Null is the app's Default agent with its catalog's own model.
 */
function AgentRow({
	locale,
	enabled,
	agent,
	busy,
	save,
}: {
	locale: Locale;
	enabled: Record<AgentProviderId, boolean>;
	agent: Settings['mentions']['agent'];
	busy: boolean;
	save(agent: Settings['mentions']['agent']): void;
}) {
	const catalogs = useProviderCatalogs(enabled),
		catalog = agent ? catalogs[agent.provider] : undefined,
		models = (catalog ? selectOption(catalog.options, 'model')?.choices : undefined) ?? [],
		effort =
			agent && catalog ? selectOption(catalogOptions(catalog, agent.model), 'effort') : undefined;
	const label = t(locale, 'Agent for tasks');
	// A provider's first model, as the sheet picks it; its catalog is read first when it is not here yet.
	const choose = (value: string) => {
		if (value === 'default') {
			save(null);
			return;
		}
		const provider = value as AgentProviderId;
		void readCatalog(provider).then((own) => {
			const first = own ? selectOption(own.options, 'model')?.choices[0]?.value : undefined;
			if (first) save({ provider, model: first, effort: null });
		});
	};
	return (
		<SettingsRow label={label} hint={t(locale, 'New tasks from Slack.')}>
			<span className={styles.inline} data-slack-agent={agent?.provider ?? 'default'}>
				<Popup
					label={label}
					value={agent?.provider ?? 'default'}
					disabled={busy}
					options={[
						{ value: 'default', label: t(locale, 'Same as Default agent') },
						{ value: 'claude', label: t(locale, 'Claude'), icon: <Glyph name="claude" /> },
						{ value: 'codex', label: t(locale, 'Codex'), icon: <Glyph name="openai" /> },
					].filter(
						(option) =>
							option.value === 'default' ||
							enabled[option.value as AgentProviderId] ||
							option.value === agent?.provider
					)}
					onChange={choose}
				/>
				{agent && catalog === undefined && (
					<Popup
						disabled
						label={t(locale, 'Model')}
						value=""
						displayValue={<Spinner size={10} />}
						options={[]}
						onChange={() => {}}
					/>
				)}
				{agent && models.length > 0 && (
					<Popup
						label={t(locale, 'Model')}
						value={agent.model}
						disabled={busy}
						options={models.map((choice) => ({ value: choice.value, label: choice.name }))}
						onChange={(model) => {
							// The effort carries over when the new model has that level; otherwise the model's own.
							const level = selectOption(catalogOptions(catalog, model), 'effort');
							save({
								...agent,
								model,
								effort: level?.choices.some((choice) => choice.value === agent.effort)
									? agent.effort
									: null,
							});
						}}
					/>
				)}
				{agent && effort && effort.choices.length > 0 && (
					<Popup
						label={t(locale, 'Effort')}
						value={agent.effort ?? effort.value}
						disabled={busy}
						options={optionChoices('effort', effort.choices)}
						onChange={(value) => save({ ...agent, effort: value })}
					/>
				)}
			</span>
		</SettingsRow>
	);
}
