/**
 * spec/remote-access-and-mobile#phone-app: the phone's state — the machine's workspace and quota as the bridge reads them, the link to the machine,
 * and what belongs to this phone only: the filter, the theme, the windows shown in the header.
 */
import { create } from 'zustand';
import type {
	AgentProvider,
	Locale,
	QuotaSnapshot,
	SidebarFilter,
	WorkspaceSnapshot,
} from '@brigadir/core';

export type Link = 'on' | 'slow' | 'connecting' | 'off';
export type ThemeChoice = 'system' | 'light' | 'dark';
const local = {
	read(key: string): string | null {
		try {
			return localStorage.getItem(key);
		} catch {
			return null;
		}
	},
	write(key: string, value: string | null) {
		try {
			if (value === null) localStorage.removeItem(key);
			else localStorage.setItem(key, value);
		} catch {
			// Storage blocked (a private window): the choice lasts until the page closes.
		}
	},
};
const readJson = <T>(key: string, fallback: T): T => {
	try {
		return (JSON.parse(local.read(key) ?? 'null') as T | null) ?? fallback;
	} catch {
		return fallback;
	}
};
type State = {
	locale: Locale;
	machine: string;
	device: string;
	workspace: WorkspaceSnapshot | null;
	/** When the workspace was last read (ms): «Дані станом на 09:12» while the machine is away. */
	syncedAt: number | null;
	quota: QuotaSnapshot | null;
	link: Link;
	rtt: number | null;
	filter: SidebarFilter;
	theme: ThemeChoice;
	/** The quota window this phone shows per provider; absent — the machine's choice or the tightest. */
	quotaShown: Partial<Record<AgentProvider, string>>;
	lastProject: string | null;
	setWorkspace(value: WorkspaceSnapshot): void;
	setQuota(value: QuotaSnapshot): void;
	setLink(link: Link, rtt?: number | null): void;
	setFilter(filter: SidebarFilter): void;
	setTheme(theme: ThemeChoice): void;
	showQuota(provider: AgentProvider, id: string | null): void;
	setLastProject(id: string): void;
};
export const useMobile = create<State>((set, get) => ({
	locale: 'en',
	machine: '',
	device: '',
	workspace: null,
	syncedAt: null,
	quota: null,
	link: 'on',
	rtt: null,
	filter: null,
	theme: (local.read('brigadir.theme') as ThemeChoice | null) ?? 'system',
	quotaShown: readJson('brigadir.quota', {}),
	lastProject: local.read('brigadir.project'),
	setWorkspace: (workspace) => set({ workspace, syncedAt: Date.now() }),
	setQuota: (quota) => set({ quota }),
	setLink: (link, rtt) => set(rtt === undefined ? { link } : { link, rtt }),
	setFilter: (filter) => set({ filter }),
	setTheme: (theme) => {
		local.write('brigadir.theme', theme === 'system' ? null : theme);
		set({ theme });
	},
	showQuota: (provider, id) => {
		const quotaShown = { ...get().quotaShown };
		if (id) quotaShown[provider] = id;
		else delete quotaShown[provider];
		local.write('brigadir.quota', JSON.stringify(quotaShown));
		set({ quotaShown });
	},
	setLastProject: (id) => {
		local.write('brigadir.project', id);
		set({ lastProject: id });
	},
}));
/** Actions wait for the machine: while it is away the phone shows its cache and does nothing (spec/remote-access-and-mobile#phone-app). */
export const useOffline = () => useMobile((state) => state.link === 'off');
