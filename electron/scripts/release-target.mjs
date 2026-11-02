// spec/architecture-and-platform#auto-update: `node scripts/release-target.mjs v<version>` — before CI publishes a tag, checks that the tag is the
// version of apps/desktop/package.json and that `releases` names the real releases repository, not the placeholder. Prints
// `repo=<owner>/<repo>` for $GITHUB_OUTPUT. Needs no installed dependencies.
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { releasesRepo, workspace } from '../packaging/electron-builder.config.mjs';

const tag = process.argv[2] ?? '';
try {
	const { version } = JSON.parse(
		readFileSync(join(workspace, 'apps/desktop/package.json'), 'utf8')
	);
	if (tag !== `v${version}`)
		throw new Error(
			`The tag ${JSON.stringify(tag)} is not v${version}, the version of apps/desktop/package.json. Tag the chore(release) commit that sets the version.`
		);
	const { owner, repo } = releasesRepo({ publishing: true });
	console.log(`repo=${owner}/${repo}`);
} catch (error) {
	console.error(error instanceof Error ? error.message : String(error));
	process.exit(1);
}
