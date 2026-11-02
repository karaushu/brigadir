import { useMemo } from 'react';
import {
	slashIndex,
	slashKinds,
	slashWords,
	t,
	type Locale,
	type MessageKey,
	type SlashEntry,
	type SlashKind,
} from '@brigadir/core';
import type { FindCommands } from './mention-editor';
import type { MentionMenuItem } from './ui/MentionMenu';
import type { MentionGroup } from './ui/mention-tabs';

/** spec/composer#slash-menu: the group captions of the `/` menu; the menu's future tabs take the same names (spec/composer#mentions). */
export const slashGroups: Record<SlashKind, MessageKey> = {
	command: 'Slash commands',
	skill: 'Skills',
	tool: 'MCP tools',
	action: 'Actions',
};
/** Rows of the shared mention menu: the inserted text in mono, the description as the tail, the full text in `title`. */
export function slashMenuItems(entries: readonly SlashEntry[], locale: Locale): MentionMenuItem[] {
	return entries.map((entry) => {
		const tail = entry.server ? t(locale, 'MCP server') : entry.description;
		return {
			key: entry.key,
			group: t(locale, slashGroups[entry.kind]),
			label: entry.label,
			mono: entry.kind !== 'action',
			...(tail ? { tail } : {}),
			title: [entry.kind === 'action' ? '' : entry.insert, entry.description, entry.inputHint]
				.filter(Boolean)
				.join('\n'),
		};
	});
}

/**
 * spec/composer#mentions: the `/` menu's groups become the menu's tabs, `All` first, in the order of spec/composer#slash-menu. A kind is a tab while
 * the list has it at all (the tabs do not jump while typing); `matched` fills it. With nothing to list, one group carries `status`.
 */
export function slashMenuGroups(
	all: readonly SlashEntry[],
	matched: readonly SlashEntry[],
	locale: Locale,
	status: string | null = null
): MentionGroup[] {
	const kinds = slashKinds.filter((kind) => all.some((entry) => entry.kind === kind));
	if (!kinds.length)
		return [{ id: 'command', label: t(locale, 'Slash commands'), items: [], status }];
	return kinds.map((kind, index) => ({
		id: kind,
		label: t(locale, slashGroups[kind]),
		items: slashMenuItems(
			matched.filter((entry) => entry.kind === kind),
			locale
		).map(({ group: _group, ...item }) => item),
		...(index === 0 ? { status } : {}),
	}));
}

const kindNames: Record<SlashKind, MessageKey> = {
	command: 'slash command (kind)',
	skill: 'skill (kind)',
	tool: 'MCP tool (kind)',
	action: 'Actions',
};
/** spec/composer#slash-highlight: the hint over a known name in the text — the name and its kind, the menu's description, and where a built-in works. */
export function slashWordTitle(entry: SlashEntry, locale: Locale): string {
	return [
		`${entry.insert} · ${t(locale, entry.server ? 'MCP server' : kindNames[entry.kind])}`,
		entry.description,
		entry.anywhere ? '' : t(locale, 'Works only as the first word of the message.'),
	]
		.filter(Boolean)
		.join('\n');
}
/**
 * spec/composer#slash-highlight: the known names of a line of text, for the editor's marks and the log; `key` changes only when the list does, so a list
 * that arrives late (the disk, then the agent) marks the text already typed.
 */
export function useSlashWords(
	entries: readonly SlashEntry[],
	locale: Locale
): { commands: FindCommands; key: string } {
	const key = entries
		.map((entry) => `${entry.insert}:${entry.anywhere ? 1 : 0}:${entry.kind}`)
		.join(' ');
	return useMemo(() => {
		const index = slashIndex(entries);
		return {
			key: `${key}|${locale}`,
			commands: (line, start) =>
				slashWords(line, index, start).map((found) => ({
					from: found.from,
					to: found.to,
					title: slashWordTitle(found.entry, locale),
				})),
		};
	}, [key, locale]);
}
