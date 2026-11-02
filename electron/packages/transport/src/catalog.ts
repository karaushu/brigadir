import { AgentTransport } from './transport';
import type { AdapterCommand } from './adapter';
import { selectOption, type AgentProvider, type AgentOption, type AgentMode } from '@brigadir/core';
/**
 * spec/tasks#sheet-model: what the agent itself advertises — asked before any task exists, so the launch
 * sheet can offer models on a fresh workspace. No prompt, no task, no journal: the session
 * is started for its `session.started` payload, every model is set once for its options (spec/agents-and-providers#catalog), and it is closed (spec/agents-and-providers#transport rule: no own registry).
 */
export async function probeAgentCatalog(input: {
	provider: AgentProvider;
	cwd: string;
	adapter?: AdapterCommand;
	signal?: AbortSignal;
	timeoutMs?: number;
}): Promise<{
	options: AgentOption[];
	modes: AgentMode[];
	byModel: Record<string, AgentOption[]>;
} | null> {
	const controller = new AbortController(),
		signal = input.signal ? AbortSignal.any([input.signal, controller.signal]) : controller.signal;
	const timeoutMs = input.timeoutMs ?? 30000;
	// Written from the event callback: a holder keeps TypeScript from narrowing it to `null`.
	const seen: {
		started: { options: AgentOption[]; modes: AgentMode[] } | null;
		latest: AgentOption[];
	} = { started: null, latest: [] };
	let transport: AgentTransport | undefined;
	const timer = setTimeout(
		() => controller.abort(new Error('The provider catalog request timed out')),
		timeoutMs
	);
	try {
		transport = await AgentTransport.start({
			provider: input.provider,
			cwd: input.cwd,
			signal,
			...(input.adapter ? { adapter: input.adapter } : {}),
			startupTimeoutMs: timeoutMs,
			requestPermission: async () => null,
			onEvent: (event) => {
				if (event.kind === 'session.started') {
					seen.started = { options: event.options, modes: event.modes };
					seen.latest = event.options;
				} else if (event.kind === 'options.changed') seen.latest = event.options;
			},
		});
		const catalog = seen.started;
		if (!catalog) return null;
		// spec/agents-and-providers#catalog: effort levels differ per model, so each model is set once and the provider's answer kept.
		// A model the provider refuses keeps no entry; the sheet then falls back to the advertised options.
		const byModel: Record<string, AgentOption[]> = {},
			model = selectOption(catalog.options, 'model');
		for (const choice of model?.choices ?? []) {
			if (signal.aborted) break;
			try {
				await transport.send({ kind: 'setOption', id: model!.id, value: choice.value });
				byModel[choice.value] = seen.latest;
			} catch {
				/* next model */
			}
		}
		return { ...catalog, byModel };
	} catch {
		return seen.started ? { ...seen.started, byModel: {} } : null;
	} finally {
		clearTimeout(timer);
		transport?.close();
	}
}
