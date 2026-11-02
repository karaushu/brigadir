import { join } from 'node:path';
import { readFile, stat } from 'node:fs/promises';
import {
	CodeIntel,
	PrettierPool,
	StaleVersionError,
	TextMirror,
	findPrettier,
	prettierIgnore,
	type FoundLocations,
} from '@brigadir/lsp';
import {
	syntaxLanguage,
	type AppSettings,
	type CodeChange,
	type CodeFormatInfo,
	type CodeIndentInfo,
	type CodeFormatReason,
	type CodeFormatResult,
	type CodeLocations,
	type CodeProblemsEvent,
	type CodeRestartResult,
	type CodeStatus,
	type CodeTrigger,
	type Project,
	type TaskKey,
} from '@brigadir/core';
import { formatEdits, formatMode } from './format';
import { lspIndent, projectIndent, resolveFor } from './indent';
import type { Files } from './files';
import type { Syntax } from './syntax';
const owner = (key: TaskKey) => `${key.projectId}/${key.id}`;
/** What formatting reads from the app (spec/editor-code-intelligence#format-on-save): the global choice and the project's override. */
export type FormatDeps = {
	settings(): Promise<AppSettings>;
	project(projectId: string): Promise<Project | null>;
};
const formatByteLimit = 2 * 1024 * 1024;
/** Opaque file IDs ↔ absolute paths for the language servers (spec/editor-code-intelligence#architecture). The renderer sees neither paths nor URIs. */
export class CodeIntelBridge {
	private intel: CodeIntel;
	private open = new Map<
		string,
		{ key: TaskKey; fileId: string; absolute: string; projectRoot: string }
	>();
	private prettier: PrettierPool;
	constructor(
		private files: Files,
		services: string,
		syntax: Syntax,
		private send: (event: CodeProblemsEvent) => void,
		private formatting: FormatDeps,
		restarted: (keys: TaskKey[]) => void = () => {}
	) {
		this.prettier = new PrettierPool(join(services, 'prettier.cjs'), process.execPath);
		const lsp = join(services, 'lsp/node_modules');
		this.intel = new CodeIntel({
			typescript: {
				cli: join(lsp, 'typescript-language-server/lib/cli.mjs'),
				tsserver: join(lsp, 'typescript/lib/tsserver.js'),
			},
			node: process.execPath,
			onProblems: (ownerId, absolute, version, problems) => {
				for (const doc of this.open.values())
					if (owner(doc.key) === ownerId && doc.absolute === absolute)
						this.send({ key: doc.key, fileId: doc.fileId, version, problems });
			},
			fallback: {
				files: async (ownerId, language) => {
					const doc = [...this.open.values()].find((doc) => owner(doc.key) === ownerId);
					return doc ? this.files.codeFiles(doc.key, language).catch(() => []) : [];
				},
				read: async (absolute) => {
					try {
						if ((await stat(absolute)).size > 1024 * 1024) return null;
						return await readFile(absolute, 'utf8');
					} catch {
						return null;
					}
				},
				declarations: (language, texts, name) => syntax.declarations(language, texts, name),
			},
			// spec/editor-code-intelligence#language-server-restart: owners back to task keys through the documents they have open.
			onRestarted: (owners) => {
				const keys = new Map<string, TaskKey>();
				for (const doc of this.open.values())
					if (owners.includes(owner(doc.key))) keys.set(owner(doc.key), doc.key);
				if (keys.size) restarted([...keys.values()]);
			},
		});
		files.onClosed = (key, fileId) => {
			for (const [id, doc] of this.open)
				if (!key || (owner(doc.key) === owner(key) && (!fileId || doc.fileId === fileId))) {
					this.open.delete(id);
					this.intel.close(owner(doc.key), doc.absolute);
				}
		};
	}
	private id(key: TaskKey, fileId: string) {
		return `${owner(key)}\0${fileId}`;
	}
	private doc(key: TaskKey, fileId: string) {
		const doc = this.open.get(this.id(key, fileId));
		if (!doc) throw new StaleVersionError();
		return doc;
	}
	/** A stale version or a closed document answers "nothing", never an error dialog. */
	private async quiet<T>(run: () => Promise<T>, empty: T): Promise<T> {
		try {
			return await run();
		} catch (error) {
			if (error instanceof StaleVersionError) return empty;
			throw error;
		}
	}
	async openCode(key: TaskKey, fileId: string, text: string): Promise<CodeStatus> {
		const target = await this.files.codeTarget(key, fileId);
		this.open.set(this.id(key, fileId), {
			key,
			fileId,
			absolute: target.absolute,
			projectRoot: target.projectRoot,
		});
		return this.intel.open(owner(key), target.absolute, target.projectRoot, text, target.locked);
	}
	changeCode(key: TaskKey, fileId: string, version: number, changes: CodeChange[]) {
		const doc = this.open.get(this.id(key, fileId));
		if (!doc) return { status: 'resync' as const };
		return this.intel.change(owner(key), doc.absolute, version, changes);
	}
	closeCode(key: TaskKey, fileId: string) {
		const doc = this.open.get(this.id(key, fileId));
		if (!doc) return;
		this.open.delete(this.id(key, fileId));
		this.intel.close(owner(key), doc.absolute);
	}
	complete(key: TaskKey, fileId: string, version: number, offset: number, trigger: CodeTrigger) {
		return this.quiet(
			() =>
				this.intel.completion(owner(key), this.doc(key, fileId).absolute, version, offset, trigger),
			null
		);
	}
	resolve(key: TaskKey, fileId: string, version: number, list: number, item: number) {
		return this.quiet(
			() =>
				this.intel.resolveCompletion(
					owner(key),
					this.doc(key, fileId).absolute,
					version,
					list,
					item
				),
			null
		);
	}
	hover(key: TaskKey, fileId: string, version: number, offset: number) {
		return this.quiet(
			() => this.intel.hover(owner(key), this.doc(key, fileId).absolute, version, offset),
			null
		);
	}
	signature(key: TaskKey, fileId: string, version: number, offset: number, trigger: CodeTrigger) {
		return this.quiet(
			() =>
				this.intel.signature(owner(key), this.doc(key, fileId).absolute, version, offset, trigger),
			null
		);
	}
	definition(key: TaskKey, fileId: string, version: number, offset: number) {
		return this.quiet(
			async () =>
				this.locations(
					key,
					fileId,
					await this.intel.definition(owner(key), this.doc(key, fileId).absolute, version, offset)
				),
			null
		);
	}
	references(key: TaskKey, fileId: string, version: number, offset: number) {
		return this.quiet(
			async () =>
				this.locations(
					key,
					fileId,
					await this.intel.references(owner(key), this.doc(key, fileId).absolute, version, offset)
				),
			null
		);
	}
	/** Registers each location as an opaque file and reads its line from the open buffer or the disk. */
	private async locations(
		key: TaskKey,
		fileId: string,
		found: FoundLocations
	): Promise<CodeLocations> {
		const language = syntaxLanguage(this.doc(key, fileId).absolute);
		const texts = new Map<string, TextMirror | null>();
		const registered = new Map<string, Awaited<ReturnType<Files['locate']>>>();
		const text = async (absolute: string) => {
			if (!texts.has(absolute)) {
				const open = [...this.open.values()].find(
					(doc) => owner(doc.key) === owner(key) && doc.absolute === absolute
				);
				const buffer = open ? this.intel.text(owner(key), absolute) : null;
				let value = buffer;
				if (value === null) {
					try {
						if ((await stat(absolute)).size <= 2 * 1024 * 1024)
							value = await readFile(absolute, 'utf8');
					} catch {
						/* the preview stays empty */
					}
				}
				texts.set(absolute, value === null ? null : new TextMirror(value));
			}
			return texts.get(absolute)!;
		};
		const locations: CodeLocations['locations'] = [];
		for (const location of found.locations) {
			if (!registered.has(location.absolute))
				registered.set(location.absolute, await this.files.locate(key, location.absolute));
			const file = registered.get(location.absolute);
			if (!file) continue;
			const preview =
				(await text(location.absolute))?.lineText(location.line).trim().slice(0, 300) ?? '';
			locations.push({
				fileId: file.id,
				path: file.path,
				line: location.line + 1,
				column: location.character + 1,
				preview,
				readOnly: file.readOnly,
				byName: location.byName,
			});
		}
		return { locations, source: found.source, language, truncated: found.truncated };
	}
	private async mode(key: TaskKey, reason: CodeFormatReason) {
		const [settings, project] = await Promise.all([
			this.formatting.settings(),
			this.formatting.project(key.projectId).catch(() => null),
		]);
		return formatMode(settings, project?.formatter, reason);
	}
	/** spec/editor-code-intelligence#format-on-save: the project's Prettier, else the language server; edits are in the synced `version`. */
	async format(
		key: TaskKey,
		fileId: string,
		version: number,
		reason: CodeFormatReason
	): Promise<CodeFormatResult> {
		const doc = this.open.get(this.id(key, fileId));
		if (!doc) return { status: 'skipped', reason: 'stale' };
		const mode = await this.mode(key, reason);
		if (mode === 'off') return { status: 'skipped', reason: 'off' };
		const text = this.intel.snapshot(owner(key), doc.absolute, version);
		if (text === null) return { status: 'skipped', reason: 'stale' };
		if (text.length > formatByteLimit) return { status: 'skipped', reason: 'unsupported' };
		if (mode !== 'language-server') {
			const found = findPrettier(doc.absolute, doc.projectRoot);
			if (!found && mode === 'prettier') return { status: 'skipped', reason: 'not-found' };
			if (found) {
				const result = await this.prettier.format(
					found.directory,
					doc.absolute,
					prettierIgnore(doc.absolute, doc.projectRoot),
					text
				);
				if (result.status === 'formatted')
					return this.intel.snapshot(owner(key), doc.absolute, version) === text
						? {
								status: 'formatted',
								source: 'prettier',
								version,
								edits: formatEdits(text, result.text),
							}
						: { status: 'skipped', reason: 'stale' };
				if (result.status === 'ignored') return { status: 'skipped', reason: 'ignored' };
				if (result.status === 'syntax')
					return {
						status: 'failed',
						source: 'prettier',
						reason: 'syntax',
						...(result.line ? { line: result.line } : {}),
					};
				if (result.status === 'timeout' || result.status === 'crashed')
					return { status: 'failed', source: 'prettier', reason: result.status };
				if (mode === 'prettier')
					return { status: 'skipped', reason: 'unsupported', source: 'prettier' };
			}
		}
		try {
			const edits = await this.intel.format(
				owner(key),
				doc.absolute,
				version,
				lspIndent(
					resolveFor(
						(await this.formatting.settings()).editor,
						await projectIndent(this.prettier, doc.absolute, doc.projectRoot),
						doc.absolute,
						text
					)
				)
			);
			if (edits === null)
				return mode === 'language-server'
					? { status: 'skipped', reason: 'unsupported', source: 'language-server' }
					: { status: 'skipped', reason: 'none' };
			if (edits === undefined)
				return { status: 'failed', source: 'language-server', reason: 'timeout' };
			return { status: 'formatted', source: 'language-server', version, edits };
		} catch (error) {
			if (error instanceof StaleVersionError) return { status: 'skipped', reason: 'stale' };
			throw error;
		}
	}
	/** spec/editor#indentation: what the project's Prettier or `.editorconfig` says about this file's indentation; the renderer merges it with Settings. */
	async indentInfo(key: TaskKey, fileId: string): Promise<CodeIndentInfo> {
		const doc = this.open.get(this.id(key, fileId));
		if (!doc) return { project: null };
		return { project: await projectIndent(this.prettier, doc.absolute, doc.projectRoot) };
	}
	/** The same for a project root, for the project rows of Settings ▸ Editor. */
	projectIndentAt(root: string) {
		return projectIndent(this.prettier, join(root, 'index.ts'), root);
	}
	/** The footer's answer to «will ⌘S change this file» (spec/editor-code-intelligence#format-states). */
	async formatInfo(key: TaskKey, fileId: string): Promise<CodeFormatInfo> {
		const doc = this.open.get(this.id(key, fileId));
		if (!doc) return { source: null, onSave: false };
		const [save, command] = await Promise.all([this.mode(key, 'save'), this.mode(key, 'command')]);
		const onSave = save !== 'off';
		if (command !== 'language-server') {
			const found = findPrettier(doc.absolute, doc.projectRoot);
			if (found) {
				const info = await this.prettier.info(
					found.directory,
					doc.absolute,
					prettierIgnore(doc.absolute, doc.projectRoot)
				);
				if (info?.ignored) return { source: null, onSave };
				if (info?.parser) return { source: 'prettier', onSave };
			}
			if (command === 'prettier') return { source: null, onSave };
		}
		return {
			source: this.intel.canFormat(owner(key), doc.absolute) ? 'language-server' : null,
			onSave,
		};
	}
	/** Agent edits after a checkpoint (spec/editor-code-intelligence#server-processes): servers re-read the task's changed files. */
	async checkpoint(key: TaskKey) {
		try {
			const snapshot = await this.files.changes.read(key);
			const changed = snapshot.files.flatMap((file) => {
				const scope = snapshot.scopes.find((scope) => scope.id === file.scopeId);
				return scope
					? [
							{
								absolute: join(scope.path, file.path),
								type: (/^a/i.test(file.status) ? 1 : /^d/i.test(file.status) ? 3 : 2) as 1 | 2 | 3,
							},
						]
					: [];
			});
			for (const scope of snapshot.scopes)
				this.intel.filesChanged(
					scope.path,
					changed.filter((file) => file.absolute.startsWith(scope.path + '/'))
				);
		} catch {
			/* a missing snapshot changes nothing */
		}
	}
	/** spec/editor-code-intelligence#language-server-restart: the language servers of the task's documents, from the menu or the agent's tool. */
	restart(key: TaskKey): Promise<CodeRestartResult> {
		return this.intel.restart(owner(key));
	}
	/** spec/editor-code-intelligence#typing-help Settings ▸ Editor ▸ Language servers; the renderer reopens its documents on the appearance change. */
	setLanguageServers(enabled: boolean) {
		return this.intel.setServers(enabled);
	}
	dispose() {
		this.prettier.dispose();
		return this.intel.dispose();
	}
}
