import { useMemo, useState } from 'react';
import {
	prColumn,
	prKeyOf,
	prPasses,
	relativeAge,
	t,
	waitingCount,
	type Locale,
	type MessageKey,
	type PRColumn,
	type PRFilter,
	type WorkspaceSnapshot,
} from '@brigadir/core';
import type { BoardPR, useBoardPRs } from './ProjectPRs';
import { PRFilterButton } from './SidebarFilter';
import { usePRSectionReview } from './pr-section';
import { SearchField } from './ui/PanelSearch';
import { Glyph } from './ui/Glyph';
import { PRStateGlyph } from './ui/PRGlyphs';
import { ProjectIcon } from './ui/ProjectIcon';
import { SkeletonRows } from './ui/Loading';
import styles from './App.module.css';

const columnLabels: Partial<Record<PRColumn, MessageKey>> = {
	draft: 'Draft (column)',
	open: 'Open (column)',
	review: 'In review (column)',
};

/**
 * spec/sidebar#section-rail: the sidebar of the Pull requests section — the filter field and
 * the All · Yours · Waiting for you menu, `All pull requests`, then the projects as the task groups are drawn (rule 17), each
 * with its open PRs and drafts: the state glyph, the title, `#N · waiting for you | the column · age`. A project or `All
 * pull requests` shows the PR board; a PR row opens its review over it (spec/projects-and-board#pr-mode). The same data and cache as the board.
 */
export function SidebarPRs({
	prs,
	workspace,
	locale,
	colors,
	selected,
	onSelect,
	onReview,
}: {
	/** The rail's read of every project's PRs (it counts what waits for you). */ prs: ReturnType<
		typeof useBoardPRs
	>;
	workspace: WorkspaceSnapshot;
	locale: Locale;
	colors: Map<string, number>;
	/** The board on screen: `*` for all projects, a project's id, or null when a task is open. */ selected:
		string | null;
	onSelect(projectId: string): void;
	onReview(item: BoardPR): void;
}) {
	const [filter, setFilter] = useState<PRFilter>('all'),
		[query, setQuery] = useState(''),
		/** Groups flipped from their default: a project with PRs opens, one without stays folded. */
		[flipped, setFlipped] = useState<string[]>([]);
	const reviewing = usePRSectionReview((state) => state.item);
	const now = Date.now();
	// Open PRs and drafts; the closed ones live in the board's Closed column.
	const open = useMemo(
		() =>
			prs.items
				.map((item) => ({ item, column: prColumn(item.pr, item.local, now) }))
				.filter(
					(entry): entry is { item: BoardPR; column: PRColumn } =>
						!!entry.column && entry.column !== 'closed'
				),
		[prs.items]
	);
	const needle = query.trim().toLowerCase();
	const shown = open
		.filter(({ item }) => prPasses(item.pr, filter))
		.filter(
			({ item }) =>
				!needle ||
				item.pr.title.toLowerCase().includes(needle) ||
				String(item.pr.number).includes(needle) ||
				item.pr.head.toLowerCase().includes(needle)
		)
		.sort(
			(a, b) =>
				Number(b.item.pr.waiting) - Number(a.item.pr.waiting) ||
				(Date.parse(b.item.pr.updatedAt) || 0) - (Date.parse(a.item.pr.updatedAt) || 0)
		);
	const waiting = waitingCount(open.map(({ item }) => item.pr));
	const groups = workspace.projects
		.map((project) => ({
			project,
			rows: shown.filter(({ item }) => item.projectId === project.id),
		}))
		// spec/pull-requests-and-ci#project-pr-section: every project is a group, as in Tasks; with a query or a filter only those with matches.
		.filter(({ rows }) => rows.length || (!needle && filter === 'all'));
	const rowKey = (item: BoardPR) => `${item.projectId}/${prKeyOf(item.scopeId, item.pr.number)}`;
	return (
		<>
			<div className={styles.taskFilter} data-size="s">
				<SearchField
					className={styles.taskFilterField}
					locale={locale}
					label={t(locale, 'Filter pull requests')}
					value={query}
					onChange={setQuery}
					onKeyDown={(event) => {
						if (event.key === 'Escape' && query) {
							event.preventDefault();
							setQuery('');
						}
					}}
				/>
				<PRFilterButton locale={locale} value={filter} waiting={waiting} onChange={setFilter} />
			</div>
			<div className={styles.allProjectsRow} data-selected={selected === '*' && !reviewing}>
				<button
					className={styles.allProjects}
					aria-pressed={selected === '*' && !reviewing}
					onClick={() => onSelect('*')}>
					<Glyph name="pr-branch" size={14} />
					{t(locale, 'All pull requests')}
				</button>
				{prs.loaded && waiting > 0 && (
					<span
						className={styles.sectionWaiting}
						title={t(locale, 'Waiting for you')}
						aria-label={`${t(locale, 'Waiting for you')} · ${waiting}`}>
						{waiting}
					</span>
				)}
			</div>
			<div data-sidebar-list data-sidebar-prs className={styles.projectList}>
				{!prs.loaded ? (
					<SkeletonRows count={4} height={46} />
				) : !groups.length ? (
					<p className={styles.muted}>{t(locale, 'No pull requests')}</p>
				) : (
					groups.map(({ project, rows }) => {
						const shut = !rows.length !== flipped.includes(project.id),
							mine = rows.filter(({ item }) => item.pr.waiting).length;
						return (
							<section key={project.id} className={styles.project} data-open={!shut}>
								<div
									className={styles.projectHeader}
									data-selected={(selected === project.id && !reviewing) || undefined}>
									<button
										className={styles.projectCollapse}
										aria-label={`${t(locale, shut ? 'Expand project' : 'Collapse project')} · ${project.name}`}
										title={t(locale, shut ? 'Expand project' : 'Collapse project')}
										aria-expanded={!shut}
										onClick={() =>
											setFlipped((list) =>
												list.includes(project.id)
													? list.filter((id) => id !== project.id)
													: [...list, project.id]
											)
										}>
										<Glyph name="sidebar-chevron" size={9} />
									</button>
									<span className={styles.projectIconButton} aria-hidden="true">
										<ProjectIcon project={project} slot={colors.get(project.id) ?? 0} />
									</span>
									<h3 title={project.path}>
										<button
											className={styles.projectSelect}
											aria-pressed={selected === project.id && !reviewing}
											onClick={() => onSelect(project.id)}>
											{project.name}
										</button>
									</h3>
									{mine > 0 ? (
										<span
											className={styles.sectionWaiting}
											title={t(locale, 'Waiting for you')}
											aria-label={`${t(locale, 'Waiting for you')} · ${mine}`}>
											{mine}
										</span>
									) : (
										<span className={styles.sectionGroupCount}>{rows.length}</span>
									)}
								</div>
								<div
									className={styles.projectDisclosure}
									data-open={!shut}
									inert={shut}
									aria-hidden={shut}>
									<div>
										{!rows.length && (
											<p className={styles.muted}>{t(locale, 'No pull requests')}</p>
										)}
										{rows.map(({ item, column }) => (
											<button
												key={rowKey(item)}
												className={styles.task}
												data-sidebar-pr={item.pr.number}
												aria-pressed={!!reviewing && rowKey(reviewing) === rowKey(item)}
												title={`#${item.pr.number} · ${item.pr.title}`}
												onClick={() => onReview(item)}>
												<PRStateGlyph pr={item.pr} size={14} />
												<span className={styles.taskCopy}>
													<span className={styles.taskHead}>
														<span className={styles.taskTitle}>{item.pr.title}</span>
													</span>
													<small className={styles.prLine}>
														#{item.pr.number}
														{' · '}
														{item.pr.waiting ? (
															<b>{t(locale, 'Waiting for you')}</b>
														) : (
															t(locale, columnLabels[column]!)
														)}
														{' · '}
														<time dateTime={item.pr.updatedAt}>
															{relativeAge(locale, item.pr.updatedAt, now)}
														</time>
													</small>
												</span>
											</button>
										))}
									</div>
								</div>
							</section>
						);
					})
				)}
			</div>
		</>
	);
}
