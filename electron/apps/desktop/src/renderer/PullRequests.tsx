import { createContext, useContext, useEffect, useRef, useState, type ReactNode } from 'react';
import { prCounts, prCountTitle, t, type Locale, type PullRequestsSnapshot } from '@brigadir/core';
import { onSessionEvent } from './session-events';
import { useWorkspace } from './store';
import { Glyph } from './ui/Glyph';
import { Button } from './ui/Controls';
import styles from './PullRequests.module.css';

type Context = {
	data: PullRequestsSnapshot | null;
	error: string;
	loading: boolean;
	refresh(fresh?: boolean): Promise<void>;
};
const PullRequestsContext = createContext<Context | null>(null);
export const usePullRequests = () => useContext(PullRequestsContext);
/**
 * spec/pull-requests-and-ci#reading-and-refresh: the PR list of the task's or the main tree's repo. It reads when a task or repo is chosen, on window
 * focus and after own actions; no polling. An error keeps the last data and never turns into «no PRs».
 */
export function PullRequestsProvider({
	projectId,
	taskId,
	children,
}: {
	projectId: string | undefined;
	taskId: string | undefined;
	children: ReactNode;
}) {
	// spec/settings-modules-and-onboarding#module-off: with the module off nothing reads GitHub — no list, no refresh on focus — and every counter is gone.
	const enabled = useWorkspace((state) => state.appearance.modules.pullRequests);
	const [data, setData] = useState<PullRequestsSnapshot | null>(null),
		[error, setError] = useState(''),
		[loading, setLoading] = useState(false),
		revision = useRef(0);
	async function refresh(fresh = false) {
		if (!projectId || !enabled) return;
		const id = ++revision.current;
		setLoading(true);
		try {
			const value = await window.brigadir.readPullRequests(projectId, taskId ?? null, fresh);
			if (id === revision.current) {
				setData(value);
				setError('');
			}
		} catch (failure) {
			if (id === revision.current)
				setError(failure instanceof Error ? failure.message : String(failure));
		} finally {
			if (id === revision.current) setLoading(false);
		}
	}
	const latest = useRef(refresh);
	latest.current = refresh;
	useEffect(() => {
		setData(null);
		setError('');
		if (!projectId || !enabled) return;
		void latest.current(false);
		const focus = () => {
			void latest.current(true);
		};
		window.addEventListener('focus', focus);
		const stop = onSessionEvent(({ key, record }) => {
			if (
				taskId &&
				key.id === taskId &&
				key.projectId === projectId &&
				record?.event.kind === 'pull-request.changed'
			)
				void latest.current(true);
		});
		return () => {
			revision.current++;
			window.removeEventListener('focus', focus);
			stop();
		};
	}, [projectId, taskId, enabled]);
	return (
		<PullRequestsContext.Provider
			value={{ data, error, loading, refresh: (fresh) => latest.current(fresh) }}>
			{children}
		</PullRequestsContext.Provider>
	);
}
/**
 * spec/pull-requests-and-ci#repo-counter: the counter in a repo row — the PR mark with the open ones, the merge mark with those closed in 7 days, an amber
 * «waits for you» dot. No text, the words are in the tooltip. Zero and zero, or a repo without GitHub, shows no counter; a read error shows «?».
 */
export function RepoPRCounter({
	scopeId,
	locale,
	onOpen,
	active = false,
}: {
	scopeId: string;
	locale: Locale;
	onOpen(): void;
	active?: boolean;
}) {
	const context = usePullRequests(),
		repo = context?.data?.repos.find((item) => item.scopeId === scopeId);
	if (!context?.data || !repo) return null;
	const unavailable =
		(context.data.auth !== 'ready' && context.data.auth !== 'missing') || Boolean(repo.error);
	if (unavailable) {
		const title = t(
			locale,
			context.data.auth === 'login'
				? 'Sign in with gh auth login to use GitHub.'
				: 'GitHub status could not be read.'
		);
		return (
			<Button
				size="s"
				className={styles.counter}
				data-repo-prs="unknown"
				title={title}
				aria-label={title}
				onClick={onOpen}>
				<Glyph name="pr-branch" size={12} />
				<span className={styles.number}>?</span>
			</Button>
		);
	}
	if (!repo.repository) return null;
	const counts = prCounts(repo.prs);
	if (!counts.open && !counts.closed) return null;
	const title = prCountTitle(locale, counts.open, counts.closed, counts.waiting);
	return (
		<Button
			size="s"
			className={styles.counter}
			data-repo-prs={scopeId}
			title={title}
			aria-label={title}
			aria-pressed={active}
			onClick={onOpen}>
			{counts.open > 0 && (
				<>
					<Glyph name="pr-branch" size={12} />
					<span className={styles.number}>{counts.open}</span>
					{counts.waiting && <span className={styles.waiting} />}
				</>
			)}
			{counts.closed > 0 && (
				<span className={styles.closed}>
					<Glyph name="pr-merged" size={12} />
					<span className={styles.number}>{counts.closed}</span>
				</span>
			)}
		</Button>
	);
}
