import { useState } from 'react';
import {
	relativeAge,
	t,
	type BrigadirChatMeta,
	type BrigadirSetupState,
	type Locale,
	type MessageKey,
} from '@brigadir/core';
import { SearchField } from './ui/PanelSearch';
import { IconButton } from './ui/Controls';
import { ConfirmDialog } from './ui/ConfirmDialog';
import { Glyph, type GlyphName } from './ui/Glyph';
import { SkeletonRows } from './ui/Loading';
import { toastError } from './ui/Toast';
import { RenameDialog } from './RenameTask';
import { useBrigadirList } from './brigadir-data';
import styles from './App.module.css';

const setupNames: Record<
	BrigadirSetupState['kind'],
	{ name: MessageKey; glyph: GlyphName; ask: MessageKey }
> = {
	slack: { name: 'Slack', glyph: 'slack', ask: 'Set up a Slack bot for me' },
	remoteAccess: { name: 'Remote access', glyph: 'remote', ask: 'Turn on access from my laptop' },
};
/** A setup's state as the list's second line, in the interface language. */
function setupStatus(locale: Locale, status: string) {
	const step = /^(\d+) of (\d+) · (.+)$/.exec(status);
	if (step)
		return t(locale, '{n} of {total} · {step}')
			.replace('{n}', step[1]!)
			.replace('{total}', step[2]!)
			.replace('{step}', step[3]!);
	return t(locale, status as MessageKey);
}
/**
 * spec/settings-modules-and-onboarding#brigadir-chat-entry: the sidebar of the Brigadir section in the shared list look (rule 17) — `Filter chats` and
 * `New chat`, the `Setups` group (each setup with its state; a click opens the chat that runs it, or starts one), the `Chats` group newest first
 * (title, time of the last message; the row menu renames, archives or deletes).
 */
export function SidebarBrigadir({
	locale,
	selected,
	onOpen,
}: {
	locale: Locale;
	selected: string | null;
	onOpen(chat: string | null, ask?: string): void;
}) {
	const list = useBrigadirList(),
		[query, setQuery] = useState(''),
		[renaming, setRenaming] = useState<BrigadirChatMeta | null>(null),
		[deleting, setDeleting] = useState<BrigadirChatMeta | null>(null);
	const needle = query.trim().toLowerCase();
	const chats = (list?.chats ?? []).filter(
		(chat) => !needle || chat.title.toLowerCase().includes(needle)
	);
	const menu = async (chat: BrigadirChatMeta) => {
		const action = await window.brigadir.brigadirChatMenu(chat.id);
		if (action === 'rename') setRenaming(chat);
		else if (action === 'delete') setDeleting(chat);
		else if (action === 'archive') {
			await window.brigadir
				.archiveBrigadirChat(chat.id)
				.catch(() => toastError(t(locale, 'Could not archive the chat.')));
			if (chat.id === selected) onOpen(null);
		}
	};
	const group = (title: MessageKey, glyph: GlyphName, count: number, rows: React.ReactNode) => (
		<section className={styles.project} data-open>
			<div className={styles.projectHeader}>
				<span className={styles.projectIconButton} aria-hidden="true">
					<Glyph name={glyph} size={14} />
				</span>
				<h3>
					<span className={styles.projectSelect}>{t(locale, title)}</span>
				</h3>
				<span className={styles.sectionGroupCount}>{count}</span>
			</div>
			<div className={styles.projectDisclosure} data-open>
				<div>{rows}</div>
			</div>
		</section>
	);
	return (
		<>
			<div className={styles.taskFilter} data-size="l">
				<SearchField
					className={styles.taskFilterField}
					locale={locale}
					label={t(locale, 'Filter chats')}
					value={query}
					onChange={setQuery}
					onKeyDown={(event) => {
						if (event.key === 'Escape' && query) {
							event.preventDefault();
							setQuery('');
						}
					}}
				/>
				<IconButton label={t(locale, 'New chat')} onClick={() => onOpen(null)}>
					<Glyph name="plus" size={14} />
				</IconButton>
			</div>
			<div data-sidebar-list data-sidebar-brigadir className={styles.projectList}>
				{!list ? (
					<SkeletonRows count={4} height={46} />
				) : (
					<>
						{group(
							'Setups',
							'settings',
							list.setups.length,
							list.setups.map((setup) => {
								const names = setupNames[setup.kind];
								return (
									<button
										key={setup.kind}
										className={styles.task}
										data-brigadir-setup={setup.kind}
										aria-pressed={!!setup.chat && setup.chat === selected}
										onClick={() =>
											setup.chat ? onOpen(setup.chat) : onOpen(null, t(locale, names.ask))
										}>
										<span className={styles.noteGlyph}>
											<Glyph name={names.glyph} size={14} />
										</span>
										<span className={styles.taskCopy}>
											<span className={styles.taskHead}>
												<span className={styles.taskTitle}>{t(locale, names.name)}</span>
											</span>
											<small className={styles.prLine}>{setupStatus(locale, setup.status)}</small>
										</span>
									</button>
								);
							})
						)}
						{chats.length > 0 &&
							group(
								'Chats',
								'chat',
								chats.length,
								chats.map((chat) => (
									<button
										key={chat.id}
										className={styles.task}
										data-brigadir-row={chat.id}
										aria-pressed={chat.id === selected}
										title={chat.title || t(locale, 'New chat')}
										onClick={() => onOpen(chat.id)}
										onContextMenu={(event) => {
											event.preventDefault();
											void menu(chat);
										}}>
										<span className={styles.noteGlyph}>
											<Glyph name="bubble" size={14} />
										</span>
										<span className={styles.taskCopy}>
											<span className={styles.taskHead}>
												<span className={styles.taskTitle}>
													{chat.title || t(locale, 'New chat')}
												</span>
											</span>
											<small className={styles.prLine}>
												<time dateTime={chat.updatedAt}>{relativeAge(locale, chat.updatedAt)}</time>
											</small>
										</span>
									</button>
								))
							)}
						{needle && !chats.length && <p className={styles.muted}>{t(locale, 'No matches')}</p>}
					</>
				)}
			</div>
			{renaming && (
				<RenameDialog
					locale={locale}
					initial={renaming.title}
					title={t(locale, 'Rename the chat')}
					label={t(locale, 'Title')}
					error={t(locale, 'Could not rename the chat.')}
					close={() => setRenaming(null)}
					save={(title) => window.brigadir.renameBrigadirChat(renaming.id, title)}
				/>
			)}
			{deleting && (
				<ConfirmDialog
					title={t(locale, 'Delete the chat?')}
					locale={locale}
					action={t(locale, 'Delete')}
					danger
					error={t(locale, 'Could not delete the chat.')}
					cancel={() => setDeleting(null)}
					confirm={async () => {
						await window.brigadir.deleteBrigadirChat(deleting.id);
						if (deleting.id === selected) onOpen(null);
						setDeleting(null);
					}}>
					{t(locale, 'The chat and its history are deleted. Settings it changed stay.')}
				</ConfirmDialog>
			)}
		</>
	);
}
