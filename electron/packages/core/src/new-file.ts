/**
 * spec/editor#new-file: the path typed in «New file…», relative to the task's root. `./` and doubled slashes are dropped; a path that
 * leaves the root, names a folder only or goes through `.git` / `.brigadir` creates nothing.
 */
export type NewFilePath =
	{ ok: true; path: string } | { ok: false; reason: 'empty' | 'outside' | 'reserved' };
const reserved = new Set(['.git', '.brigadir']);
export function newFilePath(input: string): NewFilePath {
	const text = input.trim();
	if (!text || text.endsWith('/')) return { ok: false, reason: 'empty' };
	if (
		text.startsWith('/') ||
		text.startsWith('~') ||
		/^[a-zA-Z]:[\\/]/.test(text) ||
		text.includes('\0')
	)
		return { ok: false, reason: 'outside' };
	const parts = text.split(/\/+/).filter((part) => part && part !== '.');
	if (!parts.length) return { ok: false, reason: 'empty' };
	if (parts.some((part) => part === '..')) return { ok: false, reason: 'outside' };
	if (parts.some((part) => reserved.has(part))) return { ok: false, reason: 'reserved' };
	const path = parts.join('/');
	if (path.length > 4096 || parts.some((part) => part.length > 255))
		return { ok: false, reason: 'outside' };
	return { ok: true, path };
}
/** The field's first text: the folder of `path` (a file) or `path` itself (a folder), with its `/`; the root is empty. */
export function newFileFolder(path: string | null, kind: 'file' | 'directory' = 'file'): string {
	if (!path) return '';
	const clean = path.replace(/^\.\/+/, '').replace(/\/+$/, '');
	if (!clean) return '';
	const folder = kind === 'directory' ? clean : clean.split('/').slice(0, -1).join('/');
	return folder ? `${folder}/` : '';
}
