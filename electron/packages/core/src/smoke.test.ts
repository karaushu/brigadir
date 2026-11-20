import { describe, expect, it } from 'vitest';
import { isSessionEvent } from './event-validation';
import { noticeKind, notificationDecision, defaultNotificationPreferences } from './notifications';
import type { EventRecord, SessionEvent } from './session';
import {
	readyScreens,
	smokeBlocks,
	smokeCounts,
	smokeLeftMs,
	smokeOpen,
	smokeReportSteps,
	smokeReviewParagraph,
	smokeRunOf,
} from './smoke';
import { taskActivity } from './task-activity';

const at = (minute: number) => new Date(Date.UTC(2026, 10, 20, 10, minute)).toISOString();
const journal = (...items: [number, SessionEvent][]): EventRecord[] =>
	items.map(([minute, event], index) => ({
		schemaVersion: 1,
		seq: index + 1,
		at: at(minute),
		event,
	}));
const started: SessionEvent = {
	kind: 'smoke.started',
	id: 's1',
	steps: ['Clients list', 'Client card'],
	limitMs: 10 * 60_000,
};
describe('spec/smoke-run#data', () => {
	it('follows a run from its start through the limit to the report', () => {
		const running = journal([0, started]);
		const run = smokeRunOf(running)!;
		expect(run.state).toBe('running');
		expect(smokeOpen(run)).toBe(true);
		expect(smokeBlocks(run)).toBe(false);
		expect(smokeLeftMs(run, Date.parse(at(4)))).toBe(6 * 60_000);
		const extended = journal(
			[0, started],
			[3, { kind: 'smoke.extended', id: 's1', limitMs: 15 * 60_000, by: 'person' }]
		);
		expect(smokeRunOf(extended)!.limitMs).toBe(15 * 60_000);
		const stopped = journal(
			[0, started],
			[10, { kind: 'smoke.stopped', id: 's1', cause: 'limit' }]
		);
		expect(smokeRunOf(stopped)).toMatchObject({ state: 'stopped', cause: 'limit' });
		expect(smokeBlocks(smokeRunOf(stopped))).toBe(true);
		const reported = journal(
			[0, started],
			[10, { kind: 'smoke.stopped', id: 's1', cause: 'limit' }],
			[
				11,
				{
					kind: 'smoke.reported',
					id: 's1',
					steps: [{ step: 'Clients list', result: 'passed' }],
					summary: 'ok',
					elapsedMs: 600_000,
					stopped: 'limit',
				},
			]
		);
		expect(smokeRunOf(reported)!.state).toBe('reported');
		expect(smokeOpen(smokeRunOf(reported))).toBe(false);
		expect(smokeBlocks(smokeRunOf(reported))).toBe(false);
		// Events of another run, and an extension after the stop, change nothing.
		const other = journal(
			[0, started],
			[1, { kind: 'smoke.stopped', id: 'other', cause: 'person' }],
			[2, { kind: 'smoke.stopped', id: 's1', cause: 'person' }],
			[3, { kind: 'smoke.extended', id: 's1', limitMs: 20 * 60_000, by: 'person' }]
		);
		expect(smokeRunOf(other)).toMatchObject({
			state: 'stopped',
			cause: 'person',
			limitMs: 600_000,
		});
	});
	it('keeps every started step: one the report leaves out is unchecked, extra ones stay', () => {
		const steps = smokeReportSteps(
			['Clients list', 'Client card', 'Notes'],
			[
				{ step: ' client card ', result: 'failed', note: 'no avatar' },
				{ step: 'Clients list', result: 'passed' },
				{ step: 'Dark theme', result: 'passed' },
			]
		);
		expect(steps).toEqual([
			{ step: 'Clients list', result: 'passed' },
			{ step: 'client card', result: 'failed', note: 'no avatar' },
			{ step: 'Notes', result: 'unchecked', missing: true },
			{ step: 'Dark theme', result: 'passed' },
		]);
		expect(smokeCounts(steps)).toEqual({ all: 4, checked: 3, failed: 1, unchecked: 1 });
	});
	it('validates the journal events of a run and of Ready to look', () => {
		expect(isSessionEvent(started)).toBe(true);
		expect(isSessionEvent({ ...started, steps: [] })).toBe(false);
		expect(isSessionEvent({ kind: 'smoke.stopped', id: 's1', cause: 'later' })).toBe(false);
		expect(
			isSessionEvent({
				kind: 'smoke.reported',
				id: 's1',
				steps: [{ step: 'a', result: 'unchecked', missing: true }],
				summary: 'x',
				elapsedMs: 1,
			})
		).toBe(true);
		expect(
			isSessionEvent({
				kind: 'smoke.reported',
				id: 's1',
				steps: [{ step: 'a', result: 'maybe' }],
				summary: 'x',
				elapsedMs: 1,
			})
		).toBe(false);
		expect(
			isSessionEvent({ kind: 'smoke.dropped', id: 's1', reason: 'cancelled', elapsedMs: 0 })
		).toBe(true);
		expect(
			isSessionEvent({
				kind: 'task.ready',
				id: 'r1',
				screen: 'Details screen',
				where: 'simulator',
				device: 'iPhone 17 Pro',
			})
		).toBe(true);
		expect(isSessionEvent({ kind: 'task.ready', id: 'r1', screen: '', where: 'simulator' })).toBe(
			false
		);
	});
	it('tells the reviewer the newest report, or that none ran (spec/reviews#smoke)', () => {
		expect(smokeReviewParagraph(null)).toContain('No smoke run checked this change');
		const reported = journal(
			[0, started],
			[
				7,
				{
					kind: 'smoke.reported',
					id: 's1',
					steps: [
						{ step: 'Clients list', result: 'passed' },
						{ step: 'Client card', result: 'failed', note: 'no avatar' },
						{ step: 'Notes', result: 'unchecked', missing: true },
					],
					summary: 'Card broken.',
					elapsedMs: 420_000,
				},
			]
		);
		const text = smokeReviewParagraph(smokeRunOf(reported));
		expect(text).toContain('ended in time');
		expect(text).toContain('- [failed] Client card — no avatar');
		expect(text).toContain('- [unchecked] Notes — not in the report');
		expect(text).toContain(
			'A failed step that the change since this report does not fix is a finding'
		);
	});
});
describe('spec/smoke-run#ready-surfaces', () => {
	it('a Ready to look notifies as its own kind: shown while notifications are on, sounding as a turn end', () => {
		const ready: SessionEvent = {
			kind: 'task.ready',
			id: 'r1',
			screen: 'Details',
			where: 'browser',
			tab: 'b1',
			url: 'http://localhost:3000/details',
		};
		expect(noticeKind(ready)).toBe('ready');
		const visibility = { active: false, task: null },
			key = { projectId: 'p', id: 't' };
		expect(notificationDecision('ready', defaultNotificationPreferences, key, visibility)).toEqual({
			show: true,
			sound: null,
		});
		expect(
			notificationDecision(
				'ready',
				{ ...defaultNotificationPreferences, soundMode: 'turn-ended' },
				key,
				visibility
			)
		).toEqual({ show: true, sound: 'Tink' });
		expect(
			notificationDecision(
				'ready',
				{ ...defaultNotificationPreferences, mode: 'off' },
				key,
				visibility
			).show
		).toBe(false);
		// The turn's end keeps its own rule.
		expect(
			notificationDecision('turn-ended', defaultNotificationPreferences, key, visibility).show
		).toBe(false);
	});
	it('the activity line keeps Ready to look over tools until the turn ends or a request waits', () => {
		const ready: SessionEvent = {
			kind: 'task.ready',
			id: 'r1',
			screen: 'Details',
			where: 'simulator',
		};
		const tool: SessionEvent = {
			kind: 'tool.changed',
			patch: { id: 'x', title: 'Edit', locations: [{ path: 'a.ts' }] },
		} as SessionEvent;
		expect(
			taskActivity(journal([0, { kind: 'turn.started', text: 'go' }], [1, ready], [2, tool]))
		).toMatchObject({
			kind: 'ready',
		});
		expect(
			taskActivity(
				journal(
					[1, ready],
					[
						2,
						{
							kind: 'question.requested',
							question: {
								id: 'q',
								question: 'Which?',
								header: '',
								options: [],
								allowsFreeText: true,
								allowsMultiple: false,
							},
						} as SessionEvent,
					]
				)
			)
		).toMatchObject({ kind: 'question' });
		expect(
			taskActivity(journal([1, ready], [2, { kind: 'turn.completed', reason: 'end_turn' }]))
		).toBeNull();
		expect(readyScreens(journal([1, ready])).has('details')).toBe(true);
	});
});
