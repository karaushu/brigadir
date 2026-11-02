import { useEffect, useState } from 'react';
import type { NotificationPermission } from '@brigadir/core';
/** spec/notifications-slack-notes-and-schedules#macos-permission: main pushes every change of the macOS authorization; null until the first answer. */
export function useNotificationPermission() {
	const [value, setValue] = useState<NotificationPermission | null>(null);
	useEffect(() => {
		let active = true,
			received = false;
		const stop = window.brigadir.onNotificationPermission((next) => {
			received = true;
			setValue(next);
		});
		void window.brigadir.readNotificationPermission().then(
			(next) => {
				if (active && !received) setValue(next);
			},
			() => {}
		);
		return () => {
			active = false;
			stop();
		};
	}, []);
	return value;
}
