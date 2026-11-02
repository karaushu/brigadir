import { useEffect, useRef, useState } from 'react';
import {
	conflictCount,
	conflictProgress,
	t,
	type AgentTask,
	type Locale,
	type MergeState,
} from '@brigadir/core';
import { mergeEnded, openConflictsDialog } from './task-state';
import { Banner } from './ui/Banner';
import { BranchName } from './ui/BranchName';
import { Button } from './ui/Controls';
import styles from './ConflictsBanner.module.css';

/**
 * spec/appearance#evolution-redesign: the entry over the Changes list — a merge or rebase that stopped with conflicts (`Merge stopped · N
 * conflicts` → `Resolve…`), or one whose conflicts are all resolved (`Conflicts resolved` → `Continue…`). The state is read
 * from git, so a merge started in the terminal shows here too. Replaces the History merge strip as the way in.
 */
export function ConflictsBanner({
	task,
	locale,
	agentBusy,
	refreshKey,
}: {
	task: AgentTask;
	locale: Locale;
	agentBusy: boolean;
	refreshKey: string;
}) {
	const [states, setStates] = useState<MergeState[]>([]),
		[ended, setEnded] = useState(0);
	const request = useRef(0);
	useEffect(() => {
		const again = () => setEnded((value) => value + 1);
		window.addEventListener(mergeEnded, again);
		return () => window.removeEventListener(mergeEnded, again);
	}, []);
	useEffect(() => {
		const id = ++request.current;
		void window.brigadir.readMergeStates(task).then(
			(value) => {
				if (id === request.current) setStates(value);
			},
			() => {}
		);
	}, [task.id, task.projectId, refreshKey, agentBusy, ended]);
	if (!states.length) return null;
	return (
		<div className={styles.banners}>
			{states.map((state) => {
				const progress = conflictProgress(state),
					rebase = state.kind === 'rebase',
					open = progress.total - progress.resolved;
				return progress.canContinue ? (
					<Banner
						key={state.scopeId}
						tone="success"
						data-conflicts-banner="resolved"
						title={<b>{t(locale, 'Conflicts resolved')}</b>}
						note={rebase ? undefined : t(locale, 'Continue commits the merge')}
						action={
							<Button onClick={() => openConflictsDialog(task, state.scopeId)}>
								{t(locale, 'Continue…')}
							</Button>
						}
					/>
				) : (
					<Banner
						key={state.scopeId}
						tone="warning"
						data-conflicts-banner="stopped"
						title={
							<span>
								<b>{t(locale, rebase ? 'Rebase stopped' : 'Merge stopped')}</b> ·{' '}
								{conflictCount(locale, open)}
							</span>
						}
						note={
							<span className={styles.where}>
								{rebase ? (
									<>
										{t(locale, 'onto {base}').replace('{base}', state.from)}
										{state.step &&
											` · ${t(locale, 'commit {n} of {m}')
												.replace('{n}', String(state.step.current))
												.replace('{m}', String(state.step.total))}`}
									</>
								) : (
									<>
										<span>{state.from} →</span>
										<BranchName name={state.into} />
									</>
								)}
							</span>
						}
						action={
							<Button onClick={() => openConflictsDialog(task, state.scopeId)}>
								{t(locale, 'Resolve…')}
							</Button>
						}
					/>
				);
			})}
		</div>
	);
}
