import s from './BranchName.module.css';

/** How many characters of the end stay when the name is squeezed: `fix/justeat-int…-support-toggle`. */
const TAIL = 15;

/**
 * spec/appearance#evolution-redesign, spec/composer#agent-capsule: a branch in full, prefix included (`fix/`, `features/`), in the row's own font. When it does
 * not fit, the middle gives way first, so the prefix and the tail stay readable; the prefix (up to its first `/`) is never
 * cut; only as the last resort the tail gives way too, from its start (`brigadir/…support`), so its end stays. The full name is the tooltip and the text (copy, accessible name and
 * tests read it whole). A row that lets its own parts give way between the middle and the tail (the sidebar card's PR)
 * sets `display: contents` on the root: the three parts then take their turns in that row.
 */
export function BranchName({
	name,
	title = name,
	className = '',
}: {
	name: string;
	/** The tooltip when it says more than the name: the sidebar card's «Worktree · fix/…». */ title?: string;
	className?: string | undefined;
}) {
	const slash = name.indexOf('/'),
		prefix = slash > 0 && slash < name.length - 1 ? name.slice(0, slash + 1) : '',
		rest = name.slice(prefix.length),
		cut = Math.min(TAIL, Math.floor(rest.length / 2)),
		middle = rest.slice(0, rest.length - cut),
		tail = rest.slice(rest.length - cut);
	return (
		<span className={`${s.name} ${className}`} title={title} data-branch-name>
			{prefix && (
				<span className={s.prefix} data-branch-prefix>
					{prefix}
				</span>
			)}
			{middle && (
				<span className={s.middle} data-branch-middle>
					{middle}
				</span>
			)}
			<span className={s.tail} data-branch-tail>
				<bdi className={s.tailText}>{tail}</bdi>
			</span>
		</span>
	);
}
