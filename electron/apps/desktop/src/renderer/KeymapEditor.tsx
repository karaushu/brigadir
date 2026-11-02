import { useEffect, useMemo, useRef, useState } from 'react';
import {
	acceleratorFromKey,
	assignShortcut,
	commandAccelerator,
	formatAccelerator,
	keymapCommands,
	keymapConflicts,
	keymapPresets,
	keymapSection,
	keymapSections,
	menuCommands,
	shortcutConflict,
	t,
	type KeymapSettings,
	type Locale,
	type MessageKey,
	type ShortcutConflict,
} from '@brigadir/core';
import { Button, IconButton, Segments } from './ui/Controls';
import { useWorkspace } from './store';
import { Glyph } from './ui/Glyph';
import { ClearField } from './ui/ClearField';
import { PopupClose } from './ui/PopupClose';
import styles from './KeymapEditor.module.css';
const presetLabels: Record<KeymapSettings['preset'], MessageKey> = {
	brigadir: 'Brigadir',
	vscode: 'VS Code',
	intellij: 'IntelliJ',
};
const label = (locale: Locale, key: MessageKey) =>
	key === 'Search Everywhere…' ? key : t(locale, key);
/** spec/settings-modules-and-onboarding#intro: one component for the intro and Settings ▸ Appearance ▸ Keyboard. It edits a keymap and reports it;
 *  the owner saves it, so the intro and Settings share one way to change a shortcut. */
export function KeymapEditor({
	keymap,
	locale,
	disabled = false,
	onChange,
	initialQuery = '',
}: {
	keymap: KeymapSettings;
	locale: Locale;
	disabled?: boolean;
	onChange(keymap: KeymapSettings): void;
	/** spec/search-menus-and-commands#search-tabs: ⌘↩ on an action opens the list on it. */ initialQuery?:
		string | undefined;
}) {
	const [query, setQuery] = useState(initialQuery),
		[recording, setRecording] = useState<string | null>(null),
		[pending, setPending] = useState<{
			commandId: string;
			accelerator: string;
			conflict: ShortcutConflict;
		} | null>(null);
	// spec/settings-modules-and-onboarding#modules: commands of a module switched off are not listed and hold no shortcut.
	const modules = useWorkspace((state) => state.appearance.modules);
	const conflicts = useMemo(
		() => new Set(keymapConflicts(keymap, modules).flat()),
		[keymap, modules]
	);
	// The menu would take ⌘J before the recorder sees it: it drops its accelerators while a key is recorded.
	useEffect(() => {
		void window.brigadir.setShortcutRecording(recording !== null).catch(() => {});
	}, [recording]);
	useEffect(
		() => () => {
			void window.brigadir.setShortcutRecording(false).catch(() => {});
		},
		[]
	);
	const name = (id: string) => {
		const command = menuCommands.find((item) => item.id === id);
		return command ? label(locale, command.label) : id;
	};
	const needle = query.trim().toLocaleLowerCase();
	const sections = keymapSections
		.map((section) => ({
			section,
			items: keymapCommands(modules)
				.filter((command) => keymapSection(command) === section)
				.filter((command) => {
					if (!needle) return true;
					const key = commandAccelerator(command, keymap);
					return (
						label(locale, command.label).toLocaleLowerCase().includes(needle) ||
						Boolean(key && formatAccelerator(key).toLocaleLowerCase().includes(needle))
					);
				}),
		}))
		.filter((group) => group.items.length > 0);
	function record(commandId: string, event: React.KeyboardEvent) {
		if (recording !== commandId) return;
		event.preventDefault();
		event.stopPropagation();
		if (event.key === 'Escape') {
			setRecording(null);
			return;
		}
		const accelerator = acceleratorFromKey(event);
		if (!accelerator) return;
		setRecording(null);
		const conflict = shortcutConflict(keymap, commandId, accelerator, modules);
		if (conflict) {
			setPending({ commandId, accelerator, conflict });
			return;
		}
		onChange(assignShortcut(keymap, commandId, accelerator, false, modules));
	}
	const conflictText = (item: NonNullable<typeof pending>) => {
		const key = formatAccelerator(item.accelerator);
		const c = item.conflict;
		return c.kind === 'command'
			? t(locale, '{key} is already used by “{name}”.')
					.replace('{key}', key)
					.replace('{name}', name(c.commandId))
			: t(
					locale,
					c.owner === 'macOS'
						? '{key} is reserved by macOS: {name}.'
						: c.owner === 'system'
							? '{key} is reserved by the system: {name}.'
							: '{key} is reserved by the app: {name}.'
				)
					.replace('{key}', key)
					.replace('{name}', t(locale, c.name as MessageKey));
	};
	return (
		<div className={styles.editor} data-size="m" data-keymap-editor>
			<div className={styles.presetRow}>
				<span>{t(locale, 'Keymap')}</span>
				<Segments
					label={t(locale, 'Keymap')}
					value={keymap.preset}
					options={keymapPresets.map((preset) => ({
						value: preset,
						label: t(locale, presetLabels[preset]),
					}))}
					onChange={(preset) => {
						setPending(null);
						onChange({ preset: preset as KeymapSettings['preset'], overrides: {} });
					}}
				/>
			</div>
			<label className={styles.search}>
				<Glyph name="search" size={13} />
				<input
					value={query}
					onChange={(event) => setQuery(event.target.value)}
					placeholder={t(locale, 'Search an action or a shortcut')}
					aria-label={t(locale, 'Search an action or a shortcut')}
				/>
				<ClearField locale={locale} value={query} onClear={() => setQuery('')} />
				{conflicts.size > 0 && <small role="status">{conflicts.size / 2}</small>}
			</label>
			<div className={styles.list} role="list">
				{sections.map(({ section, items }) => (
					<section key={section} aria-label={t(locale, section)}>
						<h3>
							{t(locale, section)}
							<span>{items.length}</span>
						</h3>
						{items.map((command) => {
							const key = commandAccelerator(command, keymap),
								isRecording = recording === command.id,
								warn =
									conflicts.has(command.id) ||
									pending?.commandId === command.id ||
									(pending?.conflict.kind === 'command' &&
										pending.conflict.commandId === command.id);
							return (
								<div key={command.id} role="listitem" className={styles.row} data-conflict={warn}>
									<div className={styles.line}>
										<span className={styles.name}>{label(locale, command.label)}</span>
										{command.id in keymap.overrides && (
											<IconButton
												size="s"
												label={`${t(locale, 'Reset to keymap')} · ${label(locale, command.label)}`}
												hint={t(locale, 'Reset to keymap')}
												disabled={disabled}
												onClick={() => {
													const { [command.id]: _, ...overrides } = keymap.overrides;
													setPending(null);
													onChange({ ...keymap, overrides });
												}}>
												↺
											</IconButton>
										)}
										<Button
											className={styles.chip}
											data-recording={isRecording}
											disabled={disabled}
											aria-label={`${label(locale, command.label)} · ${key ? formatAccelerator(key) : '—'}`}
											onClick={() => {
												setPending(null);
												setRecording(isRecording ? null : command.id);
											}}
											onKeyDown={(event) => record(command.id, event)}
											onBlur={() => {
												if (isRecording) setRecording(null);
											}}>
											{isRecording ? (
												<span className={styles.press}>{t(locale, 'Press keys…')}</span>
											) : key ? (
												formatAccelerator(key)
											) : (
												'—'
											)}
										</Button>
									</div>
									{pending?.commandId === command.id && (
										<div className={styles.conflict} role="alert">
											<Glyph name="review-warning" size={14} />
											<span>{conflictText(pending)}</span>
											{pending.conflict.kind === 'command' && (
												<Button
													onClick={() => {
														onChange(
															assignShortcut(
																keymap,
																pending.commandId,
																pending.accelerator,
																true,
																modules
															)
														);
														setPending(null);
													}}>
													{t(locale, 'Replace')}
												</Button>
											)}
											<Button onClick={() => setPending(null)}>{t(locale, 'Cancel')}</Button>
										</div>
									)}
								</div>
							);
						})}
					</section>
				))}
				{!sections.length && <p className={styles.empty}>{t(locale, 'Nothing found')}</p>}
			</div>
		</div>
	);
}
/** Settings ▸ Appearance ▸ Keyboard ▸ Customize…: the same editor in a popup (rule 14: Esc close without a frame). */
export function KeymapDialog({
	keymap,
	locale,
	busy,
	save,
	close,
	initialQuery,
}: {
	keymap: KeymapSettings;
	locale: Locale;
	busy: boolean;
	save(keymap: KeymapSettings): void;
	close(): void;
	initialQuery?: string | undefined;
}) {
	const dialog = useRef<HTMLDialogElement>(null);
	useEffect(() => {
		const previous = document.activeElement,
			node = dialog.current!;
		node.showModal();
		return () => {
			node.close();
			if (previous instanceof HTMLElement && previous.isConnected) previous.focus();
		};
	}, []);
	return (
		<dialog
			ref={dialog}
			className={styles.dialog}
			aria-label={t(locale, 'Keyboard')}
			onCancel={(event) => {
				event.preventDefault();
				event.stopPropagation();
				close();
			}}>
			<header className={styles.header}>
				<h2>{t(locale, 'Keyboard')}</h2>
				<PopupClose locale={locale} close={close} />
			</header>
			<p className={styles.subtitle}>
				{t(locale, 'Choose a keymap and change any shortcut. You see conflicts at once.')}
			</p>
			<KeymapEditor
				keymap={keymap}
				locale={locale}
				disabled={busy}
				onChange={save}
				initialQuery={initialQuery}
			/>
		</dialog>
	);
}
