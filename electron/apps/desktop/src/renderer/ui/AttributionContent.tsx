import {
	formatDateTime,
	t,
	type Attribution,
	type AttributionRange,
	type Locale,
} from '@brigadir/core';
import { Button } from './Controls';
import styles from './AttributionContent.module.css';
export function AttributionContent({
	data,
	range,
	path,
	locale,
	close,
	goToTurn,
}: {
	data: Attribution;
	range: AttributionRange | null;
	path: string;
	locale: Locale;
	close(): void;
	goToTurn(turn: number): void;
}) {
	const [first, ...others] = data.entries;
	const badge = (entry: Attribution['entries'][number]) =>
		entry.quick
			? t(locale, 'Quick question')
			: entry.turn
				? entry.turnNumber
					? `${t(locale, 'Turn')} ${entry.turnNumber}`
					: t(locale, 'During agent turn')
				: t(locale, entry.author === 'user' ? 'Your edit' : 'Unattributed change');
	const body = (entry: Attribution['entries'][number]) => (
		<>
			<div className={styles.body}>
				{entry.excerpt && <p>{entry.excerpt}</p>}
				{entry.prompt && <blockquote>{entry.prompt}</blockquote>}
				{!entry.excerpt && !entry.prompt && (
					<p>
						{t(
							locale,
							entry.author === 'user'
								? entry.precision === 'lines'
									? 'These lines were edited by you. There is no agent turn.'
									: 'This file was edited by you. There is no agent turn.'
								: 'Unattributed change'
						)}
					</p>
				)}
			</div>
			<footer className={styles.footer}>
				<span>
					{t(locale, entry.precision === 'lines' ? 'These lines' : 'This file')} ·{' '}
					{t(
						locale,
						entry.quick
							? 'Quick question'
							: entry.author === 'agent'
								? 'During agent turn'
								: entry.author === 'user'
									? 'Your edit'
									: 'Unattributed change'
					)}
				</span>
				{entry.turn && (
					<Button appearance="primary" onClick={() => goToTurn(entry.turn!)}>
						{t(locale, 'Go to turn')}
					</Button>
				)}
			</footer>
		</>
	);
	return (
		<>
			<header className={styles.header}>
				<span className={styles.badge} data-agent={Boolean(first?.turn)}>
					{first ? badge(first) : t(locale, 'Unattributed change')}
				</span>
				{first && (
					<time title={formatDateTime(first.at, { seconds: true })}>
						{formatDateTime(first.at)}
					</time>
				)}
				<span className={styles.location} title={path}>
					{path.split('/').at(-1)}
					{range ? ` · ${range.start}–${range.end}` : ''}
				</span>
				<button className={styles.close} aria-label={t(locale, 'Close')} onClick={close}>
					Esc
				</button>
			</header>
			{first && body(first)}
			{others.length > 0 && (
				<div className={styles.history}>
					{others.map((entry) => (
						<details key={entry.checkpoint}>
							<summary>
								<span className={styles.badge} data-agent={Boolean(entry.turn)}>
									{badge(entry)}
								</span>
								<time>{formatDateTime(entry.at)}</time>
							</summary>
							{body(entry)}
						</details>
					))}
				</div>
			)}
			{data.truncated && (
				<p className={styles.hint}>{t(locale, 'Some history could not be checked.')}</p>
			)}
		</>
	);
}
