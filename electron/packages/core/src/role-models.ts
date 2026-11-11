import { selectOption } from './agent-options';
import {
	designerTemplateId,
	developerTemplateId,
	foremanTemplateId,
	reviewerTemplateId,
	securityReviewerTemplateId,
	seniorDeveloperTemplateId,
	technicalWriterTemplateId,
	testerTemplateId,
	type ProviderCatalog,
} from './crew';
import type { AgentProviderId } from './settings';
/**
 * spec/crew-templates-and-editor#library-list: the model each provider has for the work of a built-in role, as a word. The model shown is the
 * catalog entry whose value or name says the word, under the catalog's own name — like `ghostDefaults`, the word is ours and the entry is
 * the provider's (rule 7). The guide only shows it; no template takes its model from here.
 */
export const roleModelWords: Readonly<Record<string, Readonly<Record<AgentProviderId, string>>>> = {
	[foremanTemplateId]: { claude: 'fable', codex: 'astra' },
	[developerTemplateId]: { claude: 'sonnet', codex: 'terra' },
	[seniorDeveloperTemplateId]: { claude: 'opus', codex: 'sol' },
	[reviewerTemplateId]: { claude: 'opus', codex: 'astra' },
	[testerTemplateId]: { claude: 'sonnet', codex: 'terra' },
	[technicalWriterTemplateId]: { claude: 'sonnet', codex: 'terra' },
	[designerTemplateId]: { claude: 'opus', codex: 'astra' },
	[securityReviewerTemplateId]: { claude: 'opus', codex: 'sol' },
};
/**
 * The name to show for a role and a provider: the catalog's name of the first entry that says the word; the word itself while the
 * catalog is not known; null when the role has no word or a known catalog has no such entry.
 */
export function roleModelPick(
	templateId: string,
	provider: AgentProviderId,
	catalog: Pick<ProviderCatalog, 'options'> | null | undefined
): string | null {
	const word = roleModelWords[templateId]?.[provider];
	if (!word) return null;
	if (!catalog) return word[0]!.toUpperCase() + word.slice(1);
	const says = new RegExp(`(^|[^a-z])${word}([^a-z]|$)`, 'i');
	return (
		selectOption(catalog.options, 'model')?.choices.find(
			(choice) => says.test(choice.value) || says.test(choice.name)
		)?.name ?? null
	);
}
