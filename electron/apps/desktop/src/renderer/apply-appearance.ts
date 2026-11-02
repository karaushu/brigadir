import { useEffect } from 'react';
import {
	accentFillNeedsDarkText,
	chatScale,
	defaultInterfaceFont,
	defaultTypography,
	interfaceFontSize,
	opaqueColor,
	textSurfaces,
	type Appearance,
} from '@brigadir/core';
import { fontFamily, interfaceFamily } from './typography';
/**
 * The window's look from main's appearance: theme, code theme, fonts, the accent and, on Windows and Linux, the colours of
 * the OS buttons in the strip (spec/architecture-and-platform#window-frame). The workspace and the client's list of machines (spec/remote-access-and-mobile#identity-and-keys) both wear it.
 */
export function useApplyAppearance(appearance: Appearance) {
	useEffect(() => {
		document.documentElement.dataset.theme = appearance.dark ? 'dark' : 'light';
		// spec/settings-modules-and-onboarding#settings-keys: the code theme recolours only the syntax tokens of the editor and the diff.
		document.documentElement.dataset.codeTheme = appearance.codeTheme ?? 'brigadir';
		// spec/editor-code-intelligence#font-styles: font styles (bold keywords, italic comments) are a switch of their own, apart from the code theme.
		document.documentElement.dataset.syntaxStyles =
			appearance.syntaxStyles === false ? 'off' : 'on';
		document.documentElement.lang = appearance.locale;
		document.documentElement.style.setProperty(
			'--terminal-weight',
			String(appearance.terminalFontWeight ?? 400)
		);
		for (const surface of textSurfaces) {
			const font = appearance.typography?.[surface] ?? defaultTypography[surface],
				style = document.documentElement.style;
			style.setProperty(`--${surface}-family`, fontFamily(font));
			style.setProperty(`--${surface}-size`, `${font.size}px`);
			style.setProperty(`--${surface}-line`, `${Math.round(font.size * font.lineHeight)}px`);
			style.setProperty(`--${surface}-ligatures`, font.ligatures ? 'normal' : 'none');
			// spec/appearance#evolution-redesign: Geist Mono keeps its code ligatures in Stylistic Set 11; other fonts ignore the set.
			style.setProperty(`--${surface}-features`, font.ligatures ? '"ss11" 1' : 'normal');
		}
		const ui = appearance.interfaceFont ?? defaultInterfaceFont;
		document.documentElement.style.setProperty(
			'--ui-scale',
			String(ui.size / interfaceFontSize.default)
		);
		// spec/appearance#chat-text-size: the chat's own scale; tokens.css hands it to every chat text under `[data-chat-text]`.
		document.documentElement.style.setProperty(
			'--chat-scale',
			String(chatScale(appearance.chatFont, ui))
		);
		// spec/appearance#evolution-redesign: no family is Geist, the value tokens.css starts with.
		if (ui.family)
			document.documentElement.style.setProperty('--ui-family', interfaceFamily(ui.family));
		else document.documentElement.style.removeProperty('--ui-family');
		// spec/appearance#accent: a named accent comes from tokens.css; only `system` paints the macOS colour inline.
		const accentColor = appearance.accentColor ?? 'system';
		document.documentElement.dataset.accent = accentColor;
		if (accentColor === 'system' && /^[a-fA-F0-9]{8}$/.test(appearance.accent)) {
			const accent = `#${appearance.accent.slice(0, 6)}`;
			document.documentElement.style.setProperty('--accent', accent);
			document.documentElement.dataset.accentText = accentFillNeedsDarkText(appearance.accent)
				? 'dark'
				: 'light';
		} else {
			document.documentElement.style.removeProperty('--accent');
			delete document.documentElement.dataset.accentText;
		}
	}, [appearance]);
	// spec/architecture-and-platform#window-frame: the OS buttons take the strip's colour and an opaque --fg over it, after every theme or accent change.
	useEffect(() => {
		if (window.brigadir.chromePlatform === 'darwin') return;
		const style = getComputedStyle(document.documentElement),
			tb = style.getPropertyValue('--strip-bg').trim(),
			color = opaqueColor(tb, tb),
			symbolColor = opaqueColor(style.getPropertyValue('--fg').trim(), tb);
		if (color && symbolColor)
			void window.brigadir.setChromeColors({ color, symbolColor }).catch(() => {});
	}, [appearance]);
}
