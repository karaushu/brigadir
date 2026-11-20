import { expect, it, vi } from 'vitest';
import { defaultTypography, type WorkspaceSnapshot } from '@brigadir/core';
import { useWorkspace } from './store';
it('does not replace current task status with an older workspace read that finishes after a host died', async () => {
	let finish!: (snapshot: WorkspaceSnapshot) => void;
	const old = new Promise<WorkspaceSnapshot>((resolve) => {
		finish = resolve;
	});
	const task = { id: 'task', projectId: 'project', title: 'Task', status: 'done' as const };
	const current = { projects: [], tasks: [task], issues: [] };
	vi.stubGlobal('window', {
		brigadir: {
			readWorkspace: vi.fn().mockReturnValueOnce(old).mockResolvedValue(current),
			readAppearance: async () => ({
				dark: false,
				accent: '',
				locale: 'en',
				toolbarLabels: 'icons',
				interfaceFont: { family: null, size: 13 },
				typography: defaultTypography,
				fonts: null,
				missingFonts: [],
			}),
		},
	});
	try {
		const stale = useWorkspace.getState().load();
		await useWorkspace.getState().load();
		finish({
			projects: [],
			tasks: [
				{ ...task, status: 'queued', blockedBy: [{ projectId: 'project', id: 'dead-owner' }] },
			],
			issues: [],
		});
		await stale;
		expect(useWorkspace.getState().workspace?.tasks[0]?.status).toBe('done');
		expect(useWorkspace.getState().workspace?.tasks[0]?.blockedBy).toBeUndefined();
	} finally {
		vi.unstubAllGlobals();
	}
});
it('keeps an appearance published while a workspace read was on its way (spec/appearance#theme)', async () => {
	const appearance = {
		dark: false,
		accent: '',
		locale: 'en' as const,
		toolbarLabels: 'icons' as const,
		interfaceFont: { family: null, size: 13 },
		typography: defaultTypography,
		fonts: null,
		missingFonts: [],
	};
	let finish!: (value: typeof appearance) => void;
	const slow = new Promise<typeof appearance>((resolve) => {
		finish = resolve;
	});
	vi.stubGlobal('window', {
		brigadir: {
			readWorkspace: async () => ({ projects: [], tasks: [], issues: [] }),
			readAppearance: vi.fn().mockReturnValueOnce(slow).mockResolvedValue(appearance),
		},
	});
	try {
		const reading = useWorkspace.getState().load();
		// Main publishes the dark theme while the read still holds the light one.
		useWorkspace.getState().setAppearance({ ...appearance, dark: true } as never);
		finish(appearance);
		await reading;
		expect(useWorkspace.getState().appearance.dark).toBe(true);
		// A read that begins after it takes main's value again.
		await useWorkspace.getState().load();
		expect(useWorkspace.getState().appearance.dark).toBe(false);
	} finally {
		vi.unstubAllGlobals();
	}
});
