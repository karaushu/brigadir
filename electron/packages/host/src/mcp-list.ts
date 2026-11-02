import type { AppModules } from '@brigadir/core';
import { crewProcessRole, type CrewProcessRole } from '@brigadir/orchestrator';
import { mcpTools } from './mcp';
export { crewProcessRole, type CrewProcessRole };
/**
 * spec/composer#slash-menu: the tools our MCP server gives a task — the same list the agent reads at `tools/list` — for the `/` menu
 * in the app, without a running host. Names and descriptions only.
 */
export function brigadirToolList(
	role: CrewProcessRole | null,
	modules: AppModules,
	review: boolean
): { name: string; description: string }[] {
	return [...mcpTools(role, modules, review).tools.values()].map((tool) => ({
		name: tool.name,
		description: tool.description,
	}));
}
