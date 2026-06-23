/**
 * @adhd/sox-tokenguard-core — public surface
 *
 * Pure, IO-light TypeScript port of the TokenGuard bijective tokenize/detokenize engine.
 * No network, no provider specifics.
 */

// Types
export type { DetectorConfig, IdType, MapEntry, Source, TokenMap } from './types.js';

// Mapper
export { Mapper } from './mapper.js';

// Detector constants + individual detectors
export {
  BOUNDED_TYPES, detectEmail,
  detectFqdn, detectIpv4, detectIpv6, detectKnown, detectMac,
  detectPhone, EMAIL_RE,
  FQDN_RE, IPV4_RE, IPV6_RE,
  MAC_RE, NEVER, PHONE_RE, tokenizeStr
} from './detectors.js';
export type { HitMap } from './detectors.js';

// Tokenize / detokenize
export {
  detokenizeText, identifierGroupVariants,
  REQUEST_TOKENIZE_KEYS, tokenizeRequest, walkTokenize, wireLeaks
} from './tokenize.js';

// SSE reassembly
export { detokenizeSse, detokenizeSseWithMapper } from './sse.js';
