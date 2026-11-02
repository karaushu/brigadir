/**
 * spec/remote-access-and-mobile#phone-task-tools: one file for reading — CodeMirror without LSP or edits (`readOnly`, not editable, no
 * keyboard), wrapped lines, line numbers, the computer's syntax tokens (`readEditorSyntax` → `syntaxDecorations`) and the
 * change bars of spec/editor#change-marks from this file's diff in the task's changes. Markdown opens as the preview, «Код» shows the source.
 * The text comes by `peekFile`: no editor lease on the machine.
 */
import { useEffect, useMemo, useRef, useState } from 'react';
import { EditorState, RangeSet } from '@codemirror/state';
import { EditorView, GutterMarker, gutter, lineNumbers } from '@codemirror/view';
import { t, type AgentTask, type FileContent, type Locale } from '@brigadir/core';
import { setSyntax, syntaxDecorations } from '../../renderer/syntax';
import { markdown } from '../../renderer/markdown';
import { Segments } from '../../renderer/ui/Controls';
import { BackButton, NavBar, NavIcon } from '../ui/Nav';
import { Caption, Group, RowIcon, Sheet, SheetRow } from '../ui/Sheet';
import { Icon } from '../ui/Icon';
import { back, navigate, openSheet, useRouter } from '../router';
import { useChanges, keyOf } from './data';
import { changeBars, fileFolder, fileView, markdownFile, type ChangeBar } from './logic';
import { changeFor, seenFiles } from './Files';
import screen from '../screens/Screen.module.css';
import s from './Files.module.css';

class Bar extends GutterMarker {
	constructor(readonly kind: ChangeBar) {
		super();
	}
	override eq(other: Bar) {
		return other.kind === this.kind;
	}
	override toDOM() {
		const node = document.createElement('span');
		node.className = 'cm-bar';
		node.dataset.bar = this.kind;
		return node;
	}
}
/**
 * The code rows as the editor's theme: 12.5 / 19 mono, a number of 36, the bar of 3 after it, wrapped text
 * under its own start (a hanging indent). It lives in the editor's shadow root with CodeMirror's own styles: the phone's CSP
 * (`style-src 'self'`, spec/remote-access-and-mobile#phone-network) refuses the `<style>` CodeMirror would add to the page, while a shadow root takes them
 * as adopted style sheets. The colours are the page's tokens, which pass the shadow boundary.
 */
const phoneTheme = EditorView.theme({
	'&': {
		height: '100%',
		background: 'var(--win)',
		color: 'var(--fg)',
		font: '12.5px/19px var(--mono-family)',
	},
	'&.cm-focused': { outline: 'none' },
	'.cm-scroller': {
		padding: '10px 0 calc(20px + var(--safe-bottom, 0px))',
		font: 'inherit',
		lineHeight: '19px',
		overscrollBehavior: 'contain',
	},
	'.cm-gutters': { border: '0', background: 'var(--win)', color: 'var(--fg3)' },
	'.cm-lineNumbers .cm-gutterElement': {
		minWidth: '26px',
		padding: '0 10px 0 0',
		fontVariantNumeric: 'tabular-nums',
	},
	'.cm-bars': { width: '3px' },
	'.cm-bars .cm-gutterElement': { padding: '0' },
	'.cm-bar': { display: 'block', width: '3px', height: '100%', background: 'var(--green)' },
	'.cm-bar[data-bar="modified"]': { background: 'var(--accent)' },
	'.cm-content': { padding: '0', caretColor: 'transparent' },
	'.cm-line': { padding: '0 12px 0 calc(2.2em + 3px)', textIndent: '-2.2em' },
	'.syntax-keyword': { color: 'var(--syntaxKeyword)', fontWeight: '700', fontSynthesis: 'none' },
	'.syntax-string': { color: 'var(--syntaxString)' },
	'.syntax-comment': { color: 'var(--syntaxComment)', fontStyle: 'italic', fontSynthesis: 'none' },
	'.syntax-number': { color: 'var(--syntaxNumber)' },
	'.syntax-type': { color: 'var(--syntaxType)' },
	'.syntax-function': { color: 'var(--syntaxFunction)' },
	'.syntax-property': { color: 'var(--syntaxProperty)' },
});
function ReadOnlyCode({
	text,
	tokens,
	bars,
}: {
	text: string;
	tokens: Parameters<typeof setSyntax.of>[0];
	bars: Map<number, ChangeBar>;
}) {
	const host = useRef<HTMLDivElement>(null),
		view = useRef<EditorView | null>(null);
	useEffect(() => {
		const node = host.current!,
			shadow = node.shadowRoot ?? node.attachShadow({ mode: 'open' });
		const parent = document.createElement('div');
		parent.style.height = '100%';
		shadow.replaceChildren(parent);
		const markers = (state: EditorState) =>
			RangeSet.of(
				[...bars]
					.filter(([line]) => line <= state.doc.lines)
					.map(([line, kind]) => new Bar(kind).range(state.doc.line(line).from)),
				true
			);
		const editor = new EditorView({
			parent,
			root: shadow,
			state: EditorState.create({
				doc: text,
				extensions: [
					EditorState.readOnly.of(true),
					EditorView.editable.of(false),
					EditorView.lineWrapping,
					lineNumbers(),
					gutter({ class: 'cm-bars', markers: (v) => markers(v.state) }),
					syntaxDecorations,
					phoneTheme,
					EditorView.contentAttributes.of({ 'aria-readonly': 'true', 'data-code': '' }),
				],
			}),
		});
		view.current = editor;
		return () => {
			editor.destroy();
			view.current = null;
		};
	}, [text, bars]);
	useEffect(() => {
		view.current?.dispatch({ effects: setSyntax.of(tokens) });
	}, [tokens, text, bars]);
	return <div ref={host} className={s.code} data-code-view />;
}
export function Code({
	task,
	fileId,
	locale,
}: {
	task: AgentTask;
	fileId: string;
	locale: Locale;
}) {
	const entry = seenFiles.get(fileId) ?? null,
		parent = entry?.parent ? seenFiles.get(entry.parent) : null,
		{ sheet } = useRouter();
	const name = entry?.name ?? '',
		folder = entry ? fileFolder(entry.path) : '';
	const changes = useChanges(task)?.value?.files ?? [],
		change = entry ? changeFor(entry, changes) : null;
	const [file, setFile] = useState<FileContent | null>(null),
		[error, setError] = useState<string | null>(null),
		[tokens, setTokens] = useState<Parameters<typeof setSyntax.of>[0]>([]),
		[bars, setBars] = useState<Map<number, ChangeBar>>(() => new Map()),
		[view, setView] = useState<'code' | 'preview'>(markdownFile(name) ? 'preview' : 'code');
	useEffect(() => {
		let live = true;
		setFile(null);
		void window.brigadir.peekFile(keyOf(task), fileId).then(
			(content) => {
				if (!live) return;
				setFile(content);
				if (!fileView(name, content).syntax) return;
				void window.brigadir.readEditorSyntax(keyOf(task), fileId, content.text).then(
					(syntax) => live && setTokens(syntax.tokens),
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
	useEffect(() => {
		if (!change) return setBars(new Map());
		let live = true;
		void window.brigadir.readFileDiff(keyOf(task), change.id).then(
			(diff) => live && setBars(changeBars(diff.lines)),
			() => {}
		);
		return () => {
			live = false;
		};
	}, [change?.id]);
	const markdownView = fileView(name, file).preview;
	const html = useMemo(
		() => (file?.state === 'text' && markdownView ? markdown.render(file.text) : ''),
		[file, markdownView]
	);
	return (
		<div className={screen.screen} data-screen="tool" data-tool="file">
			<NavBar
				line={!markdownView}
				left={
					<BackButton label={parent?.name ?? t(locale, 'Files')} locale={locale} onClick={back} />
				}
				title={name}
				sub={`${folder || entry?.scopeName || ''}${folder || entry?.scopeName ? ' · ' : ''}${t(locale, 'view only')}`}
				right={
					markdownView ? undefined : (
						<NavIcon
							icon="more"
							quiet
							label={t(locale, 'File actions')}
							onClick={() => openSheet({ kind: 'file-actions' })}
						/>
					)
				}
			/>
			{markdownView && (
				<div className={s.segments}>
					<Segments
						size="l"
						className={s.wideSegments}
						label={t(locale, 'View')}
						options={[
							{ value: 'code', label: t(locale, 'Code') },
							{ value: 'preview', label: t(locale, 'Preview') },
						]}
						value={view}
						onChange={(value) => setView(value as 'code' | 'preview')}
					/>
				</div>
			)}
			{error ? (
				// spec/remote-access-and-mobile#remote-button: a translated line; the host's own words stay in the tooltip.
				<p className={screen.empty} title={error}>
					{t(locale, 'The file could not be read.')}
				</p>
			) : file && file.state !== 'text' ? (
				<p className={screen.empty}>
					{t(
						locale,
						file.state === 'binary' ? 'Binary file' : 'The file is too large for the preview'
					)}
				</p>
			) : file && markdownView && view === 'preview' ? (
				<div className={screen.scroll}>
					<div
						className={s.markdown}
						data-markdown
						onClick={(event) => {
							const link = (event.target as HTMLElement).closest('a');
							if (!link) return;
							event.preventDefault();
							const href = link.getAttribute('href') ?? '';
							// Only an address with a scheme leaves the app, in the phone's browser; a relative one stays text.
							if (/^(https?:|mailto:)/i.test(href))
								window.open(href, '_blank', 'noopener,noreferrer');
						}}
						dangerouslySetInnerHTML={{ __html: html }}
					/>
				</div>
			) : file ? (
				<ReadOnlyCode text={file.text} tokens={tokens} bars={bars} />
			) : null}
			{sheet?.kind === 'file-actions' && entry && (
				<Sheet label={t(locale, 'File actions')} title={name} locale={locale} close={back}>
					<Group>
						<SheetRow
							icon={
								<RowIcon>
									<Icon name="copy" size={18} />
								</RowIcon>
							}
							title={t(locale, 'Copy path')}
							sub={<span className="mono">{entry.path}</span>}
							onClick={() => {
								void navigator.clipboard?.writeText(entry.path).catch(() => {});
								back();
							}}
						/>
						{change && (
							<SheetRow
								icon={
									<RowIcon>
										<Icon name="diff" size={18} />
									</RowIcon>
								}
								title={t(locale, 'Changes')}
								sub={`+${change.additions} −${change.deletions}`}
								chevron
								onClick={() =>
									navigate({
										screen: 'tool',
										projectId: task.projectId,
										taskId: task.id,
										tool: 'changes',
										item: change.id,
									})
								}
							/>
						)}
					</Group>
					<Caption className={s.sheetCaption}>{t(locale, 'View only')}</Caption>
				</Sheet>
			)}
		</div>
	);
}
