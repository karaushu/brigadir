import { useEffect, useRef, useState } from 'react';
import type { SlashCatalog } from '@brigadir/core';

export type SlashCatalogRequest = {
	projectId: string;
	provider: 'claude' | 'codex';
	taskId?: string;
	crew?: boolean;
};
/**
 * spec/composer#slash-menu: the disk side of the `/` menu (main `slash-catalog`). Read when the surface mounts and again each time the
 * menu opens, so a skill saved a minute ago is there; a failed read keeps the last list (the menu still has the
 * agent's own). `null` until the first answer.
 */
export function useSlashCatalog(
	request: SlashCatalogRequest | null,
	opened: boolean
): SlashCatalog | null {
	return useSlashCatalogFrom(
		request ? JSON.stringify(request) : null,
		() => window.brigadir.readSlashCatalog(request!),
		opened
	);
}
/** The same for any reader of the catalog (spec/composer#chat-composer: a chat that is not a task); `key` changes when the answer would. */
export function useSlashCatalogFrom(
	key: string | null,
	read: () => Promise<SlashCatalog>,
	opened: boolean
): SlashCatalog | null {
	const [catalog, setCatalog] = useState<SlashCatalog | null>(null),
		latest = useRef(read);
	latest.current = read;
	useEffect(() => {
		setCatalog(null);
	}, [key]);
	useEffect(() => {
		if (key === null) return;
		let alive = true;
		void latest.current().then(
			(value) => {
				if (alive) setCatalog(value);
			},
			() => {}
		);
		return () => {
			alive = false;
		};
	}, [key, opened]);
	return catalog;
}
