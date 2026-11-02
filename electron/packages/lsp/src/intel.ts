import { pathToFileURL } from 'node:url';
import { dirname, relative, resolve, sep } from 'node:path';
import {
	codeLimits,
	codeWordAt,
	codeWordChars,
	syntaxLanguage,
	syntaxLimit,
	type CodeChange,
	type CodeChangeResult,
	type CodeCompletionDetail,
	type CodeCompletionList,
	type CodeHover,
	type CodeProblem,
	type CodeSignatureHelp,
	type CodeSource,
	type CodeStatus,
	type CodeTrigger,
} from '@brigadir/core';
import { TextMirror } from './mirror';
import { styleReference, styleClassOffsets } from './style-definition';
import { LanguageServer, defaultLimits, type ServerLaunch, type ServerLimits } from './server';
import {
	findExecutable,
	installStamp,
	projectTsserver,
	serverFor,
	serverSearchPath,
	workspaceRoot,
	type ServerDefinition,
} from './servers';
import * as convert from './convert';
import { esmImportEdits } from './import-edits';
export type FoundLocation = convert.RawLocation & { byName: boolean };
export type FoundLocations = { locations: FoundLocation[]; source: CodeSource; truncated: boolean };
/** What the fallback needs from the app: same-language files of the owner's project and the syntax worker. */
export type FallbackDeps = {
	files(owner: string, language: string): Promise<string[]>;
	read(absolute: string): Promise<string | null>;
	declarations(
		language: string,
		texts: string[],
		name: string
	): Promise<{ index: number; from: number }[]>;
};
export type CodeIntelOptions = {
	typescript: { cli: string; tsserver: string } | null;
	node: string;
	searchPath?: string;
	maxServers?: number;
	idleMs?: number;
	limits?: ServerLimits;
	fallbackBudget?: number;
	/** spec/editor-code-intelligence#language-server-restart: how often live servers look at their dependency folder; 0 never. */
	installPollMs?: number;
	onProblems(owner: string, absolute: string, version: number, problems: CodeProblem[]): void;
	/** spec/editor-code-intelligence#language-server-restart: owners whose documents went through a restart, so their editors reopen them. */
	onRestarted?(owners: string[]): void;
	fallback: FallbackDeps;
};
type Entry = {
	key: string;
	definition: ServerDefinition;
	root: string;
	launch: ServerLaunch;
	/** The file and project the launch was computed from; a restart computes it again (spec/editor-code-intelligence#language-server-restart). */
	origin: { absolute: string; projectRoot: string };
	server: LanguageServer | null;
	starting: Promise<LanguageServer | null> | null;
	restarts: number[];
	disabled: boolean;
	/** spec/editor-code-intelligence#language-server-restart: the install stamp at start, the one of the last poll, and whether a marker was there at start. */
	installs: { stamp: string; seen: string; marker: boolean } | null;
};
type Doc = {
	owner: string;
	absolute: string;
	uri: string;
	language: string | null;
	mirror: TextMirror;
	entry: Entry | null;
	completion: { list: number; raw: Record<string, unknown>[] } | null;
};
export class StaleVersionError extends Error {
	constructor() {
		super('The document version changed');
	}
}
const noFeatures = {
	completion: false,
	hover: false,
	signature: false,
	definition: false,
	references: false,
	problems: false,
};
const inside = (root: string, path: string) => {
	const rest = relative(root, path);
	return !rest.startsWith('..') && !rest.startsWith(sep);
};
// spec/editor-code-intelligence#typing-help: JS, TS and TSX import each other, so the fallback looks through all three.
const scriptLanguages = ['javascript', 'typescript', 'tsx'];
// spec/editor-code-intelligence#hyphenated-words: a custom property declared in CSS is used from SCSS and back.
const styleLanguages = ['css', 'scss'];
const family = (language: string) =>
	[scriptLanguages, styleLanguages].find((group) => group.includes(language)) ?? [language];
const boundary = (word: string, language: string | null) => {
	const part = codeWordChars(language);
	return new RegExp(`(?<![${part}])${word.replace(/[$]/g, '\\$')}(?![${part}])`, 'gu');
};
/** Language servers for all open editor documents (spec/editor-code-intelligence#server-processes). Electron-free; main supplies owners and paths. */
export class CodeIntel {
	private docs = new Map<string, Doc>();
	private entries = new Map<string, Entry>();
	private lists = 0;
	private enabled = true;
	private timer: ReturnType<typeof setInterval>;
	private installTimer: ReturnType<typeof setInterval> | null = null;
	private polling = false;
	private searchPath: string;
	private limits: ServerLimits;
	constructor(private options: CodeIntelOptions) {
		this.searchPath = options.searchPath ?? serverSearchPath();
		this.limits = options.limits ?? defaultLimits;
		this.timer = setInterval(() => {
			void this.sweep();
		}, 60000);
		this.timer.unref?.();
		const poll = options.installPollMs ?? 2000;
		if (poll > 0) {
			this.installTimer = setInterval(() => {
				void this.pollInstalls();
			}, poll);
			this.installTimer.unref?.();
		}
	}
	private id(owner: string, absolute: string) {
		return `${owner}\0${absolute}`;
	}
	private launch(
		definition: ServerDefinition,
		absolute: string,
		projectRoot: string
	): ServerLaunch | null {
		if (definition.id === 'typescript') {
			if (!this.options.typescript) return null;
			const tsserver = projectTsserver(absolute, projectRoot) ?? this.options.typescript.tsserver;
			return {
				command: this.options.node,
				args: [this.options.typescript.cli, '--stdio'],
				env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' },
				initializationOptions: {
					tsserver: { path: tsserver },
					maxTsServerMemory: 3072,
					disableAutomaticTypingAcquisition: true,
					preferences: {
						includeCompletionsForModuleExports: true,
						includeCompletionsWithInsertText: true,
						importModuleSpecifierPreference: 'shortest',
					},
				},
			};
		}
		for (const candidate of definition.candidates) {
			const command = findExecutable(candidate.binary, this.searchPath);
			if (command)
				return { command, args: candidate.args, env: { ...process.env, PATH: this.searchPath } };
		}
		return null;
	}
	private get live() {
		return [...this.entries.values()].filter(
			(entry) => (entry.server && !entry.server.exited) || entry.starting
		);
	}
	private async acquire(language: string | null, absolute: string, projectRoot: string) {
		const definition = serverFor(language);
		if (!definition) return null;
		const root =
			definition.id === 'typescript'
				? projectRoot
				: workspaceRoot(definition, absolute, projectRoot);
		const key = `${definition.id}\0${root}`;
		let entry = this.entries.get(key);
		if (!entry) {
			const launch = this.launch(definition, absolute, projectRoot);
			if (!launch) return null;
			if (this.live.length >= (this.options.maxServers ?? 3)) {
				const idle = this.live
					.filter(
						(other) =>
							other.server &&
							other.server.documents.size === 0 &&
							![...this.docs.values()].some((doc) => doc.entry === other)
					)
					.sort((a, b) => a.server!.lastUsed - b.server!.lastUsed)[0];
				if (!idle) return null;
				await this.retire(idle);
			}
			entry = {
				key,
				definition,
				root,
				launch,
				origin: { absolute, projectRoot },
				server: null,
				starting: null,
				restarts: [],
				disabled: false,
				installs: null,
			};
			this.entries.set(key, entry);
		}
		return entry.disabled ? null : entry;
	}
	private async retire(entry: Entry) {
		this.entries.delete(entry.key);
		const server = entry.server;
		entry.server = null;
		entry.disabled = true;
		await server?.stop();
	}
	/** The running server of an entry, starting or restarting it and reopening its documents. */
	private ensure(entry: Entry): Promise<LanguageServer | null> {
		if (entry.disabled) return Promise.resolve(null);
		if (entry.server && !entry.server.exited) return Promise.resolve(entry.server);
		return (entry.starting ??= (async () => {
			const server = new LanguageServer(entry.root, entry.launch, this.limits);
			server.onDiagnostics((uri, diagnostics, version) =>
				this.diagnostics(entry, server, uri, diagnostics, version)
			);
			server.onExit((expected) => this.exited(entry, server, expected));
			const installs = entry.definition.installs;
			if (installs) {
				const now = await installStamp(entry.root, installs);
				entry.installs = { stamp: now.stamp, seen: now.stamp, marker: now.marker };
			}
			try {
				await server.start();
			} catch {
				server.kill();
				this.failed(entry);
				return null;
			}
			// Switched off (spec/editor-code-intelligence#typing-help) or retired while starting: the new process must not outlive its entry.
			if (entry.disabled) {
				void server.stop();
				return null;
			}
			entry.server = server;
			for (const doc of this.docs.values())
				if (doc.entry === entry)
					server.open(doc.uri, entry.definition.languageId(doc.absolute), doc.mirror.text);
			return server;
		})().finally(() => {
			entry.starting = null;
		}));
	}
	private failed(entry: Entry) {
		const now = Date.now();
		entry.restarts = [...entry.restarts.filter((at) => now - at < 5 * 60000), now];
		if (entry.restarts.length > 3) entry.disabled = true;
	}
	private exited(entry: Entry, server: LanguageServer, expected: boolean) {
		if (!expected) this.failed(entry);
		if (entry.server !== server) return;
		entry.server = null;
		for (const doc of this.docs.values())
			if (doc.entry === entry)
				this.options.onProblems(doc.owner, doc.absolute, doc.mirror.version, []);
	}
	private diagnostics(
		entry: Entry,
		server: LanguageServer,
		uri: string,
		diagnostics: unknown[],
		version: number | null
	) {
		if (entry.server !== server) return;
		const doc = [...this.docs.values()].find((doc) => doc.entry === entry && doc.uri === uri);
		if (!doc) return;
		if (version !== null && version !== server.documents.get(uri)) return;
		this.options.onProblems(
			doc.owner,
			doc.absolute,
			doc.mirror.version,
			convert.problems(doc.mirror, diagnostics)
		);
	}
	private status(doc: Doc): CodeStatus {
		const server = doc.entry?.server;
		const large = doc.mirror.text.length > syntaxLimit || doc.mirror.lineCount > 50000;
		if (!server || server.exited)
			return {
				source: 'fallback',
				language: doc.language,
				server: null,
				version: doc.mirror.version,
				features: {
					...noFeatures,
					definition: !large && doc.language !== null,
					references: !large && doc.language !== null,
				},
				completionTriggers: [],
				signatureTriggers: [],
			};
		const caps = server.capabilities;
		const strings = (value: unknown) =>
			Array.isArray(value)
				? value.filter((item): item is string => typeof item === 'string' && item.length === 1)
				: [];
		return {
			source: 'server',
			language: doc.language,
			server: doc.entry!.definition.name,
			version: doc.mirror.version,
			features: {
				completion: Boolean(caps.completionProvider),
				hover: Boolean(caps.hoverProvider),
				signature: Boolean(caps.signatureHelpProvider),
				definition: Boolean(caps.definitionProvider),
				references: Boolean(caps.referencesProvider),
				problems: true,
			},
			completionTriggers: strings(caps.completionProvider?.triggerCharacters),
			signatureTriggers: [
				...new Set([
					...strings(caps.signatureHelpProvider?.triggerCharacters),
					...strings(caps.signatureHelpProvider?.retriggerCharacters),
				]),
			],
		};
	}
	async open(
		owner: string,
		absolute: string,
		projectRoot: string,
		text: string,
		shared = false
	): Promise<CodeStatus> {
		const id = this.id(owner, absolute);
		const previous = this.docs.get(id);
		if (previous) {
			this.docs.delete(id);
			previous.entry?.server?.close(previous.uri);
		}
		const uri = pathToFileURL(absolute).href;
		const language = syntaxLanguage(absolute);
		const doc: Doc = {
			owner,
			absolute,
			uri,
			language,
			mirror: new TextMirror(text),
			entry: null,
			completion: null,
		};
		this.docs.set(id, doc);
		const large = text.length > syntaxLimit || doc.mirror.lineCount > 50000;
		const taken = [...this.docs.values()].some(
			(other) => other !== doc && other.uri === uri && other.entry
		);
		if (large) return { ...this.status(doc), features: noFeatures };
		if (!shared && !taken && this.enabled) {
			const entry = await this.acquire(language, absolute, projectRoot);
			if (this.docs.get(id) !== doc) return this.status(doc);
			if (entry) {
				doc.entry = entry;
				const server = await this.ensure(entry);
				if (!server) doc.entry = null;
				else if (!server.documents.has(uri) && this.docs.get(id) === doc)
					server.open(uri, entry.definition.languageId(absolute), doc.mirror.text);
			}
		}
		return this.status(doc);
	}
	change(
		owner: string,
		absolute: string,
		version: number,
		changes: CodeChange[]
	): CodeChangeResult {
		const doc = this.docs.get(this.id(owner, absolute));
		if (!doc || version !== doc.mirror.version + 1) return { status: 'resync' };
		let applied;
		try {
			applied = doc.mirror.apply(changes);
		} catch {
			this.docs.delete(this.id(owner, absolute));
			doc.entry?.server?.close(doc.uri);
			return { status: 'resync' };
		}
		doc.mirror.version = version;
		const server = doc.entry?.server;
		if (server && !server.exited && server.documents.has(doc.uri))
			server.change(doc.uri, applied, doc.mirror.text);
		return { status: 'ok' };
	}
	close(owner: string, absolute: string) {
		const id = this.id(owner, absolute);
		const doc = this.docs.get(id);
		if (!doc) return;
		this.docs.delete(id);
		doc.entry?.server?.close(doc.uri);
	}
	/** spec/editor-code-intelligence#typing-help: switched off, no server starts and live ones stop now; open documents answer from the fallback. */
	async setServers(enabled: boolean) {
		if (this.enabled === enabled) return;
		this.enabled = enabled;
		if (enabled) return;
		for (const doc of this.docs.values())
			if (doc.entry) {
				doc.entry = null;
				doc.completion = null;
				this.options.onProblems(doc.owner, doc.absolute, doc.mirror.version, []);
			}
		await Promise.allSettled([...this.entries.values()].map((entry) => this.retire(entry)));
	}
	/**
	 * spec/editor-code-intelligence#language-server-restart: the servers of the owner's documents, and those its fallback documents would go to, restart in
	 * place. Other owners on the same server keep their documents; the crash counter starts again.
	 */
	async restart(owner: string): Promise<{ off: boolean; restarted: string[] }> {
		if (!this.enabled) return { off: true, restarted: [] };
		const docs = [...this.docs.values()].filter((doc) => doc.owner === owner);
		const entries = [...this.entries.values()].filter((entry) =>
			docs.some(
				(doc) =>
					doc.entry === entry ||
					(!doc.entry &&
						serverFor(doc.language) === entry.definition &&
						inside(entry.root, doc.absolute))
			)
		);
		const owners = new Set([owner, ...entries.flatMap((entry) => this.owners(entry))]);
		await Promise.all(entries.map((entry) => this.restartEntry(entry)));
		if (entries.length) this.options.onRestarted?.([...owners]);
		return { off: false, restarted: [...new Set(entries.map((entry) => entry.definition.name))] };
	}
	private owners(entry: Entry) {
		return [
			...new Set(
				[...this.docs.values()].filter((doc) => doc.entry === entry).map((doc) => doc.owner)
			),
		];
	}
	private async restartEntry(entry: Entry) {
		const starting = entry.starting;
		if (starting) await starting;
		const server = entry.server;
		entry.server = null;
		entry.restarts = [];
		entry.disabled = false;
		entry.launch =
			this.launch(entry.definition, entry.origin.absolute, entry.origin.projectRoot) ??
			entry.launch;
		for (const doc of this.docs.values())
			if (doc.entry === entry) {
				doc.completion = null;
				this.options.onProblems(doc.owner, doc.absolute, doc.mirror.version, []);
			}
		await server?.stop();
		if ([...this.docs.values()].some((doc) => doc.entry === entry)) await this.ensure(entry);
	}
	/** spec/editor-code-intelligence#language-server-restart: an install that finished (stamp changed and held for two polls) restarts the server. */
	private async pollInstalls() {
		if (this.polling) return;
		this.polling = true;
		try {
			for (const entry of [...this.entries.values()]) {
				const installs = entry.definition.installs,
					state = entry.installs;
				if (!installs || !state || !entry.server || entry.server.exited || entry.starting) continue;
				const now = await installStamp(entry.root, installs);
				const held = now.stamp === state.seen;
				state.seen = now.stamp;
				if (now.stamp === state.stamp || !held || !now.folder || (state.marker && !now.marker))
					continue;
				const owners = this.owners(entry);
				await this.restartEntry(entry);
				if (owners.length) this.options.onRestarted?.(owners);
			}
		} finally {
			this.polling = false;
		}
	}
	closeOwner(owner: string) {
		for (const doc of [...this.docs.values()])
			if (doc.owner === owner) this.close(owner, doc.absolute);
	}
	isOpen(owner: string, absolute: string) {
		return this.docs.has(this.id(owner, absolute));
	}
	/** The mirrored buffer, which may hold unsaved edits, for location previews. */
	text(owner: string, absolute: string) {
		return this.docs.get(this.id(owner, absolute))?.mirror.text ?? null;
	}
	private doc(owner: string, absolute: string, version: number) {
		const doc = this.docs.get(this.id(owner, absolute));
		if (!doc || doc.mirror.version !== version) throw new StaleVersionError();
		return doc;
	}
	private async server(doc: Doc, feature: keyof CodeStatus['features']) {
		if (!doc.entry) return null;
		const server = await this.ensure(doc.entry);
		if (!server) {
			doc.entry = null;
			return null;
		}
		return this.status(doc).features[feature] ? server : null;
	}
	/** `undefined` means the request failed or timed out; `null` is the server's own empty answer. */
	private async ask<T>(
		server: LanguageServer,
		method: string,
		params: unknown,
		timeout?: number
	): Promise<T | null | undefined> {
		try {
			return await server.request<T>(method, params, timeout);
		} catch {
			return undefined;
		}
	}
	async completion(
		owner: string,
		absolute: string,
		version: number,
		offset: number,
		trigger: CodeTrigger
	): Promise<CodeCompletionList | null> {
		const doc = this.doc(owner, absolute, version);
		const server = await this.server(doc, 'completion');
		if (!server) return null;
		const value = await this.ask(
			server,
			'textDocument/completion',
			{
				textDocument: { uri: doc.uri },
				position: doc.mirror.position(offset),
				context:
					trigger.kind === 'character'
						? { triggerKind: 2, triggerCharacter: trigger.character }
						: { triggerKind: 1 },
			},
			this.limits.completion
		);
		if (value === undefined || doc.mirror.version !== version) return null;
		const result = convert.completions(doc.mirror, value, offset, doc.language);
		const resolve = Boolean(server.capabilities.completionProvider?.resolveProvider);
		const list = ++this.lists;
		doc.completion = { list, raw: result.raw };
		return {
			list,
			items: result.items.map((item) => ({
				...item,
				resolve,
				...(item.edits ? { edits: esmImportEdits(absolute, item.edits) } : {}),
			})),
			incomplete: result.incomplete,
		};
	}
	async resolveCompletion(
		owner: string,
		absolute: string,
		version: number,
		list: number,
		id: number
	): Promise<CodeCompletionDetail | null> {
		const doc = this.doc(owner, absolute, version);
		const raw = doc.completion?.list === list ? doc.completion.raw[id] : undefined;
		if (!raw) return null;
		const server = await this.server(doc, 'completion');
		if (!server) return null;
		const value = server.capabilities.completionProvider?.resolveProvider
			? await this.ask<Record<string, unknown>>(server, 'completionItem/resolve', raw)
			: raw;
		if (!value || doc.mirror.version !== version) return null;
		const documentation = convert.markdown(value.documentation).slice(0, codeLimits.hover);
		return {
			...(typeof value.detail === 'string' ? { detail: value.detail.slice(0, 2000) } : {}),
			...(documentation ? { documentation } : {}),
			edits: esmImportEdits(absolute, convert.edits(doc.mirror, value.additionalTextEdits)),
		};
	}
	async hover(
		owner: string,
		absolute: string,
		version: number,
		offset: number
	): Promise<CodeHover | null> {
		const doc = this.doc(owner, absolute, version);
		const server = await this.server(doc, 'hover');
		if (!server) return null;
		const value = await this.ask(server, 'textDocument/hover', {
			textDocument: { uri: doc.uri },
			position: doc.mirror.position(offset),
		});
		return doc.mirror.version === version
			? convert.hover(doc.mirror, value, offset, doc.language)
			: null;
	}
	async signature(
		owner: string,
		absolute: string,
		version: number,
		offset: number,
		trigger: CodeTrigger
	): Promise<CodeSignatureHelp | null> {
		const doc = this.doc(owner, absolute, version);
		const server = await this.server(doc, 'signature');
		if (!server) return null;
		const value = await this.ask(server, 'textDocument/signatureHelp', {
			textDocument: { uri: doc.uri },
			position: doc.mirror.position(offset),
			context:
				trigger.kind === 'character'
					? { triggerKind: 2, triggerCharacter: trigger.character, isRetrigger: false }
					: { triggerKind: 1, isRetrigger: false },
		});
		return doc.mirror.version === version ? convert.signatures(value) : null;
	}
	async definition(
		owner: string,
		absolute: string,
		version: number,
		offset: number
	): Promise<FoundLocations> {
		const doc = this.doc(owner, absolute, version);
		if (scriptLanguages.includes(doc.language ?? '')) {
			const reference = styleReference(absolute, doc.mirror.text, offset);
			if (reference) {
				const target = resolve(dirname(absolute), reference.path);
				const text = this.text(owner, target) ?? (await this.options.fallback.read(target));
				this.doc(owner, absolute, version);
				if (text !== null) {
					const mirror = new TextMirror(text);
					const offsets = styleClassOffsets(text, reference.name);
					if (offsets.length)
						return {
							locations: offsets
								.slice(0, codeLimits.definitions)
								.map((at) => ({ absolute: target, ...mirror.position(at), byName: false })),
							source: 'stylesheet',
							truncated: offsets.length > codeLimits.definitions,
						};
				}
			}
		}
		const server = await this.server(doc, 'definition');
		if (!server) return this.fallbackDefinition(doc, offset);
		const ask = async (position: { line: number; character: number }) =>
			convert.locations(
				await this.ask(server, 'textDocument/definition', {
					textDocument: { uri: doc.uri },
					position,
				}),
				codeLimits.definitions
			);
		let found = await ask(doc.mirror.position(offset));
		// An imported name first resolves to its own import binding, and to the source only once the
		// project has loaded. Follow the binding, once more after a pause (spec/editor-code-intelligence#typescript-features).
		for (
			let hop = 0;
			hop < 3 &&
			found.locations.length &&
			found.locations.every(
				(location) => location.absolute === doc.absolute && this.importLine(doc, location.line)
			);
			hop++
		) {
			if (hop === 1) await new Promise((resolve) => setTimeout(resolve, 500));
			const next = await ask({
				line: found.locations[0]!.line,
				character: found.locations[0]!.character,
			});
			if (doc.mirror.version !== version) break;
			if (
				next.locations.length &&
				!next.locations.every(
					(location) =>
						location.absolute === doc.absolute && location.line === found.locations[0]!.line
				)
			) {
				found = next;
				break;
			}
		}
		return {
			locations: found.locations.map((location) => ({ ...location, byName: false })),
			source: 'server',
			truncated: found.truncated,
		};
	}
	private importLine(doc: Doc, line: number) {
		for (let at = line; at >= 0 && line - at < 50; at--) {
			const text = doc.mirror.lineText(at);
			// A binding, not a declaration: `export const x` is the definition itself and needs no second ask (spec/editor-code-intelligence#definition-and-usages).
			if (
				/^\s*(import\b|export\s+(type\s+)?[{*])|\brequire\s*\(|^\s*from\s+\S+\s+import\b/.test(text)
			)
				return true;
			if (at !== line && /[;}]\s*$/.test(text)) return false;
		}
		return false;
	}
	async references(
		owner: string,
		absolute: string,
		version: number,
		offset: number
	): Promise<FoundLocations> {
		const doc = this.doc(owner, absolute, version);
		const server = await this.server(doc, 'references');
		if (!server) return this.fallbackReferences(doc, offset);
		const value = await this.ask(
			server,
			'textDocument/references',
			{
				textDocument: { uri: doc.uri },
				position: doc.mirror.position(offset),
				context: { includeDeclaration: true },
			},
			10000
		);
		const found = convert.locations(value, codeLimits.references);
		return {
			locations: found.locations.map((location) => ({ ...location, byName: false })),
			source: 'server',
			truncated: found.truncated,
		};
	}
	/** Files of the same language family, nearest directories first, read within the fallback budget (spec/editor-code-intelligence#fallback-mode). */
	private async *candidates(doc: Doc, word: string) {
		// The file list is the shared Open Quickly walk; the budget covers reading, not that first walk.
		const files = (
			await Promise.all(
				family(doc.language!).map((language) => this.options.fallback.files(doc.owner, language))
			)
		)
			.flat()
			.filter((path) => path !== doc.absolute);
		const deadline = Date.now() + (this.options.fallbackBudget ?? 2000);
		const pattern = boundary(word, doc.language);
		const here = dirname(doc.absolute).split(sep);
		const shared = (path: string) => {
			const parts = dirname(path).split(sep);
			let n = 0;
			while (n < parts.length && parts[n] === here[n]) n++;
			return n;
		};
		files.sort((a, b) => shared(b) - shared(a) || a.localeCompare(b));
		let read = 0;
		for (const path of files) {
			if (read >= 200 || Date.now() > deadline) return;
			read++;
			const text = await this.options.fallback.read(path);
			if (text === null || text.length > 1024 * 1024) continue;
			pattern.lastIndex = 0;
			if (pattern.test(text)) yield { path, text };
		}
	}
	private place(absolute: string, text: string, from: number, byName: boolean): FoundLocation {
		const position = new TextMirror(text).position(from);
		return { absolute, line: position.line, character: position.character, byName };
	}
	private async fallbackDefinition(doc: Doc, offset: number): Promise<FoundLocations> {
		const empty: FoundLocations = { locations: [], source: 'fallback', truncated: false };
		const word = codeWordAt(doc.mirror.text, offset, doc.language);
		if (!word || !doc.language || !this.status(doc).features.definition) return empty;
		const text = doc.mirror.text;
		const own = await this.options.fallback.declarations(doc.language, [text], word.word);
		const local = own
			.filter((found) => found.from !== word.from)
			.sort(
				(a, b) =>
					(a.from < word.from ? word.from - a.from : 1e12 + a.from) -
					(b.from < word.from ? word.from - b.from : 1e12 + b.from)
			);
		if (local.length)
			return {
				locations: local
					.slice(0, codeLimits.definitions)
					.map((found) => this.place(doc.absolute, text, found.from, true)),
				source: 'fallback',
				truncated: local.length > codeLimits.definitions,
			};
		const result: FoundLocation[] = [];
		let batch: { path: string; text: string }[] = [];
		const flush = async () => {
			// Each file is parsed with its own grammar: a TSX file is not TypeScript.
			for (const language of new Set(
				batch.map((file) => syntaxLanguage(file.path) ?? doc.language!)
			)) {
				const group = batch.filter(
					(file) => (syntaxLanguage(file.path) ?? doc.language) === language
				);
				const found = await this.options.fallback.declarations(
					language,
					group.map((file) => file.text),
					word.word
				);
				for (const item of found) {
					const file = group[item.index];
					if (file) result.push(this.place(file.path, file.text, item.from, true));
				}
			}
			batch = [];
		};
		for await (const file of this.candidates(doc, word.word)) {
			batch.push(file);
			if (batch.length >= 20) await flush();
			if (result.length >= codeLimits.definitions) break;
		}
		if (batch.length && result.length < codeLimits.definitions) await flush();
		if (!result.length && own.length)
			result.push(this.place(doc.absolute, text, own[0]!.from, true));
		return {
			locations: result.slice(0, codeLimits.definitions),
			source: 'fallback',
			truncated: result.length > codeLimits.definitions,
		};
	}
	private async fallbackReferences(doc: Doc, offset: number): Promise<FoundLocations> {
		const word = codeWordAt(doc.mirror.text, offset, doc.language);
		if (!word || !doc.language || !this.status(doc).features.references)
			return { locations: [], source: 'fallback', truncated: false };
		const result: FoundLocation[] = [];
		const pattern = boundary(word.word, doc.language);
		const collect = (absolute: string, text: string) => {
			const mirror = new TextMirror(text);
			pattern.lastIndex = 0;
			for (const match of text.matchAll(pattern)) {
				const position = mirror.position(match.index);
				result.push({ absolute, line: position.line, character: position.character, byName: true });
				if (result.length > codeLimits.references) return;
			}
		};
		collect(doc.absolute, doc.mirror.text);
		for await (const file of this.candidates(doc, word.word)) {
			if (result.length > codeLimits.references) break;
			collect(file.path, file.text);
		}
		return {
			locations: result.slice(0, codeLimits.references),
			source: 'fallback',
			truncated: result.length > codeLimits.references,
		};
	}
	/** The mirrored text of one synced `version`, or null when the renderer moved on (spec/editor-code-intelligence#format-on-save). */
	snapshot(owner: string, absolute: string, version: number) {
		const doc = this.docs.get(this.id(owner, absolute));
		return doc && doc.mirror.version === version ? doc.mirror.text : null;
	}
	/** Whether the document's running server declared `documentFormattingProvider` in `initialize` (rule 7). */
	canFormat(owner: string, absolute: string) {
		const server = this.docs.get(this.id(owner, absolute))?.entry?.server;
		return Boolean(server && !server.exited && server.capabilities.documentFormattingProvider);
	}
	/** `textDocument/formatting`; edits are in the offsets of `version`. `undefined` means the request failed or timed out. */
	async format(
		owner: string,
		absolute: string,
		version: number,
		options: { tabSize: number; insertSpaces: boolean }
	): Promise<CodeChange[] | null | undefined> {
		const doc = this.doc(owner, absolute, version);
		if (!doc.entry) return null;
		const server = await this.ensure(doc.entry);
		if (!server || !server.capabilities.documentFormattingProvider) return null;
		const value = await this.ask<unknown[]>(server, 'textDocument/formatting', {
			textDocument: { uri: doc.uri },
			options: {
				...options,
				trimTrailingWhitespace: true,
				insertFinalNewline: true,
				trimFinalNewlines: true,
			},
		});
		if (doc.mirror.version !== version) throw new StaleVersionError();
		if (value === undefined) return undefined;
		return convert.edits(doc.mirror, value ?? []).sort((a, b) => a.from - b.from || a.to - b.to);
	}
	/** Agent edits on disk (spec/editor-code-intelligence#server-processes): servers under the project learn about the changed files. */
	filesChanged(projectRoot: string, files: { absolute: string; type: 1 | 2 | 3 }[]) {
		if (!files.length) return;
		for (const entry of this.entries.values()) {
			const changes = files
				.filter((file) => inside(entry.root, file.absolute))
				.map((file) => ({ uri: pathToFileURL(file.absolute).href, type: file.type }));
			if (changes.length && entry.server && !entry.server.exited && inside(projectRoot, entry.root))
				entry.server.notify('workspace/didChangeWatchedFiles', { changes });
		}
	}
	private async sweep() {
		const now = Date.now();
		for (const entry of [...this.entries.values()]) {
			const server = entry.server;
			if (!server || server.exited || entry.starting) continue;
			if (
				server.documents.size === 0 &&
				![...this.docs.values()].some((doc) => doc.entry === entry) &&
				now - server.lastUsed > (this.options.idleMs ?? 10 * 60000)
			) {
				this.entries.delete(entry.key);
				entry.server = null;
				await server.stop();
			}
		}
	}
	get servers() {
		return [...this.entries.values()]
			.filter((entry) => entry.server && !entry.server.exited)
			.map((entry) => ({
				id: entry.definition.id,
				root: entry.root,
				pid: entry.server!.pid,
				documents: entry.server!.documents.size,
			}));
	}
	async dispose() {
		clearInterval(this.timer);
		if (this.installTimer) clearInterval(this.installTimer);
		this.docs.clear();
		await Promise.allSettled([...this.entries.values()].map((entry) => entry.server?.stop()));
		this.entries.clear();
	}
}
