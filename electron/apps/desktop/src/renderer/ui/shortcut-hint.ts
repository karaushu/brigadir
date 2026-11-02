import { formatAccelerator, shortcutPlatform, t, type Locale } from '@brigadir/core';
type Hint =
	| '⌘V or drag: images and files'
	| '⌘+click opens in editor'
	| '⌘+click opens the link'
	| '⌘↩ send · Esc cancel';
/** These gestures are fixed by their handlers, not configurable menu shortcuts. */
export function shortcutHint(locale: Locale, key: Hint): string {
	const shortcut = key.includes('click')
		? `${shortcutPlatform() === 'darwin' ? '⌘' : 'Ctrl'}+${locale === 'uk' ? 'клік' : 'click'}`
		: formatAccelerator(key.includes('⌘V') ? 'CmdOrCtrl+V' : 'CmdOrCtrl+Enter');
	return t(locale, key).replace('{shortcut}', shortcut);
}
