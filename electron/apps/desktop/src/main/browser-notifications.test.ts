import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { BrowserNotificationSites, pageNotice } from './browser-notifications';

describe('spec/browser-and-simulator#notifications the project’s notification sites', () => {
	it('keeps the person’s decisions by domain and forgets one on «Ask»', async () => {
		const root = await mkdtemp(join(tmpdir(), 'brigadir-notification-sites-'));
		try {
			const data = join(root, 'data'),
				file = join(data, 'projects', 'p1', 'browser-notifications.json');
			const sites = new BrowserNotificationSites(data);
			expect(await sites.of('p1')).toEqual({});
			await sites.set('p1', 'stage.example.com', 'granted');
			await sites.set('p1', 'ads.example.com', 'denied');
			expect(JSON.parse(await readFile(file, 'utf8'))).toEqual({
				schemaVersion: 1,
				sites: { 'stage.example.com': 'granted', 'ads.example.com': 'denied' },
			});
			await sites.set('p1', 'ads.example.com', 'default');
			expect(sites.loaded.get('p1')).toEqual({ 'stage.example.com': 'granted' });
			// Another run reads the file; a broken one asks again instead of stopping the browser.
			expect(await new BrowserNotificationSites(data).of('p1')).toEqual({
				'stage.example.com': 'granted',
			});
			await mkdir(join(data, 'projects', 'p2'), { recursive: true });
			await writeFile(
				join(data, 'projects', 'p2', 'browser-notifications.json'),
				JSON.stringify({ schemaVersion: 1, sites: { x: 'maybe' } })
			);
			expect(await new BrowserNotificationSites(data).of('p2')).toEqual({});
		} finally {
			await rm(root, { recursive: true, force: true });
		}
	});
	it('checks and cuts what the page reports of a notification', () => {
		expect(pageNotice({ id: 2, title: 't'.repeat(300), body: 'b', tag: '' })).toEqual({
			id: 2,
			title: 't'.repeat(200),
			body: 'b',
			tag: '',
		});
		expect(pageNotice({ id: 0, title: 't', body: '', tag: '' })).toBeNull();
		expect(pageNotice({ id: 1, title: 5, body: '', tag: '' })).toBeNull();
	});
});
