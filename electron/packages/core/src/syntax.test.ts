import { expect, it } from 'vitest';
import { syntaxFencePath, syntaxLanguage } from './syntax';
it('maps fence aliases to existing grammars and leaves unknown labels plain', () => {
	for (const [label, path] of [
		['TypeScript', 'code.ts'],
		['tsx', 'code.tsx'],
		['javascript title="demo"', 'code.js'],
		['shell', 'code.sh'],
		['c++', 'code.cpp'],
		['C#', 'code.cs'],
		['python', 'code.py'],
	]) {
		expect(syntaxFencePath(label!)).toBe(path);
		expect(syntaxLanguage(path!)).not.toBeNull();
	}
	for (const label of ['', 'mermaid', 'unknown', '../../file.ts', '<img>'])
		expect(syntaxFencePath(label)).toBe('code.txt');
});
