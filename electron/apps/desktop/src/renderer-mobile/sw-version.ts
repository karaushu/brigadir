/**
 * spec/remote-access-and-mobile#outbox: the service worker's cache is named after the build, so a new version installs a new worker (its bytes
 * changed) whose `activate` drops the caches of older builds — the `/assets/` of past versions do not pile up on the phone.
 * The name is a hash of every file the build wrote: their names carry content hashes, so any change to the app changes it.
 * `vite.mobile.config.ts` applies it to `out/renderer-mobile/sw.js`; the source keeps the placeholder.
 */
import { createHash } from 'node:crypto';

export const shellPlaceholder = 'brigadir-shell-build';
export function shellCacheName(files: readonly string[]): string {
	const hash = createHash('sha256')
		.update([...files].sort().join('\n'))
		.digest('hex')
		.slice(0, 12);
	return `brigadir-shell-${hash}`;
}
/** `sw.js` with the build's cache name; throws when the placeholder is gone (the worker would keep one name forever). */
export function versionServiceWorker(source: string, files: readonly string[]): string {
	const quoted = `'${shellPlaceholder}'`;
	if (source.split(quoted).length !== 2)
		throw new Error(`sw.js must name its cache ${quoted} exactly once`);
	return source.replace(quoted, `'${shellCacheName(files)}'`);
}
