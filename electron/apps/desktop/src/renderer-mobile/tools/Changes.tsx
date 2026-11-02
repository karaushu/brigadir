/**
 * spec/remote-access-and-mobile#phone-task-tools: the task's changes for reading — the file list with marks and `+N −M`, then one file's
 * diff in the computer's rows (`diffRows`, `ui/DiffCode`, unwrapped until «Wrap lines») in the shared row engine (`ui/Rows`, rule 6),
 * «Попередній / Наступний» file below. Edits go to the agent in the chat.
 */
import { useEffect, useMemo, useState } from 'react';
import {
	fileCount,
	t,
	type AgentTask,
	type ChangedFile,
	type ChangesSnapshot,
	type FileDiff,
	type Locale,
	type SyntaxToken,
} from '@brigadir/core';
import { DiffCode } from '../../renderer/ui/DiffCode';
import { Button } from '../../renderer/ui/Controls';
import { Rows } from '../../renderer/ui/Rows';
import { diffRows, noExpansion } from '../../renderer/diff-rows';
import { lineTokens } from '../../renderer/syntax';
import { BackButton, NavBar, NavIcon } from '../ui/Nav';
import { Counts } from '../ui/Cards';
import { ChangeMark, FileRow } from '../ui/FileRow';
import { Group, Caption } from '../ui/Sheet';
import { Icon } from '../ui/Icon';
import { back, navigate, replaceRoute } from '../router';
import { useChanges, keyOf } from './data';
import { diffHunks, fileFolder, fileMark, fileName } from './logic';
import screen from '../screens/Screen.module.css';
import { Loading } from '../ui/Loading';
import s from './Tools.module.css';

const total = (files: readonly ChangedFile[]) =>
	files.reduce(
		(sum, file) => ({
			additions: sum.additions + file.additions,
			deletions: sum.deletions + file.deletions,
		}),
		{ additions: 0, deletions: 0 }
	);
/** Where a file lies in the project (`kit/src/Button`): a repo other than the root leads its folder. */
function placeOf(snapshot: ChangesSnapshot, file: ChangedFile): string {
	const scope = snapshot.scopes.find((item) => item.id === file.scopeId),
		folder = fileFolder(file.path);
	const lead = scope && scope.kind !== 'root' ? scope.name : '';
	return [lead, folder].filter(Boolean).join('/') || '/';
}
export function changesBase(task: AgentTask) {
	return task.launch?.baseRef.replace(/^origin\//, '') ?? null;
}
export function ChangesList({ task, locale }: { task: AgentTask; locale: Locale }) {
	const entry = useChanges(task),
		snapshot = entry?.value ?? null;
	const files = snapshot?.files ?? [];
	const sum = total(files),
		base = changesBase(task),
		repos = new Set(files.map((file) => file.scopeId)),
		repo =
			repos.size === 1 ? snapshot?.scopes.find((scope) => repos.has(scope.id))?.name : undefined;
	return (
		<div className={screen.screen} data-screen="tool" data-tool="changes">
			<NavBar
				left={<BackButton label={t(locale, 'Chat')} locale={locale} onClick={back} />}
				title={t(locale, 'Changes')}
				sub={task.title}
			/>
			<div className={screen.scroll}>
				{snapshot && files.length > 0 && (
					<div className={s.summary} data-changes-summary>
						<span>{fileCount(locale, files.length)}</span>
						<Counts additions={sum.additions} deletions={sum.deletions} />
						{base && (
							<>
								<span>· {t(locale, 'from (base)')}</span>
								<span className="mono">{base}</span>
							</>
						)}
						<span className={s.space} />
						{repo && <span className="ell">{repo}</span>}
					</div>
				)}
				{snapshot && files.length > 0 && (
					<Group className={s.files}>
						{files.map((file) => {
							return (
								<FileRow
									key={file.id}
									lead={<ChangeMark mark={fileMark(file)} />}
									title={fileName(file.path)}
									sub={<span className="mono">{placeOf(snapshot, file)}</span>}
									tail={<Counts additions={file.additions} deletions={file.deletions} />}
									chevron
									data={{ 'changed-file': file.path }}
									onClick={() =>
										navigate({
											screen: 'tool',
											projectId: task.projectId,
											taskId: task.id,
											tool: 'changes',
											item: file.id,
										})
									}
								/>
							);
						})}
					</Group>
				)}
				{snapshot && !files.length && <p className={screen.empty}>{t(locale, 'No changes')}</p>}
				{!snapshot && entry?.error && (
					// spec/remote-access-and-mobile#remote-button: a translated line; the host's own words stay in the tooltip.
					<p className={screen.empty} title={entry.error}>
						{t(locale, 'The changes could not be read.')}
					</p>
				)}
				{!snapshot && !entry?.error && <Loading locale={locale} />}
				{snapshot && files.length > 0 && (
					<Caption className={s.captionTop}>{t(locale, 'View only')}</Caption>
				)}
			</div>
		</div>
	);
}

type Line =
	{ id: string; kind: 'hunk'; header: string } | { id: string; kind: 'line'; index: number };
export function ChangeDiff({
	task,
	fileId,
	locale,
}: {
	task: AgentTask;
	fileId: string;
	locale: Locale;
}) {
	const entry = useChanges(task),
		files = entry?.value?.files ?? [];
	const index = files.findIndex((file) => file.id === fileId),
		file = files[index] ?? null;
	const [diff, setDiff] = useState<FileDiff | null>(null),
		[error, setError] = useState<string | null>(null),
		// spec/remote-access-and-mobile#remote-button: long lines scroll sideways until the person turns wrapping on.
		[wrap, setWrap] = useState(false);
	useEffect(() => {
		let live = true;
		setDiff(null);
		setError(null);
		void window.brigadir.readFileDiff(keyOf(task), fileId).then(
			(value) => {
				if (!live) return;
				setDiff(value);
				if (value.binary || value.tooLarge || value.file.gitlink) return;
				void window.brigadir.readFileSyntax(keyOf(task), fileId).then(
					(syntax) => live && setDiff((current) => (current ? { ...current, ...syntax } : current)),
					() => {}
				);
			},
			(reason: unknown) =>
				live && setError(reason instanceof Error ? reason.message : String(reason))
		);
		return () => {
			live = false;
		};
	}, [task.projectId, task.id, fileId]);
	const hunks = useMemo(
		() =>
			diff
				? diffHunks(diffRows(diff, 'unified', noExpansion, [], undefined, undefined, false, null))
				: [],
		[diff]
	);
	const lines = useMemo(() => hunks.flatMap((hunk) => hunk.lines), [hunks]);
	const rows: Line[] = useMemo(() => {
		const list: Line[] = [];
		let at = 0;
		for (const hunk of hunks) {
			list.push({ id: hunk.id, kind: 'hunk', header: hunk.header });
			for (let i = 0; i < hunk.lines.length; i++)
				list.push({ id: `l${at}`, kind: 'line', index: at++ });
		}
		return list;
	}, [hunks]);
	const syntax = useMemo(
		() => ({
			old: lineTokens(diff?.beforeText ?? '', diff?.beforeSyntax?.tokens ?? []),
			new: lineTokens(diff?.afterText ?? '', diff?.afterSyntax?.tokens ?? []),
		}),
		[diff]
	);
	const widest = useMemo(
		() => lines.reduce((max, line) => Math.max(max, line.text.length), 0),
		[lines]
	);
	const shown = file ?? diff?.file ?? null;
	const go = (to: number) => {
		const next = files[to];
		if (next)
			replaceRoute({
				screen: 'tool',
				projectId: task.projectId,
				taskId: task.id,
				tool: 'changes',
				item: next.id,
			});
	};
	const none: SyntaxToken[] = [];
	return (
		<div className={screen.screen} data-screen="tool" data-tool="diff">
			<NavBar
				left={<BackButton label={t(locale, 'Changes')} locale={locale} onClick={back} />}
				title={shown ? fileName(shown.path) : ''}
				sub={
					shown ? (
						<>
							{entry?.value ? placeOf(entry.value, shown) : fileFolder(shown.path) || '/'} · +
							{shown.additions} −{shown.deletions}
						</>
					) : undefined
				}
				right={
					<NavIcon
						icon="wrap"
						label={t(locale, 'Wrap lines')}
						quiet={!wrap}
						onClick={() => setWrap((value) => !value)}
					/>
				}
			/>
			<div className={s.diff} data-diff data-wrap={wrap || undefined}>
				{diff && (diff.binary || diff.tooLarge) ? (
					<p className={screen.empty}>
						{t(locale, diff.binary ? 'Binary file' : 'The file is too large for the preview')}
					</p>
				) : error !== null ? (
					<p className={screen.empty} title={error || undefined}>
						{t(locale, 'The file could not be read.')}
					</p>
				) : !diff ? (
					<Loading locale={locale} />
				) : (
					<Rows
						rows={rows}
						role="list"
						followOutput={false}
						label={t(locale, 'Changes')}
						estimatedHeight={19}
						measurementKey={wrap ? 'wrap' : 'nowrap'}
						minWidth={wrap ? 0 : widest * 7.6 + 64}
						locale={locale}
						render={(row) =>
							row.kind === 'hunk' ? (
								<div className={`mono ${s.hunk}`}>{row.header}</div>
							) : (
								(() => {
									const line = lines[row.index]!,
										side = line.kind === 'removed' ? 'old' : 'new',
										number = side === 'old' ? line.oldLine : line.newLine;
									return (
										<DiffCode
											line={line}
											side={side}
											tokens={number === null ? none : (syntax[side].get(number) ?? none)}
											locale={locale}
											wrap={wrap}
										/>
									);
								})()
							)
						}
					/>
				)}
			</div>
			<div className={screen.bottom} data-line>
				<div className={s.pager} data-size="l">
					<Button
						appearance="primary"
						variant="ghost"
						disabled={index <= 0}
						data-diff-prev
						onClick={() => go(index - 1)}>
						<Icon name="back" />
						{t(locale, 'Previous (file)')}
					</Button>
					<span className={s.space} />
					<span className={s.position}>
						{index >= 0
							? t(locale, '{n} of {total}')
									.replace('{n}', String(index + 1))
									.replace('{total}', String(files.length))
							: ''}
					</span>
					<span className={s.space} />
					<Button
						appearance="primary"
						variant="ghost"
						disabled={index < 0 || index >= files.length - 1}
						data-diff-next
						onClick={() => go(index + 1)}>
						{t(locale, 'Next (file)')}
						<Icon name="chevr" />
					</Button>
				</div>
			</div>
		</div>
	);
}
