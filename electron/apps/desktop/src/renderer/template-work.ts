import {
	designerTemplateId,
	developerTemplateId,
	foremanTemplateId,
	reviewerTemplateId,
	securityReviewerTemplateId,
	seniorDeveloperTemplateId,
	technicalWriterTemplateId,
	testerTemplateId,
	t,
	type AgentTemplate,
	type Locale,
	type MessageKey,
} from '@brigadir/core';

const builtinWork: Readonly<Record<string, MessageKey>> = {
	[foremanTemplateId]: 'Splits the work, accepts the parts',
	[developerTemplateId]: 'Parts with a clear spec',
	[seniorDeveloperTemplateId]: 'Migrations, refactors, unclear specs',
	[reviewerTemplateId]: 'Checks the work, writes no code',
	[testerTemplateId]: 'Writes tests, changes no production code',
	[technicalWriterTemplateId]: 'Writes docs, changes no behaviour',
	[designerTemplateId]: 'Checks screens in the running app',
	[securityReviewerTemplateId]: 'Looks for security defects in changes',
};
/**
 * spec/crew-templates-and-editor#agent-cards: one line on what a template does, for its card and its row in the `@` menu — the role
 * guide's line for a built-in, an own template's specialty, else what its rights allow.
 */
export function templateWork(
	locale: Locale,
	template: Pick<AgentTemplate, 'id' | 'builtin' | 'summary' | 'role'>
): string {
	const guide = template.builtin ? builtinWork[template.id] : undefined;
	return guide
		? t(locale, guide)
		: template.summary?.trim() ||
				t(
					locale,
					template.role === 'foreman'
						? 'Splits the work, accepts the parts'
						: template.role === 'reviewer'
							? 'Checks the work, writes no code'
							: 'Writes code'
				);
}
