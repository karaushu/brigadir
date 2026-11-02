import { useCallback, useEffect, useRef, useState } from 'react';
import type { EnvironmentCheck } from '@brigadir/core';
/** spec/settings-modules-and-onboarding#settings-keys: one read of this Mac per screen that shows it (the intro, Settings ▸ Agents); `refresh` checks again. */
export function useEnvironment() {
	const [check, setCheck] = useState<EnvironmentCheck | null>(null),
		[failed, setFailed] = useState(false),
		[checking, setChecking] = useState(false),
		mounted = useRef(true);
	const refresh = useCallback(async () => {
		setChecking(true);
		setFailed(false);
		try {
			const value = await window.brigadir.checkEnvironment();
			if (mounted.current) setCheck(value);
		} catch {
			if (mounted.current) setFailed(true);
		} finally {
			if (mounted.current) setChecking(false);
		}
	}, []);
	useEffect(() => {
		mounted.current = true;
		void refresh();
		return () => {
			mounted.current = false;
		};
	}, [refresh]);
	return { check, failed, checking, refresh };
}
