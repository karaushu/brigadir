import { lstat, readdir, readFile, realpath } from 'node:fs/promises';
import { join, relative, sep } from 'node:path';
import {
	isRepoIconPath,
	projectColors,
	projectImagePrompt,
	projectIconColorAt,
	projectIconFromAnswer,
	projectIconPrompt,
	type Project,
	type ProjectIcon,
	type ProjectIconColor,
	type RepoIconCandidate,
	type WorkspaceSnapshot,
} from '@brigadir/core';
import { atomicJson, atomicText, safePath, SessionStore } from '@brigadir/persistence';
import lucideTags from '../renderer/lucide/tags.json';

/** Every Lucide name (spec/appearance#evolution-redesign): a name outside the set gives the monogram. */
export const lucideNames: ReadonlySet<string> = new Set(Object.keys(lucideTags));
type Dependencies = {
	dataDir?: string;
	/** The hint model's one-shot answer; null — no hint model (provider off, quota exhausted). */
	write(prompt: string, signal: AbortSignal): Promise<string | null>;
	/** The workspace changed for this project: the sidebar reads it again. */
	changed(projectId: string): void;
	/** A PNG of the image, `size` px square, as a data URL; null when it is not an image. */
	thumbnail(path: string, size: number): string | null;
	/** spec/projects-and-board#project-icon: image bytes as `icon.png` (square, at most 512 px) and its 72 px data URL; null — not an image. */
	normalize(bytes: Uint8Array): { png: Buffer; image: string } | null;
	/** spec/projects-and-board#project-icon: one image from Codex; null — Codex is off, missing or out of quota. */
	draw?(prompt: string, signal: AbortSignal): Promise<Buffer | null>;
};
/** First line of the README and `description` of package.json: what the agent reads besides the name. */
async function projectSource(path: string) {
	const text = (name: string) => readFile(join(path, name), 'utf8').catch(() => '');
	let description = '';
	try {
		const value = JSON.parse(await text('package.json')) as unknown;
		if (value && typeof value === 'object' && 'description' in value)
			description = String((value as { description: unknown }).description ?? '');
	} catch {}
	let readme = '';
	for (const name of ['README.md', 'readme.md', 'README', 'Readme.md']) {
		readme = await text(name);
		if (readme) break;
	}
	const line =
		readme
			.split('\n')
			.map((item) => item.replace(/^[#>\s*-]+/, '').trim())
			.find(
				(item) => item && !item.startsWith('<') && !item.startsWith('![') && !item.startsWith('[!')
			) ?? '';
	return { description: description.slice(0, 600), readme: line.slice(0, 300) };
}
/** «From repo»: the usual places of an app icon (Expo, React Native, web, Electron, Tauri), apps of a monorepo one level down. */
const iconPlaces: { path: string; kind: RepoIconCandidate['kind'] }[] = [
	{ path: 'assets/icon.png', kind: 'app' },
	{ path: 'assets/images/icon.png', kind: 'app' },
	{ path: 'assets/app-icon.png', kind: 'app' },
	{ path: 'assets/adaptive-icon.png', kind: 'adaptive' },
	{ path: 'assets/images/adaptive-icon.png', kind: 'adaptive' },
	{ path: 'android/app/src/main/res/mipmap-xxxhdpi/ic_launcher.png', kind: 'app' },
	{ path: 'build/icon.png', kind: 'app' },
	{ path: 'resources/icon.png', kind: 'app' },
	{ path: 'src-tauri/icons/icon.png', kind: 'app' },
	{ path: 'icon.png', kind: 'app' },
	{ path: 'public/apple-touch-icon.png', kind: 'favicon' },
	{ path: 'public/favicon.png', kind: 'favicon' },
	{ path: 'public/icon.png', kind: 'app' },
	{ path: 'public/logo512.png', kind: 'logo' },
	{ path: 'public/logo192.png', kind: 'logo' },
	{ path: 'static/favicon.png', kind: 'favicon' },
	{ path: 'src/app/icon.png', kind: 'app' },
	{ path: 'app/icon.png', kind: 'app' },
	{ path: 'logo.png', kind: 'logo' },
];
const candidateLimit = 8;
/**
 * spec/appearance#evolution-redesign: the agent picks the project's icon once, when the project is added (and once for a project that never had
 * one); «Pick again» in the picker asks again. While it thinks, the snapshot says `iconPicking`.
 */
export class ProjectIcons {
	private picking = new Map<string, Promise<'picked' | 'failed' | 'off'>>();
	private drawing = new Map<string, Promise<'generated' | 'failed' | 'off'>>();
	private stopDrawing = new AbortController();
	/** Background picks for a project that keeps its icon: the sidebar does not say «Picking an icon…» for them. */
	private quiet = new Set<string>();
	constructor(private dependencies: Dependencies) {}
	decorate(workspace: WorkspaceSnapshot) {
		for (const project of workspace.projects)
			if (this.picking.has(project.id) && !this.quiet.has(project.id)) project.iconPicking = true;
		return workspace;
	}
	/**
	 * Every project has the agent's pick — one each, one at a time, in the background. A project
	 * whose icon the person chose (or took from the repo) keeps it: only the pick, its reason and suggestions are written.
	 * A project the agent answered for is not asked again (`project-icon-asks.json`, also when the answer was outside the
	 * set); without a hint model or on an error it waits for the next start.
	 */
	async pickMissing(projects: readonly Project[]) {
		const colors = projectColors(projects.map((project) => project.id)),
			asked = await this.asked();
		for (const project of projects)
			if (!project.iconPick && !asked.has(project.id)) {
				if (project.icon && !this.picking.has(project.id)) this.quiet.add(project.id);
				await this.pick(project.id, projectIconColorAt(colors.get(project.id) ?? 0), true);
			}
	}
	private async asksPath() {
		return join((await SessionStore.at(this.dependencies.dataDir)).root, 'project-icon-asks.json');
	}
	private async asked(): Promise<Set<string>> {
		try {
			const value = JSON.parse(await readFile(await this.asksPath(), 'utf8')) as {
				asked?: unknown;
			};
			return new Set(
				Array.isArray(value.asked) ? value.asked.filter((id) => typeof id === 'string') : []
			);
		} catch {
			return new Set();
		}
	}
	private async markAsked(projectId: string) {
		const asked = await this.asked();
		if (asked.has(projectId)) return;
		asked.add(projectId);
		await atomicJson(await this.asksPath(), { schemaVersion: 1, asked: [...asked].sort() }).catch(
			() => {}
		);
	}
	/**
	 * `fallback` — the first pick: when it gives nothing, the monogram in this colour, so it is not asked at every start.
	 * `background` — the start's pick: it never replaces an icon that is already there.
	 */
	pick(
		projectId: string,
		fallback?: ProjectIconColor,
		background = false
	): Promise<'picked' | 'failed' | 'off'> {
		const running = this.picking.get(projectId);
		if (running) return running;
		const controller = new AbortController(),
			timer = setTimeout(() => controller.abort(), 30_000);
		const work = (async (): Promise<'picked' | 'failed' | 'off'> => {
			const store = await SessionStore.at(this.dependencies.dataDir);
			const project = await store.project(projectId);
			const source = await projectSource(project.path);
			const answer = await this.dependencies
				.write(projectIconPrompt({ name: project.name, ...source }), controller.signal)
				.catch(() => '');
			if (answer === null) return 'off';
			// An error or an empty answer is not an answer: nothing is written, the next start asks again.
			if (!answer.trim()) return 'failed';
			const pick = projectIconFromAnswer(answer, lucideNames);
			const current = await store.project(projectId);
			if (background) await this.markAsked(projectId);
			if (!pick) {
				if (fallback && !current.icon)
					await store.setProjectIcon(projectId, { icon: { kind: 'monogram', color: fallback } });
				return 'failed';
			}
			await store.setProjectIcon(
				projectId,
				background && current.icon
					? { iconPick: pick }
					: {
							icon: { kind: 'lucide', name: pick.name, color: pick.color, by: 'agent' },
							iconPick: pick,
						}
			);
			return 'picked';
		})()
			.catch(() => 'failed' as const)
			.finally(() => {
				clearTimeout(timer);
				this.picking.delete(projectId);
				this.quiet.delete(projectId);
				this.dependencies.changed(projectId);
			});
		this.picking.set(projectId, work);
		this.dependencies.changed(projectId);
		return work;
	}
	cancelAll() {
		this.picking.clear();
		this.drawing.clear();
		this.stopDrawing.abort();
		this.stopDrawing = new AbortController();
	}
	/** spec/projects-and-board#project-icon: the project's own image, next to its `project.json`. */
	private async imagePath(projectId: string) {
		const store = await SessionStore.at(this.dependencies.dataDir);
		await store.project(projectId);
		return safePath(store.root, 'projects', projectId, 'icon.png');
	}
	/** The person's image (or Codex's): kept as `icon.png` and shown at once. */
	async setImage(projectId: string, bytes: Uint8Array, by: 'agent' | 'person' = 'person') {
		const made = this.dependencies.normalize(bytes);
		if (!made) throw new Error('The file is not an image');
		const store = await SessionStore.at(this.dependencies.dataDir),
			current = await store.project(projectId);
		await atomicText(await this.imagePath(projectId), made.png);
		const color = current.icon?.color ?? 'blue';
		const project = await store.setProjectIcon(projectId, {
			icon: { kind: 'image', image: made.image, color, by },
		});
		this.dependencies.changed(projectId);
		return project;
	}
	/** «Your image»: `icon.png` as 72 px, also while another icon is chosen. */
	async readImage(projectId: string): Promise<string | null> {
		try {
			const path = await this.imagePath(projectId),
				info = await lstat(path);
			return info.isFile() ? this.dependencies.thumbnail(path, 72) : null;
		} catch {
			return null;
		}
	}
	/** spec/projects-and-board#project-icon: Codex draws the icon from the project's name, description and README line and the person's hint. */
	generate(projectId: string, hint: string): Promise<'generated' | 'failed' | 'off'> {
		const running = this.drawing.get(projectId);
		if (running) return running;
		const signal = this.stopDrawing.signal;
		const work = (async (): Promise<'generated' | 'failed' | 'off'> => {
			if (!this.dependencies.draw) return 'off';
			const store = await SessionStore.at(this.dependencies.dataDir),
				project = await store.project(projectId),
				source = await projectSource(project.path);
			const image = await this.dependencies.draw(
				projectImagePrompt({ name: project.name, ...source, hint }),
				signal
			);
			if (!image) return 'off';
			await this.setImage(projectId, image, 'agent');
			return 'generated';
		})()
			.catch(() => 'failed' as const)
			.finally(() => {
				this.drawing.delete(projectId);
				this.dependencies.changed(projectId);
			});
		this.drawing.set(projectId, work);
		this.dependencies.changed(projectId);
		return work;
	}
	/** The app icons in the repo, each a 72 px PNG (shown at 36). */
	async candidates(projectId: string): Promise<RepoIconCandidate[]> {
		const store = await SessionStore.at(this.dependencies.dataDir),
			root = await realpath((await store.project(projectId)).path);
		const roots = [''];
		for (const group of ['apps', 'packages']) {
			const entries = await readdir(join(root, group), { withFileTypes: true }).catch(() => []);
			for (const entry of entries.slice(0, 24))
				if (entry.isDirectory() && !entry.name.startsWith('.'))
					roots.push(`${group}/${entry.name}/`);
		}
		const found: RepoIconCandidate[] = [];
		for (const base of roots)
			for (const place of iconPlaces) {
				if (found.length >= candidateLimit) return found;
				const path = base + place.path,
					image = await this.image(root, path, 72);
				if (image) found.push({ path, kind: place.kind, image });
			}
		return found;
	}
	/** The image of a repo path, only inside the repo and only a regular file under 8 MB. */
	async image(root: string, path: string, size: number): Promise<string | null> {
		if (!isRepoIconPath(path)) return null;
		const full = join(root, ...path.split('/'));
		try {
			const real = await realpath(full),
				inside = relative(root, real);
			if (inside.startsWith('..') || inside.startsWith(sep)) return null;
			const stat = await lstat(real);
			if (!stat.isFile() || stat.size > 8 * 1024 * 1024) return null;
			return this.dependencies.thumbnail(real, size);
		} catch {
			return null;
		}
	}
	/** The person's choice in the picker; the sidebar reads it again at once. */
	async set(projectId: string, icon: ProjectIcon | null) {
		const store = await SessionStore.at(this.dependencies.dataDir),
			project = await store.setProjectIcon(projectId, { icon });
		this.dependencies.changed(projectId);
		return project;
	}
	async setRepo(projectId: string, path: string, color: ProjectIconColor) {
		const store = await SessionStore.at(this.dependencies.dataDir),
			root = await realpath((await store.project(projectId)).path),
			image = await this.image(root, path, 72);
		if (!image) throw new Error('The icon is not in the repo');
		const project = await store.setProjectIcon(projectId, {
			icon: { kind: 'repo', path, image, color },
		});
		this.dependencies.changed(projectId);
		return project;
	}
}
