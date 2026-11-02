import { spawn, type ChildProcess } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { dirname, join, relative, sep } from 'node:path';
import type { ProjectIndent } from '@brigadir/core';
import { RpcConnection } from './rpc';
/** spec/editor-code-intelligence#format-on-save: the project's Prettier only; the app bundles none, so versions and defaults match the project's CI. */
export type PrettierFormat =
	| { status: 'formatted'; text: string }
	| { status: 'ignored' | 'unsupported' }
	| { status: 'syntax'; line?: number }
	| { status: 'timeout' | 'crashed' };
export type PrettierInfo = { version: string | null; ignored: boolean; parser: string | null };
export type PrettierLimits = { start: number; request: number; idle: number };
export const prettierLimits: PrettierLimits = { start: 10000, request: 3000, idle: 10 * 60000 };
const inside = (root: string, path: string) => {
	const rest = relative(root, path);
	return rest === '' || (!rest.startsWith('..') && !rest.startsWith(sep));
};
/** Walks from the file's directory up to the project root. */
function* upward(file: string, projectRoot: string) {
	for (
		let directory = dirname(file);
		inside(projectRoot, directory);
		directory = dirname(directory)
	) {
		yield directory;
		if (directory === projectRoot || dirname(directory) === directory) return;
	}
}
/** Nearest `node_modules/prettier` upward from the file, like `projectTsserver` (spec/editor-code-intelligence#server-processes). */
export function findPrettier(
	file: string,
	projectRoot: string
): { directory: string; version: string | null } | null {
	for (const directory of upward(file, projectRoot)) {
		const candidate = join(directory, 'node_modules/prettier');
		if (existsSync(join(candidate, 'package.json')))
			return { directory: candidate, version: prettierVersion(candidate) };
	}
	return null;
}
export function prettierVersion(directory: string) {
	try {
		const value = JSON.parse(readFileSync(join(directory, 'package.json'), 'utf8')) as {
			version?: unknown;
		};
		return typeof value.version === 'string' ? value.version.slice(0, 40) : null;
	} catch {
		return null;
	}
}
/**
 * The `.prettierignore` nearest to the file within its own git root: in a monorepo of several repositories a parent's
 * ignore file (e.g. `apps/*`) is not the rule of the nested repository the file belongs to.
 */
export function prettierIgnore(file: string, projectRoot: string) {
	for (const directory of upward(file, projectRoot)) {
		const candidate = join(directory, '.prettierignore');
		if (existsSync(candidate)) return candidate;
		if (existsSync(join(directory, '.git'))) return null;
	}
	return null;
}
type Worker = { child: ChildProcess; connection: RpcConnection; lastUsed: number; fresh: boolean };
/** One worker per Prettier directory, started on first use and stopped after the idle limit. */
export class PrettierPool {
	private workers = new Map<string, Worker>();
	private timer: ReturnType<typeof setInterval>;
	constructor(
		private worker: string,
		private node: string,
		private limits: PrettierLimits = prettierLimits
	) {
		this.timer = setInterval(() => this.sweep(), 60000);
		this.timer.unref?.();
	}
	private start(directory: string): Worker {
		const existing = this.workers.get(directory);
		if (existing && !existing.connection.isClosed) return existing;
		// cwd is the package root holding node_modules, where Prettier looks for plugins named in the config.
		const child = spawn(this.node, [this.worker, directory], {
			cwd: dirname(dirname(directory)),
			stdio: ['pipe', 'pipe', 'ignore'],
			env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' },
		});
		const connection = new RpcConnection(child.stdout!, child.stdin!);
		child.stdin!.on('error', () => {});
		child.once('error', () => connection.close(new Error('Prettier failed to start')));
		child.once('exit', () => {
			connection.close(new Error('Prettier exited'));
			if (this.workers.get(directory)?.child === child) this.workers.delete(directory);
		});
		const worker = { child, connection, lastUsed: Date.now(), fresh: true };
		this.workers.set(directory, worker);
		return worker;
	}
	private async call<T>(directory: string, method: string, params: unknown): Promise<T> {
		const worker = this.start(directory);
		worker.lastUsed = Date.now();
		// The first request pays for starting Node and loading Prettier.
		const timeout = worker.fresh ? this.limits.start : this.limits.request;
		try {
			return await worker.connection.request<T>(method, params, timeout);
		} finally {
			worker.fresh = false;
		}
	}
	async info(
		directory: string,
		file: string,
		ignorePath: string | null
	): Promise<PrettierInfo | null> {
		try {
			return await this.call<PrettierInfo>(directory, 'info', { file, ignorePath });
		} catch {
			return null;
		}
	}
	/** spec/editor#indentation: `useTabs` and `tabWidth` of the file's config; the `.editorconfig` part Prettier merged counts as `editorconfig`. */
	async indent(directory: string, file: string): Promise<ProjectIndent | null> {
		try {
			const value = await this.call<{
				own?: Record<string, unknown>;
				merged?: Record<string, unknown>;
			}>(directory, 'indent', { file });
			const own = value?.own ?? {},
				merged = value?.merged ?? {};
			const useTabs = typeof merged.useTabs === 'boolean' ? merged.useTabs : undefined;
			const tabWidth =
				typeof merged.tabWidth === 'number' && merged.tabWidth >= 1 && merged.tabWidth <= 16
					? merged.tabWidth
					: undefined;
			if (useTabs === undefined && tabWidth === undefined) return null;
			const source =
				typeof own.useTabs === 'boolean' || typeof own.tabWidth === 'number'
					? 'prettier'
					: 'editorconfig';
			return {
				source,
				...(useTabs === undefined ? {} : { useTabs }),
				...(tabWidth === undefined ? {} : { tabWidth }),
			};
		} catch {
			return null;
		}
	}
	async format(
		directory: string,
		file: string,
		ignorePath: string | null,
		text: string
	): Promise<PrettierFormat> {
		try {
			const value = await this.call<{ status?: unknown; text?: unknown; line?: unknown }>(
				directory,
				'format',
				{ file, ignorePath, text }
			);
			if (value?.status === 'formatted' && typeof value.text === 'string')
				return { status: 'formatted', text: value.text };
			if (value?.status === 'ignored' || value?.status === 'unsupported')
				return { status: value.status };
			if (value?.status === 'syntax')
				return {
					status: 'syntax',
					...(typeof value.line === 'number' && Number.isSafeInteger(value.line) && value.line > 0
						? { line: value.line }
						: {}),
				};
			return { status: 'crashed' };
		} catch (error) {
			// A timed-out worker may be stuck in a plugin: the next format gets a new one.
			if ((error as { code?: unknown }).code === -32800) {
				this.stop(directory);
				return { status: 'timeout' };
			}
			return { status: 'crashed' };
		}
	}
	private stop(directory: string) {
		const worker = this.workers.get(directory);
		if (!worker) return;
		this.workers.delete(directory);
		worker.connection.close();
		worker.child.kill();
	}
	private sweep() {
		const now = Date.now();
		for (const [directory, worker] of this.workers)
			if (now - worker.lastUsed > this.limits.idle) this.stop(directory);
	}
	get running() {
		return [...this.workers.entries()].map(([directory, worker]) => ({
			directory,
			pid: worker.child.pid ?? null,
		}));
	}
	dispose() {
		clearInterval(this.timer);
		for (const directory of [...this.workers.keys()]) this.stop(directory);
	}
}
