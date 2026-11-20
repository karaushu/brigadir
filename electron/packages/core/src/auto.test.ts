import { describe, expect, it } from 'vitest';
import {
	autoHireGates,
	autoHireTotal,
	autoHireable,
	autoRoleLabel,
	autoSpec,
	clampAutoBudget,
	editedHireParts,
	isAutoHire,
	isAutoHireDecision,
	isAutoModelAnswer,
	isAutoSettings,
	isAutoTask,
	modelRole,
	zonesOverlap,
	defaultAutoSettings,
	type AutoHirePart,
	type AutoTask,
} from './auto';
import {
	autoCrewId,
	composeCrewId,
	isCrewLaunch,
	isCrewSpec,
	rememberedCrewId,
	templateLookup,
	unshippedCrewLaunch,
	builtinAgentTemplates,
} from './crew';
import { isAgentTask } from './workspace';
import { crewPalette } from './crew-compose';
import { crewWorkerClosed, isCrewWorkerRecord } from './crew-runtime';
import { crewWorkerRows, crewTaskLabel } from './sidebar';
import { defaultAppSettings, isAppSettings } from './settings';
import type { AgentTask } from './workspace';

const part = (
	id: string,
	zone: string[],
	lines = 200,
	extra: Partial<AutoHirePart> = {}
): AutoHirePart => ({
	id,
	title: `Part ${id}`,
	role: 'developer',
	roleName: 'Developer',
	prompt: `Do ${id}`,
	zone,
	scopes: [],
	budget: { minutes: 40, tokens: 400_000 },
	estimate: { files: 3, lines },
	...extra,
});
const roles = () =>
	crewPalette(
		builtinAgentTemplates,
		{ lookup: templateLookup([...builtinAgentTemplates]), defaultProvider: 'claude' },
		[]
	).templates;

describe('spec/crew#auto-gates', () => {
	it('refuses a part whose zone overlaps an earlier part and keeps it out of the hire', () => {
		const parts = autoHireGates(
			[
				part('a', ['apps/api/src/clients/**']),
				part('b', ['apps/mobile/src/screens/ClientDetails/**']),
				part('c', ['apps/api/src/clients/types.ts']),
			],
			[]
		);
		expect(parts[0]!.refused).toBeUndefined();
		expect(parts[1]!.refused).toBeUndefined();
		expect(parts[2]!.refused).toMatchObject({
			code: 'overlap',
			part: 1,
			path: 'apps/api/src/clients/types.ts',
		});
		expect(parts[2]!.refused!.message).toBe(
			'Not independent: part 1 writes apps/api/src/clients/types.ts too.'
		);
		expect(autoHireable(parts).map((item) => item.id)).toEqual(['a', 'b']);
	});
	it('refuses a part too small for a worker, and the rest are still hired', () => {
		const parts = autoHireGates(
			[
				part('a', ['src/a/**']),
				part('b', ['src/i18n/uk.json'], 12, { estimate: { files: 1, lines: 12 } }),
			],
			[]
		);
		expect(parts[1]!.refused).toMatchObject({ code: 'small', lines: 12, files: 1 });
		expect(parts[1]!.refused!.message).toBe('Too small for a worker: about 12 lines in one file.');
		expect(autoHireable(parts)).toHaveLength(1);
	});
	it('a small part does not take its zone: a later part may write there', () => {
		const parts = autoHireGates([part('a', ['src/x.ts'], 10), part('b', ['src/**'])], []);
		expect(parts[1]!.refused).toBeUndefined();
	});
	it('refuses a part that overlaps a running worker', () => {
		const parts = autoHireGates(
			[part('a', ['src/api/**'])],
			[{ name: 'Developer', zone: ['src/api/clients.ts'] }]
		);
		expect(parts[0]!.refused).toMatchObject({ code: 'overlap', part: null, worker: 'Developer' });
	});
	it('recomputes the verdict and drops a stale one', () => {
		const stale = part('a', ['src/**'], 200, {
			refused: { code: 'small', lines: 1, files: 1, message: 'x' },
		});
		expect(autoHireGates([stale], [])[0]!.refused).toBeUndefined();
	});
	it('zones overlap by their static prefix', () => {
		expect(zonesOverlap(['src/a/**'], ['src/b/**'])).toBeNull();
		expect(zonesOverlap(['src/**'], ['src/b/c.ts'])).toBe('src/b/c.ts');
		expect(zonesOverlap(['src/a.ts'], ['src/a.ts'])).toBe('src/a.ts');
		expect(zonesOverlap(['**'], ['docs/x.md'])).not.toBeNull();
		expect(zonesOverlap(['src/ab'], ['src/a'])).toBeNull();
	});
});

describe('spec/crew#auto-hire card data', () => {
	it('sums the budgets of the hireable parts', () => {
		const parts = autoHireGates(
			[
				part('a', ['a/**']),
				part('b', ['b/**'], 200, { budget: { minutes: 50, tokens: 500_000 } }),
				part('c', ['a/x']),
			],
			[]
		);
		expect(autoHireTotal(parts)).toEqual({ minutes: 90, tokens: 900_000 });
	});
	it('takes the person’s titles, roles, budgets and prompts, never zones or estimates', () => {
		const proposed = [part('a', ['a/**'])];
		const edited = editedHireParts(proposed, [
			{
				...proposed[0]!,
				title: 'API',
				role: 'senior-developer',
				roleName: 'Senior developer',
				zone: ['**'],
				estimate: { files: 1, lines: 1 },
				budget: { minutes: 60, tokens: 600_000 },
			},
		])!;
		expect(edited[0]).toMatchObject({
			title: 'API',
			role: 'senior-developer',
			zone: ['a/**'],
			estimate: { files: 3, lines: 200 },
			budget: { minutes: 60, tokens: 600_000 },
		});
		expect(editedHireParts(proposed, [part('other', ['a/**'])])).toBeNull();
		expect(editedHireParts(proposed, null)).toBeNull();
	});
	it('validates the hire and the decision', () => {
		expect(isAutoHire({ id: 'h1', summary: 's', parts: [part('a', ['a/**'])] })).toBe(true);
		expect(isAutoHire({ id: 'h1', summary: 's', parts: [] })).toBe(false);
		expect(isAutoHire({ id: 'h1', summary: 's', parts: [part('a', [])] })).toBe(false);
		expect(isAutoHireDecision({ id: 'h1', approved: false, parts: null })).toBe(true);
		expect(isAutoHireDecision({ id: 'h1', approved: true, parts: [part('a', ['a/**'])] })).toBe(
			true
		);
	});
	it('clamps a budget into its limits', () => {
		expect(clampAutoBudget({ minutes: 1, tokens: 1e12 }, { minutes: 40, tokens: 400_000 })).toEqual(
			{ minutes: 5, tokens: 20_000_000 }
		);
		expect(clampAutoBudget({}, { minutes: 40, tokens: 400_000 })).toEqual({
			minutes: 40,
			tokens: 400_000,
		});
	});
});

describe('spec/crew#auto-roles, spec/crew#auto-model', () => {
	it('stores the roles the task hires from', () => {
		const auto: AutoTask = { roles: roles(), budget: { minutes: 40, tokens: 400_000 } };
		expect(isAutoTask(auto)).toBe(true);
		expect(auto.roles.some((role) => role.role === 'foreman')).toBe(false);
		expect(isAutoTask({ ...auto, roles: [...auto.roles, auto.roles[0]] })).toBe(false);
	});
	it('a model answer becomes a role with the base role’s instructions', () => {
		const developer = roles().find((role) => role.id === 'developer')!;
		const answer = {
			provider: 'codex' as const,
			model: { id: 'model', value: 'gpt-6-astra', name: 'GPT-6 Astra' },
			effort: { id: 'reasoning_effort', value: 'high', name: 'High' },
			saveAs: 'Vision developer',
		};
		expect(isAutoModelAnswer(answer)).toBe(true);
		const role = modelRole(developer, answer, 'role-1');
		expect(role).toMatchObject({
			id: 'role-1',
			name: 'Vision developer',
			provider: 'codex',
			instructions: developer.instructions,
			requestedChoices: { configOptions: { model: 'gpt-6-astra', reasoning_effort: 'high' } },
			choiceNames: { model: 'GPT-6 Astra', reasoning_effort: 'High' },
		});
		const { saveAs: _saveAs, ...unnamed } = answer;
		expect(modelRole(developer, unnamed, 'r2').name).toBe('Developer · GPT-6 Astra · High');
	});
});

describe('spec/crew#launch: launches that predate Auto', () => {
	it('runs a compose launch and the compose id as Auto', () => {
		expect(unshippedCrewLaunch({ compose: true }, [])).toEqual({ auto: true });
		expect(unshippedCrewLaunch({ templateId: composeCrewId }, [])).toEqual({ auto: true });
		expect(unshippedCrewLaunch({ templateId: 'default' }, [])).toEqual({ auto: true });
		expect(unshippedCrewLaunch({ templateId: 'default' }, [{ id: 'default' }])).toEqual({
			templateId: 'default',
		});
		expect(unshippedCrewLaunch({ templateId: 'review' }, [{ id: 'review' }])).toEqual({
			templateId: 'review',
		});
		expect(isCrewLaunch({ auto: true })).toBe(true);
		expect(isCrewLaunch({ auto: true, templateId: 'x' })).toBe(false);
	});
	it('a task’s crew that left the library opens on Auto', () => {
		expect(rememberedCrewId('gone', [{ id: 'review' }])).toBe(autoCrewId);
		expect(rememberedCrewId(composeCrewId, [])).toBe(autoCrewId);
		expect(rememberedCrewId('review', [{ id: 'review' }])).toBe('review');
	});
});

describe('spec/crew#auto-root', () => {
	it('the root is the task’s agent, named after its provider', () => {
		const spec = autoSpec({
			provider: 'codex',
			launchOptions: [{ id: 'model', value: 'gpt' }],
			createdAt: '2026-11-13T10:00:00.000Z',
		});
		expect(isCrewSpec(spec)).toBe(true);
		expect(spec.root).toMatchObject({
			name: 'Codex',
			role: 'foreman',
			provider: 'codex',
			requestedChoices: { configOptions: { model: 'gpt' } },
		});
		expect(spec.templateId).toBe('auto');
	});
});

describe('old data still loads', () => {
	const base: AgentTask = {
		id: 't1',
		projectId: 'p1',
		title: 'T',
		status: 'done',
		provider: 'claude',
	};
	it('a task without auto, and an Auto task', () => {
		expect(isAgentTask(base)).toBe(true);
		expect(
			isAgentTask({
				...base,
				auto: { roles: roles(), budget: { minutes: 40, tokens: 400_000 } },
				overBudget: true,
			})
		).toBe(true);
		expect(isAgentTask({ ...base, auto: { roles: [], budget: { minutes: 1, tokens: 1 } } })).toBe(
			false
		);
	});
	it('a worker record from before Auto, and one with its hire', () => {
		const record = {
			taskId: 'w1',
			nodeId: 'n1',
			name: 'Developer',
			title: 'API',
			createdAt: '2026-01-01T00:00:00.000Z',
			planPartId: null,
		};
		expect(isCrewWorkerRecord(record)).toBe(true);
		expect(crewWorkerClosed({})).toBe(false);
		const hired = {
			...record,
			budget: { minutes: 40, tokens: 400_000 },
			zone: ['src/api/**'],
			hiredFrom: { '': 'a'.repeat(40) },
			hireId: 'h1',
			dismissedAt: '2026-01-01T01:00:00.000Z',
			dismissReason: 'discarded',
		};
		expect(isCrewWorkerRecord(hired)).toBe(true);
		expect(crewWorkerClosed(hired)).toBe(true);
		expect(isCrewWorkerRecord({ ...hired, dismissReason: 'fired' })).toBe(false);
	});
	it('settings without auto read as invalid until main adds the defaults', () => {
		expect(isAppSettings(defaultAppSettings)).toBe(true);
		expect(defaultAppSettings.auto).toEqual(defaultAutoSettings);
		const { auto: _auto, ...older } = defaultAppSettings;
		expect(isAppSettings(older)).toBe(false);
		expect(
			isAutoSettings({ anyModel: true, partBudget: { minutes: 600, tokens: 20_000_000 } })
		).toBe(true);
	});
});

describe('spec/sidebar#crew-card: Auto worker rows', () => {
	it('show the role, and a dismissed worker as dismissed', () => {
		const all = roles(),
			developer = all.find((role) => role.id === 'developer')!;
		const spec = autoSpec({ provider: 'claude' });
		spec.root.agents = [
			{ ...developer, id: 'w1', name: 'Developer 2', template: developer.id, zone: ['a/**'] },
		];
		const lead: AgentTask = {
			id: 'lead',
			projectId: 'p',
			title: 'Lead',
			status: 'working',
			crew: spec,
			auto: { roles: all, budget: { minutes: 40, tokens: 400_000 } },
		};
		const worker: AgentTask = {
			id: 'w',
			projectId: 'p',
			title: 'API endpoints',
			status: 'completed',
			crewTaskId: 'lead',
			crewNodeId: 'w1',
			parentTaskId: 'lead',
		};
		const [row] = crewWorkerRows(lead, [lead, worker]);
		expect(row).toMatchObject({ name: 'Developer', dismissed: true });
		expect(crewTaskLabel(worker, [lead, worker])).toBe('Developer · API endpoints');
		const { auto: _auto, ...named } = lead;
		expect(crewWorkerRows(named, [named, worker])[0]).toMatchObject({
			name: 'Developer 2',
			dismissed: false,
		});
		expect(autoRoleLabel(undefined, spec.root.agents[0]!)).toBe('Developer 2');
	});
	it("show a reviewer by its own name and only the current review's reviewers (spec/reviews#surfaces)", () => {
		const all = roles(),
			developer = all.find((role) => role.id === 'developer')!,
			reviewer = all.find((role) => role.id === 'reviewer') ?? developer;
		const spec = autoSpec({ provider: 'claude' });
		const review = (id: string, name: string) => ({
			...reviewer,
			id,
			name,
			role: 'reviewer' as const,
			template: reviewer.id,
			zone: [],
			checkedBy: [],
			agents: [],
		});
		spec.root.agents = [
			{ ...developer, id: 'w1', name: 'Developer', template: developer.id, zone: ['a/**'] },
			review('review-a-1', 'Codex'),
			review('review-b-1', 'Codex 2'),
		];
		spec.root.checkedBy = ['review-b-1'];
		const lead: AgentTask = {
			id: 'lead',
			projectId: 'p',
			title: 'Lead',
			status: 'working',
			crew: spec,
			auto: { roles: all, budget: { minutes: 40, tokens: 400_000 } },
		};
		const member = (id: string, node: string): AgentTask => ({
			id,
			projectId: 'p',
			title: 'reviews the changes',
			status: 'done',
			crewTaskId: 'lead',
			crewNodeId: node,
			parentTaskId: 'lead',
		});
		const tasks = [lead, member('w', 'w1'), member('r1', 'review-a-1'), member('r2', 'review-b-1')];
		expect(
			crewWorkerRows(lead, tasks).map((row) => [row.task.id, row.name, row.reviewer ?? false])
		).toEqual([
			['w', 'Developer', false],
			['r2', 'Codex 2', true],
		]);
		expect(crewTaskLabel(tasks[3]!, tasks)).toBe('Codex 2 · reviews the changes');
	});
});
