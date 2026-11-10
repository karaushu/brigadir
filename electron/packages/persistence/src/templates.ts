import { mkdir, readdir, unlink } from 'node:fs/promises';
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
	crewIssues,
	templateLookup,
	isId,
	isRecord,
	type AgentTemplate,
	type BuiltinAgentChoices,
	type CrewTemplate,
	type ReadIssue,
} from '@brigadir/core';
import { atomicJson, readDocument, safePath, SessionStore } from './session';
import { ReadFailure } from './index';
export type TemplateLibrary = {
	agents: AgentTemplate[];
	crews: CrewTemplate[];
	issues: ReadIssue[];
	/** spec/pull-requests-and-ci#review-crew: built-in crews the person deleted; the UI offers `Restore default crews` while any are hidden. */
	hiddenCrews: string[];
};
const hiddenCrewsPath = 'templates/builtin/hidden-crews.json';
const isBuiltinCrewId = (id: string) => builtinCrewTemplates.some((item) => item.id === id);
/** spec/crew-templates-and-editor#template-library library: builtins come from code, own templates from `templates/agents|crews/<id>.json`. Builtins are never written;
 *  a person's provider, model and effort for a built-in role live beside them in `templates/builtin/<id>.json` (spec/agents-and-providers#catalog). */
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
	/** spec/pull-requests-and-ci#review-crew: a missing file hides nothing; a broken one is an issue and hides nothing either. Ids of crews the app
	 *  no longer ships are dropped. */
	private async hidden(issues?: ReadIssue[]): Promise<string[]> {
		try {
			const doc = await readDocument(await safePath(this.root, hiddenCrewsPath));
			if (
				Object.keys(doc).length !== 2 ||
				!Array.isArray(doc.crews) ||
				!doc.crews.every((id) => typeof id === 'string' && isId(id))
			)
				throw new ReadFailure('invalid_document');
			return builtinCrewTemplates
				.map((item) => item.id)
				.filter((id) => (doc.crews as string[]).includes(id));
		} catch (error) {
			if (isRecord(error) && error.code === 'ENOENT') return [];
			issues?.push({
				path: hiddenCrewsPath,
				code: error instanceof ReadFailure ? error.code : 'unreadable',
			});
			return [];
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
				const doc = await readDocument(await this.file(kind, id));
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
		const issues: ReadIssue[] = [],
			agents: AgentTemplate[] = [],
			crews: CrewTemplate[] = [],
			choices = await this.builtinChoices(issues),
			hiddenCrews = await this.hidden(issues),
			builtins = builtinAgentTemplates.map((template) =>
				withBuiltinChoices(template, choices.get(template.id))
			);
		for (const doc of await this.list('agents', issues)) {
			if (isAgentTemplateDocument(doc) && !doc.template.builtin) agents.push(doc.template);
			else
				issues.push({
					path: `templates/agents/${String((doc.template as { id?: unknown })?.id)}.json`,
					code: 'invalid_document',
				});
		}
		const lookup = templateLookup([...builtins, ...agents]);
		for (const doc of await this.list('crews', issues)) {
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
		return {
			agents: [...builtins, ...agents.sort(byName)],
			crews: [
				...builtinCrewTemplates.filter((item) => !hiddenCrews.includes(item.id)),
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
			if (!isAgentTemplateDocument({ schemaVersion: 1, template }))
				throw new Error('Invalid agent template');
			await mkdir(await this.dir('agents'), { recursive: true, mode: 0o700 });
			await atomicJson(await this.file('agents', template.id), { schemaVersion: 1, template });
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
	saveCrew(template: CrewTemplate) {
		return this.serial(async () => {
			if (template.builtin || isBuiltinTemplateId(template.id))
				throw new Error('Built-in templates are read-only');
			if (!isCrewTemplateDocument({ schemaVersion: 1, template }))
				throw new Error('Invalid crew template');
			const library = await this.read();
			const issues = crewIssues(template, templateLookup(library.agents));
			if (issues.length) throw new Error(issues[0]!.message);
			await mkdir(await this.dir('crews'), { recursive: true, mode: 0o700 });
			await atomicJson(await this.file('crews', template.id), { schemaVersion: 1, template });
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
	/** spec/pull-requests-and-ci#review-crew: `Restore default crews` brings every hidden built-in crew back. */
	restoreCrews() {
		return this.serial(async () => {
			await unlink(await safePath(this.root, hiddenCrewsPath)).catch((error) => {
				if (!(isRecord(error) && error.code === 'ENOENT')) throw error;
			});
		});
	}
}
