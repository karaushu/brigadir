import { useEffect, useState } from 'react';
import { agentStatus, installCommands, t, type AgentCheck, type Locale } from '@brigadir/core';
import { Button } from './ui/Controls';
import { useAgentLogin } from './AuthCard';
import { startAgentSignIn } from './agent-sign-in';
import styles from './AgentStatus.module.css';
/** One status line per agent, the same in the intro and Settings ▸ Agents (spec/settings-modules-and-onboarding#intro). */
export function AgentStatus({
	agent,
	locale,
	checking,
	failed = false,
	refresh,
}: {
	agent: AgentCheck | undefined;
	locale: Locale;
	checking: boolean;
	/** The check itself failed: «Not checked» and Check instead of an endless «Searching…». */
	failed?: boolean;
	refresh(): void;
}) {
	if (!agent) {
		const { state, text } = agentStatus(locale, agent, { failed, checking });
		return state === 'failed' ? (
			<span className={styles.wrap} data-agent-status="failed">
				<span className={styles.status} data-state="failed">
					{text}
				</span>
				<Button onClick={refresh}>{t(locale, 'Check')}</Button>
			</span>
		) : (
			<span className={styles.status} data-state="checking">
				{text}
			</span>
		);
	}
	return <AgentStatusLine agent={agent} locale={locale} checking={checking} refresh={refresh} />;
}
function AgentStatusLine({
	agent,
	locale,
	checking,
	refresh,
}: {
	agent: AgentCheck;
	locale: Locale;
	checking: boolean;
	refresh(): void;
}) {
	const [hint, setHint] = useState(false),
		login = useAgentLogin(agent.provider),
		waiting = login.phase === 'waiting';
	// spec/agents-and-providers#sign-in-recovery: the in-app sign-in ends — the status reads the CLI again.
	useEffect(() => {
		if (login.phase === 'done' || login.phase === 'failed') refresh();
	}, [login.phase, login.at]); // eslint-disable-line react-hooks/exhaustive-deps
	const { state, text } = agentStatus(locale, agent, { waiting });
	return (
		<span className={styles.wrap} data-agent-status={state}>
			<span className={styles.status} data-state={state}>
				{text}
			</span>
			{state === 'missing' && (
				<Button onClick={() => setHint((value) => !value)}>{t(locale, 'How to install')}</Button>
			)}
			{state === 'login' &&
				(waiting ? (
					<Button
						onClick={() => {
							void window.brigadir.cancelAgentLogin(agent.provider).catch(() => {});
						}}>
						{t(locale, 'Cancel')}
					</Button>
				) : (
					<Button onClick={() => startAgentSignIn(agent.provider, locale)}>
						{t(locale, 'Sign in…')}
					</Button>
				))}
			{state !== 'ready' && (
				<Button disabled={checking} onClick={refresh}>
					{t(locale, 'Check')}
				</Button>
			)}
			{hint && state === 'missing' && (
				<code className={styles.hint}>{installCommands[agent.provider]}</code>
			)}
		</span>
	);
}
