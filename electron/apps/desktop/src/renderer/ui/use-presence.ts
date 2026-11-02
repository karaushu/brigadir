import { useLayoutEffect, useState } from 'react';
import { motionTime } from './motion';
/** Retain only the visual exit; callers make closing content inert immediately. */
export function usePresence(open: boolean) {
	const [retained, setRetained] = useState(open);
	useLayoutEffect(() => {
		if (open) {
			setRetained(true);
			return;
		}
		if (matchMedia('(prefers-reduced-motion: reduce)').matches) {
			setRetained(false);
			return;
		}
		const timer = setTimeout(() => setRetained(false), motionTime('--motion-enter-time'));
		return () => clearTimeout(timer);
	}, [open]);
	return open || retained;
}
