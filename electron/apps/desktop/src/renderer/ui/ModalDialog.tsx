import {
	useEffect,
	useId,
	useRef,
	type CSSProperties,
	type KeyboardEvent,
	type ReactNode,
	type RefObject,
} from 'react';
import { createPortal } from 'react-dom';
import { t, type Locale } from '@brigadir/core';
import { IconButton } from './Controls';
import { Glyph } from './Glyph';
import { PopupClose } from './PopupClose';
import s from './ModalDialog.module.css';

/**
 * A modal card with a header (an optional Back, the name, `Esc` — rule 14), a body and a footer of actions on a tint —
 * the look of the merge dialog (MergeDialog.module.css), shared by the remote access dialogs
 * (`Change password`, the log, pairing, `Connect`). Focus goes to `initialFocus` (or the dialog) and back on close.
 */
export function ModalDialog({
	title,
	locale,
	close,
	back,
	width = 460,
	top = 96,
	footer,
	children,
	initialFocus,
	role = 'dialog',
	note,
	icon,
	headerExtra,
	onKeyDown,
	large = false,
	divided = false,
	radius,
	...data
}: {
	/** spec/appearance#evolution-redesign: almost the whole window (24 px off each edge), a 44 px header of M controls over a hairline, no body
	 *  padding — the review of a PR. */ large?: boolean;
	/** spec/appearance#dialogs: a hairline under a 12/16 header with a 13/600 name that wraps, a 16 px body
	 *  that scrolls, a 12/16 footer; the window's side gutter is 32. Rename and the document viewer. */ divided?: boolean;
	/** The card's corner, when it differs from 11 (Rename: 10). */ radius?: number;
	title: string;
	/** A sign before the name: the file's icon in the merge view (spec/appearance#evolution-redesign). */ icon?: ReactNode;
	/** A dim second part after the name (spec/git#commit-dialog: the commit dialog's file count and +N −M). */ note?: ReactNode;
	/** Controls in the header before `Esc`, of the header's size (rule 16). */ headerExtra?: ReactNode;
	/** The dialog's own keys (⌘↩ in the commit dialog); Esc stays the dialog's. */ onKeyDown?(
		event: KeyboardEvent<HTMLDialogElement>
	): void;
	locale: Locale;
	close(): void;
	/** A Back button before the name (a step of a flow). */ back?: (() => void) | undefined;
	width?: number;
	/** The distance from the window's top, or `center` — in the middle of the window, at most 80 % of its height. */
	top?: number | 'center';
	footer?: ReactNode;
	children: ReactNode;
	initialFocus?: RefObject<HTMLElement | null>;
	role?: 'dialog' | 'alertdialog';
} & { [key: `data-${string}`]: string | boolean | undefined }) {
	const ref = useRef<HTMLDialogElement>(null),
		label = useId();
	useEffect(() => {
		const previous = document.activeElement,
			dialog = ref.current!;
		dialog.showModal();
		(initialFocus?.current ?? dialog).focus({ preventScroll: true });
		return () => {
			dialog.close();
			if (previous instanceof HTMLElement && previous.isConnected && !previous.matches(':disabled'))
				previous.focus({ preventScroll: true });
		};
	}, []);
	// In the body, not inside the dialog that opened it: Settings styles its own header and inputs by descent.
	return createPortal(
		<dialog
			{...data}
			ref={ref}
			role={role}
			tabIndex={-1}
			className={s.dialog}
			data-large={large || undefined}
			data-divided={divided || undefined}
			data-center={(!large && top === 'center') || undefined}
			aria-labelledby={label}
			style={
				{
					...(large
						? {}
						: {
								'--modal-w': `${width}px`,
								...(top === 'center' ? {} : { '--modal-top': `${top}px` }),
							}),
					...(radius === undefined ? {} : { '--modal-r': `${radius}px` }),
				} as CSSProperties
			}
			onKeyDown={(event) => {
				// The dialog closes itself; a dialog under it (Settings) must not see this Esc too.
				if (event.key === 'Escape') event.stopPropagation();
				else onKeyDown?.(event);
			}}
			onCancel={(event) => {
				// React bubbles `cancel` to a dialog this one is rendered in (Settings): only this one closes.
				event.preventDefault();
				event.stopPropagation();
				close();
			}}>
			<header className={s.header} data-size={large ? 'm' : 's'}>
				{back && (
					<IconButton variant="ghost" className={s.back} label={t(locale, 'Back')} onClick={back}>
						<Glyph name="back" size={14} />
					</IconButton>
				)}
				<h2 id={label}>
					{icon && <span className={s.icon}>{icon}</span>}
					{title}
					{note && <span className={s.note}>{note}</span>}
				</h2>
				{headerExtra}
				<PopupClose locale={locale} close={close} />
			</header>
			<div className={s.body}>{children}</div>
			{footer && (
				<footer className={s.footer} data-size="m">
					{footer}
				</footer>
			)}
		</dialog>,
		document.body
	);
}
