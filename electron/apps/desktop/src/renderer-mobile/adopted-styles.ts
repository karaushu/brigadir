/**
 * spec/remote-access-and-mobile#outbox (security review W2, J2): the phone's CSP (`style-src 'self'`, spec/remote-access-and-mobile#phone-network) refuses a `<style>` element
 * and a `style="…"` attribute. xterm makes both: a `<style>` for the scrollbar's colours, and — in the DOM renderer, when the
 * phone has no WebGL — a `<style>` for the cells' palette and size and `setAttribute('style', …)` for 24-bit colours. Without
 * a way round, those styles were lost and each one was a CSP violation.
 *
 * Styles the app's own scripts make go through the CSSOM instead, which CSP leaves to `script-src` — as CodeMirror's adopted
 * style sheets do: `document.createElement('style')` gives an inert element whose text fills an adopted `CSSStyleSheet`
 * (removing the element drops the sheet), and `setAttribute('style', …)` sets `style.cssText`. Markup parsed from a string
 * (`innerHTML`, the HTML parser) never calls these methods, so an injected `<style>` or `style=` stays refused, and CSP is
 * not loosened (no `'unsafe-inline'`, no nonce).
 */
export function adoptScriptStyles(doc: Document = document): () => void {
	const view = doc.defaultView;
	if (!view || !('adoptedStyleSheets' in doc) || typeof view.CSSStyleSheet !== 'function')
		return () => {};
	const create = doc.createElement as (
		tag: string,
		options?: ElementCreationOptions
	) => HTMLElement;
	const element = view.Element.prototype;
	const setAttribute = element.setAttribute;
	const made = (tag: string, options?: ElementCreationOptions) => create.call(doc, tag, options);
	doc.createElement = function createElement(tag: string, options?: ElementCreationOptions) {
		if (String(tag).toLowerCase() !== 'style') return made(tag, options);
		return adoptedStyle(doc, view, made) as unknown as HTMLStyleElement;
	} as Document['createElement'];
	element.setAttribute = function (this: Element, name: string, value: string) {
		if (String(name).toLowerCase() === 'style' && 'style' in this) {
			(this as HTMLElement).style.cssText = String(value);
			return;
		}
		setAttribute.call(this, name, value);
	};
	return () => {
		// The method was the prototype's: dropping the own one brings it back.
		delete (doc as { createElement?: unknown }).createElement;
		element.setAttribute = setAttribute;
	};
}
/** A `<style>` look-alike: no text node, nothing for CSP to judge; its text goes to an adopted sheet. */
function adoptedStyle(
	doc: Document,
	view: Window & typeof globalThis,
	made: (tag: string) => HTMLElement
): HTMLElement {
	const sheet = new view.CSSStyleSheet();
	doc.adoptedStyleSheets = [...doc.adoptedStyleSheets, sheet];
	// `<template>` renders nothing and runs nothing; its text never becomes children here.
	const node = made('template');
	node.dataset.adoptedStyle = '';
	let text = '';
	Object.defineProperty(node, 'textContent', {
		configurable: true,
		get: () => text,
		set: (value: unknown) => {
			text = value == null ? '' : String(value);
			sheet.replaceSync(text);
		},
	});
	const remove = node.remove.bind(node);
	node.remove = () => {
		doc.adoptedStyleSheets = doc.adoptedStyleSheets.filter((item) => item !== sheet);
		remove();
	};
	return node;
}
