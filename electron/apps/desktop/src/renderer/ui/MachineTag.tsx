import { Glyph } from './Glyph';
import s from './MachineTag.module.css';

/**
 * spec/remote-access-and-mobile#client-ui-seam, spec/remote-access-and-mobile#browser-from-device: the machine a page or a simulator lives on, in the address field of the browser and the strip
 * of the simulator in a window of another machine (canvas `Stream`, `StreamSim` `.mtag`). A quiet tag, not a control.
 */
export function MachineTag({ name, title }: { name: string; title: string }) {
	return (
		<span className={s.tag} title={title} data-machine-tag>
			<Glyph name="remote" size={11} />
			<span className={s.name}>{name}</span>
		</span>
	);
}
