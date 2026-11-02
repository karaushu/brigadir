/**
 * The phone's chip — the terminal's command tabs (spec/remote-access-and-mobile#phone-task-tools) and the PR list's filter All · Waiting
 * for you · Yours (spec/remote-access-and-mobile#phone-pr-list). One look, one component (rule 17); the row scrolls sideways when the chips do not fit.
 */
import type { ReactNode } from 'react';
import s from './Chip.module.css';

export function ChipRow({
	label,
	role,
	line = false,
	children,
}: {
	label: string;
	role: 'tablist' | 'radiogroup';
	/** The terminal's tabs end the header with a hairline. */ line?: boolean;
	children: ReactNode;
}) {
	return (
		<div className={s.row} role={role} aria-label={label} data-line={line || undefined}>
			{children}
		</div>
	);
}
export function Chip({
	selected,
	role,
	onClick,
	children,
	data,
}: {
	selected: boolean;
	role: 'tab' | 'radio';
	onClick(): void;
	children: ReactNode;
	data?: Record<string, string>;
}) {
	const attributes = Object.fromEntries(
		Object.entries(data ?? {}).map(([key, value]) => [`data-${key}`, value])
	);
	return (
		<button
			type="button"
			role={role}
			className={s.chip}
			{...(role === 'tab' ? { 'aria-selected': selected } : { 'aria-checked': selected })}
			onClick={onClick}
			{...attributes}>
			<span>{children}</span>
		</button>
	);
}
