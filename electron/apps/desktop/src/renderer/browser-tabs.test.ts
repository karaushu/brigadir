import { describe, expect, it } from 'vitest';
import type { BrowserTabInfo } from '@brigadir/core';
import { browserTabName, displayAddress } from './browser-tabs';
const tab = (url: string, title = '') => ({ url, title }) as BrowserTabInfo;
// spec/task-window-workspace#tool-tab-look: a tab names its page's host; a tab without a page is «New page».
describe('browserTabName', () => {
	it('names a web page by its host', () => {
		expect(browserTabName(tab('http://localhost:5173/loyalty', 'Admin'), 'New page')).toBe(
			'localhost:5173'
		);
	});
	it('calls a blank page «New page», not about:blank', () => {
		expect(browserTabName(tab('about:blank', 'about:blank'), 'New page')).toBe('New page');
		expect(browserTabName(undefined, 'New page')).toBe('New page');
	});
	it('keeps a real title of a page without a web address, but not its address as a title', () => {
		expect(browserTabName(tab('', 'Docs'), 'New page')).toBe('Docs');
		expect(browserTabName(tab('data:text/html,x', 'data:text/html,x'), 'New page')).toBe(
			'New page'
		);
	});
});
// spec/task-window-workspace#tool-tab-look.1: the field at rest has no scheme; other addresses stay whole.
describe('displayAddress', () => {
	it('drops http:// and https://', () => {
		expect(displayAddress('http://localhost:5173/loyalty')).toBe('localhost:5173/loyalty');
		expect(displayAddress('https://staging.example.com/loyalty?tab=2#top')).toBe(
			'staging.example.com/loyalty?tab=2#top'
		);
	});
	it('drops the root slash of a bare host, not of a query', () => {
		expect(displayAddress('http://localhost:5174/')).toBe('localhost:5174');
		expect(displayAddress('http://localhost:5174/?a=1')).toBe('localhost:5174/?a=1');
	});
	it('keeps other schemes and plain text', () => {
		expect(displayAddress('file:///tmp/a.html')).toBe('file:///tmp/a.html');
		expect(displayAddress('')).toBe('');
		expect(displayAddress('localhost:3000')).toBe('localhost:3000');
	});
});
