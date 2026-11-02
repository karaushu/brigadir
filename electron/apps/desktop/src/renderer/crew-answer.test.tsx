import { expect, it } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import type { CrewQuestion } from '@brigadir/core';
import { CrewAnswerRow } from './Crew';
const question: CrewQuestion = {
	id: '00000000-0000-4000-8000-000000000001',
	workerTaskId: '00000000-0000-4000-8000-000000000002',
	parentTaskId: '00000000-0000-4000-8000-000000000003',
	callId: 'call-1',
	agent: 'Reviewer',
	question: 'Keep the legacy orderId alias?',
	options: [],
	createdAt: '2026-10-02T10:00:00.000Z',
	escalateAt: '2026-10-02T10:05:00.000Z',
	state: 'answered',
};
const noop = () => {};
it('folds the answer to a crew question into one plate with the question (spec/chat#tool-calls)', () => {
	const html = renderToStaticMarkup(
		<CrewAnswerRow
			question={question}
			answer={'Yes, keep it.\n- Remove in wave 2.'}
			answeredBy="foreman"
			locale="uk"
			open={false}
			onToggle={noop}
		/>
	);
	expect(html).toMatch(/^<details[^>]*data-crew-row="answer"/);
	expect(html).not.toContain(' open=""');
	const head = /<summary[\s\S]*<\/summary>/
		.exec(html)![0]
		.replace(/<svg[\s\S]*?<\/svg>/g, '')
		.replace(/<[^>]+>/g, '');
	expect(head).toBe('питанняРевʼюер · Keep the legacy orderId alias?відповів бригадир');
	expect(html).toContain('<p>Yes, keep it.\n- Remove in wave 2.</p>');
	expect(
		renderToStaticMarkup(
			<CrewAnswerRow
				question={question}
				answer="Yes"
				answeredBy="human"
				locale="en"
				open
				onToggle={noop}
			/>
		)
	).toContain('answered by you');
});
it('shows an interrupted answer as a plate without a disclosure', () => {
	const html = renderToStaticMarkup(
		<CrewAnswerRow
			question={question}
			answer={null}
			answeredBy={null}
			locale="en"
			open={false}
			onToggle={noop}
		/>
	);
	expect(html).not.toContain('<details');
	expect(html).toContain('Interrupted');
});
