/**
 * spec/architecture-and-platform#auto-update: the app version this host's code was built with. `scripts/build-services.mjs` writes it into `host.cjs`;
 * unbundled (tests) it is unknown. The host records it in `host.json`, so a newer app can replace hosts of an older bundle.
 */
export const hostAppVersion: string | undefined = process.env.BRIGADIR_APP_VERSION || undefined;
