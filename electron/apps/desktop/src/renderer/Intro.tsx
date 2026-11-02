import {
	useEffect,
	useLayoutEffect,
	useRef,
	useState,
	type CSSProperties,
	type ReactNode,
	type RefObject,
} from 'react';
import {
	defaultKeymap,
	formatAccelerator,
	commandShortcut,
	accentColors,
	agentProviders,
	bundledFonts,
	codeFontSize,
	codeThemes,
	developerTemplateId,
	diffBases,
	foremanTemplateId,
	agentStatus,
	installCommands,
	interfaceFontSize,
	onboardingVersion,
	remotePasswordMin,
	reviewerTemplateId,
	selectLocale,
	systemMonoFamily,
	t,
	builtinAgentTemplates,
	builtinCrewTemplates,
	defaultCrewTemplateId,
	resolveCrew,
	templateLookup,
	type AgentCheck,
	type AgentOption,
	type AgentTask,
	type BoardColumn,
	type CrewPlan,
	type CrewSpec,
	type AgentProviderId,
	type AgentTemplate,
	type AppModule,
	type AppSettings,
	type RemoteAccessStatus,
	type Locale,
	type MessageKey,
	type ScopeChoice,
} from '@brigadir/core';
import { useWorkspace } from './store';
import { useEnvironment } from './use-environment';
import { useNotificationPermission } from './use-notification-permission';
import { KeymapEditor } from './KeymapEditor';
import { AccentPicker, accentNames } from './ui/AccentPicker';
import { Button, IconButton, Popup, Segments, Switch } from './ui/Controls';
import { Glyph } from './ui/Glyph';
import { ListCard, ListLead, ListRow } from './ui/ListCard';
import { TextInput } from './ui/Input';
import { ModuleList } from './ModuleList';
import { RemoteFacts, RemoteScheme } from './RemoteOverview';
import { listeningParts } from './remote-text';
import { remoteMachine, setRemoteStatus } from './remote-store';
import helmet from './assets/intro-helmet.png';
import s from './Intro.module.css';
import { ComposerBar, ComposerIsland, ComposerText } from './ui/ComposerIsland';
import { ComposerOptions } from './ComposerOptions';
import { ComposerSend } from './ComposerSend';
import { ComposerEnvironment } from './ComposerEnvironment';
import { PlanCard } from './Crew';
import { CrewCard } from './SidebarTasks';
import { SectionsRail, SettingsTile } from './SectionsRail';
import { QuotaButton } from './Quota';
import {
	BoardCard,
	BoardColumnView,
	BoardColumns,
	ProjectTitlebar,
	ProjectToolbar,
} from './ProjectBoard';
import { useAgentLogin } from './AuthCard';
import { startAgentSignIn } from './agent-sign-in';
import { geistMono, systemMono } from './typography';
/** spec/settings-modules-and-onboarding#intro: the first-run intro as a live build. The window assembles itself: every choice is
 *  saved to the real settings at once, so theme, accent, sizes, code theme and layout change through the app's own tokens. */
const steps = [
	'hello',
	'look',
	'agents',
	'crew',
	'git',
	'editor',
	'tasks',
	'modules',
	'notify',
	'keys',
	'remote',
	'project',
	'done',
] as const;
type Step = (typeof steps)[number];
type Draft = AppSettings;
type Tr = (key: string) => string;
const L = (locale: Locale, key: string) => t(locale, key as MessageKey);
const kindLabels: Record<string, string> = {
	root: 'Root',
	submodule: 'Submodule',
	nested: 'Separate repo',
	external: 'Separate repo',
	worktree: 'Worktree',
	folder: 'Folder',
};
const repoName = (scope: ScopeChoice, project: string) =>
	scope.name === '.' ? project : scope.name;
/** spec/settings-modules-and-onboarding#intro-crew: the roles of the built-in crew `default` (spec/crew-templates-and-editor#builtin-templates) whose provider the Crew step changes (spec/agents-and-providers#catalog). */
const crewRoles = [
	[foremanTemplateId, 'Foreman'],
	[developerTemplateId, 'Developers'],
	[reviewerTemplateId, 'Reviewer'],
] as const;
/** Quick picks beside «Other font…»; a quick pick shows only when the font is on this Mac. */
const quickFonts = ['JetBrains Mono', 'Fira Code'] as const;
/** Windows and Linux: ☰ in the sidebar strip where macOS has its traffic lights, the OS buttons over the toolbar's end (spec/architecture-and-platform#window-frame). */
const pcChrome = window.brigadir.chromePlatform !== 'darwin';
type EnvState = 'spin' | 'ok' | 'warn' | 'miss';
const agentState = (agent: AgentCheck | undefined, checking: boolean): EnvState =>
	!agent || checking
		? 'spin'
		: !agent.found
			? 'miss'
			: agent.signIn === 'signed-out' || agent.signIn === 'expired'
				? 'warn'
				: 'ok';
export function Intro({
	locale: appLocale,
	close,
}: {
	locale: Locale;
	close(projectId?: string, newTask?: boolean): void;
}) {
	const dialog = useRef<HTMLDialogElement>(null);
	const [step, setStep] = useState<Step>('hello'),
		[draft, setDraft] = useState<Draft | null>(null),
		// The intro's own keymap: a preset picked a step earlier already moves New task.
		newTaskKey = commandShortcut('new-task', draft?.keymap ?? defaultKeymap),
		[saveError, setSaveError] = useState(false),
		[dropRefused, setDropRefused] = useState(false),
		[restartNeeded, setRestartNeeded] = useState(false);
	const latest = useRef<Draft | null>(null),
		queue = useRef<Promise<unknown>>(Promise.resolve());
	const environment = useEnvironment();
	// spec/agents-and-providers#sign-in-recovery: an in-app sign-in that ended reads the agents again.
	useEffect(
		() =>
			window.brigadir.onAgentLogin((state) => {
				if (state.phase === 'done' || state.phase === 'failed') environment.refresh();
			}),
		[]
	); // eslint-disable-line react-hooks/exhaustive-deps
	// spec/agents-and-providers#sign-in-recovery: the sign-in in the browser as in Settings ▸ Agents: «Waiting…» and Cancel while it runs.
	const logins = { claude: useAgentLogin('claude'), codex: useAgentLogin('codex') };
	const permission = useNotificationPermission();
	const fonts = useWorkspace((state) => state.appearance.fonts);
	const [project, setProject] = useState<{
			id: string;
			name: string;
			path: string;
			scopes: ScopeChoice[];
		} | null>(null),
		[scanning, setScanning] = useState(false),
		[shown, setShown] = useState(0),
		[dragging, setDragging] = useState(false);
	// spec/settings-modules-and-onboarding#intro-remote: remote access as the working machine has it; the Remote access step turns it on.
	const [remote, setRemote] = useState<RemoteAccessStatus | null>(null),
		[hovered, setHovered] = useState<AppModule | null>(null);
	// The intro saves whole settings: the switch's state goes into them too, or the next save would turn access off.
	function remoteChanged(value: RemoteAccessStatus) {
		setRemote(value);
		const current = latest.current;
		if (!current || current.remoteAccess.enabled === value.enabled) return;
		latest.current = {
			...current,
			remoteAccess: { ...current.remoteAccess, enabled: value.enabled },
		};
		setDraft(latest.current);
	}
	useEffect(() => {
		if (remoteMachine) return;
		let live = true;
		const stop = window.brigadir.onRemoteStatus((value) => {
			if (live) remoteChanged(value);
		});
		void window.brigadir.readRemoteAccess().then(
			(value) => {
				if (live) remoteChanged(value);
			},
			() => {}
		);
		return () => {
			live = false;
			stop();
		};
	}, []);
	const [roles, setRoles] = useState<AgentTemplate[] | null>(null),
		// spec/settings-modules-and-onboarding#intro-steps: the built-in templates could not be read — the Crew step's segments stay off, the footer says why.
		[rolesFailed, setRolesFailed] = useState(false),
		[crewFocus, setCrewFocus] = useState<'card' | 'chat'>('card'),
		[hints, setHints] = useState<Record<string, boolean>>({});
	// spec/settings-modules-and-onboarding#intro-crew: the spotlight shows the crew card in the sidebar first, then the chat with the foreman's plan.
	useEffect(() => {
		if (step !== 'crew') return;
		setCrewFocus('card');
		if (!roles)
			void window.brigadir
				.readTemplates()
				.then((library) => setRoles(library.agents.filter((item) => item.builtin)))
				.catch(() => {
					setRoles([]);
					setRolesFailed(true);
				});
		const timer = setTimeout(() => setCrewFocus('chat'), 2600);
		return () => clearTimeout(timer);
	}, [step]);
	useEffect(() => {
		const node = dialog.current!;
		node.showModal();
		void window.brigadir.readSettings().then(({ settings }) => {
			latest.current = settings;
			setDraft(settings);
		});
		return () => node.close();
	}, []);
	function update(patch: Partial<Draft>) {
		if (!latest.current) return;
		const next = { ...latest.current, ...patch };
		latest.current = next;
		setDraft(next);
		queue.current = queue.current
			.then(async () => {
				if (latest.current !== next) return;
				const saved = await window.brigadir.saveSettings(next);
				setRestartNeeded(saved.restartRequired);
			})
			.catch(() => setSaveError(true));
	}
	const lang: Locale =
		!draft || draft.language === 'system'
			? (appLocale ?? selectLocale(navigator.language))
			: draft.language;
	const tr: Tr = (key) => L(lang, key);
	// spec/settings-modules-and-onboarding#intro-remote: the Remote access step only while the module is on, and never in a device's window (spec/remote-access-and-mobile#architecture).
	const flow = steps.filter(
		(item) => item !== 'remote' || (draft?.modules.remoteAccess !== false && !remoteMachine)
	);
	const index = flow.indexOf(step),
		built = index > 0;
	// spec/settings-modules-and-onboarding#intro-remote: from the Modules step on, the window shows the modules that are on.
	const showModules = index >= flow.indexOf('modules');
	const agents = environment.check?.agents ?? [];
	const usable = agentProviders.filter(
		(provider) =>
			draft?.agents.enabled[provider] &&
			agents.find((agent) => agent.provider === provider)?.found !== false
	);
	const noAgents = Boolean(environment.check) && usable.length === 0;
	// The check itself failed (IPC or main threw): not «no agents», but nothing is known; Check repeats it.
	const unchecked = environment.failed && !environment.checking;
	const go = (next: Step) => setStep(next);
	const next = () => {
		if (step === 'agents' && (noAgents || !environment.check)) return;
		go(flow[Math.min(index + 1, flow.length - 1)]!);
	};
	const skip = () => go(noAgents ? 'agents' : 'done');
	const hint = (id: string) => setHints((value) => ({ ...value, [id]: !value[id] }));
	async function finish(newTask = false) {
		if (!latest.current) return;
		update({ onboarding: { completedVersion: onboardingVersion } });
		await queue.current;
		close(project?.id, newTask);
	}
	async function opened(added: { id: string; name: string; path: string } | null) {
		if (!added) return;
		const launch = await window.brigadir.readLaunchSettings(added.id);
		setProject({ id: added.id, name: added.name, path: added.path, scopes: launch.scopes });
		setShown(0);
	}
	async function pickFolder() {
		setScanning(true);
		try {
			await opened(await window.brigadir.addProject());
		} catch {
			// spec/settings-modules-and-onboarding#intro-steps: the same red line in the footer as a failed drop.
			setSaveError(true);
		} finally {
			setScanning(false);
		}
	}
	async function dropFolder(file: File) {
		// spec/remote-access-and-mobile#client-ui-seam: a folder dropped from this computer is not a folder of the machine this window shows.
		if (remoteMachine) {
			setDropRefused(true);
			return;
		}
		setScanning(true);
		try {
			await opened(await window.brigadir.addDroppedProject(file));
		} catch {
			setSaveError(true);
		} finally {
			setScanning(false);
		}
	}
	useEffect(() => {
		if (!project || shown >= project.scopes.length) return;
		const timer = setTimeout(() => setShown((value) => value + 1), 260);
		return () => clearTimeout(timer);
	}, [project, shown]);
	// The spotlight follows the part of the window the step changes.
	const refs = {
		crew: useRef<HTMLDivElement>(null),
		chat: useRef<HTMLDivElement>(null),
		editor: useRef<HTMLDivElement>(null),
		changes: useRef<HTMLDivElement>(null),
		allProjects: useRef<HTMLDivElement>(null),
		banner: useRef<HTMLDivElement>(null),
		projects: useRef<HTMLDivElement>(null),
		commands: useRef<HTMLSpanElement>(null),
		browser: useRef<HTMLElement>(null),
		simulator: useRef<HTMLElement>(null),
		pullRequests: useRef<HTMLElement>(null),
		chip: useRef<HTMLSpanElement>(null),
		// spec/sidebar#section-rail: the rail's sections the Modules step lights.
		railPRs: useRef<HTMLButtonElement>(null),
		railNotes: useRef<HTMLButtonElement>(null),
		railSchedules: useRef<HTMLButtonElement>(null),
	};
	const remoteOn = Boolean(remote?.enabled) && draft?.modules.remoteAccess !== false;
	// spec/settings-modules-and-onboarding#intro-remote: a hovered module row lights its part of the window; access turned on lights the Remote tile.
	// spec/sidebar#section-rail: Pull requests, Notes and Schedules are sections of the rail, Remote is at its foot — their tiles light up.
	const moduleTarget: Record<AppModule, RefObject<HTMLElement | null>> = {
		browser: refs.browser,
		simulator: refs.simulator,
		pullRequests: refs.railPRs,
		commands: refs.commands,
		remoteAccess: refs.chip,
		notes: refs.railNotes,
		schedules: refs.railSchedules,
		// spec/notifications-slack-notes-and-schedules#slack: Slack has no part of the window to light.
		slack: { current: null },
	};
	const target: RefObject<HTMLElement | null> | null =
		step === 'modules'
			? hovered
				? moduleTarget[hovered]
				: null
			: step === 'remote'
				? remoteOn
					? refs.chip
					: null
				: step === 'agents'
					? refs.chat
					: step === 'crew'
						? crewFocus === 'chat'
							? refs.chat
							: refs.crew
						: step === 'git'
							? refs.changes
							: step === 'editor'
								? refs.editor
								: step === 'tasks'
									? refs.allProjects
									: step === 'notify'
										? refs.banner
										: step === 'project'
											? refs.projects
											: null;
	const [spot, setSpot] = useState<{ x: number; y: number; w: number; h: number } | null>(null);
	useLayoutEffect(() => {
		const measure = () => {
			const node = target?.current,
				root = dialog.current;
			if (!node || !root) {
				setSpot(null);
				return;
			}
			const a = node.getBoundingClientRect(),
				b = root.getBoundingClientRect();
			setSpot({ x: a.left - b.left - 4, y: a.top - b.top - 4, w: a.width + 8, h: a.height + 8 });
		};
		measure();
		const timer = setTimeout(measure, 700);
		window.addEventListener('resize', measure);
		return () => {
			clearTimeout(timer);
			window.removeEventListener('resize', measure);
		};
	}, [step, crewFocus, draft?.agents.transport, hovered, remoteOn]);
	if (!draft) return <dialog ref={dialog} className={s.intro} aria-label={tr('Intro')} />;
	// spec/task-window-workspace#layout-switch: a new task shows the chat, the work area and the panel; the crew step shows two, so its part has room.
	// spec/task-window-workspace#two-columns: two columns — the chat is the first tab of the work area; the steps about the editor and its tabs still
	// open it beside the chat, so the part they explain is in view.
	const twoColumns = draft.taskColumns === 'two' && step !== 'editor' && step !== 'modules';
	const columns = step === 'crew' ? 'crew' : twoColumns ? 'two' : 3;
	const provider = usable.includes(draft.agents.provider)
		? draft.agents.provider
		: (usable[0] ?? draft.agents.provider);
	// A role without its own provider runs on the default agent; a provider turned off is not offered.
	const roleProvider = (id: string): AgentProviderId => {
		const own = roles?.find((item) => item.id === id)?.provider;
		return own && usable.includes(own) ? own : provider;
	};
	async function pickRole(id: string, value: AgentProviderId) {
		const template = roles?.find((item) => item.id === id);
		if (!template) return;
		try {
			const library = await window.brigadir.saveAgentTemplate({
				...template,
				provider: value,
				choices: {},
				choiceNames: {},
			});
			setRoles(library.agents.filter((item) => item.builtin));
		} catch {
			setSaveError(true);
		}
	}
	const crewProviders = {
		foreman: roleProvider(foremanTemplateId),
		developer: roleProvider(developerTemplateId),
		reviewer: roleProvider(reviewerTemplateId),
	};
	// spec/appearance#evolution-redesign: Geist Mono is the default, the OS mono a choice of its own; an installed Geist Mono is the bundled one.
	const installed = new Set(
		(fonts?.fonts ?? [])
			.filter((font) => font.mono && font.family !== bundledFonts.mono)
			.map((font) => font.family)
	);
	const family = draft.typography.editor.family ?? '';
	const quick = ['', ...quickFonts.filter((name) => installed.has(name))],
		other = !quick.includes(family);
	const fontOptions = quick.map((name) => ({ value: name, label: name || bundledFonts.mono }));
	const allFonts = [
		{ value: '', label: bundledFonts.mono, labelStyle: { fontFamily: geistMono } },
		{
			value: systemMonoFamily,
			label: tr('System mono'),
			labelStyle: { fontFamily: systemMono },
		},
		...[...installed]
			.sort((a, b) => a.localeCompare(b))
			.map((name) => ({
				value: name,
				label: name,
				labelStyle: { fontFamily: `"${name}", monospace` },
			})),
	];
	const setFamily = (name: string) =>
		update({
			typography: {
				...draft.typography,
				editor: { ...draft.typography.editor, family: name || null },
			},
		});
	const agentsSub = unchecked
		? 'Could not check the agents.'
		: !environment.check
			? 'Looking for agents on this Mac…'
			: noAgents
				? 'There is no agent. You need at least one.'
				: usable.length === 1
					? 'One agent will work. You can see it in the chat.'
					: 'Both agents are ready. The chat shows the default one.';
	const gh = environment.check?.gh.auth;
	return (
		<dialog
			ref={dialog}
			className={s.intro}
			data-size="m"
			data-step={step}
			data-built={built}
			aria-label={tr('Intro')}
			onCancel={(event) => {
				event.preventDefault();
				if (step === 'hello' || step === 'done') void finish();
				else skip();
			}}>
			{/* The window assembles itself behind the card. */}
			<div className={s.window} aria-hidden="true" inert>
				{/* spec/sidebar#section-rail, spec/settings-modules-and-onboarding#intro-steps (rule 17): the app's sections rail at rest — Tasks open, a section whose module is
				    off gone (spec/sidebar#section-rail), ☰ over its strip on Windows and Linux; at its foot the bell, Remote while
				    access is on (spec/settings-modules-and-onboarding#intro-remote), the limits once there is a quota and Settings. No counts in the intro. */}
				<SectionsRail
					locale={lang}
					strip={
						pcChrome ? (
							<IconButton label={tr('Application menu')} data-size="m">
								<Glyph name="app-menu" size={15} />
							</IconButton>
						) : undefined
					}
					modules={{
						prs: draft.modules.pullRequests,
						notes: draft.modules.notes,
						schedules: draft.modules.schedules,
					}}
					selected="tasks"
					tileRefs={{ prs: refs.railPRs, notes: refs.railNotes, schedules: refs.railSchedules }}
					tools={
						<>
							<IconButton label={tr('Notifications')}>
								<Glyph name="bell" size={16} />
							</IconButton>
							{remoteOn && (
								<span ref={refs.chip} className={s.chip}>
									<IconButton
										label={tr('Remote access is on')}
										dot={
											remote?.devices.some((device) => device.connected)
												? 'var(--green)'
												: 'var(--fg3)'
										}
										dotAt="bottom">
										<Glyph name="remote" size={16} />
									</IconButton>
								</span>
							)}
							<QuotaButton locale={lang} placement="rail" />
							<SettingsTile locale={lang} />
						</>
					}
				/>
				<div className={s.sidebar}>
					{/* spec/sidebar#section-rail: the sidebar's part of the strip — the inert toggle at its end, the --sep line under it. */}
					<div className={s.traffic} data-size="m">
						<IconButton label={tr('Hide sidebar')}>
							<Glyph name="sidebar-toggle" size={16} />
						</IconButton>
					</div>
					<div ref={refs.projects} className={s.projectsArea}>
						<div ref={refs.allProjects} className={s.allProjects} data-active={step === 'tasks'}>
							<Glyph name="board" size={14} />
							<span>{tr('All projects')}</span>
							<Glyph name="folder" size={15} />
						</div>
						<div className={s.projects}>
							{project ? (
								<>
									<div className={s.projectName}>
										{project.name}
										<small>{project.scopes.length} repo</small>
									</div>
									{project.scopes.slice(0, shown).map((scope) => (
										<div key={scope.id} className={s.repo}>
											<Glyph name="git" size={12} />
											<span>{repoName(scope, project.name)}</span>
										</div>
									))}
								</>
							) : (
								<div className={s.addProject}>
									<Glyph name="plus" size={12} />
									{tr('Add a project…')}
								</div>
							)}
						</div>
					</div>
					<SampleCrewCard
						ref={refs.crew}
						open={step === 'crew'}
						providers={crewProviders}
						tr={tr}
					/>
				</div>
				<div className={s.content}>
					<div className={s.toolbar}>
						<strong>{project ? tr('Orders export') : tr('Brigadir')}</strong>
						<span>{project ? project.name : tr('this is how a task looks')}</span>
						{showModules && (
							<span className={s.toolbarTools}>
								{draft.modules.commands && (
									<span ref={refs.commands} className={s.command}>
										<b>
											<Glyph name="command-idle" size={14} />
											dev
											<Glyph name="chevron-down" size={10} />
										</b>
										<i>
											<Glyph name="command-play" size={14} />
										</i>
									</span>
								)}
								<span className={s.toolMenu}>
									<Glyph name="tools" size={16} />
									<Glyph name="chevron-down" size={10} />
								</span>
							</span>
						)}
					</div>
					<div className={s.grid} data-columns={columns}>
						<div ref={refs.chat} className={s.column}>
							<Chat
								terminal={draft.agents.transport === 'terminal'}
								provider={provider}
								crew={step === 'crew' ? crewFocus : null}
								providers={crewProviders}
								locale={lang}
								tr={tr}
								tabbed={columns === 'two'}
							/>
						</div>
						<div ref={refs.editor} className={s.column} data-editor>
							<h4>
								{tr('Editor')}
								<code>date-time.ts</code>
								{/* spec/settings-modules-and-onboarding#intro-remote: the browser and the simulator open as tabs of the work area. */}
								{showModules && draft.modules.browser && (
									<code ref={refs.browser} className={s.tab}>
										<Glyph name="browser" size={11} />
										localhost:5173
									</code>
								)}
								{showModules && draft.modules.simulator && (
									<code ref={refs.simulator} className={s.tab}>
										<Glyph name="simulator" size={11} />
										iPhone 17
									</code>
								)}
							</h4>
							<Code ligatures={draft.typography.editor.ligatures} />
						</div>
						<div ref={refs.changes} className={s.column}>
							<Changes
								base={draft.editor.diffBase}
								crew={step === 'crew'}
								panel={
									showModules
										? { pr: draft.modules.pullRequests, ref: refs.pullRequests }
										: undefined
								}
								tr={tr}
							/>
						</div>
					</div>
					<Board
						list={draft.projects.defaultView === 'list'}
						open={step === 'tasks'}
						prs={draft.modules.pullRequests}
						locale={lang}
						tr={tr}
					/>
				</div>
				<div
					ref={refs.banner}
					className={s.banner}
					data-open={step === 'notify'}
					data-mode={draft.notifications.mode}>
					{draft.notifications.mode === 'off' ? (
						<span className={s.bannerNever}>
							<Glyph name="notifications-off" size={18} />
							{tr('No banners. A task that waits for you glows in the sidebar.')}
						</span>
					) : (
						<>
							<img src={helmet} alt="" />
							<span>
								<strong>{tr('Orders export')}</strong>
								<small>{tr('now')}</small>
								<span>
									{draft.notifications.mode === 'needs-you'
										? tr('The agent asks: “Remove the old API?”')
										: tr('The agent finished a turn · 2 files, +48 −3')}
								</span>
							</span>
						</>
					)}
				</div>
			</div>
			<div
				className={s.spot}
				data-on={Boolean(spot)}
				style={spot ? { left: spot.x, top: spot.y, width: spot.w, height: spot.h } : undefined}
			/>
			{/* Hello: the helmet drops, the name rises letter by letter. */}
			<section className={s.hello} data-open={step === 'hello'} aria-hidden={step !== 'hello'}>
				<Button variant="ghost" className={s.escape} onClick={skip}>
					{tr('Skip')}
					<kbd>esc</kbd>
				</Button>
				<div className={s.helmet}>
					<i />
					<img src={helmet} alt="" />
					<b />
				</div>
				<h1 className={s.word} aria-label={tr('Brigadir')}>
					{[...tr('Brigadir')].map((letter, i) => (
						<span key={`${lang}${i}`} style={{ '--i': i } as CSSProperties}>
							{letter}
						</span>
					))}
				</h1>
				<Button size="xl" appearance="primary" className={s.start} onClick={() => go('look')}>
					{tr('Get started')}
				</Button>
				<div className={s.language}>
					<Glyph name="settings-language" size={14} />
					<span>{tr('Language')}</span>
					<Seg
						label={tr('Language')}
						value={draft.language}
						options={[
							{ value: 'system', label: tr('Follow system') },
							{ value: 'uk', label: 'Українська' },
							{ value: 'en', label: 'English' },
						]}
						onChange={(language) => update({ language: language as Draft['language'] })}
					/>
				</div>
			</section>
			{/* The card with the step's settings; it moves to the part of the window it changes. */}
			<section
				className={s.card}
				data-step={step}
				aria-live="polite"
				aria-hidden={step === 'hello' || step === 'done'}>
				<header>
					<div className={s.dots}>
						{flow.slice(1, -1).map((item, i) => (
							<i key={item} data-on={item === step} data-done={i + 1 < index} />
						))}
					</div>
					<Button variant="ghost" className={s.escape} onClick={skip}>
						{tr('Skip')}
						<kbd>esc</kbd>
					</Button>
				</header>
				<div className={s.body} key={`${step}-${lang}`}>
					{step === 'look' && (
						<Section
							title={tr('Appearance')}
							sub={tr('Look at the window: it changes as you choose.')}>
							<Field label={tr('Theme')}>
								<div className={s.cards}>
									{(['system', 'light', 'dark'] as const).map((value) => (
										<button
											key={value}
											type="button"
											className={s.themeCard}
											aria-pressed={draft.appearance === value}
											onClick={() => update({ appearance: value })}>
											<span className={s.preview}>
												<Mini palette={value === 'dark' ? 'dark' : 'light'} />
												{value === 'system' && <Mini palette="dark" half />}
											</span>
											{tr(value === 'system' ? 'System' : value === 'light' ? 'Light' : 'Dark')}
										</button>
									))}
								</div>
							</Field>
							<Field label={tr('Accent')} value={tr(accentNames[draft.accent])}>
								<AccentPicker
									locale={lang}
									value={draft.accent}
									onChange={(accent) => {
										if (accentColors.includes(accent)) update({ accent });
									}}
								/>
							</Field>
							<Field label={tr('Text size')}>
								<SizeStepper
									label={tr('Text size')}
									min={interfaceFontSize.min}
									max={interfaceFontSize.max}
									value={draft.interfaceFont.size}
									// spec/appearance#chat-text-size: the intro's text size moves the interface and the chat together; the chat's own size is set later in Settings.
									onChange={(size) =>
										update({
											interfaceFont: { ...draft.interfaceFont, size },
											chatFont: { size: null },
										})
									}
									increaseLabel={tr('Larger')}
									decreaseLabel={tr('Smaller')}
								/>
							</Field>
							{/* spec/task-window-workspace#two-columns: two or three columns as cards with their Layout glyphs; the window shows the choice. */}
							<Field label={tr('Task layout')}>
								<div className={s.cards}>
									{(['two', 'three'] as const).map((value) => (
										<button
											key={value}
											type="button"
											className={s.layoutCard}
											aria-pressed={draft.taskColumns === value}
											onClick={() => update({ taskColumns: value })}>
											<span className={s.layoutGlyph}>
												<Glyph name={value === 'two' ? 'layout-two' : 'layout-three'} size={22} />
											</span>
											<span>
												<strong>{tr(value === 'two' ? 'Two columns' : 'Three columns')}</strong>
												<small>{tr(value === 'two' ? 'Chat as a tab' : 'Chat as a column')}</small>
											</span>
										</button>
									))}
								</div>
							</Field>
						</Section>
					)}
					{step === 'agents' && (
						<Section title={tr('Agents')} sub={tr(agentsSub)}>
							<Field label={tr('Agents')}>
								<ListCard>
									{agentProviders.map((item) => {
										const found = agents.find((agent) => agent.provider === item),
											on = draft.agents.enabled[item],
											last =
												on && agentProviders.filter((p) => draft.agents.enabled[p]).length === 1,
											state =
												unchecked && !found ? 'warn' : agentState(found, environment.checking),
											waiting = state === 'warn' && !!found && logins[item].phase === 'waiting',
											name = item === 'claude' ? 'Claude Code' : 'Codex',
											checked = on && found !== undefined && state !== 'miss' && state !== 'spin',
											locked = last || !found || state === 'miss' || state === 'spin';
										const turn = (value: boolean) => {
											const enabled = { ...draft.agents.enabled, [item]: value };
											update({
												agents: {
													...draft.agents,
													enabled,
													provider: enabled[draft.agents.provider]
														? draft.agents.provider
														: agentProviders.find((p) => enabled[p])!,
												},
											});
										};
										// spec/appearance#component-details: the same line as Settings ▸ Agents, plus the account behind «Ready».
										const status = agentStatus(lang, environment.checking ? undefined : found, {
											failed: environment.failed,
											checking: environment.checking,
											waiting,
											signedInWith: true,
										});
										return (
											<ListRow
												key={item}
												tall
												off={state !== 'spin' && state !== 'miss' && !on}
												line={{
													'data-agent-status': status.state,
												}}
												lead={
													<>
														<EnvIcon state={state} />
														<Provider provider={item} size={16} />
													</>
												}
												title={name}
												detail={status.text}
												// spec/settings-modules-and-onboarding#intro-steps, rule 15: the whole row hovers and toggles; Sign in… and the switch keep their own.
												onActivate={locked ? undefined : () => turn(!checked)}
												control={
													<>
														{state === 'warn' &&
															found &&
															(waiting ? (
																<Button
																	onClick={() => {
																		void window.brigadir.cancelAgentLogin(item).catch(() => {});
																	}}>
																	{tr('Cancel')}
																</Button>
															) : (
																<Button onClick={() => startAgentSignIn(item, lang)}>
																	{tr('Sign in…')}
																</Button>
															))}
														{state === 'miss' && (
															<Button onClick={() => hint(item)}>{tr('How to install')}</Button>
														)}
														<Switch
															label={name}
															checked={checked}
															disabled={locked}
															onChange={turn}
														/>
													</>
												}
												below={
													hints[item] && state === 'miss' ? (
														<code className={s.hint}>{installCommands[item]}</code>
													) : undefined
												}
											/>
										);
									})}
								</ListCard>
							</Field>
							<div className={s.pair}>
								<Field label={tr('Default')}>
									<Seg
										label={tr('Default agent')}
										value={provider}
										options={agentProviders.map((item) => ({
											value: item,
											label: item === 'claude' ? 'Claude' : 'Codex',
											icon: <Provider provider={item} />,
											disabled: !usable.includes(item),
										}))}
										onChange={(value) =>
											update({ agents: { ...draft.agents, provider: value as AgentProviderId } })
										}
									/>
								</Field>
								<Field label={tr('Launch in')}>
									<Seg
										label={tr('Launch in')}
										value={draft.agents.transport}
										options={[
											{ value: 'gui', label: 'GUI' },
											{ value: 'terminal', label: tr('Terminal') },
										]}
										onChange={(transport) =>
											update({
												agents: {
													...draft.agents,
													transport: transport as Draft['agents']['transport'],
												},
											})
										}
									/>
								</Field>
							</div>
							{unchecked && (
								<div className={s.warn} role="alert" data-env-failed>
									<Glyph name="env-warn" size={16} />
									<span>
										{tr('Check again. You can also set up the agents later in Settings ▸ Agents.')}
									</span>
									<Button
										onClick={() => {
											void environment.refresh();
										}}>
										{tr('Check')}
									</Button>
								</div>
							)}
							{noAgents && !unchecked && (
								<div className={s.warn} role="alert">
									<Glyph name="env-warn" size={16} />
									<span>
										{tr(
											'You need an agent to continue. Install Claude Code or Codex, then check again.'
										)}
									</span>
									<Button
										onClick={() => {
											void environment.refresh();
										}}>
										{tr('Check')}
									</Button>
								</div>
							)}
							<p className={s.note}>
								{tr(
									'Brigadir runs agents through their CLIs and works only with your subscription. API keys are not supported.'
								)}
							</p>
						</Section>
					)}
					{step === 'crew' && (
						<Section
							title={tr('Crew')}
							sub={tr(
								'You can give a task to one agent or to a crew. The foreman divides the task between the agents and accepts their work.'
							)}>
							<CrewTree providers={crewProviders} tr={tr} />
							<div className={s.legend}>
								<span>
									<i />
									{tr('gives work and accepts it')}
								</span>
								<span data-kind="check">
									<i />
									{tr('checks')}
								</span>
							</div>
							<Field label={tr('Select a provider')}>
								<ListCard>
									{crewRoles.map(([id, label]) => (
										<ListRow
											key={id}
											compact
											title={tr(label)}
											control={
												<Seg
													label={`${tr('Select a provider')} · ${tr(label)}`}
													value={roleProvider(id)}
													options={agentProviders.map((item) => ({
														value: item,
														label: item === 'claude' ? 'Claude' : 'Codex',
														icon: <Provider provider={item} />,
														disabled: !usable.includes(item) || !roles || rolesFailed,
													}))}
													onChange={(value) => {
														void pickRole(id, value as AgentProviderId);
													}}
												/>
											}
										/>
									))}
								</ListCard>
								<p className={s.note}>
									{tr(
										usable.length < 2
											? 'Turn on a second agent to use two providers in one crew.'
											: 'One crew can use agents from different providers. Set the model and effort in Settings ▸ Templates.'
									)}
								</p>
							</Field>
							<p className={s.note}>
								{tr(
									'To use a crew, press ⌘N and select Foreman. You make your own crew in the crew editor.'
								)}
							</p>
						</Section>
					)}
					{step === 'git' && (
						<Section
							title={tr('Git and GitHub')}
							sub={tr(
								!environment.check
									? 'Checking git and GitHub CLI…'
									: gh === 'ready'
										? 'Git and GitHub CLI are ready.'
										: 'Git is ready. You can install GitHub CLI later.'
							)}>
							<ListCard>
								<ListRow
									tall
									lead={
										<>
											<EnvIcon
												state={
													!environment.check ? 'spin' : environment.check.git.found ? 'ok' : 'miss'
												}
											/>
											<Glyph name="git" size={16} />
										</>
									}
									title="Git"
									detail={
										!environment.check
											? tr('Looking…')
											: environment.check.git.found
												? `git ${environment.check.git.version ?? ''}`
												: tr('Not found on this Mac')
									}
								/>
								<ListRow
									tall
									lead={
										<>
											<EnvIcon
												state={!environment.check ? 'spin' : gh === 'ready' ? 'ok' : 'warn'}
											/>
											<Glyph name="github" size={16} />
										</>
									}
									title="GitHub CLI"
									detail={
										!environment.check
											? tr('Looking…')
											: gh === 'ready'
												? tr('Signed in to github.com')
												: gh === 'login'
													? tr('Sign in with gh auth login to use GitHub.')
													: tr('Not found. You need it for pull requests and checks.')
									}
									control={
										gh === 'missing' && (
											<Button onClick={() => hint('gh')}>{tr('How to install')}</Button>
										)
									}
									below={
										hints.gh && gh === 'missing' ? (
											<code className={s.hint}>{installCommands.gh}</code>
										) : undefined
									}
								/>
							</ListCard>
							<Field label={tr('Diff base')} wide>
								<Seg
									label={tr('Diff base')}
									value={draft.editor.diffBase}
									options={diffBases.map((value) => ({
										value,
										label: tr(value === 'task' ? 'Task start' : 'Last commit'),
										icon: <Glyph name={value === 'task' ? 'base-task' : 'base-head'} size={14} />,
									}))}
									onChange={(diffBase) =>
										update({
											editor: {
												...draft.editor,
												diffBase: diffBase as Draft['editor']['diffBase'],
											},
										})
									}
								/>
								<p className={s.note}>
									{tr(
										draft.editor.diffBase === 'task'
											? 'The diff shows all that the agent changed since the task started.'
											: 'The diff shows only uncommitted changes, as git status does.'
									)}
								</p>
							</Field>
							<Field label={tr('Isolation for new tasks')} wide>
								<Seg
									label={tr('Isolation for new tasks')}
									value={draft.agents.isolation}
									options={[
										{ value: 'in-place', label: tr('No isolation') },
										{ value: 'worktree', label: 'Worktree' },
									]}
									onChange={(isolation) =>
										update({
											agents: {
												...draft.agents,
												isolation: isolation as Draft['agents']['isolation'],
											},
										})
									}
								/>
								<p className={s.note}>
									{tr(
										draft.agents.isolation === 'in-place'
											? 'The agent works in the project folder. You can change this for each task.'
											: 'Each task gets its own worktree and branch.'
									)}
								</p>
							</Field>
						</Section>
					)}
					{step === 'editor' && (
						<Section
							title={tr('Editor')}
							sub={tr('Code font and colors. The diff uses the same theme.')}>
							<Field label={tr('Code theme')}>
								<div className={s.themes}>
									{codeThemes.map((theme) => (
										<button
											key={theme}
											type="button"
											className={s.theme}
											aria-pressed={draft.editor.codeTheme === theme}
											onClick={() => update({ editor: { ...draft.editor, codeTheme: theme } })}>
											<span data-swatches={theme}>
												<i />
												<i />
												<i />
												<i />
												<i />
											</span>
											{tr(
												theme === 'brigadir'
													? 'Brigadir'
													: theme === 'vscode'
														? 'VS Code'
														: 'IntelliJ'
											)}
										</button>
									))}
								</div>
							</Field>
							<Field label={tr('Font')} wide>
								<div className={s.fontRow}>
									<Seg
										label={tr('Font')}
										value={other ? '\u0000' : family}
										options={fontOptions}
										onChange={setFamily}
									/>
									{/* Any monospace font of this Mac: the Settings popup, with search, each font in its own face. */}
									<div className={s.fontPicker} data-other={other}>
										<Popup
											label={tr('Other font…')}
											value={family}
											displayValue={
												!other
													? tr('Other font…')
													: family === systemMonoFamily
														? tr('System mono')
														: family
											}
											options={allFonts}
											onChange={setFamily}
											align="end"
											search={{
												placeholder: tr('Search fonts'),
												empty: tr('Nothing found'),
												clear: tr('Clear the field'),
											}}
										/>
									</div>
								</div>
							</Field>
							<div className={s.inline}>
								<Field label={tr('Size')} inline>
									<SizeStepper
										label={tr('Size')}
										min={codeFontSize.min}
										max={codeFontSize.max}
										value={draft.typography.editor.size}
										onChange={(size) =>
											update({
												typography: {
													...draft.typography,
													editor: { ...draft.typography.editor, size },
												},
											})
										}
										increaseLabel={tr('Larger')}
										decreaseLabel={tr('Smaller')}
									/>
								</Field>
								<Field label={tr('Ligatures')} inline>
									<Switch
										label={tr('Ligatures')}
										checked={draft.typography.editor.ligatures}
										onChange={(ligatures) =>
											update({
												typography: {
													...draft.typography,
													editor: { ...draft.typography.editor, ligatures },
												},
											})
										}
									/>
								</Field>
							</div>
							<div className={s.sample}>
								<Code ligatures={draft.typography.editor.ligatures} />
							</div>
							<ListCard>
								<ListRow
									wrap
									title={tr('Language servers')}
									detail={tr(
										'Completion, go to definition, problems. About 0.45 GB of memory for each project.'
									)}
									// spec/settings-modules-and-onboarding#intro-steps, rule 15: the switch rows hover and toggle as a whole.
									onActivate={() =>
										update({
											editor: { ...draft.editor, languageServers: !draft.editor.languageServers },
										})
									}
									control={
										<Switch
											label={tr('Language servers')}
											checked={draft.editor.languageServers}
											onChange={(languageServers) =>
												update({ editor: { ...draft.editor, languageServers } })
											}
										/>
									}
								/>
								<ListRow
									wrap
									title={tr('Format on save')}
									detail={tr('The project Prettier. If there is none, the language server.')}
									onActivate={() =>
										update({
											editor: {
												...draft.editor,
												format: draft.editor.format === 'auto' ? 'off' : 'auto',
											},
										})
									}
									control={
										<Switch
											label={tr('Format on save')}
											checked={draft.editor.format === 'auto'}
											onChange={(on) =>
												update({ editor: { ...draft.editor, format: on ? 'auto' : 'off' } })
											}
										/>
									}
								/>
							</ListCard>
						</Section>
					)}
					{step === 'tasks' && (
						<Section title={tr('Tasks')} sub={tr('Choose how you follow your tasks.')}>
							<div className={s.views}>
								{(['board', 'list'] as const).map((view) => (
									<button
										key={view}
										type="button"
										className={s.view}
										aria-pressed={draft.projects.defaultView === view}
										onClick={() => update({ projects: { defaultView: view } })}>
										<span className={s.viewMini} data-view={view}>
											{view === 'board' ? (
												<>
													<span>
														<i />
														<i />
													</span>
													<span>
														<i data-on />
														<i data-on />
														<i />
													</span>
													<span>
														<i />
													</span>
												</>
											) : (
												<span>
													<b />
													<i />
													<b />
													<i data-on />
													<i data-on />
												</span>
											)}
										</span>
										{tr(view === 'board' ? 'Board' : 'List')}
									</button>
								))}
							</div>
						</Section>
					)}
					{step === 'modules' && (
						<Section
							title={tr('Modules')}
							sub={tr('A module that is off leaves the window, menus and agent tools.')}>
							<ModuleList
								locale={lang}
								modules={draft.modules}
								locked={remoteMachine ? ['remoteAccess'] : []}
								onHover={setHovered}
								onChange={(modules) => update({ modules })}
							/>
						</Section>
					)}
					{step === 'notify' && (
						<Section title={tr('Notifications')}>
							<Field label={tr('When')}>
								<div className={s.options}>
									{(['needs-you', 'turn-ended', 'off'] as const).map((mode) => (
										<button
											key={mode}
											type="button"
											className={s.option}
											aria-pressed={draft.notifications.mode === mode}
											onClick={() => update({ notifications: { ...draft.notifications, mode } })}>
											<i />
											<span>
												<strong>
													{tr(
														mode === 'needs-you'
															? 'When you are needed'
															: mode === 'turn-ended'
																? 'When a turn ends'
																: 'Never'
													)}
												</strong>
												<small>
													{tr(
														mode === 'needs-you'
															? 'The agent asks a question or asks for permission.'
															: mode === 'turn-ended'
																? 'When the agent finishes each turn.'
																: 'Brigadir does not show notifications.'
													)}
												</small>
											</span>
										</button>
									))}
								</div>
							</Field>
							{draft.notifications.mode !== 'off' && (
								<ListCard>
									<ListRow
										title={tr('Sound')}
										onActivate={() =>
											update({
												notifications: {
													...draft.notifications,
													soundMode:
														draft.notifications.soundMode !== 'off'
															? 'off'
															: draft.notifications.mode,
												},
											})
										}
										control={
											<Switch
												label={tr('Sound')}
												checked={draft.notifications.soundMode !== 'off'}
												onChange={(on) =>
													update({
														notifications: {
															...draft.notifications,
															soundMode: on ? draft.notifications.mode : 'off',
														},
													})
												}
											/>
										}
									/>
									{/* spec/architecture-and-platform#linux-package: only macOS has a permission to show; Linux reads `unknown`. */}
									{permission !== null && permission !== 'unknown' && (
										<ListRow
											wrap
											title={tr('macOS permission')}
											detail={tr(
												permission === 'granted'
													? 'Notifications are allowed'
													: permission === 'denied'
														? 'Brigadir notifications are turned off in macOS.'
														: 'Not requested yet. macOS asks one time.'
											)}
											control={
												<>
													{permission === 'not-determined' && (
														<Button
															onClick={() => {
																void window.brigadir
																	.requestNotificationPermission()
																	.catch(() => {});
															}}>
															{tr('Allow')}
														</Button>
													)}
													{permission === 'granted' && <EnvIcon state="ok" />}
												</>
											}
										/>
									)}
								</ListCard>
							)}
						</Section>
					)}
					{step === 'keys' && (
						<Section
							title={tr('Keyboard shortcuts')}
							sub={tr('Choose a keymap and change any shortcut. You see conflicts at once.')}>
							<KeymapEditor
								keymap={draft.keymap}
								locale={lang}
								onChange={(keymap) => update({ keymap })}
							/>
						</Section>
					)}
					{step === 'remote' && (
						<Section
							title={tr('Remote access')}
							sub={tr(
								'Control this machine from Brigadir on another computer: tasks, terminal, browser and simulator run here.'
							)}>
							<RemoteStep status={remote} locale={lang} onStatus={remoteChanged} />
						</Section>
					)}
					{step === 'project' && (
						<Section
							title={tr('First project')}
							sub={tr('The repositories appear in the sidebar on the left.')}>
							{!project ? (
								<div
									className={s.drop}
									data-over={dragging}
									onDragOver={(event) => {
										event.preventDefault();
										setDragging(true);
									}}
									onDragLeave={() => setDragging(false)}
									onDrop={(event) => {
										event.preventDefault();
										setDragging(false);
										const file = event.dataTransfer.files[0];
										if (file) void dropFolder(file);
									}}>
									<Glyph name="folder" size={28} />
									{dropRefused && remoteMachine ? (
										<span role="alert" data-intro-drop-refused>
											{tr(
												'A folder of this computer cannot be a project of {machine}. Choose a folder on {machine}.'
											).replaceAll('{machine}', remoteMachine.name)}
										</span>
									) : (
										<span>{tr('Drag a folder here, or')}</span>
									)}
									<Button
										size="l"
										appearance="primary"
										disabled={scanning}
										onClick={() => {
											void pickFolder();
										}}>
										{tr('Choose a folder…')}
									</Button>
								</div>
							) : (
								<>
									<div className={s.picked}>
										<Glyph name="folder" size={16} />
										<span>
											<strong>{project.name}</strong>
											<small>{project.path}</small>
										</span>
										<Button
											onClick={() => {
												void pickFolder();
											}}>
											{tr('Another folder…')}
										</Button>
									</div>
									<div className={s.repos}>
										{project.scopes.slice(0, shown).map((scope) => (
											<div key={scope.id} className={s.repoRow}>
												<Glyph name="git" size={13} />
												<span>{repoName(scope, project.name)}</span>
												{scope.kind && <small>{tr(kindLabels[scope.kind] ?? 'Folder')}</small>}
											</div>
										))}
									</div>
									{shown >= project.scopes.length && (
										<p className={s.note}>
											{tr('Found ')}
											{project.scopes.length} repo
										</p>
									)}
								</>
							)}
						</Section>
					)}
				</div>
				<footer>
					<Button size="l" variant="ghost" onClick={() => go(flow[Math.max(0, index - 1)]!)}>
						{tr('Back')}
					</Button>
					<span />
					{saveError ? (
						<small role="alert">{tr('The settings could not be saved.')}</small>
					) : (
						step === 'crew' &&
						rolesFailed && <small role="alert">{tr('Could not read the role templates.')}</small>
					)}
					<Button
						size="l"
						appearance="primary"
						className={s.next}
						disabled={step === 'agents' && (noAgents || !environment.check)}
						onClick={next}>
						{tr(step === 'project' ? (project ? 'Done' : 'Later') : 'Next')}
					</Button>
				</footer>
			</section>
			<section className={s.done} data-open={step === 'done'} aria-hidden={step !== 'done'}>
				<h2>{tr('All set')}</h2>
				<p>
					{tr('Settings are always in ')}
					<kbd>{formatAccelerator('CmdOrCtrl+,')}</kbd>
				</p>
				{restartNeeded && <p className={s.note}>{tr('The language will change after restart.')}</p>}
				<div>
					<Button size="xl" variant="ghost" onClick={() => go('look')}>
						{tr('Go through again')}
					</Button>
					{restartNeeded && (
						<Button
							size="xl"
							onClick={() => {
								void finish().then(() => window.brigadir.restartApp());
							}}>
							{tr('Restart')}
						</Button>
					)}
					<Button
						size="xl"
						appearance="primary"
						onClick={() => {
							void finish(true);
						}}>
						{tr('New task')}
						{newTaskKey && <kbd>{newTaskKey}</kbd>}
					</Button>
				</div>
			</section>
		</dialog>
	);
}
/** The intro's segmented control is the system `Segments` (spec/appearance#control-scale). A provider that is not usable stays in the list, switched off:
 *  `Segments` takes only a group-wide `disabled`, so the buttons of the options marked `disabled` are switched off here. */
function Seg({
	label,
	value,
	options,
	onChange,
}: {
	label: string;
	value: string;
	options: { value: string; label: string; icon?: ReactNode; disabled?: boolean }[];
	onChange(value: string): void;
}) {
	const box = useRef<HTMLSpanElement>(null);
	useLayoutEffect(() => {
		box.current?.querySelectorAll<HTMLButtonElement>('[role=radio]').forEach((node, index) => {
			node.disabled = Boolean(options[index]?.disabled);
		});
	});
	return (
		<span ref={box} className={s.seg}>
			<Segments
				label={label}
				value={value}
				options={options}
				onChange={(next) => {
					if (!options.find((option) => option.value === next)?.disabled) onChange(next);
				}}
			/>
		</span>
	);
}
/** spec/settings-modules-and-onboarding#intro: every font size in the intro is a «− N +» stepper within 8–24 px: two M icon buttons round the number. */
function SizeStepper({
	label,
	value,
	min,
	max,
	onChange,
	increaseLabel,
	decreaseLabel,
}: {
	label: string;
	value: number;
	min: number;
	max: number;
	onChange(value: number): void;
	increaseLabel: string;
	decreaseLabel: string;
}) {
	return (
		<div className={s.size} role="group" aria-label={label}>
			<IconButton
				label={decreaseLabel}
				disabled={value <= min}
				onClick={() => onChange(Math.max(min, value - 1))}>
				−
			</IconButton>
			<output aria-live="polite">{value}</output>
			<IconButton
				label={increaseLabel}
				disabled={value >= max}
				onClick={() => onChange(Math.min(max, value + 1))}>
				+
			</IconButton>
		</div>
	);
}
/**
 * spec/settings-modules-and-onboarding#intro-remote: the Remote access step — the scheme, the switch of Settings ▸ Remote and, the first time, the password
 * under it (no Cancel: the switch folds the form back). On, it says where the gateway listens and where devices are
 * added; pairing stays in Settings.
 */
function RemoteStep({
	status,
	locale,
	onStatus,
}: {
	status: RemoteAccessStatus | null;
	locale: Locale;
	onStatus(status: RemoteAccessStatus): void;
}) {
	const tr: Tr = (key) => L(locale, key);
	const [enabling, setEnabling] = useState(false),
		[password, setPassword] = useState(''),
		[again, setAgain] = useState(''),
		[busy, setBusy] = useState(false),
		[failed, setFailed] = useState(false);
	const first = useRef<HTMLInputElement>(null);
	useEffect(() => {
		if (enabling) first.current?.focus();
	}, [enabling]);
	const on = Boolean(status?.enabled);
	const count = [...password].length,
		mismatch = again.length > 0 && again.length >= password.length && again !== password,
		ready = count >= remotePasswordMin && again === password && !busy;
	async function run(action: () => Promise<RemoteAccessStatus>) {
		setBusy(true);
		setFailed(false);
		try {
			const value = await action();
			onStatus(value);
			setRemoteStatus(value);
			return true;
		} catch {
			setFailed(true);
			return false;
		} finally {
			setBusy(false);
		}
	}
	const turnOn = () => {
		if (!ready) return;
		void run(() => window.brigadir.setRemoteAccess(true, password)).then((done) => {
			if (!done) return;
			setEnabling(false);
			setPassword('');
			setAgain('');
		});
	};
	const label = tr('Allow control from other devices');
	const toggle = (value: boolean) => {
		if (!value) {
			if (on) void run(() => window.brigadir.setRemoteAccess(false));
			setEnabling(false);
		} else if (status?.passwordSet) void run(() => window.brigadir.setRemoteAccess(true));
		else setEnabling(true);
	};
	return (
		<>
			<RemoteScheme locale={locale} machine={status?.machineName ?? ''} on={on} />
			<ListCard>
				<ListRow
					tall
					wrap
					lead={
						<ListLead>
							<Glyph name="remote" size={16} />
						</ListLead>
					}
					title={label}
					detail={tr('Needs a password and a one-time pairing of each device.')}
					line={{ 'data-remote-switch': true }}
					onActivate={!status || busy ? undefined : () => toggle(!(on || enabling))}
					control={
						<Switch
							label={label}
							checked={on || enabling}
							disabled={!status || busy}
							onChange={toggle}
						/>
					}
					below={
						enabling && !on ? (
							<div className={s.remoteForm} data-size="m">
								<div className={s.remoteFields}>
									<label>
										{tr('Password')}
										<TextInput
											ref={first}
											type="password"
											size="m"
											aria-label={tr('Password')}
											autoComplete="new-password"
											value={password}
											onChange={(event) => setPassword(event.target.value)}
											onKeyDown={(event) => {
												if (event.key === 'Enter') turnOn();
											}}
										/>
									</label>
									<label>
										{tr('Again (password)')}
										<TextInput
											type="password"
											size="m"
											aria-label={tr('Repeat the password')}
											aria-invalid={mismatch}
											placeholder={tr('Repeat the password')}
											autoComplete="new-password"
											value={again}
											onChange={(event) => setAgain(event.target.value)}
											onKeyDown={(event) => {
												if (event.key === 'Enter') turnOn();
											}}
										/>
									</label>
								</div>
								{mismatch ? (
									<small data-error>{tr('The passwords do not match.')}</small>
								) : (
									<small>
										{tr('At least 10 characters · now {count}').replace('{count}', String(count))}
									</small>
								)}
								<div className={s.remoteActions}>
									<Button
										appearance="primary"
										disabled={!ready}
										onClick={turnOn}
										data-remote-enable>
										{tr('Turn on')}
									</Button>
								</div>
							</div>
						) : on && status ? (
							<div className={s.remoteState} data-remote-status>
								<EnvIcon state={status.listening.length ? 'ok' : 'warn'} />
								<span>
									<b>
										{status.listening.length ? (
											<>
												{tr('Listening · {networks}').replace('{networks}', '')}
												{listeningParts(status.listening, s.mono!)}
											</>
										) : (
											tr('Not listening: no LAN or Tailscale network.')
										)}
									</b>
									<small>
										{tr('Port {port}. No port forwarding on the router.').replace(
											'{port}',
											String(status.port)
										)}
									</small>
								</span>
							</div>
						) : undefined
					}
				/>
			</ListCard>
			{failed && (
				<p className={s.note} role="alert" data-error>
					{tr('Could not change remote access.')}
				</p>
			)}
			{on ? (
				<>
					<RemoteFacts locale={locale} network />
					<p className={s.note}>{tr('Add devices in Settings ▸ Remote.')}</p>
				</>
			) : (
				<RemoteFacts locale={locale} />
			)}
		</>
	);
}
function Section({ title, sub, children }: { title: string; sub?: string; children: ReactNode }) {
	return (
		<>
			<h2 className={s.title}>{title}</h2>
			{sub && <p className={s.sub}>{sub}</p>}
			<div className={s.fields}>{children}</div>
		</>
	);
}
function Field({
	label,
	value,
	inline = false,
	wide = false,
	children,
}: {
	label: string;
	value?: string;
	inline?: boolean;
	wide?: boolean;
	children: ReactNode;
}) {
	return (
		<div className={s.field} data-inline={inline} data-wide={wide}>
			<span>
				{label}
				{value && <small>{value}</small>}
			</span>
			{children}
		</div>
	);
}
/** The theme card's preview: a small window in that palette's own tokens (tokens.css `[data-palette]`). */
function Mini({ palette, half = false }: { palette: 'light' | 'dark'; half?: boolean }) {
	return (
		<span className={s.mini} data-palette={palette} data-half={half}>
			<i />
			<span>
				<b />
				<b />
			</span>
		</span>
	);
}
/** Environment check state beside a row. */
function EnvIcon({ state, size = 16 }: { state: EnvState; size?: number }) {
	return (
		<span className={s.env} data-state={state} style={{ width: size, height: size }}>
			{state === 'spin' ? (
				<i />
			) : (
				<Glyph
					name={state === 'ok' ? 'env-ok' : state === 'warn' ? 'env-warn' : 'env-miss'}
					size={size}
				/>
			)}
		</span>
	);
}
/** A provider's glyph; Claude's is in its own colour. */
function Provider({ provider, size = 12 }: { provider: AgentProviderId; size?: number }) {
	return (
		<span className={s.provider} data-provider={provider}>
			<Glyph name={provider === 'claude' ? 'claude' : 'openai'} size={size} />
		</span>
	);
}
const codeLines: ReactNode[] = [
	<span className="syntax-comment">{'/** User-facing dates are European. */'}</span>,
	<>
		<span className="syntax-keyword">export function</span>{' '}
		<span className="syntax-function">formatDate</span>(value:{' '}
		<span className="syntax-type">DateValue</span>): <span className="syntax-type">string</span>{' '}
		{'{'}
	</>,
	<>
		{' '}
		<span className="syntax-keyword">const</span> <span className="syntax-function">part</span> =
		(type: <span className="syntax-type">string</span>) =&gt;
	</>,
	<>
		{' '}
		parts.<span className="syntax-function">find</span>((p) =&gt; p.
		<span className="syntax-property">type</span> === type)!.
		<span className="syntax-property">value</span>;
	</>,
	<>
		{' '}
		<span className="syntax-keyword">return</span>{' '}
		<span className="syntax-string">{"`${part('day')}.${part('month')}`"}</span>;
	</>,
	<>{'}'}</>,
];
/** The code sample with its line numbers, as the editor draws it. */
function Code({ ligatures }: { ligatures: boolean }) {
	return (
		<div className={s.code} data-ligatures={ligatures}>
			{codeLines.map((line, i) => (
				<div key={i}>
					<span>{i + 1}</span>
					<code>{line}</code>
				</div>
			))}
		</div>
	);
}
type CrewProviders = {
	foreman: AgentProviderId;
	developer: AgentProviderId;
	reviewer: AgentProviderId;
};
/* spec/settings-modules-and-onboarding#intro-steps (rule 17): the sample window is drawn by the app's own components at rest — the sidebar's crew card, the
   foreman's PlanCard, the composer island and the project board. Their data is made up here; nothing is read or sent through
   main, and the window is inert, so no control acts. */
const sampleProject = 'intro-sample',
	sampleAt = '2026-01-01T00:00:00.000Z';
const noop = () => {};
/** The built-in crew (spec/crew-templates-and-editor#builtin-templates) as a task snapshots it, with the providers the Crew step picked (spec/settings-modules-and-onboarding#intro-crew). */
function sampleSpec(providers: CrewProviders): CrewSpec {
	const role: Record<string, AgentProviderId> = {
		[foremanTemplateId]: providers.foreman,
		[developerTemplateId]: providers.developer,
		[reviewerTemplateId]: providers.reviewer,
	};
	return resolveCrew(
		builtinCrewTemplates.find((item) => item.id === defaultCrewTemplateId)!,
		{
			lookup: templateLookup(
				builtinAgentTemplates.map((item) => ({
					...item,
					provider: role[item.id] ?? providers.foreman,
				}))
			),
			defaultProvider: providers.foreman,
			now: sampleAt,
		}
	);
}
/** The foreman's task with its plan waiting for the person, and its workers waiting for the plan (spec/settings-modules-and-onboarding#intro-crew). */
function sampleCrew(providers: CrewProviders, tr: Tr) {
	const spec = sampleSpec(providers);
	const foreman: AgentTask = {
		id: 'intro-crew',
		projectId: sampleProject,
		title: tr('Orders export'),
		status: 'needs-you',
		provider: providers.foreman,
		crew: spec,
		activity: { kind: 'plan', title: tr('The foreman proposes a split'), path: null },
		taskTree: { branch: 'brigadir/orders-csv', worktree: true },
		updatedAt: sampleAt,
	};
	const worker = (node: string, title: string, provider: AgentProviderId): AgentTask => ({
		id: `intro-${node}`,
		projectId: sampleProject,
		title: tr(title),
		status: 'backlog',
		provider,
		crewTaskId: foreman.id,
		crewNodeId: node,
		parentTaskId: foreman.id,
		updatedAt: sampleAt,
	});
	return {
		spec,
		foreman,
		tasks: [
			foreman,
			worker('developer-1', 'CSV export', providers.developer),
			worker('developer-2', 'Table button', providers.developer),
			worker('reviewer', 'checks both', providers.reviewer),
		],
	};
}
/** spec/settings-modules-and-onboarding#intro-crew: the Brigadir card of the built-in crew in the sidebar (spec/sidebar#layout, spec/crew-templates-and-editor#after-launch) — the sidebar's own `CrewCard`. */
function SampleCrewCard({
	ref,
	open,
	providers,
	tr,
}: {
	ref: RefObject<HTMLDivElement | null>;
	open: boolean;
	providers: CrewProviders;
	tr: Tr;
}) {
	const crew = sampleCrew(providers, tr);
	return (
		<div ref={ref} className={s.crewCard} data-open={open}>
			<CrewCard task={crew.foreman} tasks={crew.tasks} onMenu={noop} onOpen={noop} preview />
		</div>
	);
}
/** spec/settings-modules-and-onboarding#intro-crew: the crew tree; work runs down the edges, through the review and up to the foreman. */
function CrewTree({ providers, tr }: { providers: CrewProviders; tr: Tr }) {
	const node = (key: string, name: string, does: string, provider: AgentProviderId) => (
		<div className={s.node} data-node={key}>
			<strong>
				<Provider provider={provider} />
				{tr(name)}
			</strong>
			<small>{tr(does)}</small>
		</div>
	);
	return (
		<div className={s.tree} aria-hidden="true">
			<i className={s.edge} data-edge="root" />
			<i className={s.edge} data-edge="bus" />
			<i className={s.edge} data-edge="a" />
			<i className={s.edge} data-edge="b" />
			<i className={s.edge} data-edge="c" />
			<i className={s.check} data-edge="a" />
			<i className={s.check} data-edge="b" />
			<i className={s.check} data-edge="c" />
			<i className={s.check} data-edge="bus" />
			<span className={s.checkLabel}>{tr('checks')}</span>
			{node('root', 'Foreman', 'divides and accepts', providers.foreman)}
			{node('a', 'Developer 1', 'writes code', providers.developer)}
			{node('b', 'Developer 2', 'writes code', providers.developer)}
			{node('c', 'Reviewer', 'writes no code', providers.reviewer)}
			<b className={s.dot} data-run="down-a" />
			<b className={s.dot} data-run="down-b" />
			<b className={s.dot} data-run="check-a" />
			<b className={s.dot} data-run="check-b" />
			<b className={s.dot} data-run="up-a" />
			<b className={s.dot} data-run="up-b" />
		</div>
	);
}
/** The capsule's options as an agent advertises them (rule 7): the model and its effort, nothing else off its default. */
function sampleOptions(provider: AgentProviderId, tr: Tr): AgentOption[] {
	const model =
		provider === 'claude'
			? { value: 'opus', name: 'Opus 5.5' }
			: { value: 'gpt-5.5', name: 'gpt-5.5' };
	return [
		{
			id: 'model',
			name: tr('Model'),
			description: null,
			category: 'model',
			kind: 'select',
			value: model.value,
			choices: [{ ...model, description: null, group: null }],
		},
		{
			id: provider === 'claude' ? 'effort' : 'reasoning_effort',
			name: tr('Effort'),
			description: null,
			category: 'effort',
			kind: 'select',
			value: 'high',
			choices: [
				['low', 'Low'],
				['medium', 'Medium'],
				['high', 'High'],
			].map(([value, name]) => ({ value: value!, name: name!, description: null, group: null })),
		},
	];
}
/** spec/composer#agent-capsule: the composer island of the chat at rest — the empty field's key hint, `+`, the capsule and Send M 28, the
 *  environment footer. A provider picked on the Agents step rolls the capsule in. */
function SampleComposer({
	task,
	provider,
	locale,
	tr,
}: {
	task: AgentTask;
	provider: AgentProviderId;
	locale: Locale;
	tr: Tr;
}) {
	return (
		<ComposerIsland className={s.composer}>
			<ComposerText
				placeholder={t(locale, '{send} send · {newline} new line · @ files · / commands')
					.replace('{send}', formatAccelerator('Enter'))
					.replace('{newline}', formatAccelerator('Shift+Enter'))}
			/>
			<ComposerBar
				attach={
					<IconButton label={tr('Attach files')}>
						<Glyph name="plus" size={15} />
					</IconButton>
				}>
				<span key={provider} className={s.capsule}>
					<ComposerOptions
						options={sampleOptions(provider, tr)}
						provider={provider}
						locale={locale}
						disabled={false}
					/>
				</span>
				<ComposerSend
					locale={locale}
					busy={false}
					steers={false}
					filled={false}
					stopDisabled
					sendDisabled
					stopShortcut={undefined}
					queueShortcut={undefined}
					onStop={noop}
					onSendNow={noop}
					onQueue={noop}
				/>
			</ComposerBar>
			<ComposerEnvironment task={task} locale={locale} />
		</ComposerIsland>
	);
}
/** spec/chat-turns-plans-and-questions#plan-row: the foreman's plan waiting for the person — the chat's own `PlanCard`, without a task behind it. */
function SampleBrief({
	providers,
	locale,
	tr,
}: {
	providers: CrewProviders;
	locale: Locale;
	tr: Tr;
}) {
	const crew = sampleCrew(providers, tr);
	const plan: CrewPlan = {
		id: 'intro-plan',
		summary: tr(
			'There are two independent parts. I give them to two developers. The reviewer checks both.'
		),
		parts: [
			{
				id: 'part-1',
				title: tr('CSV export'),
				agent: 'Developer 1',
				prompt: tr(
					'Add ordersToCsv(rows) to orders/export.ts: an id,total header and one line for each order. Your files: orders/export.ts.'
				),
				files: ['orders/export.ts'],
				scopes: ['choice'],
			},
			{
				id: 'part-2',
				title: tr('Export button in the table'),
				agent: 'Developer 2',
				prompt: tr(
					'Add an Export button to the orders table toolbar. It calls ordersToCsv. Your files: orders/OrdersTable.tsx.'
				),
				files: ['orders/OrdersTable.tsx'],
				scopes: ['choice'],
			},
		],
	};
	return (
		<div className={s.brief}>
			<PlanCard
				key={locale}
				plan={plan}
				spec={crew.spec}
				task={null}
				revision={0}
				locale={locale}
				disabled={false}
				send={noop}
			/>
		</div>
	);
}
function Chat({
	terminal,
	provider,
	crew,
	providers,
	locale,
	tr,
	tabbed = false,
}: {
	terminal: boolean;
	provider: 'claude' | 'codex';
	crew: 'card' | 'chat' | null;
	providers: CrewProviders;
	locale: Locale;
	tr: Tr;
	/** spec/task-window-workspace#two-columns: two columns — the chat is the pinned first tab of the work area, a file tab after the divider. */
	tabbed?: boolean;
}) {
	return (
		<>
			{tabbed ? (
				<h4 data-tabbed>
					<code className={s.tab} data-on>
						<Glyph name={terminal ? 'console' : 'chat'} size={11} />
						{terminal ? 'CLI' : tr('Chat')}
					</code>
					<i className={s.tabSep} aria-hidden="true" />
					<code>date-time.ts</code>
				</h4>
			) : (
				<h4>{terminal && !crew ? 'CLI' : tr('Chat')}</h4>
			)}
			<div className={s.crewChat} data-hidden={!crew}>
				<p className={s.ask}>{tr('Add a CSV export for orders')}</p>
				{crew === 'chat' && <SampleBrief providers={providers} locale={locale} tr={tr} />}
				<SampleComposer
					task={sampleCrew(providers, tr).foreman}
					provider={providers.foreman}
					locale={locale}
					tr={tr}
				/>
			</div>
			<div className={s.gui} data-hidden={terminal || Boolean(crew)}>
				<p className={s.ask}>{tr('Add a CSV export for orders')}</p>
				<p>{tr('I will look at how the orders table is built now.')}</p>
				<div className={s.tools}>
					<p className={s.tool}>
						<i />
						Read <code>orders/OrdersTable.tsx</code>
					</p>
					<p className={s.tool}>
						<i />
						Edit <code>orders/export.ts</code>
						<ins>+42</ins>
						<del>−3</del>
					</p>
				</div>
				<p>{tr('Done. The Export button is now in the table toolbar.')}</p>
				<SampleComposer
					task={sampleTask(provider, tr)}
					provider={provider}
					locale={locale}
					tr={tr}
				/>
			</div>
			<div className={s.cli} data-hidden={!terminal || Boolean(crew)}>
				<p className={s.capsuleLine} data-provider={provider}>
					<b data-on={provider === 'claude'}>
						<Provider provider="claude" />
						Claude Code · ~/projects/shop
					</b>
					<b data-on={provider === 'codex'}>
						<Glyph name="openai" size={12} />
						codex · ~/projects/shop
					</b>
				</p>
				<p>
					<em>&gt;</em> {tr('Add a CSV export for orders')}
				</p>
				<p>
					<ins>●</ins> Read(orders/OrdersTable.tsx)
				</p>
				<p className={s.dim}> ⎿ {tr('214 lines')}</p>
				<p>
					<ins>●</ins> Edit(orders/export.ts)
				</p>
				<p className={s.dim}>
					{' '}
					⎿ <ins>+42</ins> <del>−3</del>
				</p>
				<p>{tr('Done. The Export button is now in the table toolbar.')}</p>
				<p className={s.prompt}>
					<em>&gt;</em>
					<span />
				</p>
				<p className={s.dim}>⏵⏵ accept edits on</p>
			</div>
		</>
	);
}
function Changes({
	base,
	crew,
	panel,
	tr,
}: {
	base: 'task' | 'head';
	crew: boolean;
	/** spec/settings-modules-and-onboarding#intro-remote: from the Modules step on, the panel's Files · Changes · PR, PR only while its module is on. */ panel?:
		{ pr: boolean; ref: RefObject<HTMLElement | null> } | undefined;
	tr: Tr;
}) {
	return (
		<>
			{panel ? (
				<h4>
					<span className={s.panelSeg}>
						<b>{tr('Files')}</b>
						<b data-on>{tr('Changes')}</b>
						{panel.pr && <b ref={panel.ref}>PR</b>}
					</span>
					<small className={s.sum}>
						{base === 'task' ? (
							<>
								<ins>+128</ins> <del>−41</del>
							</>
						) : (
							<>
								<ins>+12</ins> <del>−3</del>
							</>
						)}
					</small>
				</h4>
			) : (
				<h4>
					{tr('Changes')}
					<small className={s.roll}>
						<b data-on={base === 'task'}>
							{tr('since task start')} · <ins>+128</ins> <del>−41</del>
						</b>
						<b data-on={base === 'head'}>
							{tr('since last commit')} · <ins>+12</ins> <del>−3</del>
						</b>
					</small>
				</h4>
			)}
			<div className={s.diff} data-dim={crew}>
				<p className={s.file}>
					orders/export.ts<ins>+42</ins>
					<del>−3</del>
				</p>
				<p data-kind="del">- // TODO: export</p>
				<p data-kind="add">+ export function ordersToCsv(rows) {'{'}</p>
				<p data-kind="add">+ const head = ['id', 'total'].join(',');</p>
				<p data-kind="add">+ return [head, ...rows.map(toLine)];</p>
				<p data-kind="add">+ {'}'}</p>
				<p className={s.file}>
					orders/OrdersTable.tsx<ins>+6</ins>
					<del>−0</del>
				</p>
				<p data-kind="add">+ &lt;ExportButton rows={'{rows}'} /&gt;</p>
			</div>
		</>
	);
}
/** The task the chat shows: its worktree, branch and changes in the island's footer. */
const sampleTask = (provider: AgentProviderId, tr: Tr): AgentTask => ({
	id: 'intro-task',
	projectId: sampleProject,
	title: tr('Orders export'),
	status: 'done',
	provider,
	taskTree: { branch: 'brigadir/orders-csv', worktree: true },
	changeSummary: { additions: 48, deletions: 3 },
	updatedAt: sampleAt,
});
/** ProjectScreen «All projects» (spec/projects-and-board#board) for the Tasks step, on the project screen's own parts. */
const boardColumnLabels: Record<BoardColumn, string> = {
	backlog: 'Backlog',
	progress: 'In progress',
	completed: 'Completed',
};
/** Status, provider, model, effort, branch, title, description, minutes since the last change. */
const boardSample: [
	BoardColumn,
	[
		AgentTask['status'],
		AgentProviderId,
		string | null,
		string | null,
		string | null,
		string,
		string,
		number,
	][],
][] = [
	[
		'backlog',
		[
			[
				'backlog',
				'claude',
				'Sonnet 5',
				'medium',
				null,
				'Move to a pnpm workspace',
				'Put kit and apps/* in one workspace and remove duplicate dependencies.',
				1440,
			],
			[
				'backlog',
				'claude',
				'Opus 5.5',
				'high',
				null,
				'Dark theme for the admin',
				'Color tokens from kit and a switch in the profile.',
				2880,
			],
		],
	],
	[
		'progress',
		[
			[
				'needs-you',
				'claude',
				'Opus 5.5',
				'high',
				'feat/loyalty',
				'Loyalty 1+1',
				'A free second coffee for regular guests.',
				3,
			],
			[
				'working',
				'claude',
				'Opus 5.5',
				'medium',
				'feat/orders-csv',
				'Orders CSV export',
				'A button in the orders table toolbar.',
				0,
			],
			[
				'queued',
				'codex',
				null,
				null,
				null,
				'Fix the time zone in reports',
				'Daily reports count from UTC, not from the venue time.',
				12,
			],
		],
	],
	[
		'completed',
		[
			[
				'completed',
				'claude',
				'Sonnet 5',
				'medium',
				'feat/menu-cdn',
				'Menu cache on a CDN',
				'The menu comes from a CDN and refreshes on publish.',
				300,
			],
		],
	],
];
function Board({
	list,
	open,
	prs,
	locale,
	tr,
}: {
	list: boolean;
	open: boolean;
	/** The Pull requests tab, while its module is on (spec/projects-and-board#pr-mode). */ prs: boolean;
	locale: Locale;
	tr: Tr;
}) {
	const [now] = useState(() => Date.now());
	// spec/projects-and-board#pr-mode: in a window up to 1050 px the view switch keeps only its glyphs, as on the project screen.
	const [narrow, setNarrow] = useState(() => matchMedia('(max-width: 1050px)').matches);
	useEffect(() => {
		const query = matchMedia('(max-width: 1050px)'),
			change = () => setNarrow(query.matches);
		query.addEventListener('change', change);
		return () => query.removeEventListener('change', change);
	}, []);
	const columns = boardSample.map(([column, rows]) => ({
		column,
		tasks: rows.map(
			(
				[status, provider, model, effort, branch, title, description, minutes],
				index
			): AgentTask => ({
				id: `intro-${column}-${index}`,
				projectId: sampleProject,
				title: tr(title),
				prompt: tr(description),
				status,
				provider,
				...(model ? { modelName: model } : {}),
				...(effort ? { effortName: effort } : {}),
				...(branch ? { worktreeBranch: branch } : {}),
				updatedAt: new Date(now - minutes * 60_000).toISOString(),
			})
		),
	}));
	const count = columns.reduce((sum, item) => sum + item.tasks.length, 0);
	return (
		<div className={s.board} data-open={open}>
			<ProjectTitlebar title={tr('All projects')}>
				<IconButton label={tr('Search Everywhere')}>
					<Glyph name="search" size={15} />
				</IconButton>
			</ProjectTitlebar>
			<ProjectToolbar
				tabs={
					<Segments
						underline
						tablist
						label={tr('Project tabs')}
						value="tasks"
						options={[
							{
								value: 'tasks',
								label: tr('Tasks'),
								icon: <Glyph name="base-task" size={13} />,
								tail: String(count),
							},
							...(prs
								? [
										{
											value: 'prs',
											label: tr('Pull requests (tab)'),
											icon: <Glyph name="pr-branch" size={13} />,
											tail: '',
										},
									]
								: []),
						]}
						onChange={noop}
					/>
				}>
				<Segments
					label={tr('Project view')}
					value={list ? 'list' : 'board'}
					iconOnly={narrow}
					options={[
						{ value: 'board', label: tr('Board'), icon: <Glyph name="board" size={13} /> },
						{ value: 'list', label: tr('List'), icon: <Glyph name="list" size={13} /> },
					]}
					onChange={noop}
				/>
			</ProjectToolbar>
			<BoardColumns view={list ? 'list' : 'board'} key={list ? 'list' : 'board'}>
				{columns.map(({ column, tasks }) => (
					<BoardColumnView
						key={column}
						column={column}
						label={tr(boardColumnLabels[column])}
						count={tasks.length}
						action={
							column === 'completed' && (
								<IconButton size="s" label={tr('Archive the list')}>
									<Glyph name="archive-box" size={13} />
								</IconButton>
							)
						}>
						{tasks.map((task) => (
							<BoardCard
								key={task.id}
								task={task}
								locale={locale}
								all
								project={{ name: 'choice' }}
								slot={0}
								now={now}
								live={0}
								// As on the board: a chip opens a menu where the agent has told its options — a backlog task from the
								// catalog, a finished one from its session; a queued task has none yet.
								selectable={() => task.status === 'backlog' || task.status === 'completed'}
								aria-label={task.title}
							/>
						))}
					</BoardColumnView>
				))}
			</BoardColumns>
		</div>
	);
}
