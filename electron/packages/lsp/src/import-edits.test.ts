import { afterEach, expect, it } from 'vitest';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { esmImportEdits } from './import-edits';

const roots: string[] = [];
afterEach(() => {
	for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});
it('uses real runtime extensions and explicit directory indexes for generated ESM imports', () => {
	const root = mkdtempSync(join(tmpdir(), 'brigadir-imports-'));
	roots.push(root);
	for (const file of ['math.js', 'helper.mjs', 'typed.mts', 'common.cts', 'plain.ts'])
		writeFileSync(join(root, file), 'export const value = 1;');
	mkdirSync(join(root, 'folder'));
	writeFileSync(join(root, 'folder/index.js'), 'export const value = 1;');
	for (const [name, expected] of [
		['math', 'math.js'],
		['helper.mjs', 'helper.mjs'],
		['typed.mjs', 'typed.mjs'],
		['common.cjs', 'common.cjs'],
		['plain', 'plain.js'],
		['folder', 'folder/index.js'],
	]) {
		const edits = [{ from: 0, to: 0, insert: `import { value } from "./${name}";\n\n` }];
		expect(esmImportEdits(join(root, 'main.mjs'), edits)[0]?.insert).toBe(
			`import { value } from "./${expected}";\n\n`
		);
		expect(esmImportEdits(join(root, 'main.tsx'), edits)).toBe(edits);
	}
});
it('preserves package imports, existing extensions, unresolved imports, comments and unrelated edits', () => {
	const edits = [
		{
			from: 5,
			to: 9,
			insert:
				'import x from "package";\nimport y from "./explicit.js";\nimport z from "./missing";\n// import fake from "./math";\n',
		},
		{ from: 20, to: 20, insert: ', multiply' },
	];
	expect(esmImportEdits('/tmp/main.mjs', edits)).toEqual(edits);
});
