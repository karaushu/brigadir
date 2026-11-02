/** spec/composer#paste: what ⌘V does in the composer, from what the paste event shows of the clipboard.
 * Text wins over an image (cells from a spreadsheet carry a picture of themselves); an image or Finder's files attach
 * when there is no text (a Finder copy shows its files and no text), or when the text is only the image's address. */
export function pasteKind(text: string, hasImage: boolean): 'text' | 'image' {
	if (!text) return 'image';
	return hasImage && /^(?:https?|file|data|blob):\S+$/i.test(text.trim()) ? 'image' : 'text';
}
export function clipboardHasImage(data: DataTransfer) {
	return Array.from(data.items).some(
		(item) => item.kind === 'file' && item.type.startsWith('image/')
	);
}
