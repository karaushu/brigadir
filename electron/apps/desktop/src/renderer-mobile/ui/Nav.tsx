/**
 * spec/remote-access-and-mobile#phone-app: the phone's navigation bar, its «back», the icon buttons (`ui/IconButton` in L), the large
 * title. Android: the back arrow without its label, the title on the left, ⋮ for ….
 */
import type { ReactNode } from 'react';
import { t, type Locale } from '@brigadir/core';
import { IconButton } from '../../renderer/ui/Controls';
import { Icon, type IconName } from './Icon';
import s from './Nav.module.css';

export const android = /Android/.test(navigator.userAgent);
export function NavBar({
	left,
	title,
	sub,
	right,
	line = true,
}: {
	left?: ReactNode;
	title?: ReactNode;
	sub?: ReactNode;
	right?: ReactNode;
	line?: boolean;
}) {
	return (
		<header className={s.bar} data-line={line || undefined} data-size="l">
			{left}
			{title !== undefined && (
				<div className={s.title}>
					<b className="ell">{title}</b>
					{sub !== undefined && <small className="ell">{sub}</small>}
				</div>
			)}
			<span className={s.space} />
			{right}
		</header>
	);
}
export function BackButton({
	label,
	locale,
	onClick,
}: {
	label: string;
	locale: Locale;
	onClick(): void;
}) {
	return (
		<button
			type="button"
			className={s.back}
			aria-label={`${t(locale, 'Back')}: ${label}`}
			onClick={onClick}
			data-back>
			{android ? <Icon name="arrow" size={22} /> : <Icon name="back" size={20} />}
			{!android && <span className={`ell ${s.backLabel}`}>{label}</span>}
		</button>
	);
}
export function NavIcon({
	icon,
	label,
	onClick,
	quiet = false,
	dot,
	disabled,
}: {
	icon: IconName;
	label: string;
	onClick(): void;
	/** A secondary action in --fg2; otherwise the accent. */ quiet?: boolean;
	dot?: string | null;
	disabled?: boolean;
}) {
	return (
		<IconButton
			label={label}
			appearance={quiet ? 'neutral' : 'primary'}
			className={s.icon}
			data-quiet={quiet || undefined}
			disabled={disabled}
			{...(dot === undefined ? {} : { dot })}
			onClick={onClick}>
			<Icon name={android && icon === 'more' ? 'vmore' : icon} size={22} />
		</IconButton>
	);
}
export function LargeTitle({ children }: { children: ReactNode }) {
	return <h1 className={s.large}>{children}</h1>;
}
