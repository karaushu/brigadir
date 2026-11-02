import { isRecord } from '@brigadir/core';
import type * as ACP from '@agentclientprotocol/sdk';
import type {
	AgentContent,
	AgentEvent,
	AgentOption,
	PermissionRequest,
	ToolContent,
	ToolPatch,
} from '@brigadir/core';

export function mapContent(content: ACP.ContentBlock): AgentContent {
	switch (content.type) {
		case 'text':
			return { kind: 'text', text: content.text };
		case 'image':
		case 'audio':
			return { kind: content.type, mimeType: content.mimeType, data: content.data };
		case 'resource_link':
			return { kind: 'resource', uri: content.uri, name: content.name, text: null };
		case 'resource':
			return {
				kind: 'resource',
				uri: content.resource.uri,
				name: null,
				text: 'text' in content.resource ? content.resource.text : null,
			};
		default:
			return { kind: 'unsupported', format: (content as { type: string }).type };
	}
}
function mapToolContent(content: ACP.ToolCallContent): ToolContent {
	switch (content.type) {
		case 'content':
			return mapContent(content.content);
		case 'diff':
			return {
				kind: 'diff',
				path: content.path,
				before: content.oldText ?? null,
				after: content.newText,
			};
		case 'terminal':
			return { kind: 'terminal', id: content.terminalId };
	}
}
/** Claude names the tool in `_meta.claudeCode.toolName`; Codex reports the exit in `rawOutput` and `_meta.terminal_exit` (spec/agents-and-providers#mapper-rules). */
function toolName(meta: unknown): string | null {
	const claude = isRecord(meta) && isRecord(meta.claudeCode) ? meta.claudeCode : null;
	return typeof claude?.toolName === 'string' && claude.toolName ? claude.toolName : null;
}
/** spec/composer-steering-queue-and-ghost#steering-hold: Claude marks a subagent's own tools with `_meta.claudeCode.parentToolUseId`. */
function parentToolUseId(meta: unknown): string | null {
	const claude = isRecord(meta) && isRecord(meta.claudeCode) ? meta.claudeCode : null;
	return typeof claude?.parentToolUseId === 'string' && claude.parentToolUseId
		? claude.parentToolUseId
		: null;
}
function exitCode(tool: ACP.ToolCallUpdate, output: string | null): number | null {
	const exit =
		isRecord(tool._meta) && isRecord(tool._meta.terminal_exit)
			? tool._meta.terminal_exit.exit_code
			: undefined;
	if (typeof exit === 'number') return exit;
	if (isRecord(tool.rawOutput) && typeof tool.rawOutput.exit_code === 'number')
		return tool.rawOutput.exit_code;
	// Claude prefixes a failed Bash result with `Exit code N`.
	const claude = output?.match(/^Exit code (\d+)\r?\n/);
	return claude ? Number(claude[1]) : null;
}
export function mapTool(tool: ACP.ToolCallUpdate): ToolPatch {
	const name = toolName(tool._meta);
	const output =
		typeof tool.rawOutput === 'string'
			? tool.rawOutput
			: isRecord(tool.rawOutput) && typeof tool.rawOutput.formatted_output === 'string'
				? tool.rawOutput.formatted_output
				: null;
	const exit = exitCode(tool, output);
	return {
		id: tool.toolCallId,
		...(name ? { name } : {}),
		...(tool.title != null ? { title: tool.title } : {}),
		...(tool.kind != null ? { category: tool.kind } : {}),
		...(exit !== null && exit !== 0
			? { status: 'failed' }
			: tool.status != null
				? { status: tool.status }
				: {}),
		...(tool.rawInput !== undefined ? { input: JSON.stringify(tool.rawInput) } : {}),
		...(output !== null ? { output } : {}),
		...(exit !== null ? { exitCode: exit } : {}),
		...(tool.content != null ? { content: tool.content.map(mapToolContent) } : {}),
		...(tool.locations != null
			? {
					locations: tool.locations.map((location) => ({
						path: location.path,
						line: location.line ?? null,
					})),
				}
			: {}),
		...(parentToolUseId(tool._meta) ? { parentId: parentToolUseId(tool._meta)! } : {}),
	};
}
export function mapOptions(options: ACP.SessionConfigOption[]): AgentOption[] {
	return options.map((option) => {
		const base = {
			id: option.id,
			name: option.name,
			description: option.description ?? null,
			category: option.category ?? null,
		};
		if (option.type === 'boolean') return { ...base, kind: 'boolean', value: option.currentValue };
		return {
			...base,
			kind: 'select',
			value: option.currentValue,
			choices: option.options.flatMap<Extract<AgentOption, { kind: 'select' }>['choices'][number]>(
				(choice) =>
					'group' in choice
						? choice.options.map((item) => ({
								value: item.value,
								name: item.name,
								description: item.description ?? null,
								group: choice.name,
							}))
						: [
								{
									value: choice.value,
									name: choice.name,
									description: choice.description ?? null,
									group: null,
								},
							]
			),
		};
	});
}
export function mapSession(session: ACP.NewSessionResponse): AgentEvent {
	return {
		kind: 'session.started',
		sessionId: session.sessionId,
		modes:
			session.modes?.availableModes.map((mode) => ({
				id: mode.id,
				name: mode.name,
				description: mode.description ?? null,
			})) ?? [],
		modeId: session.modes?.currentModeId ?? null,
		options: mapOptions(session.configOptions ?? []),
	};
}
export function mapPermission(id: string, params: ACP.RequestPermissionRequest): PermissionRequest {
	return {
		id,
		tool: mapTool(params.toolCall),
		options: params.options.map((option) => ({
			id: option.optionId,
			name: option.name,
			kind: option.kind,
		})),
	};
}
export function mapUpdate(update: ACP.SessionUpdate): AgentEvent {
	switch (update.sessionUpdate) {
		case 'agent_message_chunk':
		case 'agent_thought_chunk':
		case 'user_message_chunk':
			return {
				kind: 'message.delta',
				role:
					update.sessionUpdate === 'user_message_chunk'
						? 'user'
						: update.sessionUpdate === 'agent_thought_chunk'
							? 'thought'
							: 'assistant',
				messageId: update.messageId ?? null,
				content: mapContent(update.content),
				// spec/chat#subagents: without subagent sessions Claude still marks a subagent's text with the tool call that runs it.
				...(parentToolUseId(update._meta) ? { parentId: parentToolUseId(update._meta)! } : {}),
			};
		case 'tool_call':
		case 'tool_call_update':
			return { kind: 'tool.changed', patch: mapTool(update) };
		case 'plan':
			return {
				kind: 'plan.changed',
				entries: update.entries.map((entry) => ({
					text: entry.content,
					priority: entry.priority,
					status: entry.status,
				})),
			};
		// spec/chat-turns-plans-and-questions#plan-approval: only the markdown form is shown; `items` and `file` stay unhandled for now.
		case 'plan_update':
			return update.plan.type === 'markdown'
				? { kind: 'plan.document', planId: update.plan.planId, text: update.plan.content }
				: { kind: 'unhandled', name: `plan_update:${update.plan.type}` };
		case 'plan_removed':
			return { kind: 'plan.removed', planId: update.planId };
		case 'config_option_update':
			return { kind: 'options.changed', options: mapOptions(update.configOptions) };
		case 'current_mode_update':
			return { kind: 'mode.changed', modeId: update.currentModeId };
		case 'available_commands_update':
			return {
				kind: 'commands.changed',
				commands: update.availableCommands.map((command) => ({
					name: command.name,
					description: command.description,
					inputHint: command.input?.hint ?? null,
				})),
			};
		case 'usage_update':
			return {
				kind: 'usage.changed',
				used: update.used,
				capacity: update.size,
				cost: update.cost ? { amount: update.cost.amount, currency: update.cost.currency } : null,
			};
		case 'session_info_update':
			return {
				kind: 'session.info',
				...(update.title != null ? { title: update.title } : {}),
				...(update.updatedAt != null ? { updatedAt: update.updatedAt } : {}),
			};
		default:
			return { kind: 'unhandled', name: update.sessionUpdate };
	}
}

/** Claude ACP extension, observed by the v1 probe; never inferred from context usage. */
export function mapRateLimit(
	update: ACP.SessionUpdate
): Extract<AgentEvent, { kind: 'rate-limit.changed' }> | null {
	if (update.sessionUpdate !== 'usage_update') return null;
	const meta = update._meta;
	return mapRateLimitInfo(isRecord(meta) ? meta['_claude/rateLimit'] : null);
}
/** The same payload arrives as `usage_update._meta["_claude/rateLimit"]` and as the raw SDK `rate_limit_info`. */
export function mapRateLimitInfo(
	limit: unknown
): Extract<AgentEvent, { kind: 'rate-limit.changed' }> | null {
	if (
		!isRecord(limit) ||
		!['allowed', 'allowed_warning', 'rejected'].includes(String(limit.status))
	)
		return null;
	return {
		kind: 'rate-limit.changed',
		status: limit.status as 'allowed' | 'allowed_warning' | 'rejected',
		window: typeof limit.rateLimitType === 'string' ? limit.rateLimitType : null,
		resetsAt:
			typeof limit.resetsAt === 'number' &&
			Number.isFinite(limit.resetsAt) &&
			limit.resetsAt >= 0 &&
			limit.resetsAt <= 8_640_000_000_000
				? limit.resetsAt
				: null,
	};
}
/** spec/chat#subagents: the result of the tool call that ran a subagent — the subagent session it names (`agentId`) and the type, model, tokens and
 *  run time Claude reports in `_meta.claudeCode.toolResponse`. Null for any other update. Nothing is computed here. */
export function subagentResult(update: ACP.SessionUpdate): {
	agentId: string;
	toolId: string;
	type?: string;
	model?: string;
	tokens?: number;
	durationMs?: number;
} | null {
	if (update.sessionUpdate !== 'tool_call' && update.sessionUpdate !== 'tool_call_update')
		return null;
	const claude =
			isRecord(update._meta) && isRecord(update._meta.claudeCode) ? update._meta.claudeCode : null,
		response = claude && isRecord(claude.toolResponse) ? claude.toolResponse : null;
	if (!response || typeof response.agentId !== 'string' || !response.agentId) return null;
	const count = (value: unknown) =>
		typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : undefined;
	const model =
			typeof response.resolvedModel === 'string' && response.resolvedModel
				? response.resolvedModel
				: undefined,
		tokens = count(response.totalTokens),
		durationMs = count(response.totalDurationMs);
	const type =
		typeof response.agentType === 'string' && response.agentType ? response.agentType : undefined;
	return {
		agentId: response.agentId,
		toolId: update.toolCallId,
		...(type ? { type } : {}),
		...(model ? { model } : {}),
		...(tokens !== undefined ? { tokens } : {}),
		...(durationMs !== undefined ? { durationMs } : {}),
	};
}
/** spec/chat#subagents: ACP `subagent_spawned` / `subagent_state_update`, which the SDK schema does not know yet; read from the raw notification. */
export function mapSubagentUpdate(
	update: unknown,
	sessionId: string,
	root: string
): Extract<AgentEvent, { kind: 'subagent.started' | 'subagent.changed' }> | null {
	if (
		!isRecord(update) ||
		typeof update.subagentSessionId !== 'string' ||
		!update.subagentSessionId
	)
		return null;
	const id = update.subagentSessionId,
		text = (value: unknown) => (typeof value === 'string' && value.trim() ? value : null);
	if (update.sessionUpdate === 'subagent_spawned')
		return {
			kind: 'subagent.started',
			id,
			parentId: sessionId === root ? null : sessionId,
			name: text(update.name) ?? text(update.task)?.split('\n')[0]!.slice(0, 120) ?? id,
			prompt: text(update.prompt) ?? text(update.task),
		};
	if (
		update.sessionUpdate === 'subagent_state_update' &&
		(update.state === 'completed' || update.state === 'failed' || update.state === 'cancelled')
	)
		return { kind: 'subagent.changed', id, state: update.state };
	return null;
}
