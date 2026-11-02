import { slashTrigger } from '@brigadir/core';
import { mentionTrigger } from './prompt-mentions';

/**
 * spec/composer#mention-menu, spec/composer#slash-menu: what the text around the caret asks the task composer to open. `to` ends the word the caret is in;
 * `start` — a `/` that is the message's first character, where the agent's built-in commands work too.
 */
export type ComposerTrigger = {
	kind: 'file' | 'command';
	from: number;
	to: number;
	query: string;
	start?: boolean;
};

/** `@` at the start of a word opens the file picker (spec/chat#collapse-rules); `/` at the start of a word opens the `/` menu (spec/composer#slash-menu). */
export function composerTrigger(text: string, caret: number): ComposerTrigger | null {
	const slash = slashTrigger(text, caret);
	if (slash) return { kind: 'command', ...slash };
	const before = text.slice(0, caret),
		rest = /^[^\s@]*/.exec(text.slice(caret))![0],
		to = caret + rest.length;
	const mention = mentionTrigger.exec(before.slice(before.lastIndexOf('\n') + 1));
	if (mention)
		return { kind: 'file', from: caret - mention[2]!.length - 1, to, query: mention[2]! };
	return null;
}

/** The text after a pick: the trigger word is replaced, and the caret lands after the insert. */
export function replaceTrigger(
	text: string,
	trigger: ComposerTrigger,
	insert: string
): { text: string; caret: number } {
	const head = text.slice(0, trigger.from);
	let tail = text.slice(trigger.to);
	// A picked file becomes a chip and an action runs: the word goes, and one space stays between the words around it.
	if (!insert && (!head || /\s$/.test(head)) && tail.startsWith(' ')) tail = tail.slice(1);
	const glue = insert && !/^\s/.test(tail) ? ' ' : '';
	return { text: head + insert + glue + tail, caret: head.length + insert.length + glue.length };
}
