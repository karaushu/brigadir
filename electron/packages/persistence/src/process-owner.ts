import { execFile, spawn } from 'node:child_process';
import { promisify } from 'node:util';
import { isAbsolute } from 'node:path';

/** Kernel start identity, not a wall-clock timestamp recorded by our process. */
export class ProcessCoordinator {
	constructor(readonly executable: string) {
		if (!isAbsolute(executable)) throw new Error('Expected an absolute process helper path');
	}
	async identity(pid: number): Promise<string | null> {
		if (!Number.isSafeInteger(pid) || pid <= 0) throw new Error('Invalid process ID');
		const { stdout } = await promisify(execFile)(this.executable, ['identity', String(pid)], {
			timeout: 5000,
			maxBuffer: 1024,
		});
		const value: unknown = JSON.parse(stdout);
		if (value !== null && (typeof value !== 'string' || !/^[-a-f0-9:]{3,100}$/.test(value)))
			throw new Error('Invalid process identity');
		return value;
	}
	/** Parent death closes stdin, and the native supervisor terminates the setup process group. */
	async run(
		cwd: string,
		command: string,
		logFd: number,
		signal?: AbortSignal,
		started?: (owner: { pid: number; processStart: string }) => Promise<void>
	): Promise<void> {
		if (!isAbsolute(cwd)) throw new Error('Expected an absolute working directory');
		signal?.throwIfAborted();
		await new Promise<void>((resolve, reject) => {
			const child = spawn(
				this.executable,
				['run', cwd, process.platform === 'darwin' ? '/bin/zsh' : '/bin/sh', command],
				{ stdio: ['pipe', logFd, logFd] }
			);
			child.stdin!.on('error', () => {});
			const abort = () => child.stdin!.end();
			signal?.addEventListener('abort', abort, { once: true });
			let startFailure: unknown,
				ended = false;
			const starting = (async () => {
				if (!child.pid) throw new Error('Setup supervisor did not start');
				const processStart = await this.identity(child.pid);
				if (!processStart || ended) throw new Error('Setup supervisor stopped');
				await started?.({ pid: child.pid, processStart });
				signal?.throwIfAborted();
				if (ended) throw new Error('Setup supervisor stopped');
				child.stdin!.write('s');
			})().catch((error) => {
				startFailure = error;
				child.stdin!.end();
			});
			child.once('error', reject);
			child.once('close', (code) => {
				ended = true;
				signal?.removeEventListener('abort', abort);
				void starting.then(() => {
					if (startFailure) reject(startFailure);
					else
						code === 0
							? resolve()
							: reject(new Error(`Setup command failed (${code}). See worktree-setup.log.`));
				});
			});
		});
	}
	/** The guard file stays in place. flock ownership disappears when the helper exits. */
	async transaction<T>(path: string, work: () => Promise<T>): Promise<T> {
		if (!isAbsolute(path)) throw new Error('Expected an absolute guard path');
		const child = spawn(this.executable, ['guard', path], { stdio: ['pipe', 'pipe', 'pipe'] });
		child.stdin.on('error', () => {});
		let ready = false,
			ended = false,
			output = '';
		const closed = new Promise<void>((resolve, reject) => {
			child.once('error', reject);
			child.once('close', (code) => {
				ended = true;
				code === 0 ? resolve() : reject(new Error(`Process guard exited (${code})`));
			});
		});
		// Observe early exits immediately, including while waiting for another transaction.
		void closed.catch(() => {});
		let timer: ReturnType<typeof setTimeout> | undefined;
		try {
			await new Promise<void>((resolve, reject) => {
				timer = setTimeout(() => reject(new Error('Process guard timed out')), 10000);
				child.stdout.setEncoding('utf8');
				child.stdout.on('data', (chunk: string) => {
					output += chunk;
					if (output === 'ready\n') {
						ready = true;
						resolve();
					} else if (output.length > 64 || output.includes('\n'))
						reject(new Error('Invalid process guard response'));
				});
				void closed.then(() => {
					if (!ready) reject(new Error('Process guard closed before acquisition'));
				}, reject);
			});
			clearTimeout(timer);
			const result = await work();
			if (ended) throw new Error('Process guard was lost during the transaction');
			return result;
		} finally {
			clearTimeout(timer);
			child.stdin.end();
			if (!ready && !ended) child.kill();
			await closed;
		}
	}
}
