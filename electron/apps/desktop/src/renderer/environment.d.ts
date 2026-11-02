import type { DesktopBridge } from '@brigadir/core';
declare global {
	interface Window {
		brigadir: DesktopBridge;
	}
}
export {};
