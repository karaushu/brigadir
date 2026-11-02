import type { HTMLAttributes, ReactNode, Ref } from 'react';
import { Glyph } from './Glyph';
import s from './RepoRoot.module.css';

/**
 * spec/appearance#evolution-redesign: a repo as a root of the panel's list (Files, Changes). The first line is
 * the disc that folds the root, the name and the changes, `…` on hover; the second is the branch and its marks. The
 * whole row is the target (rule 15): the disc's button stretches over it, the controls sit above it.
 */
export function RepoRoot({
	name,
	expanded,
	toggleLabel,
	onToggle,
	kind,
	counts,
	branch,
	marks,
	actions,
	outside = false,
	unavailable = false,
	ref,
	...props
}: Omit<HTMLAttributes<HTMLDivElement>, 'children'> & {
	name: string;
	expanded: boolean;
	toggleLabel: string;
	onToggle(): void;
	/** A small chip after the name: `Submodule`. */ kind?: ReactNode;
	counts?: ReactNode;
	/** The second line's start: the branch, or «outside the task». */ branch: ReactNode;
	/** The second line's end: ↑N / ↓N, the lock, the PR. */ marks?: ReactNode;
	/** `…` (shown on hover, focus or while open) or the `+` of a repo outside the task. */ actions?: ReactNode;
	outside?: boolean;
	unavailable?: boolean;
	ref?: Ref<HTMLDivElement>;
}) {
	return (
		<div
			{...props}
			ref={ref}
			className={`${s.root} ${props.className ?? ''}`}
			data-repo-root={name}
			data-expanded={expanded}
			data-outside={outside || undefined}
			data-unavailable={unavailable || undefined}>
			<div className={s.first}>
				<button
					type="button"
					tabIndex={-1}
					className={s.toggle}
					aria-expanded={expanded}
					aria-label={toggleLabel}
					onClick={(event) => {
						event.stopPropagation();
						onToggle();
					}}>
					<span className={s.disc} aria-hidden="true">
						<Glyph name="sidebar-chevron" size={10} />
					</span>
					<span className={s.name}>{name}</span>
				</button>
				{kind && <span className={s.kind}>{kind}</span>}
				<span className={s.space} />
				{counts && <span className={s.counts}>{counts}</span>}
				{actions && <span className={s.actions}>{actions}</span>}
			</div>
			<div className={s.second}>
				{branch}
				<span className={s.space} />
				{marks}
			</div>
		</div>
	);
}
