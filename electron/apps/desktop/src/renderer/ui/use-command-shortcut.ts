import { commandShortcut, defaultKeymap } from '@brigadir/core';
import { useWorkspace } from '../store';
/**
 * The shortcuts of menu commands as this platform shows them, from the person's keymap: `⌥⌘R` on macOS,
 * `Ctrl+Shift+R` on Windows and Linux (spec/architecture-and-platform#window-frame). Every label of a command's key reads it here, never a literal.
 */
export function useCommandShortcut(): (id: string) => string | undefined {
	const keymap = useWorkspace((state) => state.appearance.keymap) ?? defaultKeymap;
	return (id) => commandShortcut(id, keymap);
}
