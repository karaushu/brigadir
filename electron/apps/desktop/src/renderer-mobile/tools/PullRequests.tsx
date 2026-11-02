/**
 * spec/remote-access-and-mobile#phone-pr-list: the project's PR segment — the search and the repo picker,
 * the chips All · Waiting for you · Yours, the groups of the computer's PR panel, pull to refresh, the first read, an empty
 * list and GitHub without a sign-in on the machine. A row opens the PR in the main tree's context.
 */
import { useEffect, useMemo, useRef, useState } from 'react';
import { create } from 'zustand';
import {
	isOpenPR,
	prAge,
	t,
	type Locale,
	type MessageKey,
	type PRGroup,
	type PullRequestsSnapshot,
} from '@brigadir/core';
import { Button, StatusIcon } from '../../renderer/ui/Controls';
import { Avatar } from '../../renderer/ui/Avatar';
import { Glyph } from '../../renderer/ui/Glyph';
import { CIGlyph } from '../../renderer/ui/RunSteps';
import { Highlight } from '../../renderer/ui/PanelSearch';
import { PRMarkGlyph, PRStateGlyph } from '../../renderer/ui/PRGlyphs';
import { Banner, Counts } from '../ui/Cards';
import { Chip, ChipRow } from '../ui/Chip';
import { Icon } from '../ui/Icon';
import { Caption, Group, Sheet, SheetRow } from '../ui/Sheet';
import { back, navigate, openSheet } from '../router';
import { useMobile } from '../store';
import { loadPRList, type PRListEntry } from './prs';
import {
	chipCounts,
	defaultChip,
	githubRepos,
	prItems,
	prSections,
	repoName,
	type PRChip,
	type PRItem,
} from './pr-list';
import { checksGlyph } from './logic';
import screen from '../screens/Screen.module.css';
import sheets from '../screens/Sheets.module.css';
import s from './PullRequests.module.css';

/** What the list keeps while a PR is open: the repo, the chip and the search of each project. */
type View = { repo: string | null; chip: PRChip | null; query: string; closed: boolean };
const blank: View = { repo: null, chip: null, query: '', closed: false };
export const usePRView = create<{ views: Record<string, View> }>(() => ({ views: {} }));
export const prView = (projectId: string) => usePRView.getState().views[projectId] ?? blank;
const setView = (projectId: string, patch: Partial<View>) =>
	usePRView.setState((state) => ({
		views: { ...state.views, [projectId]: { ...(state.views[projectId] ?? blank), ...patch } },
	}));
const groupLabels: Record<PRGroup, MessageKey> = {
	waiting: 'Waiting for you',
	mine: 'Yours',
	others: 'Others',
	closed: 'Recently closed',
};
const chips: { value: PRChip; label: MessageKey }[] = [
	{ value: 'all', label: 'All (PRs)' },
	{ value: 'waiting', label: 'Waiting for you' },
	{ value: 'mine', label: 'Yours' },
];
/** The repo the header's 🔗 and «Older closed PRs are on GitHub» open: the chosen one, else the first on GitHub. */
export function linkRepo(snapshot: PullRequestsSnapshot | null, chosen: string | null) {
	const repos = snapshot ? snapshot.repos.filter((repo) => repo.repository) : [];
	return (repos.find((repo) => repo.scopeId === chosen) ?? repos[0])?.scopeId ?? null;
}
export function openPulls(projectId: string, scopeId: string | null, closed = false) {
	if (!scopeId) return;
	// The tab opens from the tap itself (a popup blocker); the address follows.
	const tab = window.open('', '_blank');
	void window.brigadir
		.readPullRequestPageUrl(projectId, null, scopeId, null)
		.then((url) => {
			const address = closed ? `${url}?q=${encodeURIComponent('is:pr is:closed')}` : url;
			if (tab) {
				tab.opener = null;
				tab.location.href = address;
			} else window.open(address, '_blank', 'noopener,noreferrer');
		})
		.catch(() => tab?.close());
}
export function PRList({
	projectId,
	projectName,
	entry,
	locale,
}: {
	projectId: string;
	projectName: string;
	entry: PRListEntry | undefined;
	locale: Locale;
}) {
	const view = usePRView((state) => state.views[projectId] ?? blank),
		machine = useMobile((state) => state.machine);
	const snapshot = entry?.value ?? null;
	const repos = snapshot ? githubRepos(snapshot) : [];
	const repo = repos.some((item) => item.scopeId === view.repo) ? view.repo : null;
	const items = useMemo(
		() => (snapshot ? prItems(snapshot, projectName, repo) : []),
		[snapshot, projectName, repo]
	);
	const counts = chipCounts(items),
		chip = view.chip ?? defaultChip(items),
		several = repos.length > 1;
	const sections = prSections(items, { chip, query: view.query, closed: view.closed });
	const closedCount = items.filter((item) => !isOpenPR(item.pr)).length;
	const loading = !snapshot && (entry?.loading ?? true) && !entry?.error;
	const pull = usePull(() => loadPRList(projectId, true));
	if (snapshot && snapshot.auth !== 'ready' && snapshot.auth !== 'error')
		return (
			<div className={screen.scroll} data-pr-list="auth">
				<div className={s.auth}>
					<Banner
						amber
						data="pr-auth"
						icon={<Icon name="lock" size={20} className={s.authIcon} />}
						title={t(locale, 'GitHub is not connected on {machine}').replace('{machine}', machine)}
						sub={t(
							locale,
							snapshot.auth === 'missing'
								? 'Install GitHub CLI (gh) to create pull requests.'
								: 'Sign in with gh auth login to use GitHub.'
						)}
						action={
							<Button
								size="l"
								className={screen.bannerAction}
								onClick={() => void loadPRList(projectId, true)}>
								{t(locale, 'Retry (link)')}
							</Button>
						}
					/>
					<Caption className={s.authCaption}>
						{t(
							locale,
							'The command is run in the terminal of {machine}; it cannot be typed from a phone.'
						).replace('{machine}', machine)}
					</Caption>
				</div>
			</div>
		);
	const empty = snapshot && !loading && counts.all === 0 && !view.closed && !view.query.trim();
	return (
		<div ref={pull.scroller} className={screen.scroll} data-pr-list={loading ? 'loading' : 'list'}>
			{pull.state !== 'idle' && (
				<div className={s.pull} data-pull={pull.state} style={{ height: pull.height }}>
					{pull.state === 'refresh' ? (
						<StatusIcon status="working" label={t(locale, 'Refreshing from GitHub…')} size={24} />
					) : (
						<Icon name="arrowdn" size={20} />
					)}
					<span>
						{t(locale, pull.state === 'refresh' ? 'Refreshing from GitHub…' : 'Release to refresh')}
					</span>
				</div>
			)}
			<div className={s.top} data-dim={loading || undefined}>
				<div className={s.searchRow} data-size="l">
					<label className={s.field}>
						<Icon name="search" size={18} />
						<input
							type="search"
							value={view.query}
							aria-label={t(locale, 'Find a PR')}
							placeholder={t(locale, 'Find a PR')}
							data-pr-search
							onChange={(event) => setView(projectId, { query: event.target.value })}
						/>
					</label>
					{several && (
						<button
							type="button"
							className={s.repo}
							data-selected={repo !== null || undefined}
							data-pr-repo-picker
							aria-label={`Repo: ${
								repo
									? repoName(
											repos.find((item) => item.scopeId === repo)!,
											projectName
										)
									: t(locale, 'All repos')
							}`}
							onClick={() => openSheet({ kind: 'repo' })}>
							<span className="ell">
								{repo
									? repoName(
											repos.find((item) => item.scopeId === repo)!,
											projectName
										)
									: t(locale, 'All repos')}
							</span>
							<Icon name="chev" size={14} className={s.repoChevron} />
						</button>
					)}
				</div>
				<ChipRow role="radiogroup" label={t(locale, 'Pull requests (segment)')}>
					{chips.map((item) => (
						<Chip
							key={item.value}
							role="radio"
							selected={chip === item.value}
							data={{ 'pr-chip': item.value }}
							onClick={() => setView(projectId, { chip: item.value })}>
							{item.value === 'waiting' && <i className={s.waitingDot} />}
							{t(locale, item.label)}
							{!loading && <small>{counts[item.value]}</small>}
						</Chip>
					))}
				</ChipRow>
			</div>
			<div className={s.stack}>
				{entry?.error && snapshot && (
					<Banner
						data="pr-error"
						icon={<Icon name="x2" size={18} className={s.errorIcon} />}
						title={t(locale, 'PRs could not be read.')}
						sub={entry.error}
						action={
							<Button
								size="l"
								className={screen.bannerAction}
								onClick={() => void loadPRList(projectId, true)}>
								{t(locale, 'Retry (link)')}
							</Button>
						}
					/>
				)}
				{loading ? (
					<>
						{[0, 1, 2, 3].map((index) => (
							<div key={index} className={s.skeleton} data-index={index} aria-hidden="true">
								<span />
								<span>
									<i />
									<i />
									<i />
								</span>
							</div>
						))}
						<div className={s.status} role="status">
							<StatusIcon
								status="working"
								label={t(locale, 'Reading PRs from GitHub…')}
								size={16}
							/>
							<span>{t(locale, 'Reading PRs from GitHub…')}</span>
						</div>
					</>
				) : !snapshot && entry?.error ? (
					<Banner
						data="pr-error"
						icon={<Icon name="x2" size={18} className={s.errorIcon} />}
						title={t(locale, 'PRs could not be read.')}
						sub={entry.error}
						action={
							<Button
								size="l"
								className={screen.bannerAction}
								onClick={() => void loadPRList(projectId, true)}>
								{t(locale, 'Retry (link)')}
							</Button>
						}
					/>
				) : empty ? (
					<div className={s.empty} data-pr-empty>
						<span className={s.emptyIcon}>
							<Glyph name="pr-branch" size={26} />
						</span>
						<b>
							{repo
								? t(locale, 'No open PRs in {repo}').replace(
										'{repo}',
										repoName(
											repos.find((item) => item.scopeId === repo)!,
											projectName
										)
									)
								: t(locale, 'No open PRs')}
						</b>
						{closedCount > 0 && (
							<span data-size="l">
								<Button onClick={() => setView(projectId, { closed: true, chip: 'all' })}>
									{t(locale, 'Show closed')} · {closedCount}
								</Button>
							</span>
						)}
						<OlderLink
							locale={locale}
							open={() => openPulls(projectId, linkRepo(snapshot, repo), true)}
						/>
					</div>
				) : (
					<>
						{sections.map((section, index) => (
							<div
								key={section.group}
								role="group"
								aria-label={t(locale, groupLabels[section.group])}
								className={screen.frames6}>
								<div
									className={`${screen.groupHead} ${s.head}`}
									data-first={index === 0 || undefined}>
									{t(locale, groupLabels[section.group])} <span>{section.items.length}</span>
								</div>
								{section.items.map((item) => (
									<PRRow
										key={`${item.scopeId}#${item.pr.number}`}
										item={item}
										named={several && repo === null}
										query={view.query}
										locale={locale}
										open={() =>
											navigate({
												screen: 'pr',
												projectId,
												scopeId: item.scopeId,
												number: item.pr.number,
											})
										}
									/>
								))}
							</div>
						))}
						{sections.some((section) => section.group === 'closed') && (
							<OlderLink
								locale={locale}
								open={() => openPulls(projectId, linkRepo(snapshot, repo), true)}
							/>
						)}
						{snapshot && !sections.length && view.query.trim() && (
							<p className={screen.empty}>{t(locale, 'Nothing found')}</p>
						)}
					</>
				)}
			</div>
		</div>
	);
}
function OlderLink({ locale, open }: { locale: Locale; open(): void }) {
	return (
		<span className={s.older} data-size="l">
			<Button appearance="primary" variant="ghost" data-pr-older onClick={open}>
				{t(locale, 'Older closed PRs are on GitHub')}
				<Icon name="link" size={14} />
			</Button>
		</span>
	);
}
/** The whole row is the button (rule 15); the desktop PRRow's glyphs in the touch scale (rule 17). */
function PRRow({
	item,
	named,
	query,
	locale,
	open,
}: {
	item: PRItem;
	named: boolean;
	query: string;
	locale: Locale;
	open(): void;
}) {
	const { pr } = item,
		live = isOpenPR(pr),
		who = pr.mine ? t(locale, 'you') : pr.author;
	return (
		<button
			type="button"
			className={s.row}
			data-closed={!live || undefined}
			data-pr-row={pr.number}
			data-pr-scope={item.scopeId}
			onClick={open}>
			<PRStateGlyph pr={pr} size={18} />
			<span className={s.body}>
				<span className={s.title}>
					<span className={`ell ${s.name}`}>
						<Highlight text={pr.title} query={query} />
					</span>
					{live && (
						<span className={s.marks}>
							<PRMarkGlyph pr={pr} locale={locale} size={15} />
							{pr.checks !== 'none' && <CIGlyph state={checksGlyph(pr.checks)} size={16} />}
						</span>
					)}
				</span>
				<span className={s.who}>
					{named && (
						<>
							<span className={s.repoName}>
								<Highlight text={item.repo} query={query} />
							</span>
							<span>·</span>
						</>
					)}
					{live && <Avatar login={pr.author} size="m" />}
					<span className="ell">
						#{pr.number} · <Highlight text={who} query={query} /> ·{' '}
						{prAge(locale, live ? pr.updatedAt : (pr.closedAt ?? pr.updatedAt))}
					</span>
				</span>
				{live && (
					<span className={s.meta}>
						<span className={s.branch}>
							<Icon name="branch" size={12} />
							<span className="ell mono">
								<Highlight text={pr.head} query={query} />
							</span>
						</span>
						<span className={s.space} />
						{pr.comments > 0 && (
							<span className={s.comments} aria-label={`${t(locale, 'Comments')}: ${pr.comments}`}>
								<Glyph name="bubble" size={12} />
								{pr.comments}
							</span>
						)}
						{(pr.additions ?? 0) + (pr.deletions ?? 0) > 0 && (
							<Counts additions={pr.additions ?? 0} deletions={pr.deletions ?? 0} />
						)}
					</span>
				)}
			</span>
		</button>
	);
}
/** The repo picker: every repo of the list with its open PRs, in the computer's Repo order; one without PRs is dimmed. */
export function RepoSheet({
	projectId,
	projectName,
	snapshot,
	locale,
}: {
	projectId: string;
	projectName: string;
	snapshot: PullRequestsSnapshot | null;
	locale: Locale;
}) {
	const chosen = usePRView((state) => state.views[projectId]?.repo ?? null);
	const repos = snapshot ? githubRepos(snapshot) : [];
	const all = snapshot
		? prItems(snapshot, projectName, null).filter((item) => isOpenPR(item.pr)).length
		: 0;
	const pick = (scopeId: string | null) => {
		setView(projectId, { repo: scopeId });
		back();
	};
	const count = (n: number) => (
		<span className={s.repoCount}>
			<Glyph name="pr-branch" size={14} />
			{n}
		</span>
	);
	return (
		<Sheet label="Repo" title="Repo" locale={locale} close={back}>
			<Group>
				<SheetRow
					role="menuitemradio"
					checked={chosen === null}
					icon={<span className={s.tick}>{chosen === null && <Icon name="tick" size={18} />}</span>}
					title={t(locale, 'All repos')}
					tail={count(all)}
					data={{ 'repo-choice': 'all' }}
					onClick={() => pick(null)}
				/>
				{repos.map((repo) => {
					const open = repo.prs.filter(isOpenPR).length;
					return (
						<SheetRow
							key={repo.scopeId}
							role="menuitemradio"
							checked={chosen === repo.scopeId}
							disabled={!open}
							icon={
								<span className={s.tick}>
									{chosen === repo.scopeId && <Icon name="tick" size={18} />}
								</span>
							}
							title={<span className="mono">{repoName(repo, projectName)}</span>}
							tail={
								open ? count(open) : <span className={sheets.value}>{t(locale, 'No PRs')}</span>
							}
							data={{ 'repo-choice': repo.name }}
							onClick={() => pick(repo.scopeId)}
						/>
					);
				})}
			</Group>
		</Sheet>
	);
}
/**
 * Pull to refresh: at the top of the list a drag down shows «Release to refresh»; a release past 58 reads
 * past main's cache and shows «Refreshing from GitHub…» until it answers. Touch events, so the list's own scroll stays native.
 */
function usePull(refresh: () => Promise<void>) {
	const scroller = useRef<HTMLDivElement>(null),
		[height, setHeight] = useState(0),
		[busy, setBusy] = useState(false),
		latest = useRef(refresh);
	latest.current = refresh;
	useEffect(() => {
		const node = scroller.current;
		if (!node) return;
		let start: number | null = null,
			pulled = 0;
		const down = (event: TouchEvent) => {
			start = node.scrollTop <= 0 ? event.touches[0]!.clientY : null;
			pulled = 0;
		};
		const move = (event: TouchEvent) => {
			if (start === null) return;
			const dy = event.touches[0]!.clientY - start;
			if (dy <= 0 || node.scrollTop > 0) {
				pulled = 0;
				setHeight(0);
				return;
			}
			event.preventDefault();
			pulled = Math.min(90, dy * 0.5);
			setHeight(pulled);
		};
		const up = () => {
			if (start === null) return;
			start = null;
			if (pulled >= 58) {
				setBusy(true);
				setHeight(58);
				void latest.current().finally(() => {
					setBusy(false);
					setHeight(0);
				});
			} else setHeight(0);
			pulled = 0;
		};
		node.addEventListener('touchstart', down, { passive: true });
		node.addEventListener('touchmove', move, { passive: false });
		node.addEventListener('touchend', up);
		node.addEventListener('touchcancel', up);
		return () => {
			node.removeEventListener('touchstart', down);
			node.removeEventListener('touchmove', move);
			node.removeEventListener('touchend', up);
			node.removeEventListener('touchcancel', up);
		};
	}, []);
	return {
		scroller,
		height,
		state: busy ? ('refresh' as const) : height > 0 ? ('pull' as const) : ('idle' as const),
	};
}
