import { describe, expect, it } from 'vitest';
import { useSurfaceLayout } from './surface-layout';
describe('spec/sidebar#width sidebar width', () => {
	it('keeps a dragged width within 220–480 and in whole pixels', () => {
		const { resize } = useSurfaceLayout.getState(),
			width = () => useSurfaceLayout.getState().layout.sidebarWidth;
		expect(width()).toBe(280);
		resize('sidebarWidth', 360.4);
		expect(width()).toBe(360);
		resize('sidebarWidth', 1000);
		expect(width()).toBe(480);
		resize('sidebarWidth', 40);
		expect(width()).toBe(220);
	});
});
