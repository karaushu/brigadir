import { useLayoutEffect, useState } from 'react';
import { motionTime } from './motion';
/** Retain only the visual exit; callers make closing content inert immediately. Under reduced motion the exit is still a fade
 *  (spec/appearance#motion), so the time is the same. */
export function usePresence(open: boolean) {
	const [retained, setRetained] = useState(open);
	useLayoutEffect(() => {
		if (open) {
			setRetained(true);
			return;
		}
		const timer = setTimeout(() => setRetained(false), motionTime('--motion-enter-time'));
		return () => clearTimeout(timer);
	}, [open]);
	return open || retained;
}
