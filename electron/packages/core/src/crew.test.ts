import { it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import {
	builtinAgentCustomized,
	builtinCrewCustomized,
	withBuiltinCrew,
	builtinAgentTemplates,
	builtinCrewTemplates,
	isAgentTemplate,
	isBuiltinCrewName,
	isBuiltinTemplateId,
	starterCrewTemplate,
	unshippedCrewLaunch,
	isCrewLaunch,
	rememberedCrewId,
	unshippedCrewTemplateIds,
	type CrewSpec,
	seniorDeveloperTemplateId,
	withBuiltinChoices,
	crewIssues,
	crewIssueText,
	type CrewIssue,
	findSpecAgent,
	isCrewSpec,
	isCrewTemplate,
	normalizeZonePath,
	resolveCrew,
	specChildByName,
	templateLookup,
	zoneCovers,
	zoneOwns,
	type AgentTemplate,
	type CrewTemplate,
	crewRightsInstructions,
	isWhenToUse,
	isAgentTemplateDocument,
	isCrewTemplateDocument,
	ownInstructions,
	roleInstructions,
	specWhenToUse,
	upgradeAgentTemplateDocument,
	upgradeCrewLaunch,
	upgradeCrewTemplateDocument,
	whenToUseLine,
} from './crew';
import { isMessageKey } from './messages';
import {
	addCrewAgent,
	addCrewCheck,
	branchAsCrewTemplate,
	cloneCrewBranch,
	duplicateCrewTemplate,
	removeCrewAgent,
	renameCrewAgent,
	updateCrewAgent,
} from './crew-edit';
import { isAgentTask } from './workspace';
const designer: AgentTemplate = {
	id: 'designer',
	name: 'Designer',
	role: 'reviewer',
	provider: 'claude',
	choices: { configOptions: { model: 'claude-opus' } },
	choiceNames: { model: 'Claude Opus' },
	instructions: 'Check screens against the design.',
	builtin: false,
};
const lookup = templateLookup([designer]);
const crew: CrewTemplate = {
	schemaVersion: 1,
	id: 'ui-api-tests',
	name: 'UI + API + Тести',
	builtin: false,
	root: {
		id: 'root',
		name: 'Бригадир',
		template: 'foreman-default',
		extraInstructions: 'Coordinate the named agents.',
		provider: 'claude',
		choices: { configOptions: { model: 'claude-opus' } },
		agents: [
			{
				id: 'ui-lead',
				name: 'UI-лід',
				template: 'foreman-default',
				zone: ['apps/admin/src/ui/**'],
				agents: [
					{
						id: 'ui-dev',
						name: 'Верстальник',
						template: 'developer',
						checkedBy: ['ui-review'],
						zone: ['apps/admin/src/ui/screens/**'],
					},
					{
						id: 'ui-review',
						name: 'Дизайнер',
						template: 'designer',
						extraInstructions: 'Check the screens against the brief.',
					},
				],
			},
			{
				id: 'api',
				name: 'API',
				template: 'developer',
				provider: 'codex',
				choices: { configOptions: { model: 'gpt-6-astra' } },
				checkedBy: ['review'],
				zone: ['services/api/**'],
			},
			{ id: 'tests', name: 'Тести', template: 'developer', checkedBy: ['review'] },
			{ id: 'review', name: 'Ревʼюер', template: 'reviewer', provider: 'codex' },
		],
	},
};
const defaults = (provider: 'claude' | 'codex') =>
	provider === 'claude'
		? {
				choices: {
					modeId: 'acceptEdits',
					configOptions: { model: 'claude-sonnet', reasoning_effort: 'medium' },
				},
				choiceNames: { model: 'Claude Sonnet', reasoning_effort: 'Medium' },
			}
		: {
				choices: { modeId: 'read-only', configOptions: { model: 'gpt-6-mini' } },
				choiceNames: { model: 'GPT-6 mini' },
			};

it('validates the structure and semantics of a crew template', () => {
	expect(isCrewTemplate(crew)).toBe(true);
	expect(crewIssues(crew, lookup)).toEqual([]);
	for (const builtin of builtinCrewTemplates) {
		expect(isCrewTemplate(builtin)).toBe(true);
		expect(crewIssues(builtin, lookup)).toEqual([]);
	}
	expect(isCrewTemplate({ ...crew, root: { ...crew.root, name: '' } })).toBe(false);
	expect(isCrewTemplate({ ...crew, extra: 1 })).toBe(false);
	expect(isCrewTemplate({ ...crew, root: { ...crew.root, zone: ['../outside'] } })).toBe(false);
	const mutate = (change: (root: CrewTemplate['root']) => void) => {
		const copy = JSON.parse(JSON.stringify(crew)) as CrewTemplate;
		change(copy.root);
		return crewIssues(copy, lookup).map((issue) => issue.code);
	};
	expect(
		mutate((root) => {
			root.agents![1]!.id = 'tests';
		})
	).toContain('duplicate_id');
	expect(
		mutate((root) => {
			root.agents![1]!.name = ' Тести ';
		})
	).toContain('duplicate_name');
	expect(
		mutate((root) => {
			root.agents![1]!.template = 'missing';
		})
	).toContain('unknown_template');
	expect(
		mutate((root) => {
			root.agents![1]!.checkedBy = ['ui-review'];
		})
	).toContain('unknown_checker');
	expect(
		mutate((root) => {
			root.agents![1]!.checkedBy = ['api'];
		})
	).toContain('self_check');
	expect(
		mutate((root) => {
			root.agents![1]!.checkedBy = ['review', 'review'];
		})
	).toContain('duplicate_check');
	expect(
		mutate((root) => {
			root.agents![1]!.checkedBy = ['tests'];
		})
	).toContain('checker_not_reviewer');
	expect(
		mutate((root) => {
			root.agents![3]!.checkedBy = ['review'];
			root.agents![0]!.checkedBy = ['review'];
		})
	).toEqual(expect.arrayContaining(['self_check', 'checked_not_developer']));
	expect(
		mutate((root) => {
			root.agents![3]!.agents = [{ id: 'x', name: 'X', template: 'developer' }];
		})
	).toContain('reviewer_with_agents');
	expect(
		mutate((root) => {
			root.agents![0]!.agents![0]!.zone = ['services/api/**'];
		})
	).toContain('zone_outside_parent');
	expect(
		mutate((root) => {
			root.checkedBy = ['review'];
		})
	).toContain('root_checked');
});
it('words every crew issue in both locales with the agent name, never the English message (spec/notifications-slack-notes-and-schedules#message-classes)', () => {
	const copy = JSON.parse(JSON.stringify(crew)) as CrewTemplate;
	copy.root.agents![1]!.name = ' Тести ';
	const duplicate = crewIssues(copy, lookup).find((issue) => issue.code === 'duplicate_name')!;
	expect(duplicate.subject).toBe('Тести');
	expect(crewIssueText('uk', duplicate)).toBe('Два агенти мають однакову назву: Тести.');
	expect(crewIssueText('en', duplicate)).toBe('Two agents have the same name: Тести.');
	const codes: CrewIssue['code'][] = [
		'duplicate_id',
		'duplicate_name',
		'unknown_template',
		'unknown_checker',
		'self_check',
		'duplicate_check',
		'checker_not_reviewer',
		'checked_not_developer',
		'reviewer_with_agents',
		'zone_outside_parent',
		'root_checked',
	];
	for (const code of codes)
		for (const locale of ['uk', 'en'] as const) {
			const text = crewIssueText(locale, {
				agentId: null,
				code,
				subject: 'Агент 2',
				message: 'raw',
			});
			expect(text).not.toContain('{name}');
			expect(text).not.toContain('raw');
			if (code !== 'root_checked') expect(text).toContain('Агент 2');
		}
});
it('normalizes zones and checks coverage', () => {
	expect(normalizeZonePath(' ./apps//admin/ ')).toBe('apps/admin');
	expect(normalizeZonePath('a/../b')).toBeNull();
	expect(normalizeZonePath('/')).toBeNull();
	expect(zoneCovers([], 'anything')).toBe(true);
	expect(zoneCovers(['apps/admin/src/ui/**'], 'apps/admin/src/ui/screens/*.tsx')).toBe(true);
	expect(zoneCovers(['apps/admin/src/ui/**'], 'apps/admin/src/uix')).toBe(false);
	expect(zoneOwns(['services/api/**'], 'services/api/orders.ts')).toBe(true);
	expect(zoneOwns(['services/api/**'], 'services/web/index.ts')).toBe(false);
});
it('resolves defaults, template and node overrides in order; a provider change drops template choices', () => {
	const spec = resolveCrew(crew, {
		lookup,
		defaultProvider: 'claude',
		defaults,
		now: '2026-09-21T10:00:00.000Z',
	});
	expect(isCrewSpec(spec)).toBe(true);
	expect(spec.templateId).toBe('ui-api-tests');
	expect(spec.root.role).toBe('foreman');
	expect(spec.root.requestedChoices).toEqual({
		modeId: 'acceptEdits',
		configOptions: { model: 'claude-opus', reasoning_effort: 'medium' },
	});
	const api = findSpecAgent(spec.root, 'api')!;
	expect(api.provider).toBe('codex');
	expect(api.requestedChoices).toEqual({
		modeId: 'read-only',
		configOptions: { model: 'gpt-6-astra' },
	});
	expect(api.zone).toEqual(['services/api/**']);
	expect(api.checkedBy).toEqual(['review']);
	// spec/crew-templates-and-editor#rights: Developer has no instructions of its own; its agent gets the rules of its rights.
	expect(api.instructions).toBe(crewRightsInstructions.developer);
	const lead = findSpecAgent(spec.root, 'ui-lead')!;
	expect(lead.role).toBe('foreman');
	expect(lead.zone).toEqual(['apps/admin/src/ui/**']);
	const review = findSpecAgent(spec.root, 'ui-review')!;
	expect(review.role).toBe('reviewer');
	expect(review.zone).toEqual(['apps/admin/src/ui/**']);
	expect(review.requestedChoices.configOptions).toEqual({
		model: 'claude-opus',
		reasoning_effort: 'medium',
	});
	expect(review.choiceNames.model).toBe('Claude Opus');
	expect(review.extraInstructions).toBe('Check the screens against the brief.');
	const tests = findSpecAgent(spec.root, 'tests')!;
	expect(tests.zone).toEqual([]);
	expect(tests.requestedChoices.configOptions).toEqual({
		model: 'claude-sonnet',
		reasoning_effort: 'medium',
	});
	// Node overrides the template's provider: the template's Claude model is not carried to Codex.
	const switched = resolveCrew(
		{
			...crew,
			root: {
				...crew.root,
				agents: [{ id: 'd', name: 'D', template: 'designer', provider: 'codex' }],
			},
		},
		{ lookup, defaultProvider: 'claude', defaults, now: '2026-09-21T10:00:00.000Z' }
	);
	expect(switched.root.agents[0]!.requestedChoices).toEqual({
		modeId: 'read-only',
		configOptions: { model: 'gpt-6-mini' },
	});
	expect(switched.root.agents[0]!.choiceNames).toEqual({ model: 'GPT-6 mini' });
	expect(specChildByName(spec.root, ' API ')?.id).toBe('api');
	expect(specChildByName(spec.root, 'Верстальник')).toBeNull();
	expect(() =>
		resolveCrew(
			{
				...crew,
				root: {
					...crew.root,
					agents: [{ id: 'a', name: 'A', template: 'developer', checkedBy: ['b'] }],
				},
			},
			{ lookup, defaultProvider: 'claude' }
		)
	).toThrow('unknown agent');
	expect(JSON.parse(JSON.stringify(spec))).toEqual(spec);
	const task = { id: 't', projectId: 'p', title: 'Foreman', status: 'queued', crew: spec };
	expect(isAgentTask(task)).toBe(true);
	expect(
		isAgentTask({ id: 'w', projectId: 'p', title: 'W', status: 'queued', crewTaskId: 't' })
	).toBe(false);
	expect(
		isAgentTask({
			id: 'w',
			projectId: 'p',
			title: 'W',
			status: 'queued',
			crewTaskId: 't',
			crewNodeId: 'api',
			parentTaskId: 't',
		})
	).toBe(true);
	expect(isCrewSpec({ ...spec, root: { ...spec.root, role: 'developer' } })).toBe(false);
});
it('edits the tree without breaking edges or ids', () => {
	let next = addCrewAgent(crew, 'root', { id: 'docs', template: 'developer', name: 'Розробник' });
	expect(next.root.agents!.at(-1)).toEqual({
		id: 'docs',
		name: 'Розробник',
		template: 'developer',
		agents: [],
		checkedBy: [],
	});
	next = renameCrewAgent(next, 'docs', 'Документатор');
	expect(next.root.agents!.at(-1)!.name).toBe('Документатор');
	expect(next.root.agents!.at(-1)!.id).toBe('docs');
	expect(() => renameCrewAgent(next, 'docs', 'API')).toThrow('already exists');
	next = addCrewCheck(next, 'docs', 'review');
	expect(next.root.agents!.at(-1)!.checkedBy).toEqual(['review']);
	expect(() => addCrewCheck(next, 'docs', 'ui-review')).toThrow('one parent');
	next = removeCrewAgent(next, 'review');
	expect(next.root.agents!.map((agent) => agent.checkedBy ?? [])).toEqual([[], [], [], []]);
	expect(crewIssues(next, lookup)).toEqual([]);
	// A leaf gaining a child becomes a foreman of its branch and keeps its draft; removing the last child restores it.
	let branch = addCrewAgent(crew, 'api', {
		id: 'api-dev',
		template: 'developer',
		name: 'Ендпоінти',
	});
	const lead = branch.root.agents![1]!;
	expect(lead.template).toBe('foreman-default');
	expect(lead.provider).toBeUndefined();
	expect(lead.leafDraft).toEqual({
		template: 'developer',
		provider: 'codex',
		choices: { configOptions: { model: 'gpt-6-astra' } },
	});
	expect(lead.checkedBy).toEqual([]);
	expect(() => updateCrewAgent(branch, 'api', { template: 'developer' })).toThrow('Foreman');
	branch = removeCrewAgent(branch, 'api-dev');
	expect(branch.root.agents![1]).toEqual({
		id: 'api',
		name: 'API',
		template: 'developer',
		provider: 'codex',
		choices: { configOptions: { model: 'gpt-6-astra' } },
		zone: ['services/api/**'],
		checkedBy: [],
		agents: [],
	});
	// Cloning a branch rewrites internal edges and gives fresh ids and unique names.
	let counter = 0;
	const cloned = cloneCrewBranch(crew, 'ui-lead', () => `n${++counter}`);
	const copy = cloned.root.agents![1]!;
	expect(copy.id).toBe('n1');
	expect(copy.name).toBe('UI-лід 2');
	expect(copy.agents!.map((agent) => agent.id)).toEqual(['n2', 'n3']);
	expect(copy.agents![0]!.checkedBy).toEqual(['n3']);
	expect(copy.agents!.map((agent) => agent.name)).toEqual(['Верстальник 2', 'Дизайнер 2']);
	expect(crewIssues(cloned, lookup)).toEqual([]);
	const dup = duplicateCrewTemplate(crew, 'copy', 'Копія');
	expect(dup.id).toBe('copy');
	expect(dup.root.agents![0]!.id).toBe('ui-lead');
	expect(dup.builtin).toBe(false);
	const own = branchAsCrewTemplate(crew, 'ui-lead', 'ui-crew', 'UI');
	expect(own.root.id).toBe('ui-lead');
	expect(own.root.zone).toBeUndefined();
	expect(own.root.agents!.length).toBe(2);
	expect(crewIssues(own, lookup)).toEqual([]);
	expect(() => removeCrewAgent(crew, 'root')).toThrow();
	expect(() => branchAsCrewTemplate(crew, 'api', 'x', 'X')).toThrow();
});
it('resolves When to use from the node, else the template, and validates it as one line (spec/crew-templates-and-editor#roster)', () => {
	const tester: AgentTemplate = {
		id: 'tester',
		name: 'Tester',
		role: 'developer',
		whenToUse: 'Writes e2e tests.',
		instructions: '',
		builtin: false,
	};
	const template: CrewTemplate = {
		schemaVersion: 1,
		id: 's',
		name: 'S',
		builtin: false,
		root: {
			id: 'root',
			name: 'F',
			template: 'foreman-default',
			agents: [
				{ id: 'a', name: 'A', template: 'tester' },
				{ id: 'b', name: 'B', template: 'tester', whenToUse: '  Owns the fixtures.  ' },
				{ id: 'c', name: 'C', template: 'tester', whenToUse: '   ' },
				{ id: 'd', name: 'D', template: null },
			],
		},
	};
	expect(isCrewTemplate(template)).toBe(true);
	const spec = resolveCrew(template, {
		lookup: templateLookup([tester]),
		defaultProvider: 'claude',
		now: '2026-09-25T10:00:00.000Z',
	});
	expect(spec.root.agents.map((agent) => agent.whenToUse)).toEqual([
		'Writes e2e tests.',
		'Owns the fixtures.',
		'Writes e2e tests.',
		'',
	]);
	expect(isCrewSpec(spec)).toBe(true);
	// Snapshots written before spec/crew-templates-and-editor#roster have no line and stay readable.
	const { whenToUse: line, ...legacy } = spec.root.agents[0]!;
	const withAgent = (agent: object) => ({
		...spec,
		root: { ...spec.root, agents: [agent, ...spec.root.agents.slice(1)] },
	});
	expect(isCrewSpec(withAgent(legacy))).toBe(true);
	// spec/crew-templates-and-editor#schema: an older snapshot keeps the line as `summary`; both names at once are not a snapshot.
	expect(isCrewSpec(withAgent({ ...legacy, summary: line }))).toBe(true);
	expect(specWhenToUse({ ...legacy, summary: line! })).toBe('Writes e2e tests.');
	expect(isCrewSpec(withAgent({ ...legacy, summary: line, whenToUse: line }))).toBe(false);
	expect(isCrewTemplate({ ...template, root: { ...template.root, whenToUse: 'two\nlines' } })).toBe(
		false
	);
	expect(
		isCrewTemplate({ ...template, root: { ...template.root, whenToUse: 'x'.repeat(241) } })
	).toBe(false);
	// The former name is not part of the current shape: it is upgraded on read.
	expect(isCrewTemplate({ ...template, root: { ...template.root, summary: 'x' } })).toBe(false);
	expect(updateCrewAgent(template, 'b', { whenToUse: undefined }).root.agents![1]).toEqual({
		id: 'b',
		name: 'B',
		template: 'tester',
	});
});
// spec/crew-templates-and-editor#builtin-templates
it('ships Senior developer with a model, and an overlay replaces its provider and choices whole', () => {
	const senior = builtinAgentTemplates.find((item) => item.id === seniorDeveloperTemplateId)!;
	expect(isAgentTemplate(senior)).toBe(true);
	expect(senior).toMatchObject({
		role: 'developer',
		provider: 'claude',
		choices: { configOptions: { model: 'opus', effort: 'high' } },
	});
	expect(builtinAgentCustomized(senior)).toBe(false);
	const onCodex = withBuiltinChoices(senior, { id: senior.id, provider: 'codex' });
	expect(onCodex.provider).toBe('codex');
	expect(onCodex.choices).toBeUndefined();
	expect(onCodex.choiceNames).toBeUndefined();
	expect(onCodex.whenToUse).toBe(senior.whenToUse);
	expect(builtinAgentCustomized(onCodex)).toBe(true);
	// The same values in another key order are the app's own.
	expect(
		builtinAgentCustomized({
			...senior,
			choices: { configOptions: { effort: 'high', model: 'opus' } },
		})
	).toBe(false);
	const developer = builtinAgentTemplates.find((item) => item.id === 'developer')!;
	expect(builtinAgentCustomized(developer)).toBe(false);
	expect(builtinAgentCustomized({ ...developer, provider: 'codex' })).toBe(true);
});
it("a built-in crew is customized when its tree differs from the app's (spec/crew-templates-and-editor#builtin-templates)", () => {
	const base = builtinCrewTemplates.find((item) => item.id === 'review')!;
	expect(builtinCrewCustomized(base)).toBe(false);
	// Key order and absent values are no difference.
	expect(
		builtinCrewCustomized({
			...base,
			root: {
				agents: base.root.agents!,
				template: base.root.template,
				name: 'Foreman',
				id: 'root',
			},
		})
	).toBe(false);
	const edited = withBuiltinCrew(base, {
		...base,
		id: 'other',
		name: 'Renamed',
		builtin: false,
		root: {
			...base.root,
			agents: base.root.agents!.slice(0, 1).map(({ checkedBy: _, ...agent }) => agent),
		},
	});
	expect(edited).toMatchObject({ id: 'review', name: 'Review crew', builtin: true });
	expect(builtinCrewCustomized(edited)).toBe(true);
	// An own crew is never a customized built-in.
	expect(builtinCrewCustomized({ ...edited, id: 'own', builtin: false })).toBe(false);
	expect(withBuiltinCrew(base, undefined)).toBe(base);
});
it('ships the profiles as a Developer or a Reviewer with When to use, and the review crew as the only built-in crew (spec/crew-templates-and-editor#builtin-templates)', () => {
	const roles = Object.fromEntries(builtinAgentTemplates.map((item) => [item.id, item.role]));
	expect(roles).toEqual({
		'foreman-default': 'foreman',
		developer: 'developer',
		'senior-developer': 'developer',
		tester: 'developer',
		'technical-writer': 'developer',
		reviewer: 'reviewer',
		designer: 'reviewer',
		'security-reviewer': 'reviewer',
	});
	for (const template of builtinAgentTemplates) {
		expect(isAgentTemplate(template)).toBe(true);
		expect(isBuiltinCrewName(template.name)).toBe(true);
		expect(builtinAgentCustomized(template)).toBe(false);
		// spec/crew-templates-and-editor#builtin-templates: every built-in role says when to use it, in a line the library translates.
		expect(isWhenToUse(template.whenToUse)).toBe(true);
		expect(isMessageKey(template.whenToUse!)).toBe(true);
	}
	const lookup = templateLookup([]);
	for (const crew of builtinCrewTemplates) expect(crewIssues(crew, lookup)).toEqual([]);
	// A tree of developers chosen before the task is read is not shipped: the foreman composes one (spec/crew#compose).
	expect(builtinCrewTemplates.map((item) => item.id)).toEqual(['review']);
	for (const id of unshippedCrewTemplateIds) expect(isBuiltinTemplateId(id)).toBe(false);
	// The starter tree of «New crew» and the intro is a valid crew that the library does not list.
	expect(isCrewTemplate(starterCrewTemplate)).toBe(true);
	expect(crewIssues(starterCrewTemplate, lookup)).toEqual([]);
	expect(starterCrewTemplate.builtin).toBe(false);
	expect(isBuiltinTemplateId(starterCrewTemplate.id)).toBe(false);
	expect(
		starterCrewTemplate.root.agents!.map((item) => [item.name, item.template, item.checkedBy])
	).toEqual([
		['Developer 1', 'developer', ['reviewer']],
		['Developer 2', 'developer', ['reviewer']],
		['Reviewer', 'reviewer', undefined],
	]);
});
it('runs a stored launch of a crew the app no longer ships, or of a composing foreman, as Auto (spec/crew-templates-and-editor#unshipped-crew-ids)', () => {
	const crews = [...builtinCrewTemplates];
	expect(unshippedCrewLaunch({ templateId: 'default' }, crews)).toEqual({ auto: true });
	expect(unshippedCrewLaunch({ templateId: 'tests' }, crews)).toEqual({ auto: true });
	expect(unshippedCrewLaunch({ templateId: 'compose' }, crews)).toEqual({ auto: true });
	expect(unshippedCrewLaunch({ compose: true }, crews)).toEqual({ auto: true });
	expect(
		unshippedCrewLaunch(
			{
				compose: true,
				template: { ...starterCrewTemplate, root: { ...starterCrewTemplate.root, agents: [] } },
			},
			crews
		)
	).toEqual({ auto: true });
	expect(unshippedCrewLaunch({ auto: true }, crews)).toEqual({ auto: true });
	// A person's edit moved to an own crew under the same id keeps the schedule on that crew.
	const adopted = [...crews, { ...starterCrewTemplate, id: 'default' }];
	expect(unshippedCrewLaunch({ templateId: 'default' }, adopted)).toEqual({
		templateId: 'default',
	});
	// Any other missing id stays as it is, so the run fails as for a deleted crew.
	expect(unshippedCrewLaunch({ templateId: 'gone' }, crews)).toEqual({ templateId: 'gone' });
	expect(unshippedCrewLaunch({ templateId: 'review' }, crews)).toEqual({ templateId: 'review' });
	expect(isCrewLaunch({ auto: true })).toBe(true);
	expect(isCrewLaunch({ auto: true, templateId: 'review' })).toBe(false);
});
it('opens the sheet on Auto unless the task’s own crew is still in the library (spec/tasks#sheet-rail)', () => {
	const crews = [...builtinCrewTemplates];
	expect(rememberedCrewId('default', crews)).toBe('auto');
	expect(rememberedCrewId('tests', crews)).toBe('auto');
	expect(rememberedCrewId(undefined, crews)).toBe('auto');
	expect(rememberedCrewId('compose', crews)).toBe('auto');
	expect(rememberedCrewId('gone', crews)).toBe('auto');
	expect(rememberedCrewId('review', crews)).toBe('review');
	// A person's edit moved to an own crew under the same id stays that crew.
	expect(rememberedCrewId('default', [...crews, { ...starterCrewTemplate, id: 'default' }])).toBe(
		'default'
	);
});
it('keeps an old task snapshot of a crew the app no longer ships valid, with the role texts it was resolved with (spec/crew-templates-and-editor#snapshot)', () => {
	const old = JSON.parse(
		readFileSync(new URL('./fixtures/crew-snapshot-default.json', import.meta.url), 'utf8')
	) as unknown;
	expect(isCrewSpec(old)).toBe(true);
	const spec = old as CrewSpec;
	expect(spec.templateId).toBe('default');
	const designer = findSpecAgent(spec.root, 'designer')!;
	expect(designer.instructions).toContain('neighbouring screens and the design tokens');
	expect(designer.instructions).not.toBe(
		builtinAgentTemplates.find((item) => item.id === 'designer')!.instructions
	);
});
it('makes the Designer check against the design source, node by node, and keeps the Tester off manual app checks (spec/crew-templates-and-editor#builtin-templates)', () => {
	// What the agent of a built-in role reads: the rules of its rights, then the role's own instructions.
	const text = (id: string) => {
		const role = builtinAgentTemplates.find((item) => item.id === id)!;
		return roleInstructions(role.role, role.instructions);
	};
	const designer = text('designer');
	for (const phrase of [
		'a Figma node or frame, a mock-up file, or a reference screen',
		'ask the foreman for it with ask_foreman; do not judge from neighbouring screens',
		'node, property, expected from the design, found in the app, screenshot',
		'List the icons one by one',
		'Never approve from the code alone, and never without having opened the screen and the design',
		'do not approve',
		'simulator_act and browser_act already wait for the screen',
		'use simulator_wait',
		'names the node, the property, what the design expects and what you found',
		'read_report',
		'read_diff',
		'submit_review',
		'approve',
	])
		expect(designer).toContain(phrase);
	expect(designer).not.toContain(
		'Compare spacing, sizes and colours with the neighbouring screens'
	);
	const tester = text('tester');
	expect(tester).toContain('automated tests');
	expect(tester).toContain('Checking the running app by hand is not your job');
	expect(tester).toContain('10 minutes when it states none');
	for (const id of ['tester', 'designer'])
		expect(
			builtinAgentTemplates.find((item) => item.id === id)!.whenToUse!.length
		).toBeLessThanOrEqual(240);
});
// spec/crew-templates-and-editor#schema
it('reads version 1 roles and crews in the current shape, without a second copy of the rights', () => {
	const rules = crewRightsInstructions.developer;
	const doc = upgradeAgentTemplateDocument({
		schemaVersion: 1,
		template: {
			id: 'front',
			name: 'Front',
			role: 'developer',
			summary: 'React screens',
			instructions: `${rules}\n\nUse the tokens.`,
			builtin: false,
		},
	});
	expect(isAgentTemplateDocument(doc)).toBe(true);
	expect(doc).toEqual({
		schemaVersion: 2,
		template: {
			id: 'front',
			name: 'Front',
			role: 'developer',
			whenToUse: 'React screens',
			instructions: 'Use the tokens.',
			builtin: false,
		},
	});
	// A duplicate of Developer is the rules alone; any other text stays as written; a version 2 document is left alone.
	expect(ownInstructions('developer', rules)).toBe('');
	expect(ownInstructions('developer', 'Read the spec first.')).toBe('Read the spec first.');
	expect(ownInstructions('foreman', 'Lead.')).toBe('Lead.');
	const current = { schemaVersion: 2, template: { ...builtinAgentTemplates[1]!, builtin: false } };
	expect(upgradeAgentTemplateDocument(current)).toBe(current);
	expect(isAgentTemplateDocument({ schemaVersion: 1, template: builtinAgentTemplates[1] })).toBe(
		false
	);
	const crew = upgradeCrewTemplateDocument({
		schemaVersion: 1,
		template: {
			...starterCrewTemplate,
			root: {
				...starterCrewTemplate.root,
				agents: [{ id: 'a', name: 'A', template: 'developer', summary: 'API routes' }],
			},
		},
	});
	expect(isCrewTemplateDocument(crew)).toBe(true);
	expect((crew as { template: CrewTemplate }).template.root.agents![0]).toEqual({
		id: 'a',
		name: 'A',
		template: 'developer',
		whenToUse: 'API routes',
	});
	// A schedule's one-off crew.
	const launch = upgradeCrewLaunch({
		template: { ...starterCrewTemplate, root: { ...starterCrewTemplate.root, summary: 'x' } },
	});
	expect(isCrewLaunch(launch)).toBe(true);
	expect(upgradeCrewLaunch({ templateId: 'review' })).toEqual({ templateId: 'review' });
});
// spec/crew#auto-model
it('makes one When to use line of free text', () => {
	expect(whenToUseLine('  Parts that\nwork from   screenshots ')).toBe(
		'Parts that work from screenshots'
	);
	const long = whenToUseLine(`${'word '.repeat(80)}end`);
	expect(isWhenToUse(long)).toBe(true);
	expect(long.endsWith('word…')).toBe(true);
});
// spec/crew-templates-and-editor#schema: an older Senior developer joined the rules and its own text with a space.
it('removes the rules of the rights however an older role joined them, and a resolved node has room for them', () => {
	const rules = crewRightsInstructions.developer;
	expect(ownInstructions('developer', `${rules} Your parts are the hard ones.`)).toBe(
		'Your parts are the hard ones.'
	);
	expect(ownInstructions('developer', `${rules}Tail`)).toBe(`${rules}Tail`);
	// spec/crew-templates-and-editor#limits: a role at the instructions limit still resolves to a valid snapshot.
	const big: AgentTemplate = {
		id: 'big',
		name: 'Big',
		role: 'developer',
		instructions: 'x'.repeat(100_000),
		builtin: false,
	};
	expect(isAgentTemplate(big)).toBe(true);
	const spec = resolveCrew(
		{
			...starterCrewTemplate,
			root: {
				...starterCrewTemplate.root,
				agents: [{ id: 'a', name: 'A', template: 'big' }],
			},
		},
		{ lookup: templateLookup([big]), defaultProvider: 'claude' }
	);
	expect(isCrewSpec(spec)).toBe(true);
});
