// spec/remote-access-and-mobile#identity-and-keys: the PNG icon of the Linux and Windows builds (packaging/icons/icon.png, 512 px), drawn on a Mac from the
// same Icon Composer document as the macOS app (apps/desktop/resources/brigadir.icon): actool compiles it, AppKit draws
// the compiled icon at the asked size. `node scripts/render-icon.mjs [size]`; commit the PNG it writes.
import { execFile } from 'node:child_process';
import { chmod, mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { workspace } from '../packaging/electron-builder.config.mjs';
const run = promisify(execFile);
const size = Number(process.argv[2] ?? 512);
const temp = await mkdtemp(join(tmpdir(), 'brigadir-icon-'));
try {
	// A bundle with an executable: Launch Services draws a bundle without one with a «cannot run» badge.
	const app = join(temp, 'BrigadirIcon.app'),
		resources = join(app, 'Contents/Resources');
	await mkdir(resources, { recursive: true });
	await mkdir(join(app, 'Contents/MacOS'));
	await run('/usr/bin/xcrun', [
		'actool',
		'--compile',
		resources,
		'--platform',
		'macosx',
		'--minimum-deployment-target',
		'13.0',
		'--app-icon',
		'brigadir',
		'--output-partial-info-plist',
		join(temp, 'icon.plist'),
		join(workspace, 'apps/desktop/resources/brigadir.icon'),
	]);
	await writeFile(join(app, 'Contents/MacOS/run'), '#!/bin/sh\nexit 0\n');
	await chmod(join(app, 'Contents/MacOS/run'), 0o755);
	await writeFile(
		join(app, 'Contents/Info.plist'),
		`<?xml version="1.0" encoding="UTF-8"?>
<plist version="1.0"><dict>
<key>CFBundleIdentifier</key><string>com.karaushu.brigadir.icon-render.${Date.now()}</string>
<key>CFBundleExecutable</key><string>run</string>
<key>CFBundlePackageType</key><string>APPL</string>
<key>CFBundleIconFile</key><string>brigadir</string>
<key>CFBundleIconName</key><string>brigadir</string>
</dict></plist>
`
	);
	const swift = join(temp, 'render.swift');
	await writeFile(
		swift,
		`import AppKit
let args = CommandLine.arguments
let image = NSWorkspace.shared.icon(forFile: args[1])
let size = Int(args[3])!
let rep = NSBitmapImageRep(bitmapDataPlanes: nil, pixelsWide: size, pixelsHigh: size, bitsPerSample: 8, samplesPerPixel: 4, hasAlpha: true, isPlanar: false, colorSpaceName: .deviceRGB, bytesPerRow: 0, bitsPerPixel: 0)!
rep.size = NSSize(width: size, height: size)
NSGraphicsContext.saveGraphicsState()
NSGraphicsContext.current = NSGraphicsContext(bitmapImageRep: rep)
image.draw(in: NSRect(x: 0, y: 0, width: size, height: size), from: .zero, operation: .copy, fraction: 1)
NSGraphicsContext.restoreGraphicsState()
try! rep.representation(using: .png, properties: [:])!.write(to: URL(fileURLWithPath: args[2]))
`
	);
	const output = join(workspace, 'packaging/icons/icon.png');
	await mkdir(join(workspace, 'packaging/icons'), { recursive: true });
	await run('/usr/bin/xcrun', ['swift', swift, app, output, String(size)]);
	console.log(`${output}: ${size} × ${size}`);
} finally {
	await rm(temp, { recursive: true, force: true });
}
