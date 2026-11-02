import { AgentTransport, isAuthRequired } from './transport';
/** spec/appearance#evolution-redesign p. 19: the message of a one-shot call that failed on the agent's sign-in (ACP authRequired), not on the text. */
export const signInRequired = 'Agent sign-in required';
import type { AdapterCommand } from './adapter';
import {
	isRecord,
	selectOption,
	type AgentProvider,
	type AgentOption,
	type AgentEvent,
} from '@brigadir/core';
/** spec/agents-and-providers#one-shot: a disposable text call; no task, journal, MCP server or filesystem capability. */
export async function oneShotText(input: {
	prompt: string;
	cwd: string;
	provider?: AgentProvider;
	adapter?: AdapterCommand;
	signal?: AbortSignal;
	timeoutMs?: number;
	characterLimit?: number;
	preferredModel?: string;
	/** spec/composer-steering-queue-and-ghost#ghost-headless: an exact catalog value; wins over `preferredModel`. */ model?: string;
	/** spec/composer-steering-queue-and-ghost#ghost-headless: the lowest effort the chosen model advertises (first level that is not the provider's `default`). */ lowestEffort?: boolean;
	/** spec/appearance#evolution-redesign: an exact effort level of the chosen model; one it does not list falls back to `lowestEffort`. */ effort?: string;
	stopAtRateWarning?: boolean;
	onRateLimit?: (event: Extract<AgentEvent, { kind: 'rate-limit.changed' }>) => void;
}): Promise<string> {
	if (!input.prompt.trim() || input.prompt.length > 200_000)
		throw new Error('Invalid text generation input');
	const controller = new AbortController(),
		signal = input.signal ? AbortSignal.any([input.signal, controller.signal]) : controller.signal;
	let options: AgentOption[] = [];
	let transport: AgentTransport | undefined,
		text = '',
		completed = false,
		failure: Error | undefined;
	// spec/agents-and-providers#one-shot: the call leaves no session in the agent's history (Claude transcripts, Codex threads in ChatGPT). The adapter
	// gets its own signal so a cancelled or failed call still deletes the session before the process stops.
	const lifetime = new AbortController();
	const dispose = () => {
		if (transport) {
			const opened = transport;
			void opened.deleteSession().finally(() => opened.close());
		} else lifetime.abort(signal.reason);
	};
	signal.addEventListener('abort', dispose, { once: true });
	const aborted = new Promise<never>((_, reject) =>
		signal.addEventListener('abort', () => reject(signal.reason), { once: true })
	);
	aborted.catch(() => {});
	const guard = <T>(work: Promise<T>) => Promise.race([work, aborted]);
	const fail = (message: string) => {
		failure ??= new Error(message);
		controller.abort(failure);
	};
	const timer = setTimeout(() => fail('Text generation timed out'), input.timeoutMs ?? 90000);
	try {
		transport = await AgentTransport.start({
			provider: input.provider ?? 'claude',
			cwd: input.cwd,
			signal: lifetime.signal,
			...(input.adapter ? { adapter: input.adapter } : {}),
			startupTimeoutMs: input.timeoutMs ?? 90000,
			requestPermission: async () => null,
			onEvent: (event) => {
				if (event.kind === 'session.started' || event.kind === 'options.changed')
					options = event.options;
				if (event.kind === 'rate-limit.changed') input.onRateLimit?.(event);
				if (
					input.stopAtRateWarning &&
					event.kind === 'rate-limit.changed' &&
					event.status !== 'allowed'
				)
					fail('Subscription quota warning');
				if (
					event.kind === 'message.delta' &&
					event.role === 'assistant' &&
					event.content.kind === 'text'
				) {
					text += event.content.text;
					if (text.length > (input.characterLimit ?? 12000))
						fail('Generated text exceeds its limit');
				}
				if (event.kind === 'tool.changed') fail('Text generation cannot use tools');
				if (event.kind === 'session.failed')
					failure ??= new Error(event.reason === 'auth' ? signInRequired : event.message);
				if (event.kind === 'turn.completed') {
					completed = event.reason === 'end_turn';
					if (!completed) failure ??= new Error('Text generation did not finish');
				}
			},
		});
		const model = selectOption(options, 'model');
		if (model && (input.model || input.preferredModel)) {
			const preferred = (input.model ?? input.preferredModel)!.toLowerCase(),
				choice =
					model.choices.find((choice) => choice.value.toLowerCase() === preferred) ??
					(input.model
						? undefined
						: model.choices.find((choice) => choice.name.toLowerCase().includes(preferred)));
			if (choice && choice.value !== model.value)
				await guard(transport.send({ kind: 'setOption', id: model.id, value: choice.value })).catch(
					() => {}
				);
		}
		// Levels come from the provider once the model is set (spec/agents-and-providers#catalog); their order is the provider's, lowest first.
		const effort = input.lowestEffort || input.effort ? selectOption(options, 'effort') : undefined,
			exact = input.effort
				? effort?.choices.find((choice) => choice.value === input.effort)
				: undefined,
			lowest =
				exact ??
				(input.lowestEffort
					? effort?.choices.find((choice) => choice.value !== 'default')
					: undefined);
		if (effort && lowest && lowest.value !== effort.value)
			await guard(transport.send({ kind: 'setOption', id: effort.id, value: lowest.value })).catch(
				() => {}
			);
		signal.throwIfAborted();
		// spec/composer-steering-queue-and-ghost#ghost-headless: an adapter may answer an option change with text of its own («Auto mode unavailable…» from claude-agent-acp
		// when the model has no Auto mode). It is not the answer: only text after the prompt counts.
		text = '';
		await guard(transport.send({ kind: 'prompt', text: input.prompt }));
		if (failure) throw failure;
		signal.throwIfAborted();
		if (!completed || !text.trim()) throw new Error('Text generation returned no answer');
		return text.trim();
	} catch (error) {
		if (failure) throw failure;
		if (signal.aborted) throw new Error('Text generation was cancelled');
		if (isAuthRequired(error)) throw new Error(signInRequired);
		// spec/agents-and-providers#adapter-launch: an adapter that cannot start its CLI answers «Internal error»; the reason is in `data.details`.
		const details =
			error instanceof Error &&
			'data' in error &&
			isRecord(error.data) &&
			typeof error.data.details === 'string'
				? error.data.details
				: '';
		throw details
			? new Error(`${error instanceof Error ? error.message : String(error)}: ${details}`)
			: error;
	} finally {
		clearTimeout(timer);
		signal.removeEventListener('abort', dispose);
		dispose();
	}
}
