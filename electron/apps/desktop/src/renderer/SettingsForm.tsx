import type { ReactNode } from 'react';
import styles from './LayoutSettings.module.css';
/** spec/appearance#interface-font: every Settings page is built from the same parts — a titled card of rows, labels in one right-aligned column, notes under the card. */
export function SettingsSection({
	title,
	label,
	role,
	disabled,
	footnote,
	warning = false,
	children,
}: {
	title?: string;
	label?: string;
	role?: 'radiogroup';
	disabled?: boolean;
	footnote?: ReactNode;
	warning?: boolean;
	children: ReactNode;
}) {
	return (
		<section className={styles.section}>
			{title && <h2 className={styles.sectionTitle}>{title}</h2>}
			<fieldset
				className={styles.group}
				role={role}
				aria-label={label ?? title}
				disabled={disabled}>
				{children}
			</fieldset>
			{footnote && (
				<div className={styles.footnote} data-warning={warning}>
					{footnote}
				</div>
			)}
		</section>
	);
}
/** spec/composer-steering-queue-and-ghost#ghost-headless: `inactive` dims the control while another switch keeps it off; `warning` turns the line under it amber (spec/appearance#interface-font). */
export function SettingsRow({
	label,
	hint,
	wide = false,
	inactive = false,
	warning = false,
	children,
}: {
	label: string;
	hint?: ReactNode;
	wide?: boolean;
	inactive?: boolean;
	warning?: boolean;
	children: ReactNode;
}) {
	return (
		<div className={styles.row} data-size="m" data-settings-row={label}>
			<span className={styles.label}>{label}</span>
			<div className={styles.control} data-wide={wide} data-inactive={inactive || undefined}>
				{children}
				{hint && <small data-warning={warning || undefined}>{hint}</small>}
			</div>
		</div>
	);
}
export function SettingsOption({
	title,
	detail,
	icon,
	children,
}: {
	title: string;
	detail: string;
	icon?: ReactNode;
	children: ReactNode;
}) {
	return (
		<label className={styles.option}>
			{children}
			{icon}
			<span>
				<strong>{title}</strong>
				<small>{detail}</small>
			</span>
		</label>
	);
}
