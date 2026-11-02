import { expect, it } from 'vitest';
import type { Terminal } from '@xterm/xterm';
import { nativeWheel } from './terminal-wheel';

function fake() {
	const csi: ((params: number[]) => boolean)[] = [];
	let wheel: (event: WheelEvent) => boolean = () => true;
	const terminal = {
		cols: 80,
		rows: 20,
		modes: { mouseTrackingMode: 'any' },
		buffer: { active: { type: 'normal' } },
		scrollLines: (_count: number) => {},
		parser: {
			registerCsiHandler: (_id: unknown, handler: (params: number[]) => boolean) => {
				csi.push(handler);
				return { dispose() {} };
			},
		},
		attachCustomWheelEventHandler: (handler: typeof wheel) => {
			wheel = handler;
		},
	};
	const screen = {
		getBoundingClientRect: () => ({ left: 0, top: 0, width: 800, height: 400 }),
	} as HTMLElement;
	return {
		terminal: terminal as unknown as Terminal,
		screen,
		setSgr: (on: boolean) => csi[on ? 0 : 1]!([1000, 1006]),
		wheel: (deltaY: number) =>
			wheel({
				deltaY,
				deltaMode: 0,
				shiftKey: false,
				clientX: 15,
				clientY: 25,
				preventDefault() {},
			} as WheelEvent),
	};
}

it('sends one SGR wheel report per line-height of trackpad travel, keeping the remainder', () => {
	const { terminal, screen, setSgr, wheel } = fake();
	const sent: string[] = [];
	let speed = 1;
	nativeWheel(
		terminal,
		() => screen,
		() => speed,
		(data) => sent.push(data)
	);
	setSgr(true);
	// Cells are 10×20 px: 50 px down is two lines with 10 px kept, the next 10 px completes a third.
	expect(wheel(50)).toBe(false);
	expect(sent).toEqual(['\x1b[<65;2;2M\x1b[<65;2;2M']);
	wheel(10);
	expect(sent[1]).toBe('\x1b[<65;2;2M');
	// Turning back drops the remainder; speed scales the travel.
	speed = 2;
	wheel(-20);
	expect(sent[2]).toBe('\x1b[<64;2;2M\x1b[<64;2;2M');
});

it('leaves the wheel to xterm without SGR mouse tracking', () => {
	const { terminal, screen, wheel } = fake();
	const sent: string[] = [];
	nativeWheel(
		terminal,
		() => screen,
		() => 1,
		(data) => sent.push(data)
	);
	expect(wheel(100)).toBe(true);
	expect(sent).toEqual([]);
});

it('scrolls Codex history locally even with mouse tracking, but leaves alternate-screen events to the CLI', () => {
	const { terminal, screen, setSgr, wheel } = fake();
	const sent: string[] = [],
		scrolled: number[] = [];
	terminal.scrollLines = (count) => {
		scrolled.push(count);
	};
	nativeWheel(
		terminal,
		() => screen,
		() => 1,
		(data) => sent.push(data),
		() => true
	);
	setSgr(true);
	wheel(-50);
	wheel(-10);
	expect(scrolled).toEqual([-2, -1]);
	expect(sent).toEqual([]);
	(terminal.buffer.active as { type: string }).type = 'alternate';
	wheel(20);
	expect(sent).toEqual(['\x1b[<65;2;2M']);
	expect(scrolled).toEqual([-2, -1]);
});
