/**
 * spec/remote-access-and-mobile#phone-task-tools: the task's files for reading — folder by folder (`listFiles`), the crumbs of the open
 * folders, M/A from the tree's status and `+N −M` from the change set; the magnifier searches by name (`searchFiles`).
 * Folders and files are reached only by the ids main handed out, never by a path the phone names.
 */
import { useEffect, useMemo, useRef, useState } from 'react';
import { t, type AgentTask, type FileEntry, type Locale } from '@brigadir/core';
import { BackButton, NavBar, NavIcon } from '../ui/Nav';
import { ChangeMark, FileRow } from '../ui/FileRow';
import { Icon } from '../ui/Icon';
import { back, navigate, replaceRoute } from '../router';
import { useMobile } from '../store';
import { useChanges, keyOf } from './data';
import screen from '../screens/Screen.module.css';
import { Loading } from '../ui/Loading';
import s from './Files.module.css';

/** The entries the phone has seen, by id: the crumbs and the code screen's title come from here. */
export const seenFiles = new Map<string, FileEntry & { parent: string | null }>();
const marks: Record<NonNullable<FileEntry['status']>, string> = {
	modified: 'M',
	added: 'A',
	untracked: 'A',
	deleted: 'D',
	renamed: 'R',
	conflict: '!',
};
/** A tree entry's change in the task's change set: the same file, whatever repo root the change set counts from. */
export function changeFor<T extends { path: string }>(
	entry: { path: string },
	files: readonly T[]
) {
	return (
		files.find((file) => entry.path === file.path || entry.path.endsWith(`/${file.path}`)) ?? null
	);
}
function crumbs(folder: string | null): { id: string | null; name: string }[] {
	const list: { id: string | null; name: string }[] = [];
	for (let id = folder; id;) {
		const entry = seenFiles.get(id);
		if (!entry) break;
		list.unshift({ id, name: entry.name });
		id = entry.parent;
	}
	return list;
}
export function Files({
	task,
	folder,
	locale,
}: {
	task: AgentTask;
	folder: string | null;
	locale: Locale;
}) {
	const project = useMobile((state) =>
		state.workspace?.projects.find((item) => item.id === task.projectId)
	);
	const changes = useChanges(task)?.value?.files ?? [];
	const [entries, setEntries] = useState<FileEntry[] | null>(null),
		[error, setError] = useState<string | null>(null),
		[query, setQuery] = useState<string | null>(null),
		[found, setFound] = useState<FileEntry[] | null>(null);
	const field = useRef<HTMLInputElement>(null);
	useEffect(() => {
		let live = true;
		setEntries(null);
		void window.brigadir.listFiles(keyOf(task), folder).then(
			(listing) => {
				if (!live) return;
				for (const entry of listing.entries) seenFiles.set(entry.id, { ...entry, parent: folder });
				setEntries(listing.entries.filter((entry) => entry.kind !== 'unavailable'));
			},
			(reason: unknown) =>
				live && setError(reason instanceof Error ? reason.message : String(reason))
		);
		return () => {
			live = false;
		};
	}, [task.projectId, task.id, folder]);
	useEffect(() => {
		if (query === null) return;
		field.current?.focus();
		if (!query.trim()) return setFound(null);
		let live = true;
		const timer = setTimeout(() => {
			void window.brigadir.searchFiles(keyOf(task), query.trim()).then(
				(result) => {
					if (!live) return;
					for (const entry of result.entries)
						if (!seenFiles.has(entry.id)) seenFiles.set(entry.id, { ...entry, parent: null });
					setFound(result.entries);
				},
				() => live && setFound([])
			);
		}, 200);
		return () => {
			live = false;
			clearTimeout(timer);
		};
	}, [query]);
	const path = crumbs(folder),
		current = folder ? seenFiles.get(folder) : null,
		repo = current?.scopeName ?? project?.name ?? '';
	const changed = useMemo(
		() => (entries ?? []).filter((entry) => entry.kind === 'file' && entry.status).length,
		[entries]
	);
	const open = (entry: FileEntry) =>
		(entry.kind === 'directory' ? replaceRoute : navigate)({
			screen: 'tool',
			projectId: task.projectId,
			taskId: task.id,
			tool: entry.kind === 'directory' ? 'files' : 'file',
			item: entry.id,
		});
	const row = (entry: FileEntry, sub?: string) => {
		const change = entry.kind === 'file' ? changeFor(entry, changes) : null;
		const mark = entry.status ? marks[entry.status] : null;
		return (
			<FileRow
				key={entry.id}
				lead={
					<Icon
						name={entry.kind === 'directory' ? 'folder' : 'file'}
						size={20}
						className={entry.kind === 'directory' ? s.folder : s.file}
					/>
				}
				title={entry.name}
				{...(sub !== undefined
					? { sub: <span className="mono">{sub}</span> }
					: change
						? {
								sub: (
									<span className="mono">
										{entry.status === 'added' || entry.status === 'untracked'
											? t(locale, 'new (file)')
											: `+${change.additions} −${change.deletions}`}
									</span>
								),
							}
						: {})}
				tail={mark ? <ChangeMark mark={mark} /> : undefined}
				chevron={entry.kind === 'directory'}
				data={{ 'file-entry': entry.name, kind: entry.kind }}
				onClick={() => open(entry)}
			/>
		);
	};
	return (
		<div className={screen.screen} data-screen="tool" data-tool="files">
			<NavBar
				left={<BackButton label={t(locale, 'Chat')} locale={locale} onClick={back} />}
				title={t(locale, 'Files')}
				sub={`${repo} · ${t(locale, 'view only')}`}
				right={
					<NavIcon
						icon="search"
						quiet
						label={t(locale, 'Search files')}
						onClick={() => setQuery((value) => (value === null ? '' : null))}
					/>
				}
			/>
			{query !== null ? (
				<label className={screen.search}>
					<Icon name="search" />
					<input
						ref={field}
						type="search"
						value={query}
						enterKeyHint="search"
						aria-label={t(locale, 'Search files')}
						placeholder={t(locale, 'Search files')}
						onChange={(event) => setQuery(event.target.value)}
					/>
				</label>
			) : (
				<div className={s.crumbs} data-crumbs>
					{folder ? (
						<button
							type="button"
							className={s.root}
							aria-label={project?.name ?? t(locale, 'Files')}
							onClick={() =>
								replaceRoute({
									screen: 'tool',
									projectId: task.projectId,
									taskId: task.id,
									tool: 'files',
								})
							}>
							<Icon name="folder" size={15} />
						</button>
					) : (
						<>
							<Icon name="folder" size={15} />
							<b className="ell">{project?.name ?? ''}</b>
						</>
					)}
					{path.map((crumb, i) => (
						<span key={crumb.id ?? i} className={s.crumb}>
							{i > 0 && <Icon name="chevr" size={12} />}
							{i === path.length - 1 ? (
								<b className="ell">{crumb.name}</b>
							) : (
								<button
									type="button"
									className="ell"
									onClick={() =>
										replaceRoute({
											screen: 'tool',
											projectId: task.projectId,
											taskId: task.id,
											tool: 'files',
											item: crumb.id!,
										})
									}>
									{crumb.name}
								</button>
							)}
						</span>
					))}
					<span className={s.space} />
					{changed > 0 && (
						<span className={s.changed}>
							{t(locale, '{count} changed').replace('{count}', String(changed))}
						</span>
					)}
				</div>
			)}
			<div className={screen.scroll}>
				<div className={s.list} data-files>
					{query !== null && found ? (
						found.length ? (
							found.map((entry) =>
								row(entry, entry.path.slice(0, entry.path.lastIndexOf('/')) || '/')
							)
						) : (
							<p className={screen.empty}>{t(locale, 'Nothing found')}</p>
						)
					) : (
						entries?.map((entry) => row(entry))
					)}
					{!entries && error && (
						// spec/remote-access-and-mobile#remote-button: a translated line; the host's own words stay in the tooltip.
						<p className={screen.empty} title={error}>
							{t(locale, 'The folder could not be read.')}
						</p>
					)}
					{!entries && !error && query === null && <Loading locale={locale} />}
				</div>
			</div>
		</div>
	);
}
