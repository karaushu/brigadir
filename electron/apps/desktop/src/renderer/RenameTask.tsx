import { useEffect, useId, useRef, useState, type FormEvent } from 'react';
import { isTaskTitle, t, type AgentTask, type Locale } from '@brigadir/core';
import { TextInput } from './ui/Input';
import { Button } from './ui/Controls';
import { ModalDialog } from './ui/ModalDialog';
import s from './RenameTask.module.css';
/**
 * The divided `ModalDialog` (spec/appearance#dialogs), 420 wide in the middle of the window. The title opens
 * selected; while it saves, Esc and Cancel do nothing, as in `ConfirmDialog`. Focus goes back where it was.
 */
export function RenameTask({
	task,
	locale,
	close,
	saved,
}: {
	task: AgentTask;
	locale: Locale;
	close(): void;
	saved(): Promise<void>;
}) {
	const input = useRef<HTMLInputElement>(null),
		alive = useRef(true),
		pending = useRef(false),
		form = useId(),
		[title, setTitle] = useState(task.title),
		[saving, setSaving] = useState(false),
		[error, setError] = useState(false);
	useEffect(() => {
		alive.current = true;
		// After ModalDialog's own effect has opened the dialog and focused the field.
		input.current?.select();
		return () => {
			alive.current = false;
		};
	}, []);
	const dismiss = () => {
		if (!pending.current) close();
	};
	async function submit(event: FormEvent) {
		event.preventDefault();
		if (pending.current || !isTaskTitle(title)) return;
		pending.current = true;
		setSaving(true);
		setError(false);
		try {
			await window.brigadir.renameTask(task, title);
			await saved();
			pending.current = false;
			if (alive.current) close();
		} catch {
			pending.current = false;
			if (alive.current) setError(true);
		} finally {
			if (alive.current) setSaving(false);
		}
	}
	return (
		<ModalDialog
			divided
			radius={10}
			width={420}
			top="center"
			title={t(locale, 'Rename task')}
			locale={locale}
			close={dismiss}
			initialFocus={input}
			footer={
				<>
					<Button disabled={saving} onClick={dismiss}>
						{t(locale, 'Cancel')}
					</Button>
					<Button
						appearance="primary"
						type="submit"
						form={form}
						disabled={saving || !isTaskTitle(title) || title.trim() === task.title}>
						{t(locale, saving ? 'Saving…' : 'Save')}
					</Button>
				</>
			}>
			<form id={form} className={s.form} onSubmit={(event) => void submit(event)}>
				<label>
					<span>{t(locale, 'Task title')}</span>
					<TextInput
						size="l"
						ref={input}
						value={title}
						maxLength={160}
						disabled={saving}
						onChange={(event) => setTitle(event.target.value)}
					/>
				</label>
				{error && <p role="alert">{t(locale, 'Could not rename the task.')}</p>}
			</form>
		</ModalDialog>
	);
}
