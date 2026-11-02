import { describe, expect, it } from 'vitest';
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { runInNewContext } from 'node:vm';
import { shellCacheName, shellPlaceholder, versionServiceWorker } from './sw-version';

const source = () => readFile(resolve(__dirname, 'public/sw.js'), 'utf8');
describe('the service worker’s cache follows the build (spec/remote-access-and-mobile#outbox)', () => {
	it('names the cache after every file of the build', () => {
		const a = shellCacheName(['assets/app-1.js', 'index.html']);
		expect(a).toMatch(/^brigadir-shell-[0-9a-f]{12}$/);
		expect(shellCacheName(['index.html', 'assets/app-1.js'])).toBe(a);
		expect(shellCacheName(['assets/app-2.js', 'index.html'])).not.toBe(a);
	});
	it('puts the name into sw.js once, and refuses a worker without the placeholder', async () => {
		const sw = await source();
		const built = versionServiceWorker(sw, ['assets/app-1.js']);
		expect(built).toContain(`'${shellCacheName(['assets/app-1.js'])}'`);
		expect(built).not.toContain(shellPlaceholder);
		expect(() => versionServiceWorker(built, ['assets/app-1.js'])).toThrow(/exactly once/);
	});
	it('drops the caches of older builds when the new worker activates', async () => {
		const name = shellCacheName(['assets/app-2.js']);
		const caches = new Set(['brigadir-shell-1', 'brigadir-shell-0123456789ab', name]);
		const listeners = new Map<string, (event: unknown) => void>();
		let claimed = false;
		const self = {
			addEventListener: (type: string, listener: (event: unknown) => void) =>
				listeners.set(type, listener),
			skipWaiting: () => {},
			clients: { claim: async () => void (claimed = true) },
			location: { origin: 'https://studio.example.ts.net' },
			navigator: { language: 'uk' },
		};
		runInNewContext(versionServiceWorker(await source(), ['assets/app-2.js']), {
			self,
			caches: {
				keys: async () => [...caches],
				delete: async (key: string) => caches.delete(key),
			},
			URL,
		});
		let done: Promise<unknown> = Promise.resolve();
		listeners.get('activate')!({ waitUntil: (work: Promise<unknown>) => (done = work) });
		await done;
		expect([...caches]).toEqual([name]);
		expect(claimed).toBe(true);
	});
});
