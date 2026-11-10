import { isRecord } from '@brigadir/core';
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
