/**
 * spec/crew#ask-foreman, spec/crew#attention on the phone: a worker's question in its foreman's chat. While the foreman may still answer, the card says
 * whose question it is and that it waits for the foreman (the person can write to the foreman below). After the escalation
 * (spec/crew#ask-foreman) the person answers for the foreman: the agent's question card (`ui/SessionInputs` Question) with the
 * worker's name in its head, the worker's options and an own answer, without «Пропустити» — the worker waits for an answer.
 */
import { useState } from 'react';
import {
	crewLabel,
	t,
	type CrewQuestion,
	type Locale,
	type QuestionAnswer,
	type SessionCommand,
	type UserQuestion,
} from '@brigadir/core';
import { Glyph } from '../../renderer/ui/Glyph';
import { Question } from '../../renderer/ui/SessionInputs';
import { markdown } from '../../renderer/markdown';
import s from './Cards.module.css';

export function CrewQuestionCard({
	question,
	locale,
	disabled,
	send,
}: {
	question: CrewQuestion;
	locale: Locale;
	disabled: boolean;
	send(command: SessionCommand): void;
}) {
	const [answer, setAnswer] = useState<QuestionAnswer>({ labels: [], text: '' });
	const agent = crewLabel(locale, question.agent);
	if (question.state !== 'escalated')
		return (
			<section
				className={s.plan}
				data-crew-question={question.id}
				aria-label={t(locale, 'Question')}>
				<header className={s.planHead}>
					<Glyph name="agent-question" size={16} />
					<span>{t(locale, 'Question')}</span>
					<small className={s.headNote}>{agent}</small>
				</header>
				<div className={s.lead}>
					<p>{question.question}</p>
				</div>
				<footer className={s.planFoot}>
					<small>{t(locale, 'waiting for the foreman')}</small>
				</footer>
			</section>
		);
	const asked: UserQuestion = {
		id: question.id,
		question: question.question,
		header: agent,
		options: question.options.map((label) => ({ label, description: '' })),
		allowsFreeText: true,
		allowsMultiple: false,
	};
	return (
		<div data-crew-question={question.id} data-escalated>
			<Question
				touch
				skip={false}
				question={asked}
				body={
					<div
						className={s.planText}
						dangerouslySetInnerHTML={{ __html: markdown.render(question.question) }}
					/>
				}
				locale={locale}
				disabled={disabled}
				answer={answer}
				onChange={setAnswer}
				since={Date.parse(question.createdAt)}
				send={(command) => {
					if (command.kind !== 'answerQuestion' || !command.answer) return;
					const text = command.answer.text.trim() || command.answer.labels[0] || '';
					if (text) send({ kind: 'answerCrewQuestion', id: question.id, answer: text });
				}}
			/>
		</div>
	);
}
