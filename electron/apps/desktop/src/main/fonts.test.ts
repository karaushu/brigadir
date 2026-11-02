import { it, expect, vi } from 'vitest';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { existsSync } from 'node:fs';
import { boxDrawingPattern, fontconfigCatalog, Fonts } from './fonts';
it.skipIf(process.platform !== 'darwin')(
	'shares startup, receives catalog updates and stops its helper',
	async () => {
		const root = await mkdtemp(join(tmpdir(), 'brigadir-font-watch-')),
			script = join(root, 'helper');
		await writeFile(
			script,
			`#!${process.execPath}\nprocess.stdout.write(JSON.stringify({fonts:[{family:'Fixture mono',mono:true,boxDrawing:true}]})+'\\n');setTimeout(()=>process.stdout.write(JSON.stringify({fonts:[{family:'Second mono',mono:true,boxDrawing:false}]})+'\\n'),100);setInterval(()=>{},1000);`,
			{ mode: 0o700 }
		);
		const changed = vi.fn(),
			fonts = new Fonts(script, changed);
		try {
			await Promise.all([fonts.start(), fonts.start()]);
			expect(fonts.read()?.fonts[0]?.family).toBe('Fixture mono');
			await vi.waitFor(() =>
				expect(fonts.read()?.fonts[0]).toEqual({
					family: 'Second mono',
					mono: true,
					boxDrawing: false,
				})
			);
			expect(changed).toHaveBeenCalledTimes(2);
		} finally {
			fonts.stop();
			await rm(root, { recursive: true, force: true });
		}
	}
);
it.skipIf(process.platform !== 'darwin')(
	'handles an unavailable helper without inventing a catalog',
	async () => {
		const fonts = new Fonts('/does-not-exist/brigadir-font-helper', () => {});
		await fonts.start();
		expect(fonts.read()).toBeNull();
		fonts.stop();
	}
);
// spec/architecture-and-platform#linux-package: the Linux catalog comes from fontconfig.
it('reads the Linux catalog from fc-list: families, fixed pitch and box drawing', () => {
	const faces = [
		'DejaVu Sans\t',
		'DejaVu Sans\t',
		'DejaVu Sans Mono\t100',
		'JetBrains Mono\t100',
		'Noto Sans Mono CJK JP\t90',
		'Noto Color Emoji\t100',
		'.Hidden\t100',
		'cantarell\t',
		'',
	].join('\n');
	const box = ['DejaVu Sans Mono', 'DejaVu Sans', ''].join('\n');
	expect(fontconfigCatalog(faces, box).fonts).toEqual([
		{ family: 'cantarell', mono: false, boxDrawing: false },
		{ family: 'DejaVu Sans', mono: false, boxDrawing: true },
		{ family: 'DejaVu Sans Mono', mono: true, boxDrawing: true },
		{ family: 'JetBrains Mono', mono: true, boxDrawing: false },
		{ family: 'Noto Color Emoji', mono: false, boxDrawing: false },
		{ family: 'Noto Sans Mono CJK JP', mono: true, boxDrawing: false },
	]);
});
it('starts the Linux catalog with two fc-list calls and keeps the system font when fontconfig is missing', async () => {
	const calls: string[][] = [];
	const changed = vi.fn();
	const fonts = new Fonts('/nonexistent', changed, 'linux', async (file, args) => {
		calls.push([file, ...args]);
		return args.includes(boxDrawingPattern) ? 'Fira Code\n' : 'Fira Code\t100\nInter\t\n';
	});
	await fonts.start();
	expect(fonts.read()).toEqual({
		fonts: [
			{ family: 'Fira Code', mono: true, boxDrawing: true },
			{ family: 'Inter', mono: false, boxDrawing: false },
		],
	});
	expect(changed).toHaveBeenCalledTimes(1);
	expect(calls).toEqual([
		['fc-list', '--format', '%{family[0]}\t%{spacing}\n'],
		['fc-list', '--format', '%{family[0]}\n', ':charset=2500 2502 2514 2518 251c'],
	]);
	const missing = new Fonts('/nonexistent', changed, 'linux', async () => {
		throw new Error('spawn fc-list ENOENT');
	});
	await missing.start();
	expect(missing.read()).toBeNull();
});
it.skipIf(!existsSync('/opt/homebrew/bin/fc-list') && !existsSync('/usr/bin/fc-list'))(
	'reads a real fontconfig catalog',
	async () => {
		const fonts = new Fonts('/nonexistent', () => {}, 'linux');
		await fonts.start();
		const catalog = fonts.read();
		expect(catalog?.fonts.length).toBeGreaterThan(0);
		expect(catalog?.fonts.some((font) => font.mono)).toBe(true);
		expect(catalog?.fonts.some((font) => font.family.startsWith('.'))).toBe(false);
	}
);
