import { expect, it } from 'vitest';
import { externalLink, githubRepository, pullRequestLink } from './external-links';
// spec/pull-requests-and-ci#pr-links: a PR page of GitHub is the only http link the app may open itself.
const prBase = 'https://github.com/Acme/shop-app/pull/1062';
it('reads the repository, number and tab of a PR page and its tails', () => {
	expect(pullRequestLink(prBase)).toEqual({
		repository: 'acme/shop-app',
		number: 1062,
		tab: 'comments',
	});
	for (const tail of [
		'/',
		'#discussion_r123',
		'#issuecomment-9',
		'?notification_referrer_id=x#issuecomment-9',
	])
		expect(pullRequestLink(prBase + tail)?.tab).toBe('comments');
	expect(pullRequestLink(`${prBase}/files`)?.tab).toBe('files');
	expect(pullRequestLink(`${prBase}/files#diff-abc`)?.tab).toBe('files');
	expect(pullRequestLink(`${prBase}/commits`)?.tab).toBe('commits');
	expect(pullRequestLink(`${prBase}/commits/a82e7d4`)?.tab).toBe('commits');
	expect(pullRequestLink(`${prBase}/checks`)?.tab).toBe('checks');
	expect(pullRequestLink('https://www.github.com/o/r/pull/7')?.number).toBe(7);
});
it('leaves every other address to the system browser', () => {
	for (const url of [
		'https://github.com/o/r/pull/0',
		'https://github.com/o/r/pull/abc',
		'https://github.com/o/r/pulls',
		'https://github.com/o/r/issues/5',
		'https://github.com/o/r/pull/5/reviews',
		'https://github.com/o/r/pull/5x',
		'https://gitlab.com/o/r/pull/5',
		'https://github.com.evil.test/o/r/pull/5',
		'https://user@github.com/o/r/pull/5',
		'http://github.com/o/r/pull/5',
		'https://github.com/o/pull/5',
		'https://github.com/o/r/pull/1234567890',
		'mailto:a@b.com',
		42,
		null,
	])
		expect(pullRequestLink(url)).toBeNull();
});
it('names a repository from a web address or a git remote', () => {
	for (const remote of [
		'https://github.com/Acme/Repo.git',
		'git@github.com:acme/repo.git',
		'ssh://git@github.com/acme/repo',
		'https://github.com/acme/repo/',
	])
		expect(githubRepository(remote)).toBe('acme/repo');
	for (const remote of [
		'/tmp/remotes/repo.git',
		'https://gitlab.com/o/r.git',
		'git@gitlab.com:o/r.git',
		'',
	])
		expect(githubRepository(remote)).toBeNull();
});
it('lets http(s) to a host and mailto through as they are', () => {
	expect(externalLink('https://github.com/acme/shop-app/pull/1062')).toBe(
		'https://github.com/acme/shop-app/pull/1062'
	);
	expect(externalLink('http://localhost:5173')).toBe('http://localhost:5173');
	expect(externalLink('http://[::1]:8080/a')).toBe('http://[::1]:8080/a');
	expect(externalLink('https://a.com?q=1#x')).toBe('https://a.com?q=1#x');
	expect(externalLink('https://xn--80ak6aa92e.com/%D0%B0')).toBe(
		'https://xn--80ak6aa92e.com/%D0%B0'
	);
	expect(externalLink('HTTPS://Example.COM/Path')).toBe('HTTPS://Example.COM/Path');
	expect(externalLink('mailto:team@example.com')).toBe('mailto:team@example.com');
});
it('refuses every other scheme, credentials, whitespace and relative paths', () => {
	for (const value of [
		'javascript:alert(1)',
		'JavaScript:alert(1)',
		'file:///etc/hosts',
		'data:text/html,x',
		'vbscript:x',
		'ftp://x.com/a',
		'//evil.com/a',
		'docs/rules/pr-conventions.md',
		'src/foo.ts:42',
		'package-lock.json',
		'#anchor',
		'https://user:pass@example.com/',
		'https://github.com@evil.com/',
		'https:///path',
		'https://a.com/a b',
		'https://a.com/\nx',
		'https://a.com\\@evil.com',
		'mailto:',
		'mailto:nobody',
		'mailto:a@b.com/x',
		'https://a.com:123456/',
		'https://-a.com/',
		'',
		null,
		42,
		`https://a.com/${'x'.repeat(9000)}`,
	])
		expect(externalLink(value), String(value)).toBeNull();
});
it('tells a local page (spec/browser-and-simulator#browser) from the rest of the web', async () => {
	const { localLink, isLocalHost } = await import('./external-links');
	for (const value of [
		'http://localhost:3000',
		'http://localhost:3000/',
		'https://localhost/a?b#c',
		'http://LOCALHOST:5173/x',
		'http://127.0.0.1:8080/',
		'http://[::1]:4000/',
		'http://app.localhost:3000/',
		'http://localhost',
	])
		expect(localLink(value), value).toBe(value);
	for (const value of [
		'https://github.com/a/b/pull/1',
		'http://localhost.evil.com/',
		'http://127.0.0.2/',
		'http://10.0.0.1:3000/',
		'http://192.168.1.14:6006/',
		'http://user:pass@localhost:3000/',
		'mailto:me@localhost',
		'file:///localhost',
		'javascript:localhost',
		null,
	])
		expect(localLink(value), String(value)).toBeNull();
	expect(isLocalHost('Localhost')).toBe(true);
	expect(isLocalHost('notlocalhost')).toBe(false);
});
