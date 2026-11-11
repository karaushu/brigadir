import { useMemo, useState, type ReactNode } from 'react';
import {
	planLinesLabel,
	planSectionsLabel,
	planUnchangedLabel,
	t,
	type AgentTask,
	type Locale,
} from '@brigadir/core';
import type { PlanChange, PlanChangeView } from '@brigadir/diff';
import { MarkdownBlock, markdown, type MarkdownTokens } from './MarkdownBlock';
import { ChangeCounts } from './ui/ChangeCounts';
import { DiffFold } from './ui/DiffCode';
import { Segments } from './ui/Controls';
import styles from './PlanChanges.module.css';

// Private-use marks around changed words: they pass through markdown-it untouched and become <ins> / <del> after it.
const INS = '',
	INS_END = '',
	DEL = '',
	DEL_END = '';
const noTokens = [] as unknown as MarkdownTokens;

/** One block's markup: its Markdown rendered alone, changed words marked, inside a frame that carries the change. */
export function planBlockHtml(item: PlanChange) {
	const source =
		item.change === 'changed'
			? item.words
					.map((word) =>
						word.change === 'same'
							? word.text
							: !word.text.trim()
								? word.change === 'added'
									? word.text
									: ''
								: word.change === 'added'
									? `${word.text.match(/^\s*/)![0]}${INS}${word.text.trim()}${INS_END}${word.text.match(/\s*$/)![0]}`
									: `${DEL}${word.text.trim()}${DEL_END}`
					)
					.join('')
			: item.block.text;
	const html = markdown
		.render(source)
		.replaceAll(INS, '<ins>')
		.replaceAll(INS_END, '</ins>')
		.replaceAll(DEL, '<del>')
		.replaceAll(DEL_END, '</del>');
	const depth = item.block.depth ? ` style="padding-left: ${item.block.depth * 20}px"` : '';
	return `<div class="${styles.block}" data-change="${item.change}" data-kind="${item.block.kind}"${depth}>${html}</div>`;
}

/**
 * spec/chat-turns-plans-and-questions#plan-revisions: the plan's Markdown with what changed since its base — added blocks green, removed ones red and
 * struck through, a changed block with its words marked; unchanged sections and runs fold into `DiffFold` bands that open in place.
 */
export function PlanChanges({
	id,
	view,
	task,
	locale,
	revision,
	folded,
}: {
	id: string;
	view: PlanChangeView;
	task: AgentTask;
	locale: Locale;
	revision: number;
	folded: boolean;
}) {
	const [opened, setOpened] = useState<ReadonlySet<string>>(new Set());
	const runs = useMemo(() => {
		const out: (
			| { kind: 'html'; html: string }
			| { kind: 'fold'; id: string; label: string; lines: number; sections: boolean }
		)[] = [];
		const add = (html: string) => {
			const last = out.at(-1);
			if (last?.kind === 'html') last.html += html;
			else out.push({ kind: 'html', html });
		};
		for (const part of view.parts) {
			if (part.kind === 'block') add(planBlockHtml(part.item));
			else if (opened.has(part.id)) part.items.forEach((item) => add(planBlockHtml(item)));
			else {
				const names = part.names?.map((name) => name ?? t(locale, 'Introduction'));
				out.push({
					kind: 'fold',
					id: part.id,
					label: names
						? `${names.length <= 2 ? names.join(', ') : planSectionsLabel(locale, names.length)} · ${t(locale, 'unchanged')}`
						: planUnchangedLabel(locale, part.items.length),
					lines: part.lines,
					sections: !!names,
				});
			}
		}
		return out;
	}, [view, opened, locale]);
	return (
		<div className={styles.body} data-folded={folded} data-plan-changes>
			{runs.map((run, index) =>
				run.kind === 'html' ? (
					<MarkdownBlock
						key={index}
						rowId={`${id}-${index}`}
						html={run.html}
						tokens={noTokens}
						locale={locale}
						task={task}
						revision={revision}
						className={styles.changes}
					/>
				) : (
					<DiffFold
						key={run.id}
						data-plan-fold={run.id}
						onClick={() => setOpened((set) => new Set(set).add(run.id))}>
						<span className={styles.foldName}>{run.label}</span>
						{run.sections && (
							<span className={styles.foldLines}>{planLinesLabel(locale, run.lines)}</span>
						)}
					</DiffFold>
				)
			)}
		</div>
	);
}

/** spec/chat-turns-plans-and-questions#plan-revisions: the bar over a revision — `Changes · Plan`, what it is compared with, `Rewritten`, `+N −M`. */
export function PlanRevisionBar({
	view,
	base,
	mode,
	locale,
	onMode,
	tag,
}: {
	view: PlanChangeView;
	base: { revision: number; edited: boolean };
	mode: 'changes' | 'plan';
	locale: Locale;
	onMode(mode: 'changes' | 'plan'): void;
	tag?: ReactNode;
}) {
	const since = base.edited
		? t(locale, 'since your edits')
		: t(
				locale,
				view.rewritten
					? 'most lines changed since revision {n}'
					: view.additions + view.deletions
						? 'since revision {n}'
						: 'no changes since revision {n}'
			).replace('{n}', String(base.revision));
	return (
		<div className={styles.bar} data-size="s" data-plan-revision-bar>
			<Segments
				label={t(locale, 'Show the changes or the plan')}
				value={mode}
				onChange={(value) => onMode(value as 'changes' | 'plan')}
				options={[
					{ value: 'changes', label: t(locale, 'Changes') },
					{ value: 'plan', label: t(locale, 'Plan') },
				]}
				optionAttribute="plan-view"
			/>
			{view.rewritten && tag}
			<span className={styles.since}>{since}</span>
			<span className={styles.space} />
			<ChangeCounts
				additions={view.additions}
				deletions={view.deletions}
				locale={locale}
				tone="diff"
			/>
		</div>
	);
}

/** The words under a folded changes view: `All changes · N sections` / `Collapse changes`. */
export function allChangesLabel(locale: Locale, sections: number, whole: boolean) {
	return whole
		? t(locale, 'Collapse changes')
		: t(locale, 'All changes · {n}').replace('{n}', planSectionsLabel(locale, sections));
}
