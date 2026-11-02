import { useEffect, useRef, useState, type ReactNode } from 'react';
import {
	formatAccelerator,
	searchCount,
	syntaxLanguage,
	t,
	textSearchDelay,
	type AgentTask,
	type Locale,
	type SyntaxToken,
	type TextMatch,
	type TextSearchOptions,
	type TextSearchRequest,
} from '@brigadir/core';
import { lineTokens, syntaxSegments } from './syntax';
import { Popup, PopupMarks } from './ui/Controls';
import { Glyph } from './ui/Glyph';
import { ClearField } from './ui/ClearField';
import styles from './Search.module.css';
import { SkeletonText } from './ui/Loading';

export type TextSearchState = {
	id: string;
	matches: TextMatch[];
	scanned: number;
	total: number;
	running: boolean;
	truncated: boolean;
	error: string | null;
};
const idle: TextSearchState = {
	id: '',
	matches: [],
	scanned: 0,
	total: 0,
	running: false,
	truncated: false,
	error: null,
};
/**
 * spec/search-menus-and-commands#search-tabs: one search at a time, 250 ms after the last key; a newer request or closing the modal cancels it.
 * Batches arrive in file order and only append.
 */
export function useTextSearch(
	task: AgentTask | null,
	request: TextSearchRequest | null
): TextSearchState {
	const [state, setState] = useState<TextSearchState>(idle);
	const key = request && task ? `${task.projectId}/${task.id}/${JSON.stringify(request)}` : '';
	useEffect(() => {
		if (!task || !request) {
			setState(idle);
			return;
		}
		const id = crypto.randomUUID();
		let active = true;
		setState({ ...idle, id, running: true });
		const stop = window.brigadir.onTextSearch((event) => {
			if (!active || event.id !== id) return;
			setState((value) => ({
				...value,
				matches: event.matches.length ? [...value.matches, ...event.matches] : value.matches,
				scanned: event.scanned,
				total: event.total,
				running: !event.done,
				truncated: event.truncated,
				error: event.error,
			}));
		});
		const timer = setTimeout(() => {
			void window.brigadir.searchText(task, request, id).catch(() => {
				if (active) setState((value) => ({ ...value, running: false, error: 'failed' }));
			});
		}, textSearchDelay);
		return () => {
			active = false;
			clearTimeout(timer);
			stop();
			void window.brigadir.cancelTextSearch(id).catch(() => {});
		};
	}, [key]);
	return state;
}

/** Aa, W, .* (⌥C ⌥W ⌥X), the mask and the repo of Text (spec/search-menus-and-commands#search-tabs). */
export function TextOptions({
	options,
	setOptions,
	task,
	rootName,
	locale,
	focusInput,
}: {
	options: TextSearchOptions;
	setOptions(next: TextSearchOptions): void;
	task: AgentTask | null;
	/** The root repo `.` is listed by the project's name, as PR rows name it. */
	rootName: string;
	locale: Locale;
	focusInput(): void;
}) {
	const [repos, setRepos] = useState<string[]>([]),
		[mask, setMask] = useState(options.mask);
	useEffect(() => {
		if (!task) return;
		let active = true;
		void window.brigadir.readTextSearchRepos(task).then(
			(value) => {
				if (active) setRepos(value);
			},
			() => {}
		);
		return () => {
			active = false;
		};
	}, [task?.projectId, task?.id]);
	useEffect(() => {
		if (mask === options.mask) return;
		const timer = setTimeout(() => setOptions({ ...options, mask }), 250);
		return () => clearTimeout(timer);
	}, [mask]);
	const toggle = (
		key: 'caseSensitive' | 'wholeWord' | 'regex',
		label: string,
		title: string,
		shortcut: string
	) => (
		<button
			type="button"
			className={styles.toggle}
			aria-pressed={options[key]}
			aria-label={title}
			title={`${title} ${shortcut}`}
			onClick={() => {
				setOptions({ ...options, [key]: !options[key] });
				focusInput();
			}}>
			{label}
		</button>
	);
	return (
		<div className={styles.options} data-size="s">
			{toggle('caseSensitive', 'Aa', t(locale, 'Match case'), formatAccelerator('Alt+C'))}
			{toggle('wholeWord', 'W', t(locale, 'Whole word'), formatAccelerator('Alt+W'))}
			{toggle('regex', '.*', t(locale, 'Regular expression'), formatAccelerator('Alt+X'))}
			<span className={styles.vsep} aria-hidden="true" />
			<label className={styles.field}>
				<Glyph name="search-mask" size={11} />
				<span>{t(locale, 'Mask')}</span>
				<input
					value={mask}
					placeholder="*.ts, !*.test.ts"
					aria-label={t(locale, 'Mask')}
					maxLength={500}
					spellCheck={false}
					onChange={(event) => setMask(event.target.value)}
					onKeyDown={(event) => {
						if (event.key === 'Enter') {
							event.preventDefault();
							setOptions({ ...options, mask });
							focusInput();
						}
					}}
				/>
				<ClearField
					locale={locale}
					value={mask}
					onClear={() => {
						setMask('');
						setOptions({ ...options, mask: '' });
					}}
				/>
			</label>
			{/* spec/search-menus-and-commands#search-modal: the chosen repo carries ✓ in the list, as in the archive and the sheet. */}
			<span className={styles.repo}>
				<PopupMarks.Provider value>
					<Popup
						size="s"
						label={t(locale, 'Repo')}
						icon={<Glyph name="search-repo" size={11} />}
						value={options.repo ?? ''}
						options={[
							{ value: '', label: t(locale, 'All repos') },
							...repos.map((repo) => ({
								value: repo,
								label: repo === '.' ? rootName || repo : repo,
							})),
						]}
						onChange={(value) => {
							setOptions({ ...options, repo: value || null });
							focusInput();
						}}
					/>
				</PopupMarks.Provider>
			</span>
		</div>
	);
}

type Preview = { fileId: string; text: string | null; tokens: Map<number, SyntaxToken[]> };
/** The file around the selected match, the matching lines tinted (spec/search-menus-and-commands#search-tabs). */
function PreviewPane({
	task,
	match,
	matches,
	locale,
}: {
	task: AgentTask | null;
	match: TextMatch | null;
	matches: TextMatch[];
	locale: Locale;
}) {
	const [preview, setPreview] = useState<Preview | null>(null),
		cache = useRef(new Map<string, Preview>()),
		body = useRef<HTMLDivElement>(null);
	useEffect(() => {
		if (!task || !match) {
			setPreview(null);
			return;
		}
		const hit = cache.current.get(match.fileId);
		if (hit) {
			setPreview(hit);
			return;
		}
		let active = true;
		void window.brigadir.peekFile(task, match.fileId).then(
			async (content) => {
				const text = content.state === 'text' ? content.text : null,
					language = syntaxLanguage(match.path);
				let tokens = new Map<number, SyntaxToken[]>();
				if (text !== null && language && text.length < 512 * 1024) {
					try {
						const syntax = await window.brigadir.readCodeSyntax(language, text);
						tokens = lineTokens(text, syntax.tokens);
					} catch {
						/* plain */
					}
				}
				const value = { fileId: match.fileId, text, tokens };
				cache.current.set(match.fileId, value);
				if (active) setPreview(value);
			},
			() => {
				if (active) setPreview({ fileId: match.fileId, text: null, tokens: new Map() });
			}
		);
		return () => {
			active = false;
		};
	}, [task?.id, match?.fileId]);
	const inFile = match ? matches.filter((item) => item.fileId === match.fileId) : [];
	const lines =
		preview?.fileId === match?.fileId && preview?.text != null ? preview.text.split('\n') : null;
	useEffect(() => {
		const node = body.current?.querySelector<HTMLElement>('[data-current]');
		if (node && body.current) {
			const box = body.current;
			box.scrollTop = Math.max(0, node.offsetTop - box.clientHeight / 3);
		}
	}, [lines, match?.line]);
	if (!match) return <div className={styles.preview} />;
	const dir = match.path.includes('/') ? match.path.slice(0, match.path.lastIndexOf('/')) : '';
	const hits = new Map(inFile.map((item) => [item.line, item]));
	const render = (text: string, line: number): ReactNode => {
		const hit = hits.get(line),
			tokens = preview?.tokens.get(line) ?? [];
		if (!hit)
			return syntaxSegments(text, tokens).map((part) => (
				<span key={part.from} className={part.kind ? `syntax-${part.kind}` : undefined}>
					{part.text}
				</span>
			));
		// The stored line may be clipped (400 chars); the marks are found again on the full line.
		const offset = text.indexOf(hit.text),
			ranges = offset < 0 ? [] : hit.ranges.map(([a, b]) => [a + offset, b + offset] as const);
		const out: ReactNode[] = [];
		let at = 0;
		for (const [from, to] of ranges) {
			out.push(
				...syntaxSegments(text.slice(at, from), []).map((part) => (
					<span key={`${at}-${part.from}`}>{part.text}</span>
				)),
				<mark key={`m${from}`}>{text.slice(from, to)}</mark>
			);
			at = to;
		}
		out.push(<span key="tail">{text.slice(at)}</span>);
		return out;
	};
	return (
		<div className={styles.preview}>
			<div className={styles.previewHead}>
				<Glyph name="search-file" size={13} />
				<b>{match.path.split('/').at(-1)}</b>
				<span className={styles.previewPath}>{dir}</span>
				{match.scope && match.scope !== '.' && <span className={styles.chip}>{match.scope}</span>}
				<span
					className={
						styles.previewWhere
					}>{`${t(locale, 'line')} ${match.line} · ${searchCount(locale, 'match', inFile.length)} ${t(locale, 'in the file')}`}</span>
			</div>
			<div ref={body} className={styles.source}>
				{lines === null ? (
					preview && preview.fileId === match.fileId ? (
						<p className={styles.empty}>{t(locale, 'The file could not be read.')}</p>
					) : (
						<SkeletonText lines={10} />
					)
				) : (
					lines.map((text, index) => {
						const line = index + 1;
						return (
							<div
								key={line}
								data-hit={hits.has(line) || undefined}
								data-current={line === match.line || undefined}>
								<span className={styles.gutter}>{line}</span>
								<span>{render(text, line)}</span>
							</div>
						);
					})
				)}
			</div>
		</div>
	);
}

/** Left: matches grouped by file; right: the preview (spec/search-menus-and-commands#search-tabs). */
export function SearchTextPane({
	task,
	list,
	current,
	matches,
	locale,
}: {
	task: AgentTask | null;
	list: ReactNode;
	current: TextMatch | null;
	matches: TextMatch[];
	locale: Locale;
}) {
	return (
		<div className={styles.split}>
			<div className={styles.left}>{list}</div>
			<PreviewPane task={task} match={current} matches={matches} locale={locale} />
		</div>
	);
}
