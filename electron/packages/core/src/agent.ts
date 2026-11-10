/** Portable domain records. Protocol metadata and provider model registries do not belong here. */
export type AgentProvider = 'claude' | 'codex';
export type AgentContent =
	| { kind: 'text'; text: string }
	| { kind: 'image' | 'audio'; mimeType: string; data: string }
	| { kind: 'resource'; uri: string; name: string | null; text: string | null }
	| { kind: 'unsupported'; format: string };
export type ToolContent =
	| AgentContent
	| { kind: 'diff'; path: string; before: string | null; after: string }
	| { kind: 'terminal'; id: string };
export type ToolPatch = {
	/** `name` is the provider's own tool name when it sends one (Claude `Bash`, `Edit`); Codex does not (spec/agents-and-providers#mapper-rules). */
	id: string;
	name?: string;
	title?: string;
	category?: string;
	status?: string;
	input?: string;
	output?: string;
	exitCode?: number;
	content?: ToolContent[];
	locations?: { path: string; line: number | null }[];
	/** The tool call of a subagent that runs this one (Claude `parentToolUseId`); top-level tools have none (spec/composer-steering-queue-and-ghost#steering-hold). */
	parentId?: string;
};
export type AgentOption = {
	id: string;
	name: string;
	description: string | null;
	category: string | null;
} & (
	| { kind: 'boolean'; value: boolean }
	| {
			kind: 'select';
			value: string;
			choices: { value: string; name: string; description: string | null; group: string | null }[];
	  }
);
export type AgentMode = { id: string; name: string; description: string | null };
export type PermissionRequest = {
	id: string;
	tool: ToolPatch;
	options: { id: string; name: string; kind: string }[];
};
export type SubagentState = 'completed' | 'failed' | 'cancelled';
/** spec/chat-turns-plans-and-questions#background-commands: how a background command ended. `stopped` — the person's «Stop», or the task or the app closed under it. */
export type BackgroundState = 'completed' | 'failed' | 'stopped';
/** spec/chat-turns-plans-and-questions#background-commands: why it stopped; kept in the journal, never shown — the UI says «Stopped» for all three. */
export type BackgroundStopReason = 'person' | 'closed' | 'restarted';
export type AgentEvent =
	| {
			kind: 'rate-limit.changed';
			status: 'allowed' | 'allowed_warning' | 'rejected';
			window: string | null;
			resetsAt: number | null;
	  }
	/** Account-level subscription windows seen in this session (spec/agents-and-providers#quota-sources); main folds them into the global quota. */
	| {
			kind: 'quota.observed';
			provider: AgentProvider;
			windows: import('./quota').QuotaReading[];
			complete: boolean;
	  }
	/** `steering`: the adapter takes a prompt into a running turn (`_session/steering`, spec/composer-steering-queue-and-ghost#steering). */
	| {
			kind: 'session.started';
			sessionId: string;
			modes: AgentMode[];
			modeId: string | null;
			options: AgentOption[];
			steering?: boolean;
	  }
	/** `subagentId`: the update came from that subagent's own session (spec/chat#subagents). `parentId`: an adapter without subagent sessions
	 *  marks a subagent's text with the tool call that runs it (Claude `parentToolUseId`); it never joins the main agent's message. */
	| {
			kind: 'message.delta';
			role: 'user' | 'assistant' | 'thought';
			messageId: string | null;
			content: AgentContent;
			subagentId?: string;
			parentId?: string;
	  }
	| { kind: 'tool.changed'; patch: ToolPatch; subagentId?: string }
	/** spec/chat#subagents: the agent started a subagent with its own session (ACP `subagent_spawned`); `parentId` is the subagent that started it. */
	| {
			kind: 'subagent.started';
			id: string;
			parentId: string | null;
			name: string;
			prompt: string | null;
	  }
	/** spec/chat#subagents: what the adapter told about a subagent: its end (ACP `subagent_state_update`), the tool call that ran it, and the
	 *  type, model, tokens and run time of its result when the adapter sent them. Nothing here is computed by us. */
	| {
			kind: 'subagent.changed';
			id: string;
			state?: SubagentState;
			toolId?: string;
			type?: string;
			model?: string;
			tokens?: number;
			durationMs?: number;
	  }
	/** spec/chat-turns-plans-and-questions#background-commands: a command the agent left running after its tool call returned (Claude Bash `run_in_background`). `name` is the
	 *  agent's own description of it; `toolId` the call that started it. */
	| { kind: 'background.started'; id: string; toolId: string | null; name: string }
	/** spec/chat-turns-plans-and-questions#background-commands: its end, or the file its output goes to (named by the adapter, read only by the host). */
	| {
			kind: 'background.changed';
			id: string;
			state?: BackgroundState;
			reason?: BackgroundStopReason;
			outputPath?: string;
	  }
	| { kind: 'plan.changed'; entries: { text: string; priority: string; status: string }[] }
	/** spec/chat-turns-plans-and-questions#plan-approval: a plan document from ACP `plan_update` (markdown); one per `planId`, replaced whole on each update. */
	| { kind: 'plan.document'; planId: string; text: string }
	| { kind: 'plan.removed'; planId: string }
	| { kind: 'options.changed'; options: AgentOption[] }
	| { kind: 'mode.changed'; modeId: string }
	| {
			kind: 'commands.changed';
			commands: { name: string; description: string; inputHint: string | null }[];
	  }
	| {
			kind: 'usage.changed';
			used: number;
			capacity: number;
			cost: { amount: number; currency: string } | null;
	  }
	| { kind: 'session.info'; title?: string; updatedAt?: string }
	| { kind: 'permission.requested'; request: PermissionRequest }
	/** spec/agents-and-providers#turn-usage: the tokens of one finished turn as the adapter reported them; journaled just before its `turn.completed`. */
	| { kind: 'turn.usage'; input: number; output: number; cacheRead: number; cacheWrite: number }
	| { kind: 'turn.completed'; reason: string }
	/** spec/agents-and-providers#sign-in-recovery: `auth` — the adapter answered ACP `authRequired`; the agent's sign-in, not the task, failed. */
	| { kind: 'session.failed'; message: string; reason?: 'auth' }
	| { kind: 'unhandled'; name: string };
/** `crew` marks a service prompt the crew host sends to its own agent (report, question, plan decision); the UI renders it as a service row (spec/crew-templates-and-editor#after-launch). */
/** `steer`: the person typed it in the composer, so it may go into the running turn (spec/composer-steering-queue-and-ghost#steering); app and crew prompts never carry it. */
export type AgentCommand =
	| {
			kind: 'prompt';
			text: string;
			attachmentIds?: string[];
			crew?: import('./crew-runtime').CrewTurnMarker;
			steer?: true;
	  }
	| { kind: 'cancel' }
	| { kind: 'stopBackground'; id: string }
	| { kind: 'setMode'; modeId: string }
	| { kind: 'setOption'; id: string; value: string | boolean };

/** Validate provider catalogs stored with a task; never infer a model registry. */
export function isAgentOption(value: unknown): value is AgentOption {
	if (!value || typeof value !== 'object') return false;
	const option = value as Record<string, unknown>,
		nullable = (v: unknown) => v === null || typeof v === 'string';
	return (
		typeof option.id === 'string' &&
		typeof option.name === 'string' &&
		nullable(option.description) &&
		nullable(option.category) &&
		((option.kind === 'boolean' && typeof option.value === 'boolean') ||
			(option.kind === 'select' &&
				typeof option.value === 'string' &&
				Array.isArray(option.choices) &&
				option.choices.length <= 1024 &&
				option.choices.every(
					(choice) =>
						choice &&
						typeof choice === 'object' &&
						typeof choice.value === 'string' &&
						typeof choice.name === 'string' &&
						nullable(choice.description) &&
						nullable(choice.group)
				)))
	);
}
