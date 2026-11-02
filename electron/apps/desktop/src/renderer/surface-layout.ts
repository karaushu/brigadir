import { create } from 'zustand';
import {
	defaultSurfaceLayout,
	layoutLimits,
	type SidebarSection,
	type SurfaceLayout,
	type SurfaceToggle,
} from '@brigadir/core';
let loaded: Promise<void> | undefined;
let edited = false;
export const useSurfaceLayout = create<{
	layout: SurfaceLayout;
	error: boolean;
	load(): Promise<void>;
	resize(key: keyof typeof layoutLimits, value: number): void;
	toggle(key: SurfaceToggle): void;
	/** spec/sidebar#section-rail: the rail's section, saved at once like a toggle. */ setSection(
		section: SidebarSection
	): void;
	save(): void;
}>((set, get) => ({
	layout: { ...defaultSurfaceLayout },
	error: false,
	load() {
		return (loaded ??= window.brigadir.readSurfaceLayout().then(
			(layout) => {
				if (!edited) set({ layout });
			},
			() => {
				set({ error: true });
			}
		));
	},
	resize(key, value) {
		edited = true;
		const [min, max] = layoutLimits[key];
		set((state) => ({
			layout: { ...state.layout, [key]: Math.max(min, Math.min(max, Math.round(value))) },
		}));
	},
	/** spec/git#commit-strip: a collapse toggle is saved at once — it has no drag to wait for. */
	toggle(key) {
		edited = true;
		set((state) => ({ layout: { ...state.layout, [key]: !state.layout[key] } }));
		get().save();
	},
	setSection(section) {
		edited = true;
		set((state) => ({ layout: { ...state.layout, sidebarSection: section } }));
		get().save();
	},
	save() {
		void window.brigadir.saveSurfaceLayout(get().layout).then(
			() => set({ error: false }),
			() => set({ error: true })
		);
	},
}));
