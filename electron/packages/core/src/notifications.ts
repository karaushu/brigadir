import type { PermissionRequest } from './agent';
import type { SessionEvent, TaskKey } from './session';
import { isRecord } from './workspace';

/** spec/sidebar#layout: independent OS and in-app sound policies; native delivery lives in main. */
export type NotificationScope = 'needs-you' | 'turn-ended';
/** `page` — a notification of a page in the task's browser (spec/browser-and-simulator#notifications). */
export type NoticeKind =
	'needs-you' | 'turn-ended' | 'failed' | 'rate-limited' | 'scope-violation' | 'page';
export type SoundSlot = 'needsYou' | 'turnEnded' | 'failed';
export const soundSlots: readonly SoundSlot[] = ['needsYou', 'turnEnded', 'failed'];
/** spec/notifications-slack-notes-and-schedules#macos-permission: one «When» picker; `turn-ended` also covers needs-you. `off` silences every kind. */
export type NotificationMode = 'off' | NotificationScope;
export const notificationModes: readonly NotificationMode[] = ['off', 'needs-you', 'turn-ended'];
/** spec/notifications-slack-notes-and-schedules#macos-permission: macOS authorization of the app's own bundle; `unknown` means it cannot be read here. */
export type NotificationPermission = 'granted' | 'denied' | 'not-determined' | 'unknown';
export function isNotificationPermission(value: unknown): value is NotificationPermission {
	return (
		value === 'granted' || value === 'denied' || value === 'not-determined' || value === 'unknown'
	);
}
export type NotificationPreferences = {
	mode: NotificationMode;
	soundMode: NotificationMode;
	sounds: Record<SoundSlot, string | null>;
	muteVisibleTask: boolean;
};
export const defaultNotificationPreferences: NotificationPreferences = {
	mode: 'needs-you',
	soundMode: 'needs-you',
	sounds: { needsYou: 'Ping', turnEnded: 'Tink', failed: 'Basso' },
	muteVisibleTask: true,
};
/** A system sound is addressed by its file stem only; paths are resolved from the catalog in main. */
export function isSoundName(value: unknown): value is string {
	return (
		typeof value === 'string' &&
		/^[A-Za-z0-9][A-Za-z0-9 _.()-]{0,63}$/.test(value) &&
		!value.includes('..')
	);
}
export function isNotificationPreferences(value: unknown): value is NotificationPreferences {
	if (!isRecord(value) || Object.keys(value).length !== 4) return false;
	return (
		notificationModes.includes(value.mode as NotificationMode) &&
		notificationModes.includes(value.soundMode as NotificationMode) &&
		typeof value.muteVisibleTask === 'boolean' &&
		isRecord(value.sounds) &&
		Object.keys(value.sounds).length === soundSlots.length &&
		soundSlots.every((slot) => {
			const sound = (value.sounds as Record<string, unknown>)[slot];
			return sound === null || isSoundName(sound);
		})
	);
}
export type NotificationDecision = { show: boolean; sound: string | null };
/** spec/notifications-slack-notes-and-schedules#macos-permission: settings written before the single picker carried `enabled` and `scope`; read them as `mode`. */
export function migrateNotificationPreferences(value: unknown): unknown {
	if (!isRecord(value) || 'mode' in value || !('enabled' in value)) return value;
	const { enabled, scope, ...rest } = value;
	return { ...rest, mode: enabled === false ? 'off' : scope };
}
export function notificationDecision(
	kind: NoticeKind,
	preferences: NotificationPreferences,
	task: TaskKey,
	visibility: { active: boolean; task: TaskKey | null }
): NotificationDecision {
	if (
		preferences.muteVisibleTask &&
		visibility.active &&
		visibility.task?.id === task.id &&
		visibility.task.projectId === task.projectId
	)
		return { show: false, sound: null };
	const turn = kind === 'turn-ended';
	const show = preferences.mode !== 'off' && (!turn || preferences.mode === 'turn-ended');
	const sound =
		preferences.soundMode === 'off' || (turn && preferences.soundMode !== 'turn-ended')
			? null
			: preferences.sounds[kind === 'needs-you' ? 'needsYou' : turn ? 'turnEnded' : 'failed'];
	return { show, sound };
}
/** Only normalized semantic events qualify; never infer rate limits from prose. */
export function noticeKind(event: SessionEvent): NoticeKind | null {
	switch (event.kind) {
		case 'permission.requested':
		case 'question.requested':
		case 'task.proposal.requested':
		case 'crew.plan.requested':
			return 'needs-you';
		case 'session.failed':
			return 'failed';
		// spec/chat-turns-plans-and-questions#background-commands: a background command that failed notifies as a failure; one that finished notifies in main, only when the agent does not go on.
		case 'background.changed':
			return event.state === 'failed' ? 'failed' : null;
		case 'rate-limit.changed':
			return event.status === 'rejected' ? 'rate-limited' : null;
		case 'scope.violation':
			return 'scope-violation';
		case 'turn.completed':
			return event.reason === 'cancelled' ? null : 'turn-ended';
		default:
			return null;
	}
}
/** Notification actions must never silently grant a persistent permission. */
export function notificationPermissionChoices(request: PermissionRequest): {
	allow: string | null;
	deny: string | null;
} {
	return {
		allow: request.options.find((option) => option.kind === 'allow_once')?.id ?? null,
		deny: request.options.find((option) => option.kind === 'reject_once')?.id ?? null,
	};
}
