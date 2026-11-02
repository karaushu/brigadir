import { isRecord, isRelayHandoff, type RelayHandoff, type TaskKey } from '@brigadir/core';
import { SessionStore, readDocument, safePath } from './session';
export async function readRelayHandoff(
	store: SessionStore,
	key: TaskKey
): Promise<RelayHandoff | null> {
	const task = await store.task(key);
	try {
		const doc = await readDocument(await safePath(await store.taskDir(key), 'relay.json'));
		if (!isRelayHandoff(doc.handoff) || task.continuesTaskId !== doc.handoff.sourceId)
			throw new Error('Invalid relay handoff');
		return doc.handoff;
	} catch (error) {
		if (isRecord(error) && error.code === 'ENOENT') return null;
		throw error;
	}
}
