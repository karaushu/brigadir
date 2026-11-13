import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { starterCrewTemplate } from '../../packages/core/src/crew';
/** spec/crew-templates-and-editor#builtin-templates: the app ships no crew of developers, so a spec that needs one seeds a crew of the person's
 *  own: `Crew`, Foreman → `Developer 1`, `Developer 2`, `Reviewer` checking both. */
export const ownCrew = { ...starterCrewTemplate, id: 'two-developers', name: 'Crew', builtin: false };
export async function seedOwnCrew(data: string) {
	const dir = join(data, 'templates', 'crews');
	await mkdir(dir, { recursive: true });
	await writeFile(
		join(dir, `${ownCrew.id}.json`),
		JSON.stringify({ schemaVersion: 1, template: ownCrew })
	);
}
