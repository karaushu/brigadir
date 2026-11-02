import { t, type DiffBase, type Locale } from '@brigadir/core';
import { Glyph } from './Glyph';
import { Button, IconButton } from './Controls';
import styles from './DiffBaseChip.module.css';
type Range = { base: number; current: number } | null;
const titles = { task: 'Task start', head: 'Last commit' } as const;
const details = {
	task: 'What changed since the task started.',
	head: 'What is not committed yet, as in git status.',
} as const;
/** spec/diff-and-review#changes-header: the changes panel says what it counts from. A click opens Settings ▸ Editor; the base is chosen only there (spec/diff-and-review#diff-base). */
export function DiffBaseChip({
	locale,
	base,
	range,
	onSettings,
	onAllChanges,
}: {
	locale: Locale;
	base: DiffBase;
	range: Range;
	onSettings(): void;
	onAllChanges(): void;
}) {
	if (range) {
		const label = t(locale, 'Snapshots #{base}–#{current}')
			.replace('{base}', String(range.base))
			.replace('{current}', String(range.current));
		return (
			<span className={styles.chip} data-diff-base-chip="range" title={label}>
				<Glyph name="history" size={12} />
				<span className={styles.label}>{label}</span>
				<IconButton
					size="s"
					className={styles.reset}
					label={t(locale, 'Show all changes')}
					onClick={onAllChanges}>
					<Glyph name="close" size={8} />
				</IconButton>
			</span>
		);
	}
	const value = t(locale, titles[base]),
		label = t(locale, '{label}: {value}')
			.replace('{label}', t(locale, 'Diff base'))
			.replace('{value}', value);
	return (
		<Button
			className={styles.chip}
			data-diff-base-chip={base}
			aria-label={label}
			title={`${label}. ${t(locale, details[base])}\n${t(locale, 'Change in Settings ▸ Editor')}`}
			onClick={onSettings}>
			<Glyph name={base === 'task' ? 'base-task' : 'base-head'} size={12} />
			<span className={styles.label}>{value}</span>
		</Button>
	);
}
