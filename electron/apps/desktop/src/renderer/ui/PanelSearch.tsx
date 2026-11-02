import { useEffect, useRef, type KeyboardEvent as ReactKeyboardEvent, type RefObject } from 'react';
import { withShortcut, t, type Locale } from '@brigadir/core';
import { Glyph } from './Glyph';
import { IconButton } from './Controls';
import { ClearField } from './ClearField';
import s from './PanelSearch.module.css';
import { useCommandShortcut } from './use-command-shortcut';
/**
 * spec/pull-requests-and-ci#pr-panel: the panel header's search is an icon; a click or ⌘F expands the field over the whole row,
 * above the switch. Esc, or an empty field losing focus, restores the row. The PR panel has the same search (spec/pull-requests-and-ci#pr-list).
 */
export function SearchToggle({ label, onOpen }: { label: string; onOpen(): void }) {
	const find = useCommandShortcut()('editor-find');
	return (
		<IconButton label={label} hint={withShortcut(label, find)} onClick={onOpen}>
			<Glyph name="search" size={13} />
		</IconButton>
	);
}
/**
 * A search field: the --tint frame with the search glyph, the text, an optional count and the clear button (rule 17) — the
 * panel search, the sidebar's task filter (spec/appearance#evolution-redesign) and the icon search of «Project icon» (spec/appearance#evolution-redesign).
 */
export function SearchField({
	locale,
	label,
	placeholder,
	value,
	count,
	inputRef,
	size,
	className,
	onChange,
	onKeyDown,
	onBlur,
	...data
}: {
	locale: Locale;
	label: string;
	placeholder?: string;
	value: string;
	count?: string | undefined;
	inputRef?: RefObject<HTMLInputElement | null>;
	size?: 's' | 'm' | 'l';
	className?: string | undefined;
	onChange(value: string): void;
	onKeyDown?(event: ReactKeyboardEvent<HTMLInputElement>): void;
	onBlur?(): void;
} & { [key: `data-${string}`]: string | boolean | undefined }) {
	return (
		<label {...data} className={`${s.field} ${className ?? ''}`} data-size={size}>
			<Glyph name="search" size={12} />
			<input
				ref={inputRef}
				type="search"
				aria-label={label}
				placeholder={placeholder ?? label}
				value={value}
				onChange={(event) => onChange(event.target.value)}
				onKeyDown={onKeyDown}
				onBlur={onBlur}
			/>
			{value.trim() && count !== undefined && <span className={s.count}>{count}</span>}
			<ClearField locale={locale} value={value} onClear={() => onChange('')} />
		</label>
	);
}
export function PanelSearch({
	locale,
	label,
	value,
	count,
	onChange,
	onClose,
}: {
	locale: Locale;
	label: string;
	value: string;
	count?: string | undefined;
	onChange(value: string): void;
	onClose(): void;
}) {
	const input = useRef<HTMLInputElement>(null);
	useEffect(() => {
		input.current?.focus({ preventScroll: true });
	}, []);
	return (
		<div className={s.search} data-panel-search>
			<SearchField
				locale={locale}
				label={label}
				value={value}
				count={count}
				inputRef={input}
				onChange={onChange}
				onKeyDown={(event) => {
					if (event.key === 'Escape') {
						event.preventDefault();
						event.stopPropagation();
						onChange('');
						onClose();
					}
				}}
				onBlur={() => {
					if (!value.trim()) onClose();
				}}
			/>
			<kbd className={s.kbd} title={t(locale, 'Close')}>
				esc
			</kbd>
		</div>
	);
}
/** A match in the name is highlighted. */
export function Highlight({ text, query }: { text: string; query: string }) {
	const at = query.trim() ? text.toLocaleLowerCase().indexOf(query.trim().toLocaleLowerCase()) : -1;
	if (at < 0) return <>{text}</>;
	const end = at + query.trim().length;
	return (
		<>
			{text.slice(0, at)}
			<mark className={s.mark}>{text.slice(at, end)}</mark>
			{text.slice(end)}
		</>
	);
}
