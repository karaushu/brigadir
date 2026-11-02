import { expect, it } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import { NoticeChip, NoticeLede, NoticeRepoRow } from './NoticeChip';
it('draws a class S state as one amber chip button with its place and accessible name (spec/notifications-slack-notes-and-schedules#repo-contention, spec/notifications-slack-notes-and-schedules#notice-chips)', () => {
	const html = renderToStaticMarkup(
		<NoticeChip
			locale="uk"
			placement="repo"
			icon="scope-lock"
			label="2 задачі"
			accessibleLabel="Змішані зміни: kit"
			title="Змішані зміни"
			data-test-chip="x">
			{() => null}
		</NoticeChip>
	);
	expect(html).not.toContain('data-tone');
	expect(html).toContain('data-placement="repo"');
	expect(html).toContain('data-test-chip="x"');
	expect(html).toContain('aria-label="Змішані зміни: kit"');
	expect(html).toContain('aria-haspopup="dialog"');
	expect(html).toContain('aria-expanded="false"');
	expect(html).not.toContain('role="dialog"');
});
it('gives every class S popover the same lede and repo row with its count (spec/notifications-slack-notes-and-schedules#notice-chips)', () => {
	const html = renderToStaticMarkup(
		<>
			<NoticeLede>Lede</NoticeLede>
			<NoticeRepoRow name="kit" count="2 tasks" icon="scope-lock" />
			<NoticeRepoRow name="mobile" count="3 files" />
		</>
	);
	expect(html.match(/<h4/g)).toHaveLength(2);
	expect(html.match(/data-glyph="scope-lock"/g)).toHaveLength(1);
	expect(html).toContain('kit');
	expect(html).toContain('3 files');
});
