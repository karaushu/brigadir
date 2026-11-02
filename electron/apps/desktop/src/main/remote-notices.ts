import type { RemoteNotify } from '@brigadir/core';
import type { Client } from './clients';
import type {
	Notice,
	NoticeGateway,
	NoticeHandle,
	NoticeHandlers,
	SoundPlayer,
} from './notifications';

/**
 * spec/remote-access-and-mobile#client-ui-seam: while a device controls the working machine, the machine's notices, sounds and badge go to that
 * device — it shows them with its own OS — instead of this machine's screen and speakers. `Allow` / `Deny` come back as
 * `remote:notice-act`; a click opens the task on the device itself. Without a device in control nothing changes.
 */
export class RoutedNotices implements NoticeGateway {
	private next = 1;
	private readonly handlers = new Map<number, { client: string; handlers: NoticeHandlers }>();
	constructor(
		private readonly local: NoticeGateway,
		private readonly target: () => Client | null
	) {}
	supported() {
		return this.local.supported() || !!this.target();
	}
	show(notice: Notice, handlers: NoticeHandlers): NoticeHandle | null {
		const client = this.target();
		if (!client) return this.local.show(notice, handlers);
		const id = this.next++;
		const value: RemoteNotify = {
			kind: 'show',
			id,
			notice: {
				id: notice.id,
				groupId: notice.groupId,
				key: { projectId: notice.key.projectId, id: notice.key.id },
				title: notice.title,
				body: notice.body,
				actions: notice.actions,
			},
		};
		if (!client.send('remote:notify', value)) return this.local.show(notice, handlers);
		this.handlers.set(id, { client: client.id, handlers });
		// Old notices the device never answered do not pile up.
		for (const key of this.handlers.keys()) {
			if (this.handlers.size <= 200) break;
			this.handlers.delete(key);
		}
		return {
			close: () => {
				this.handlers.delete(id);
				client.send('remote:notify', { kind: 'close', id } satisfies RemoteNotify);
			},
		};
	}
	removeGroup(groupId: string) {
		this.local.removeGroup(groupId);
		this.target()?.send('remote:notify', { kind: 'remove', groupId } satisfies RemoteNotify);
	}
	/** `remote:notice-act`: only the device that got the notice. */
	act(client: Client, id: number, action: 'allow' | 'deny') {
		const item = this.handlers.get(id);
		if (!item || item.client !== client.id) return;
		this.handlers.delete(id);
		item.handlers[action]();
	}
	/** The sound of a notice plays where the person is. */
	sounds(local: SoundPlayer): SoundPlayer {
		return {
			play: (name) => {
				const client = this.target();
				if (
					!client ||
					!client.send('remote:notify', { kind: 'sound', name } satisfies RemoteNotify)
				)
					local.play(name);
			},
		};
	}
	/** The badge shows on the device in control too. */
	badge(count: number) {
		this.target()?.send('remote:notify', { kind: 'badge', count } satisfies RemoteNotify);
	}
}
