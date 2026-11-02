import { describe, expect, it } from 'vitest';
import { chatCeiling, chatMinimum } from './chat-width';

describe('chatCeiling (spec/task-window#width-rules)', () => {
	it('leaves the work area its 400 px and nothing more without the panel', () => {
		expect(chatCeiling(2000, null)).toBe(2000 - 401);
	});
	it('counts the open panel at the width it wants', () => {
		expect(chatCeiling(2400, 400)).toBe(2400 - 401 - 401);
		expect(chatCeiling(2400, 460)).toBe(2400 - 401 - 461);
	});
	it('is not the old 900 on a wide window', () => {
		expect(chatCeiling(2560, 400)).toBeGreaterThan(900);
	});
	it('never drops under the chat minimum on a narrow window', () => {
		expect(chatCeiling(900, 400)).toBe(chatMinimum);
	});
});
