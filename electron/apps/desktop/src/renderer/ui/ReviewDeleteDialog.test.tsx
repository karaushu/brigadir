import { expect, it } from 'vitest';
import { reviewDeleteError } from './ReviewDeleteDialog';
it('names the action and the object when deleting the review fails (spec/notifications-slack-notes-and-schedules#message-classes)', () => {
	expect(reviewDeleteError('en', new Error('EACCES: permission denied'), 3)).toBe(
		'Could not delete the review comments.'
	);
	expect(reviewDeleteError('uk', new Error('EACCES'), 3)).toBe(
		'Не вдалося видалити коментарі ревʼю.'
	);
	expect(reviewDeleteError('en', new Error('EACCES'), 0)).toBe(
		'Could not delete the general note draft.'
	);
	expect(reviewDeleteError('uk', new Error('EACCES'), 0)).toBe(
		'Не вдалося видалити чернетку загальної нотатки.'
	);
	expect(reviewDeleteError('en', new Error('Review changed'), 3)).toBe(
		'The review changed. Cancel deletion and check the comments.'
	);
});
