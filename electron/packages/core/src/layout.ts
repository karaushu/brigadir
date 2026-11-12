import { isRecord } from './workspace';
/** spec/sidebar#width: `sidebarWidth` — the projects sidebar, 220–480, 280 by default (the canvas width). */
/** spec/browser-and-simulator#simulator: `simulatorWidth` — the simulator column, 360–800, 460 by default. */
/** spec/git#commit-strip's `commitCollapsed` is gone: the commit strip is always one row (spec/git#commit-dialog). spec/composer#capsule-squeeze: `composerCapsuleCompact` — the agent capsule is one compact button at any width
 *  (it replaced spec/git#commit-strip's `composerEnvironmentCollapsed`: the environment is now the island's footer and does not fold). */
/** `reviewFilesWidth` / `reviewColumnWidth` — the review modal's files and step column (spec/appearance#evolution-redesign), 220 and 340 by default (the canvas). */
/** spec/task-window-workspace#layout-switch: the two / three columns setting (`columns`) is gone; the layout is each task's three switches (task-layout.ts). */
/** spec/sidebar#section-rail: the sections of the rail left of the sidebar, in rail order; each sets what the sidebar lists. */
export const sidebarSections = ['tasks', 'prs'] as const;
export type SidebarSection = (typeof sidebarSections)[number];
export const isSidebarSection = (value: unknown): value is SidebarSection =>
	sidebarSections.includes(value as SidebarSection);
export type SurfaceLayout = {
	sidebarWidth: number;
	changesWidth: number;
	browserWidth: number;
	simulatorWidth: number;
	consoleHeight: number;
	chatWidth: number;
	/** spec/notifications-slack-notes-and-schedules#note-chat: the note's chat column, 352 by default. */ noteChatWidth: number;
	reviewFilesWidth: number;
	reviewColumnWidth: number;
	composerCapsuleCompact: boolean;
	/** spec/sidebar#section-rail: the rail's section the sidebar shows, `tasks` by default. */ sidebarSection: SidebarSection;
};
export type SurfaceToggle = 'composerCapsuleCompact';
export const defaultSurfaceLayout: SurfaceLayout = {
	sidebarWidth: 280,
	changesWidth: 400,
	browserWidth: 460,
	simulatorWidth: 460,
	consoleHeight: 260,
	chatWidth: 420,
	noteChatWidth: 352,
	reviewFilesWidth: 220,
	reviewColumnWidth: 340,
	composerCapsuleCompact: false,
	sidebarSection: 'tasks',
};
/** spec/task-window#width-rules, spec/task-window#width-rules: the browser and the chat have no design ceiling, the window is their ceiling (the renderer clamps them to
 *  the space the other columns leave). 8000 only keeps a broken file out; it is wider than any display. */
export const layoutLimits = {
	sidebarWidth: [220, 480],
	changesWidth: [200, 500],
	browserWidth: [420, 8000],
	simulatorWidth: [360, 800],
	consoleHeight: [120, 600],
	chatWidth: [380, 8000],
	noteChatWidth: [300, 8000],
	reviewFilesWidth: [180, 480],
	reviewColumnWidth: [280, 600],
} as const;
export const surfaceToggles: readonly SurfaceToggle[] = ['composerCapsuleCompact'];
export function isSurfaceLayout(value: unknown): value is SurfaceLayout {
	return (
		isRecord(value) &&
		Object.entries(layoutLimits).every(
			([key, [min, max]]) =>
				Number.isInteger(value[key]) && Number(value[key]) >= min && Number(value[key]) <= max
		) &&
		surfaceToggles.every((key) => typeof value[key] === 'boolean') &&
		isSidebarSection(value.sidebarSection)
	);
}
