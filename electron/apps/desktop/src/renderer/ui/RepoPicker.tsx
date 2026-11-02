/**
 * spec/pull-requests-and-ci#repo-picker: the repo picker of a PR list — the PR panel's header and, since spec/projects-and-board#pr-mode, the project screen's Pull requests tab.
 * One look in both (rule 17).
 */
import { useRef, useState } from 'react';
import {
	isOpenPR,
	t,
	type Locale,
	type PullRequestSummary,
	type RepoPullRequests,
} from '@brigadir/core';
import { Button, Chevron } from './Controls';
import { Glyph } from './Glyph';
import { MenuItem, MenuPopover, MenuSeparator } from './Popover';
import s from './RepoPicker.module.css';
/** The Repo section's name of a repo: the root is the project's name. */
export const repoName = (repo: { name: string }, projectName: string) =>
	repo.name === '.' ? projectName : repo.name;
/**
 * spec/pull-requests-and-ci#repo-picker: the repo of the PR list in the panel's header, in place of spec/pull-requests-and-ci#repo-counter's chip. The menu is the shared one
 * with `Repo` and `Esc`: «All repos» with the open PRs of all, then each repo in the Repo section's order with its open
 * PRs; a repo with no PR in the list is dimmed and off. CI shows one repo's runs, so there it has no «All repos» and no counts.
 */
export function RepoPicker({
	className,
	label: shownLabel,
	locale,
	projectName,
	repos,
	value,
	all,
	onChange,
}: {
	/** The host places it (the panel's header lets it shrink first, spec/pull-requests-and-ci#pr-panel). */ className?:
		string | undefined;
	/** A repo's name in the list when the host names it otherwise (All projects: «project · repo», spec/projects-and-board#pr-mode). */ label?:
		((repo: RepoPullRequests) => string) | undefined;
	locale: Locale;
	projectName: string;
	repos: readonly RepoPullRequests[];
	value: string | null;
	all: boolean;
	onChange(scopeId: string | null): void;
}) {
	const [open, setOpen] = useState(false),
		anchor = useRef<HTMLButtonElement>(null),
		picked = repos.find((repo) => repo.scopeId === value),
		openCount = (prs: readonly PullRequestSummary[]) => prs.filter(isOpenPR).length,
		count = (n: number) => (
			<span className={s.repoCount}>
				<Glyph name="pr-branch" size={11} />
				{n}
			</span>
		),
		name = (repo: RepoPullRequests) => shownLabel?.(repo) ?? repoName(repo, projectName),
		label = picked ? name(picked) : t(locale, 'All repos');
	return (
		<>
			<Button
				ref={anchor}
				appearance={picked && all ? 'primary' : 'neutral'}
				variant="soft"
				className={className ? `${s.picker} ${className}` : s.picker}
				data-repo-picker
				aria-haspopup="menu"
				aria-expanded={open}
				aria-label={`${t(locale, 'Repo')} · ${label}`}
				title={t(locale, 'Repo')}
				onClick={() => setOpen((value) => !value)}>
				<span>{label}</span>
				<Chevron />
			</Button>
			<MenuPopover
				open={open}
				onClose={() => setOpen(false)}
				anchor={anchor}
				align="start"
				width={224}
				focus="checked"
				label={t(locale, 'Repo')}
				locale={locale}>
				{all && (
					<>
						<MenuItem
							kind="radio"
							checked={!picked}
							tail={count(openCount(repos.flatMap((repo) => repo.prs)))}
							onSelect={() => onChange(null)}>
							{t(locale, 'All repos')}
						</MenuItem>
						<MenuSeparator />
					</>
				)}
				{repos.map((repo) => (
					<MenuItem
						key={repo.scopeId}
						kind="radio"
						checked={repo.scopeId === picked?.scopeId}
						disabled={all && !repo.prs.length}
						tail={
							all ? (repo.prs.length ? count(openCount(repo.prs)) : t(locale, 'No PRs')) : undefined
						}
						data-repo={repo.name}
						onSelect={() => onChange(repo.scopeId)}>
						{name(repo)}
					</MenuItem>
				))}
			</MenuPopover>
		</>
	);
}
