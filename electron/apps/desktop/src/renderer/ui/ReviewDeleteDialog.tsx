import { commentCount, reviewRemovalScope, t, type Locale } from '@brigadir/core';
import { ConfirmDialog } from './ConfirmDialog';
import { Glyph } from './Glyph';

/** spec/notifications-slack-notes-and-schedules#message-classes: a failed delete names the action and what it deletes — the comments, or only the note draft. */
export function reviewDeleteError(locale: Locale, reason: unknown, count: number): string {
	if (String(reason).includes('Review changed'))
		return t(locale, 'The review changed. Cancel and check the comments before deleting.');
	return t(
		locale,
		count > 0 ? 'Could not delete the review comments.' : 'Could not delete the general note draft.'
	);
}
/** Deleting every review comment: the shared confirm (canvas 17.2, rule 14 — the name, the warning sign and Esc in the header). */
export function ReviewDeleteDialog({
	locale,
	count,
	files,
	hasNote,
	cancel,
	confirm,
}: {
	locale: Locale;
	count: number;
	files: number;
	hasNote: boolean;
	cancel(): void;
	confirm(): Promise<void>;
}) {
	return (
		<ConfirmDialog
			locale={locale}
			danger
			icon={<Glyph name="review-warning" size={16} />}
			title={t(locale, 'Delete all review comments?')}
			action={t(locale, 'Delete')}
			error={(reason) => reviewDeleteError(locale, reason, count)}
			cancel={cancel}
			confirm={confirm}>
			<p>
				{count > 0 ? (
					<>
						<strong>{commentCount(locale, count)}</strong>
						{reviewRemovalScope(locale, files, hasNote)}
					</>
				) : (
					t(locale, 'The general note draft will be deleted. This cannot be undone.')
				)}
			</p>
		</ConfirmDialog>
	);
}
