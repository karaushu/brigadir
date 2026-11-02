import { useEffect, useRef, useState } from 'react';
import { t, type LaunchConflict, type LaunchConflictChoice, type Locale } from '@brigadir/core';
import { Button } from './ui/Controls';
import { Glyph } from './ui/Glyph';
import { PopupClose } from './ui/PopupClose';
import styles from './LockConflict.module.css';
export function LockConflict({ conflict, locale }: { conflict: LaunchConflict; locale: Locale }) {
	const dialog = useRef<HTMLDialogElement>(null),
		[busy, setBusy] = useState(false),
		[error, setError] = useState(false);
	useEffect(() => {
		const element = dialog.current!,
			previous = document.activeElement;
		element.showModal();
		element.querySelector<HTMLButtonElement>('footer button')?.focus({ preventScroll: true });
		return () => {
			element.close();
			if (previous instanceof HTMLElement && previous.isConnected && !previous.matches(':disabled'))
				previous.focus({ preventScroll: true });
		};
	}, []);
	async function choose(choice: LaunchConflictChoice) {
		if (busy) return;
		setBusy(true);
		setError(false);
		try {
			await window.brigadir.resolveLaunchConflict(conflict.id, choice);
		} catch {
			setError(true);
			setBusy(false);
		}
	}
	const options = [
		{
			choice: 'worktree',
			icon: 'lock-branch',
			title: 'Isolate in a worktree',
			description:
				'The task works in its own copy of every repo and takes no locks. Preparation takes longer, because each repository gets a branch and the setup command runs.',
		},
		{
			choice: 'queue',
			icon: 'scope-lock',
			title: 'Wait in queue',
			description:
				'The task waits and starts by itself when the lock is free. If the task that holds the lock dies, the queue notices within 3 seconds.',
		},
		{
			choice: 'override',
			icon: 'review-warning',
			title: 'Work despite the lock',
			description:
				'Both tasks write to one repo. The diff of this task will show the changes of the other one, and the other way round. While this lasts, the repo is marked contended and both diffs carry a warning.',
		},
	] as const;
	return (
		<dialog
			ref={dialog}
			className={styles.dialog}
			data-size="m"
			aria-labelledby="lock-conflict-title"
			onCancel={(event) => {
				event.preventDefault();
				void choose('cancel');
			}}>
			<div className={styles.body}>
				<header>
					<Glyph name="review-warning" size={16} />
					<h2 id="lock-conflict-title">{t(locale, 'Repo is busy')}</h2>
					<PopupClose
						locale={locale}
						close={() => {
							void choose('cancel');
						}}
					/>
				</header>
				<div className={styles.owners}>
					{conflict.scopes.map((scope) => (
						<div key={scope.path}>
							{scope.owners.map((owner) => (
								<p key={`${owner.key.projectId}/${owner.key.id}`}>
									<code>{scope.name}</code> {t(locale, 'is busy with the task')}{' '}
									<strong>{owner.title}</strong>.{' '}
									{t(locale, 'It took the lock {minutes} min ago.').replace(
										'{minutes}',
										new Intl.NumberFormat(locale).format(
											Math.max(0, Math.floor((Date.now() - Date.parse(owner.acquiredAt)) / 60000))
										)
									)}
								</p>
							))}
						</div>
					))}
				</div>
				<div className={styles.options}>
					{options.map((option) => (
						<button
							key={option.choice}
							disabled={busy || (option.choice === 'worktree' && !conflict.canIsolate)}
							onClick={() => {
								void choose(option.choice);
							}}>
							<Glyph name={option.icon} size={16} />
							<span>
								<strong>{t(locale, option.title)}</strong>
								<span>{t(locale, option.description)}</span>
								{option.choice === 'worktree' && !conflict.canIsolate && (
									<span>
										{t(
											locale,
											'This task has already used its workspace. Create a new task to use a worktree.'
										)}
									</span>
								)}
							</span>
						</button>
					))}
				</div>
				{error && (
					<p className={styles.error} role="alert">
						{t(locale, 'The request failed.')}
					</p>
				)}
			</div>
			<footer>
				<Button
					disabled={busy}
					onClick={() => {
						void choose('cancel');
					}}>
					{t(locale, 'Cancel')}
				</Button>
			</footer>
		</dialog>
	);
}
