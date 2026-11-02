import { spawn, type ChildProcess } from 'node:child_process';
import { pathToFileURL } from 'node:url';
import { RpcConnection } from './rpc';
import type { Range } from './mirror';
export type ServerLaunch = {
	command: string;
	args: string[];
	env?: NodeJS.ProcessEnv;
	initializationOptions?: unknown;
};
export type ServerCapabilities = Record<string, unknown> & {
	completionProvider?: { triggerCharacters?: string[]; resolveProvider?: boolean };
	signatureHelpProvider?: { triggerCharacters?: string[]; retriggerCharacters?: string[] };
	hoverProvider?: unknown;
	definitionProvider?: unknown;
	referencesProvider?: unknown;
	documentFormattingProvider?: unknown;
	textDocumentSync?: unknown;
};
export type ServerLimits = { start: number; request: number; completion: number };
export const defaultLimits: ServerLimits = { start: 20000, request: 5000, completion: 3000 };
const clientCapabilities = {
	general: { positionEncodings: ['utf-16'] },
	textDocument: {
		synchronization: { didSave: false, willSave: false, dynamicRegistration: false },
		completion: {
			completionItem: {
				snippetSupport: false,
				documentationFormat: ['markdown', 'plaintext'],
				resolveSupport: { properties: ['detail', 'documentation', 'additionalTextEdits'] },
				labelDetailsSupport: true,
			},
			contextSupport: true,
		},
		hover: { contentFormat: ['markdown', 'plaintext'] },
		signatureHelp: {
			signatureInformation: {
				documentationFormat: ['markdown', 'plaintext'],
				parameterInformation: { labelOffsetSupport: true },
				activeParameterSupport: true,
			},
			contextSupport: true,
		},
		definition: { linkSupport: true },
		references: {},
		formatting: { dynamicRegistration: false },
		publishDiagnostics: { relatedInformation: false, versionSupport: true },
	},
	workspace: {
		workspaceFolders: true,
		configuration: true,
		didChangeWatchedFiles: { dynamicRegistration: false },
	},
	window: { workDoneProgress: false },
};
/** One language-server process for one workspace root. Documents are keyed by URI and owned by the caller. */
export class LanguageServer {
	private child: ChildProcess | null = null;
	private connection: RpcConnection | null = null;
	capabilities: ServerCapabilities = {};
	private starting: Promise<void> | null = null;
	readonly documents = new Map<string, number>();
	lastUsed = Date.now();
	private processExited = false;
	/** The process is gone or its pipe closed; either way it answers nothing more. */
	get exited() {
		return this.processExited || Boolean(this.connection?.isClosed);
	}
	private diagnostics = new Set<
		(uri: string, diagnostics: unknown[], version: number | null) => void
	>();
	private exits = new Set<(expected: boolean) => void>();
	private stopping = false;
	readonly stderr: string[] = [];
	constructor(
		readonly root: string,
		private launch: ServerLaunch,
		readonly limits: ServerLimits = defaultLimits
	) {}
	onDiagnostics(listener: (uri: string, diagnostics: unknown[], version: number | null) => void) {
		this.diagnostics.add(listener);
		return () => {
			this.diagnostics.delete(listener);
		};
	}
	onExit(listener: (expected: boolean) => void) {
		this.exits.add(listener);
		return () => {
			this.exits.delete(listener);
		};
	}
	get pid() {
		return this.child?.pid ?? null;
	}
	start() {
		return (this.starting ??= this.performStart());
	}
	private async performStart() {
		const child = spawn(this.launch.command, this.launch.args, {
			cwd: this.root,
			stdio: ['pipe', 'pipe', 'pipe'],
			env: this.launch.env ?? process.env,
		});
		this.child = child;
		child.stderr!.on('data', (chunk: Buffer) => {
			this.stderr.push(chunk.toString('utf8').slice(0, 2000));
			if (this.stderr.length > 20) this.stderr.shift();
		});
		const failed = new Promise<never>((_, reject) => {
			child.once('error', reject);
		});
		child.once('exit', () => {
			this.processExited = true;
			this.connection?.close(new Error('Language server exited'));
			for (const listener of this.exits) listener(this.stopping);
		});
		child.stdin!.on('error', () => {});
		const root = pathToFileURL(this.root).href;
		this.connection = new RpcConnection(child.stdout!, child.stdin!, (method, params) =>
			this.serverRequest(method, params)
		);
		this.connection.onNotification((method, params) => {
			if (method !== 'textDocument/publishDiagnostics' || !params || typeof params !== 'object')
				return;
			const value = params as { uri?: unknown; diagnostics?: unknown; version?: unknown };
			if (typeof value.uri === 'string' && Array.isArray(value.diagnostics))
				for (const listener of this.diagnostics)
					listener(
						value.uri,
						value.diagnostics,
						typeof value.version === 'number' ? value.version : null
					);
		});
		const initialized = this.connection.request<{ capabilities?: ServerCapabilities }>(
			'initialize',
			{
				processId: process.pid,
				clientInfo: { name: 'Brigadir' },
				rootUri: root,
				rootPath: this.root,
				locale: 'en',
				workspaceFolders: [{ uri: root, name: this.root.split('/').at(-1) ?? 'root' }],
				capabilities: clientCapabilities,
				...(this.launch.initializationOptions
					? { initializationOptions: this.launch.initializationOptions }
					: {}),
			},
			this.limits.start
		);
		try {
			const result = await Promise.race([initialized, failed]);
			this.capabilities = result?.capabilities ?? {};
			this.connection.notify('initialized', {});
		} catch (error) {
			this.kill();
			throw error;
		}
	}
	private serverRequest(method: string, params: unknown) {
		if (method === 'workspace/configuration') {
			const items = (params as { items?: unknown[] } | null)?.items;
			return Array.isArray(items) ? items.map(() => null) : [];
		}
		if (method === 'workspace/workspaceFolders') {
			const uri = pathToFileURL(this.root).href;
			return [{ uri, name: this.root.split('/').at(-1) ?? 'root' }];
		}
		return null;
	}
	get syncKind(): number {
		const sync = this.capabilities.textDocumentSync;
		if (typeof sync === 'number') return sync;
		if (
			sync &&
			typeof sync === 'object' &&
			typeof (sync as { change?: unknown }).change === 'number'
		)
			return (sync as { change: number }).change;
		return 1;
	}
	request<T>(method: string, params: unknown, timeout = this.limits.request, signal?: AbortSignal) {
		this.lastUsed = Date.now();
		if (!this.connection || this.exited)
			return Promise.reject(new Error('Language server is not running'));
		return this.connection.request<T>(method, params, timeout, signal);
	}
	notify(method: string, params: unknown) {
		this.lastUsed = Date.now();
		this.connection?.notify(method, params);
	}
	open(uri: string, languageId: string, text: string) {
		this.documents.set(uri, 0);
		this.notify('textDocument/didOpen', { textDocument: { uri, languageId, version: 0, text } });
	}
	change(uri: string, changes: { range: Range; text: string }[], fullText: string) {
		const version = (this.documents.get(uri) ?? 0) + 1;
		this.documents.set(uri, version);
		const contentChanges = this.syncKind === 2 ? changes : [{ text: fullText }];
		if (this.syncKind !== 0)
			this.notify('textDocument/didChange', { textDocument: { uri, version }, contentChanges });
		return version;
	}
	close(uri: string) {
		if (!this.documents.delete(uri)) return;
		this.notify('textDocument/didClose', { textDocument: { uri } });
	}
	async stop() {
		if (this.processExited || !this.child) return;
		this.stopping = true;
		const exited = new Promise<void>((resolve) => {
			if (this.processExited) resolve();
			else this.child!.once('exit', () => resolve());
		});
		try {
			await this.request('shutdown', null, 2000);
			this.notify('exit', null);
		} catch {
			/* the kill below still stops it */
		}
		const timer = setTimeout(() => this.kill(), 2000);
		await exited;
		clearTimeout(timer);
	}
	kill() {
		this.stopping = true;
		if (!this.processExited) this.child?.kill('SIGKILL');
	}
}
