import { sequenceDiff } from './index';

/** spec/chat-turns-plans-and-questions#plan-revisions: one block of a plan's Markdown, the unit the changes view marks. */
export type PlanBlock = {
	kind: 'heading' | 'paragraph' | 'item' | 'quote' | 'table' | 'code';
	/** Its Markdown, the leading indentation of a nested list item removed. */
	text: string;
	/** A nested list item's level, from 0. */
	depth: number;
	/** Source lines it takes. */
	lines: number;
};
export type PlanWord = { text: string; change: 'same' | 'added' | 'removed' };
export type PlanChange =
	| { change: 'same' | 'added' | 'removed'; block: PlanBlock }
	| { change: 'changed'; block: PlanBlock; before: PlanBlock; words: PlanWord[] };
export type PlanPart =
	| { kind: 'block'; item: PlanChange }
	/** A folded run: unchanged sections (`names`, `null` for the text before the first heading) or unchanged blocks in a changed section. */
	| {
			kind: 'fold';
			id: string;
			names: (string | null)[] | null;
			lines: number;
			items: PlanChange[];
	  };
export type PlanChangeView = {
	parts: PlanPart[];
	/** Changed non-empty lines, as the file diff counts them. */
	additions: number;
	deletions: number;
	/** Sections with a change. */
	sections: number;
	/** More than half of the lines changed: the card opens on the plan itself. */
	rewritten: boolean;
	/** Lines the view shows with every fold closed (a fold counts as one). */
	shownLines: number;
};

const itemLine = /^(\s*)([-*+]|\d+[.)])\s+/,
	fenceLine = /^\s*(```|~~~)/;
function startsBlock(line: string) {
	return (
		/^#{1,6}\s/.test(line) ||
		itemLine.test(line) ||
		fenceLine.test(line) ||
		/^\s*\|/.test(line) ||
		/^\s*>/.test(line)
	);
}
/** The plan's Markdown as blocks: a heading, a paragraph, a list item (with its continuation lines), a quote, a whole table, a whole code block. */
export function planBlocks(text: string): PlanBlock[] {
	const lines = text.replace(/\r\n?/g, '\n').split('\n'),
		out: PlanBlock[] = [];
	let i = 0;
	const push = (kind: PlanBlock['kind'], from: number, to: number, depth = 0, indent = 0) =>
		out.push({
			kind,
			text: lines
				.slice(from, to)
				.map((line) =>
					indent ? line.slice(Math.min(indent, line.length - line.trimStart().length)) : line
				)
				.join('\n')
				.trimEnd(),
			depth,
			lines: to - from,
		});
	while (i < lines.length) {
		const line = lines[i]!;
		if (!line.trim()) {
			i++;
			continue;
		}
		const start = i;
		const fence = fenceLine.exec(line);
		if (fence) {
			i++;
			while (i < lines.length && !lines[i]!.trimStart().startsWith(fence[1]!)) i++;
			push('code', start, Math.min(i + 1, lines.length));
			i++;
		} else if (/^\s*\|/.test(line)) {
			while (i < lines.length && /^\s*\|/.test(lines[i]!)) i++;
			push('table', start, i);
		} else if (/^#{1,6}\s/.test(line)) {
			push('heading', start, ++i);
		} else if (/^\s*>/.test(line)) {
			while (i < lines.length && /^\s*>/.test(lines[i]!)) i++;
			push('quote', start, i);
		} else if (itemLine.test(line)) {
			const indent = itemLine.exec(line)![1]!.replace(/\t/g, '  ').length;
			i++;
			while (i < lines.length && lines[i]!.trim() && !startsBlock(lines[i]!)) i++;
			push('item', start, i, Math.floor(indent / 2), indent);
		} else {
			i++;
			while (i < lines.length && lines[i]!.trim() && !startsBlock(lines[i]!)) i++;
			push('paragraph', start, i);
		}
	}
	return out;
}

const tokenPattern =
	/`[^`\n]*`|\[[^\]\n]*\]\([^)\n]*\)|\*\*[^*\n]+\*\*|\*[^*\n]+\*|[\p{L}\p{N}_]+|\s+|[^\s\p{L}\p{N}_]/gu;
/** Words of a block for the word diff; a code span, a link or an emphasis stays one token, so the marks never cut Markdown apart. */
export function planTokens(text: string): string[] {
	return text.match(tokenPattern) ?? [];
}
function words(text: string) {
	return text.toLowerCase().match(/[\p{L}\p{N}_]+/gu) ?? [];
}
/** Two blocks are one changed block when 60 % of the old words and 30 % of the new ones stay (spec/chat-turns-plans-and-questions#plan-revisions). */
export function samePlanBlock(before: PlanBlock, after: PlanBlock): boolean {
	if (before.kind !== after.kind || before.kind === 'table' || before.kind === 'code') return false;
	const a = words(before.text),
		b = words(after.text);
	if (!a.length || !b.length) return false;
	const kept = sequenceDiff(a, b, 10000).filter((edit) => edit.kind === 'context').length;
	return kept / a.length >= 0.6 && kept / b.length >= 0.3;
}
export function planWords(before: string, after: string): PlanWord[] {
	const out: PlanWord[] = [];
	for (const edit of sequenceDiff(planTokens(before), planTokens(after), 10000)) {
		const change = edit.kind === 'context' ? 'same' : edit.kind;
		const last = out.at(-1);
		if (last?.change === change) last.text += edit.value;
		else out.push({ text: edit.value, change });
	}
	return out;
}

const blockKey = (block: PlanBlock) => `${block.kind}\0${block.depth}\0${block.text}`;
/** Block by block, in the new text's order; a change run lists removed blocks before added ones, like the file diff. */
export function planChanges(before: string, after: string): PlanChange[] {
	const a = planBlocks(before),
		b = planBlocks(after);
	const edits = sequenceDiff(a.map(blockKey), b.map(blockKey), 250000, 1_000_000),
		out: PlanChange[] = [];
	let ai = 0,
		bi = 0,
		removed: PlanBlock[] = [],
		added: PlanBlock[] = [];
	const flush = () => {
		let left = removed,
			pending: PlanChange[] = [];
		for (const block of added) {
			const match = left.findIndex((old) => samePlanBlock(old, block));
			if (match < 0) {
				pending.push({ change: 'added', block });
				continue;
			}
			out.push(...left.slice(0, match).map((old) => ({ change: 'removed' as const, block: old })));
			out.push(...pending);
			pending = [];
			const old = left[match]!;
			out.push({ change: 'changed', block, before: old, words: planWords(old.text, block.text) });
			left = left.slice(match + 1);
		}
		out.push(...left.map((old) => ({ change: 'removed' as const, block: old })), ...pending);
		removed = [];
		added = [];
	};
	for (const edit of edits) {
		if (edit.kind === 'context') {
			flush();
			out.push({ change: 'same', block: b[bi]! });
			ai++;
			bi++;
		} else if (edit.kind === 'removed') removed.push(a[ai++]!);
		else added.push(b[bi++]!);
	}
	flush();
	return out;
}

function lineCounts(before: string, after: string) {
	const split = (text: string) => text.replace(/\r\n?/g, '\n').split('\n');
	let additions = 0,
		deletions = 0;
	for (const edit of sequenceDiff(split(before), split(after), 250000, 1_000_000)) {
		if (!edit.value.trim()) continue;
		if (edit.kind === 'added') additions++;
		else if (edit.kind === 'removed') deletions++;
	}
	const total = [before, after].reduce(
		(sum, text) => sum + split(text).filter((l) => l.trim()).length,
		0
	);
	return { additions, deletions, rewritten: total > 0 && (additions + deletions) / total > 0.5 };
}

/**
 * spec/chat-turns-plans-and-questions#plan-revisions: the changes view of a revision. The title always shows; a section (a heading to the next one) without a
 * change folds, a run of such sections being one fold; inside a changed section a run of more than two unchanged blocks between changes folds too.
 */
export function planChangeView(before: string, after: string): PlanChangeView {
	const items = planChanges(before, after),
		parts: PlanPart[] = [];
	let start = 0;
	if (items[0]?.block.kind === 'heading') {
		parts.push({ kind: 'block', item: items[0] });
		start = 1;
	}
	const sections: { name: string | null; items: PlanChange[] }[] = [];
	for (const item of items.slice(start)) {
		if (item.block.kind === 'heading' || !sections.length)
			sections.push({
				name: item.block.kind === 'heading' ? item.block.text.replace(/^#+\s*/, '') : null,
				items: [],
			});
		sections.at(-1)!.items.push(item);
	}
	let run: typeof sections = [],
		changedSections = 0;
	const lines = (list: PlanChange[]) => list.reduce((sum, item) => sum + item.block.lines, 0);
	const flush = () => {
		if (!run.length) return;
		parts.push({
			kind: 'fold',
			id: `s${parts.length}`,
			names: run.map((section) => section.name),
			lines: lines(run.flatMap((section) => section.items)),
			items: run.flatMap((section) => section.items),
		});
		run = [];
	};
	for (const section of sections) {
		if (section.items.every((item) => item.change === 'same')) {
			run.push(section);
			continue;
		}
		flush();
		changedSections++;
		const near = new Set<number>([0]);
		section.items.forEach((item, index) => {
			if (item.change !== 'same') [index - 1, index, index + 1].forEach((n) => near.add(n));
		});
		let skipped: PlanChange[] = [];
		const release = () => {
			if (skipped.length > 2)
				parts.push({
					kind: 'fold',
					id: `b${parts.length}`,
					names: null,
					lines: lines(skipped),
					items: skipped,
				});
			else parts.push(...skipped.map((item) => ({ kind: 'block' as const, item })));
			skipped = [];
		};
		section.items.forEach((item, index) => {
			if (!near.has(index)) {
				skipped.push(item);
				return;
			}
			release();
			parts.push({ kind: 'block', item });
		});
		release();
	}
	flush();
	const counts = lineCounts(before, after);
	return {
		parts,
		additions: counts.additions,
		deletions: counts.deletions,
		rewritten: counts.rewritten,
		sections: changedSections,
		shownLines: parts.reduce(
			(sum, part) => sum + (part.kind === 'fold' ? 1 : part.item.block.lines),
			0
		),
	};
}
