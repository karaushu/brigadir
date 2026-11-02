import { useRef, useState } from 'react';
import {
	t,
	sidebarMatches,
	type AgentTask,
	type Locale,
	type MessageKey,
	type PRFilter,
	type SidebarFilter,
} from '@brigadir/core';
import { Glyph, type GlyphName } from './ui/Glyph';
import { IconButton } from './ui/Controls';
import { MenuItem, MenuPopover, MenuSeparator } from './ui/Popover';

/** spec/sidebar#status-filter: the sidebar's status filters behind one button; the active one shows as a dot of its colour over the glyph. */
const FILTERS: readonly {
	filter: Exclude<SidebarFilter, null>;
	label: MessageKey;
	icon: GlyphName;
	color: string;
}[] = [
	{ filter: 'needs-you', label: 'Needs you', icon: 'sidebar-needs', color: 'var(--amber)' },
	{ filter: 'running', label: 'Running', icon: 'sidebar-running', color: 'var(--accent)' },
	{ filter: 'unreviewed', label: 'Unreviewed', icon: 'sidebar-unreviewed', color: 'var(--accent)' },
];

export function SidebarFilterButton({
	locale,
	live,
	value,
	onChange,
	quiet,
}: {
	locale: Locale;
	live: readonly AgentTask[];
	value: SidebarFilter;
	onChange(value: SidebarFilter): void;
	/** spec/notifications-slack-notes-and-schedules#schedules: «Quiet scheduled runs» — a check under the statuses; null while the schedules module is off. */ quiet?: {
		on: boolean;
		count: number;
		toggle(): void;
	} | null;
}) {
	const [open, setOpen] = useState(false),
		button = useRef<HTMLButtonElement>(null);
	const active = FILTERS.find((entry) => entry.filter === value);
	const label = `${t(locale, 'Filter by status')}${active ? ` · ${t(locale, active.label)}` : ''}`;
	return (
		<>
			<IconButton
				ref={button}
				data-status-filter={value ?? undefined}
				label={label}
				aria-haspopup="menu"
				aria-expanded={open}
				dot={active?.color ?? (quiet?.on ? 'var(--accent)' : null)}
				onClick={() => setOpen((state) => !state)}>
				<Glyph name="filter" size={14} />
			</IconButton>
			<MenuPopover
				open={open}
				onClose={() => setOpen(false)}
				anchor={button}
				side="bottom"
				width={230}
				label={t(locale, 'Filter by status')}
				locale={locale}
				focus="checked">
				<MenuItem
					kind="radio"
					checked={value === null}
					icon={<Glyph name="list" size={14} />}
					tail={String(live.length)}
					onSelect={() => onChange(null)}>
					{t(locale, 'All tasks')}
				</MenuItem>
				<MenuSeparator />
				{FILTERS.map((entry) => (
					<MenuItem
						key={entry.filter}
						kind="radio"
						checked={value === entry.filter}
						icon={<Glyph name={entry.icon} size={14} />}
						tail={String(live.filter((item) => sidebarMatches(item, entry.filter)).length)}
						// The checked filter chosen again turns off, as the chips did (spec/sidebar#filter-behaviour).
						onSelect={() => onChange(value === entry.filter ? null : entry.filter)}>
						{t(locale, entry.label)}
					</MenuItem>
				))}
				{quiet && (
					<>
						<MenuSeparator />
						<MenuItem
							kind="check"
							checked={quiet.on}
							icon={<Glyph name="schedule" size={14} />}
							tail={String(quiet.count)}
							keepOpen
							onSelect={quiet.toggle}>
							{t(locale, 'Quiet scheduled runs')}
						</MenuItem>
					</>
				)}
			</MenuPopover>
		</>
	);
}

/** spec/sidebar#section-rail: the Pull requests section's filter — All · Yours · Waiting for you — behind the same button and menu. */
export function PRFilterButton({
	locale,
	value,
	waiting,
	onChange,
}: {
	locale: Locale;
	value: PRFilter;
	waiting: number;
	onChange(value: PRFilter): void;
}) {
	const [open, setOpen] = useState(false),
		button = useRef<HTMLButtonElement>(null);
	const options: readonly { filter: PRFilter; label: MessageKey; icon: GlyphName }[] = [
		{ filter: 'all', label: 'All (PRs)', icon: 'pr-branch' },
		{ filter: 'mine', label: 'Yours', icon: 'person' },
		{ filter: 'waiting', label: 'Waiting for you', icon: 'review' },
	];
	const active = options.find((entry) => entry.filter === value && value !== 'all');
	return (
		<>
			<IconButton
				ref={button}
				data-pr-filter={value}
				label={`${t(locale, 'PR filter')}${active ? ` · ${t(locale, active.label)}` : ''}`}
				aria-haspopup="menu"
				aria-expanded={open}
				dot={active ? 'var(--accent)' : null}
				onClick={() => setOpen((state) => !state)}>
				<Glyph name="filter" size={14} />
			</IconButton>
			<MenuPopover
				open={open}
				onClose={() => setOpen(false)}
				anchor={button}
				side="bottom"
				width={230}
				label={t(locale, 'PR filter')}
				locale={locale}
				focus="checked">
				{options.map((entry, index) => (
					<MenuItem
						key={entry.filter}
						kind="radio"
						checked={value === entry.filter}
						icon={<Glyph name={entry.icon} size={14} />}
						tail={entry.filter === 'waiting' && waiting ? String(waiting) : undefined}
						onSelect={() => onChange(entry.filter)}>
						{index === 0 ? t(locale, 'All pull requests') : t(locale, entry.label)}
					</MenuItem>
				))}
			</MenuPopover>
		</>
	);
}
