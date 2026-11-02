/**
 * spec/remote-access-and-mobile#phone-app: what the phone keeps in step with the machine — the workspace (re-read after the same session events
 * as the computer's sidebar), the quota, the link (a ping every 10 s; a drop is «підключення…», 5 s later «недоступна»).
 */
import { useEffect } from 'react';
import { onSessionEvent } from '../renderer/session-events';
import { workspaceEventKinds } from '../renderer/workspace-events';
import { useMobile } from './store';
import type { Connection } from './connection';

export async function loadWorkspace() {
	try {
		useMobile.getState().setWorkspace(await window.brigadir.readWorkspace());
	} catch {
		// The machine is away: the cache stays and the link says so.
	}
}
export function useMachineSync(connection: Connection) {
	useEffect(() => {
		const { setLink, setQuota } = useMobile.getState();
		let refresh: ReturnType<typeof setTimeout> | undefined,
			away: ReturnType<typeof setTimeout> | undefined;
		void loadWorkspace();
		const readQuota = () => void window.brigadir.readQuota().then(setQuota, () => {});
		readQuota();
		const stopQuota = window.brigadir.onQuotaChanged(setQuota);
		const stopEvents = onSessionEvent(({ record }) => {
			if (record && !workspaceEventKinds.has(record.event.kind)) return;
			const wait = record?.event.kind === 'tool.changed' ? 1000 : 150;
			if (!refresh)
				refresh = setTimeout(() => {
					refresh = undefined;
					void loadWorkspace();
				}, wait);
		});
		const measure = async () => {
			const rtt = await connection.ping();
			if (rtt < 0) return;
			setLink(rtt > 300 ? 'slow' : 'on', rtt);
		};
		void measure();
		const pinger = setInterval(() => void measure(), 10_000);
		connection.onLink = (state) => {
			clearTimeout(away);
			if (state === 'down') {
				setLink('connecting');
				away = setTimeout(() => setLink('off'), 5000);
			} else {
				setLink('on');
				void loadWorkspace();
				readQuota();
				void measure();
			}
		};
		// A phone woken from the lock screen reconnects and measures at once instead of waiting for the backoff or the tick.
		const wake = () => {
			if (document.visibilityState !== 'visible') return;
			void connection.wake().then(() => measure());
		};
		document.addEventListener('visibilitychange', wake);
		addEventListener('pageshow', wake);
		addEventListener('online', wake);
		return () => {
			clearTimeout(refresh);
			clearTimeout(away);
			clearInterval(pinger);
			stopQuota();
			stopEvents();
			connection.onLink = null;
			document.removeEventListener('visibilitychange', wake);
			removeEventListener('pageshow', wake);
			removeEventListener('online', wake);
		};
	}, [connection]);
}
/** «Повторити» on the offline banner: a ping now; the socket's own reconnect keeps trying meanwhile. */
export async function retryLink(connection: Connection) {
	const { setLink } = useMobile.getState();
	setLink('connecting');
	await connection.wake();
	const rtt = await connection.ping();
	if (rtt < 0) setLink('off');
	else {
		setLink(rtt > 300 ? 'slow' : 'on', rtt);
		void loadWorkspace();
	}
}
