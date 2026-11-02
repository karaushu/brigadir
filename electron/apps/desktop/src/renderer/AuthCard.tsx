import { useEffect, useRef, useState } from 'react';
import { t, type AgentLoginState, type Locale } from '@brigadir/core';
import { Button } from './ui/Controls';
import { TextInput } from './ui/Input';
import { Glyph } from './ui/Glyph';
import { notify } from './ui/Toast';
import s from './AuthCard.module.css';
import { reopenAgentLogin, startAgentSignIn } from './agent-sign-in';
export { signInAgent } from './agent-sign-in';
type Provider = 'claude' | 'codex';
const agentName = (provider: Provider) => (provider === 'codex' ? 'Codex' : 'Claude');
/** Sign-ins already reported as not finished: a card that mounts again (another task, a re-render of the log) does not repeat the toast. */
const reportedRelogins = new Set<string>();
/** spec/agents-and-providers#sign-in-recovery: one in-app sign-in per agent, shared by every card of it. */
export function useAgentLogin(provider: Provider): AgentLoginState {
	const [state, setState] = useState<AgentLoginState>({
		provider,
		phase: 'idle',
		url: null,
		at: 0,
	});
	useEffect(() => {
		let active = true;
		setState({ provider, phase: 'idle', url: null, at: 0 });
		const off = window.brigadir.onAgentLogin((next) => {
			if (next.provider === provider) setState(next);
		});
		void window.brigadir.readAgentLogin(provider).then(
			(next) => {
				if (active) setState((current) => (current.at > next.at ? current : next));
			},
			() => {}
		);
		return () => {
			active = false;
			off();
		};
	}, [provider]);
	return state;
}
function Spinner() {
	return (
		<svg
			className={s.spin}
			aria-hidden="true"
			width="14"
			height="14"
			viewBox="0 0 16 16"
			fill="none">
			<circle cx="8" cy="8" r="6" stroke="var(--accent)" strokeWidth="1.6" opacity=".25" />
			<path d="M8 2a6 6 0 0 1 6 6" stroke="var(--accent)" strokeWidth="1.6" strokeLinecap="round" />
		</svg>
	);
}
function Done() {
	return (
		<svg
			aria-hidden="true"
			width="13"
			height="13"
			viewBox="0 0 16 16"
			fill="none"
			className={s.done}>
			<circle cx="8" cy="8" r="7" fill="currentColor" opacity=".22" />
			<path
				d="M4.9 8.3 6.9 10.3 11.1 5.9"
				stroke="currentColor"
				strokeWidth="1.6"
				strokeLinecap="round"
				strokeLinejoin="round"
			/>
		</svg>
	);
}
/**
 * spec/agents-and-providers#sign-in-recovery: the card on the place of the turn that failed on the agent's sign-in. `startup`: the session never
 * started, so nothing was sent; `failedAt` (ms) tells a sign-in that ended after this failure from an older one.
 */
export function AuthCard({
	provider,
	locale,
	detail,
	startup,
	failedAt,
	retryDisabled,
	onRetry,
	embedded = false,
}: {
	provider: Provider;
	locale: Locale;
	detail: string;
	startup: boolean;
	failedAt: number;
	retryDisabled: boolean;
	onRetry(): void;
	/** spec/notifications-slack-notes-and-schedules#notice-chips: the body of the composer chip's popover, which already carries the title. */ embedded?: boolean;
}) {
	const login = useAgentLogin(provider),
		name = agentName(provider),
		[open, setOpen] = useState(false),
		[codeOpen, setCodeOpen] = useState(false),
		[code, setCode] = useState('');
	const waiting = login.phase === 'waiting',
		relogin = login.phase === 'failed' && login.at > failedAt;
	// A session that never started has no host to retry it after the sign-in (spec/agents-and-providers#sign-in-recovery): the card starts it.
	const retried = useRef(0);
	useEffect(() => {
		if (startup && login.phase === 'done' && login.at > failedAt && retried.current !== login.at) {
			retried.current = login.at;
			onRetry();
		}
	}, [startup, login.phase, login.at, failedAt, onRetry]);
	useEffect(() => {
		if (!waiting) {
			setCodeOpen(false);
			setCode('');
		}
	}, [waiting]);
	// spec/notifications-slack-notes-and-schedules#message-classes: the sign-in's own failures are toasts; the card keeps its state (`relogin`) and its actions.
	const signIn = () => startAgentSignIn(provider, locale);
	const submit = () => {
		if (!code.trim()) return;
		void window.brigadir.submitAgentLoginCode(provider, code).then(
			() => setCode(''),
			() => notify('error', t(locale, 'The code was not accepted.'))
		);
	};
	useEffect(() => {
		if (!relogin || waiting) return;
		const key = `${provider}:${login.at}`;
		if (reportedRelogins.has(key)) return;
		reportedRelogins.add(key);
		notify(
			'warning',
			t(locale, 'Sign-in was not finished: the page closed before the end of the sign-in.'),
			{ action: { label: t(locale, 'Retry'), run: signIn } }
		);
	}, [relogin, waiting, provider, login.at]);
	const details = (
		<Button
			variant="ghost"
			disclosure
			className={s.link}
			aria-expanded={open}
			onClick={() => setOpen((value) => !value)}>
			<Glyph name="chevron-down" size={9} />
			{t(locale, 'Details')}
		</Button>
	);
	return (
		<div
			className={s.card}
			data-auth-card={embedded ? 'popover' : 'log'}
			data-embedded={embedded || undefined}
			data-state={waiting ? 'waiting' : relogin ? 'relogin' : 'failed'}
			role={embedded ? undefined : 'alert'}>
			<span className={s.icon} data-waiting={waiting || undefined}>
				{waiting ? <Spinner /> : <Glyph name="agent-key" size={14} />}
			</span>
			<div className={s.body}>
				<div className={s.head}>
					<strong>
						{waiting
							? t(locale, 'Waiting for the sign-in in the browser…')
							: t(locale, '{agent} asks you to sign in again').replace('{agent}', name)}
					</strong>
					<small>{provider === 'claude' ? t(locale, 'Claude Code · subscription') : 'Codex'}</small>
				</div>
				<p>
					{waiting
						? t(
								locale,
								'The browser opened the {agent} sign-in page. Once you sign in, the message goes to the agent by itself.'
							).replace('{agent}', name)
						: t(
								locale,
								startup
									? 'The subscription sign-in expired and did not renew, so the agent did not start. After you sign in, it starts again.'
									: 'The subscription sign-in expired and did not renew, so the message did not reach the agent. After you sign in, Brigadir sends it again.'
							)}
				</p>
				{codeOpen && (
					<form
						className={s.code}
						data-size="m"
						onSubmit={(event) => {
							event.preventDefault();
							submit();
						}}>
						<label htmlFor="auth-code">{t(locale, 'Code from the page')}</label>
						<TextInput
							id="auth-code"
							className={s.codeInput}
							autoFocus
							autoComplete="off"
							spellCheck={false}
							value={code}
							onChange={(event) => setCode(event.target.value)}
						/>
						<Button type="submit" appearance="primary" disabled={!code.trim()}>
							{t(locale, 'Sign in')}
						</Button>
					</form>
				)}
				<div className={s.actions} data-size="m">
					{waiting ? (
						<>
							{login.url && (
								<Button
									variant="ghost"
									className={s.link}
									onClick={() => {
										void reopenAgentLogin(provider, login.url).catch(() => {});
									}}>
									<Glyph name="external" size={12} />
									{t(locale, 'Open the page again')}
								</Button>
							)}
							{provider === 'claude' && !codeOpen && (
								<Button variant="ghost" className={s.link} onClick={() => setCodeOpen(true)}>
									{t(locale, 'Enter the code')}
								</Button>
							)}
							<span className={s.space} />
							<Button
								onClick={() => {
									void window.brigadir.cancelAgentLogin(provider).catch(() => {});
								}}>
								{t(locale, 'Cancel')}
							</Button>
						</>
					) : (
						<>
							<Button appearance="primary" onClick={signIn}>
								{t(locale, 'Sign in to {agent}…').replace('{agent}', name)}
							</Button>
							<Button disabled={retryDisabled} onClick={onRetry}>
								{t(locale, 'Try again')}
							</Button>
							<span className={s.space} />
							{details}
						</>
					)}
				</div>
				{open && !waiting && <pre className={s.detail}>{detail}</pre>}
			</div>
		</div>
	);
}
/** spec/agents-and-providers#sign-in-recovery: a sign-in card the conversation went past — the retry that followed it, or only the fact. */
export function AuthRow({
	provider,
	locale,
	retried,
}: {
	provider: Provider;
	locale: Locale;
	retried: boolean;
}) {
	const name = agentName(provider);
	return (
		<div className={s.row} data-auth-row={retried ? 'retried' : 'past'}>
			{retried ? <Done /> : <Glyph name="agent-key" size={13} />}
			<span>
				{retried
					? t(locale, 'Signed in to {agent} · the message was sent again').replace('{agent}', name)
					: t(locale, '{agent} asked you to sign in again').replace('{agent}', name)}
			</span>
		</div>
	);
}
