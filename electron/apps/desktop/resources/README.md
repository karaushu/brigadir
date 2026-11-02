# Application icon

`brigadir.icon/` is the original Icon Composer document supplied by the author on
15.09.2026. Preserve its layers, placement, background and effects. The PNG in
Assets is only one layer; it is not a replacement for the complete app icon.

`scripts/desktop-runtime.mjs` compiles the document with Xcode actool for macOS,
including `Assets.car` and the `brigadir.icns` fallback. Both icon keys in the
app's Info.plist refer to `brigadir`. The runtime cache includes a digest of all
source files. Use the normal start/dev commands; do not edit a cached bundle or
add a temporary `app.dock.setIcon` override.
