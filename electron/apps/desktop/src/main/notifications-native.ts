import { Notification } from 'electron';
import type { Notice, NoticeGateway, NoticeHandlers } from './notifications';
/** Electron UNUserNotification bridge: always silent (spec/sidebar#layout), grouped per task, one-time actions only. */
export class NativeNotices implements NoticeGateway {
	supported() {
		return Notification.isSupported();
	}
	show(notice: Notice, handlers: NoticeHandlers) {
		const buttons = [
			...(notice.actions.allow ? [{ text: notice.actions.allow, run: handlers.allow }] : []),
			...(notice.actions.deny ? [{ text: notice.actions.deny, run: handlers.deny }] : []),
		];
		const notification = new Notification({
			title: notice.title,
			body: notice.body,
			silent: true,
			id: notice.id,
			groupId: notice.groupId,
			actions: buttons.map((button) => ({ type: 'button' as const, text: button.text })),
		});
		notification.on('click', () => handlers.open());
		notification.on('action', (_event, index) => {
			buttons[index]?.run();
		});
		notification.show();
		return {
			close: () => {
				try {
					notification.close();
				} catch {}
			},
		};
	}
	removeGroup(groupId: string) {
		try {
			Notification.removeGroup(groupId);
		} catch {}
	}
}
