import { useLayoutEffect, useRef, type KeyboardEvent, type Ref } from 'react';
import {
	commandAccelerator,
	defaultKeymap,
	formatAccelerator,
	matchesAccelerator,
	menuCommands,
	t,
	type KeymapSettings,
	type Locale,
} from '@brigadir/core';
import { IconButton } from './Controls';
import { Glyph } from './Glyph';
import { PopupClose } from './PopupClose';
import styles from './FindPanel.module.css';

/**
 * spec/appearance#evolution-redesign (spec/editor#editor-chrome): find in a file — a floating card over the code, top right, the code under it stays.
 * One row M 28 (rule 16): `›` in its own column, the field with Aa / ab / .* inside it, the counter, ↑ ↓, select all, Esc;
 * expanded, a second row with the replace field, Replace and Replace all. The owner keeps the query (CodeMirror's).
 */
export type FindQuery = {
	search: string;
	caseSensitive: boolean;
	wholeWord: boolean;
	regexp: boolean;
	replace: string;
};
export type FindCount =
	| { kind: 'empty' }
	| { kind: 'invalid' }
	| { kind: 'none' }
	| { kind: 'found'; current: number | null; total: number; capped: boolean };

/** The counter as the canvas writes it: `3 of 12`, narrow `3/12`; `?` when the caret is off every match. */
export function findCountText(locale: Locale, count: FindCount, short: boolean): string {
	if (count.kind === 'empty') return '';
	if (count.kind === 'invalid') return t(locale, 'Invalid regex');
	if (count.kind === 'none') return t(locale, 'No results');
	const total = `${count.total}${count.capped ? '+' : ''}`,
		current = count.current === null ? '?' : String(count.current);
	return short
		? `${current}/${total}`
		: t(locale, '{index} of {count}').replace('{index}', current).replace('{count}', total);
}

/** A menu command's key in this keymap, as an accelerator for this platform. */
const commandKey = (id: string, keymap: KeymapSettings) => {
	const command = menuCommands.find((item) => item.id === id);
	return command && commandAccelerator(command, keymap);
};
/**
 * Keys of the panel's gestures, spelled for this platform. Next, previous and Replace all are Editor ▸ Find next /
 * Find previous / Replace all, so they follow the keymap (spec/search-menus-and-commands#menu-structure); select all and replace are the fields' own.
 */
function keys(keymap: KeymapSettings) {
	const shown = (id: string) => {
		const key = commandKey(id, keymap);
		return key ? formatAccelerator(key) : undefined;
	};
	return {
		next: shown('editor-find-next'),
		previous: shown('editor-find-previous'),
		selectAll: formatAccelerator('Alt+Enter'),
		replace: formatAccelerator('Enter'),
		replaceAll: shown('editor-replace-all'),
	};
}

export function FindPanel({
	locale,
	query,
	count,
	replace,
	showReplaceKey,
	keymap = defaultKeymap,
	fieldRef,
	replaceRef,
	onQuery,
	onNext,
	onPrevious,
	onSelectAll,
	onReplace,
	onReplaceAll,
	onClose,
}: {
	locale: Locale;
	query: FindQuery;
	count: FindCount;
	/** Null where replacing is not possible: a read-only or locked file, the Markdown preview. */
	replace: { open: boolean; toggle(): void } | null;
	/** `Show replace · ⌥⌘F`: the keymap's Find and replace. */
	showReplaceKey?: string | undefined;
	/** The keymap the Editor menu's find items follow. */
	keymap?: KeymapSettings;
	fieldRef?: Ref<HTMLInputElement>;
	replaceRef?: Ref<HTMLInputElement>;
	onQuery(next: FindQuery): void;
	onNext(): void;
	onPrevious(): void;
	onSelectAll(): void;
	onReplace(): void;
	onReplaceAll(): void;
	onClose(): void;
}) {
	const key = keys(keymap);
	const hint = (label: string, shortcut?: string) => (shortcut ? `${label} · ${shortcut}` : label);
	const found = count.kind === 'found';
	const bad = count.kind === 'none' || count.kind === 'invalid';
	const own = useRef<HTMLInputElement | null>(null);
	// A fresh panel takes the focus with its words selected, as ⌘F does in every editor.
	useLayoutEffect(() => {
		own.current?.focus();
		own.current?.select();
	}, []);
	const toggle = (
		name: 'caseSensitive' | 'wholeWord' | 'regexp',
		label: string,
		glyph: 'find-case' | 'find-word' | 'find-regex'
	) => (
		<button
			type="button"
			className={styles.toggle}
			aria-pressed={query[name]}
			aria-label={label}
			title={label}
			onMouseDown={(event) => event.preventDefault()}
			onClick={() => onQuery({ ...query, [name]: !query[name] })}>
			<Glyph name={glyph} size={14} />
		</button>
	);
	function keyDown(event: KeyboardEvent<HTMLElement>) {
		if (event.key === 'Escape') {
			event.preventDefault();
			event.stopPropagation();
			onClose();
		} else if (matchesAccelerator(event, commandKey('editor-find-next', keymap))) {
			event.preventDefault();
			onNext();
		} else if (matchesAccelerator(event, commandKey('editor-find-previous', keymap))) {
			event.preventDefault();
			onPrevious();
		}
	}
	return (
		<div className={styles.host}>
			<section
				className={styles.panel}
				data-find-panel
				data-replace={replace?.open || undefined}
				role="search"
				aria-label={t(locale, 'Find in file')}
				onKeyDown={keyDown}>
				{replace && (
					<div className={styles.row} data-size="m">
						<IconButton
							label={t(locale, replace.open ? 'Hide replace' : 'Show replace')}
							hint={hint(
								t(locale, replace.open ? 'Hide replace' : 'Show replace'),
								replace.open ? undefined : showReplaceKey
							)}
							onMouseDown={(event) => event.preventDefault()}
							onClick={replace.toggle}>
							<Glyph name={replace.open ? 'find-replace-hide' : 'find-replace-show'} size={14} />
						</IconButton>
					</div>
				)}
				<div className={styles.rows}>
					<div className={styles.row} data-size="m">
						<label className={styles.field} data-bad={bad || undefined}>
							<input
								ref={(node) => {
									own.current = node;
									if (typeof fieldRef === 'function') fieldRef(node);
									else if (fieldRef) fieldRef.current = node;
								}}
								value={query.search}
								placeholder={t(locale, 'Find')}
								aria-label={t(locale, 'Find')}
								aria-invalid={bad || undefined}
								spellCheck={false}
								autoComplete="off"
								onChange={(event) => onQuery({ ...query, search: event.target.value })}
								onKeyDown={(event) => {
									if (event.key !== 'Enter') return;
									event.preventDefault();
									if (event.altKey) onSelectAll();
									else (event.shiftKey ? onPrevious : onNext)();
								}}
							/>
							{toggle('caseSensitive', t(locale, 'Match case'), 'find-case')}
							{toggle('wholeWord', t(locale, 'Whole word'), 'find-word')}
							{toggle('regexp', t(locale, 'Regular expression'), 'find-regex')}
						</label>
						{count.kind !== 'empty' && (
							<span
								className={styles.count}
								data-find-count
								data-bad={bad || undefined}
								aria-live="polite">
								<span className={styles.long}>{findCountText(locale, count, false)}</span>
								<span className={styles.short} aria-hidden="true">
									{findCountText(locale, count, true)}
								</span>
							</span>
						)}
						<IconButton
							label={t(locale, 'Previous match')}
							hint={hint(t(locale, 'Previous match'), key.previous)}
							disabled={!found}
							onMouseDown={(event) => event.preventDefault()}
							onClick={onPrevious}>
							<Glyph name="find-previous" size={14} />
						</IconButton>
						<IconButton
							label={t(locale, 'Next match')}
							hint={hint(t(locale, 'Next match'), key.next)}
							disabled={!found}
							onMouseDown={(event) => event.preventDefault()}
							onClick={onNext}>
							<Glyph name="find-next" size={14} />
						</IconButton>
						<IconButton
							className={styles.selectAll}
							label={t(locale, 'Select all matches')}
							hint={hint(t(locale, 'Select all matches'), key.selectAll)}
							disabled={!found}
							onMouseDown={(event) => event.preventDefault()}
							onClick={onSelectAll}>
							<Glyph name="select-all" size={14} />
						</IconButton>
						<PopupClose locale={locale} close={onClose} />
					</div>
					{replace?.open && (
						<div className={styles.row} data-size="m">
							<label className={styles.field}>
								<input
									ref={replaceRef}
									value={query.replace}
									placeholder={t(locale, 'Replace')}
									aria-label={t(locale, 'Replace')}
									spellCheck={false}
									autoComplete="off"
									onChange={(event) => onQuery({ ...query, replace: event.target.value })}
									onKeyDown={(event) => {
										if (matchesAccelerator(event, commandKey('editor-replace-all', keymap))) {
											event.preventDefault();
											onReplaceAll();
										} else if (event.key === 'Enter' && !event.altKey) {
											event.preventDefault();
											onReplace();
										}
									}}
								/>
							</label>
							<IconButton
								label={t(locale, 'Replace')}
								hint={hint(t(locale, 'Replace'), key.replace)}
								disabled={!found}
								onMouseDown={(event) => event.preventDefault()}
								onClick={onReplace}>
								<Glyph name="replace" size={14} />
							</IconButton>
							<IconButton
								label={t(locale, 'Replace all')}
								hint={hint(t(locale, 'Replace all'), key.replaceAll)}
								disabled={!found}
								onMouseDown={(event) => event.preventDefault()}
								onClick={onReplaceAll}>
								<Glyph name="replace-all" size={14} />
							</IconButton>
						</div>
					)}
				</div>
			</section>
		</div>
	);
}
