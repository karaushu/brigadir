/**
 * spec/appearance#bundled-fonts: the kit shows hover, press and focus as the components really draw them. While it is open, every selector
 * with `:hover`, `:active`, `:focus-visible` or `:focus-within` also matches an element marked `data-kit-state` (or
 * inside one), so a specimen keeps that state without a pointer or focus. The rules are edited in place, which keeps
 * their order in the cascade; closing the kit restores them.
 */
const PSEUDO = /:(hover|active|focus-visible|focus-within)(?![\w-])/g;
const STATE: Record<string, KitState> = {
	hover: 'hover',
	active: 'press',
	'focus-visible': 'focus',
	'focus-within': 'focus',
};
export type KitState = 'hover' | 'press' | 'focus';

export function forcedSelector(selector: string) {
	return selector.replace(PSEUDO, (pseudo, name: string) => {
		const mark = `[data-kit-state~='${STATE[name]}']`;
		return `:is(${pseudo}, ${mark}, ${mark} *)`;
	});
}

type Edited = { rule: CSSStyleRule; selector: string };
function walk(rules: CSSRuleList, edited: Edited[]) {
	for (const rule of rules) {
		if (rule instanceof CSSStyleRule) {
			const next = forcedSelector(rule.selectorText);
			if (next !== rule.selectorText) {
				const selector = rule.selectorText;
				rule.selectorText = next;
				// A selector the engine refuses stays as it was; only applied edits are undone.
				if (rule.selectorText !== selector) edited.push({ rule, selector });
			}
			if (rule.cssRules?.length) walk(rule.cssRules, edited);
		} else if ('cssRules' in rule && rule.cssRules instanceof CSSRuleList)
			walk(rule.cssRules, edited);
	}
}

/** Marks the stylesheets; the returned function puts every edited selector back. */
export function forceKitStates(doc: Document = document) {
	const edited: Edited[] = [];
	for (const sheet of doc.styleSheets) {
		let rules: CSSRuleList;
		try {
			rules = sheet.cssRules;
		} catch {
			continue;
		}
		walk(rules, edited);
	}
	return () => {
		for (const { rule, selector } of edited.reverse()) rule.selectorText = selector;
	};
}
