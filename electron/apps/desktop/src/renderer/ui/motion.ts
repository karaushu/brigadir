/** CSS <time> in milliseconds. The minified build serializes tokens.css `180ms` as `.18s`, so both units are real inputs. */
export function cssTime(value: string) {
	const match = /^\s*([+-]?(?:\d+\.?\d*|\.\d+)(?:e[+-]?\d+)?)(ms|s)\s*$/i.exec(value);
	return match ? Math.max(0, Number(match[1]) * (match[2]!.toLowerCase() === 's' ? 1000 : 1)) : 0;
}
/** Resolved shared motion token (`--motion-enter-time`, `--motion-travel`), 0 under reduced motion. */
export function motionTime(token: `--motion-${string}`) {
	return cssTime(getComputedStyle(document.documentElement).getPropertyValue(token));
}
