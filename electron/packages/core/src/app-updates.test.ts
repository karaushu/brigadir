import { describe, expect, it } from 'vitest';
import {
	appUpdateLabel,
	releasePage,
	releasesPlaceholder,
	releasesRepo,
	type AppUpdateState,
} from './app-updates';
import { idleStopped, resumableStop, type EventRecord } from './session';

const state = (patch: Partial<AppUpdateState> = {}): AppUpdateState => ({
	support: 'install',
	phase: 'idle',
	current: '1.0.0',
	version: null,
	progress: null,
	checkedAt: null,
	failed: null,
	waitingTurns: null,
	releaseUrl: null,
	lastCheck: null,
	...patch,
});
const now = new Date(2026, 9, 30, 12, 0);
describe('app updates (spec/architecture-and-platform#auto-update)', () => {
	it('reads the releases repository, never the placeholder', () => {
		expect(releasesRepo('acme/brigadir-releases')).toEqual({
			owner: 'acme',
			repo: 'brigadir-releases',
		});
		expect(releasesRepo(releasesPlaceholder)).toBeNull();
		expect(releasesRepo('acme')).toBeNull();
		expect(releasesRepo('acme/../x/y')).toBeNull();
		expect(releasesRepo(undefined)).toBeNull();
		expect(releasePage({ owner: 'acme', repo: 'r' }, '1.2.0')).toBe(
			'https://github.com/acme/r/releases/tag/v1.2.0'
		);
	});
	it('says what the update does in one line, in both languages', () => {
		const checkedAt = new Date(2026, 9, 30, 9, 5).toISOString();
		expect(appUpdateLabel('en', state()).text).toBe('Version 1.0.0');
		expect(appUpdateLabel('en', state({ checkedAt }), now).text).toBe(
			'Version 1.0.0 · checked today at 09:05'
		);
		expect(appUpdateLabel('uk', state({ checkedAt }), now).text).toBe(
			'Версія 1.0.0 · перевірено сьогодні о 09:05'
		);
		expect(
			appUpdateLabel('en', state({ phase: 'downloading', version: '1.1.0', progress: 42 })).text
		).toBe('Downloading 1.1.0… 42%');
		expect(appUpdateLabel('en', state({ phase: 'ready', version: '1.1.0' })).text).toBe(
			'Brigadir 1.1.0 is ready'
		);
		expect(
			appUpdateLabel('uk', state({ phase: 'ready', version: '1.1.0', waitingTurns: 3 })).text
		).toBe('Турнів у роботі: 3. Бригадир перезапуститься, коли вони завершаться.');
		expect(appUpdateLabel('en', state({ phase: 'error', failed: 'check' }))).toEqual({
			text: 'Could not check for updates.',
			warning: true,
		});
		expect(appUpdateLabel('uk', state({ support: 'off' })).text).toBe(
			'Ця збірка не перевіряє оновлення.'
		);
	});
	it('an update stop leaves the session resumable, like an idle stop', () => {
		const record = (seq: number, event: EventRecord['event']) =>
			({ schemaVersion: 1, seq, at: '2026-10-30T10:00:00Z', event }) as EventRecord;
		expect(resumableStop('update')).toBe(true);
		expect(resumableStop('shutdown')).toBe(false);
		expect(
			idleStopped([
				record(1, { kind: 'session.started', sessionId: 's' } as EventRecord['event']),
				record(2, { kind: 'host.stopped', reason: 'update' }),
			])
		).toBe(true);
	});
});
