import { it, expect } from 'vitest';
import {
	defaultNotificationPreferences,
	isNotificationPermission,
	isNotificationPreferences,
	migrateNotificationPreferences,
	isSoundName,
	notificationDecision,
	notificationPermissionChoices,
	noticeKind,
	type NoticeKind,
} from './notifications';
import type { SessionEvent } from './session';
const task = { projectId: 'one', id: 'task' },
	background = { active: false, task: null };
it('keeps OS and sound independent, with urgent events outside completion scope', () => {
	const prefs = structuredClone(defaultNotificationPreferences);
	expect(notificationDecision('needs-you', prefs, task, background)).toEqual({
		show: true,
		sound: 'Ping',
	});
	expect(notificationDecision('turn-ended', prefs, task, background)).toEqual({
		show: false,
		sound: null,
	});
	for (const kind of ['failed', 'rate-limited', 'scope-violation'] as NoticeKind[])
		expect(notificationDecision(kind, prefs, task, background)).toEqual({
			show: true,
			sound: 'Basso',
		});
	expect(notificationDecision('failed', { ...prefs, mode: 'off' }, task, background)).toEqual({
		show: false,
		sound: 'Basso',
	});
	expect(
		notificationDecision('needs-you', { ...prefs, soundMode: 'off' }, task, background)
	).toEqual({ show: true, sound: null });
	expect(
		notificationDecision('turn-ended', { ...prefs, mode: 'turn-ended' }, task, background)
	).toEqual({ show: true, sound: null });
	expect(
		notificationDecision(
			'needs-you',
			{ ...prefs, mode: 'turn-ended', soundMode: 'off' },
			task,
			background
		)
	).toEqual({ show: true, sound: null });
	expect(notificationDecision('needs-you', { ...prefs, mode: 'off' }, task, background)).toEqual({
		show: false,
		sound: 'Ping',
	});
	expect(
		notificationDecision(
			'turn-ended',
			{ ...prefs, mode: 'off', soundMode: 'turn-ended' },
			task,
			background
		)
	).toEqual({ show: false, sound: 'Tink' });
	expect(
		notificationDecision(
			'failed',
			{ ...prefs, sounds: { ...prefs.sounds, failed: null } },
			task,
			background
		)
	).toEqual({ show: true, sound: null });
});
it('suppresses only the visible task in an active app, using the full project/task key', () => {
	const prefs = defaultNotificationPreferences;
	expect(notificationDecision('failed', prefs, task, { active: true, task })).toEqual({
		show: false,
		sound: null,
	});
	expect(notificationDecision('failed', prefs, task, { active: false, task })).toEqual({
		show: true,
		sound: 'Basso',
	});
	expect(
		notificationDecision('failed', prefs, task, {
			active: true,
			task: { ...task, projectId: 'two' },
		})
	).toEqual({ show: true, sound: 'Basso' });
	expect(
		notificationDecision('failed', { ...prefs, muteVisibleTask: false }, task, {
			active: true,
			task,
		})
	).toEqual({ show: true, sound: 'Basso' });
});
it('ignores progress, tools, snapshot failures and user cancellation; never invents rate-limit data', () => {
	for (const event of [
		{ kind: 'message.delta' },
		{ kind: 'tool.changed' },
		{ kind: 'usage.changed' },
		{ kind: 'snapshot.failed' },
		{ kind: 'host.stopped' },
		{ kind: 'turn.started' },
		{ kind: 'turn.completed', reason: 'cancelled' },
	])
		expect(noticeKind(event as SessionEvent)).toBeNull();
	expect(
		noticeKind({ kind: 'crew.plan.requested', plan: { id: 'p', summary: '', parts: [] } })
	).toBe('needs-you');
	expect(noticeKind({ kind: 'turn.completed', reason: 'end_turn' })).toBe('turn-ended');
	expect(noticeKind({ kind: 'session.failed', message: 'rate limited?' })).toBe('failed');
	expect(noticeKind({ kind: 'permission.requested' } as SessionEvent)).toBe('needs-you');
	expect(noticeKind({ kind: 'question.requested' } as SessionEvent)).toBe('needs-you');
});
it('uses only advertised one-time permission choices for native notification actions', () => {
	const request = {
		id: 'permission',
		tool: { id: 'tool' },
		options: [
			{ id: 'persist', name: 'Always', kind: 'allow_always' },
			{ id: 'deny-persist', name: 'Never', kind: 'reject_always' },
		],
	};
	expect(notificationPermissionChoices(request)).toEqual({ allow: null, deny: null });
	request.options.push(
		{ id: 'once', name: 'Allow once', kind: 'allow_once' },
		{ id: 'deny', name: 'Deny', kind: 'reject_once' }
	);
	expect(notificationPermissionChoices(request)).toEqual({ allow: 'once', deny: 'deny' });
});
it('validates preferences strictly and addresses sounds by safe file stems only', () => {
	expect(isNotificationPreferences(defaultNotificationPreferences)).toBe(true);
	expect(
		isNotificationPreferences({
			...defaultNotificationPreferences,
			sounds: { ...defaultNotificationPreferences.sounds, failed: null },
		})
	).toBe(true);
	for (const invalid of [
		null,
		{},
		{ ...defaultNotificationPreferences, mode: 'always' },
		{ ...defaultNotificationPreferences, enabled: true },
		{ ...defaultNotificationPreferences, soundMode: 'loud' },
		{ ...defaultNotificationPreferences, sounds: { needsYou: 'Ping' } },
		{
			...defaultNotificationPreferences,
			sounds: { ...defaultNotificationPreferences.sounds, failed: '../etc/passwd' },
		},
		{
			...defaultNotificationPreferences,
			sounds: { ...defaultNotificationPreferences.sounds, failed: '/System/Library/Sounds/Basso' },
		},
		{ ...defaultNotificationPreferences, extra: 1 },
	])
		expect(isNotificationPreferences(invalid)).toBe(false);
	expect(isSoundName('Hero')).toBe(true);
	expect(isSoundName('My Sound (2)')).toBe(true);
	expect(isSoundName('a/b')).toBe(false);
	expect(isSoundName('')).toBe(false);
	expect(isSoundName('x'.repeat(65))).toBe(false);
});
it('reads the two-control preferences written before spec/notifications-slack-notes-and-schedules#macos-permission as one mode', () => {
	const legacy = {
		enabled: true,
		scope: 'turn-ended',
		soundMode: 'needs-you',
		sounds: defaultNotificationPreferences.sounds,
		muteVisibleTask: true,
	};
	expect(migrateNotificationPreferences(legacy)).toEqual({
		mode: 'turn-ended',
		soundMode: 'needs-you',
		sounds: defaultNotificationPreferences.sounds,
		muteVisibleTask: true,
	});
	expect(migrateNotificationPreferences({ ...legacy, enabled: false })).toMatchObject({
		mode: 'off',
	});
	expect(isNotificationPreferences(migrateNotificationPreferences(legacy))).toBe(true);
	expect(migrateNotificationPreferences(defaultNotificationPreferences)).toBe(
		defaultNotificationPreferences
	);
	for (const value of ['granted', 'denied', 'not-determined', 'unknown'])
		expect(isNotificationPermission(value)).toBe(true);
	expect(isNotificationPermission('provisional')).toBe(false);
});
