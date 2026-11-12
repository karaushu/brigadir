import { setTaskBrowser, setTaskSimulator, showTaskDiff } from './task-state';
import { followBoardFocus } from './board-focus';
import { onSessionEvent } from './session-events';
import { workspaceEventKinds } from './workspace-events';
import { statusLabels } from './task-line';
import { useSidebarOrder } from './use-sidebar-order';
import { RenameTask } from './RenameTask';
import { AgentsProvider, AgentsButton } from './LiveAgents';
import { RejectedKnowledge } from './Knowledge';
import { ForgeProvider, ForgeToast } from './Forge';
import { PullRequestsProvider } from './PullRequests';
import { CIWatchEvents } from './CIRuns';
import { NotificationBell, NotificationCenterEvents } from './NotificationCenter';
import { LockConflict } from './LockConflict';
import type { LaunchConflict, TaskProposal } from '@brigadir/core';
import { ProjectScreen } from './ProjectScreen';
import { NotesScreen } from './NotesScreen';
import type { NoteSelection } from './NoteEditor';
import {
	relativeAge,
	projectColors,
	sidebarTasks,
	sidebarMatches,
	type SidebarFilter,
	layoutLimits,
} from '@brigadir/core';
import {
	ArchiveHeaderButton,
	ArchiveToast,
	ArchiveWindow,
	SwipeToArchive,
	archiveTask,
	showArchiveToast,
} from './Archive';
import {
	archivedTasks,
	archiveSoon,
	canArchive,
	defaultArchiveAfterDays,
	scheduleState,
} from '@brigadir/core';
import { TitleMark } from './ui/TitleMark';
import { ProjectIcon, projectToneStyle } from './ui/ProjectIcon';
import { ProjectIconPicker } from './ProjectIconPicker';
import { usePresence } from './ui/use-presence';
import { QuotaButton } from './Quota';
import { SectionsRail, SettingsTile } from './SectionsRail';
import { SidebarPRs } from './SidebarPRs';
import { SidebarNotes } from './SidebarNotes';
import { SidebarSchedules } from './SidebarSchedules';
import { SchedulesScreen, useSchedules } from './SchedulesScreen';
import { requestPRReview } from './pr-section';
import { useBoardPRs } from './ProjectPRs';
import { SidebarFilterButton } from './SidebarFilter';
import { announceMenuContext, useMenuContext } from './menu-context';
import { askRemoteChip, followRemote, remoteMachine, useRemote } from './remote-store';
import { RemoteDialogs } from './RemoteDialogs';
import {
	RemoteCover,
	RemoteWindowChip,
	RemoteWindowState,
	remoteNoticeToast,
	type OpenRemoteSettings,
} from './RemoteChrome';
import { RemoteConnect } from './RemoteConnect';
import type { RemoteDialog, RemotePart } from './RemoteSettings';
import { useRestoreSelection } from './use-restore-selection';
import { SearchField } from './ui/PanelSearch';
import { useSurfaceLayout } from './surface-layout';
import { ResizeHandle } from './ui/ResizeHandle';
import {
	type CSSProperties,
	Fragment,
	memo,
	useCallback,
	useEffect,
	useLayoutEffect,
	useMemo,
	useRef,
	useState,
} from 'react';
import {
	type SettingsTab,
	formatAccelerator,
	waitingCount,
	withShortcut,
	commandAccelerator,
	defaultKeymap,
	matchesAccelerator,
	menuCommands,
	textSurfaces,
	resizedTypography,
	type TextSurface,
	type Locale,
	t,
	taskCount,
	type AgentTask,
	type NoteDocument,
	type MessageKey,
	type ReadIssueCode,
} from '@brigadir/core';
import { useWorkspace } from './store';
import { useCommandShortcut } from './ui/use-command-shortcut';
import { TaskView } from './TaskView';
import { NewTask } from './NewTask';
import { QuickTask, type QuickTaskRequest } from './QuickTask';
import { resolveToast, showToast, toastError, toastWarning, ToastHost } from './ui/Toast';
import { AppUpdateToasts } from './AppUpdates';
import { LayoutSettings } from './LayoutSettings';
import { Intro } from './Intro';
import { AppMenuButton } from './ui/AppMenuButton';
import { useApplyAppearance } from './apply-appearance';
import { Search, type SearchMode } from './Search';
import { CommandEditorHost, useCommandEditor } from './ProjectCommands';
import { ReviewLaunchHost, openReviewNotes } from './ReviewLaunch';
import { Kit } from './Kit';
import { SurfaceBoundary } from './ui/ErrorBoundary';
import { Glyph } from './ui/Glyph';
import { StatusIcon, Button, IconButton } from './ui/Controls';
import { useNotificationPermission } from './use-notification-permission';
import styles from './App.module.css';
import { setSimulatorWaiting } from './simulator-waiting';
import { CrewCard, TaskRow } from './SidebarTasks';
import {
	collapseCompleted,
	loadCollapsedCompleted,
	useCompletedCollapse,
} from './completed-collapse';
import { SkeletonRows } from './ui/Loading';

const issueLabels: Record<ReadIssueCode, MessageKey> = {
	invalid_document: 'The file is invalid.',
	unsupported_schema: 'The file uses a newer schema.',
	unreadable: 'The file could not be read.',
	unsafe_path: 'The data location is not allowed.',
};
/** A collapsed project's needs-you count pops when it grows, never when it first renders. */
function ProjectAttention({ count, label }: { count: number; label: string }) {
	const previous = useRef(count),
		grew = useRef(0);
	if (previous.current !== count) {
		if (count > previous.current) grew.current++;
		previous.current = count;
	}
	if (!count) return null;
	return (
		<span
			key={grew.current}
			className={styles.projectAttention}
			data-attention={grew.current > 0 || undefined}
			title={label}>
			<Glyph name="sidebar-needs" size={11} />
			{count}
		</span>
	);
}
/** spec/notifications-slack-notes-and-schedules#macos-permission, spec/notifications-slack-notes-and-schedules#toasts: while notifications are wanted and macOS refuses them, one warning toast per refusal; it leaves when macOS allows them or «When» is Never. */
function NotificationToast({
	locale,
	mode,
}: {
	locale: Locale;
	mode: 'off' | 'needs-you' | 'turn-ended';
}) {
	const permission = useNotificationPermission(),
		shown = useRef(false);
	useEffect(() => {
		if (permission !== 'denied' || mode === 'off') {
			shown.current = false;
			resolveToast(t(locale, 'Notifications are turned off in macOS'));
			return;
		}
		if (shown.current) return;
		shown.current = true;
		toastWarning(t(locale, 'Notifications are turned off in macOS'), {
			action:
				window.brigadir.chromePlatform === 'darwin'
					? {
							label: t(locale, 'Open System Settings'),
							run: () => {
								void window.brigadir.openNotificationSettings().catch(() => {});
							},
						}
					: undefined,
		});
	}, [permission, mode, locale]);
	return null;
}
/**
 * spec/sidebar#done-rows: a completed task is a quiet 30 px row, not a card: tick, title, unread dot, archive-soon clock, age. The row hovers as a whole;
 * under the pointer or focus the age gives way to the «Archive» button (its own hover), when the task can go to the archive (spec/tasks#archive).
 * The primary button fills the row and holds the text; the archive button is a sibling raised above it, so it never opens the task.
 */
const CompletedRow = memo(function CompletedRow({
	task,
	archivable,
	onMenu,
	onOpen,
}: {
	task: AgentTask;
	archivable: boolean;
	onMenu(task: AgentTask): void;
	onOpen(task: AgentTask): void;
}) {
	const locale = useWorkspace((state) => state.appearance.locale),
		selected = useWorkspace(
			(state) =>
				state.selectedTask?.id === task.id && state.selectedTask.projectId === task.projectId
		);
	const soon = archiveSoon(
			task,
			useWorkspace((state) => state.appearance.archiveAfterDays) ?? defaultArchiveAfterDays,
			Date.now()
		),
		statusText = t(locale, statusLabels[task.status]),
		archiveKey = useCommandShortcut()('archive-task');
	return (
		<div
			className={styles.doneRow}
			data-done-row
			data-selected={selected}
			data-archivable={archivable}>
			<button
				type="button"
				className={styles.doneMain}
				data-sidebar-task={task.id}
				data-sidebar-order={`${task.projectId}/${task.id}`}
				data-pinned={!!task.pinned}
				data-status={task.status}
				title={`${task.title}${task.pinned ? ' · ' + t(locale, 'Pinned') : ''} · ${statusText}`}
				aria-pressed={selected}
				onClick={() => onOpen(task)}
				onContextMenu={(event) => {
					event.preventDefault();
					onMenu(task);
				}}
				onKeyDown={(event) => {
					if (event.key === 'ContextMenu' || (event.shiftKey && event.key === 'F10')) {
						event.preventDefault();
						onMenu(task);
					}
				}}>
				<StatusIcon status={task.status} label={statusText} size={16} />
				<span className={styles.doneTitle}>{task.title}</span>
				{task.hasUnread && (
					<span
						className={styles.doneUnread}
						aria-label={t(locale, 'Unread')}
						title={t(locale, 'Unread')}
					/>
				)}
				{soon && (
					<TitleMark
						icon="clock"
						className={styles.doneSoon}
						data-archive-soon={soon}
						title={t(
							locale,
							soon === 'today' ? 'Goes to the archive today' : 'Goes to the archive tomorrow'
						)}
					/>
				)}
				<span className={styles.doneAge}>
					{relativeAge(locale, task.completedAt ?? task.updatedAt)}
				</span>
				{archivable && <span className={styles.doneSlot} aria-hidden="true" />}
			</button>
			{archivable && (
				<IconButton
					size="s"
					className={styles.doneArchive}
					label={t(locale, 'Archive')}
					hint={withShortcut(t(locale, 'Archive'), archiveKey)}
					data-done-archive
					onClick={() => {
						void archiveTask(task).catch(() =>
							toastError(t(locale, 'Could not archive the task.'))
						);
					}}>
					<Glyph name="archive-box" size={14} />
				</IconButton>
			)}
		</div>
	);
});
const pcChrome = window.brigadir.chromePlatform !== 'darwin';
export function App() {
	const [renaming, setRenaming] = useState<AgentTask | null>(null);
	const [knowledgeProject, setKnowledgeProject] = useState<string | null>(null);
	const knowledgePresent = usePresence(Boolean(knowledgeProject)),
		lastKnowledgeProject = useRef(knowledgeProject);
	if (knowledgeProject) lastKnowledgeProject.current = knowledgeProject;
	const [launchConflict, setLaunchConflict] = useState<LaunchConflict | null>(null);
	useEffect(() => {
		let active = true,
			received = false;
		const stop = window.brigadir.onLaunchConflict((value) => {
			received = true;
			setLaunchConflict(value);
		});
		void window.brigadir
			.readLaunchConflict()
			.then((value) => {
				if (active && !received) setLaunchConflict(value);
			})
			.catch(() => {});
		return () => {
			active = false;
			stop();
		};
	}, []);
	useEffect(() => {
		void useSurfaceLayout.getState().load();
	}, []);
	const {
		workspace,
		appearance,
		error,
		selectedTask,
		selectedProject,
		selectProject,
		load,
		setAppearance,
		mainTree,
		notes: notesRoute,
		openNotes,
		schedules: schedulesRoute,
		openSchedules,
		openScheduleTask,
	} = useWorkspace();
	// spec/notifications-slack-notes-and-schedules#notes: the Notes screen, while its module is on.
	const notesOpen = !!notesRoute && appearance.modules.notes;
	// spec/notifications-slack-notes-and-schedules#schedules: the Schedules section, while its module is on; a run's task opened from it keeps the section's sidebar.
	const schedulesOpen = !!schedulesRoute && appearance.modules.schedules;
	const allSchedules = useSchedules();
	/** spec/notifications-slack-notes-and-schedules#schedules: the rail's dot — red when a last run failed, amber when missed slots wait, accent while a run works. */
	const scheduleDot = (() => {
		if (!allSchedules || !workspace) return null;
		const states = allSchedules.map((item) => scheduleState(item, workspace.tasks));
		return states.includes('failed')
			? 'var(--red)'
			: states.includes('ask')
				? 'var(--amber)'
				: states.includes('running')
					? 'var(--accent)'
					: null;
	})();
	const [quietRuns, setQuietRuns] = useState(false);
	const [statusFilter, setStatusFilter] = useState<SidebarFilter>(null),
		[collapsedProjects, setCollapsedProjects] = useState<string[]>([]),
		[filteredCollapsed, setFilteredCollapsed] = useState<string[]>([]),
		[sidebarReady, setSidebarReady] = useState(false);
	const sidebarRevision = useRef(0),
		sidebarWrites = useRef(Promise.resolve());
	// spec/sidebar#completed-fold: projects whose completed tasks are folded; read once, open by default.
	const completedFolded = useCompletedCollapse((state) => state.collapsed);
	useEffect(() => {
		void loadCollapsedCompleted();
	}, []);
	async function loadSidebar() {
		try {
			const value = await window.brigadir.readSidebarState();
			setCollapsedProjects(value);
			setSidebarReady(true);
		} catch {
			toastError(t(locale, 'Could not read the sidebar state.'), {
				action: {
					label: t(locale, 'Retry'),
					run: () => {
						void loadSidebar();
					},
				},
			});
		}
	}
	useEffect(() => {
		void loadSidebar();
	}, []);
	// spec/task-window-workspace#restore-window: the content waits for the last task with its surface, not a board or a default.
	const restoring = useRestoreSelection();
	function collapseProject(id: string, collapsed: boolean) {
		if (statusFilter !== null || taskFilter.trim()) {
			setFilteredCollapsed((values) =>
				collapsed ? [...new Set([...values, id])] : values.filter((value) => value !== id)
			);
			return;
		}
		const revision = ++sidebarRevision.current;
		setCollapsedProjects((values) =>
			collapsed ? [...new Set([...values, id])] : values.filter((value) => value !== id)
		);
		sidebarWrites.current = sidebarWrites.current
			.then(async () => {
				const values = await window.brigadir.collapseProject(id, collapsed);
				if (sidebarRevision.current === revision) setCollapsedProjects(values);
			})
			.catch(() => {
				if (sidebarRevision.current === revision) {
					toastError(t(locale, 'Could not save the collapsed projects.'));
					setSidebarReady(false);
					void window.brigadir
						.readSidebarState()
						.then(setCollapsedProjects)
						.catch(() => {});
				}
			});
	}
	const [sidebarHidden, setSidebarHidden] = useState(false),
		[iconPicker, setIconPicker] = useState<string | null>(null),
		[taskFilter, setTaskFilter] = useState('');
	const filterInput = useRef<HTMLInputElement>(null),
		iconAnchor = useRef<HTMLElement | null>(null);
	// ⌥⇧⌘F focuses the field after React commits it: a frame callback can run before a busy render mounts the input.
	const [filterFocus, setFilterFocus] = useState(0);
	useLayoutEffect(() => {
		if (filterFocus) {
			filterInput.current?.focus();
			filterInput.current?.select();
		}
	}, [filterFocus]);
	const sidebarPresent = usePresence(!sidebarHidden);
	const sidebarWidth = useSurfaceLayout((state) => state.layout.sidebarWidth);
	// spec/sidebar#section-rail: the rail's section — what the sidebar lists and which board the main area shows.
	const savedSection = useSurfaceLayout((state) => state.layout.sidebarSection);
	const prsModule = useWorkspace((state) => state.appearance.modules.pullRequests);
	const section = savedSection === 'prs' && !prsModule ? 'tasks' : savedSection;
	/** spec/sidebar#section-rail: the rail counts the PRs that wait for you — the board's data and cache (spec/projects-and-board#pr-mode). */
	const projectKey = workspace?.projects.map((item) => item.id).join('\0') ?? '';
	const projectIdList = useMemo(() => (projectKey ? projectKey.split('\0') : []), [projectKey]);
	const railPRs = useBoardPRs(projectIdList, prsModule, appearance.locale);
	const shortcut = useCommandShortcut();
	/** The task left open in Tasks while Pull requests showed its board; Tasks brings it back. */
	const taskBeforePRs = useRef<{ projectId: string; id: string | null } | null>(null);
	const [route, setRoute] = useState(location.hash);
	// spec/settings-modules-and-onboarding#intro: the intro opens on the first start (no onboarding recorded) and from Brigadir ▸ Show the intro again…
	const [intro, setIntro] = useState(false);
	useEffect(() => {
		void window.brigadir
			.readSettings()
			.then(({ settings }) => {
				if (settings.onboarding.completedVersion === null) setIntro(true);
			})
			.catch(() => {});
	}, []);
	const [settings, setSettings] = useState<false | SettingsTab>(false),
		[settingsTarget, setSettingsTarget] = useState<{
			setting?: string;
			keymap?: string;
			remote?: RemoteDialog;
			remotePart?: RemotePart;
		}>({});
	// spec/remote-access-and-mobile#module-and-settings: remote access — its settings (spec/settings-modules-and-onboarding#module-settings-popup: the Remote access popup of Settings ▸ Modules) with a dialog, File ▸ Connect…, the chip, the cover and the notices.
	const [connect, setConnect] = useState<{ machine?: string; pair?: boolean } | null>(null),
		[remoteChipWidth, setRemoteChipWidth] = useState(0);
	const openRemoteSettings: OpenRemoteSettings = (dialog, part) => {
		setSettingsTarget({
			...(dialog ? { remote: dialog } : {}),
			...(part ? { remotePart: part } : {}),
		});
		setSettings('remote');
	};
	const remoteModule = appearance.modules.remoteAccess;
	// spec/remote-access-and-mobile#remote-button: «Go to» in another machine's window brings this one with the list «Connect» open.
	useEffect(
		() =>
			remoteModule && !remoteMachine
				? window.brigadir.onRemoteOpen((machine) =>
						setConnect(machine ? { machine } : { pair: true })
					)
				: undefined,
		[remoteModule]
	);
	useEffect(
		() =>
			followRemote(remoteModule, (notice) =>
				remoteNoticeToast(useWorkspace.getState().appearance.locale, notice, openRemoteSettings)
			),
		[remoteModule]
	);
	// spec/remote-access-and-mobile#pairing: main kept the visible task and the menu of the client in control; back in control, say them again.
	const remoteEpoch = useRemote((state) => state.epoch);
	useEffect(() => {
		if (remoteEpoch) announceMenuContext();
	}, [remoteEpoch]);
	const fontWrites = useRef(Promise.resolve());
	// spec/notifications-slack-notes-and-schedules#toasts: missing fonts are a warning toast once per set; the face-size failure is an error toast.
	const missingFonts = (appearance.missingFonts ?? []).join(', ');
	useEffect(() => {
		if (missingFonts)
			toastWarning(
				t(
					useWorkspace.getState().appearance.locale,
					'Unavailable fonts: {fonts}. Using the system font.'
				).replace('{fonts}', missingFonts)
			);
	}, [missingFonts]);
	useEffect(() => {
		const resize = (operation: 'increase' | 'decrease' | 'reset') => {
			const focus = document.activeElement;
			if (focus?.closest('dialog,input,textarea:not(.xterm-helper-textarea),[data-prompt],button'))
				return false;
			const surface = focus?.closest<HTMLElement>('[data-font-surface]')?.dataset.fontSurface as
				TextSurface | undefined;
			if (!surface || !textSurfaces.includes(surface)) return false;
			fontWrites.current = fontWrites.current
				.then(async () => {
					const { settings } = await window.brigadir.readSettings();
					await window.brigadir.saveSettings({
						...settings,
						typography: resizedTypography(settings.typography, surface, operation),
					});
				})
				.catch(() =>
					toastError(
						t(useWorkspace.getState().appearance.locale, 'The settings could not be saved.')
					)
				);
			return true;
		};
		const stop = window.brigadir.onWorkspaceAction((action) => {
			if (action === 'font-increase') resize('increase');
			if (action === 'font-decrease') resize('decrease');
			if (action === 'font-reset') resize('reset');
		});
		// Native menu accelerators consume their events before the DOM. Handle the
		// unshifted equals alias and keyboard events delivered directly to a surface.
		const key = (event: KeyboardEvent) => {
			/* spec/settings-modules-and-onboarding#settings-keys: the same shortcuts as the View menu, from the keymap. */ const keymap =
					useWorkspace.getState().appearance.keymap ?? defaultKeymap,
				shortcut = (id: string) => {
					const command = menuCommands.find((item) => item.id === id);
					return command ? commandAccelerator(command, keymap) : undefined;
				};
			const operation = matchesAccelerator(event, shortcut('font-increase'))
				? 'increase'
				: matchesAccelerator(event, shortcut('font-decrease'))
					? 'decrease'
					: matchesAccelerator(event, shortcut('font-reset'))
						? 'reset'
						: null;
			if (operation && resize(operation)) {
				event.preventDefault();
				event.stopPropagation();
			}
		};
		window.addEventListener('keydown', key, true);
		return () => {
			stop();
			window.removeEventListener('keydown', key, true);
		};
	}, []);
	// spec/search-menus-and-commands#search-tabs: ⇧⌘F opens Text with the editor's one-line selection as the query, ⇧⌘A opens Actions.
	const [search, setSearchState] = useState<{ mode: SearchMode; query: string } | null>(null);
	const setSearch = (
		action: 'search' | 'quick-open' | 'commands' | 'find-in-files' | 'find-action' | null
	) => {
		if (!action) {
			setSearchState(null);
			return;
		}
		const selection =
			action === 'find-in-files' ? (window.getSelection()?.toString() ?? '').trim() : '';
		setSearchState({
			mode:
				action === 'quick-open'
					? 'quick'
					: action === 'commands'
						? 'commands'
						: action === 'find-in-files'
							? 'text'
							: action === 'find-action'
								? 'actions'
								: 'all',
			query: selection.includes('\n') || selection.length > 200 ? '' : selection,
		});
	};
	// spec/appearance#evolution-redesign: a surface of a task (the review's «Open Settings») opens a tab of Settings without a menu action.
	useEffect(() => {
		const open = (event: Event) => {
			const tab = (event as CustomEvent<string>).detail;
			// spec/pull-requests-and-ci#review-crew: `No crews` of «Review with an agent ▾» opens Settings ▸ Templates.
			// spec/notifications-slack-notes-and-schedules#notification-center: the notification center's gear opens Settings ▸ Notifications.
			if (tab === 'agents' || tab === 'templates' || tab === 'notifications') setSettings(tab);
		};
		window.addEventListener('brigadir:open-settings', open);
		return () => window.removeEventListener('brigadir:open-settings', open);
	}, []);
	// spec/tasks#archive: the Archive window, all projects or one; the open archive sections of the sidebar.
	const [archiveWindow, setArchiveWindow] = useState<{ projectId: string | null } | null>(null);
	useEffect(() => {
		let shift = 0;
		const stop = window.brigadir.onWorkspaceAction((action) => {
			if (action === 'settings') setSettings('appearance');
			// spec/remote-access-and-mobile#remote-button: the chip's menu when the chip is in the bar, the list «Connect» otherwise.
			if (action === 'connect' && useWorkspace.getState().appearance.modules.remoteAccess)
				if (!askRemoteChip()) setConnect({});
			if (action === 'intro') setIntro(true);
			if (action === 'settings-templates') setSettings('templates');
			if (
				action === 'search' ||
				action === 'quick-open' ||
				action === 'find-in-files' ||
				action === 'find-action' ||
				(action === 'commands' && useWorkspace.getState().appearance.modules.commands)
			)
				setSearch(action);
		});
		const key = (event: KeyboardEvent) => {
			if (event.repeat) return;
			if (event.key === 'Shift' && !event.altKey && !event.metaKey && !event.ctrlKey) {
				const now = performance.now();
				if (shift && now - shift <= 300) {
					setSearch('search');
					shift = 0;
				} else shift = now;
			} else shift = 0;
		};
		window.addEventListener('keydown', key);
		return () => {
			stop();
			window.removeEventListener('keydown', key);
		};
	}, []);
	const [newProject, setNewProject] = useState<string | null>(null);
	const [quickTask, setQuickTask] = useState<QuickTaskRequest | null>(null);
	const [newWhen, setNewWhen] = useState<'now' | 'later' | 'repeat'>('now');
	const [newBacklog, setNewBacklog] = useState(false),
		[editing, setEditing] = useState<AgentTask | undefined>(),
		[relaySource, setRelaySource] = useState<AgentTask | undefined>(),
		[duplicateSource, setDuplicateSource] = useState<AgentTask | undefined>(),
		[proposalSheet, setProposalSheet] = useState<
			{ source: AgentTask; proposal: TaskProposal } | undefined
		>(),
		[noteSheet, setNoteSheet] = useState<
			| {
					id: string;
					title: string;
					prompt: string;
					name: string;
					range: string | null;
					after: number | null;
			  }
			| undefined
		>();
	const showNew = (id: string, backlog = false) => {
		setNewWhen('now');
		setNoteSheet(undefined);
		setDuplicateSource(undefined);
		setProposalSheet(undefined);
		setRelaySource(undefined);
		setEditing(undefined);
		setNewBacklog(backlog);
		setNewProject(id);
	};
	/** spec/notifications-slack-notes-and-schedules#schedules: `New schedule…`, the section's «+» and its empty state — the sheet on When = Repeat. */
	const newSchedule = (projectId?: string) => {
		const id = projectId ?? activeProject?.id ?? workspace?.projects[0]?.id;
		if (!id) return;
		showNew(id);
		setNewWhen('repeat');
	};
	/** spec/notifications-slack-notes-and-schedules#schedules: a task's `Repeat…` — a copy of it on When = Repeat. */
	const repeatTask = (source: AgentTask) => {
		showNew(source.projectId);
		setDuplicateSource(source);
		setNewWhen('repeat');
	};
	const editTask = (task: AgentTask) => {
		setDuplicateSource(undefined);
		setProposalSheet(undefined);
		setRelaySource(undefined);
		setEditing(task);
		setNewBacklog(true);
		setNewProject(task.projectId);
	};
	// spec/tasks#agent-created-tasks: «Open in the sheet…» on the card of a task the agent proposed.
	const proposalTask = (task: AgentTask, proposal: TaskProposal) => {
		setDuplicateSource(undefined);
		setRelaySource(undefined);
		setEditing(undefined);
		setProposalSheet({ source: task, proposal });
		setNewBacklog(proposal.start === 'backlog');
		// spec/notifications-slack-notes-and-schedules#schedules: a proposed schedule opens the sheet on Repeat (Later for a once) with its rule.
		setNewWhen(
			proposal.start === 'schedule'
				? proposal.schedule?.rule.kind === 'once'
					? 'later'
					: 'repeat'
				: 'now'
		);
		setNewProject(task.projectId);
	};
	// spec/notifications-slack-notes-and-schedules#notes: a task from a whole note or its selected lines; a note without a project asks where the task goes.
	const noteTask = async (note: NoteDocument, part: NoteSelection | null) => {
		const projectId = note.project ?? (await window.brigadir.noteTaskProjectMenu());
		if (!projectId) return;
		const title = note.title || t(locale, 'Untitled note'),
			text = part ? part.text : note.text,
			first =
				text
					.split('\n')
					.map((line) => line.replace(/^\s*(#{1,6}|[-*+]|\d+\.)\s+/, '').trim())
					.find(Boolean) ?? '';
		setDuplicateSource(undefined);
		setProposalSheet(undefined);
		setRelaySource(undefined);
		setEditing(undefined);
		setNoteSheet({
			id: note.id,
			title,
			prompt: text,
			name: first.slice(0, 80),
			range: part
				? part.startLine === part.endLine
					? `${part.startLine}`
					: `${part.startLine}–${part.endLine}`
				: null,
			after: part ? part.endLine : null,
		});
		setNewBacklog(false);
		setNewProject(projectId);
	};
	const openNoteTask = (projectId: string, taskId: string) => {
		const found = workspace?.tasks.find(
			(item) => item.projectId === projectId && item.id === taskId
		);
		if (found) openTask(found);
	};
	const relayTask = (task: AgentTask) => {
		if (['backlog', 'preparing'].includes(task.status)) return;
		setDuplicateSource(undefined);
		setProposalSheet(undefined);
		setEditing(undefined);
		setRelaySource(task);
		setNewBacklog(false);
		setNewProject(task.projectId);
	};
	useEffect(() => {
		const stop = window.brigadir.onAppearanceChanged(setAppearance);
		void load();
		let refresh: ReturnType<typeof setTimeout> | undefined,
			refreshAt = 0;
		const stopEvents = onSessionEvent(({ record }) => {
			if (!record || workspaceEventKinds.has(record.event.kind)) {
				// Tool updates stream with command output; the sidebar activity line can trail them by a second.
				const wait = record?.event.kind === 'tool.changed' ? 1000 : 150;
				if (refresh && refreshAt > Date.now() + wait) {
					clearTimeout(refresh);
					refresh = undefined;
				}
				if (!refresh) {
					refreshAt = Date.now() + wait;
					refresh = setTimeout(() => {
						refresh = undefined;
						void load();
					}, wait);
				}
			}
		});
		const stopNavigation = window.brigadir.onNavigate((route) => {
			location.hash = route;
		});
		const handleHash = () => setRoute(location.hash);
		window.addEventListener('hashchange', handleHash);
		return () => {
			stopNavigation();
			stop();
			stopEvents();
			clearTimeout(refresh);
			window.removeEventListener('hashchange', handleHash);
		};
	}, [load, setAppearance]);
	useApplyAppearance(appearance);
	const locale = appearance.locale;
	const task = workspace?.tasks.find(
		(item) => item.id === selectedTask?.id && item.projectId === selectedTask.projectId
	);
	const launchProject = workspace?.projects.find((project) => project.id === newProject);
	const activeProject =
		workspace?.projects.find((project) => project.id === (task?.projectId ?? selectedProject)) ??
		(selectedProject === '*' ? undefined : workspace?.projects[0]);
	const colors = projectColors(workspace?.projects.map((project) => project.id) ?? []);
	const iconProject = workspace?.projects.find((project) => project.id === iconPicker);
	// spec/tasks#archive: archived tasks leave the cards, counts and filters; the archive section and window show them.
	const live =
			workspace?.tasks.filter(
				(item) => !item.archived && (quietRuns || !item.scheduleRun?.quiet)
			) ?? [],
		archived = archivedTasks(workspace?.tasks ?? []);
	useSidebarOrder(
		sidebarTasks(workspace?.tasks ?? [], quietRuns)
			.map((task) => `${task.projectId}/${task.id}`)
			.join('|'),
		`${route}/${sidebarHidden}/${statusFilter}/${taskFilter}/${collapsedProjects.join(',')}/${filteredCollapsed.join(',')}`
	);
	const boardProject = selectedProject === '*' ? '*' : activeProject?.id;
	/** spec/sidebar#section-rail: a section's tile or key opens it with the sidebar; the open section's own hides and shows the sidebar. */
	const openSection = (next: typeof section) => {
		// spec/notifications-slack-notes-and-schedules#notes + spec/sidebar#section-rail: from the Notes screen a section's tile goes back to that section's board, the sidebar shown.
		if (notesOpen || schedulesOpen) {
			useWorkspace.getState().closeNotes();
			useWorkspace.getState().closeSchedules();
			setSidebarHidden(false);
			if (next === section) return;
		}
		if (next === section) {
			setSidebarHidden((value) => !value);
			return;
		}
		setSidebarHidden(false);
		const store = useWorkspace.getState();
		if (next === 'prs') {
			// What Tasks showed — a task or a project's board — comes back with Tasks.
			taskBeforePRs.current = task
				? { projectId: task.projectId, id: task.id }
				: { projectId: selectedProject ?? activeProject?.id ?? '*', id: null };
			// spec/pull-requests-and-ci#project-pr-section: Pull requests opens on every project; a project's group narrows the board.
			store.selectProject('*');
		} else {
			const back = taskBeforePRs.current;
			taskBeforePRs.current = null;
			if (back?.id) {
				if (
					workspace?.tasks.some((item) => item.id === back.id && item.projectId === back.projectId)
				)
					store.selectTask(back.projectId, back.id);
			} else if (back) store.selectProject(back.projectId);
		}
		useSurfaceLayout.getState().setSection(next);
	};
	// spec/sidebar#section-rail: Pull requests never shows a task — a task opened from elsewhere (⌘J, a notification) opens Tasks.
	useEffect(() => {
		if (task && section === 'prs') {
			taskBeforePRs.current = null;
			useSurfaceLayout.getState().setSection('tasks');
		}
	}, [task?.id, task?.projectId, section]);
	const addProject = () => {
		void window.brigadir.addProject().then(
			async (project) => {
				if (project) selectProject(project.id);
				await load();
			},
			() => toastError(t(locale, 'Could not add the project.'))
		);
	};
	const openTask = (task: AgentTask) => {
		if (task.status === 'backlog' && !task.hasStarted) editTask(task);
		else useWorkspace.getState().selectTask(task.projectId, task.id);
	};
	const taskMenu = (task: AgentTask): Promise<string | null> => {
		const focused = document.activeElement,
			fromBoard = !!focused?.closest('[data-board-task]');
		return window.brigadir
			.taskMenu(task)
			.then(async (action) => {
				if (action === 'rename') {
					setRenaming(task);
				}
				if (action === 'duplicate') {
					setEditing(undefined);
					setRelaySource(undefined);
					setDuplicateSource(task);
					setNewBacklog(task.status === 'backlog');
					setNewProject(task.projectId);
				}
				if (action === 'repeat') repeatTask(task);
				if (action === 'diff') {
					showTaskDiff(task);
					useWorkspace.getState().selectTask(task.projectId, task.id);
				}
				if (action === 'relay') relayTask(task);
				if (action === 'edit') editTask(task);
				if (action === 'open') openTask(task);
				if (action === 'archived') showArchiveToast(task);
				await load();
				if (fromBoard) followBoardFocus(focused, task.id, '[data-project-screen] button');
				return action;
			})
			.catch(() => {
				toastError(t(locale, 'The task menu action failed.'));
				return null;
			});
	};
	// Stable identities for memoized sidebar rows; they always call the latest handlers.
	const handlers = useRef({ openTask, taskMenu });
	handlers.current = { openTask, taskMenu };
	const openTaskStable = useCallback((task: AgentTask) => handlers.current.openTask(task), []),
		taskMenuStable = useCallback((task: AgentTask) => handlers.current.taskMenu(task), []);
	const projectMenu = (id: string) => {
		void window.brigadir
			.projectMenu(id)
			.then(async (action) => {
				if (action === 'knowledge') setKnowledgeProject(id);
				// spec/pull-requests-and-ci#review-notes
				if (action === 'review-notes') openReviewNotes(id);
				// spec/sidebar#project-groups: «Project icon…» opens the same picker as the icon, anchored to the group's icon.
				if (action === 'icon') {
					const button = document.querySelector<HTMLElement>(
						`[data-project-icon-button="${CSS.escape(id)}"]`
					);
					if (button) {
						iconAnchor.current = button;
						setIconPicker(id);
					}
				}
				if (action === 'new-task') showNew(id);
				if (action === 'main-tree') await useWorkspace.getState().openMainTree(id, null);
				if (action === 'removed') setNewProject(null);
				await load();
			})
			.catch(() => toastError(t(locale, 'The project menu action failed.')));
	};
	// spec/sidebar#layout suppression needs the task that is actually visible, not the menu context.
	useEffect(() => {
		void window.brigadir
			.setVisibleTask(task && route !== '#kit' ? { projectId: task.projectId, id: task.id } : null)
			.catch(() => {});
	}, [task?.id, task?.projectId, route, remoteEpoch]);
	useEffect(
		() =>
			window.brigadir.onNotificationOpen((key) => {
				if (location.hash === '#kit') location.hash = 'workspace';
				useWorkspace.getState().selectTask(key.projectId, key.id);
				void load();
			}),
		[load]
	);
	// spec/browser-and-simulator#simulator: «Commands…» in the simulator column opens the Commands tab of Search Everywhere.
	useEffect(() => {
		const open = (event: Event) => {
			if (
				(event as CustomEvent).detail === 'commands' &&
				useWorkspace.getState().appearance.modules.commands
			)
				setSearch('commands');
		};
		addEventListener('brigadir:search', open);
		return () => removeEventListener('brigadir:search', open);
	}, []);
	// spec/browser-and-simulator#simulator: `simulator_open` opens the column in the agent's task, shown or parked.
	// spec/browser-and-simulator#opening-tabs: the browser column opens for the agent the same way.
	useEffect(
		() =>
			window.brigadir.onBrowserShow(({ key, tab, front }) => {
				const task = useWorkspace
					.getState()
					.workspace?.tasks.find((item) => item.projectId === key.projectId && item.id === key.id);
				if (task) setTaskBrowser(task, tab, '', front ? 'front' : 'agent');
			}),
		[]
	);
	useEffect(
		() =>
			window.brigadir.onSimulatorEvent((event) => {
				if ('waiting' in event) setSimulatorWaiting(event.projectId, event.waiting);
				if (!('show' in event)) return;
				const task = useWorkspace
					.getState()
					.workspace?.tasks.find(
						(item) => item.projectId === event.show.projectId && item.id === event.show.id
					);
				if (task) setTaskSimulator(task);
			}),
		[]
	);
	useEffect(
		() =>
			window.brigadir.onProjectOpen((id) => {
				if (location.hash === '#kit') location.hash = 'workspace';
				selectProject(id);
				void load();
			}),
		[load, selectProject]
	);
	const needsYou = live.filter((task) => task.status === 'needs-you');
	useMenuContext(
		!!activeProject && route !== '#kit',
		!!(task || mainTree) && route !== '#kit',
		needsYou.length > 0 && route !== '#kit',
		!!task && !task.archived && !['backlog', 'preparing'].includes(task.status) && route !== '#kit',
		!!task && !!workspace && canArchive(task, workspace.tasks) && route !== '#kit'
	);
	useEffect(
		() =>
			window.brigadir.onWorkspaceAction((action) => {
				if (document.querySelector('dialog[open]')) return;
				if (action === 'relay' && task) relayTask(task);
				if (action === 'open-project') addProject();
				if (action === 'close-task') useWorkspace.setState({ selectedTask: null });
				if (action === 'archive') setArchiveWindow({ projectId: null });
				// spec/sidebar#section-rail: ⌃⌘3 opens Notes; on the Notes screen it hides and shows the sidebar, like the other sections.
				if (action === 'notes' && useWorkspace.getState().appearance.modules.notes) {
					if (useWorkspace.getState().notes) setSidebarHidden((value) => !value);
					else openNotes();
				}
				if (action === 'note-new' && useWorkspace.getState().appearance.modules.notes)
					void window.brigadir
						.createNote(null, '')
						.then((id) => openNotes(id))
						.catch(() => toastError(t(locale, 'Could not create the note.')));
				if (action === 'archive-task' && task && workspace && canArchive(task, workspace.tasks))
					void archiveTask(task).catch(() => toastError(t(locale, 'Could not archive the task.')));
				if (action === 'new-task' && activeProject) {
					if (!task && mainTree?.task.projectId === activeProject.id)
						setQuickTask({ projectId: activeProject.id, scopeId: mainTree.scopeId });
					else showNew(activeProject.id);
				}
				if (
					action === 'command-new' &&
					activeProject &&
					useWorkspace.getState().appearance.modules.commands
				)
					useCommandEditor.getState().open({ projectId: activeProject.id, command: null, task });
				// spec/notifications-slack-notes-and-schedules#schedules: ⌃⌘4 opens Schedules (again — hides and shows the sidebar); File ▸ New schedule… the sheet.
				if (action === 'schedules' && useWorkspace.getState().appearance.modules.schedules) {
					if (useWorkspace.getState().schedules) setSidebarHidden((value) => !value);
					else openSchedules();
				}
				if (action === 'schedule-new' && useWorkspace.getState().appearance.modules.schedules)
					newSchedule();
				if (action === 'section-tasks') openSection('tasks');
				if (action === 'section-prs' && prsModule) openSection('prs');
				if (action === 'sidebar-toggle') {
					setSidebarHidden((value) => !value);
					if (document.activeElement?.closest('aside'))
						(document.querySelector('main') as HTMLElement | null)?.focus();
				}
				if (action === 'sidebar-filter') {
					setSidebarHidden(false);

					setFilterFocus((value) => value + 1);
				}
				if (action === 'needs-next' || action === 'needs-previous') {
					if (!needsYou.length) return;
					const index = needsYou.findIndex(
							(item) => item.id === task?.id && item.projectId === task.projectId
						),
						step = action === 'needs-next' ? 1 : -1,
						next =
							needsYou[
								index < 0
									? step === 1
										? 0
										: needsYou.length - 1
									: (index + step + needsYou.length) % needsYou.length
							]!;
					useWorkspace.getState().selectTask(next.projectId, next.id);
				}
			}),
		[activeProject?.id, task?.id, task?.projectId, workspace, mainTree, section, prsModule]
	);
	useEffect(() => setFilteredCollapsed([]), [statusFilter, taskFilter]);
	const isProjectCollapsed = (id: string) =>
		(statusFilter !== null || taskFilter.trim() ? filteredCollapsed : collapsedProjects).includes(
			id
		);
	const matches = (item: AgentTask) =>
		sidebarMatches(item, statusFilter) &&
		(!taskFilter.trim() ||
			item.title.toLocaleLowerCase(locale).includes(taskFilter.trim().toLocaleLowerCase(locale)));
	const handleRetry = () => {
		void load();
	};
	return (
		<AgentsProvider locale={locale}>
			<ForgeProvider
				key={`${(task ?? mainTree?.task)?.projectId}/${(task ?? mainTree?.task)?.id}`}
				task={task ?? mainTree?.task}
				locale={locale}>
				<PullRequestsProvider projectId={activeProject?.id} taskId={task?.id ?? mainTree?.task.id}>
					<CIWatchEvents locale={locale} />
					<div className={styles.window}>
						{launchConflict && (
							<LockConflict
								key={launchConflict.id}
								conflict={launchConflict}
								locale={appearance.locale}
							/>
						)}
						{knowledgePresent && lastKnowledgeProject.current && (
							<RejectedKnowledge
								key={lastKnowledgeProject.current}
								projectId={lastKnowledgeProject.current}
								locale={locale}
								open={Boolean(knowledgeProject)}
								close={() => setKnowledgeProject(null)}
							/>
						)}
						{connect && !remoteMachine && (
							<RemoteConnect
								key={JSON.stringify(connect)}
								locale={locale}
								machine={connect.machine}
								pair={connect.pair}
								close={() => setConnect(null)}
							/>
						)}
						<RemoteCover locale={locale} workspace={workspace} />
						{settings && (
							<LayoutSettings
								locale={locale}
								initialTab={settings}
								highlight={settingsTarget.setting}
								keymapQuery={settingsTarget.keymap}
								remoteDialog={settingsTarget.remote}
								remotePart={settingsTarget.remotePart}
								close={() => {
									setSettings(false);
									setSettingsTarget({});
								}}
							/>
						)}
						{intro && (
							<Intro
								locale={locale}
								close={(projectId, newTask) => {
									setIntro(false);
									void load();
									if (projectId) useWorkspace.getState().selectProject(projectId);
									if (newTask && projectId) showNew(projectId);
								}}
							/>
						)}
						{search && (
							<Search
								mode={search.mode}
								initialQuery={search.query}
								workspace={workspace}
								task={task}
								mainTree={mainTree?.task ?? null}
								project={activeProject}
								locale={locale}
								close={() => setSearch(null)}
								openSettings={(tab, target) => {
									setSettingsTarget(target);
									setSettings(tab);
								}}
							/>
						)}
						{archiveWindow && workspace && (
							<ArchiveWindow
								taskMenu={taskMenu}
								workspace={workspace}
								locale={locale}
								projectId={archiveWindow.projectId}
								close={() => setArchiveWindow(null)}
								openTask={(item) => {
									if (location.hash === '#kit') location.hash = 'workspace';
									useWorkspace.getState().selectTask(item.projectId, item.id);
								}}
								openSettings={() => {
									setSettingsTarget({});
									setSettings('agents');
								}}
								searchAll={(query) => setSearchState({ mode: 'all', query })}
							/>
						)}
						{appearance.modules.commands && <CommandEditorHost locale={locale} />}
						<ReviewLaunchHost locale={locale} />
						{route === '#kit' ? (
							<>
								<div className={styles.sidebarChrome} />
								<Kit locale={locale} />
							</>
						) : (
							<div
								className={styles.layout}
								style={
									{
										'--sidebar-width': `${sidebarWidth}px`,
										'--remote-chip-w': `${remoteChipWidth}px`,
									} as CSSProperties
								}
								data-sidebar-hidden={sidebarHidden}
								data-sidebar-present={sidebarPresent}
								data-chip-shown={remoteChipWidth > 0 || undefined}>
								{/* spec/sidebar#section-rail: the sections rail left of the sidebar; it stays when the sidebar hides. The bell (spec/notifications-slack-notes-and-schedules#notification-center),
								    Remote (spec/sidebar#project-groups), the limits (spec/agents-and-providers#quota-sources) and Settings live here, not in the sidebar. */}
								<SectionsRail
									locale={locale}
									modules={{
										prs: prsModule,
										notes: appearance.modules.notes,
										schedules: appearance.modules.schedules,
									}}
									selected={notesOpen ? 'notes' : schedulesOpen ? 'schedules' : section}
									counts={{
										tasks: needsYou.length,
										prs: railPRs.loaded ? waitingCount(railPRs.items.map((item) => item.pr)) : 0,
									}}
									scheduleDot={scheduleDot}
									onOpen={(id) => {
										if (id === 'notes') {
											if (notesOpen) setSidebarHidden((value) => !value);
											else openNotes();
										} else if (id === 'schedules') {
											if (schedulesOpen) setSidebarHidden((value) => !value);
											else {
												setSidebarHidden(false);
												openSchedules();
											}
										} else openSection(id);
									}}
									tools={
										<>
											<NotificationBell locale={locale} size="xl" placement="rail" />
											{/* spec/remote-access-and-mobile#module-and-settings: this machine's button, or the chip of another machine's window. */}
											<RemoteWindowChip
												locale={locale}
												size="xl"
												placement="rail"
												openSettings={openRemoteSettings}
												openConnect={setConnect}
												onWidth={setRemoteChipWidth}
											/>
											<QuotaButton locale={locale} placement="rail" />
											<SettingsTile locale={locale} onClick={() => setSettings('appearance')} />
										</>
									}
								/>
								<aside
									data-app-sidebar
									className={styles.sidebar}
									inert={sidebarHidden}
									aria-hidden={sidebarHidden}
									aria-label={t(locale, 'Projects')}>
									<div className={styles.sidebarChrome} data-sidebar-strip />
									{/* spec/sidebar#section-rail: the section the rail picked — Tasks, or Pull requests in the same look. */}
									{schedulesOpen && workspace ? (
										<SidebarSchedules
											locale={locale}
											projects={workspace.projects}
											tasks={workspace.tasks}
											colors={colors}
											selected={task ? null : schedulesRoute.schedule}
											onSelect={(schedule) => openSchedules(schedule)}
											onNew={() => newSchedule()}
										/>
									) : notesOpen && workspace ? (
										<SidebarNotes
											locale={locale}
											projects={workspace.projects}
											colors={colors}
											selected={notesRoute.note}
											onOpen={(id) => openNotes(id)}
											onCreateTask={(note) => void noteTask(note, null)}
										/>
									) : section === 'prs' && workspace ? (
										<SidebarPRs
											prs={railPRs}
											workspace={workspace}
											locale={locale}
											colors={colors}
											selected={task || mainTree ? null : (boardProject ?? null)}
											onSelect={selectProject}
											onReview={(item) => {
												if (boardProject !== '*' && boardProject !== item.projectId)
													selectProject(item.projectId);
												requestPRReview(item);
											}}
										/>
									) : (
										<>
											{/* spec/appearance#evolution-redesign: the task filter is always there, the status filter beside it. */}
											<div className={styles.taskFilter} data-size="l">
												<SearchField
													className={styles.taskFilterField}
													inputRef={filterInput}
													locale={locale}
													label={t(locale, 'Filter tasks')}
													value={taskFilter}
													onChange={setTaskFilter}
													data-task-filter
													onKeyDown={(event) => {
														if (event.key === 'Escape') {
															event.preventDefault();
															if (taskFilter) setTaskFilter('');
															else (document.querySelector('main') as HTMLElement | null)?.focus();
														}
													}}
												/>
												<SidebarFilterButton
													locale={locale}
													live={live}
													value={statusFilter}
													onChange={setStatusFilter}
													quiet={
														appearance.modules.schedules
															? {
																	on: quietRuns,
																	count: (workspace?.tasks ?? []).filter(
																		(item) => !item.archived && item.scheduleRun?.quiet
																	).length,
																	toggle: () => setQuietRuns((value) => !value),
																}
															: null
													}
												/>
											</div>

											<div
												className={styles.allProjectsRow}
												data-selected={!task && selectedProject === '*'}>
												<button
													className={styles.allProjects}
													aria-pressed={!task && selectedProject === '*'}
													onClick={() => selectProject('*')}>
													<Glyph name="board" size={16} />
													{t(locale, 'All projects')}
												</button>
												<ArchiveHeaderButton
													count={archived.length}
													locale={locale}
													onClick={() => setArchiveWindow({ projectId: null })}
												/>
												<IconButton
													size="s"
													label={t(locale, 'Add a project…')}
													onClick={addProject}>
													<Glyph name="folder-plus" size={14} />
												</IconButton>
											</div>
											<div data-sidebar-list className={styles.projectList}>
												<NotificationToast locale={locale} mode={appearance.notificationMode} />
												<AppUpdateToasts locale={locale} />
												{!workspace && !error && <SkeletonRows count={4} height={32} single />}
												{workspace?.projects.length === 0 && (
													<p className={styles.muted}>{t(locale, 'No projects')}</p>
												)}
												{workspace?.projects
													.filter(
														(project) =>
															(!taskFilter.trim() && statusFilter === null) ||
															live.some((item) => item.projectId === project.id && matches(item))
													)
													.map((project) => (
														<section
															key={project.id}
															className={styles.project}
															data-open={!isProjectCollapsed(project.id)}>
															<div
																className={styles.projectHeader}
																style={projectToneStyle(project, colors.get(project.id) ?? 0)}
																data-selected={(!task && boardProject === project.id) || undefined}
																tabIndex={0}
																aria-label={project.name}
																onContextMenu={(event) => {
																	event.preventDefault();
																	projectMenu(project.id);
																}}
																onKeyDown={(event) => {
																	if (
																		event.key === 'ContextMenu' ||
																		(event.shiftKey && event.key === 'F10')
																	) {
																		event.preventDefault();
																		projectMenu(project.id);
																	}
																}}>
																<button
																	className={styles.projectCollapse}
																	disabled={!sidebarReady}
																	aria-label={`${t(locale, isProjectCollapsed(project.id) ? 'Expand project' : 'Collapse project')} · ${project.name}`}
																	title={t(
																		locale,
																		isProjectCollapsed(project.id)
																			? 'Expand project'
																			: 'Collapse project'
																	)}
																	aria-expanded={!isProjectCollapsed(project.id)}
																	onClick={() =>
																		collapseProject(project.id, !isProjectCollapsed(project.id))
																	}>
																	<Glyph name="sidebar-chevron" size={10} />
																</button>
																{/* spec/appearance#evolution-redesign: the icon in place of the dot; a click opens «Project icon»; a spinner while the agent picks. */}
																<button
																	type="button"
																	className={styles.projectIconButton}
																	aria-label={t(locale, 'Project icon · {project}').replace(
																		'{project}',
																		project.name
																	)}
																	title={t(locale, 'Project icon')}
																	aria-haspopup="dialog"
																	aria-expanded={iconPicker === project.id}
																	data-project-icon-button={project.id}
																	data-picking={project.iconPicking || undefined}
																	onClick={(event) => {
																		iconAnchor.current = event.currentTarget;
																		setIconPicker((value) =>
																			value === project.id ? null : project.id
																		);
																	}}>
																	{project.iconPicking ? (
																		<span className={styles.projectPicking}>
																			<Glyph name="agent-run" size={14} />
																		</span>
																	) : (
																		<ProjectIcon
																			project={project}
																			slot={colors.get(project.id) ?? 0}
																			size={22}
																		/>
																	)}
																</button>
																<h3 title={project.path}>
																	<button
																		className={styles.projectSelect}
																		aria-pressed={!task && !mainTree && boardProject === project.id}
																		onClick={() => selectProject(project.id)}>
																		{project.name}
																	</button>
																</h3>
																{project.iconPicking && (
																	<span className={styles.projectPickingText} data-icon-picking>
																		{t(locale, 'Picking an icon…')}
																	</span>
																)}
																{!project.iconPicking && (
																	<ProjectAttention
																		count={
																			live.filter(
																				(item) =>
																					item.projectId === project.id &&
																					item.status === 'needs-you'
																			).length
																		}
																		label={t(locale, 'Needs you')}
																	/>
																)}
																{/* spec/sidebar#project-groups: open or folded, the same tail — Needs you, the archive count and «New task». */}
																{!project.iconPicking && (
																	<>
																		<ArchiveHeaderButton
																			project
																			count={
																				archived.filter((item) => item.projectId === project.id)
																					.length
																			}
																			locale={locale}
																			onClick={() => setArchiveWindow({ projectId: project.id })}
																		/>
																		<IconButton
																			size="s"
																			hint={t(locale, 'New task')}
																			label={`${t(locale, 'New task')} · ${project.name}`}
																			onClick={() => showNew(project.id)}>
																			<Glyph name="plus" size={14} />
																		</IconButton>
																	</>
																)}
															</div>
															<div
																className={styles.projectDisclosure}
																data-project-disclosure={project.id}
																data-open={!isProjectCollapsed(project.id)}
																inert={isProjectCollapsed(project.id)}
																aria-hidden={isProjectCollapsed(project.id)}>
																<div>
																	{/* spec/sidebar#completed-fold: the completed come last as quiet rows under «Completed · N», which folds them; a filter opens it. */}
																	{sidebarTasks(
																		workspace.tasks.filter(
																			(item) =>
																				item.projectId === project.id &&
																				(matches(item) ||
																					live.some(
																						(worker) =>
																							worker.crewTaskId === item.id && matches(worker)
																					))
																		),
																		quietRuns
																	).map((item, index, list) => {
																		const done = item.status === 'completed',
																			doneFolded =
																				completedFolded.has(project.id) &&
																				!taskFilter.trim() &&
																				statusFilter === null;
																		if (
																			done &&
																			doneFolded &&
																			list[index - 1]?.status === 'completed'
																		)
																			return null;
																		return (
																			<Fragment key={item.id}>
																				{done && list[index - 1]?.status !== 'completed' && (
																					<button
																						type="button"
																						className={styles.doneFold}
																						data-done-fold
																						aria-expanded={!doneFolded}
																						title={t(
																							locale,
																							doneFolded ? 'Expand completed' : 'Collapse completed'
																						)}
																						onClick={() =>
																							collapseCompleted(project.id, !doneFolded, locale)
																						}>
																						<span>
																							{t(locale, 'Completed · {n}').replace(
																								'{n}',
																								new Intl.NumberFormat(locale).format(
																									list.filter(
																										(other) => other.status === 'completed'
																									).length
																								)
																							)}
																						</span>
																						<Glyph name="sidebar-triangle" size={10} />
																					</button>
																				)}
																				{!(done && doneFolded) && (
																					<SwipeToArchive
																						task={item}
																						tasks={workspace.tasks}
																						locale={locale}
																						row={item.status === 'completed'}>
																						{item.status === 'completed' ? (
																							<CompletedRow
																								task={item}
																								archivable={canArchive(item, workspace.tasks)}
																								onMenu={taskMenuStable}
																								onOpen={openTaskStable}
																							/>
																						) : item.crew || item.reviewCrew ? (
																							<CrewCard
																								task={item}
																								tasks={workspace.tasks}
																								onMenu={taskMenuStable}
																								onOpen={openTaskStable}
																							/>
																						) : (
																							<TaskRow
																								task={item}
																								onMenu={taskMenuStable}
																								onOpen={openTaskStable}
																							/>
																						)}
																					</SwipeToArchive>
																				)}
																			</Fragment>
																		);
																	})}
																	{!workspace.tasks.some(
																		(item) => item.projectId === project.id
																	) && <p className={styles.muted}>{t(locale, 'No tasks')}</p>}
																</div>
															</div>
														</section>
													))}
												{(taskFilter.trim() || statusFilter !== null) && !live.some(matches) && (
													<p className={styles.muted}>{t(locale, 'No matches')}</p>
												)}
											</div>
										</>
									)}
									<ArchiveToast locale={locale} />
									<ForgeToast />
									{iconProject && (
										<ProjectIconPicker
											key={iconProject.id}
											project={iconProject}
											slot={colors.get(iconProject.id) ?? 0}
											anchor={iconAnchor}
											open={!!iconPicker}
											locale={locale}
											onClose={() => setIconPicker(null)}
										/>
									)}
								</aside>
								<main className={styles.content} tabIndex={-1}>
									{!task && !boardProject && !notesOpen && !schedulesOpen && (
										<header className={styles.titlebar}>
											<span>{activeProject?.name ?? t(locale, 'Brigadir')}</span>
											<AgentsButton />
											<IconButton
												label={t(locale, 'Search Everywhere')}
												onClick={() => setSearch('search')}>
												<Glyph name="search" size={16} />
											</IconButton>
										</header>
									)}
									{error ? (
										<div role="alert" className={styles.empty}>
											<h1>{t(locale, 'Some data could not be read.')}</h1>
											<Button onClick={handleRetry}>{t(locale, 'Retry')}</Button>
										</div>
									) : schedulesOpen && !task && workspace ? (
										<SurfaceBoundary surface="project" locale={locale} resetKey="schedules">
											<SchedulesScreen
												locale={locale}
												projects={workspace.projects}
												tasks={workspace.tasks}
												selected={schedulesRoute.schedule}
												onSelect={(schedule) => openSchedules(schedule)}
												onOpenTask={(projectId, id) => openScheduleTask(projectId, id)}
												onNew={() => newSchedule()}
											/>
										</SurfaceBoundary>
									) : notesOpen && workspace ? (
										<SurfaceBoundary surface="project" locale={locale} resetKey="notes">
											<NotesScreen
												locale={locale}
												projects={workspace.projects}
												selected={notesRoute.note}
												onSelect={(id) => openNotes(id)}
												onSearch={() => setSearch('search')}
												tasks={workspace.tasks}
												onCreateTask={(note, part) => void noteTask(note, part)}
												onOpenTask={openNoteTask}
											/>
										</SurfaceBoundary>
									) : !task && mainTree && mainTree.task.projectId === activeProject?.id ? (
										<SurfaceBoundary
											surface="task"
											locale={locale}
											resetKey={`${mainTree.task.projectId}/main-tree`}>
											<TaskView
												key={`${mainTree.task.projectId}/main-tree`}
												task={mainTree.task}
												mainTree={mainTree}
												locale={locale}
												projectName={activeProject.name}
												onRelay={() => {}}
												onProposal={(proposal) => proposalTask(mainTree.task, proposal)}
												onOpenTask={openTask}
												onSearch={() => setSearch('search')}
												onEditorSettings={() => setSettings('editor')}
												onQuickTask={(context) =>
													setQuickTask({ projectId: activeProject.id, ...context })
												}
											/>
										</SurfaceBoundary>
									) : task ? (
										<SurfaceBoundary
											surface="task"
											locale={locale}
											resetKey={`${task.projectId}/${task.id}`}>
											<TaskView
												key={`${task.projectId}/${task.id}`}
												task={task}
												locale={locale}
												projectName={activeProject?.name ?? ''}
												onRelay={() => relayTask(task)}
												onProposal={(proposal) => proposalTask(task, proposal)}
												onOpenTask={openTask}
												onSearch={() => setSearch('search')}
												onEditorSettings={() => setSettings('editor')}
											/>
										</SurfaceBoundary>
									) : restoring ? null : workspace && boardProject ? (
										<SurfaceBoundary surface="project" locale={locale} resetKey={boardProject}>
											<ProjectScreen
												key={boardProject}
												archived={
													archived.filter(
														(item) => boardProject === '*' || item.projectId === boardProject
													).length
												}
												openArchive={() =>
													setArchiveWindow({
														projectId: boardProject === '*' ? null : boardProject,
													})
												}
												workspace={workspace}
												projectId={boardProject}
												locale={locale}
												newTask={(backlog) => {
													if (activeProject) showNew(activeProject.id, backlog);
												}}
												editTask={editTask}
												taskMenu={taskMenu}
												search={() => setSearch('search')}
												knowledgeMenu={() => projectMenu(boardProject)}
												statusFilter={statusFilter}
												quietRuns={quietRuns}
												quickTask={setQuickTask}
												section={section}
											/>
										</SurfaceBoundary>
									) : (
										<div className={styles.empty}>
											<Glyph name="folder" size={44} />
											<h1>
												{t(locale, workspace?.projects.length ? 'Select a task' : 'No projects')}
											</h1>
											<p>
												{t(
													locale,
													workspace?.projects.length
														? 'No task is selected.'
														: 'The workspace is empty.'
												)}
											</p>
											<Button
												appearance="primary"
												onClick={() => (activeProject ? showNew(activeProject.id) : addProject())}>
												{t(locale, activeProject ? 'New task' : 'Open a project…')}
											</Button>
										</div>
									)}
									<RemoteWindowState locale={locale} part="card" />
									<RemoteDialogs locale={locale} />
									<ToastHost locale={locale} />
									<NotificationCenterEvents />
									{!!workspace?.issues.length && (
										<section role="alert" className={styles.issues}>
											<h2>{t(locale, 'Some data could not be read.')}</h2>
											{workspace.issues.map((issue) => (
												<p key={issue.path}>
													{t(locale, issueLabels[issue.code])} <code>{issue.path}</code>
												</p>
											))}
										</section>
									)}
								</main>
								{/* Last in the layout: Electron resolves app-region in document order, so a no-drag button before the sidebar chrome or the title strip would be swallowed by their drag regions. */}
								<button
									type="button"
									className={styles.sidebarToggle}
									aria-label={t(locale, sidebarHidden ? 'Show sidebar' : 'Hide sidebar')}
									title={((key) =>
										key
											? `${t(locale, sidebarHidden ? 'Show sidebar' : 'Hide sidebar')} · ${formatAccelerator(key)}`
											: t(locale, sidebarHidden ? 'Show sidebar' : 'Hide sidebar'))(
										commandAccelerator(
											menuCommands.find((item) => item.id === 'sidebar-toggle')!,
											appearance.keymap ?? defaultKeymap
										)
									)}
									onClick={() => setSidebarHidden((value) => !value)}>
									<Glyph name={sidebarHidden ? 'sidebar-toggle-off' : 'sidebar-toggle'} size={16} />
								</button>
								<RemoteWindowState locale={locale} part="dim" />
								{/* spec/sidebar#width: the sidebar's edge, after the drag regions for the same reason as the toggle. */}
								{!sidebarHidden && sidebarPresent && (
									<div className={styles.sidebarResize}>
										<ResizeHandle
											label={t(locale, 'Resize sidebar')}
											value={sidebarWidth}
											min={layoutLimits.sidebarWidth[0]}
											max={layoutLimits.sidebarWidth[1]}
											edge="end"
											onChange={(value) =>
												useSurfaceLayout.getState().resize('sidebarWidth', value)
											}
											onCommit={() => useSurfaceLayout.getState().save()}
										/>
									</div>
								)}
							</div>
						)}
						{/* After every strip: Electron resolves app-region in document order. */}
						{pcChrome && <AppMenuButton locale={locale} />}
						{renaming && (
							<RenameTask
								key={`${renaming.projectId}/${renaming.id}`}
								task={renaming}
								locale={locale}
								close={() => setRenaming(null)}
								saved={load}
							/>
						)}
						{quickTask && (
							<QuickTask
								key={JSON.stringify(quickTask)}
								request={quickTask}
								locale={locale}
								close={() => setQuickTask(null)}
								more={(request) => {
									setQuickTask(null);
									showNew(request.projectId);
								}}
								started={(started) => {
									void load();
									showToast(t(locale, 'Quick task started'), {
										label: t(locale, 'Open'),
										run: () => openTask(started),
									});
								}}
							/>
						)}
						{launchProject && (
							<NewTask
								key={`${launchProject.id}/${editing?.id ?? duplicateSource?.id ?? proposalSheet?.proposal.id ?? noteSheet?.id ?? 'new'}`}
								backlog={newBacklog}
								{...(duplicateSource ? { duplicateSource } : {})}
								{...(relaySource ? { relaySource } : {})}
								{...(proposalSheet ? { proposal: proposalSheet } : {})}
								{...(noteSheet ? { note: noteSheet } : {})}
								{...(editing ? { editing } : {})}
								when={newWhen}
								scheduled={(schedule) => {
									setNewProject(null);
									setDuplicateSource(undefined);
									openSchedules({ projectId: schedule.projectId, id: schedule.id });
								}}
								projectId={launchProject.id}
								projectName={launchProject.name}
								locale={locale}
								close={() => setNewProject(null)}
								created={async (task) => {
									// spec/notifications-slack-notes-and-schedules#notes: the link back goes into the note, under the lines the task came from.
									if (noteSheet)
										await window.brigadir
											.linkNoteTask(
												noteSheet.id,
												{ projectId: task.projectId, id: task.id, title: task.title },
												noteSheet.after
											)
											.catch(() =>
												toastError(t(locale, 'Could not save the note. Changes are kept.'))
											);
									await load();
									/* spec/tasks#agent-created-tasks: a task from a proposal leaves you in the chat it came from; its row there opens it. */ if (
										proposalSheet
									) {
									} else if (noteSheet) {
										// The person stays in the note; the link to the task is there.
									} else if (task.status === 'backlog') selectProject(task.projectId);
									else useWorkspace.getState().selectTask(task.projectId, task.id);
									setNewProject(null);
									setEditing(undefined);
									setProposalSheet(undefined);
									setNoteSheet(undefined);
								}}
							/>
						)}
					</div>
				</PullRequestsProvider>
			</ForgeProvider>
		</AgentsProvider>
	);
}
