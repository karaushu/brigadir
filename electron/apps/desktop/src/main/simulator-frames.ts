import type { SimulatorFrame } from '@brigadir/core';
import type { Client, Clients } from './clients';

/**
 * spec/remote-access-and-mobile#architecture, spec/remote-access-and-mobile#browser-from-device: simulator frames to every window that shows them — this machine's own over IPC, a
 * device's over its connection as binary frames it may miss. A device that missed a frame gets no delta until the next
 * key frame (a delta of a missing one would decode into garbage), and the helper is asked for a key frame at most once a
 * second per project.
 */
export class SimulatorFrames {
	private readonly lost = new Set<string>();
	private readonly asked = new Map<string, number>();
	constructor(
		private readonly clients: Pick<Clients, 'each'>,
		private readonly keyframe: (projectId: string) => void,
		private readonly now: () => number = Date.now
	) {}
	frame(projectId: string, frame: SimulatorFrame) {
		const value = { projectId, ...frame };
		this.clients.each('simulator:frame', (client) => {
			const id = `${client.id}\n${projectId}`;
			if (this.lost.has(id) && !frame.key) return;
			if (client.send('simulator:frame', value, true)) {
				if (frame.key) this.lost.delete(id);
				return;
			}
			// A window that is gone takes nothing; only a connection that had no room missed a frame.
			if (!client.device) return;
			this.lost.add(id);
			const at = this.asked.get(projectId) ?? -Infinity;
			if (this.now() - at >= 1000) {
				this.asked.set(projectId, this.now());
				this.keyframe(projectId);
			}
		});
	}
	/** A device's connection went. */
	forget(client: Pick<Client, 'id'>) {
		for (const id of [...this.lost]) if (id.startsWith(`${client.id}\n`)) this.lost.delete(id);
	}
}
