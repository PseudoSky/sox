/**
 * @sox/tokenguard-core — public surface
 *
 * Pure, IO-light TypeScript port of the TokenGuard bijective tokenize/detokenize engine.
 * No network, no provider specifics.
 */

// Types
export type { MapEntry, TokenMap, Source, IdType, DetectorConfig } from './types.js';

// Mapper
export { Mapper } from './mapper.js';

// Detector constants + individual detectors
export {
  NEVER,
  BOUNDED_TYPES,
  IPV4_RE,
  EMAIL_RE,
  FQDN_RE,
  IPV6_RE,
  MAC_RE,
  PHONE_RE,
  detectKnown,
  detectEmail,
  detectFqdn,
  detectIpv6,
  detectIpv4,
  detectMac,
  detectPhone,
  tokenizeStr,
} from './detectors.js';
export type { HitMap } from './detectors.js';

// Tokenize / detokenize
export {
  identifierGroupVariants,
  REQUEST_TOKENIZE_KEYS,
  walkTokenize,
  tokenizeRequest,
  wireLeaks,
  detokenizeText,
} from './tokenize.js';

// SSE reassembly
export { detokenizeSse, detokenizeSseWithMapper } from './sse.js';
