import { describe, expect, it } from 'vitest';
import { moveVerdict } from './board-moves';

describe('the phone’s board moves (spec/remote-access-and-mobile#phone-pr-list)', () => {
	it('allows what the computer’s board allows and says what a release does', () => {
		expect(moveVerdict({ status: 'backlog' }, 'progress')).toMatchObject({
			move: 'start',
			hint: 'Release — the agent starts',
			confirm: false,
		});
		expect(moveVerdict({ status: 'completed' }, 'progress')).toMatchObject({ move: 'await-input' });
		expect(moveVerdict({ status: 'done' }, 'completed')).toMatchObject({
			move: 'stop-complete',
			confirm: false,
		});
	});
	it('asks first when the move stops an agent that works or waits', () => {
		expect(moveVerdict({ status: 'working' }, 'completed')).toMatchObject({ confirm: true });
		expect(moveVerdict({ status: 'needs-you' }, 'backlog')).toMatchObject({
			move: 'stop-backlog',
			confirm: true,
		});
	});
	it('refuses backlog ↔ completed with the reason and says nothing over its own column', () => {
		expect(moveVerdict({ status: 'backlog' }, 'completed')).toEqual({
			move: null,
			column: 'completed',
			hint: 'From the backlog only to “In progress”',
		});
		expect(moveVerdict({ status: 'completed' }, 'backlog').hint).toBe(
			'From completed only to “In progress”'
		);
		expect(moveVerdict({ status: 'working' }, 'progress')).toEqual({
			move: null,
			column: 'progress',
			hint: null,
		});
	});
});
