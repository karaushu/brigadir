import { EditorSelection, EditorState, type TransactionSpec } from '@codemirror/state';
import { describe, expect, it } from 'vitest';
import {
	bulletGlyphsToMarkdown,
	continueBlock,
	htmlListToMarkdown,
	indentItem,
	inListLine,
	insideFence,
	outdentItem,
	parseBlock,
	pasteAsMarkdown,
	toggleLink,
	toggleWrap,
} from './composer-format';

/** A document with `|` for the caret, or `[a|b]` style ranges as `«…»`; the host applies what the command dispatches. */
function open(source: string) {
	const from = source.indexOf('«'),
		to = source.indexOf('»');
	const text = from >= 0 ? source.replace('«', '').replace('»', '') : source.replace('|', '');
	const caret = from >= 0 ? undefined : source.indexOf('|');
	const host = {
		state: EditorState.create({
			doc: text,
			selection: from >= 0 ? EditorSelection.range(from, to - 1) : EditorSelection.cursor(caret!),
		}),
		dispatch(spec: TransactionSpec) {
			host.state = host.state.update(spec).state;
		},
	};
	return host;
}
function show(host: { state: EditorState }) {
	const range = host.state.selection.main,
		text = host.state.doc.toString();
	return range.empty
		? `${text.slice(0, range.head)}|${text.slice(range.head)}`
		: `${text.slice(0, range.from)}«${text.slice(range.from, range.to)}»${text.slice(range.to)}`;
}
const run = (source: string, command: (host: ReturnType<typeof open>) => boolean) => {
	const host = open(source);
	const handled = command(host);
	return { handled, out: show(host), host };
};

describe('Markdown block lines (spec/composer#formatting)', () => {
	it('knows the four block markers and nothing else', () => {
		expect(parseBlock('- a')?.kind).toBe('bullet');
		expect(parseBlock('  * a')).toMatchObject({ kind: 'bullet', indent: 2, bullet: '*' });
		expect(parseBlock('12. a')).toMatchObject({ kind: 'ordered', number: 12, marker: '12. ' });
		expect(parseBlock('- [x] a')).toMatchObject({ kind: 'task', done: true });
		expect(parseBlock('> a')?.kind).toBe('quote');
		expect(parseBlock('-a')).toBeNull();
		expect(parseBlock('--- ')).toBeNull();
		expect(parseBlock('1.a')).toBeNull();
		expect(parseBlock('plain')).toBeNull();
	});
	it('tells whether the caret is on a list item outside a code block', () => {
		expect(inListLine(open('- a|').state)).toBe(true);
		expect(inListLine(open('> a|').state)).toBe(false);
		expect(inListLine(open('text|').state)).toBe(false);
		expect(inListLine(open('```\n- a|\n```').state)).toBe(false);
		expect(insideFence(open('```\nx\n```\ny').state.doc, 4)).toBe(false);
	});
});

describe('⇧↩ continues a block', () => {
	it('keeps the marker of a bullet', () => {
		expect(run('- a|', continueBlock).out).toBe('- a\n- |');
		expect(run('* a|', continueBlock).out).toBe('* a\n* |');
	});
	it('counts an ordered list on and renumbers the items after it', () => {
		expect(run('1. a|', continueBlock).out).toBe('1. a\n2. |');
		expect(run('1. a|\n2. b\n3. c', continueBlock).out).toBe('1. a\n2. |\n3. b\n4. c');
	});
	it('renumbers only the level the item is in', () => {
		expect(run('1. a|\n   - x\n2. b', continueBlock).out).toBe('1. a\n2. |\n   - x\n3. b');
		expect(run('1. a\n   1. b|\n   2. c\n2. d', continueBlock).out).toBe(
			'1. a\n   1. b\n   2. |\n   3. c\n2. d'
		);
	});
	it('starts an unticked task and keeps a quote', () => {
		expect(run('- [x] a|', continueBlock).out).toBe('- [x] a\n- [ ] |');
		expect(run('> a|', continueBlock).out).toBe('> a\n> |');
	});
	it('keeps the indent of a nested item', () => {
		expect(run('- a\n  - b|', continueBlock).out).toBe('- a\n  - b\n  - |');
	});
	it('moves the text after the caret to the new item', () => {
		expect(run('- ab|cd', continueBlock).out).toBe('- ab\n- |cd');
	});
	it('is a plain line break outside a block, inside a marker and with a range selected', () => {
		expect(run('text|', continueBlock).handled).toBe(false);
		expect(run('-| a', continueBlock).handled).toBe(false);
		expect(run('«- a»', continueBlock).handled).toBe(false);
	});
	it('leaves the list on an empty item: the marker goes, a nested item first goes up', () => {
		expect(run('- a\n- |', continueBlock).out).toBe('- a\n|');
		expect(run('1. a\n2. |', continueBlock).out).toBe('1. a\n|');
		expect(run('> a\n> |', continueBlock).out).toBe('> a\n|');
		expect(run('- a\n  - |', continueBlock).out).toBe('- a\n- |');
		expect(run('- a\n  - b\n    - |', continueBlock).out).toBe('- a\n  - b\n  - |');
		expect(run('- [ ] |', continueBlock).out).toBe('|');
	});
	it('numbers an item that leaves a nested level after its parent level', () => {
		expect(run('1. a\n2. b\n   1. |\n3. c', continueBlock).out).toBe('1. a\n2. b\n3. |\n4. c');
	});
	it('adds no marker in a code block and keeps its indent', () => {
		expect(run('```\n  - a|\n```', continueBlock).out).toBe('```\n  - a\n  |\n```');
		expect(run('- a\n```js\n  x|', continueBlock).out).toBe('- a\n```js\n  x\n  |');
		expect(run('```js|', continueBlock).out).toBe('```js\n|');
	});
});

describe('Tab and ⇧Tab move an item one level', () => {
	it('nests under the item before it, by the width of its marker', () => {
		expect(run('- a\n- b|', indentItem).out).toBe('- a\n  - b|');
		expect(run('1. a\n- b|', indentItem).out).toBe('1. a\n   - b|');
	});
	it('starts a nested ordered list at 1 and renumbers the level it left', () => {
		expect(run('1. a\n2. b|\n3. c', indentItem).out).toBe('1. a\n   1. b|\n2. c');
	});
	it('joins the children the item before it already has', () => {
		expect(run('- a\n  - x\n- b|', indentItem).out).toBe('- a\n  - x\n  - b|');
		expect(run('1. a\n   1. x\n2. b|', indentItem).out).toBe('1. a\n   1. x\n   2. b|');
	});
	it('takes the items under it along', () => {
		expect(run('- a\n- b|\n  - c', indentItem).out).toBe('- a\n  - b|\n    - c');
	});
	it('does not go deeper than a child of the item before it, nor at the first item', () => {
		expect(run('- a\n  - b|', indentItem)).toMatchObject({ handled: true, out: '- a\n  - b|' });
		expect(run('- a|', indentItem)).toMatchObject({ handled: true, out: '- a|' });
	});
	it('goes up to the parent level and numbers the item after its parent', () => {
		expect(run('- a\n  - b|', outdentItem).out).toBe('- a\n- b|');
		expect(run('1. a\n   1. b|\n   2. c\n2. d', outdentItem).out).toBe(
			'1. a\n2. b|\n   1. c\n3. d'
		);
		expect(run('- a|', outdentItem)).toMatchObject({ handled: true, out: '- a|' });
	});
	it('is not the keys of anything but a list item', () => {
		expect(run('text|', indentItem).handled).toBe(false);
		expect(run('> a|', outdentItem).handled).toBe(false);
		expect(run('```\n- a|\n```', indentItem).handled).toBe(false);
	});
});

describe('⌘B ⌘I ⌘E wrap and unwrap', () => {
	const bold = (host: ReturnType<typeof open>) => toggleWrap(host, 'bold');
	const italic = (host: ReturnType<typeof open>) => toggleWrap(host, 'italic');
	const code = (host: ReturnType<typeof open>) => toggleWrap(host, 'code');
	it('wraps the selection and keeps it on the text', () => {
		expect(run('a «word» b', bold).out).toBe('a **«word»** b');
		expect(run('a «word» b', italic).out).toBe('a *«word»* b');
		expect(run('a «word» b', code).out).toBe('a `«word»` b');
	});
	it('puts a pair with the caret between when nothing is selected', () => {
		expect(run('a |', bold).out).toBe('a **|**');
		expect(run('|', code).out).toBe('`|`');
	});
	it('takes the mark off a wrapped selection, around it, or around the caret', () => {
		expect(run('a «**word**» b', bold).out).toBe('a «word» b');
		expect(run('a **«word»** b', bold).out).toBe('a «word» b');
		expect(run('a **wo|rd** b', bold).out).toBe('a wo|rd b');
		expect(run('a **|**', bold).out).toBe('a |');
		expect(run('a `x|y`', code).out).toBe('a x|y');
	});
	it('does not take italic off bold, and bold is not italic', () => {
		expect(run('**«word»**', italic).out).toBe('***«word»***');
		expect(run('*a «b» c*', bold).out).toBe('*a **«b»** c*');
		expect(run('*wo|rd*', italic).out).toBe('wo|rd');
	});
	it('only unwraps the span the caret is in', () => {
		expect(run('**a** and **b|**', bold).out).toBe('**a** and b|');
	});
});

describe('⌘K makes a link', () => {
	it('wraps the selection and leaves the caret in the address', () => {
		expect(run('see «docs» now', toggleLink).out).toBe('see [docs](|) now');
	});
	it('starts an empty link with the caret in its text', () => {
		expect(run('see |', toggleLink).out).toBe('see [|]()');
	});
	it('takes a link back to its text', () => {
		expect(run('see [do|cs](https://a.b) now', toggleLink).out).toBe('see do|cs now');
		expect(run('see «[docs](https://a.b)» now', toggleLink).out).toBe('see «docs» now');
	});
});

describe('paste', () => {
	it('turns the bullet glyphs of Slack, Notion and Pages into items', () => {
		expect(bulletGlyphsToMarkdown('• a\n• b')).toBe('- a\n- b');
		expect(bulletGlyphsToMarkdown('• a\n◦ b\n▪ c\n• d')).toBe('- a\n  - b\n    - c\n- d');
		expect(bulletGlyphsToMarkdown('• a\n\t• b')).toBe('- a\n  - b');
		expect(bulletGlyphsToMarkdown('intro\n• a')).toBe('intro\n- a');
		expect(bulletGlyphsToMarkdown('plain\ntext')).toBeNull();
		expect(bulletGlyphsToMarkdown('•no space')).toBeNull();
	});
	it('turns an HTML list into items, nested and numbered', () => {
		expect(htmlListToMarkdown('<ul><li>a</li><li>b<ul><li>c &amp; d</li></ul></li></ul>')).toBe(
			'- a\n- b\n  - c & d'
		);
		expect(htmlListToMarkdown('<ol><li><p>one</p></li><li>two<ul><li>x</li></ul></li></ol>')).toBe(
			'1. one\n2. two\n   - x'
		);
		expect(htmlListToMarkdown('<p>intro</p><ul><li>a</li></ul>')).toBe('intro\n- a');
		expect(htmlListToMarkdown('<p>no list</p>')).toBeNull();
	});
	it('picks one conversion and leaves other text to the browser', () => {
		expect(pasteAsMarkdown('• a\n• b', '', '')).toBe('- a\n- b');
		expect(pasteAsMarkdown('a\nb', '<ul><li>a</li><li>b</li></ul>', '')).toBe('- a\n- b');
		// Plain text that already has Markdown markers is what the person copied.
		expect(pasteAsMarkdown('- a\n- b', '<ul><li>a</li><li>b</li></ul>', '')).toBeNull();
		expect(pasteAsMarkdown('hello world', '<p>hello world</p>', '')).toBeNull();
	});
	it('an address pasted over a selected word makes a link', () => {
		expect(pasteAsMarkdown('https://kit.dev/focus ', '', 'docs')).toBe(
			'[docs](https://kit.dev/focus)'
		);
		expect(pasteAsMarkdown('https://kit.dev/focus', '', '')).toBeNull();
		expect(pasteAsMarkdown('https://kit.dev/focus', '', 'two\nlines')).toBeNull();
		expect(pasteAsMarkdown('not an address', '', 'docs')).toBeNull();
	});
});
