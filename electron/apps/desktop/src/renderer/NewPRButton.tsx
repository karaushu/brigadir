import { useRef, useState } from 'react';
import { MAIN_TREE_ID, t, type Locale, type Project } from '@brigadir/core';
import { Button } from './ui/Controls';
import { Glyph } from './ui/Glyph';
import { MenuItem, MenuPopover } from './ui/Popover';
import { ProjectIcon } from './ui/ProjectIcon';
import { requestForgeAction } from './Forge';
import { repoName } from './ui/RepoPicker';
import { useWorkspace } from './store';
import type { BoardRepo } from './ProjectPRs';

/**
 * spec/pull-requests-and-ci#project-pr-section: the Pull requests board's action — the New pull request dialog (spec/pull-requests-and-ci#ready-card, spec/pull-requests-and-ci#from-into `From → Into`) in the
 * main tree of a repo's project. One GitHub repo on the board opens it at once; more list `project · repo` first.
 */
export function NewPRButton({
	locale,
	repos,
	projects,
}: {
	locale: Locale;
	/** The board's repos on GitHub. */ repos: readonly BoardRepo[];
	projects: readonly Project[];
}) {
	const [open, setOpen] = useState(false),
		anchor = useRef<HTMLButtonElement>(null);
	const start = (repo: BoardRepo) => {
		setOpen(false);
		requestForgeAction({ projectId: repo.projectId, id: MAIN_TREE_ID }, 'pr', repo.scopeId);
		void useWorkspace.getState().openMainTree(repo.projectId, repo.scopeId);
	};
	// The root repo reads as its project (spec/pull-requests-and-ci#repo-picker); a nested one as `project · path`.
	const name = (repo: BoardRepo) => {
		const project = projects.find((item) => item.id === repo.projectId)?.name ?? '';
		const own = repoName(repo, project);
		return own === project ? project : `${project} · ${own}`;
	};
	return (
		<>
			<Button
				ref={anchor}
				appearance="primary"
				data-new-pr-board
				disabled={!repos.length}
				title={repos.length ? undefined : t(locale, 'GitHub is unavailable')}
				aria-haspopup={repos.length > 1 ? 'menu' : undefined}
				aria-expanded={repos.length > 1 ? open : undefined}
				onClick={() => (repos.length === 1 ? start(repos[0]!) : setOpen((value) => !value))}>
				<Glyph name="plus" size={13} />
				{t(locale, 'New pull request')}
			</Button>
			<MenuPopover
				open={open}
				onClose={() => setOpen(false)}
				anchor={anchor}
				side="bottom"
				align="end"
				width={280}
				label={t(locale, 'New pull request')}
				locale={locale}>
				{repos.map((repo) => {
					const project = projects.find((item) => item.id === repo.projectId);
					return (
						<MenuItem
							key={`${repo.projectId}/${repo.scopeId}`}
							icon={project ? <ProjectIcon project={project} slot={0} size={14} /> : undefined}
							onSelect={() => start(repo)}>
							{name(repo)}
						</MenuItem>
					);
				})}
			</MenuPopover>
		</>
	);
}
