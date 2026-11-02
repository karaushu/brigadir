import { useEffect, useState } from 'react';
import { onSessionEvent } from './session-events';
import { affectsScopes, type TaskKey, type ScopeLockView } from '@brigadir/core';
/** Locks move when a host starts or stops; the slow timer is a fallback for owners outside this window. */
export function useScopeLocks(key: TaskKey) {
	const [locks, setLocks] = useState<ScopeLockView[]>([]),
		[error, setError] = useState(false);
	useEffect(() => {
		let active = true,
			busy = false,
			pending = false,
			retryTimer: ReturnType<typeof setTimeout> | undefined;
		const read = async () => {
			if (busy) {
				pending = true;
				return;
			}
			busy = true;
			try {
				const value = await window.brigadir.readScopeLocks(key);
				if (active) {
					setLocks(value);
					setError(false);
				}
			} catch {
				if (active) {
					setError(true);
					if (!retryTimer)
						retryTimer = setTimeout(() => {
							retryTimer = undefined;
							if (active) void read();
						}, 1500);
				}
			} finally {
				busy = false;
				if (pending && active) {
					pending = false;
					void read();
				}
			}
		};
		void read();
		const timer = setInterval(() => {
				if (!document.hidden) void read();
			}, 30000),
			stop = onSessionEvent(({ record }) => {
				if (affectsScopes(record)) void read();
			});
		return () => {
			active = false;
			clearInterval(timer);
			clearTimeout(retryTimer);
			stop();
		};
	}, [key.id, key.projectId]);
	return { locks, error };
}
