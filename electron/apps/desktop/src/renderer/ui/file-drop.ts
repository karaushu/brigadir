import type { DragEvent } from 'react';
import { isRecord, type AgentTask } from '@brigadir/core';
import { attachTaskFile } from '../task-state';
export const fileDragType = 'application/x-brigadir-file';
/** spec/composer#paste: the composer also takes files from Finder (`files`) and shows its drop zone while one is over it (`over`). */
export function fileDropHandlers(
	task: AgentTask,
	onError: () => void,
	options: { files?: (files: File[]) => void; over?: (value: boolean) => void } = {}
) {
	const accepts = (event: DragEvent) =>
		event.dataTransfer.types.includes(fileDragType) ||
		(Boolean(options.files) && event.dataTransfer.types.includes('Files'));
	return {
		onDragOver(event: DragEvent) {
			if (accepts(event)) {
				event.preventDefault();
				event.dataTransfer.dropEffect = 'copy';
				options.over?.(true);
			}
		},
		onDragLeave(event: DragEvent) {
			const next = event.relatedTarget;
			if (!(next instanceof Node && event.currentTarget.contains(next))) options.over?.(false);
		},
		onDrop(event: DragEvent) {
			if (!accepts(event)) return;
			event.preventDefault();
			event.stopPropagation();
			options.over?.(false);
			if (!event.dataTransfer.types.includes(fileDragType)) {
				options.files?.(Array.from(event.dataTransfer.files));
				return;
			}
			try {
				const payload = JSON.parse(event.dataTransfer.getData(fileDragType));
				if (
					!isRecord(payload) ||
					payload.projectId !== task.projectId ||
					payload.taskId !== task.id ||
					typeof payload.id !== 'string' ||
					!/^[a-f0-9]{64}$/.test(payload.id)
				)
					throw new Error('Invalid file drag');
				void attachTaskFile(task, payload.id).catch(onError);
			} catch {
				onError();
			}
		},
	};
}
