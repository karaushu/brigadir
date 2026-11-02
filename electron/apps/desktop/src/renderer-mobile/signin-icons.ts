/**
 * The sign-in page's glyphs and the helmet of `ui/Glyph`.
 * Plain markup: this page has no React, and it carries no inline style (the listener's CSP).
 */
const glyphs = {
	machine: `<rect x="1.8" y="2.6" width="12.4" height="8.4" rx="1.6" stroke="currentColor" stroke-width="1.4" stroke-linecap="round" stroke-linejoin="round"/><path d="M6 13.6h4M8 11v2.6" stroke="currentColor" stroke-width="1.4" stroke-linecap="round" stroke-linejoin="round"/>`,
	faceid: `<path d="M2.4 5.4V3.6a1.2 1.2 0 0 1 1.2-1.2h1.8M10.6 2.4h1.8a1.2 1.2 0 0 1 1.2 1.2v1.8M13.6 10.6v1.8a1.2 1.2 0 0 1-1.2 1.2h-1.8M5.4 13.6H3.6a1.2 1.2 0 0 1-1.2-1.2v-1.8" stroke="currentColor" stroke-width="1.4" stroke-linecap="round" stroke-linejoin="round"/><path d="M5.6 6v1M10.4 6v1M8 6v2.8l-.8.4M6 10.6c1.2 1 2.8 1 4 0" stroke="currentColor" stroke-width="1.4" stroke-linecap="round" stroke-linejoin="round"/>`,
	finger: `<path d="M4.6 12.6c.8-1.4 1-2.8 1-4.4a2.4 2.4 0 0 1 4.8 0c0 1.2-.1 2.4-.4 3.4M8 8.2c0 2-.4 3.8-1.4 5.4M3 9.6c.2-.6.2-1 .2-1.6a4.8 4.8 0 0 1 9.6 0c0 1.6-.2 3.2-.8 4.6M12 4.2" stroke="currentColor" stroke-width="1.4" stroke-linecap="round" stroke-linejoin="round"/>`,
	key: `<circle cx="5.2" cy="10.8" r="2.8" stroke="currentColor" stroke-width="1.4" stroke-linecap="round" stroke-linejoin="round"/><path d="m7.2 8.8 5.6-5.6M10.8 5.2l1.6 1.6M9.4 6.6l1.2 1.2" stroke="currentColor" stroke-width="1.4" stroke-linecap="round" stroke-linejoin="round"/>`,
	tick: `<path d="M3.4 8.4 6.5 11.4 12.6 4.8" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"/>`,
	moon: `<path d="M12.8 10.2A5.6 5.6 0 0 1 5.8 3.2a5.6 5.6 0 1 0 7 7z" stroke="currentColor" stroke-width="1.4" stroke-linecap="round" stroke-linejoin="round"/>`,
	lock: `<rect x="3.4" y="7" width="9.2" height="6.6" rx="1.6" stroke="currentColor" stroke-width="1.4" stroke-linecap="round" stroke-linejoin="round"/><path d="M5.6 7V5.2a2.4 2.4 0 0 1 4.8 0V7" stroke="currentColor" stroke-width="1.4" stroke-linecap="round" stroke-linejoin="round"/>`,
	x2: `<circle cx="8" cy="8" r="6.4" stroke="currentColor" stroke-width="1.4" stroke-linecap="round" stroke-linejoin="round"/><path d="M5.8 5.8l4.4 4.4M10.2 5.8l-4.4 4.4" stroke="currentColor" stroke-width="1.4" stroke-linecap="round" stroke-linejoin="round"/>`,
	share: `<path d="M8 10V2.4M5.2 5 8 2.2 10.8 5" stroke="currentColor" stroke-width="1.4" stroke-linecap="round" stroke-linejoin="round"/><path d="M5 7H3.8a1 1 0 0 0-1 1v5a1 1 0 0 0 1 1h8.4a1 1 0 0 0 1-1V8a1 1 0 0 0-1-1H11" stroke="currentColor" stroke-width="1.4" stroke-linecap="round" stroke-linejoin="round"/>`,
	addsq: `<rect x="2.2" y="2.2" width="11.6" height="11.6" rx="2.6" stroke="currentColor" stroke-width="1.4" stroke-linecap="round" stroke-linejoin="round"/><path d="M8 5.2v5.6M5.2 8h5.6" stroke="currentColor" stroke-width="1.4" stroke-linecap="round" stroke-linejoin="round"/>`,
} as const;
const helmet = `<path fill="currentColor" d="M 14 3 C 13.448 3 13 3.448 13 4 L 13 4.2304688 L 13 6 C 13 6.552 12.552 7 12 7 C 11.448 7 11 6.552 11 6 L 11 4.9472656 C 8.039 6.4202656 6 9.468 6 13 L 6 15 L 5 15 A 1.0001 1.0001 0 1 0 5 17 L 6 17 L 6 17.957031 L 6 18.572266 L 6 19.800781 C 6 21.067448 6.5630258 21.996554 7.140625 22.501953 C 7.4938002 22.810981 7.645978 22.816388 7.8847656 22.910156 C 7.9749139 23.146233 8.2661545 23.820662 8.8085938 24.595703 C 9.6466236 26.386706 11.361419 27.951961 14.869141 27.992188 A 1.0001 1.0001 0 0 0 14.990234 28 C 14.993687 28.000003 14.996544 28 15 28 A 1.0001 1.0001 0 0 0 15.119141 27.994141 C 18.639347 27.957433 20.357374 26.385577 21.195312 24.589844 C 21.735475 23.817323 22.025288 23.145704 22.115234 22.910156 C 22.354022 22.816386 22.5062 22.810986 22.859375 22.501953 C 23.436974 21.996554 24 21.067448 24 19.800781 L 24 18.199219 L 24 17.957031 L 24 17 L 25 17 A 1.0001 1.0001 0 1 0 25 15 L 11 15 C 10.448 15 10 14.552 10 14 C 10 13.448 10.448 13 11 13 L 24 13 C 24 9.468 21.961 6.4202656 19 4.9472656 L 19 6 C 19 6.552 18.552 7 18 7 C 17.448 7 17 6.552 17 6 L 17 4.2304688 L 17 4 C 17 3.448 16.552 3 16 3 L 14 3 z M 10.976562 17 L 21.005859 17 C 21.565329 17.52777 22 18.220543 22 19 L 22 19.800781 C 22 19.885592 21.98641 19.944577 21.980469 20.017578 C 21.923071 20.074882 18.990261 23 18 23 C 17 23 15.992 22 15 22 C 14.008 22 13 23 12 23 C 11.009739 23 8.0769288 20.074882 8.0195312 20.017578 C 8.0135905 19.944577 8 19.885592 8 19.800781 L 8 18.572266 C 8 17.38592 9.7084243 18.231752 10.976562 17 z"/>`;
export type SigninIcon = keyof typeof glyphs | 'helmet';
export function icon(name: SigninIcon, size: number): SVGSVGElement {
	const holder = document.createElement('span');
	holder.innerHTML =
		name === 'helmet'
			? `<svg aria-hidden="true" width="${size}" height="${size}" viewBox="0 0 30 30">${helmet}</svg>`
			: `<svg aria-hidden="true" width="${size}" height="${size}" viewBox="0 0 16 16" fill="none">${glyphs[name]}</svg>`;
	return holder.firstElementChild as SVGSVGElement;
}
