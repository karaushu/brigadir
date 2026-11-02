import { describe, expect, it, vi } from 'vitest';

// spec/remote-access-and-mobile#browser-from-device: a window of another machine — the sign-in page opens on this device, never on the machine; spec/remote-access-and-mobile#networking:
// through `openAgentSignIn`, which also listens for the page's way back.
describe('a sign-in from a window of another machine', () => {
	it('opens the page here once the machine knows it, and «Open the page again» opens it here too', async () => {
		let listener: ((state: unknown) => void) | null = null;
		const opened: string[] = [];
		const brigadir = {
			remoteMachine: { id: 'a'.repeat(64), name: 'studio', device: 'ThinkPad' },
			onAgentLogin: (next: (state: unknown) => void) => {
				listener = next;
				return () => {};
			},
			signInAgent: vi.fn(async () => ({ provider: 'claude', phase: 'waiting', url: null, at: 1 })),
			reopenAgentLogin: vi.fn(async () => {}),
			openAgentSignIn: vi.fn(async (provider: string, url: string) => {
				opened.push(`${provider} ${url}`);
			}),
		};
		vi.stubGlobal('window', { brigadir });
		const { signInAgent, reopenAgentLogin } = await import('./agent-sign-in');
		await signInAgent('claude');
		expect(opened).toEqual([]);
		listener!({ provider: 'codex', phase: 'waiting', url: 'https://example.com/codex', at: 2 });
		listener!({ provider: 'claude', phase: 'waiting', url: 'https://example.com/claude', at: 3 });
		listener!({ provider: 'claude', phase: 'waiting', url: 'https://example.com/claude', at: 4 });
		expect(opened).toEqual(['claude https://example.com/claude']);
		await reopenAgentLogin('claude', 'https://example.com/again');
		expect(opened).toEqual([
			'claude https://example.com/claude',
			'claude https://example.com/again',
		]);
		expect(brigadir.reopenAgentLogin).not.toHaveBeenCalled();
		vi.unstubAllGlobals();
	});
});
