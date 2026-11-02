import { it, expect } from 'vitest';
import {
	builtinAgentTemplates,
	builtinCrewTemplates,
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
} from './crew';
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
	expect(api.instructions).toBe(builtinAgentTemplates[1]!.instructions);
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
it('resolves the specialty from the node, else the template, and validates it as one line (spec/crew-templates-and-editor#roster)', () => {
	const tester: AgentTemplate = {
		id: 'tester',
		name: 'Tester',
		role: 'developer',
		summary: 'Writes e2e tests.',
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
				{ id: 'b', name: 'B', template: 'tester', summary: '  Owns the fixtures.  ' },
				{ id: 'c', name: 'C', template: 'tester', summary: '   ' },
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
	expect(spec.root.agents.map((agent) => agent.summary)).toEqual([
		'Writes e2e tests.',
		'Owns the fixtures.',
		'Writes e2e tests.',
		'',
	]);
	expect(isCrewSpec(spec)).toBe(true);
	// Snapshots written before spec/crew-templates-and-editor#roster have no summary and stay readable.
	const { summary: _, ...legacy } = spec.root.agents[0]!;
	expect(
		isCrewSpec({ ...spec, root: { ...spec.root, agents: [legacy, ...spec.root.agents.slice(1)] } })
	).toBe(true);
	expect(isCrewTemplate({ ...template, root: { ...template.root, summary: 'two\nlines' } })).toBe(
		false
	);
	expect(
		isCrewTemplate({ ...template, root: { ...template.root, summary: 'x'.repeat(241) } })
	).toBe(false);
	expect(updateCrewAgent(template, 'b', { summary: undefined }).root.agents![1]).toEqual({
		id: 'b',
		name: 'B',
		template: 'tester',
	});
});
