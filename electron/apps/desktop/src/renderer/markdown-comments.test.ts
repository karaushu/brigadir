import { expect, it } from 'vitest';
import { markdown, userMarkdown } from './markdown';

const render = (text: string) => markdown.render(text);

it('hides a block of comments, the managed-rules marker included, and keeps the text around it', () => {
	const html = render(
		[
			'# Rules',
			'',
			'<!-- acme-rules:start --> <!-- Managed by acme.fe-skills — do not edit inside this block. Regenerated on every npx github:acme/acme.fe-skills add --rule <name>. -->',
			'Use the shared button.',
			'<!-- acme-rules:end -->',
		].join('\n')
	);
	expect(html).toBe('<h1>Rules</h1>\n<p>Use the shared button.</p>\n');
	expect(html).not.toContain('name');
	expect(html).not.toContain('--&gt;');
});

it('hides an inline comment inside a paragraph', () => {
	expect(render('before <!-- hidden <b> --> after')).toBe('<p>before  after</p>\n');
	expect(render('**bold**<!-- x -->*em*')).toBe('<p><strong>bold</strong><em>em</em></p>\n');
});

it('hides a multi-line comment, as a block and inside a paragraph', () => {
	expect(render('One\n\n<!--\nfirst line\n<name>\n-->\n\nTwo')).toBe('<p>One</p>\n<p>Two</p>\n');
	expect(render('Text\n<!-- a\nb -->\nnext')).toBe('<p>Text</p>\n<p>next</p>\n');
	expect(render('a <!-- spans\ntwo lines --> b')).toBe('<p>a  b</p>\n');
	expect(render('- item\n  <!-- note -->\n- other')).not.toContain('note');
	expect(render('> quote\n> <!-- note -->')).not.toContain('note');
});

it('keeps a comment inside a code fence, an indented block and a code span as written', () => {
	expect(render('```html\n<!-- keep -->\n```')).toBe(
		'<pre><code class="language-html">&lt;!-- keep --&gt;\n</code></pre>\n'
	);
	expect(render('    <!-- indented -->')).toBe(
		'<pre><code>&lt;!-- indented --&gt;\n</code></pre>\n'
	);
	expect(render('use `<!-- x -->` here')).toBe('<p>use <code>&lt;!-- x --&gt;</code> here</p>\n');
});

it('leaves an unclosed comment as text and treats the short forms as comments', () => {
	expect(render('<!-- still typing')).toBe('<p>&lt;!-- still typing</p>\n');
	expect(render('a <!--> b <!---> c')).toBe('<p>a  b  c</p>\n');
});

it('hides comments in the person’s message too', () => {
	expect(userMarkdown.render('hi <!-- x -->\nthere')).toBe('<p>hi<br>\nthere</p>\n');
});
