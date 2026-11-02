import { t, type Locale, type MessageKey } from '@brigadir/core';

/** Main's refusals arrive as English text inside the IPC error; they are shown from the catalog. */
const known: MessageKey[] = [
	'Add the repo to the task before merging.',
	'Wait for the agent to finish before merging.',
	'Commit or stash the changes before merging.',
	'Merge into the current branch only.',
	'A merge is already in progress.',
	'Resolve every conflict place first.',
	'No conflict places are left.',
	'The branch is unavailable',
];
export function gitErrorText(locale: Locale, error: unknown): string {
	const message = error instanceof Error ? error.message : String(error);
	const key = known.find((item) => message.includes(item));
	return t(locale, key ?? 'The request failed.');
}
