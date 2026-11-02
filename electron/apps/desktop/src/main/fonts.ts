import { execFile, spawn, type ChildProcess } from 'node:child_process';
import { isRecord, type FontCatalog, type FontFamily } from '@brigadir/core';
/** The box-drawing characters the CoreText helper checks (fonts.m), as a fontconfig charset pattern. */
export const boxDrawingPattern = ':charset=2500 2502 2514 2518 251c';
/**
 * spec/architecture-and-platform#linux-package: the Linux catalog from fontconfig. `faces` — `fc-list --format '%{family[0]}\t%{spacing}\n'`, one line
 * per face, spacing 100 (mono) or 90 (dual width, CJK monospace) marks a fixed-pitch family; `box` — the families of
 * `fc-list --format '%{family[0]}\n' <boxDrawingPattern>`. Hidden (`.`) and over-long names are left out, as on macOS.
 */
export function fontconfigCatalog(faces: string, box: string): FontCatalog {
	const families = new Map<string, FontFamily>();
	const boxed = new Set(box.split('\n').map((line) => line.trim()));
	for (const line of faces.split('\n')) {
		const [name = '', spacing = ''] = line.split('\t');
		const family = name.trim();
		if (!family || family.startsWith('.') || family.length > 200 || /[\x00-\x1f]/.test(family))
			continue;
		// Colour emoji fonts declare spacing 100 too, but nobody writes code in them.
		const mono = (spacing.trim() === '100' || spacing.trim() === '90') && !/emoji/i.test(family);
		const known = families.get(family);
		if (known) known.mono ||= mono;
		else families.set(family, { family, mono, boxDrawing: boxed.has(family) });
	}
	return {
		fonts: [...families.values()]
			.sort((a, b) => a.family.localeCompare(b.family, undefined, { sensitivity: 'base' }))
			.slice(0, 10000),
	};
}
type Read = (file: string, args: string[]) => Promise<string>;
const read: Read = (file, args) =>
	new Promise((resolve, reject) =>
		execFile(file, args, { timeout: 5000, maxBuffer: 16 << 20 }, (error, stdout) =>
			error ? reject(error) : resolve(stdout)
		)
	);
export class Fonts {
	private child: ChildProcess | undefined;
	private catalog: FontCatalog | null = null;
	private starting: Promise<void> | undefined;
	constructor(
		private executable: string,
		private changed: () => void,
		private platform: NodeJS.Platform = process.platform,
		private run: Read = read
	) {}
	read() {
		return this.catalog;
	}
	start() {
		if (this.catalog) return Promise.resolve();
		return (this.starting ??= this.begin().finally(() => {
			this.starting = undefined;
		}));
	}
	private async begin() {
		if (this.platform === 'linux') return this.fontconfig();
		if (this.platform !== 'darwin') return;
		await new Promise<void>((resolve) => {
			let buffer = '',
				settled = false;
			const done = () => {
				if (!settled) {
					settled = true;
					clearTimeout(timer);
					resolve();
				}
			};
			const timer = setTimeout(() => {
				this.stop();
				done();
			}, 5000);
			// stdin stays open and unused: the helper exits on its EOF, so it never outlives a killed app.
			const child = spawn(this.executable, ['--watch'], { stdio: ['pipe', 'pipe', 'ignore'] });
			this.child = child;
			child.stdout!.setEncoding('utf8');
			child.stdout!.on('data', (chunk: string) => {
				buffer += chunk;
				if (buffer.length > 1024 * 1024) {
					this.stop();
					done();
					return;
				}
				let end: number;
				while ((end = buffer.indexOf('\n')) >= 0) {
					const line = buffer.slice(0, end);
					buffer = buffer.slice(end + 1);
					try {
						const value: unknown = JSON.parse(line);
						if (
							!isRecord(value) ||
							!Array.isArray(value.fonts) ||
							value.fonts.length > 10000 ||
							!value.fonts.every(
								(font) =>
									isRecord(font) &&
									typeof font.family === 'string' &&
									font.family.length <= 200 &&
									typeof font.mono === 'boolean' &&
									typeof font.boxDrawing === 'boolean'
							)
						)
							throw Error('Invalid font catalog');
						this.catalog = value as FontCatalog;
						done();
						this.changed();
					} catch {
						this.stop();
						done();
					}
				}
			});
			child.on('error', done);
			child.on('exit', () => {
				if (this.child === child) {
					this.child = undefined;
					this.catalog = null;
					this.changed();
				}
				done();
			});
		});
	}
	/** Linux reads the catalog once; fonts installed later show after a restart (spec/architecture-and-platform#linux-package). */
	private async fontconfig() {
		try {
			const [faces, box] = await Promise.all([
				this.run('fc-list', ['--format', '%{family[0]}\t%{spacing}\n']),
				this.run('fc-list', ['--format', '%{family[0]}\n', boxDrawingPattern]),
			]);
			this.catalog = fontconfigCatalog(faces, box);
			this.changed();
		} catch {
			/* No fontconfig: the pickers offer the system font only. */
		}
	}
	stop() {
		const child = this.child;
		this.child = undefined;
		child?.kill();
	}
}
