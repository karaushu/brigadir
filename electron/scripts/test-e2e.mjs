// E2E lanes. Tests tagged @serial
// share the system clipboard and run alone; everything else runs in parallel workers, each Electron with its own profile
// and data dir, in background mode.
//   node scripts/test-e2e.mjs smoke            P0: the @smoke tests (15 specs), once per merge
//   node scripts/test-e2e.mjs area <name>      P1: one @area:<name>, e.g. diff, chat, editor
//   node scripts/test-e2e.mjs full             P2: everything
// The reporter is quiet (`dot`, playwright.config.ts): only failures print in full. Extra arguments go to
// `playwright test` (e.g. --reporter=line).
import { spawnSync } from 'node:child_process';
const [mode, ...rest] = process.argv.slice(2);
const areas = ['chat', 'tasks', 'diff', 'editor', 'pr', 'settings', 'browser', 'shell'];
let tag = null,
	extra = rest;
if (mode === 'smoke') tag = '@smoke';
else if (mode === 'area') {
	const name = rest[0];
	if (!areas.includes(name)) {
		console.error(`area: one of ${areas.join(', ')}`);
		process.exit(2);
	}
	tag = `@area:${name}`;
	extra = rest.slice(1);
} else if (mode !== 'full') {
	console.error('usage: test-e2e.mjs smoke | area <name> | full [playwright args]');
	process.exit(2);
}
const lane = (grep, invert, workers) =>
	spawnSync(
		'npx',
		[
			'playwright',
			'test',
			'--pass-with-no-tests',
			...(grep ? ['--grep', grep] : []),
			...(invert ? ['--grep-invert', invert] : []),
			`--workers=${workers}`,
			...extra,
		],
		{ stdio: 'inherit' }
	).status ?? 1;
const parallel = Number(process.env.BRIGADIR_E2E_WORKERS || 3);
const first = lane(tag, '@serial', parallel);
const second = lane(tag ? `(?=.*${tag}(?!\\S))(?=.*@serial)` : '@serial', null, 1);
process.exit(first || second);
