/**
 * spec/remote-access-and-mobile#phone-network: what a phone's page shares with the working machine — CPace, the text frames, the web protocol and
 * base64. Nothing here imports Node: `@brigadir/remote/web` is bundled into `renderer-mobile`.
 */
export * from './base64';
export { decodeFrame, encodeFrame } from './codec';
export * from './cpace';
export * from './web-protocol';
