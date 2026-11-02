import styles from './ChangeSign.module.css';
/** spec/diff-and-review#change-counters: the sign of a `+N −M` counter is drawn, so `+` and `−` share one height in any fallback font. The text sign stays for copy and accessible names. */
export function ChangeSign({ sign }: { sign: '+' | '−' }) {
	return (
		<>
			<span className={styles.text}>{sign}</span>
			<svg aria-hidden="true" className={styles.sign} viewBox="0 0 6.6 7.9">
				<path d={sign === '+' ? 'M.6 3.95h5.4M3.3 1.25v5.4' : 'M.6 3.95h5.4'} />
			</svg>
		</>
	);
}
