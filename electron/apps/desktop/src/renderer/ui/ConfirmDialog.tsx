import { useEffect, useId, useRef, useState, type ReactNode, type RefObject } from 'react';
import { createPortal } from 'react-dom';
import { t, type Locale } from '@brigadir/core';
import { Button } from './Controls';
import { PopupHeader } from './Popover';
import s from './ConfirmDialog.module.css';

/**
 * spec/git#main-tree-branches: a short confirm of a git action — the popover's shell as a modal: the name and Esc in the header (rule 14),
 * what happens, Cancel and the action. Focus starts on Cancel and goes back where it was.
 */
export function ConfirmDialog({
	title,
	icon,
	locale,
	action,
	danger = false,
	cancel,
	confirm,
	error,
	returnFocus,
	children,
}: {
	title: string;
	/** A sign before the name: the warning of the review deletion (canvas 17.2). */ icon?: ReactNode;
	locale: Locale;
	action: string;
	danger?: boolean;
	/** What failed, when `confirm` throws: a fixed text or one chosen by the reason; a git action by default. */ error?:
		string | ((reason: unknown) => string);
	cancel(): void;
	confirm(): Promise<void>;
	/** Where focus goes once the dialog closes, when the element that opened it is gone (an item of a closed menu). */
	returnFocus?: RefObject<HTMLElement | null>;
	children: ReactNode;
}) {
	const ref = useRef<HTMLDialogElement>(null),
		cancelRef = useRef<HTMLButtonElement>(null),
		pending = useRef(false),
		label = useId(),
		body = useId();
	const [busy, setBusy] = useState(false),
		[failed, setFailed] = useState<string | null>(null);
	useEffect(() => {
		const previous = document.activeElement,
			dialog = ref.current!;
		dialog.showModal();
		cancelRef.current?.focus({ preventScroll: true });
		return () => {
			dialog.close();
			const target =
				previous instanceof HTMLElement && previous.isConnected ? previous : returnFocus?.current;
			if (target?.isConnected && !target.matches(':disabled'))
				target.focus({ preventScroll: true });
		};
	}, []);
	async function run() {
		if (pending.current) return;
		pending.current = true;
		setBusy(true);
		setFailed(null);
		try {
			await confirm();
		} catch (reason) {
			pending.current = false;
			setBusy(false);
			setFailed(
				typeof error === 'function' ? error(reason) : (error ?? t(locale, 'The git action failed.'))
			);
		}
	}
	const close = () => {
		if (!pending.current) cancel();
	};
	// In the body: a confirm opened from Settings must not take the Settings dialog's header and text styles.
	return createPortal(
		<dialog
			ref={ref}
			className={s.dialog}
			aria-labelledby={label}
			aria-describedby={body}
			onCancel={(event) => {
				// React bubbles `cancel` to a dialog this one is rendered in (Settings ▸ Remote): only this one closes.
				event.preventDefault();
				event.stopPropagation();
				close();
			}}>
			<PopupHeader
				title={
					<>
						{icon}
						<span id={label}>{title}</span>
					</>
				}
				locale={locale}
				close={close}
			/>
			<div id={body} className={s.body}>
				{children}
			</div>
			{failed && (
				<p className={s.error} role="alert">
					{failed}
				</p>
			)}
			<footer className={s.footer} data-size="m">
				<Button ref={cancelRef} disabled={busy} onClick={close}>
					{t(locale, 'Cancel')}
				</Button>
				<Button
					appearance={danger ? 'danger' : 'primary'}
					variant="solid"
					disabled={busy}
					onClick={() => {
						void run();
					}}>
					{action}
				</Button>
			</footer>
		</dialog>,
		document.body
	);
}
