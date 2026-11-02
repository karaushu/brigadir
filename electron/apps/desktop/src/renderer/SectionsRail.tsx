import type { ReactNode, Ref } from 'react';
import { formatAccelerator, t, withShortcut, type Locale } from '@brigadir/core';
import { IconButton } from './ui/Controls';
import { Glyph } from './ui/Glyph';
import { Rail, RailSection } from './ui/Rail';
import { useCommandShortcut } from './ui/use-command-shortcut';

/** spec/sidebar#section-rail: the rail's sections — Tasks, Pull requests, Notes (spec/notifications-slack-notes-and-schedules#notes) and Schedules (spec/notifications-slack-notes-and-schedules#schedules). */
export type SectionId = 'tasks' | 'prs' | 'notes' | 'schedules';

/**
 * spec/sidebar#section-rail (rule 17): the sections rail as the window has it — Tasks · Pull requests · Notes · Schedules on
 * `ui/Rail`, their glyphs, names and shortcuts in the hint, the counts and the Schedules dot; a module that is off takes its
 * section away. The foot (`tools`) is the caller's: the app gives its live bell, Remote, limits and Settings, the intro's
 * sample window the same tiles at rest. Without `onOpen` nothing acts (the intro's window is inert anyway).
 */
export function SectionsRail({
	locale,
	strip,
	modules,
	selected,
	counts,
	scheduleDot,
	onOpen,
	tileRefs,
	tools,
}: {
	locale: Locale;
	/** ☰ on Windows and Linux; nothing under the macOS traffic lights. */ strip?: ReactNode;
	/** The sections whose module is on (spec/sidebar#section-rail); Tasks is always there. */ modules: {
		prs: boolean;
		notes: boolean;
		schedules: boolean;
	};
	/** The open section, or none. */ selected: SectionId | null;
	/** spec/sidebar#section-rail: Tasks — amber, tasks that wait; Pull requests — accent, PRs that wait for your review. */ counts?: {
		tasks?: number;
		prs?: number;
	};
	/** spec/notifications-slack-notes-and-schedules#schedules: the Schedules dot (a CSS colour); `null` keeps the slot so it fades out. */ scheduleDot?:
		string | null;
	onOpen?(section: SectionId): void;
	/** A section's tile, for whoever measures it (the intro's spotlight). */ tileRefs?: Partial<
		Record<SectionId, Ref<HTMLButtonElement>>
	>;
	tools: ReactNode;
}) {
	const shortcut = useCommandShortcut();
	const tile = (
		id: SectionId,
		name: string,
		command: string,
		glyph: Parameters<typeof Glyph>[0]['name'],
		extra: { count?: number; tone?: 'amber' | 'accent'; dot?: string | null } = {}
	) => (
		<RailSection
			ref={tileRefs?.[id]}
			section={id}
			label={name}
			hint={withShortcut(name, shortcut(command))}
			selected={selected === id}
			{...extra}
			onClick={() => onOpen?.(id)}>
			<Glyph name={glyph} size={18} />
		</RailSection>
	);
	return (
		<Rail
			label={t(locale, 'Sections')}
			strip={strip}
			sections={
				<>
					{tile('tasks', t(locale, 'Tasks (section)'), 'section-tasks', 'board', {
						count: counts?.tasks ?? 0,
						tone: 'amber',
					})}
					{modules.prs &&
						tile('prs', t(locale, 'Pull requests (section)'), 'section-prs', 'pr-branch', {
							count: counts?.prs ?? 0,
						})}
					{/* spec/notifications-slack-notes-and-schedules#notes → spec/sidebar#section-rail: Notes is the rail's third section; it opens the Notes screen. */}
					{modules.notes && tile('notes', t(locale, 'Notes'), 'notes', 'note')}
					{/* spec/notifications-slack-notes-and-schedules#schedules: Schedules is the rail's fourth section, ⌃⌘4. */}
					{modules.schedules &&
						tile(
							'schedules',
							t(locale, 'Schedules'),
							'schedules',
							'schedule',
							scheduleDot === undefined ? {} : { dot: scheduleDot }
						)}
				</>
			}
			tools={tools}
		/>
	);
}

/** spec/sidebar#section-rail: the rail's Settings tile — the gear, the Settings dialog (⌘,). */
export function SettingsTile({ locale, onClick }: { locale: Locale; onClick?(): void }) {
	const name = t(locale, 'Settings (rail)');
	return (
		<IconButton
			label={name}
			hint={withShortcut(name, formatAccelerator('CmdOrCtrl+,'))}
			onClick={onClick}>
			<Glyph name="settings" size={18} />
		</IconButton>
	);
}
