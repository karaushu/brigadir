import { describe, expect, it } from 'vitest';
import { agentStatus } from './agent-status';
import type { AgentCheck } from './environment';

const agent = (patch: Partial<AgentCheck> = {}): AgentCheck => ({
	provider: 'claude',
	found: true,
	via: 'path',
	version: '2.1.290',
	signIn: 'signed-in',
	...patch,
});

// spec/appearance#component-details: Settings ▸ Agents and the intro build the agent's line with one function.
describe('agentStatus', () => {
	it('tells a failed check from a running one before any result', () => {
		expect(agentStatus('en', undefined, { failed: true })).toEqual({
			state: 'failed',
			text: 'Not checked',
		});
		expect(agentStatus('en', undefined, { failed: true, checking: true })).toEqual({
			state: 'checking',
			text: 'Searching…',
		});
		expect(agentStatus('uk', undefined).text).toBe('Пошук…');
	});
	it('names a missing agent and a needed sign-in', () => {
		expect(agentStatus('en', agent({ found: false }))).toEqual({
			state: 'missing',
			text: 'Not found on this computer',
		});
		expect(agentStatus('en', agent({ signIn: 'signed-out' })).text).toBe(
			'Found. You need to sign in.'
		);
		expect(agentStatus('en', agent({ signIn: 'expired' })).text).toBe('Sign-in expired');
		expect(agentStatus('en', agent({ signIn: 'expired' }), { waiting: true })).toEqual({
			state: 'login',
			text: 'Waiting for browser sign-in…',
		});
	});
	it('shows the version when ready, «signed in with…» only on request', () => {
		expect(agentStatus('en', agent()).text).toBe('Ready · 2.1.290');
		expect(agentStatus('en', agent({ version: null, signIn: 'unknown' })).text).toBe('Ready');
		expect(agentStatus('en', agent({ via: 'npx', version: null })).text).toBe(
			'Downloads on the first launch'
		);
		expect(agentStatus('en', agent(), { signedInWith: true }).text).toBe(
			'Ready · signed in with Claude Code'
		);
		expect(agentStatus('uk', agent({ provider: 'codex' }), { signedInWith: true }).text).toBe(
			'Готовий · вхід через ChatGPT'
		);
		expect(agentStatus('en', agent({ signIn: 'unknown' }), { signedInWith: true }).text).toBe(
			'Ready · 2.1.290'
		);
	});
});
