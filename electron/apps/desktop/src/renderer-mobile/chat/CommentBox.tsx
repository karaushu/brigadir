/**
 * spec/remote-access-and-mobile#phone-task-tools: the PR's comment box — the phone composer's island (`Composer.module.css`, rule 17) in one
 * row: the field and Send. A reply to a thread says whom it answers and can be let go of with ×.
 */
import { useState } from 'react';
import { t, type Locale } from '@brigadir/core';
import { Icon } from '../ui/Icon';
import c from './Composer.module.css';
import s from './CommentBox.module.css';

export function CommentBox({
	locale,
	placeholder,
	disabled,
	replyTo,
	cancelReply,
	send,
}: {
	locale: Locale;
	placeholder: string;
	disabled: boolean;
	/** The author a reply answers; null — a comment on the PR. */
	replyTo: string | null;
	cancelReply(): void;
	send(text: string): Promise<boolean>;
}) {
	const [text, setText] = useState(''),
		[sending, setSending] = useState(false);
	const filled = text.trim().length > 0;
	return (
		<div className={c.wrap} data-comment-box data-reply={replyTo ?? undefined}>
			<div className={`${c.island} ${s.island}`}>
				{replyTo && (
					<button
						type="button"
						className={`${c.circle} ${s.cancel}`}
						aria-label={t(locale, 'Cancel the reply')}
						onClick={cancelReply}>
						<Icon name="x2" size={20} />
					</button>
				)}
				<textarea
					className={`${c.field} ${s.field}`}
					rows={1}
					value={text}
					disabled={disabled || sending}
					aria-label={placeholder}
					placeholder={placeholder}
					onChange={(event) => setText(event.target.value)}
				/>
				<button
					type="button"
					className={c.send}
					data-idle={!filled || undefined}
					aria-label={t(locale, 'Send the comment')}
					disabled={disabled || sending || !filled}
					data-comment-send
					onClick={() => {
						setSending(true);
						void send(text.trim())
							.then((ok) => ok && setText(''))
							.finally(() => setSending(false));
					}}>
					<Icon name="up" size={20} />
				</button>
			</div>
		</div>
	);
}
