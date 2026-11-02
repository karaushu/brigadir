import { create } from 'zustand';
import type {
	FoundMachine,
	PairedMachine,
	RemoteAccessStatus,
	RemoteControl,
	RemoteNotice,
	RemoteReach,
	RemoteSession,
} from '@brigadir/core';

/**
 * spec/remote-access-and-mobile#architecture, spec/remote-access-and-mobile#module-and-settings: what the window chrome knows about remote access.
 * - This machine's own window: `status` and `control` of its gateway (the idle chip, the cover, the notices).
 * - A window of another machine (`window.brigadir.remoteMachine`): its `session` from this machine's main and `control`
 *   as that machine sends it (`self` — this device controls it).
 * `epoch` grows each time this window gets control back, and after each reconnect or move of its link (spec/remote-access-and-mobile#networking:
 * for the machine that is a new client), so the window says its visible task, menu context, streams and watches again.
 */
type State = {
	status: RemoteAccessStatus | null;
	control: RemoteControl | null;
	session: RemoteSession | null;
	epoch: number;
	/** spec/remote-access-and-mobile#remote-button: the window chip is in the bar, and how many times File ▸ Connect… (⌥⌘O) asked it to open its menu. */
	chipShown: boolean;
	chipAsked: number;
};
export const useRemote = create<State>(() => ({
	status: null,
	control: null,
	session: null,
	epoch: 0,
	chipShown: false,
	chipAsked: 0,
}));
/** File ▸ Connect…: the chip's menu when the chip is shown; false — the caller opens the list «Connect» itself. */
export function askRemoteChip(): boolean {
	if (!useRemote.getState().chipShown) return false;
	useRemote.setState((state) => ({ chipAsked: state.chipAsked + 1 }));
	return true;
}
export const remoteMachine = window.brigadir.remoteMachine;

function setControl(control: RemoteControl) {
	useRemote.setState((state) => {
		const had = state.control,
			gained = control.self && !(had?.self ?? false);
		return { control, epoch: gained && had ? state.epoch + 1 : state.epoch };
	});
}

/** Reads and follows the remote state; `notice` gets the gateway's notices (this machine's window only). */
export function followRemote(enabled: boolean, notice: (notice: RemoteNotice) => void): () => void {
	const stops: (() => void)[] = [];
	let alive = true;
	if (remoteMachine) {
		// The device's link follows `remote:control` and says it in the session (`active`), so the session is the truth here.
		const pick = (sessions: RemoteSession[]) =>
			sessions.find((item) => item.machineId === remoteMachine!.id) ?? null;
		const take = (session: RemoteSession | null) => {
			if (!session) return;
			useRemote.setState((state) => {
				const before = state.session,
					regained = session.active && before && !before.active,
					relinked =
						session.state === 'connected' &&
						before &&
						(session.generation ?? 0) > (before.generation ?? 0);
				return { session, epoch: regained || relinked ? state.epoch + 1 : state.epoch };
			});
		};
		stops.push(window.brigadir.onRemoteSessions((sessions) => take(pick(sessions))));
		void window.brigadir
			.readRemoteSessions()
			.then((sessions) => {
				if (alive) take(pick(sessions));
			})
			.catch(() => {});
	} else if (enabled) {
		stops.push(
			window.brigadir.onRemoteStatus((status) => useRemote.setState({ status })),
			window.brigadir.onRemoteControl(setControl),
			window.brigadir.onRemoteNotice(notice)
		);
		void window.brigadir
			.readRemoteAccess()
			.then((status) => {
				if (!alive) return;
				useRemote.setState({ status });
				setControl(status.control);
			})
			.catch(() => {
				if (alive) useRemote.setState({ status: null, control: null });
			});
	} else useRemote.setState({ status: null, control: null });
	return () => {
		alive = false;
		for (const stop of stops) stop();
	};
}
/** A fresh status after an action that returns one (Settings ▸ Remote, the idle menu). */
export function setRemoteStatus(status: RemoteAccessStatus) {
	useRemote.setState({ status });
}

/**
 * spec/remote-access-and-mobile#module-and-settings, spec/remote-access-and-mobile#remote-button: this computer's paired machines and whether each answers — for the list «Connect», the chip's
 * popover and Settings ▸ Remote ▸ Connect to another. mDNS and the TLS touch (spec/remote-access-and-mobile#networking) run while anyone holds
 * `watchRemoteMachines`; the first holder starts them, the last one stops them, so two surfaces never fight over it.
 */
type Machines = {
	machines: PairedMachine[] | null;
	found: FoundMachine[];
	reach: RemoteReach[];
	sessions: RemoteSession[];
};
export const useRemoteMachines = create<Machines>(() => ({
	machines: null,
	found: [],
	reach: [],
	sessions: [],
}));
let holders = 0,
	unwatch: (() => void) | null = null,
	stopping: ReturnType<typeof setTimeout> | null = null;
/** Reads the paired machines again (after pairing or forgetting one); the list it read. */
export function reloadRemoteMachines(): Promise<PairedMachine[]> {
	return window.brigadir
		.readRemoteMachines()
		.then((machines) => {
			useRemoteMachines.setState({ machines });
			return machines;
		})
		.catch(() => useRemoteMachines.getState().machines ?? []);
}
export function watchRemoteMachines(): () => void {
	holders++;
	void reloadRemoteMachines();
	// A surface handing the watch to the next one (the chip's menu opening the list «Connect») keeps it running.
	if (stopping) {
		clearTimeout(stopping);
		stopping = null;
	}
	if (holders === 1 && !unwatch) {
		const stops = [
			window.brigadir.onRemoteFound((found) => useRemoteMachines.setState({ found })),
			window.brigadir.onRemoteReach((reach) => useRemoteMachines.setState({ reach })),
			window.brigadir.onRemoteSessions((sessions) => useRemoteMachines.setState({ sessions })),
		];
		void window.brigadir
			.readRemoteSessions()
			.then((sessions) => useRemoteMachines.setState({ sessions }))
			.catch(() => {});
		void window.brigadir.browseRemoteMachines(true).catch(() => {});
		unwatch = () => {
			for (const stop of stops) stop();
			void window.brigadir.browseRemoteMachines(false).catch(() => {});
			useRemoteMachines.setState({ found: [], reach: [] });
		};
	}
	let released = false;
	return () => {
		if (released) return;
		released = true;
		holders--;
		if (holders === 0)
			stopping = setTimeout(() => {
				stopping = null;
				if (holders) return;
				unwatch?.();
				unwatch = null;
			}, 200);
	};
}
