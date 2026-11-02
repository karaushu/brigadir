import { it, expect, vi } from 'vitest';
import {
	defaultNotificationPreferences,
	type EventRecord,
	type NotificationPreferences,
	type SessionEvent,
	type SessionSnapshot,
	type TaskKey,
} from '@brigadir/core';
import { Notifications, phonePushKind, type Notice, type NoticeHandlers } from './notifications';
const key: TaskKey = { projectId: 'project', id: 'task' },
	other: TaskKey = { projectId: 'project', id: 'other' };
const request = {
	id: 'perm-1',
	tool: { id: 'tool', title: 'Write example' },
	options: [
		{ id: 'deny', name: 'Deny', kind: 'reject_once' },
		{ id: 'allow', name: 'Allow', kind: 'allow_once' },
	],
};
const record = (seq: number, event: SessionEvent): EventRecord => ({
	schemaVersion: 1,
	seq,
	at: '2026-09-18T00:00:00.000Z',
	event,
});
const snapshot = (records: EventRecord[]): SessionSnapshot => ({
	key,
	records,
	connected: true,
	issue: null,
});
function harness(
	preferences: NotificationPreferences = defaultNotificationPreferences,
	allowed = true
) {
	const pushes: { type: string; task: string; key: string }[] = [];
	const shown: { notice: Notice; handlers: NoticeHandlers; closed: boolean }[] = [],
		sounds: string[] = [],
		removed: string[] = [],
		badges: number[] = [],
		opened: TaskKey[] = [],
		answers: { key: TaskKey; id: string; optionId: string }[] = [];
	const visibility = { active: false, task: null as TaskKey | null };
	const service = new Notifications({
		gateway: {
			supported: () => true,
			show(notice, handlers) {
				const entry = { notice, handlers, closed: false };
				shown.push(entry);
				return {
					close: () => {
						entry.closed = true;
					},
				};
			},
			removeGroup(id) {
				removed.push(id);
			},
		},
		sounds: {
			play(name) {
				sounds.push(name);
			},
		},
		preferences: () => preferences,
		visibility: () => visibility,
		locale: () => 'en',
		allowed: async () => allowed,
		taskTitle: async () => 'Fixture task',
		answerPermission: async (key, id, optionId) => {
			answers.push({ key, id, optionId });
		},
		openTask: (key) => {
			opened.push(key);
		},
		badge: (count) => {
			badges.push(count);
		},
		push: (type, task, key) => pushes.push({ type, task, key }),
	});
	const settle = () => new Promise((resolve) => setTimeout(resolve, 0));
	return { service, shown, sounds, removed, badges, opened, answers, visibility, settle, pushes };
}
it('buffers live events until the snapshot seeds the watermark and never replays the journal', async () => {
	const h = harness();
	h.service.observe(key, record(3, { kind: 'permission.requested', request }));
	h.service.observe(key, record(4, { kind: 'turn.completed', reason: 'end_turn' }));
	await h.settle();
	expect(h.shown).toHaveLength(0);
	expect(h.sounds).toEqual([]);
	h.service.seed(
		key,
		snapshot([
			record(1, { kind: 'turn.started', text: 'go' }),
			record(2, { kind: 'permission.requested', request: { ...request, id: 'old' } }),
			record(3, { kind: 'permission.requested', request }),
		])
	);
	await h.settle();
	// seq 3 is already in the journal; seq 4 arrived live and is the only notice.
	expect(h.shown.map((entry) => entry.notice.kind)).toEqual([]);
	expect(h.badges.at(-1)).toBe(1);
	h.service.observe(
		key,
		record(5, {
			kind: 'question.requested',
			question: {
				id: 'q1',
				question: 'Which?',
				header: 'Q',
				options: [],
				allowsFreeText: true,
				allowsMultiple: false,
			},
		})
	);
	await h.settle();
	expect(h.shown.map((entry) => entry.notice.id)).toEqual(['project/task/needs-you/q1']);
	expect(h.sounds).toEqual(['Ping']);
	h.service.observe(
		key,
		record(5, {
			kind: 'question.requested',
			question: {
				id: 'q1',
				question: 'Which?',
				header: 'Q',
				options: [],
				allowsFreeText: true,
				allowsMultiple: false,
			},
		})
	);
	await h.settle();
	expect(h.shown).toHaveLength(1);
	h.service.seed(key, snapshot([record(1, { kind: 'turn.started', text: 'go' })]));
	h.service.observe(key, record(2, { kind: 'permission.requested', request }));
	await h.settle();
	expect(h.shown).toHaveLength(1);
});
it('shows needs-you with one-time actions, revalidates stale actions and closes on resolution', async () => {
	const h = harness();
	h.service.seed(key, snapshot([]));
	h.service.observe(key, record(1, { kind: 'permission.requested', request }));
	await h.settle();
	const entry = h.shown[0]!;
	expect(entry.notice).toMatchObject({
		id: 'project/task/needs-you/perm-1',
		groupId: 'project/task',
		title: 'Fixture task',
		body: 'Write example · The agent is waiting for permission.',
		actions: { allow: 'Allow', deny: 'Deny' },
	});
	expect(h.badges.at(-1)).toBe(1);
	entry.handlers.allow();
	expect(h.answers).toEqual([{ key, id: 'perm-1', optionId: 'allow' }]);
	expect(entry.closed).toBe(true);
	h.service.observe(
		key,
		record(2, { kind: 'permission.resolved', id: 'perm-1', optionId: 'allow' })
	);
	expect(h.badges.at(-1)).toBe(0);
	h.service.observe(
		key,
		record(3, {
			kind: 'permission.requested',
			request: {
				...request,
				id: 'perm-2',
				options: [{ id: 'always', name: 'Always', kind: 'allow_always' }],
			},
		})
	);
	await h.settle();
	const second = h.shown[1]!;
	expect(second.notice.actions).toEqual({ allow: null, deny: null });
	h.service.observe(
		key,
		record(4, { kind: 'permission.resolved', id: 'perm-2', optionId: 'always' })
	);
	expect(second.closed).toBe(true);
	second.handlers.allow();
	expect(h.answers).toHaveLength(1);
	expect(h.opened).toEqual([key]);
	h.service.observe(
		key,
		record(5, { kind: 'permission.requested', request: { ...request, id: 'perm-3' } })
	);
	await h.settle();
	const third = h.shown[2]!;
	h.service.observe(key, record(6, { kind: 'host.stopped', reason: 'exit' }));
	expect(third.closed).toBe(true);
	expect(h.badges.at(-1)).toBe(0);
	third.handlers.deny();
	expect(h.answers).toHaveLength(1);
	expect(h.opened).toEqual([key, key]);
	h.service.observe(
		key,
		record(7, { kind: 'permission.requested', request: { ...request, id: 'perm-4' } })
	);
	await h.settle();
	h.shown[3]!.handlers.open();
	expect(h.removed).toEqual(['project/task']);
	expect(h.opened.at(-1)).toEqual(key);
	expect(h.shown[3]!.closed).toBe(true);
});
it("a root foreman's plan waits for the person: notice, sound and badge; a lead's plan resolved at once stays quiet", async () => {
	const h = harness();
	h.service.seed(key, snapshot([]));
	const plan = {
		id: 'plan-1',
		summary: 'Split',
		parts: [{ id: 'p1', title: 'Part', agent: 'Developer', prompt: 'go', files: [], scopes: [] }],
	};
	h.service.observe(key, record(1, { kind: 'crew.plan.requested', plan }));
	expect(h.badges.at(-1)).toBe(1);
	await new Promise((resolve) => setTimeout(resolve, 800));
	await h.settle();
	expect(h.shown.map((entry) => entry.notice)).toMatchObject([
		{
			id: 'project/task/needs-you/plan-1',
			kind: 'needs-you',
			body: 'The foreman proposes a split',
		},
	]);
	expect(h.sounds).toEqual(['Ping']);
	h.service.observe(
		key,
		record(2, { kind: 'crew.plan.resolved', id: 'plan-1', approved: true, parts: null })
	);
	expect(h.shown[0]!.closed).toBe(true);
	expect(h.badges.at(-1)).toBe(0);
	h.service.seed(other, snapshot([]));
	h.service.observe(
		other,
		record(2, { kind: 'crew.plan.requested', plan: { ...plan, id: 'lead-2' } })
	);
	h.service.observe(
		other,
		record(3, { kind: 'crew.plan.resolved', id: 'lead-2', approved: true, parts: null })
	);
	await new Promise((resolve) => setTimeout(resolve, 800));
	await h.settle();
	expect(h.shown).toHaveLength(1);
	expect(h.sounds).toEqual(['Ping']);
	expect(h.badges.at(-1)).toBe(0);
});
it("a worker's question the foreman left open at the end of its turn waits for the person; one answered in the turn does not (spec/crew#attention)", async () => {
	const h = harness();
	h.service.seed(key, snapshot([]));
	const question = {
		id: 'cq-1',
		workerTaskId: 'w',
		parentTaskId: 'task',
		callId: '1',
		agent: 'Credits',
		question: 'Which?',
		options: [],
		createdAt: '2026-10-09T00:00:00.000Z',
		escalateAt: '2026-10-09T00:05:00.000Z',
		state: 'pending' as const,
	};
	h.service.observe(key, record(1, { kind: 'crew.question.requested', question }));
	h.service.observe(key, record(2, { kind: 'turn.started', text: 'Worker asks' }));
	expect(h.badges.at(-1) ?? 0).toBe(0);
	h.service.observe(key, record(3, { kind: 'turn.completed', reason: 'end_turn' }));
	await h.settle();
	expect(h.shown.map((entry) => entry.notice)).toMatchObject([
		{
			id: 'project/task/needs-you/cq-1',
			kind: 'needs-you',
			body: 'A worker is waiting for your answer.',
		},
	]);
	expect(h.sounds).toEqual(['Ping']);
	expect(h.badges.at(-1)).toBe(1);
	h.service.observe(key, record(4, { kind: 'crew.question.escalated', id: 'cq-1' }));
	await h.settle();
	expect(h.shown).toHaveLength(1);
	h.service.observe(key, record(5, { kind: 'turn.started', text: 'yes' }));
	expect(h.badges.at(-1)).toBe(0);
	h.service.observe(
		key,
		record(6, { kind: 'crew.question.resolved', id: 'cq-1', answer: 'yes', answeredBy: 'foreman' })
	);
	expect(h.shown[0]!.closed).toBe(true);
	h.service.observe(key, record(7, { kind: 'turn.completed', reason: 'end_turn' }));
	await h.settle();
	expect(h.shown).toHaveLength(1);
	expect(h.badges.at(-1)).toBe(0);
});
it('applies suppression, scope and sound axes per task, coalesces turn notices and counts the badge across tasks', async () => {
	const h = harness({
		...defaultNotificationPreferences,
		mode: 'turn-ended',
		soundMode: 'turn-ended',
	});
	h.service.seed(key, snapshot([]));
	h.service.seed(other, snapshot([record(1, { kind: 'permission.requested', request })]));
	expect(h.badges.at(-1)).toBe(1);
	h.visibility.active = true;
	h.visibility.task = key;
	h.service.observe(key, record(1, { kind: 'turn.completed', reason: 'end_turn' }));
	await h.settle();
	expect(h.shown).toHaveLength(0);
	expect(h.sounds).toEqual([]);
	h.visibility.task = other;
	h.service.observe(key, record(2, { kind: 'turn.completed', reason: 'end_turn' }));
	await h.settle();
	expect(h.shown.map((entry) => entry.notice.id)).toEqual(['project/task/turn-ended']);
	expect(h.sounds).toEqual(['Tink']);
	h.service.observe(key, record(3, { kind: 'turn.completed', reason: 'end_turn' }));
	await h.settle();
	expect(h.shown).toHaveLength(2);
	expect(h.shown[0]!.closed).toBe(true);
	h.service.observe(key, record(4, { kind: 'turn.started', text: 'next' }));
	expect(h.shown[1]!.closed).toBe(true);
	h.service.observe(key, record(5, { kind: 'turn.completed', reason: 'cancelled' }));
	await h.settle();
	expect(h.shown).toHaveLength(2);
	h.service.observe(key, record(6, { kind: 'session.failed', message: 'boom' }));
	await h.settle();
	expect(h.shown.at(-1)!.notice).toMatchObject({
		id: 'project/task/failed',
		body: 'The session failed.',
	});
	expect(h.sounds).toEqual(['Tink', 'Tink', 'Basso']);
	h.service.observe(key, record(7, { kind: 'permission.requested', request }));
	await h.settle();
	expect(h.badges.at(-1)).toBe(2);
	h.service.detached(other);
	expect(h.badges.at(-1)).toBe(1);
	h.service.observe(
		other,
		record(2, { kind: 'permission.requested', request: { ...request, id: 'late' } })
	);
	await h.settle();
	expect(h.shown.filter((entry) => entry.notice.key.id === 'other')).toHaveLength(0);
	h.service.seed(other, null);
	await h.settle();
	expect(h.shown.filter((entry) => entry.notice.key.id === 'other')).toHaveLength(0);
	expect(h.badges.at(-1)).toBe(1);
});
it('delivers scope warnings once, never replays saved warnings and respects suppression and sound preferences', async () => {
	const event: SessionEvent = {
		kind: 'scope.violation',
		scopeId: '0123456789abcdef',
		name: '.',
		paths: ['read.txt'],
		checkpoint: 2,
	};
	const h = harness();
	h.service.seed(key, snapshot([record(1, event)]));
	await h.settle();
	expect(h.shown).toHaveLength(0);
	h.service.observe(key, record(2, { ...event, checkpoint: 3 }));
	h.service.observe(key, record(2, { ...event, checkpoint: 3 }));
	await h.settle();
	expect(h.shown).toHaveLength(1);
	expect(h.shown[0]!.notice).toMatchObject({
		kind: 'scope-violation',
		body: 'A read-only repo changed.',
		actions: { allow: null, deny: null },
	});
	expect(h.sounds).toEqual(['Basso']);
	expect(h.badges.at(-1)).toBe(0);
	h.visibility.active = true;
	h.visibility.task = key;
	h.service.observe(key, record(3, { ...event, checkpoint: 4 }));
	await h.settle();
	expect(h.shown).toHaveLength(1);
	expect(h.sounds).toHaveLength(1);
	const muted = harness({ ...defaultNotificationPreferences, mode: 'off', soundMode: 'off' });
	muted.service.seed(key, snapshot([]));
	muted.service.observe(key, record(1, event));
	await muted.settle();
	expect(muted.shown).toHaveLength(0);
	expect(muted.sounds).toHaveLength(0);
});
it('notifies only new structured rejection, coalesces its failure and closes on reset without journal replay', async () => {
	const h = harness(),
		rejection: SessionEvent = {
			kind: 'rate-limit.changed',
			status: 'rejected',
			window: 'five_hour',
			resetsAt: Date.now() / 1000 + 300,
		};
	h.service.seed(key, snapshot([]));
	h.service.observe(key, record(1, { ...rejection, status: 'allowed_warning' }));
	await h.settle();
	expect(h.shown).toHaveLength(0);
	expect(h.sounds).toHaveLength(0);
	h.service.observe(key, record(2, rejection));
	await h.settle();
	expect(h.shown).toHaveLength(1);
	expect(h.shown[0]!.notice.kind).toBe('rate-limited');
	expect(h.sounds).toEqual(['Basso']);
	h.service.observe(key, record(3, rejection));
	h.service.observe(key, record(4, { kind: 'session.failed', message: 'Rejected' }));
	await h.settle();
	expect(h.shown).toHaveLength(1);
	expect(h.sounds).toHaveLength(1);
	h.service.observe(
		key,
		record(5, {
			kind: 'rate-limit.expired',
			window: rejection.window,
			resetsAt: rejection.resetsAt!,
		})
	);
	expect(h.shown[0]!.closed).toBe(true);
	h.service.seed(key, snapshot([record(6, rejection)]));
	await h.settle();
	expect(h.shown).toHaveLength(1);
	const muted = harness({ ...defaultNotificationPreferences, mode: 'off', soundMode: 'off' });
	muted.service.seed(key, snapshot([]));
	muted.service.observe(key, record(1, rejection));
	await muted.settle();
	expect(muted.shown).toHaveLength(0);
	expect(muted.sounds).toHaveLength(0);
});
it('seeds the watermark from a journal too long to spread into Math.max', async () => {
	const h = harness(),
		records = Array.from({ length: 300_000 }, (_, index) =>
			record(index + 1, {
				kind: 'message.delta',
				role: 'assistant',
				messageId: null,
				content: { kind: 'text', text: 'x' },
			})
		);
	expect(() => h.service.seed(key, snapshot(records))).not.toThrow();
	h.service.observe(key, record(300_000, { kind: 'permission.requested', request }));
	await h.settle();
	expect(h.shown).toHaveLength(0);
	h.service.observe(key, record(300_001, { kind: 'permission.requested', request }));
	await h.settle();
	expect(h.shown).toHaveLength(1);
});
it('plays the in-app sound but shows nothing when macOS refuses notifications (spec/notifications-slack-notes-and-schedules#macos-permission)', async () => {
	const h = harness(defaultNotificationPreferences, false);
	h.service.seed(key, snapshot([]));
	h.service.observe(key, record(1, { kind: 'permission.requested', request }));
	await h.settle();
	expect(h.shown).toHaveLength(0);
	expect(h.sounds).toEqual(['Ping']);
	expect(h.badges.at(-1)).toBe(1);
});
// spec/chat-turns-plans-and-questions#background-commands: a failed background command notifies as a failure; a finished one only when the agent does not go on by itself.
it('background commands: failure notifies at once, success only when no turn follows, and never twice', async () => {
	vi.useFakeTimers();
	try {
		const h = harness({ ...defaultNotificationPreferences, mode: 'turn-ended' });
		h.service.seed(key, snapshot([record(1, { kind: 'turn.started', text: 'go' })]));
		h.service.observe(
			key,
			record(2, { kind: 'background.started', id: 'b1', toolId: 't1', name: 'Run the review' })
		);
		h.service.observe(key, record(3, { kind: 'turn.completed', reason: 'end_turn' }));
		await vi.runOnlyPendingTimersAsync();
		h.shown.length = 0;
		// Claude goes on by itself: its turn's end notifies, the command's end does not.
		h.service.observe(key, record(4, { kind: 'background.changed', id: 'b1', state: 'completed' }));
		h.service.observe(key, record(5, { kind: 'turn.started', text: '', origin: 'agent' }));
		await vi.advanceTimersByTimeAsync(6000);
		expect(h.shown).toHaveLength(0);
		h.service.observe(key, record(6, { kind: 'turn.completed', reason: 'end_turn' }));
		await vi.runOnlyPendingTimersAsync();
		expect(h.shown.map((entry) => entry.notice.body)).toEqual(['The turn ended.']);
		h.shown.length = 0;
		// Codex does not go on: after the wait, one notice that the command finished.
		h.service.observe(
			key,
			record(7, { kind: 'background.started', id: 'b2', toolId: 't2', name: 'pnpm storybook' })
		);
		h.service.observe(key, record(8, { kind: 'background.changed', id: 'b2', state: 'completed' }));
		await vi.advanceTimersByTimeAsync(4000);
		expect(h.shown).toHaveLength(0);
		await vi.advanceTimersByTimeAsync(2000);
		expect(h.shown.map((entry) => [entry.notice.kind, entry.notice.body])).toEqual([
			['turn-ended', 'The background command finished. pnpm storybook'],
		]);
		// A failure is a failure in any mode but «Never».
		const quiet = harness({ ...defaultNotificationPreferences, mode: 'needs-you' });
		quiet.service.seed(key, snapshot([]));
		quiet.service.observe(
			key,
			record(1, { kind: 'background.started', id: 'b3', toolId: null, name: 'exit 3' })
		);
		quiet.service.observe(
			key,
			record(2, { kind: 'background.changed', id: 'b3', state: 'failed' })
		);
		await vi.runOnlyPendingTimersAsync();
		expect(quiet.shown.map((entry) => [entry.notice.kind, entry.notice.body])).toEqual([
			['failed', 'The background command failed. exit 3'],
		]);
		// Stopped (by the person or with the host) is silent; a finished one in «Needs you» mode too.
		quiet.service.observe(
			key,
			record(3, { kind: 'background.started', id: 'b4', toolId: null, name: 'sleep' })
		);
		quiet.service.observe(
			key,
			record(4, { kind: 'background.changed', id: 'b4', state: 'stopped', reason: 'closed' })
		);
		quiet.service.observe(
			key,
			record(5, { kind: 'background.started', id: 'b5', toolId: null, name: 'ok' })
		);
		quiet.service.observe(
			key,
			record(6, { kind: 'background.changed', id: 'b5', state: 'completed' })
		);
		await vi.advanceTimersByTimeAsync(6000);
		expect(quiet.shown).toHaveLength(1);
	} finally {
		vi.useRealTimers();
	}
});

it('sends the same notice to the paired phones as the task name and the kind, and nothing it would not show (spec/remote-access-and-mobile#phone)', async () => {
	const h = harness();
	h.service.seed(key, snapshot([record(1, { kind: 'turn.started', text: 'go' })]));
	await h.settle();
	h.service.observe(key, record(2, { kind: 'permission.requested', request }));
	await h.settle();
	expect(h.pushes).toEqual([
		{ type: 'permission', task: 'Fixture task', key: `${key.projectId}/${key.id}` },
	]);
	// The task is in front at the machine: no notice, no push.
	h.visibility.active = true;
	h.visibility.task = key;
	h.service.observe(
		key,
		record(3, { kind: 'permission.requested', request: { ...request, id: 'perm-2' } })
	);
	await h.settle();
	expect(h.pushes).toHaveLength(1);
});
it('names the kind of the wait on a phone’s lock screen and nothing for what a phone does not get (spec/remote-access-and-mobile#phone)', () => {
	expect(phonePushKind('needs-you', 'permission.requested')).toBe('permission');
	expect(phonePushKind('needs-you', 'question.requested')).toBe('question');
	expect(phonePushKind('needs-you', 'crew.question.escalated')).toBe('question');
	expect(phonePushKind('needs-you', 'crew.plan.requested')).toBe('plan');
	expect(phonePushKind('needs-you', 'task.proposal.requested')).toBe('needs-you');
	expect(phonePushKind('turn-ended', 'turn.completed')).toBe('done');
	expect(phonePushKind('failed', 'session.failed')).toBeNull();
	expect(phonePushKind('rate-limited', 'rate.limited')).toBeNull();
	expect(phonePushKind('scope-violation', 'scope.violation')).toBeNull();
});
it('spec/notifications-slack-notes-and-schedules#notification-center: logs every notice whatever «When» is, requests too, and lists the live requests with their one-time actions', async () => {
	const logged: { kind: string; body: string; read: boolean }[] = [];
	let changes = 0;
	const answers: string[] = [];
	const service = new Notifications({
		gateway: { supported: () => true, show: () => ({ close() {} }), removeGroup() {} },
		sounds: { play() {} },
		preferences: () => ({ ...defaultNotificationPreferences, mode: 'off' }),
		visibility: () => ({ active: false, task: null }),
		locale: () => 'en',
		allowed: async () => false,
		taskTitle: async () => 'Fixture task',
		answerPermission: async (_key, _id, optionId) => {
			answers.push(optionId);
		},
		openTask() {},
		badge() {},
		log: (input) => logged.push({ kind: input.kind, body: input.body, read: input.read }),
		pendingChanged: () => changes++,
	});
	service.seed(key, snapshot([]));
	service.observe(key, record(1, { kind: 'permission.requested', request }));
	await new Promise((resolve) => setTimeout(resolve, 0));
	const pending = service.pendingNotices();
	expect(pending).toMatchObject([
		{ kind: 'permission', task: key, allow: 'allow', deny: 'deny', title: 'Fixture task' },
	]);
	expect(pending[0]!.body).toBe('Write example · The agent is waiting for permission.');
	expect(changes).toBeGreaterThan(0);
	service.answer(pending[0]!.id, 'allow');
	await new Promise((resolve) => setTimeout(resolve, 0));
	expect(answers).toEqual(['allow']);
	service.observe(
		key,
		record(2, { kind: 'permission.resolved', id: 'perm-1', optionId: 'allow' } as SessionEvent)
	);
	service.observe(key, record(3, { kind: 'turn.completed', reason: 'end_turn' }));
	await new Promise((resolve) => setTimeout(resolve, 0));
	expect(service.pendingNotices()).toEqual([]);
	expect(logged).toEqual([
		{
			kind: 'permission',
			body: 'Write example · The agent is waiting for permission.',
			read: false,
		},
		{ kind: 'turn-ended', body: 'The turn ended.', read: false },
	]);
});
it('spec/notifications-slack-notes-and-schedules#notification-center: a page notification goes to the center even with «When» = Never', async () => {
	const logged: string[] = [];
	const service = new Notifications({
		gateway: { supported: () => true, show: () => ({ close() {} }), removeGroup() {} },
		sounds: { play() {} },
		preferences: () => ({ ...defaultNotificationPreferences, mode: 'off' }),
		visibility: () => ({ active: false, task: null }),
		locale: () => 'en',
		allowed: async () => true,
		taskTitle: async () => 'Fixture task',
		answerPermission: async () => {},
		openTask() {},
		badge() {},
		log: (input) => logged.push(`${input.kind}:${input.title}:${input.body}`),
	});
	expect(
		await service.page(
			key,
			{ id: 'p1', title: 'Order ready', body: 'stage · 2 new orders' },
			() => {}
		)
	).toBeNull();
	expect(logged).toEqual(['page:Order ready:stage · 2 new orders']);
});
