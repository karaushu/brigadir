import type { ReactNode } from 'react';
import { ActionRow } from './ui/ActionRow';
import { Glyph } from './ui/Glyph';
import styles from './EmptyPlace.module.css';
export type EmptyPlaceAction = {
	id: string;
	icon: ReactNode;
	label: string;
	kbd?: string | undefined;
	run(row: HTMLElement): void;
};
/**
 * spec/task-window-workspace#empty-work-area: one empty state for a place with nothing to show — the brigadier's helmet over a
 * column of action rows, each the command of its menu item. The main tree's work area without a tab (New file…, Open
 * Quickly, New browser) and a task with the chat and the work area off (Show the chat, New file…, Open Quickly).
 */
export function EmptyPlace({
	variant,
	actions,
}: {
	variant: 'main-tree' | 'task';
	actions: EmptyPlaceAction[];
}) {
	return (
		<div className={styles.empty} data-empty-place={variant}>
			<span className={styles.helmet}>
				<Glyph name="helmet" size={44} />
			</span>
			<div className={styles.actions} data-size="m">
				{actions.map((action) => (
					<ActionRow
						key={action.id}
						icon={action.icon}
						kbd={action.kbd}
						data-empty-action={action.id}
						onClick={(event) => action.run(event.currentTarget)}>
						{action.label}
					</ActionRow>
				))}
			</div>
		</div>
	);
}
