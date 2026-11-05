import { expect, it } from 'vitest';
import { slackLocalize } from './slack-mentions';
import { isSlackWatch, slackWatchReply, type SlackWatch } from './slack-watches';
import { slackText } from './slack';

const pr = {
	projectId: 'p',
	taskId: 't',
	scopeId: 's',
	number: 12,
	url: 'https://github.com/o/r/pull/12',
};
const watch: SlackWatch = {
	id: 'w1',
	kind: 'ci',
	channel: 'C1',
	ts: '1.0',
	by: 'U2CD',
	language: 'uk',
	created: 1,
	task: { projectId: 'p', id: 't', title: 'Phone validation' },
	pr,
};

it('keeps only well-formed watches from the file', () => {
	expect(isSlackWatch(watch)).toBe(true);
	expect(isSlackWatch({ ...watch, run: { id: 5, bell: true }, outbox: 'x' })).toBe(true);
	expect(isSlackWatch({ ...watch, pr: null })).toBe(false);
	expect(isSlackWatch({ ...watch, kind: 'task-done', task: null, pr: null })).toBe(false);
	expect(isSlackWatch({ ...watch, kind: 'deploy' })).toBe(false);
	expect(isSlackWatch({ ...watch, last: 'sleeping' })).toBe(false);
});

it('writes the watch texts and puts them into Ukrainian', () => {
	const text = slackWatchReply.watching([
		watch,
		{ ...watch, kind: 'pr-merged' },
		{ ...watch, kind: 'task-done', pr: null },
	]);
	expect(text).toBe(
		[
			'👀 *Watching* — I’ll write here when:',
			'• 🧪 CI finishes — <https://github.com/o/r/pull/12|#12>',
			'• 🔀 PR is merged — <https://github.com/o/r/pull/12|#12>',
			'• 🏁 Task is done — Phone validation',
		].join('\n')
	);
	expect(slackLocalize(text, 'uk')).toBe(
		[
			'👀 *Стежу* — напишу тут, коли:',
			'• 🧪 CI завершиться — <https://github.com/o/r/pull/12|#12>',
			'• 🔀 PR змержать — <https://github.com/o/r/pull/12|#12>',
			'• 🏁 Задачу закінчать — Phone validation',
		].join('\n')
	);
	expect(slackLocalize(slackWatchReply.stopped(1), 'uk')).toBe('🛑 *Більше не стежу*');
	expect(slackLocalize(slackWatchReply.expired(watch), 'uk')).toBe(
		'⌛ *Перестав стежити через 7 днів*\n🧪 CI завершиться — <https://github.com/o/r/pull/12|#12>'
	);
	expect(slackLocalize(slackWatchReply.noPR([12]), 'uk')).toBe(
		'🔎 *Немає PR #12 серед задач Бригадира*'
	);
	const ci = slackText(
		{
			kind: 'ci',
			state: 'fail',
			repo: 'r',
			branch: 'claude/phone',
			environment: null,
			task: watch.task,
			seconds: 372,
			link: 'https://github.com/o/r/actions/runs/1',
			error: null,
		},
		'<@U2CD>'
	);
	expect(slackLocalize(ci, 'uk')).toBe(
		[
			'<@U2CD>',
			'❌ *CI впав* — r (`claude/phone`)',
			'🌐 Середовище: *claude/phone*',
			'📋 Задача: Phone validation',
			'⏱️ Тривалість: 6 хв 12 с',
			'🔗 <https://github.com/o/r/actions/runs/1|Відкрити run>',
		].join('\n')
	);
});
