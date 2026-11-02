import { isRecord } from '@brigadir/core';
export type CliHook = { sessionId: string; turnId?: string } & (
	| { kind: 'session' }
	| { kind: 'prompt'; text: string }
	| { kind: 'stop'; cancelled: boolean }
	| { kind: 'end' }
	| { kind: 'tool'; id: string; name: string; status: 'in_progress' | 'completed' | 'failed' }
);
export function cliHook(value: unknown): CliHook | null {
	if (
		!isRecord(value) ||
		typeof value.session_id !== 'string' ||
		!/^[A-Za-z0-9_-]{1,200}$/.test(value.session_id)
	)
		throw new Error('Invalid CLI hook');
	if (typeof value.agent_id === 'string' && value.agent_id) return null;
	const common = {
		sessionId: value.session_id,
		...(typeof value.turn_id === 'string' ? { turnId: value.turn_id.slice(0, 200) } : {}),
	};
	switch (value.hook_event_name) {
		case 'SessionStart':
			return { ...common, kind: 'session' };
		case 'UserPromptSubmit':
			if (typeof value.prompt !== 'string') throw new Error('Missing prompt');
			return { ...common, kind: 'prompt', text: value.prompt.split(/\r?\n/, 1)[0]!.slice(0, 500) };
		case 'Stop':
		case 'Interrupt':
			return { ...common, kind: 'stop', cancelled: value.hook_event_name === 'Interrupt' };
		case 'SessionEnd':
			return { ...common, kind: 'end' };
		case 'PreToolUse':
		case 'PostToolUse':
		case 'PostToolUseFailure':
			if (
				typeof value.tool_use_id !== 'string' ||
				!value.tool_use_id ||
				typeof value.tool_name !== 'string'
			)
				throw new Error('Invalid CLI tool');
			return {
				...common,
				kind: 'tool',
				id: value.tool_use_id.slice(0, 200),
				name: value.tool_name.slice(0, 200),
				status:
					value.hook_event_name === 'PreToolUse'
						? 'in_progress'
						: value.hook_event_name === 'PostToolUse'
							? 'completed'
							: 'failed',
			};
		default:
			return null;
	}
}
