/**
 * spec/remote-access-and-mobile#client-ui-seam, spec/remote-access-and-mobile#phone-app: a menu or a message box that main's handler of an allowed row shows this phone comes as a sheet
 * and is answered with `remote:ui-answer`; a folder or file choice and a page's dialog are not for a phone — null at once.
 * Closing a sheet any way answers like «Скасувати» (the box's cancel button, no item of a menu).
 */
import { useEffect } from 'react';
import { create } from 'zustand';
import { t, type Locale, type RemoteBox, type RemoteMenu } from '@brigadir/core';
import { Button } from '../../renderer/ui/Controls';
import { Group, Sheet, SheetRow } from '../ui/Sheet';
import { back, openSheet, useRouter } from '../router';
import s from './Sheets.module.css';

type Asked = { kind: 'box'; box: RemoteBox } | { kind: 'menu'; menu: RemoteMenu };
const useAsked = create<{ items: Record<number, Asked> }>(() => ({ items: {} }));
const answered = new Set<number>();
function answer(id: number, value: string | number | null) {
	if (answered.has(id)) return;
	answered.add(id);
	void window.brigadir.answerRemoteUi(id, value).catch(() => {});
	useAsked.setState((state) => {
		const items = { ...state.items };
		delete items[id];
		return { items };
	});
}
export function useRemoteUi() {
	useEffect(() => {
		const stopDialog = window.brigadir.onRemoteDialog((dialog) => {
			if (dialog.kind !== 'box')
				return void window.brigadir.answerRemoteUi(dialog.id, null).catch(() => {});
			useAsked.setState((state) => ({
				items: { ...state.items, [dialog.id]: { kind: 'box', box: dialog } },
			}));
			openSheet({ kind: 'dialog', id: dialog.id });
		});
		const stopMenu = window.brigadir.onRemoteMenu((menu) => {
			useAsked.setState((state) => ({
				items: { ...state.items, [menu.id]: { kind: 'menu', menu } },
			}));
			openSheet({ kind: 'menu-remote', id: menu.id });
		});
		return () => {
			stopDialog();
			stopMenu();
		};
	}, []);
	// A sheet that left the history unanswered (the system «back», a swipe) answers as cancelled.
	const { sheet } = useRouter();
	const items = useAsked((state) => state.items);
	useEffect(() => {
		for (const [key, item] of Object.entries(items)) {
			const id = Number(key),
				open = (sheet?.kind === 'dialog' || sheet?.kind === 'menu-remote') && sheet.id === id;
			if (!open) answer(id, item.kind === 'box' ? item.box.cancelId : null);
		}
	}, [sheet]);
}
export function RemoteSheet({ id, locale }: { id: number; locale: Locale }) {
	const item = useAsked((state) => state.items[id]);
	if (!item) return null;
	const done = (value: string | number | null) => {
		answer(id, value);
		back();
	};
	if (item.kind === 'box') {
		const box = item.box;
		return (
			<Sheet
				label={box.message}
				title={box.message}
				locale={locale}
				close={() => done(box.cancelId)}>
				{box.detail && <p className={s.dialogText}>{box.detail}</p>}
				<div className={s.dialogButtons} data-size="xl">
					{box.buttons.map((label, index) => (
						<Button
							key={index}
							className={s.wide}
							appearance={
								index === box.danger ? 'danger' : index === box.defaultId ? 'primary' : 'neutral'
							}
							onClick={() => done(index)}>
							{label}
						</Button>
					))}
				</div>
			</Sheet>
		);
	}
	const items = item.menu.items.filter(
		(entry): entry is NonNullable<typeof entry> =>
			entry !== null && !entry.role && entry.reveal === undefined
	);
	return (
		<Sheet
			label={t(locale, 'Menu')}
			title={t(locale, 'Menu')}
			locale={locale}
			close={() => done(null)}>
			<Group>
				{items.map((entry) => (
					<SheetRow
						key={entry.id}
						title={entry.label}
						disabled={entry.enabled === false}
						onClick={() => {
							if (entry.copy !== undefined)
								void navigator.clipboard?.writeText(entry.copy).catch(() => {});
							done(entry.copy !== undefined ? null : entry.id);
						}}
					/>
				))}
			</Group>
		</Sheet>
	);
}
