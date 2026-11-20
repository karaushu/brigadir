import { lstat, mkdir, readdir, unlink } from 'node:fs/promises';
import {
	isAgentTemplateDocument,
	isCrewTemplateDocument,
	isBuiltinTemplateId,
	isBuiltinAgentChoicesDocument,
	builtinAgentChoices,
	withBuiltinChoices,
	builtinAgentTemplates,
	sameBuiltinChoices,
	builtinCrewTemplates,
	unshippedCrewTemplateIds,
	withBuiltinCrew,
	sameCrewTree,
	crewIssues,
	templateLookup,
	isId,
	isRecord,
	upgradeAgentTemplateDocument,
	upgradeCrewTemplateDocument,
	type AgentTemplate,
	type BuiltinAgentChoices,
	type CrewTemplate,
	type ReadIssue,
} from '@brigadir/core';
import { atomicJson, newJson, readDocument, safePath, SessionStore } from './session';
import { ReadFailure } from './index';
export type TemplateLibrary = {
	agents: AgentTemplate[];
	crews: CrewTemplate[];
	issues: ReadIssue[];
	/** spec/pull-requests-and-ci#review-crew: built-in crews the person deleted; the UI offers `Restore built-in crews` while any are hidden. */
	hiddenCrews: string[];
};
/** spec/crew-templates-and-editor#schema: role and crew files of version 1 are read and upgraded; new ones are version 2. */
const templateVersions = [1, 2] as const;
const hiddenCrewsPath = 'templates/builtin/hidden-crews.json';
/** spec/crew-templates-and-editor#unshipped-crew-ids: the move of each data folder, process-wide. */
const adoptions = new Map<string, Promise<void>>();
const isBuiltinCrewId = (id: string) => builtinCrewTemplates.some((item) => item.id === id);
/** spec/crew-templates-and-editor#template-library library: builtins come from code, own templates from `templates/agents|crews/<id>.json`. Builtins are never written;
 *  a person's provider, model and effort for a built-in role, and their edit of a built-in crew, live beside them in `templates/builtin/<id>.json`
 *  (spec/agents-and-providers#catalog, spec/crew-templates-and-editor#builtin-templates). */
export class TemplateStore {
	private tail: Promise<unknown> = Promise.resolve();
	private pending = 0;
	constructor(readonly root: string) {}
	static async at(dataDir?: string) {
		return new TemplateStore((await SessionStore.at(dataDir)).root);
	}
	get isSaving() {
		return this.pending > 0;
	}
	waitForWrites() {
		return this.tail;
	}
	private serial<T>(work: () => Promise<T>) {
		this.pending++;
		const result = this.tail
			.catch(() => {})
			.then(work)
			.finally(() => {
				this.pending--;
			});
		this.tail = result;
		return result;
	}
	private async dir(kind: 'agents' | 'crews' | 'builtin') {
		return safePath(this.root, 'templates', kind);
	}
	private async file(kind: 'agents' | 'crews' | 'builtin', id: string) {
		if (!isId(id)) throw new ReadFailure('unsafe_path');
		return safePath(await this.dir(kind), `${id}.json`);
	}
	/** A missing file is no choice; a broken one is an issue and the role keeps the app's defaults. */
	private async builtinChoices(issues: ReadIssue[]): Promise<Map<string, BuiltinAgentChoices>> {
		const found = new Map<string, BuiltinAgentChoices>();
		for (const template of builtinAgentTemplates) {
			const path = `templates/builtin/${template.id}.json`;
			try {
				const doc = await readDocument(await this.file('builtin', template.id));
				if (!isBuiltinAgentChoicesDocument(doc) || doc.template.id !== template.id)
					throw new ReadFailure('invalid_document');
				found.set(template.id, doc.template);
			} catch (error) {
				if (isRecord(error) && error.code === 'ENOENT') continue;
				issues.push({ path, code: error instanceof ReadFailure ? error.code : 'unreadable' });
			}
		}
		return found;
	}
	/** spec/crew-templates-and-editor#builtin-templates: a missing file is the app's crew; a broken one, or one that fails against the agent library, is an
	 *  issue and the app's crew stays. */
	private async builtinCrews(
		lookup: ReturnType<typeof templateLookup>,
		issues: ReadIssue[]
	): Promise<CrewTemplate[]> {
		const crews: CrewTemplate[] = [];
		for (const base of builtinCrewTemplates) {
			try {
				const doc = upgradeCrewTemplateDocument(
					await readDocument(await this.file('builtin', base.id), undefined, templateVersions)
				);
				if (
					!isCrewTemplateDocument(doc) ||
					doc.template.id !== base.id ||
					crewIssues(doc.template, lookup).length
				)
					throw new ReadFailure('invalid_document');
				crews.push(withBuiltinCrew(base, doc.template));
			} catch (error) {
				crews.push(base);
				if (isRecord(error) && error.code === 'ENOENT') continue;
				issues.push({
					path: `templates/builtin/${base.id}.json`,
					code: error instanceof ReadFailure ? error.code : 'unreadable',
				});
			}
		}
		return crews;
	}
	/** The ids `hidden-crews.json` lists, as written. A missing file hides nothing; a broken one is an issue and hides nothing either. */
	private async hiddenIds(issues?: ReadIssue[]): Promise<string[]> {
		try {
			const doc = await readDocument(await safePath(this.root, hiddenCrewsPath));
			if (
				Object.keys(doc).length !== 2 ||
				!Array.isArray(doc.crews) ||
				!doc.crews.every((id) => typeof id === 'string' && isId(id))
			)
				throw new ReadFailure('invalid_document');
			return doc.crews as string[];
		} catch (error) {
			if (isRecord(error) && error.code === 'ENOENT') return [];
			issues?.push({
				path: hiddenCrewsPath,
				code: error instanceof ReadFailure ? error.code : 'unreadable',
			});
			return [];
		}
	}
	/** spec/pull-requests-and-ci#review-crew: the hidden built-in crews. Ids the app does not ship are dropped, except one whose edit still waits in
	 *  `templates/builtin/` (spec/crew-templates-and-editor#unshipped-crew-ids): it keeps `Restore built-in crews` offered. */
	private async hidden(issues?: ReadIssue[]): Promise<string[]> {
		const listed = await this.hiddenIds(issues),
			kept: string[] = [];
		for (const id of listed)
			if (isBuiltinCrewId(id) || (unshippedCrewTemplateIds.includes(id) && (await this.edited(id))))
				kept.push(id);
		return kept;
	}
	/** Whether an edit waits in `templates/builtin/<id>.json`. A path that is not safe (a symlink) holds no edit. */
	private async edited(id: string) {
		try {
			await lstat(await this.file('builtin', id));
			return true;
		} catch {
			return false;
		}
	}
	/** spec/crew-templates-and-editor#unshipped-crew-ids: one move at a time per data folder in this process, whichever store instance reads; the
	 *  destination is created without overwriting, so a reader that lost the race (here or in another process) never replaces the moved crew or a
	 *  person's later edit of it. Not on the write queue: a save reads the library inside that queue. */
	private adoptUnshippedCrews(issues: ReadIssue[]) {
		const run = (adoptions.get(this.root) ?? Promise.resolve()).then(() => this.adoptNow(issues)),
			tail = run.catch(() => {});
		adoptions.set(this.root, tail);
		void tail.then(() => {
			if (adoptions.get(this.root) === tail) adoptions.delete(this.root);
		});
		return run;
	}
	/** A person's edit of a crew the app does not ship becomes an own crew under the same id, so the launch default and schedules that name it
	 *  keep it. An edit of a hidden crew waits for `Restore built-in crews`; an invalid or unsafe file stays and is an issue; an own crew already
	 *  under that id is never overwritten. The source goes only after the copy is written. */
	private async adoptNow(issues: ReadIssue[]) {
		const hidden = await this.hiddenIds();
		for (const id of unshippedCrewTemplateIds) {
			if (hidden.includes(id)) continue;
			const path = `templates/builtin/${id}.json`;
			try {
				const source = await this.file('builtin', id),
					doc = upgradeCrewTemplateDocument(
						await readDocument(source, undefined, templateVersions)
					);
				if (!isCrewTemplateDocument(doc) || doc.template.id !== id)
					throw new ReadFailure('invalid_document');
				await mkdir(await this.dir('crews'), { recursive: true, mode: 0o700 });
				const moved = await newJson(await this.file('crews', id), {
					schemaVersion: 2,
					template: { ...doc.template, builtin: false },
				});
				if (moved)
					await unlink(source).catch((error) => {
						if (!(isRecord(error) && error.code === 'ENOENT')) throw error;
					});
			} catch (error) {
				if (isRecord(error) && error.code === 'ENOENT') continue;
				issues.push({ path, code: error instanceof ReadFailure ? error.code : 'unreadable' });
			}
		}
	}
	private async list(kind: 'agents' | 'crews', issues: ReadIssue[]) {
		const dir = await this.dir(kind);
		let entries: import('node:fs').Dirent[];
		try {
			entries = await readdir(dir, { withFileTypes: true });
		} catch (error) {
			if (isRecord(error) && error.code === 'ENOENT') return [];
			issues.push({ path: `templates/${kind}`, code: 'unreadable' });
			return [];
		}
		const documents: Record<string, unknown>[] = [];
		for (const entry of entries.sort((a, b) => a.name.localeCompare(b.name))) {
			if (!entry.name.endsWith('.json')) continue;
			const id = entry.name.slice(0, -5),
				path = `templates/${kind}/${entry.name}`;
			if (entry.isSymbolicLink() || !entry.isFile() || !isId(id)) {
				issues.push({ path, code: 'unsafe_path' });
				continue;
			}
			try {
				const doc = await readDocument(await this.file(kind, id), undefined, templateVersions);
				if (!isRecord(doc.template) || doc.template.id !== id || isBuiltinTemplateId(id))
					throw new ReadFailure('invalid_document');
				documents.push(doc);
			} catch (error) {
				issues.push({ path, code: error instanceof ReadFailure ? error.code : 'unreadable' });
			}
		}
		return documents;
	}
	async read(): Promise<TemplateLibrary> {
		const issues: ReadIssue[] = [];
		await this.adoptUnshippedCrews(issues);
		const agents: AgentTemplate[] = [],
			crews: CrewTemplate[] = [],
			choices = await this.builtinChoices(issues),
			hiddenCrews = await this.hidden(issues),
			builtins = builtinAgentTemplates.map((template) =>
				withBuiltinChoices(template, choices.get(template.id))
			);
		// spec/crew-templates-and-editor#schema: a version 1 file reads as version 2 and is written so at its next save.
		for (const stored of await this.list('agents', issues)) {
			const doc = upgradeAgentTemplateDocument(stored) as Record<string, unknown>;
			if (isAgentTemplateDocument(doc) && !doc.template.builtin) agents.push(doc.template);
			else
				issues.push({
					path: `templates/agents/${String((doc.template as { id?: unknown })?.id)}.json`,
					code: 'invalid_document',
				});
		}
		const lookup = templateLookup([...builtins, ...agents]);
		for (const stored of await this.list('crews', issues)) {
			const doc = upgradeCrewTemplateDocument(stored) as Record<string, unknown>;
			if (
				isCrewTemplateDocument(doc) &&
				!doc.template.builtin &&
				!crewIssues(doc.template, lookup).length
			)
				crews.push(doc.template);
			else
				issues.push({
					path: `templates/crews/${String((doc.template as { id?: unknown })?.id)}.json`,
					code: 'invalid_document',
				});
		}
		const byName = (a: { name: string }, b: { name: string }) => a.name.localeCompare(b.name);
		const builtinCrews = await this.builtinCrews(lookup, issues);
		return {
			agents: [...builtins, ...agents.sort(byName)],
			crews: [
				...builtinCrews.filter((item) => !hiddenCrews.includes(item.id)),
				...crews.sort(byName),
			],
			issues,
			hiddenCrews,
		};
	}
	saveAgent(template: AgentTemplate) {
		return this.serial(async () => {
			if (template.builtin && builtinAgentTemplates.some((item) => item.id === template.id))
				return this.saveBuiltinChoices(template);
			if (template.builtin || isBuiltinTemplateId(template.id))
				throw new Error('Built-in templates are read-only');
			if (!isAgentTemplateDocument({ schemaVersion: 2, template }))
				throw new Error('Invalid agent template');
			await mkdir(await this.dir('agents'), { recursive: true, mode: 0o700 });
			await atomicJson(await this.file('agents', template.id), { schemaVersion: 2, template });
			return template;
		});
	}
	/** Only provider and launch choices are kept; no choices removes the file, and the role is the app's again. */
	private async saveBuiltinChoices(template: AgentTemplate) {
		const choices = builtinAgentChoices(template),
			file = await this.file('builtin', template.id);
		if (!isBuiltinAgentChoicesDocument({ schemaVersion: 1, template: choices }))
			throw new Error('Invalid agent template');
		// spec/crew-templates-and-editor#builtin-templates: the app's own values are no overlay.
		if (
			sameBuiltinChoices(
				choices,
				builtinAgentChoices(builtinAgentTemplates.find((item) => item.id === template.id)!)
			)
		) {
			await unlink(file).catch((error) => {
				if (!(isRecord(error) && error.code === 'ENOENT')) throw error;
			});
			return withBuiltinChoices(
				builtinAgentTemplates.find((item) => item.id === template.id)!,
				undefined
			);
		}
		await mkdir(await this.dir('builtin'), { recursive: true, mode: 0o700 });
		await atomicJson(file, { schemaVersion: 1, template: choices });
		return withBuiltinChoices(
			builtinAgentTemplates.find((item) => item.id === template.id)!,
			choices
		);
	}
	/** The whole tree is kept under the app's id and name; the app's own tree removes the file, and the crew is the app's again. */
	private async saveBuiltinCrew(template: CrewTemplate) {
		const base = builtinCrewTemplates.find((item) => item.id === template.id)!,
			edited = withBuiltinCrew(base, template),
			file = await this.file('builtin', base.id);
		if (!isCrewTemplateDocument({ schemaVersion: 2, template: edited }))
			throw new Error('Invalid crew template');
		const issues = crewIssues(edited, templateLookup((await this.read()).agents));
		if (issues.length) throw new Error(issues[0]!.message);
		if (sameCrewTree(edited, base)) {
			await unlink(file).catch((error) => {
				if (!(isRecord(error) && error.code === 'ENOENT')) throw error;
			});
			return base;
		}
		await mkdir(await this.dir('builtin'), { recursive: true, mode: 0o700 });
		await atomicJson(file, { schemaVersion: 2, template: edited });
		return edited;
	}
	saveCrew(template: CrewTemplate) {
		return this.serial(async () => {
			if (template.builtin && isBuiltinCrewId(template.id)) return this.saveBuiltinCrew(template);
			if (template.builtin || isBuiltinTemplateId(template.id))
				throw new Error('Built-in templates are read-only');
			if (!isCrewTemplateDocument({ schemaVersion: 2, template }))
				throw new Error('Invalid crew template');
			const library = await this.read();
			const issues = crewIssues(template, templateLookup(library.agents));
			if (issues.length) throw new Error(issues[0]!.message);
			await mkdir(await this.dir('crews'), { recursive: true, mode: 0o700 });
			await atomicJson(await this.file('crews', template.id), { schemaVersion: 2, template });
			return template;
		});
	}
	/** Deleting an agent template keeps crews that reference it invalid until edited: the library shows them as issues, tasks keep their snapshots (spec/crew-templates-and-editor#snapshot). */
	deleteAgent(id: string) {
		return this.serial(async () => {
			if (isBuiltinTemplateId(id)) throw new Error('Built-in templates are read-only');
			await unlink(await this.file('agents', id));
		});
	}
	/** spec/pull-requests-and-ci#review-crew: a built-in crew is hidden, not deleted; tasks keep their snapshots (spec/crew-templates-and-editor#snapshot). Built-in agents stay. */
	deleteCrew(id: string) {
		return this.serial(async () => {
			if (isBuiltinCrewId(id)) {
				const hidden = await this.hidden();
				if (hidden.includes(id)) return;
				await mkdir(await this.dir('builtin'), { recursive: true, mode: 0o700 });
				await atomicJson(await safePath(this.root, hiddenCrewsPath), {
					schemaVersion: 1,
					crews: [...hidden, id],
				});
				return;
			}
			if (isBuiltinTemplateId(id)) throw new Error('Built-in templates are read-only');
			await unlink(await this.file('crews', id));
		});
	}
	/** spec/pull-requests-and-ci#review-crew: `Restore built-in crews` brings every hidden built-in crew back. */
	restoreCrews() {
		return this.serial(async () => {
			await unlink(await safePath(this.root, hiddenCrewsPath)).catch((error) => {
				if (!(isRecord(error) && error.code === 'ENOENT')) throw error;
			});
		});
	}
}
