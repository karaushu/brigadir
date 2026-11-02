import { useEffect, useRef, useState, type KeyboardEvent } from 'react';
import {
	folderAge,
	t,
	type Locale,
	type RemoteFsEntry,
	type RemoteFsListing,
	type RemotePick,
} from '@brigadir/core';
import { Button, Chevron, IconButton } from './ui/Controls';
import { Glyph } from './ui/Glyph';
import { TextInput } from './ui/Input';
import { ModalDialog } from './ui/ModalDialog';
import { listStep } from './ui/list-keys';
import { fill } from './remote-text';
import s from './RemoteFolder.module.css';

const join = (folder: string, name: string) => (folder === '/' ? `/${name}` : `${folder}/${name}`);

/**
 * spec/remote-access-and-mobile#architecture, spec/remote-access-and-mobile#client-ui-seam: the folder browser of the working
 * machine in a window of it on a device — what `showOpenDialog` was there. Up and the crumbs walk the folders; a row is
 * chosen by a click, opened by a double click or →; `Choose` answers with the chosen folder (or the one shown) or file.
 * ⌘⇧. shows hidden names, as the system dialog does. It reads only while this choice is open on the machine.
 */
export function RemoteFolder({
	pick,
	machine,
	locale,
	answer,
}: {
	pick: RemotePick;
	machine: string;
	locale: Locale;
	answer(path: string | null): void;
}) {
	const [listing, setListing] = useState<RemoteFsListing | null>(null),
		[failed, setFailed] = useState(false),
		[selected, setSelected] = useState<string | null>(null),
		[hidden, setHidden] = useState(false),
		[naming, setNaming] = useState<string | null>(null),
		[creating, setCreating] = useState(false);
	const list = useRef<HTMLDivElement>(null),
		trail = useRef<HTMLElement>(null),
		choose = useRef<HTMLButtonElement>(null),
		request = useRef(0);
	const open = (path: string | null, select: string | null = null, showHidden = hidden) => {
		const id = ++request.current;
		setFailed(false);
		void window.brigadir.listRemoteFolder(pick.id, path, showHidden).then(
			(next) => {
				if (id !== request.current) return;
				setListing(next);
				setSelected(select && next.entries.some((entry) => entry.name === select) ? select : null);
				setNaming(null);
				list.current?.scrollTo({ top: 0 });
			},
			() => {
				if (id === request.current) setFailed(true);
			}
		);
	};
	useEffect(() => open(null), [pick.id]);
	// A deep folder keeps its last crumbs in sight; the first ones go under the left edge.
	useEffect(() => {
		const node = trail.current;
		if (node) node.scrollLeft = node.scrollWidth;
	}, [listing?.path]);
	const entries = listing?.entries ?? [];
	const entry = entries.find((item) => item.name === selected) ?? null;
	const path = listing ? (entry ? join(listing.path, entry.name) : listing.path) : '';
	const choosable =
		pick.target === 'folder'
			? !!listing && (!entry || entry.kind === 'directory')
			: entry?.kind === 'file';
	const submit = () => {
		if (choosable && listing) answer(path);
	};
	const enter = (item: RemoteFsEntry) => {
		if (!listing) return;
		if (item.kind === 'directory') open(join(listing.path, item.name));
		else if (pick.target === 'file') answer(join(listing.path, item.name));
	};
	const up = () => {
		if (listing?.parent) open(listing.parent, listing.path.split('/').pop() ?? null);
	};
	const crumbs = listing
		? listing.path
				.split('/')
				.filter(Boolean)
				.map((name, index, all) => ({ name, path: `/${all.slice(0, index + 1).join('/')}` }))
		: [];
	const keys = (event: KeyboardEvent) => {
		if (naming !== null) return;
		if (event.key === '.' && event.shiftKey && (event.metaKey || event.ctrlKey)) {
			event.preventDefault();
			setHidden(!hidden);
			open(listing?.path ?? null, selected, !hidden);
			return;
		}
		const index = entries.findIndex((item) => item.name === selected);
		const step = listStep(event.key, index, entries.length);
		if (
			step !== null &&
			(event.key === 'ArrowDown' ||
				event.key === 'ArrowUp' ||
				event.key === 'Home' ||
				event.key === 'End')
		) {
			event.preventDefault();
			const next = entries[step];
			if (next) {
				setSelected(next.name);
				list.current
					?.querySelector(`[data-folder-row="${CSS.escape(next.name)}"]`)
					?.scrollIntoView({ block: 'nearest' });
			}
			return;
		}
		if (event.key === 'ArrowRight' && entry?.kind === 'directory') {
			event.preventDefault();
			enter(entry);
		}
		if (event.key === 'ArrowLeft' && listing?.parent) {
			event.preventDefault();
			up();
		}
		if (event.key === 'Enter' && event.target === list.current) {
			event.preventDefault();
			submit();
		}
	};
	const create = async () => {
		const name = naming?.trim();
		if (!listing || !name || creating) return;
		setCreating(true);
		try {
			await window.brigadir.createRemoteFolder(pick.id, listing.path, name);
			open(listing.path, name);
		} catch {
			setFailed(true);
		} finally {
			setCreating(false);
		}
	};
	return (
		<ModalDialog
			title={pick.title}
			locale={locale}
			width={540}
			top={80}
			close={() => answer(null)}
			initialFocus={list}
			data-remote-folder={pick.target}
			footer={
				<>
					{pick.target === 'folder' && (
						<Button
							variant="ghost"
							className={s.newFolder}
							disabled={!listing || naming !== null}
							onClick={() => {
								setSelected(null);
								setNaming('');
							}}>
							{t(locale, 'New folder…')}
						</Button>
					)}
					<span className={s.grow} />
					<Button
						ref={choose}
						appearance="primary"
						disabled={!choosable}
						onClick={submit}
						data-remote-folder-choose>
						{t(locale, 'Choose (folder)')}
					</Button>
				</>
			}>
			<div className={s.bar} data-size="m">
				<IconButton
					variant="soft"
					label={t(locale, 'Folder up')}
					disabled={!listing?.parent}
					onClick={up}>
					<Glyph name="folder-up" size={14} />
				</IconButton>
				<nav
					ref={trail}
					className={s.crumbs}
					aria-label={fill(locale, 'Folders of {machine}', { machine })}>
					<button type="button" className={s.crumb} onClick={() => open('/')}>
						{machine}
					</button>
					{crumbs.map((crumb, index) => (
						<span key={crumb.path} className={s.step}>
							<Chevron right />
							<button
								type="button"
								className={s.crumb}
								data-last={index === crumbs.length - 1}
								aria-current={index === crumbs.length - 1 ? 'location' : undefined}
								onClick={() => open(crumb.path)}>
								{crumb.name}
							</button>
						</span>
					))}
				</nav>
			</div>
			<div
				ref={list}
				className={s.list}
				role="listbox"
				tabIndex={0}
				aria-label={listing?.path ?? pick.title}
				aria-activedescendant={entry ? `folder-row-${entries.indexOf(entry)}` : undefined}
				onKeyDown={keys}
				data-remote-folder-list>
				{naming !== null && (
					<div className={s.row} data-naming>
						<Glyph name="folder-browse" size={14} />
						<TextInput
							autoFocus
							embedded
							aria-label={t(locale, 'Folder name')}
							value={naming}
							onChange={(event) => setNaming(event.target.value)}
							onBlur={() => {
								if (!naming.trim()) setNaming(null);
							}}
							onKeyDown={(event) => {
								event.stopPropagation();
								if (event.key === 'Enter') void create();
								if (event.key === 'Escape') {
									event.preventDefault();
									setNaming(null);
									list.current?.focus();
								}
							}}
						/>
					</div>
				)}
				{entries.map((item, index) => {
					const age = folderAge(locale, item.modifiedAt);
					return (
						<div
							key={item.name}
							id={`folder-row-${index}`}
							role="option"
							aria-selected={item.name === selected}
							className={s.row}
							data-git={item.git}
							data-hidden={item.hidden}
							data-folder-row={item.name}
							onClick={() => setSelected(item.name)}
							onDoubleClick={() => enter(item)}>
							<Glyph name={item.kind === 'directory' ? 'folder-browse' : 'file'} size={14} />
							<span className={s.name}>{item.name}</span>
							<span className={s.meta}>
								{item.git ? fill(locale, 'git · {time}', { time: age }) : age}
							</span>
							{item.kind === 'directory' && (
								<span className={s.chevron}>
									<Chevron right />
								</span>
							)}
						</div>
					);
				})}
				{listing && !entries.length && naming === null && !failed && (
					<p className={s.empty}>{t(locale, 'The folder is empty')}</p>
				)}
				{failed && (
					<p className={s.empty} role="alert">
						{t(
							locale,
							naming !== null ? 'Could not create the folder.' : 'Could not read the folder.'
						)}
					</p>
				)}
			</div>
			<p className={s.hint}>
				{fill(locale, 'Double-click or → opens a folder. Path on {machine}:', { machine })}{' '}
				<span className={s.path} data-remote-folder-path>
					{path}
				</span>
				{listing?.truncated ? ` · ${t(locale, 'Showing the first 2,000 items')}` : ''}
			</p>
		</ModalDialog>
	);
}
