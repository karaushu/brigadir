import { useEffect, useMemo, useState } from 'react';
import { moreLinesCount, syntaxLanguage, type Locale, type SyntaxToken } from '@brigadir/core';
import { lineTokens, SyntaxText } from '../syntax';
import { quoteLines } from '../code-selection';
import styles from './ReviewControls.module.css';
// One parse per quoted text: a card scrolled back into view or a draft re-rendered on every key paints at once.
const parsed = new Map<string, Promise<SyntaxToken[]>>();
function tokens(language: string, text: string) {
	const key = `${language}\0${text}`;
	let found = parsed.get(key);
	if (!found) {
		found = window.brigadir.readCodeSyntax(language, text).then(
			(result) => result.tokens,
			() => []
		);
		parsed.set(key, found);
		if (parsed.size > 200) parsed.delete(parsed.keys().next().value!);
	}
	return found;
}
/**
 * spec/appearance#evolution-redesign: the selected code a comment or a draft quotes — monospace, coloured like the file, its first three lines
 * without their shared indent, then `+N lines`.
 */
export function CodeQuote({
	text,
	path,
	locale,
	className = '',
}: {
	text: string;
	path: string;
	locale: Locale;
	/** Placement only (margins in the host card), never the look. */
	className?: string | undefined;
}) {
	const { lines, more } = useMemo(() => quoteLines(text), [text]);
	const shown = lines.join('\n'),
		language = syntaxLanguage(path);
	const [colours, setColours] = useState<Map<number, SyntaxToken[]> | null>(null);
	useEffect(() => {
		let active = true;
		setColours(null);
		if (language && shown.trim())
			void tokens(language, shown).then((list) => {
				if (active) setColours(lineTokens(shown, list));
			});
		return () => {
			active = false;
		};
	}, [language, shown]);
	if (!shown.trim()) return null;
	return (
		<blockquote className={`${styles.quote} ${className}`} data-code-quote>
			{lines.map((line, index) => (
				<div key={index}>
					<SyntaxText text={line} tokens={colours?.get(index + 1) ?? []} />
				</div>
			))}
			{more > 0 && <small>{moreLinesCount(locale, more)}</small>}
		</blockquote>
	);
}
