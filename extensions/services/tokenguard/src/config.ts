/**
 * TokenGuard service — config resolution
 *
 * [inv:standard-config] — ALL config flows through SOX_CONFIG_* env variables only.
 * No bespoke config-file reader; no direct fs.readFile for config.
 * Values are injected by the soxe supervisor from the install-time config_schema prompt.
 */

export interface TokenGuardConfig {
  /** Base port (walks +9 if occupied). */
  port: number;
  /** Upstream API base URL. */
  upstream: string;
  /** Body capture mode. */
  capture: 'full' | 'truncated' | 'none';
  /** Max bytes per captured body in truncated mode. */
  captureMaxBytes: number;
  /** Provider adapter selector. */
  provider: 'anthropic' | 'generic';
  /** Path to persist the live token map. */
  mapPath: string;
  /** Directory for audit.jsonl capture log. */
  captureDir: string;
  /** Pre-seeded identifiers. */
  seeds: Array<{ real?: string; type?: string; token?: string }>;
  /** Never-tokenize list. */
  never: string[];
  /** Detector toggles. */
  detectPhone: boolean;
  detectIpv6: boolean;
}

function parseJsonSafe<T>(raw: string | undefined, fallback: T): T {
  if (!raw) return fallback;
  try {
    return JSON.parse(raw) as T;
  } catch {
    return fallback;
  }
}

function parseBool(raw: string | undefined, fallback: boolean): boolean {
  if (raw === undefined) return fallback;
  return raw === 'true' || raw === '1';
}

/**
 * Resolve config from SOX_CONFIG_* environment variables only.
 * [inv:standard-config]
 */
export function resolveConfig(): TokenGuardConfig {
  const SOX_CONFIG_PORT = process.env['SOX_CONFIG_PORT'];
  const SOX_CONFIG_UPSTREAM = process.env['SOX_CONFIG_UPSTREAM'];
  const SOX_CONFIG_CAPTURE = process.env['SOX_CONFIG_CAPTURE'];
  const SOX_CONFIG_CAPTURE_MAX_BYTES = process.env['SOX_CONFIG_CAPTURE_MAX_BYTES'];
  const SOX_CONFIG_PROVIDER = process.env['SOX_CONFIG_PROVIDER'];
  const SOX_CONFIG_MAP_PATH = process.env['SOX_CONFIG_MAP_PATH'];
  const SOX_CONFIG_CAPTURE_DIR = process.env['SOX_CONFIG_CAPTURE_DIR'];
  const SOX_CONFIG_SEEDS = process.env['SOX_CONFIG_SEEDS'];
  const SOX_CONFIG_NEVER = process.env['SOX_CONFIG_NEVER'];
  const SOX_CONFIG_DETECT_PHONE = process.env['SOX_CONFIG_DETECT_PHONE'];
  const SOX_CONFIG_DETECT_IPV6 = process.env['SOX_CONFIG_DETECT_IPV6'];

  const port = SOX_CONFIG_PORT ? parseInt(SOX_CONFIG_PORT, 10) : 9099;
  const upstream = SOX_CONFIG_UPSTREAM ?? 'https://api.anthropic.com';

  const rawCapture = SOX_CONFIG_CAPTURE ?? 'truncated';
  const capture: 'full' | 'truncated' | 'none' =
    rawCapture === 'full' || rawCapture === 'truncated' || rawCapture === 'none'
      ? rawCapture
      : 'truncated';

  const captureMaxBytes = SOX_CONFIG_CAPTURE_MAX_BYTES
    ? parseInt(SOX_CONFIG_CAPTURE_MAX_BYTES, 10)
    : 4096;

  const rawProvider = SOX_CONFIG_PROVIDER ?? 'anthropic';
  const provider: 'anthropic' | 'generic' =
    rawProvider === 'anthropic' || rawProvider === 'generic' ? rawProvider : 'anthropic';

  const home = process.env['HOME'] ?? '/tmp';
  const defaultMapPath = `${home}/.tokenguard/token-mapping.json`;
  const defaultCaptureDir = `${home}/.tokenguard`;

  const mapPath = SOX_CONFIG_MAP_PATH
    ? SOX_CONFIG_MAP_PATH.replace(/^~/, home)
    : defaultMapPath;

  const captureDir = SOX_CONFIG_CAPTURE_DIR
    ? SOX_CONFIG_CAPTURE_DIR.replace(/^~/, home)
    : defaultCaptureDir;

  const seeds = parseJsonSafe<Array<{ real?: string; type?: string; token?: string }>>(
    SOX_CONFIG_SEEDS,
    [],
  );

  const never = parseJsonSafe<string[]>(SOX_CONFIG_NEVER, []);

  const detectPhone = parseBool(SOX_CONFIG_DETECT_PHONE, false);
  const detectIpv6 = parseBool(SOX_CONFIG_DETECT_IPV6, true);

  return {
    port,
    upstream,
    capture,
    captureMaxBytes,
    provider,
    mapPath,
    captureDir,
    seeds,
    never,
    detectPhone,
    detectIpv6,
  };
}
