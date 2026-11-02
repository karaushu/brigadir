import { describe, expect, it } from 'vitest';
import { newFileFolder, newFilePath } from './new-file';

describe('spec/editor#new-file new file path', () => {
	it('takes a path relative to the task root, nested folders included', () => {
		expect(newFilePath('src/new/Thing.ts')).toEqual({ ok: true, path: 'src/new/Thing.ts' });
		expect(newFilePath('  README.md ')).toEqual({ ok: true, path: 'README.md' });
	});
	it('drops ./ and doubled slashes', () => {
		expect(newFilePath('./src//a/./b.ts')).toEqual({ ok: true, path: 'src/a/b.ts' });
	});
	it('needs a name', () => {
		expect(newFilePath('')).toEqual({ ok: false, reason: 'empty' });
		expect(newFilePath('   ')).toEqual({ ok: false, reason: 'empty' });
		expect(newFilePath('src/')).toEqual({ ok: false, reason: 'empty' });
		expect(newFilePath('./')).toEqual({ ok: false, reason: 'empty' });
	});
	it('stays inside the task root', () => {
		expect(newFilePath('/etc/hosts')).toEqual({ ok: false, reason: 'outside' });
		expect(newFilePath('~/notes.md')).toEqual({ ok: false, reason: 'outside' });
		expect(newFilePath('../other/a.ts')).toEqual({ ok: false, reason: 'outside' });
		expect(newFilePath('src/../../a.ts')).toEqual({ ok: false, reason: 'outside' });
		expect(newFilePath('C:\\a.ts')).toEqual({ ok: false, reason: 'outside' });
	});
	it('never writes into .git or .brigadir', () => {
		expect(newFilePath('.git/config')).toEqual({ ok: false, reason: 'reserved' });
		expect(newFilePath('pkg/.brigadir/x')).toEqual({ ok: false, reason: 'reserved' });
		expect(newFilePath('.github/workflows/ci.yml')).toEqual({
			ok: true,
			path: '.github/workflows/ci.yml',
		});
	});
	it('prefills the folder of the active file or the selected folder', () => {
		expect(newFileFolder('src/app/main.ts')).toBe('src/app/');
		expect(newFileFolder('README.md')).toBe('');
		expect(newFileFolder('src/app', 'directory')).toBe('src/app/');
		expect(newFileFolder(null)).toBe('');
	});
});
