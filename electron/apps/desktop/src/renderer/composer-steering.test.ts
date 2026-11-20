import { expect, it } from 'vitest';
import { steeringState } from './composer-steering';

const running = {
	busy: true,
	adopted: false,
	steering: true,
	paused: false,
	rateLimited: false,
	budgetHeld: false,
	planWaiting: false,
};

it('offers Send now only while steering is available (spec/composer-steering-queue-and-ghost#queue-deck)', () => {
	expect(steeringState(running)).toEqual({ steering: true, sendNow: true });
	// A plan waiting for approval: Enter answers the plan, a queued row has no Send now.
	expect(steeringState({ ...running, planWaiting: true })).toEqual({
		steering: true,
		sendNow: false,
	});
	// The budget pause refuses steering: the composer queues and the deck has no Send now.
	expect(steeringState({ ...running, budgetHeld: true })).toEqual({
		steering: false,
		sendNow: false,
	});
	for (const off of ['paused', 'rateLimited', 'adopted'] as const)
		expect(steeringState({ ...running, [off]: true }).sendNow).toBe(false);
	expect(steeringState({ ...running, busy: false }).sendNow).toBe(false);
	expect(steeringState({ ...running, steering: false }).sendNow).toBe(false);
});
