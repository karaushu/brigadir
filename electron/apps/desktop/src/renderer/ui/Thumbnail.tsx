import { useEffect, useState } from 'react';
import { thumbnailCrop, type PromptAttachment, type TaskKey } from '@brigadir/core';
/** spec/chat#images: a tile's picture — the cached thumbnail, a placeholder of the same size while it loads, «unavailable» when the image is gone or changed. */
export function useThumbnail(task: TaskKey, item: PromptAttachment) {
	const [state, setState] = useState<{ src: string | null; failed: boolean }>({
		src: null,
		failed: false,
	});
	useEffect(() => {
		if (item.kind !== 'image') return;
		let active = true;
		setState({ src: null, failed: false });
		void window.brigadir.readAttachmentThumbnail(task, item.id).then(
			(src) => {
				if (active) setState({ src, failed: false });
			},
			() => {
				if (active) setState({ src: null, failed: true });
			}
		);
		return () => {
			active = false;
		};
	}, [task.id, task.projectId, item.id, item.kind]);
	return state;
}
export function Thumbnail({ src }: { src: string }) {
	const [crop, setCrop] = useState<string>('center');
	return (
		<img
			alt=""
			src={src}
			data-crop={crop}
			draggable={false}
			onLoad={(event) =>
				setCrop(thumbnailCrop(event.currentTarget.naturalWidth, event.currentTarget.naturalHeight))
			}
		/>
	);
}
