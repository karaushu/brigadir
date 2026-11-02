import type { ReactNode } from 'react';
import s from './StateStrip.module.css';

/**
 * spec/composer#agent-capsule: the agent's state between the log and the composer island — a --tint strip under a --hair line,
 * its glyph, what is going on, and S actions on the right (not running, the host gone, starting, waiting, the archive). One
 * look for every such strip (rule 17).
 */
export function StateStrip({
	icon,
	text,
	children,
	live = true,
	...data
}: {
	icon: ReactNode;
	text: ReactNode;
	children?: ReactNode;
	/** A status the screen reader announces (`role=status`). */ live?: boolean;
} & { [key: `data-${string}`]: string | boolean | undefined }) {
	return (
		<div {...data} className={s.strip} role={live ? 'status' : undefined} data-size="s">
			<span className={s.icon}>{icon}</span>
			<span className={s.text}>{text}</span>
			{children && <span className={s.actions}>{children}</span>}
		</div>
	);
}
