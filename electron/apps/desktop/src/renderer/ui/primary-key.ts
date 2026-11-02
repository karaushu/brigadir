/**
 * spec/architecture-and-platform#window-frame, spec/remote-access-and-mobile#identity-and-keys: the main modifier of the keyboard the window is used with — ⌘ on macOS, Ctrl on Windows
 * and Linux (`chromePlatform`, a Mac previewing the PC frame included). ⌘↩ in a form, ⌘+click on code or a link and ⌘O in
 * a list read it, so a client on Linux or Windows has them as Ctrl↩, Ctrl+click and Ctrl+O.
 */
export function primaryKey(event: { metaKey: boolean; ctrlKey: boolean }): boolean {
	return window.brigadir.chromePlatform === 'darwin' ? event.metaKey : event.ctrlKey;
}
