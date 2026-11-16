import {
	crewAgentRole,
	crewAgents,
	templateLookup,
	type CrewLibrary,
	type CrewTemplate,
} from '@brigadir/core';
/**
 * spec/pull-requests-and-ci#review-crew: the review dialog's `Who` lists only crews of reviewers — a crew whose every agent below the root reads
 * and writes no code. A crew with developers or leads is a crew for a task, picked on the New task sheet.
 */
export function reviewerCrews(library: Pick<CrewLibrary, 'agents' | 'crews'>): CrewTemplate[] {
	const lookup = templateLookup(library.agents);
	return library.crews.filter((crew) => {
		const members = crewAgents(crew.root).filter((agent) => agent !== crew.root);
		return (
			members.length > 0 && members.every((agent) => crewAgentRole(agent, lookup) === 'reviewer')
		);
	});
}
