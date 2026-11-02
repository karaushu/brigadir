import { appendFile, mkdir, readFile, stat, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';
import type { RendererErrorReport } from '@brigadir/core';
const trimAt = 512 * 1024,
	keepLines = 200;
/**
 * spec/architecture-and-platform#crash-recovery: every boundary error, chunk reload and lost renderer process leaves a line in `logs/renderer.jsonl`
 * and in main's stderr. A console log may be a temporary file, so the reason must outlive a restart.
 */
export class RendererLog {
	private chain = Promise.resolve();
	constructor(
		private readonly file: () => Promise<string>,
		private readonly build = process.env.BRIGADIR_BUILD ?? 'out',
		private readonly now = () => new Date()
	) {}
	report(report: RendererErrorReport) {
		this.write({
			build: this.build,
			componentStack: report.componentStack,
			kind: report.kind,
			message: report.message,
			stack: report.stack,
			surface: report.surface,
			time: this.now().toISOString(),
		});
	}
	processGone(reason: string, exitCode: number) {
		this.write({
			build: this.build,
			exitCode,
			kind: 'process-gone',
			message: reason,
			time: this.now().toISOString(),
		});
	}
	/** Resolves when every line written so far is on disk (tests). */
	flushed() {
		return this.chain;
	}
	private write(entry: Record<string, unknown>) {
		console.error(
			`[renderer] ${String(entry.kind)} ${String(entry.surface ?? '')} ${String(entry.message)}`.replace(
				/\s+/g,
				' '
			)
		);
		this.chain = this.chain
			.then(async () => {
				const file = await this.file();
				await mkdir(dirname(file), { recursive: true });
				await appendFile(file, `${JSON.stringify(entry)}\n`);
				if ((await stat(file)).size > trimAt) {
					const lines = (await readFile(file, 'utf8')).split('\n').filter(Boolean);
					await writeFile(file, `${lines.slice(-keepLines).join('\n')}\n`);
				}
			})
			.catch((error) => {
				console.error('[renderer] the log could not be written', error);
			});
	}
}
/** spec/architecture-and-platform#crash-recovery: a lost renderer reloads on its own once; the second loss within a minute asks the person. */
export class RendererRestarts {
	private losses: number[] = [];
	constructor(private readonly now = () => Date.now()) {}
	next(): 'reload' | 'ask' {
		const time = this.now();
		this.losses = this.losses.filter((loss) => time - loss < 60_000);
		this.losses.push(time);
		return this.losses.length > 1 ? 'ask' : 'reload';
	}
}
