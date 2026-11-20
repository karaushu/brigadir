import { useEffect, useState } from 'react';
import type { BrigadirChatMeta, BrigadirChatRow, BrigadirSetupState } from '@brigadir/core';

/** spec/settings-modules-and-onboarding#brigadir-chat-entry: the section's chats and setups, kept in step with main by `brigadir:event`. */
export function useBrigadirList() {
	const [list, setList] = useState<{
		chats: BrigadirChatMeta[];
		archived: BrigadirChatMeta[];
		setups: BrigadirSetupState[];
	} | null>(null);
	useEffect(() => {
		let active = true;
		const off = window.brigadir.onBrigadirEvent((event) => {
			if (event.kind === 'list')
				setList({ chats: event.chats, archived: event.archived, setups: event.setups });
		});
		void window.brigadir.readBrigadirChats().then(
			(value) => active && setList(value),
			() => active && setList({ chats: [], archived: [], setups: [] })
		);
		return () => {
			active = false;
			off();
		};
	}, []);
	return list;
}
/** One chat's rows and whether its agent answers now; rows that arrive while it loads are kept. */
export function useBrigadirChat(id: string | null) {
	const [rows, setRows] = useState<BrigadirChatRow[] | null>(null),
		[busy, setBusy] = useState(false),
		[title, setTitle] = useState('');
	useEffect(() => {
		setRows(null);
		setBusy(false);
		setTitle('');
		if (!id) return;
		let active = true,
			loaded = false;
		const pending: BrigadirChatRow[] = [];
		const off = window.brigadir.onBrigadirEvent((event) => {
			if (event.kind === 'list') {
				const meta = event.chats.find((chat) => chat.id === id);
				if (meta) setTitle(meta.title);
				return;
			}
			if (event.id !== id) return;
			if (event.kind === 'busy') setBusy(event.busy);
			else if (loaded)
				setRows((current) =>
					current && !current.some((row) => row.seq === event.row.seq)
						? [...current, event.row]
						: current
				);
			else pending.push(event.row);
		});
		void window.brigadir.readBrigadirChat(id).then(
			(state) => {
				if (!active) return;
				loaded = true;
				const known = new Set(state.rows.map((row) => row.seq));
				setRows([...state.rows, ...pending.filter((row) => !known.has(row.seq))]);
				setBusy(state.busy);
				setTitle((current) => current || state.meta.title);
			},
			() => active && setRows([])
		);
		return () => {
			active = false;
			off();
		};
	}, [id]);
	return { rows, busy, title };
}
