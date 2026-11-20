import { forwardRef, useImperativeHandle, useRef, type ReactNode } from 'react';
import { t, type Locale } from '@brigadir/core';
import { ComposerBar, ComposerIsland, ComposerText } from './ui/ComposerIsland';
import { ComposerSend } from './ComposerSend';
import { useMentionEditor } from './mention-editor';

export type ChatComposerHandle = {
	/** Puts the caret at the end of the text and takes the focus. */
	focus(): void;
};
/**
 * spec/composer#chat-composer (rule 17): the task composer, simplified for the chats that are not a task — the Brigadir chat and the
 * note chat. The same island, the same editor (Markdown keys, `↩` sends, `⇧↩` breaks the line) and the same Send and Stop
 * circles; no attachments, no `@` or `/` menus, no context meter, no agent capsule unless the chat passes its own controls, no
 * environment footer.
 */
export const ChatComposer = forwardRef<
	ChatComposerHandle,
	{
		locale: Locale;
		value: string;
		onChange(value: string): void;
		placeholder: string;
		/** The agent answers now: Stop replaces Send. */ busy: boolean;
		stopDisabled?: boolean;
		onSend(): void;
		onStop(): void;
		/** A row over the text (the note chat's «changed» chip). */ context?: ReactNode;
		/** Controls left of Send (the note chat's model capsule). */ controls?: ReactNode;
		className?: string;
	}
>(function ChatComposer(
	{
		locale,
		value,
		onChange,
		placeholder,
		busy,
		stopDisabled = false,
		onSend,
		onStop,
		context,
		controls,
		className,
	},
	ref
) {
	const form = useRef<HTMLFormElement>(null);
	const editor = useMentionEditor({
		value,
		onChange,
		ariaLabel: placeholder,
		placeholder,
		find: () => [],
		findKey: '',
		groups: [],
		empty: null,
		onPick: () => null,
		keys: [
			{
				key: 'Enter',
				run: (view) => {
					if (view.composing) return false;
					form.current?.requestSubmit();
					return true;
				},
			},
		],
		menu: {
			label: t(locale, 'Mention'),
			tabsLabel: t(locale, 'Mention groups'),
			allLabel: t(locale, 'All mentions'),
			hint: t(locale, 'next tab'),
			emptyTab: t(locale, 'No matches'),
			placement: 'caret',
		},
	});
	useImperativeHandle(ref, () => ({ focus: () => editor.handle.focus('end') }), [editor.handle]);
	const filled = Boolean(value.trim());
	return (
		<ComposerIsland
			ref={form}
			className={className}
			data-chat-composer
			onSubmit={(event) => {
				event.preventDefault();
				if (!busy && filled) onSend();
			}}>
			{context}
			<ComposerText ref={editor.host} onClick={() => editor.handle.focus()} />
			{editor.menu}
			<ComposerBar attach={null}>
				{controls}
				<ComposerSend
					locale={locale}
					busy={busy}
					steers={false}
					filled={!busy && filled}
					stopDisabled={stopDisabled}
					sendDisabled={busy || !filled}
					stopShortcut={undefined}
					queueShortcut={undefined}
					onStop={onStop}
					onSendNow={onSend}
					onQueue={() => {}}
				/>
			</ComposerBar>
		</ComposerIsland>
	);
});
