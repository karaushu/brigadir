import { defaultCompactionWindow, isCompactionWindow, isRecord } from '@brigadir/core';
import { readDocument, safePath } from '@brigadir/persistence';
/**
 * spec/agents-and-providers#subagent-model: `agents.claudeSubagentModel` from the app's `settings.json`, read when an agent starts, the way
 * `modules.ts` reads the modules. A missing or unreadable file, or no choice, means the session's own model.
 */
export async function claudeSubagentModel(root: string): Promise<string | null> {
	try {
		const doc = await readDocument(await safePath(root, 'settings.json'));
		const agents = isRecord(doc.settings) ? doc.settings.agents : null;
		const value = isRecord(agents) ? agents.claudeSubagentModel : null;
		return typeof value === 'string' && value && value.length <= 200 && !/[\0\r\n]/.test(value)
			? value
			: null;
	} catch {
		return null;
	}
}
/**
 * spec/agents-and-providers#compaction-window: `agents.compactionWindow` from the app's `settings.json`, read when an agent starts. A missing
 * file or key reads as the default window; an explicit null (the agent's default) or an invalid value passes nothing.
 */
export async function compactionWindow(root: string): Promise<number | null> {
	let agents: unknown;
	try {
		const doc = await readDocument(await safePath(root, 'settings.json'));
		agents = isRecord(doc.settings) ? doc.settings.agents : undefined;
	} catch {
		return defaultCompactionWindow;
	}
	if (!isRecord(agents) || !('compactionWindow' in agents)) return defaultCompactionWindow;
	return isCompactionWindow(agents.compactionWindow) ? agents.compactionWindow : null;
}
