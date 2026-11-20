import { mkdtemp, rm, writeFile, mkdir, symlink, readFile, readdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test, expect } from 'vitest';
import {
	builtinAgentTemplates,
	builtinCrewTemplates,
	crewRightsInstructions,
	starterCrewTemplate,
	templateLookup,
	type AgentTemplate,
	type CrewTemplate,
} from '@brigadir/core';
import { TemplateStore } from './templates';
import { newJson } from './session';
const designer: AgentTemplate = {
	id: 'ux',
	name: 'Designer',
	role: 'reviewer',
	instructions: 'Check screens.',
	builtin: false,
};
const crew: CrewTemplate = {
	schemaVersion: 1,
	id: 'front',
	name: 'Front + Design',
	builtin: false,
	root: {
		id: 'root',
		name: 'Foreman',
		template: 'foreman-default',
		agents: [
			{ id: 'ui', name: 'UI', template: 'developer', checkedBy: ['design'] },
			{ id: 'design', name: 'Design', template: 'ux' },
		],
	},
};
test('stores own templates next to built-ins, refuses built-in writes and reports invalid files', async () => {
	const root = await mkdtemp(join(tmpdir(), 'templates-'));
	try {
		const store = new TemplateStore(root);
		expect(await store.read()).toEqual({
			agents: [...builtinAgentTemplates],
			crews: [...builtinCrewTemplates],
			issues: [],
			hiddenCrews: [],
		});
		await store.saveAgent(designer);
		await store.saveCrew(crew);
		const text = await readFile(join(root, 'templates', 'crews', 'front.json'), 'utf8');
		expect(text.startsWith('{\n  "schemaVersion": 2,\n  "template": {')).toBe(true);
		expect(JSON.parse(text).template).toEqual(crew);
		let library = await store.read();
		expect(library.agents.map((item) => item.id)).toEqual([
			'foreman-default',
			'developer',
			'senior-developer',
			'tester',
			'technical-writer',
			'reviewer',
			'designer',
			'security-reviewer',
			'ux',
		]);
		expect(library.crews.map((item) => item.id)).toEqual(['review', 'front']);
		expect(library.issues).toEqual([]);
		await expect(store.saveAgent({ ...builtinAgentTemplates[0]!, builtin: false })).rejects.toThrow(
			'read-only'
		);
		await expect(store.saveCrew({ ...crew, id: 'review' })).rejects.toThrow('read-only');
		await expect(
			store.saveCrew({
				...crew,
				id: 'broken',
				root: {
					...crew.root,
					agents: [{ id: 'ui', name: 'UI', template: 'developer', checkedBy: ['nobody'] }],
				},
			})
		).rejects.toThrow('unknown agent');
		await writeFile(
			join(root, 'templates', 'agents', 'bad.json'),
			'{"schemaVersion":1,"template":{"id":"other"}}'
		);
		await mkdir(join(root, 'templates', 'crews'), { recursive: true });
		await symlink(
			join(root, 'templates', 'crews', 'front.json'),
			join(root, 'templates', 'crews', 'link.json')
		);
		await writeFile(
			join(root, 'templates', 'crews', 'newer.json'),
			'{"schemaVersion":3,"template":{}}'
		);
		library = await store.read();
		expect(library.issues).toEqual(
			expect.arrayContaining([
				{ path: 'templates/agents/bad.json', code: 'invalid_document' },
				{ path: 'templates/crews/link.json', code: 'unsafe_path' },
				{ path: 'templates/crews/newer.json', code: 'unsupported_schema' },
			])
		);
		expect(library.crews.map((item) => item.id)).toEqual(['review', 'front']);
		// Deleting the agent template makes the crew that references it an issue; the file itself is untouched.
		await store.deleteAgent('ux');
		library = await store.read();
		expect(library.crews.map((item) => item.id)).toEqual(['review']);
		expect(library.issues).toEqual(
			expect.arrayContaining([{ path: 'templates/crews/front.json', code: 'invalid_document' }])
		);
		expect(
			JSON.parse(await readFile(join(root, 'templates', 'crews', 'front.json'), 'utf8')).template
		).toEqual(crew);
		await store.deleteCrew('front');
		await expect(store.deleteCrew('compose')).rejects.toThrow('read-only');
	} finally {
		await rm(root, { recursive: true, force: true });
	}
});

test("a built-in role keeps a person's provider, model and effort beside the app's name and instructions (spec/agents-and-providers#catalog)", async () => {
	const root = await mkdtemp(join(tmpdir(), 'templates-builtin-'));
	try {
		const store = new TemplateStore(root),
			reviewer = builtinAgentTemplates.find((item) => item.id === 'reviewer')!;
		// Name and instructions sent with the save are ignored: only the launch part is the person's.
		await store.saveAgent({
			...reviewer,
			name: 'Critic',
			instructions: 'Write code.',
			provider: 'codex',
			choices: {
				modeId: 'read-only',
				configOptions: { model: 'gpt-6-astra', reasoning_effort: 'xhigh' },
			},
			choiceNames: { model: '6 Astra', reasoning_effort: 'Xhigh' },
		});
		const file = JSON.parse(
			await readFile(join(root, 'templates', 'builtin', 'reviewer.json'), 'utf8')
		);
		expect(file).toEqual({
			schemaVersion: 1,
			template: {
				id: 'reviewer',
				provider: 'codex',
				choices: { configOptions: { model: 'gpt-6-astra', reasoning_effort: 'xhigh' } },
				choiceNames: { model: '6 Astra', reasoning_effort: 'Xhigh' },
			},
		});
		let library = await store.read();
		const read = library.agents.find((item) => item.id === 'reviewer')!;
		expect(read).toEqual({
			...reviewer,
			provider: 'codex',
			choices: { configOptions: { model: 'gpt-6-astra', reasoning_effort: 'xhigh' } },
			choiceNames: { model: '6 Astra', reasoning_effort: 'Xhigh' },
		});
		expect(library.issues).toEqual([]);
		// The built-in crew resolves through the overlaid role.
		expect(templateLookup(library.agents)('reviewer')?.provider).toBe('codex');
		// No choices: the file goes and the role is the app's again.
		await store.saveAgent({ ...reviewer });
		library = await store.read();
		expect(library.agents.find((item) => item.id === 'reviewer')).toEqual(reviewer);
		await expect(
			readFile(join(root, 'templates', 'builtin', 'reviewer.json'), 'utf8')
		).rejects.toThrow();
		await mkdir(join(root, 'templates', 'builtin'), { recursive: true });
		await writeFile(
			join(root, 'templates', 'builtin', 'developer.json'),
			'{"schemaVersion":1,"template":{"id":"developer","name":"Hijack"}}'
		);
		library = await store.read();
		expect(library.agents.find((item) => item.id === 'developer')).toEqual(
			builtinAgentTemplates.find((item) => item.id === 'developer')
		);
		expect(library.issues).toEqual([
			{ path: 'templates/builtin/developer.json', code: 'invalid_document' },
		]);
	} finally {
		await rm(root, { recursive: true, force: true });
	}
});

test('a built-in crew is hidden on delete and comes back on restore; built-in agents stay (spec/pull-requests-and-ci#review-crew)', async () => {
	const root = await mkdtemp(join(tmpdir(), 'templates-hidden-'));
	const file = join(root, 'templates', 'builtin', 'hidden-crews.json');
	try {
		const store = new TemplateStore(root);
		await store.saveAgent(designer);
		await store.saveCrew(crew);
		await store.deleteCrew('review');
		expect(JSON.parse(await readFile(file, 'utf8'))).toEqual({
			schemaVersion: 1,
			crews: ['review'],
		});
		let library = await store.read();
		expect(library.crews.map((item) => item.id)).toEqual(['front']);
		expect(library.hiddenCrews).toEqual(['review']);
		expect(library.issues).toEqual([]);
		// Hiding twice keeps one entry.
		await store.deleteCrew('review');
		expect(JSON.parse(await readFile(file, 'utf8')).crews).toEqual(['review']);
		// Built-in agents and the compose slot are not deletable.
		for (const agent of builtinAgentTemplates)
			await expect(store.deleteAgent(agent.id)).rejects.toThrow('read-only');
		await expect(store.deleteCrew('foreman-default')).rejects.toThrow('read-only');
		expect((await store.read()).agents.map((item) => item.id)).toEqual([
			'foreman-default',
			'developer',
			'senior-developer',
			'tester',
			'technical-writer',
			'reviewer',
			'designer',
			'security-reviewer',
			'ux',
		]);
		await store.restoreCrews();
		await expect(readFile(file, 'utf8')).rejects.toThrow();
		library = await store.read();
		expect(library.crews.map((item) => item.id)).toEqual(['review', 'front']);
		expect(library.hiddenCrews).toEqual([]);
		// Restoring with nothing hidden is a no-op.
		await store.restoreCrews();
		// A broken file is an issue and hides nothing; ids the app does not ship, with no edit waiting, are dropped.
		await writeFile(file, '{"schemaVersion":1,"crews":"review"}');
		library = await store.read();
		expect(library.crews.map((item) => item.id)).toEqual(['review', 'front']);
		expect(library.hiddenCrews).toEqual([]);
		expect(library.issues).toEqual([
			{ path: 'templates/builtin/hidden-crews.json', code: 'invalid_document' },
		]);
		await writeFile(file, 'not json');
		expect((await store.read()).issues).toEqual([
			{ path: 'templates/builtin/hidden-crews.json', code: 'unreadable' },
		]);
		await writeFile(file, '{"schemaVersion":1,"crews":["gone","default","tests","review"]}');
		library = await store.read();
		expect(library.hiddenCrews).toEqual(['review']);
		expect(library.issues).toEqual([]);
		// Deleting over a broken file starts a fresh one.
		await writeFile(file, '{"schemaVersion":2,"crews":[]}');
		await store.deleteCrew('review');
		library = await store.read();
		expect(library.hiddenCrews).toEqual(['review']);
		expect(library.issues).toEqual([]);
	} finally {
		await rm(root, { recursive: true, force: true });
	}
});
test("a built-in crew keeps a person's edit beside the app's id and name, and the app's own tree removes it (spec/crew-templates-and-editor#builtin-templates)", async () => {
	const root = await mkdtemp(join(tmpdir(), 'templates-crew-edit-'));
	const file = join(root, 'templates', 'builtin', 'review.json');
	const base = builtinCrewTemplates.find((item) => item.id === 'review')!;
	const edited: CrewTemplate = {
		...base,
		name: 'Renamed',
		root: {
			...base.root,
			agents: [
				{ id: 'opus', name: 'Opus', template: 'security-reviewer' },
				{ id: 'design', name: 'Design', template: 'designer' },
			],
		},
	};
	try {
		const store = new TemplateStore(root);
		const saved = await store.saveCrew(edited);
		// The id, the name and `builtin` stay the app's; the tree is the person's.
		expect(saved).toEqual({ ...edited, name: 'Review crew' });
		expect(JSON.parse(await readFile(file, 'utf8'))).toEqual({ schemaVersion: 2, template: saved });
		let library = await store.read();
		expect(library.crews).toEqual([saved]);
		expect(library.issues).toEqual([]);
		// Hiding keeps the edit; restoring brings the edited crew back.
		await store.deleteCrew('review');
		expect((await store.read()).crews).toEqual([]);
		await store.restoreCrews();
		expect((await store.read()).crews[0]).toEqual(saved);
		// A tree that fails against the library is refused and changes nothing.
		await expect(
			store.saveCrew({
				...base,
				root: {
					...base.root,
					agents: [{ id: 'ui', name: 'UI', template: 'developer', checkedBy: ['nobody'] }],
				},
			})
		).rejects.toThrow('unknown agent');
		expect((await store.read()).crews[0]).toEqual(saved);
		// A built-in id without `builtin` is still no own template.
		await expect(store.saveCrew({ ...edited, builtin: false })).rejects.toThrow('read-only');
		// A broken file is an issue and the app's crew stands in.
		await writeFile(file, '{"schemaVersion":1,"template":{"id":"default"}}');
		library = await store.read();
		expect(library.crews[0]).toEqual(base);
		expect(library.issues).toEqual([
			{ path: 'templates/builtin/review.json', code: 'invalid_document' },
		]);
		// The app's own tree, in any key order, removes the file.
		await store.saveCrew(edited);
		expect(await store.saveCrew(JSON.parse(JSON.stringify(base)) as CrewTemplate)).toEqual(base);
		await expect(readFile(file, 'utf8')).rejects.toThrow();
		expect(await store.read()).toMatchObject({ crews: [...builtinCrewTemplates], issues: [] });
	} finally {
		await rm(root, { recursive: true, force: true });
	}
});
test("a person's edit of a crew the app no longer ships becomes their own crew under the same id (spec/crew-templates-and-editor#unshipped-crew-ids)", async () => {
	const root = await mkdtemp(join(tmpdir(), 'templates-unshipped-'));
	const builtin = join(root, 'templates', 'builtin'),
		hiddenFile = join(builtin, 'hidden-crews.json');
	// What the app wrote for an edit of the crew it shipped as `default`: the app's id and name, `builtin: true`.
	const edit: CrewTemplate = {
		...starterCrewTemplate,
		id: 'default',
		name: 'Crew',
		builtin: true,
		root: {
			...starterCrewTemplate.root,
			agents: [
				{ id: 'api', name: 'API', template: 'senior-developer', zone: ['api/**'] },
				{ id: 'ui', name: 'UI', template: 'developer', checkedBy: ['design'] },
				{ id: 'design', name: 'Design', template: 'designer' },
			],
		},
	};
	const write = async (id: string, template: unknown) => {
		await mkdir(builtin, { recursive: true });
		await writeFile(join(builtin, `${id}.json`), JSON.stringify({ schemaVersion: 1, template }));
	};
	try {
		const store = new TemplateStore(root);
		await write('default', edit);
		// A hidden one waits, untouched, and keeps «Restore built-in crews» offered.
		await write('tests', { ...edit, id: 'tests', name: 'Crew with tests' });
		await writeFile(hiddenFile, JSON.stringify({ schemaVersion: 1, crews: ['tests'] }));
		let library = await store.read();
		const own = { ...edit, builtin: false };
		expect(library.crews).toEqual([...builtinCrewTemplates, own]);
		expect(library.hiddenCrews).toEqual(['tests']);
		expect(library.issues).toEqual([]);
		expect(
			JSON.parse(await readFile(join(root, 'templates', 'crews', 'default.json'), 'utf8'))
		).toEqual({ schemaVersion: 2, template: own });
		await expect(readFile(join(builtin, 'default.json'), 'utf8')).rejects.toThrow();
		expect(JSON.parse(await readFile(join(builtin, 'tests.json'), 'utf8')).template.id).toBe(
			'tests'
		);
		// The moved crew is an own crew: saved in place, and deleted for real.
		const renamed = await store.saveCrew({ ...own, name: 'My crew' });
		expect((await store.read()).crews.at(-1)).toEqual(renamed);
		// Restoring brings the hidden edit back as an own crew too.
		await store.restoreCrews();
		library = await store.read();
		expect(library.crews.map((item) => [item.id, item.name, item.builtin])).toEqual([
			['review', 'Review crew', true],
			['tests', 'Crew with tests', false],
			['default', 'My crew', false],
		]);
		expect(library.hiddenCrews).toEqual([]);
		await store.deleteCrew('default');
		expect((await store.read()).crews.map((item) => item.id)).toEqual(['review', 'tests']);
		// An invalid file stays where it is and is listed; an own crew already under the id is never overwritten.
		await write('default', { id: 'default' });
		library = await store.read();
		expect(library.issues).toEqual([
			{ path: 'templates/builtin/default.json', code: 'invalid_document' },
		]);
		await write('tests', { ...edit, id: 'tests', name: 'Other' });
		library = await store.read();
		expect(library.crews.find((item) => item.id === 'tests')!.name).toBe('Crew with tests');
		expect(JSON.parse(await readFile(join(builtin, 'tests.json'), 'utf8')).template.name).toBe(
			'Other'
		);
		// An edit that fails against the agent library moves anyway and is listed like any own crew.
		await rm(join(builtin, 'default.json'));
		await write('default', {
			...edit,
			root: { ...edit.root, agents: [{ id: 'x', name: 'X', template: 'gone' }] },
		});
		library = await store.read();
		expect(library.crews.some((item) => item.id === 'default')).toBe(false);
		expect(library.issues).toEqual([
			{ path: 'templates/crews/default.json', code: 'invalid_document' },
		]);
	} finally {
		await rm(root, { recursive: true, force: true });
	}
});
test('moves an edit once under concurrent reads and never overwrites the moved crew or a later edit of it (spec/crew-templates-and-editor#unshipped-crew-ids)', async () => {
	const root = await mkdtemp(join(tmpdir(), 'templates-unshipped-race-'));
	const builtin = join(root, 'templates', 'builtin'),
		source = join(builtin, 'default.json'),
		target = join(root, 'templates', 'crews', 'default.json');
	const edit: CrewTemplate = { ...starterCrewTemplate, id: 'default', name: 'Crew', builtin: true };
	const document = JSON.stringify({ schemaVersion: 1, template: edit });
	try {
		await mkdir(builtin, { recursive: true });
		await writeFile(source, document);
		// Main opens a store per call: readers on separate instances race for the same move.
		const libraries = await Promise.all(
			Array.from({ length: 6 }, () => new TemplateStore(root).read())
		);
		for (const library of libraries) {
			expect(library.issues).toEqual([]);
			expect(library.crews.filter((item) => item.id === 'default')).toEqual([
				{ ...edit, builtin: false },
			]);
		}
		await expect(readFile(source, 'utf8')).rejects.toThrow();
		// The person edits the moved crew; a reader that still holds the old document (here: the file back in place) cannot replace that edit.
		const mine = await new TemplateStore(root).saveCrew({
			...edit,
			builtin: false,
			name: 'Mine',
		});
		await writeFile(source, document);
		await Promise.all([new TemplateStore(root).read(), new TemplateStore(root).read()]);
		expect(JSON.parse(await readFile(target, 'utf8')).template).toEqual(mine);
		// The document that found its place taken stays where it was.
		expect(await readFile(source, 'utf8')).toBe(document);
	} finally {
		await rm(root, { recursive: true, force: true });
	}
});
test('reports an unsafe edit file of a crew the app does not ship instead of failing the library (spec/crew-templates-and-editor#unshipped-crew-ids)', async () => {
	const root = await mkdtemp(join(tmpdir(), 'templates-unshipped-link-'));
	const builtin = join(root, 'templates', 'builtin');
	try {
		await mkdir(builtin, { recursive: true });
		const elsewhere = join(root, 'elsewhere.json');
		await writeFile(
			elsewhere,
			JSON.stringify({
				schemaVersion: 1,
				template: { ...starterCrewTemplate, id: 'default', builtin: true },
			})
		);
		await symlink(elsewhere, join(builtin, 'default.json'));
		await symlink(elsewhere, join(builtin, 'tests.json'));
		await writeFile(
			join(builtin, 'hidden-crews.json'),
			JSON.stringify({ schemaVersion: 1, crews: ['tests'] })
		);
		const library = await new TemplateStore(root).read();
		expect(library.crews).toEqual([...builtinCrewTemplates]);
		// A symlink holds no edit: the hidden id offers nothing to restore.
		expect(library.hiddenCrews).toEqual([]);
		expect(library.issues).toEqual([
			{ path: 'templates/builtin/default.json', code: 'unsafe_path' },
		]);
		await expect(
			readFile(join(root, 'templates', 'crews', 'default.json'), 'utf8')
		).rejects.toThrow();
	} finally {
		await rm(root, { recursive: true, force: true });
	}
});
test('creates a document only where nothing is, in one step, so a slower writer never replaces it', async () => {
	const root = await mkdtemp(join(tmpdir(), 'templates-new-json-'));
	const path = join(root, 'crew.json');
	try {
		const first = await Promise.all(
			Array.from({ length: 8 }, (_, index) => newJson(path, { schemaVersion: 1, index }))
		);
		expect(first.filter(Boolean)).toHaveLength(1);
		const winner = first.indexOf(true);
		expect(JSON.parse(await readFile(path, 'utf8'))).toEqual({ schemaVersion: 1, index: winner });
		await writeFile(path, 'edited');
		expect(await newJson(path, { schemaVersion: 1 })).toBe(false);
		expect(await readFile(path, 'utf8')).toBe('edited');
		// No temp file is left behind either way.
		expect(await readdir(root)).toEqual(['crew.json']);
	} finally {
		await rm(root, { recursive: true, force: true });
	}
});

// spec/crew-templates-and-editor#schema
test('reads version 1 roles and crews as version 2 and writes them so at the next save', async () => {
	const root = await mkdtemp(join(tmpdir(), 'templates-v1-'));
	const agents = join(root, 'templates', 'agents'),
		crews = join(root, 'templates', 'crews');
	const old = {
		id: 'frontend',
		name: 'Frontend dev',
		role: 'developer',
		summary: 'React screens of the admin app',
		instructions: `${crewRightsInstructions.developer}\n\nUse the admin's design tokens.`,
		builtin: false,
	};
	// A copy of a built-in's text that is not its rights' rules stays as written.
	const own = {
		id: 'writer',
		name: 'Writer',
		role: 'reviewer',
		instructions: 'Read twice.',
		builtin: false,
	};
	const oldCrew = {
		...crew,
		root: {
			...crew.root,
			agents: [
				{
					id: 'ui',
					name: 'UI',
					template: 'frontend',
					summary: 'Owns the screens',
					checkedBy: ['design'],
				},
				{ id: 'design', name: 'Design', template: 'writer' },
			],
		},
	};
	try {
		await mkdir(agents, { recursive: true });
		await mkdir(crews, { recursive: true });
		await writeFile(
			join(agents, 'frontend.json'),
			JSON.stringify({ schemaVersion: 1, template: old })
		);
		await writeFile(
			join(agents, 'writer.json'),
			JSON.stringify({ schemaVersion: 1, template: own })
		);
		await writeFile(
			join(crews, 'front.json'),
			JSON.stringify({ schemaVersion: 1, template: oldCrew })
		);
		const store = new TemplateStore(root);
		const library = await store.read();
		expect(library.issues).toEqual([]);
		const frontend = library.agents.find((item) => item.id === 'frontend')!;
		expect(frontend).toEqual({
			id: 'frontend',
			name: 'Frontend dev',
			role: 'developer',
			whenToUse: 'React screens of the admin app',
			instructions: "Use the admin's design tokens.",
			builtin: false,
		});
		expect(library.agents.find((item) => item.id === 'writer')).toEqual(own);
		const front = library.crews.find((item) => item.id === 'front')!;
		expect(front.root.agents![0]).toEqual({
			id: 'ui',
			name: 'UI',
			template: 'frontend',
			whenToUse: 'Owns the screens',
			checkedBy: ['design'],
		});
		// The files stay as they were until a save writes them as version 2.
		expect(JSON.parse(await readFile(join(agents, 'frontend.json'), 'utf8')).schemaVersion).toBe(1);
		await store.saveAgent(frontend);
		await store.saveCrew(front);
		expect(JSON.parse(await readFile(join(agents, 'frontend.json'), 'utf8'))).toEqual({
			schemaVersion: 2,
			template: frontend,
		});
		expect(JSON.parse(await readFile(join(crews, 'front.json'), 'utf8'))).toEqual({
			schemaVersion: 2,
			template: front,
		});
		expect((await store.read()).agents.find((item) => item.id === 'frontend')).toEqual(frontend);
	} finally {
		await rm(root, { recursive: true, force: true });
	}
});
