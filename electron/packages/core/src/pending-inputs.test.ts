import { expect, it } from 'vitest';
import { pendingInputs, type CrewQuestion, type EventRecord } from './index';

const record = (seq: number, event: EventRecord['event']): EventRecord => ({
	schemaVersion: 1,
	seq,
	at: new Date(Date.UTC(2026, 9, 16, 12, 0, seq)).toISOString(),
	event,
});
const question: CrewQuestion = {
	id: 'q1',
	workerTaskId: 'w1',
	parentTaskId: 'crew',
	callId: 'c1',
	agent: 'd1',
	question: 'Which endpoint?',
	options: ['/v1', '/v2'],
	createdAt: '2026-10-16T12:00:00.000Z',
	escalateAt: '2026-10-16T12:05:00.000Z',
	state: 'pending',
};
/** spec/crew#ask-foreman: the worker's question waits for the foreman; after the escalation the person's card can answer it (phone and computer). */
it('follows a crew question from pending to escalated to answered', () => {
	const asked = [record(1, { kind: 'crew.question.requested', question })];
	expect(pendingInputs(asked).crewQuestions.map((item) => item.state)).toEqual(['pending']);
	const escalated = [...asked, record(2, { kind: 'crew.question.escalated', id: 'q1' })];
	expect(pendingInputs(escalated).crewQuestions.map((item) => item.state)).toEqual(['escalated']);
	expect(
		pendingInputs([
			...escalated,
			record(3, { kind: 'crew.question.resolved', id: 'q1', answer: '/v2', answeredBy: 'human' }),
		]).crewQuestions
	).toEqual([]);
	// An escalation of a question the log never asked changes nothing.
	expect(
		pendingInputs([record(1, { kind: 'crew.question.escalated', id: 'q9' })]).crewQuestions
	).toEqual([]);
});
