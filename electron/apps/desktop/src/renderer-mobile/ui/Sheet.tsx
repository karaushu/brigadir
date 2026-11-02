/**
 * spec/remote-access-and-mobile#phone, spec/remote-access-and-mobile#phone-app: the phone's sheet — a scrim, the grab handle, a header with the title and ×
 * (`ui/PopupClose` touch), then rows. It closes with ×, the system «back», Esc, a tap on the scrim and a swipe down by the
 * handle or the header: more than a quarter of the sheet's height, or a quick flick.
 */
import { useEffect, useRef, type ReactNode, type PointerEvent as ReactPointerEvent } from 'react';
import type { Locale } from '@brigadir/core';
import { PopupClose } from '../../renderer/ui/PopupClose';
import s from './Sheet.module.css';

export function Sheet({
	label,
	title,
	sub,
	icon,
	locale,
	close,
	children,
	tall = false,
	top,
}: {
	label: string;
	title?: ReactNode;
	sub?: ReactNode;
	icon?: ReactNode;
	locale: Locale;
	close(): void;
	children: ReactNode;
	/** A sheet that fills the screen below `top` (New task at 54, Review at 70). */ tall?: boolean;
	top?: number;
}) {
	const sheet = useRef<HTMLDivElement>(null),
		drag = useRef<{ y: number; at: number; dy: number } | null>(null);
	useEffect(() => {
		const before = document.activeElement as HTMLElement | null;
		sheet.current?.focus({ preventScroll: true });
		const key = (event: KeyboardEvent) => {
			if (event.key !== 'Escape') return;
			event.preventDefault();
			close();
		};
		addEventListener('keydown', key);
		return () => {
			removeEventListener('keydown', key);
			before?.focus?.({ preventScroll: true });
		};
	}, []);
	const start = (event: ReactPointerEvent) => {
		if ((event.target as HTMLElement).closest('button:not([data-grab])')) return;
		drag.current = { y: event.clientY, at: performance.now(), dy: 0 };
		(event.currentTarget as HTMLElement).setPointerCapture(event.pointerId);
		sheet.current?.setAttribute('data-dragging', '');
	};
	const move = (event: ReactPointerEvent) => {
		if (!drag.current || !sheet.current) return;
		drag.current.dy = Math.max(0, event.clientY - drag.current.y);
		sheet.current.style.transform = `translateY(${drag.current.dy}px)`;
	};
	const end = () => {
		const state = drag.current,
			node = sheet.current;
		drag.current = null;
		if (!state || !node) return;
		node.removeAttribute('data-dragging');
		const speed = state.dy / Math.max(1, performance.now() - state.at);
		if (state.dy > node.offsetHeight / 4 || (state.dy > 24 && speed > 0.5)) close();
		else node.style.transform = '';
	};
	return (
		<div className={s.layer} data-sheet-layer>
			<div className={s.scrim} onClick={close} aria-hidden="true" />
			<div
				ref={sheet}
				role="dialog"
				aria-modal="true"
				aria-label={label}
				tabIndex={-1}
				className={s.sheet}
				data-tall={tall || undefined}
				data-sheet
				{...(top === undefined ? {} : { style: { top } })}>
				<div
					className={s.grip}
					onPointerDown={start}
					onPointerMove={move}
					onPointerUp={end}
					onPointerCancel={end}>
					<div className={s.grab} aria-hidden="true" />
					<div className={s.head} data-size="l">
						{icon}
						{title !== undefined &&
							(sub !== undefined ? (
								<span className={s.headTwo}>
									<b className="ell">{title}</b>
									<small className="ell">{sub}</small>
								</span>
							) : (
								<b className="ell">{title}</b>
							))}
						<PopupClose locale={locale} close={close} touch />
					</div>
				</div>
				<div className={s.body}>{children}</div>
			</div>
		</div>
	);
}
/** Rows on a tint card with 16 on each side. */
export function Group({
	children,
	className,
}: {
	children: ReactNode;
	className?: string | undefined;
}) {
	return <div className={className ? `${s.group} ${className}` : s.group}>{children}</div>;
}
/** The whole row is the button (rule 15); an icon in a 30 box, a title and a second line, a tail. */
export function SheetRow({
	icon,
	title,
	sub,
	tail,
	chevron = false,
	danger = false,
	onClick,
	disabled,
	selected,
	role,
	checked,
	data,
}: {
	icon?: ReactNode;
	title: ReactNode;
	sub?: ReactNode;
	tail?: ReactNode;
	chevron?: boolean;
	danger?: boolean;
	onClick?: () => void;
	disabled?: boolean;
	selected?: boolean;
	role?: 'menuitemradio' | 'switch';
	checked?: boolean;
	data?: Record<string, string>;
}) {
	const body = (
		<>
			{icon}
			<span className={s.two}>
				<span>{title}</span>
				{sub !== undefined && <small>{sub}</small>}
			</span>
			{tail}
			{chevron && (
				<svg
					className={s.chevron}
					aria-hidden="true"
					width="16"
					height="16"
					viewBox="0 0 16 16"
					fill="none">
					<path
						d="M6.5 4 10 8l-3.5 4"
						stroke="currentColor"
						strokeWidth="1.4"
						strokeLinecap="round"
						strokeLinejoin="round"
					/>
				</svg>
			)}
		</>
	);
	const attributes = Object.fromEntries(
		Object.entries(data ?? {}).map(([k, v]) => [`data-${k}`, v])
	);
	return onClick ? (
		<button
			type="button"
			className={s.row}
			data-danger={danger || undefined}
			data-selected={selected || undefined}
			disabled={disabled}
			{...(role ? { role, 'aria-checked': checked ?? false } : {})}
			onClick={onClick}
			{...attributes}>
			{body}
		</button>
	) : (
		<div className={s.row} data-danger={danger || undefined} {...attributes}>
			{body}
		</div>
	);
}
export function RowIcon({ children, danger = false }: { children: ReactNode; danger?: boolean }) {
	return (
		<span className={s.rowIcon} data-danger={danger || undefined}>
			{children}
		</span>
	);
}
export function Caption({
	children,
	className,
}: {
	children: ReactNode;
	className?: string | undefined;
}) {
	return <p className={className ? `${s.caption} ${className}` : s.caption}>{children}</p>;
}
export function SectionHead({ children, count }: { children: ReactNode; count?: ReactNode }) {
	return (
		<div className={s.section}>
			{children}
			{count !== undefined && <span>{count}</span>}
		</div>
	);
}
