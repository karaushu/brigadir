import { spawn, type ChildProcess } from 'node:child_process';
import { access, constants } from 'node:fs/promises';
import { delimiter, join } from 'node:path';
import {
	clipLine,
	matchRanges,
	maskMatcher,
	parseGrepLine,
	textPattern,
	textSearchLimits,
	type TaskKey,
	type TextMatch,
	type TextSearchEvent,
	type TextSearchRequest,
} from '@brigadir/core';
import { loginShellPath } from './environment';

export type TextFiles = {
	root: string;
	entries: { id: string; path: string; scope: string }[];
	truncated: boolean;
};
export type TextEngine = { kind: 'rg' | 'git'; command: string };

/** spec/search-menus-and-commands#search-tabs: `rg` from the login shell's PATH or the usual Homebrew places; otherwise `git grep --no-index`. */
export async function findTextEngine(path?: string): Promise<TextEngine> {
	if (process.env.BRIGADIR_TEXT_ENGINE === 'git') return { kind: 'git', command: 'git' };
	const dirs = [
		...(path ?? (await loginShellPath().catch(() => process.env.PATH ?? ''))).split(delimiter),
		'/opt/homebrew/bin',
		'/usr/local/bin',
	].filter(Boolean);
	for (const dir of new Set(dirs)) {
		const candidate = join(dir, 'rg');
		try {
			await access(candidate, constants.X_OK);
			return { kind: 'rg', command: candidate };
		} catch {
			/* next */
		}
	}
	return { kind: 'git', command: 'git' };
}
/** The arguments for one batch of files, paths relative to the project root (`cwd`). */
export function engineArgs(
	engine: TextEngine,
	request: TextSearchRequest,
	files: readonly string[]
): string[] {
	if (engine.kind === 'rg')
		return [
			'--no-heading',
			'--with-filename',
			'--line-number',
			'--null',
			'--color',
			'never',
			'--no-config',
			'--no-ignore',
			'--hidden',
			'--max-count',
			String(textSearchLimits.perFile),
			...(request.caseSensitive ? ['--case-sensitive'] : ['--ignore-case']),
			...(request.wholeWord ? ['--word-regexp'] : []),
			...(request.regex ? [] : ['--fixed-strings']),
			'-e',
			request.query,
			'--',
			...files,
		];
	return [
		'-c',
		'core.quotePath=false',
		'--literal-pathspecs',
		'grep',
		'--no-index',
		'--no-color',
		'-n',
		'-I',
		'-z',
		'--max-count',
		String(textSearchLimits.perFile),
		...(request.caseSensitive ? [] : ['-i']),
		...(request.wholeWord ? ['-w'] : []),
		request.regex ? '-E' : '-F',
		'-e',
		request.query,
		'--',
		...files,
	];
}

type Run = { cancelled: boolean; children: Set<ChildProcess> };
/**
 * spec/search-menus-and-commands#search-tabs: Text runs over the Files index in batches of 200 in index order, two processes at a time, and sends each
 * batch as it finishes, in order — rows only ever append. A new search or `cancel` kills what is running.
 */
export class TextSearches {
	private runs = new Map<string, Run>();
	private engine: Promise<TextEngine> | null = null;
	constructor(
		private files: (key: TaskKey) => Promise<TextFiles>,
		private send: (event: TextSearchEvent) => void,
		private engineFor: () => Promise<TextEngine> = () => findTextEngine()
	) {}
	async repos(key: TaskKey) {
		const { entries } = await this.files(key);
		return [...new Set(entries.map((entry) => entry.scope).filter(Boolean))];
	}
	cancel(id: string) {
		const run = this.runs.get(id);
		if (!run) return;
		run.cancelled = true;
		for (const child of run.children) child.kill('SIGKILL');
		this.runs.delete(id);
	}
	cancelAll() {
		for (const id of [...this.runs.keys()]) this.cancel(id);
	}
	async start(key: TaskKey, request: TextSearchRequest, id: string) {
		this.cancelAll();
		const run: Run = { cancelled: false, children: new Set() };
		this.runs.set(id, run);
		const pattern = textPattern(request);
		if (!pattern) {
			this.send({
				id,
				matches: [],
				scanned: 0,
				total: 0,
				done: true,
				truncated: false,
				error: 'Invalid regular expression',
			});
			this.runs.delete(id);
			return;
		}
		try {
			const engine = await (this.engine ??= this.engineFor());
			const { root, entries } = await this.files(key);
			if (run.cancelled) return;
			const mask = maskMatcher(request.mask),
				candidates = entries.filter(
					(entry) => (request.repo === null || entry.scope === request.repo) && mask(entry.path)
				);
			const byPath = new Map(candidates.map((entry, index) => [entry.path, { ...entry, index }])),
				batches: (typeof candidates)[] = [];
			for (let i = 0; i < candidates.length; i += textSearchLimits.batch)
				batches.push(candidates.slice(i, i + textSearchLimits.batch));
			let scanned = 0,
				found = 0,
				truncated = false,
				next = 0,
				flushed = 0;
			const ready = new Map<number, TextMatch[]>();
			this.send({
				id,
				matches: [],
				scanned: 0,
				total: candidates.length,
				done: !batches.length,
				truncated: false,
				error: null,
			});
			const flush = () => {
				while (ready.has(flushed) && !run.cancelled) {
					let matches = ready.get(flushed)!;
					ready.delete(flushed);
					scanned += batches[flushed]!.length;
					flushed++;
					if (truncated) matches = [];
					else if (found + matches.length >= textSearchLimits.matches) {
						matches = matches.slice(0, textSearchLimits.matches - found);
						truncated = true;
					}
					found += matches.length;
					this.send({
						id,
						matches,
						scanned,
						total: candidates.length,
						done: flushed === batches.length || truncated,
						truncated,
						error: null,
					});
					if (truncated) {
						this.cancel(id);
						return;
					}
				}
			};
			const worker = async () => {
				while (next < batches.length && !run.cancelled && !truncated) {
					const index = next++,
						batch = batches[index]!;
					const lines = await this.grep(
						engine,
						root,
						request,
						batch.map((entry) => entry.path),
						run
					);
					if (run.cancelled) return;
					const matches: TextMatch[] = [];
					for (const line of lines) {
						const hit = parseGrepLine(line),
							entry = hit && byPath.get(hit.path);
						if (!hit || !entry) continue;
						const ranges = matchRanges(hit.text, pattern);
						if (!ranges.length) continue;
						const clipped = clipLine(hit.text, ranges);
						matches.push({
							fileId: entry.id,
							path: entry.path,
							scope: entry.scope,
							line: hit.line,
							column: ranges[0]![0] + 1,
							text: clipped.text,
							ranges: clipped.ranges,
						});
					}
					// git grep prints in its own order: keep the index order, then the line order.
					matches.sort(
						(a, b) => byPath.get(a.path)!.index - byPath.get(b.path)!.index || a.line - b.line
					);
					ready.set(index, matches);
					flush();
				}
			};
			await Promise.all([worker(), worker()]);
		} catch (error) {
			if (!run.cancelled)
				this.send({
					id,
					matches: [],
					scanned: 0,
					total: 0,
					done: true,
					truncated: false,
					error: error instanceof Error ? error.message : String(error),
				});
		} finally {
			if (this.runs.get(id) === run) this.runs.delete(id);
		}
	}
	private grep(
		engine: TextEngine,
		root: string,
		request: TextSearchRequest,
		files: string[],
		run: Run
	): Promise<string[]> {
		return new Promise((resolve, reject) => {
			const child = spawn(engine.command, engineArgs(engine, request, files), {
				cwd: root,
				stdio: ['ignore', 'pipe', 'pipe'],
			});
			run.children.add(child);
			let out = '',
				err = '';
			child.stdout.setEncoding('utf8');
			child.stderr.setEncoding('utf8');
			child.stdout.on('data', (chunk: string) => {
				out += chunk;
			});
			child.stderr.on('data', (chunk: string) => {
				if (err.length < 4000) err += chunk;
			});
			child.on('error', reject);
			// Exit 1 is «no match» for both engines; 2 with output means some file could not be read, the rest is good.
			child.on('close', (code) => {
				run.children.delete(child);
				if (run.cancelled) return resolve([]);
				if (code === 0 || code === 1 || (code === 2 && out))
					return resolve(out.split('\n').filter(Boolean));
				reject(new Error(err.trim().split('\n')[0] || `${engine.kind} exited ${code}`));
			});
		});
	}
}
