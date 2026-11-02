import type { ButtonHTMLAttributes, ReactNode, Ref } from 'react';
import s from './ActionRow.module.css';
/**
 * spec/task-window-workspace#empty-work-area: an action row outside a menu — glyph, name and its shortcut on the right, the whole
 * row lights with `--tint` (rule 15). The main tree's empty work area offers its actions with it. Its height is the row's
 * (`data-size` on the list, rule 16), M by default.
 */
export function ActionRow({
	icon,
	kbd,
	children,
	className = '',
	ref,
	...props
}: Omit<ButtonHTMLAttributes<HTMLButtonElement>, 'children'> & {
	ref?: Ref<HTMLButtonElement>;
	icon: ReactNode;
	kbd?: string | undefined;
	children: ReactNode;
}) {
	return (
		<button ref={ref} type="button" {...props} className={`${s.row} ${className}`}>
			<span className={s.icon}>{icon}</span>
			<span className={s.label}>{children}</span>
			{kbd && <kbd className={s.kbd}>{kbd}</kbd>}
		</button>
	);
}
