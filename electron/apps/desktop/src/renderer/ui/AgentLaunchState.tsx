import { t, type AgentTask, type Locale } from '@brigadir/core';
import { Button } from './Controls';
import { Glyph } from './Glyph';
import styles from './AgentLaunchState.module.css';
export function AgentLaunchState({
	task,
	locale,
	loading,
	starting,
	resumable,
	error,
	onStart,
	onRetry,
	onRelay,
}: {
	task: AgentTask;
	locale: Locale;
	loading: boolean;
	starting: boolean;
	resumable: boolean;
	error: string;
	onStart(): void;
	onRetry(): void;
	onRelay?: () => void;
}) {
	const provider =
		task.provider === 'claude'
			? 'Claude Code'
			: task.provider === 'codex'
				? 'Codex'
				: t(locale, 'Agent');
	const busy = (loading && !error) || starting;
	const heading = starting
		? t(locale, 'Starting {agent}…').replace('{agent}', provider)
		: loading && !error
			? t(locale, 'Opening terminal…')
			: provider;
	return (
		<div className={styles.stage} data-agent-launch data-busy={busy}>
			<div className={styles.content}>
				<div className={styles.emblem}>
					<Glyph
						name={
							task.provider === 'claude'
								? 'claude'
								: task.provider === 'codex'
									? 'openai'
									: 'console'
						}
						size={32}
					/>
				</div>
				<div className={styles.copy} role="status" aria-live="polite">
					<h2>{heading}</h2>
					<p>
						{starting
							? t(locale, 'The agent is starting in this task’s terminal.')
							: loading
								? t(
										locale,
										error ? 'The terminal could not be opened.' : 'Checking the saved session.'
									)
								: t(
										locale,
										resumable
											? 'Continue the saved agent session in the terminal.'
											: 'Start the agent to work on this task in the terminal.'
									)}
					</p>
				</div>
				{busy ? (
					<div className={styles.wait} aria-hidden="true">
						<span />
						<span />
						<span />
					</div>
				) : (
					<Button size="l" appearance="primary" onClick={loading ? onRetry : onStart}>
						{loading
							? t(locale, 'Retry')
							: `${t(locale, resumable ? 'Resume' : 'Start')} ${provider}`}
					</Button>
				)}
				{!busy && resumable && onRelay && (
					<Button onClick={onRelay}>{t(locale, 'Continue in a new task')}</Button>
				)}
				{error && (
					<div className={styles.error} role="alert">
						<p>{error}</p>
					</div>
				)}
			</div>
		</div>
	);
}
