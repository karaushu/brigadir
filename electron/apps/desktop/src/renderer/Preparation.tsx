import { useEffect, useState } from 'react';
import { t, type AgentTask, type Locale } from '@brigadir/core';
import { Button, Chevron } from './ui/Controls';
import { resolveToast, toastError, toastWarning } from './ui/Toast';
import styles from './Preparation.module.css';
/** A task cannot open files or start an agent until its managed workspace is ready. */
export function Preparation({ task, locale }: { task: AgentTask; locale: Locale }) {
	const [busy, setBusy] = useState(false),
		[logFailed, setLogFailed] = useState(false),
		[log, setLog] = useState(''),
		[showLog, setShowLog] = useState(false);
	const preparing = task.status === 'preparing',
		failed = task.preparation?.state === 'failed';
	useEffect(() => {
		let active = true;
		const read = () => {
			void window.brigadir.readPreparationLog(task).then(
				(value) => {
					if (active) {
						setLog(value);
						setLogFailed(false);
					}
				},
				() => {
					if (active) setLogFailed(true);
				}
			);
		};
		read();
		const timer = preparing ? setInterval(read, 1000) : undefined;
		return () => {
			active = false;
			clearInterval(timer);
		};
	}, [task.id, task.projectId, preparing, locale]);
	// spec/notifications-slack-notes-and-schedules#message-classes: the log is read every second while preparing; one toast per failure streak.
	useEffect(() => {
		if (logFailed) toastWarning(t(locale, 'Could not read the setup log.'));
		else resolveToast(t(locale, 'Could not read the setup log.'));
	}, [logFailed]);
	async function act() {
		setBusy(true);
		try {
			if (preparing) await window.brigadir.sendCommand(task, { kind: 'cancel' });
			else await window.brigadir.startSession(task);
		} catch {
			if (preparing) toastError(t(locale, 'Could not cancel the preparation.'));
			else
				toastError(t(locale, 'Could not start the task.'), {
					action: {
						label: t(locale, 'Retry'),
						run: () => {
							void act();
						},
					},
				});
		} finally {
			setBusy(false);
		}
	}
	const step = task.preparation?.step;
	return (
		<section className={styles.preparation} aria-label={t(locale, 'Preparing workspace')}>
			<h2>
				{t(
					locale,
					preparing
						? 'Preparing workspace'
						: failed
							? 'Preparation failed'
							: task.launch?.isolation === 'worktree'
								? 'Worktree'
								: 'Preparing workspace'
				)}
			</h2>
			<p role="status">
				{preparing
					? step === 'setup'
						? t(locale, 'Running setup…')
						: step === 'env'
							? t(locale, 'Copying .env…')
							: step === 'branch'
								? t(locale, 'Naming the branch…')
								: step?.startsWith('switch')
									? `${t(locale, 'Switching the branch')}${step.includes(':') ? ` · ${step.slice(step.indexOf(':') + 1)}` : ''}`
									: step?.startsWith('pull:')
										? `${t(locale, 'Pulling from origin')} · ${step.slice(5)}`
										: step && step !== '.' && step !== 'repositories'
											? step
											: t(locale, 'Creating working copies…')
					: task.status === 'queued'
						? t(locale, 'Waiting for a free agent slot.')
						: task.preparation?.error}
			</p>
			<div>
				<Button
					disabled={busy}
					onClick={() => {
						void act();
					}}>
					{t(locale, preparing ? 'Cancel preparation' : failed ? 'Retry' : 'Start')}
				</Button>
				<Button
					disclosure
					aria-expanded={showLog}
					aria-controls="preparation-log"
					onClick={() => setShowLog((value) => !value)}>
					<Chevron right={!showLog} />
					{t(locale, 'Setup log')}
				</Button>
			</div>
			<div id="preparation-log" className={styles.log} data-open={showLog} inert={!showLog}>
				<div>
					<pre tabIndex={0} aria-label={t(locale, 'Setup log')}>
						{/* The host opens every run with a blank line before its `--- time ---` mark; the block starts at the mark. */}
						{log.replace(/^\s*\n/, '') || t(locale, 'No setup output yet.')}
					</pre>
				</div>
			</div>
		</section>
	);
}
