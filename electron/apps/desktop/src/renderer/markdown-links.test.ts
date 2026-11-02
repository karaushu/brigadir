import { expect, it } from 'vitest';
import { markdown } from './markdown';
const render = (text: string) => markdown.render(text);
const links = (text: string) =>
	[...render(text).matchAll(/<a href="([^"]*)"[^>]*>(.*?)<\/a>/g)].map((match) => ({
		href: match[1],
		text: match[2],
	}));
const pr = 'https://github.com/acme/shop-app/pull/1062';
it('turns a bare http(s) URL into a link with the address as its hint', () => {
	expect(links(`opened a draft PR into staging: ${pr}`)).toEqual([{ href: pr, text: pr }]);
	expect(render(`see ${pr}`)).toContain(`title="${pr}"`);
	expect(links('dev server on http://localhost:5173/ now')).toEqual([
		{ href: 'http://localhost:5173/', text: 'http://localhost:5173/' },
	]);
});
it('leaves the sentence punctuation and the closing bracket outside the link', () => {
	expect(links(`PR: ${pr}.`)).toEqual([{ href: pr, text: pr }]);
	expect(render(`PR: ${pr}.`)).toContain('</a>.</p>');
	expect(links(`(see ${pr})`)).toEqual([{ href: pr, text: pr }]);
	expect(render(`(see ${pr})`)).toContain('</a>)</p>');
	expect(links('read https://en.wikipedia.org/wiki/Foo_(bar), then go')).toEqual([
		{
			href: 'https://en.wikipedia.org/wiki/Foo_(bar)',
			text: 'https://en.wikipedia.org/wiki/Foo_(bar)',
		},
	]);
	expect(links(`**${pr}**`)).toEqual([{ href: pr, text: pr }]);
});
it('keeps paths, path:line and file names as text for the editor links', () => {
	for (const text of [
		'docs/rules/pr-conventions.md',
		'package-lock.json',
		'src/foo.ts',
		'src/foo.ts:42',
		'README.md:3:7',
		'scripts/run.sh',
		'main.rs',
		'www.example.com',
		'localhost:3000',
		'team@example.com',
		'2.23.1',
	])
		expect(links(`Changed ${text} today.`), text).toEqual([]);
});
it('does not link inside inline code or fenced blocks', () => {
	expect(links('run `https://example.com/in-code` here')).toEqual([]);
	expect(links('```sh\ncurl https://example.com/in-fence\n```')).toEqual([]);
});
it('keeps explicit Markdown links and drops unsafe schemes to text', () => {
	expect(links(`[the PR](${pr}) and <https://auto.link>`)).toEqual([
		{ href: pr, text: 'the PR' },
		{ href: 'https://auto.link', text: 'https://auto.link' },
	]);
	for (const text of [
		'[x](javascript:alert(1))',
		'[x](file:///etc/hosts)',
		'[x](data:text/html,y)',
		'javascript:alert(1)',
		'file:///etc/hosts',
		'ftp://x.com/a',
		'//evil.com/a',
	])
		expect(links(text), text).toEqual([]);
	expect(links('mailto:team@example.com')).toEqual([
		{ href: 'mailto:team@example.com', text: 'mailto:team@example.com' },
	]);
});
// What an answer's code blocks become before the log adds its header.
it('escapes HTML in fences, keeps fences nested in quotes and lists, and never loads an image', () => {
	const html = render(
		'```typescript\nexport const count = 1;\n```\n\n> ```js\n> const markup = "<img src=x onerror=alert(1)>";\n> ```\n\n' +
			'- Nested example\n\n  ```python\n  def greet():\n      return "hello"\n  ```\n\n```unknown\n<raw> stays literal\n```\n\n' +
			'![remote](https://example.invalid/never-load.png)'
	);
	expect(html.match(/<pre>/g)).toHaveLength(4);
	expect(html).toMatch(
		/<blockquote>\s*<pre><code class="language-js">const markup = &quot;&lt;img src=x/
	);
	expect(html).toMatch(/<li>[\s\S]*<pre><code class="language-python">def greet\(\):/);
	expect(html).toContain('<code class="language-unknown">&lt;raw&gt; stays literal\n</code>');
	expect(html).not.toContain('<img');
	expect(html).not.toContain('<raw>');
	expect(html).not.toContain('example.invalid');
});
