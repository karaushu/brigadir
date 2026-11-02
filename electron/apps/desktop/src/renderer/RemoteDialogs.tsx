import { useEffect, useRef, useState } from 'react';
import {
	t,
	type Locale,
	type RemoteBox,
	type RemoteDialog,
	type RemotePage,
	type RemoteUiAnswer,
} from '@brigadir/core';
import { Button, Choice } from './ui/Controls';
import styles from './RemoteDialogs.module.css';
import { TextInput } from './ui/Input';
import { ModalDialog } from './ui/ModalDialog';
import { remoteMachine, useRemote } from './remote-store';
import { RemoteFolder } from './RemoteFolder';

/**
 * spec/remote-access-and-mobile#architecture, spec/remote-access-and-mobile#client-ui-seam: in a window of another machine, what that machine's main would have shown on its own
 * screen — a message box as our modal dialog (rule 14), a folder or file choice as its folder browser. One at a time; a
 * new one of the same kind replaces the old (the machine cancels that one too); a lost connection closes them, since
 * the machine already took them as cancelled.
 */
export function RemoteDialogs({ locale }: { locale: Locale }) {
	const [dialogs, setDialogs] = useState<RemoteDialog[]>([]);
	const state = useRemote((store) => store.session?.state ?? null);
	useEffect(() => {
		if (!remoteMachine) return;
		return window.brigadir.onRemoteDialog((dialog) =>
			setDialogs((list) => [...list.filter((item) => item.kind !== dialog.kind), dialog])
		);
	}, []);
	useEffect(() => {
		if (state !== 'connected') setDialogs([]);
	}, [state]);
	if (!remoteMachine) return null;
	const current = dialogs[0];
	if (!current) return null;
	const answer = (value: RemoteUiAnswer) => {
		setDialogs((list) => list.filter((item) => item.id !== current.id));
		void window.brigadir.answerRemoteUi(current.id, value).catch(() => {});
	};
	const machine = useRemote.getState().session?.machineName || remoteMachine.name;
	if (current.kind === 'page')
		return <RemotePageDialog key={current.id} page={current} locale={locale} answer={answer} />;
	return current.kind === 'box' ? (
		<RemoteMessageBox key={current.id} box={current} locale={locale} answer={answer} />
	) : (
		<RemoteFolder
			key={current.id}
			pick={current}
			machine={machine}
			locale={locale}
			answer={answer}
		/>
	);
}

/** A message box of the working machine: the message is the name, the detail the text, the buttons the footer. */
function RemoteMessageBox({
	box,
	locale,
	answer,
}: {
	box: RemoteBox;
	locale: Locale;
	answer(index: number): void;
}) {
	const cancel = useRef<HTMLButtonElement>(null);
	// Cancel at the left, the first button at the right edge, as the system sheet lays them out; the default is primary.
	const order = [
		box.cancelId,
		...box.buttons
			.map((_, index) => index)
			.filter((index) => index !== box.cancelId)
			.reverse(),
	];
	return (
		<ModalDialog
			title={box.message}
			locale={locale}
			close={() => answer(box.cancelId)}
			initialFocus={cancel}
			role={box.type === 'warning' || box.type === 'error' ? 'alertdialog' : 'dialog'}
			data-remote-box={box.type}
			footer={order.map((index) => (
				<Button
					key={index}
					{...(index === box.cancelId ? { ref: cancel } : {})}
					appearance={
						index === box.danger
							? 'danger'
							: index === box.defaultId && index !== box.cancelId
								? 'primary'
								: 'neutral'
					}
					{...(index === box.danger ? { variant: 'solid' as const } : {})}
					onClick={() => answer(index)}>
					{box.buttons[index]}
				</Button>
			))}>
			{box.detail
				.split('\n')
				.filter((line) => line.trim())
				.map((line, index) => (
					<p key={index}>{line}</p>
				))}
		</ModalDialog>
	);
}

/**
 * spec/remote-access-and-mobile#browser-from-device: a page of the machine's browser asks — `alert`, `confirm`, `prompt`, or before it is left. The site is
 * the name, the page's text the body; `prompt` has a field. Esc and Cancel (Stay) answer as the page's own Cancel would.
 */
function RemotePageDialog({
	page,
	locale,
	answer,
}: {
	page: RemotePage;
	locale: Locale;
	answer(value: RemoteUiAnswer): void;
}) {
	const [value, setValue] = useState(page.value),
		// P1: «Don't show more dialogs from this page», offered from the second dialog in a row.
		[mute, setMute] = useState(false),
		field = useRef<HTMLInputElement>(null),
		ok = useRef<HTMLButtonElement>(null);
	const leave = page.type === 'beforeunload';
	const reply = (choice: string | boolean | null) =>
		answer(mute ? { value: choice, mute: true } : choice);
	const accept = () => reply(page.type === 'prompt' ? value : true);
	const cancel = () => reply(page.type === 'prompt' ? null : false);
	return (
		<ModalDialog
			title={leave ? t(locale, 'Leave this page?') : page.site || t(locale, 'Browser')}
			locale={locale}
			close={cancel}
			initialFocus={page.type === 'prompt' ? field : ok}
			role={page.type === 'prompt' ? 'dialog' : 'alertdialog'}
			data-remote-page={page.type}
			footer={
				<>
					{page.type !== 'alert' && (
						<Button onClick={cancel}>{t(locale, leave ? 'Stay' : 'Cancel')}</Button>
					)}
					<Button ref={ok} appearance="primary" onClick={accept}>
						{t(locale, leave ? 'Leave' : 'OK')}
					</Button>
				</>
			}>
			{(leave ? t(locale, 'Changes you made may not be saved.') : page.message)
				.split('\n')
				.filter((line) => line.trim())
				.map((line, index) => (
					<p key={index}>{line}</p>
				))}
			{page.type === 'prompt' && (
				<TextInput
					ref={field}
					aria-label={page.message || t(locale, 'Answer')}
					value={value}
					onChange={(event) => setValue(event.target.value)}
					onKeyDown={(event) => {
						if (event.key === 'Enter') {
							event.preventDefault();
							accept();
						}
					}}
				/>
			)}
			{page.mute && (
				<label className={styles.mute}>
					<Choice
						type="checkbox"
						label={t(locale, "Don't show more dialogs from this page")}
						checked={mute}
						onChange={(event) => setMute(event.target.checked)}
					/>
					<span>{t(locale, "Don't show more dialogs from this page")}</span>
				</label>
			)}
		</ModalDialog>
	);
}
