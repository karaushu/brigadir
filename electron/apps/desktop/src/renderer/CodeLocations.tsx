import { useLayoutEffect, useRef, useState } from 'react';
import {
	formatAccelerator,
	fileCount,
	locationCount,
	t,
	type CodeLocation,
	type CodeLocations as Result,
	type Locale,
} from '@brigadir/core';
import { Glyph } from './ui/Glyph';
import { useWorkspace } from './store';
import { PopupClose } from './ui/PopupClose';
import search from './Search.module.css';
import styles from './CodeLocations.module.css';
/** spec/editor-code-intelligence#references-and-problems: grouped places of a name; opens one and hands focus back to the editor. spec/pull-requests-and-ci#pr-definition: a PR file passes its own `note`
 *  (found by name in the PR branch) and a `tag` for groups the PR did not change. */
export function CodeLocations({
	title,
	result,
	languageName,
	locale,
	open,
	close,
	note: ownNote,
	tag,
}: {
	title: 'References' | 'Go to definition';
	result: Result;
	languageName: string;
	locale: Locale;
	open(location: CodeLocation): void;
	close(): void;
	note?: string;
	tag?: (fileId: string) => string | null;
}) {
	const serversOn = useWorkspace((state) => state.appearance.editing.languageServers);
	const dialog = useRef<HTMLDialogElement>(null),
		list = useRef<HTMLDivElement>(null);
	const [selected, setSelected] = useState(0);
	useLayoutEffect(() => {
		const node = dialog.current;
		node?.showModal();
		list.current
			?.querySelector<HTMLElement>('[aria-selected=true]')
			?.focus({ preventScroll: true });
		return () => {
			node?.close();
		};
	}, []);
	useLayoutEffect(() => {
		list.current
			?.querySelector<HTMLElement>('[aria-selected=true]')
			?.scrollIntoView({ block: 'nearest' });
	}, [selected]);
	const groups = new Map<
		string,
		{ path: string; readOnly: boolean; items: { location: CodeLocation; index: number }[] }
	>();
	result.locations.forEach((location, index) => {
		const group = groups.get(location.fileId) ?? {
			path: location.path,
			readOnly: location.readOnly,
			items: [],
		};
		group.items.push({ location, index });
		groups.set(location.fileId, group);
	});
	const note =
		ownNote !== undefined
			? ownNote
			: result.source !== 'fallback'
				? null
				: serversOn
					? t(
							locale,
							title === 'References'
								? 'Text matches: no language server for {language}.'
								: 'Found by name: no language server for {language}.'
						).replace('{language}', languageName)
					: t(
							locale,
							title === 'References'
								? 'Text matches: language servers are off.'
								: 'Found by name: language servers are off.'
						);
	return (
		<dialog
			ref={dialog}
			className={`${search.dialog} ${styles.dialog}`}
			aria-label={t(locale, title)}
			onCancel={(event) => {
				event.preventDefault();
				close();
			}}
			onKeyDown={(event) => {
				if (event.defaultPrevented || event.nativeEvent.isComposing) return;
				if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
					event.preventDefault();
					setSelected((value) => {
						const next = Math.max(
							0,
							Math.min(result.locations.length - 1, value + (event.key === 'ArrowDown' ? 1 : -1))
						);
						requestAnimationFrame(() =>
							list.current
								?.querySelector<HTMLElement>(`[data-index="${next}"]`)
								?.focus({ preventScroll: true })
						);
						return next;
					});
				} else if (event.key === 'Enter') {
					const location = result.locations[selected];
					if (location) {
						event.preventDefault();
						open(location);
					}
				}
			}}>
			<header>
				<Glyph name="search" size={14} />
				<h2>{t(locale, title)}</h2>
				<small>
					{locationCount(locale, result.locations.length)} · {fileCount(locale, groups.size)}
				</small>
				<PopupClose locale={locale} close={close} />
			</header>
			{note && <p className={styles.note}>{note}</p>}
			{result.locations.length ? (
				<div
					ref={list}
					role="listbox"
					aria-label={t(locale, title)}
					className={`${search.results} ${styles.results}`}>
					{[...groups.entries()].map(([fileId, group]) => (
						<section key={fileId} role="group" aria-label={group.path}>
							<h3 title={group.path}>
								{group.path}
								{group.readOnly ? (
									<small>{t(locale, 'Outside the project')}</small>
								) : (
									tag?.(fileId) && <small>{tag(fileId)}</small>
								)}
							</h3>
							{group.items.map(({ location, index }) => (
								<button
									key={index}
									type="button"
									role="option"
									data-index={index}
									aria-selected={index === selected}
									tabIndex={index === selected ? 0 : -1}
									title={t(locale, 'Open the location')}
									onMouseMove={() => setSelected(index)}
									onClick={() => open(location)}>
									<small className={styles.line}>{location.line}</small>
									<span>{location.preview || ' '}</span>
									{location.byName && <small>{t(locale, 'By name')}</small>}
								</button>
							))}
						</section>
					))}
				</div>
			) : (
				<p role="status">
					{t(locale, title === 'References' ? 'No references found.' : 'No definition found.')}
				</p>
			)}
			{result.truncated && <p>{t(locale, 'The list is shortened.')}</p>}
			<footer>
				<span>↑↓ {t(locale, 'Select result')}</span>
				<span>
					{formatAccelerator('Enter')} {t(locale, 'Open result')}
				</span>
				<span>
					{formatAccelerator('Escape')} {t(locale, 'Close')}
				</span>
			</footer>
		</dialog>
	);
}
