/** The pure part of the chat's link handling (links.ts): what a link names, and which of the task's files it is. */
/** The path a file link names: no `./`, no `#L12` or `:12:3` position, no query; null when the link is not a file. */
export function linkPath(href: string): string | null {
	const value = href.trim();
	if (!value || value.startsWith('#') || value.startsWith('//')) return null;
	if (/^[a-z][a-z0-9+.-]*:/i.test(value) && !/^file:/i.test(value)) return null;
	let path = value.replace(/^file:\/\//i, '');
	try {
		path = decodeURI(path);
	} catch {
		return null;
	}
	path = path
		.replace(/[?#].*$/, '')
		.replace(/(:\d+){1,2}$/, '')
		.replace(/^(\.\/)+/, '');
	return path && !path.endsWith('/') ? path : null;
}
/** The entry of the task's files the path names: the same path, else the longest one at its end (an absolute path). */
export function matchFile<T extends { path: string; kind: string }>(
	path: string,
	entries: readonly T[]
): T | null {
	const clean = path.replace(/^\/+/, '');
	const found = entries.filter(
		(entry) =>
			entry.kind === 'file' &&
			(entry.path === clean || clean.endsWith(`/${entry.path}`) || entry.path.endsWith(`/${clean}`))
	);
	return (
		found.find((entry) => entry.path === clean) ??
		found.sort((a, b) => b.path.length - a.path.length)[0] ??
		null
	);
}
