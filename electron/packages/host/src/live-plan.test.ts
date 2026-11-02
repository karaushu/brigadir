import { expect, it } from 'vitest';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { SessionStore } from '@brigadir/persistence';
import { planApproveChoice, planApprovedMode, sessionModes } from '@brigadir/core';
import { startHost, connectHost } from './index';
/** spec/chat-turns-plans-and-questions#checklist-tools: the plan row lives only when the agent keeps a checklist; each agent needs its tool from the transport (Claude's
 *  task tool, Codex's `update_plan`) and the sentence from the brief. spec/chat-turns-plans-and-questions#plan-approval: asked for a plan first, Claude enters plan mode
 *  and asks to approve it (`switch_mode`). `BRIGADIR_LIVE_PLAN=claude|codex|claude-approval`. */
const live = ['claude', 'codex', 'claude-approval', 'claude-approve-mode'].includes(
	process.env.BRIGADIR_LIVE_PLAN ?? ''
)
	? process.env.BRIGADIR_LIVE_PLAN!
	: null;
it.skipIf(live !== 'claude' && live !== 'codex')(
	'live agent keeps a step checklist that reaches the plan row',
	async () => {
		const provider = live as 'claude' | 'codex';
		const root = await mkdtemp(join(tmpdir(), 'brigadir-live-plan-')),
			repo = join(root, 'repo');
		await mkdir(repo);
		const store = await SessionStore.at(join(root, 'data')),
			project = await store.addProject(repo),
			task = await store.createTask(project.id, 'Live plan', provider);
		const host = await startHost({
				dataDir: store.root,
				key: task,
				mcpEntry: resolve('apps/desktop/out/services/mcp-relay'),
			}),
			client = await connectHost(host.identity);
		try {
			await expect
				.poll(() => host.records.some((r) => r.event.kind === 'session.started'), {
					timeout: 90000,
				})
				.toBe(true);
			// Codex asks before writing in its default mode, so its steps only read.
			if (provider === 'claude') {
				await client.command({ kind: 'setMode', modeId: 'acceptEdits' });
				await client.command({
					kind: 'prompt',
					text: 'Create three files one after another: a.txt with the word alpha, b.txt with the word beta, c.txt with the word gamma. Do not run shell commands.',
				});
			} else {
				await writeFile(join(repo, 'notes.txt'), 'alpha\nbeta\n');
				await client.command({
					kind: 'prompt',
					text: 'Count the lines of notes.txt, then count its characters, then report both numbers.',
				});
			}
			await expect
				.poll(() => host.records.filter((r) => r.event.kind === 'turn.completed').length, {
					timeout: 180000,
					interval: 1000,
				})
				.toBe(1);
			const plans = host.records.flatMap((r) =>
				r.event.kind === 'plan.changed' ? [r.event.entries] : []
			);
			expect(plans.length).toBeGreaterThan(0);
			expect(plans.at(-1)!.length).toBeGreaterThanOrEqual(3);
			expect(plans.at(-1)!.every((entry) => entry.status === 'completed')).toBe(true);
		} finally {
			client.close();
			await host.stop();
			await rm(root, { recursive: true, force: true });
		}
	},
	240000
);

it.skipIf(live !== 'claude-approval')(
	'asked for a plan first, Claude in its default mode brings the plan for approval',
	async () => {
		const root = await mkdtemp(join(tmpdir(), 'brigadir-live-plan-')),
			repo = join(root, 'repo');
		await mkdir(repo);
		await writeFile(join(repo, 'math.ts'), 'export function add(a:number,b:number){return a+b;}\n');
		const store = await SessionStore.at(join(root, 'data')),
			project = await store.addProject(repo),
			task = await store.createTask(project.id, 'Live plan approval', 'claude');
		const host = await startHost({
				dataDir: store.root,
				key: task,
				mcpEntry: resolve('apps/desktop/out/services/mcp-relay'),
			}),
			client = await connectHost(host.identity);
		try {
			await expect
				.poll(() => host.records.some((r) => r.event.kind === 'session.started'), {
					timeout: 90000,
				})
				.toBe(true);
			const started = host.records.find((r) => r.event.kind === 'session.started')!.event;
			expect(started.kind === 'session.started' && started.modeId).not.toBe('plan');
			await client.command({
				kind: 'prompt',
				text: 'Add a function `mul` and a function `div` (throwing on zero) to math.ts, with a short JSDoc each. Create a solid plan first, I want a full plan from you before doing anything.',
			});
			// In a mode that asks, entering plan mode is a permission of its own: allow it, as the person would.
			const answered = new Set<string>();
			await expect
				.poll(
					async () => {
						for (const r of host.records)
							if (
								r.event.kind === 'permission.requested' &&
								r.event.request.tool.category !== 'switch_mode' &&
								!answered.has(r.event.request.id)
							) {
								answered.add(r.event.request.id);
								const allow = r.event.request.options.find((o) => o.kind.startsWith('allow'));
								if (allow)
									await client.command({
										kind: 'answerPermission',
										id: r.event.request.id,
										optionId: allow.id,
									});
							}
						return (
							host.records.some(
								(r) =>
									r.event.kind === 'permission.requested' &&
									r.event.request.tool.category === 'switch_mode'
							) || host.records.some((r) => r.event.kind === 'turn.completed')
						);
					},
					{ timeout: 240000, interval: 1000 }
				)
				.toBe(true);
			expect(
				host.records.some((r) => r.event.kind === 'mode.changed' && r.event.modeId === 'plan')
			).toBe(true);
			const request = host.records
				.flatMap((r) =>
					r.event.kind === 'permission.requested' && r.event.request.tool.category === 'switch_mode'
						? [r.event.request]
						: []
				)
				.at(-1);
			expect(request).toBeDefined();
			expect(
				(request!.tool.content ?? []).some(
					(item) => item.kind === 'text' && /mul/.test(item.text) && /div/.test(item.text)
				)
			).toBe(true);
		} finally {
			client.close();
			await host.stop();
			await rm(root, { recursive: true, force: true });
		}
	},
	300000
);

/** spec/chat-turns-plans-and-questions#plan-approval: from `auto`, `Погодити` picks the adapter's own option for `auto` and the session comes back to it. */
it.skipIf(live !== 'claude-approve-mode')(
	'approving a plan made in auto brings the session back to auto',
	async () => {
		const root = await mkdtemp(join(tmpdir(), 'brigadir-live-plan-')),
			repo = join(root, 'repo');
		await mkdir(repo);
		await writeFile(join(repo, 'math.ts'), 'export function add(a:number,b:number){return a+b;}\n');
		const store = await SessionStore.at(join(root, 'data')),
			project = await store.addProject(repo),
			task = await store.createTask(project.id, 'Live plan mode', 'claude');
		const host = await startHost({
				dataDir: store.root,
				key: task,
				mcpEntry: resolve('apps/desktop/out/services/mcp-relay'),
			}),
			client = await connectHost(host.identity);
		try {
			await expect
				.poll(() => host.records.some((r) => r.event.kind === 'session.started'), {
					timeout: 90000,
				})
				.toBe(true);
			if (sessionModes(host.records).at(-1) !== 'auto')
				await client.command({ kind: 'setMode', modeId: 'auto' });
			await client.command({
				kind: 'prompt',
				text: 'Add a function `mul` to math.ts. Create a solid plan first, I want a full plan from you before doing anything.',
			});
			await expect
				.poll(
					() =>
						host.records.some(
							(r) =>
								r.event.kind === 'permission.requested' &&
								r.event.request.tool.category === 'switch_mode'
						) || host.records.some((r) => r.event.kind === 'turn.completed'),
					{ timeout: 240000, interval: 1000 }
				)
				.toBe(true);
			const record = host.records.find(
				(r) =>
					r.event.kind === 'permission.requested' && r.event.request.tool.category === 'switch_mode'
			);
			if (record?.event.kind !== 'permission.requested') throw new Error('No plan for approval');
			const choice = planApproveChoice(record.event.request, host.records, record.seq);
			expect(choice).toMatchObject({ option: { id: 'exit-plan-auto' }, returnMode: null });
			await client.command({
				kind: 'answerPermission',
				id: record.event.request.id,
				optionId: choice!.option.id,
			});
			await expect
				.poll(
					() => {
						const index = host.records.findIndex((r) => r.event.kind === 'permission.resolved');
						return index < 0 ? null : planApprovedMode(host.records, index);
					},
					{ timeout: 60000, interval: 500 }
				)
				.toBe('auto');
			await client.command({ kind: 'cancel' });
		} finally {
			client.close();
			await host.stop();
			await rm(root, { recursive: true, force: true });
		}
	},
	300000
);
