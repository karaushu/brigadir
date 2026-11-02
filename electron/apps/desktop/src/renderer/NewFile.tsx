import { useEffect, useRef, useState, type RefObject } from 'react';
import {
	newFilePath,
	t,
	type EditorDocument,
	type Locale,
	type MessageKey,
	type TaskKey,
} from '@brigadir/core';
import { Popover } from './ui/Popover';
import { Button } from './ui/Controls';
import { TextInput } from './ui/Input';
import styles from './NewFile.module.css';

const reasons: Record<'outside' | 'reserved', MessageKey> = {
	outside: 'The path is outside the task',
	reserved: 'Not inside .git or .brigadir',
};
/**
 * spec/editor#new-file: «New file…» — one path field relative to the task's root, prefilled with the folder the person is in. Enter
 * creates the file and its missing folders and opens it; a file already there offers «Open» instead.
 */
export function NewFilePopover({
	task,
	locale,
	open,
	anchor,
	initial,
	root,
	onClose,
	onOpen,
}: {
	task: TaskKey;
	locale: Locale;
	open: boolean;
	anchor: RefObject<HTMLElement | null>;
	/** The field's first text: a folder with its `/`, or empty for the root. */ initial: string;
	/** A project of several repos: the root repo's name, a fixed chip before the field. */ root:
		string | null;
	onClose(): void;
	onOpen(document: EditorDocument): void;
}) {
	const [value, setValue] = useState(initial),
		[busy, setBusy] = useState(false),
		[exists, setExists] = useState<EditorDocument | null>(null),
		[failed, setFailed] = useState<string | null>(null),
		input = useRef<HTMLInputElement>(null);
	useEffect(() => {
		if (!open) return;
		setValue(initial);
		setExists(null);
		setFailed(null);
		setBusy(false);
	}, [open, initial]);
	// The caret after the prefilled folder, where the name goes.
	useEffect(() => {
		if (!open) return;
		const frame = requestAnimationFrame(() => {
			const field = input.current;
			if (field && document.activeElement === field)
				field.setSelectionRange(field.value.length, field.value.length);
		});
		return () => cancelAnimationFrame(frame);
	}, [open]);
	const checked = newFilePath(value),
		error = !checked.ok && checked.reason !== 'empty' ? t(locale, reasons[checked.reason]) : null;
	const submit = async () => {
		if (!checked.ok || busy) return;
		setBusy(true);
		setFailed(null);
		try {
			const result = await window.brigadir.createEditorFile(task, checked.path);
			if (result.created) {
				onClose();
				onOpen(result.document);
			} else setExists(result.document);
		} catch {
			setFailed(
				t(locale, 'Could not create {file}.').replace(
					'{file}',
					checked.path.split('/').at(-1) ?? checked.path
				)
			);
		} finally {
			setBusy(false);
		}
	};
	const field = {
		ref: input,
		size: 'm' as const,
		value,
		spellCheck: false,
		autoComplete: 'off',
		'aria-label': t(locale, 'File path'),
		'aria-invalid': !!error || undefined,
		'data-new-file-path': true,
		onChange: (event: { target: { value: string } }) => {
			setValue(event.target.value);
			setExists(null);
			setFailed(null);
		},
		onKeyDown: (event: { key: string; preventDefault(): void }) => {
			if (event.key !== 'Enter') return;
			event.preventDefault();
			void submit();
		},
	};
	return (
		<Popover
			open={open}
			onClose={onClose}
			anchor={anchor}
			label={t(locale, 'New file')}
			locale={locale}
			width={380}
			align="end"
			data-new-file
			initialFocus={() => input.current}>
			<div className={styles.content}>
				{/* Canvas v3 5.6: a path in mono; several repos — the root repo's name, fixed, before the text. */}
				<TextInput
					{...field}
					className={styles.input}
					lead={root ? <span className={styles.root}>{`${root}/`}</span> : undefined}
				/>
				{error && (
					<p className={styles.error} role="alert">
						{error}
					</p>
				)}
				{failed && (
					<p className={styles.error} role="alert">
						{failed}
					</p>
				)}
				{exists && (
					<div className={styles.exists} role="status" data-size="s" data-new-file-exists>
						<span>{t(locale, 'File already exists')}</span>
						<Button
							size="s"
							appearance="primary"
							variant="ghost"
							onClick={() => {
								onClose();
								onOpen(exists);
							}}>
							{t(locale, 'Open')}
						</Button>
					</div>
				)}
			</div>
		</Popover>
	);
}
