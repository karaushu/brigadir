const http =
	/^https?:\/\/([a-z0-9](?:[a-z0-9.-]*[a-z0-9])?|\[[0-9a-f:.]+\])(?::[0-9]{1,5})?(?:[/?#].*)?$/i;
/**
 * spec/chat#web-links: the only links a click hands to the system — `http(s)` to a named host (no credentials: nothing may hide
 * the real host behind `user@`), or `mailto:` an address. The renderer asks before it calls `links:open`, and main
 * asks again. Returns the address to open, or null for anything else (`javascript:`, `file:`, `data:`, a relative path).
 */
export function externalLink(value: unknown): string | null {
	if (typeof value !== 'string' || value.length > 8192 || /[\x00-\x20\x7f\\]/.test(value))
		return null;
	if (http.test(value)) return value;
	if (/^mailto:[^/?#@]+@[^/?#@]+(?:\?.*)?$/i.test(value)) return value;
	return null;
}
/** spec/browser-and-simulator#browser: a page on this machine — the dev server's address; the agent's browser opens these without asking. */
export function isLocalHost(hostname: string): boolean {
	const host = hostname.toLowerCase();
	return (
		host === 'localhost' || host === '127.0.0.1' || host === '[::1]' || host.endsWith('.localhost')
	);
}
/** spec/chat#web-links: an `http(s)` link to a local host goes to the task's own browser (spec/browser-and-simulator#browser), not the system one. */
export function localLink(value: unknown): string | null {
	const link = externalLink(value),
		host = link ? http.exec(link)?.[1] : undefined;
	return link && host && isLocalHost(host) ? link : null;
}
/** spec/pull-requests-and-ci#pr-links: the repository a GitHub web address or git remote points at, `owner/repo` in lower case; null for any other host. */
export function githubRepository(value: string): string | null {
	const match =
		/^(?:https?:\/\/(?:www\.)?github\.com\/|ssh:\/\/git@github\.com\/|git@github\.com:)([A-Za-z0-9_.-]+)\/([A-Za-z0-9_.-]+?)(?:\.git)?(?:[/?#].*)?$/i.exec(
			value.trim()
		);
	return match ? `${match[1]}/${match[2]}`.toLowerCase() : null;
}
export type PullRequestLink = {
	repository: string;
	number: number;
	tab: 'comments' | 'files' | 'commits' | 'checks';
};
/**
 * spec/pull-requests-and-ci#pr-links: `https://github.com/<owner>/<repo>/pull/<N>` with the tails of the GitHub PR page (`/files`, `/commits[/sha]`,
 * `/checks`, `#discussion_r…`, `#issuecomment-…`); `tab` says which PR tab the link names. Anything else (issues, Actions,
 * `/pull/N/anything-else`, another host, credentials) is null: those stay system-browser links.
 */
export function pullRequestLink(value: unknown): PullRequestLink | null {
	const link = externalLink(value);
	if (!link) return null;
	const match =
		/^https:\/\/(?:www\.)?github\.com\/([A-Za-z0-9_.-]+)\/([A-Za-z0-9_.-]+)\/pull\/([1-9][0-9]{0,8})(?:\/(files|commits|checks)(?:\/[0-9a-f]{4,40})?)?\/?(?:[?#].*)?$/i.exec(
			link
		);
	if (!match) return null;
	const tab = match[4]?.toLowerCase() as 'files' | 'commits' | 'checks' | undefined;
	return {
		repository: `${match[1]}/${match[2]}`.toLowerCase(),
		number: Number(match[3]),
		tab: tab ?? 'comments',
	};
}
