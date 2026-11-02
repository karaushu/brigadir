import { isLocalHost } from '@brigadir/core';
export function browserUrl(value: string) {
	try {
		const url = new URL(value);
		return ['http:', 'https:'].includes(url.protocol) &&
			!url.username &&
			!url.password &&
			value.length <= 8192
			? url
			: null;
	} catch {
		return null;
	}
}
/** The one definition of a local page (spec/browser-and-simulator#browser) lives in core: chat links (spec/chat#web-links) use it too. */
export function localBrowserUrl(value: string) {
	const host = browserUrl(value)?.hostname;
	return !!host && isLocalHost(host);
}
