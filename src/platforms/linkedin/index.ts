// LinkedIn adapter (WP-PLAT-04). Self-contained but for the adapter contract, which exists once
// in the service (`../types.ts`, WP-PLAT-02). The registry (`../registry.ts`) wires it into the
// publish loop.

export * from '../types.js';
export * from './config.js';
export * from './escape.js';
export * from './expiry.js';
export * from './link-mode.js';
export * from './adapter.js';
export {
  createLinkedInClient,
  errorCodeOf,
  scrub,
  type LinkedInClient,
  type LinkedInClientOptions,
  type LinkedInErrorCode,
  type RetryOptions,
} from './client.js';
