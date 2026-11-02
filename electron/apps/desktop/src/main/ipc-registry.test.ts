import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { expect, it } from 'vitest';
import { ipcInvokeRows, ipcSubscribeRows } from '@brigadir/core';
// spec/architecture-and-platform#ipc-boundary, spec/remote-access-and-mobile#architecture: main registers exactly the table's invoke channels, sends only its events, and the preload
// names no channel of its own.
const source = (path: string) => readFileSync(join(__dirname, path), 'utf8');
const main = source('index.ts');
const registered = [...main.matchAll(/\b(?:handle|handleClient|registerRead)\(\s*'([^']+)'/g)].map(
	(m) => m[1]!
);
it('registers every invoke channel of the table once, and nothing else', () => {
	expect(registered.length).toBe(new Set(registered).size);
	for (const channel of registered) expect(ipcInvokeRows.has(channel), channel).toBe(true);
	expect(new Set(registered)).toEqual(new Set(ipcInvokeRows.keys()));
	expect(main).not.toMatch(/ipcMain\.(?:handle|on)\(\s*'/);
});
it('sends events only through the client set, on channels of the table', () => {
	expect(main).not.toMatch(/webContents\.send\(/);
	const sent = [...main.matchAll(/clients\.broadcast\(\s*'([^']+)'/g)].map((m) => m[1]!);
	expect(sent.length).toBeGreaterThan(20);
	for (const channel of sent) expect(ipcSubscribeRows.has(channel), channel).toBe(true);
});
it('builds the preload from the table without channels of its own', () => {
	const preload = source('../preload/index.ts');
	expect(preload).toContain('createDesktopBridge(');
	expect(preload).not.toMatch(/ipcRenderer\.invoke\(\s*'/);
	expect(preload).not.toMatch(/ipcRenderer\.on\(\s*'/);
});
