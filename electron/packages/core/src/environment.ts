import { isRecord } from './workspace';
import type { ForgeAuth } from './forge';
/** spec/settings-modules-and-onboarding#settings-keys: what the intro and Settings ▸ Agents show about this Mac. `via` — how the agent starts:
 *  its adapter on PATH or in the npx cache, or npx that fetches it on the first launch. */
export type AgentCheck = {
	provider: 'claude' | 'codex';
	found: boolean;
	via: 'path' | 'cache' | 'npx' | null;
	version: string | null;
	signIn: 'signed-in' | 'signed-out' | 'expired' | 'unknown';
};
export type ToolCheck = { found: boolean; version: string | null };
export type EnvironmentCheck = {
	agents: AgentCheck[];
	git: ToolCheck;
	gh: { auth: ForgeAuth; version: string | null };
};
/** How to install what is missing; the intro shows it as a command to copy. */
export const installCommands = {
	claude: 'npm install -g @anthropic-ai/claude-code',
	codex: 'npm install -g @openai/codex',
	gh: 'brew install gh && gh auth login',
} as const;
/** The command a sign-in opens in Terminal. */
/** spec/agents-and-providers#sign-in-recovery: the agent's sign-in, run by the app as a child process (no Terminal). */
export const signInCommands = {
	claude: ['auth', 'login', '--claudeai'],
	codex: ['login'],
} as const;
/** spec/agents-and-providers#sign-in-recovery: the in-app sign-in of one agent, shared by every task of it. `at` — ms of the last change. */
export type AgentLoginState = {
	provider: 'claude' | 'codex';
	phase: 'idle' | 'waiting' | 'failed' | 'done';
	url: string | null;
	at: number;
};
const isTool = (value: unknown): value is ToolCheck =>
	isRecord(value) &&
	typeof value.found === 'boolean' &&
	(value.version === null || typeof value.version === 'string');
export function isEnvironmentCheck(value: unknown): value is EnvironmentCheck {
	return (
		isRecord(value) &&
		Array.isArray(value.agents) &&
		value.agents.every(
			(agent) =>
				isRecord(agent) &&
				(agent.provider === 'claude' || agent.provider === 'codex') &&
				typeof agent.found === 'boolean' &&
				[null, 'path', 'cache', 'npx'].includes(agent.via as string | null) &&
				(agent.version === null || typeof agent.version === 'string') &&
				['signed-in', 'signed-out', 'expired', 'unknown'].includes(agent.signIn as string)
		) &&
		isTool(value.git) &&
		isRecord(value.gh) &&
		['ready', 'missing', 'login', 'error'].includes(value.gh.auth as string) &&
		(value.gh.version === null || typeof value.gh.version === 'string')
	);
}
/** The first `x.y.z` in a `--version` line: `git version 2.50.1` → `2.50.1`. */
export function versionOf(output: string): string | null {
	return /(\d+\.\d+(?:\.\d+)?)/.exec(output)?.[1] ?? null;
}
