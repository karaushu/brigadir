import {
	crewName,
	isRecord,
	normalizeZonePath,
	type CrewPlan,
	type CrewPlanPart,
} from '@brigadir/core';
export type PlanInput = { summary?: unknown; parts?: unknown; crew?: unknown };
/** `propose_plan` arguments become a CrewPlan; malformed input is a tool error, not a card (spec/crew#task-type, spec/crew#workers). */
export function parsePlan(input: unknown, newId: () => string): CrewPlan {
	if (!isRecord(input) || !Array.isArray(input.parts) || !input.parts.length)
		throw new Error('propose_plan needs a non-empty parts array');
	if (input.parts.length > 64) throw new Error('A plan has at most 64 parts');
	const parts: CrewPlanPart[] = input.parts.map((part, index) => {
		if (!isRecord(part)) throw new Error(`Part ${index + 1} must be an object`);
		const title = typeof part.title === 'string' ? crewName(part.title).slice(0, 80) : '';
		if (!title) throw new Error(`Part ${index + 1} needs a title`);
		const agent = typeof part.agent === 'string' ? crewName(part.agent) : '';
		if (!agent) throw new Error(`Part ${index + 1} needs an agent name`);
		const prompt = typeof part.prompt === 'string' ? part.prompt : '';
		if (!prompt.trim()) throw new Error(`Part ${index + 1} needs a prompt`);
		if (prompt.length > 100_000) throw new Error(`Part ${index + 1} prompt is too long`);
		const files = Array.isArray(part.files) ? part.files : [];
		if (files.length > 1024) throw new Error(`Part ${index + 1} lists too many files`);
		const normalized = files.map((file) =>
			typeof file === 'string' ? normalizeZonePath(file) : null
		);
		if (normalized.some((file) => file === null))
			throw new Error(`Part ${index + 1} has an invalid file path`);
		const scopes = Array.isArray(part.scopes)
			? part.scopes.filter(
					(scope): scope is string => typeof scope === 'string' && scope.length <= 4096
				)
			: [];
		return {
			id: newId(),
			title,
			agent,
			prompt,
			files: [...new Set(normalized as string[])],
			scopes,
		};
	});
	return {
		id: newId(),
		parts,
		summary: typeof input.summary === 'string' ? input.summary.slice(0, 20_000) : '',
	};
}
export { planDifferences, planBlocked } from '@brigadir/core';
