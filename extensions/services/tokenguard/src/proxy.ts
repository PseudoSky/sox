/**
 * TokenGuard proxy server core.
 *
 * Port-holding HTTP server:
 * - Walks port..+9 until a port is free, then listens.
 * - Writes the actual bound port to storePath/port.txt ONLY AFTER listening.
 * - Exposes GET /_tokenguard/health for the supervisor's http-get health probe.
 * - Tokenizes outbound request-scoped regions via the engine.
 * - Forces Accept-Encoding: identity on upstream requests.
 * - Leak self-check + audit event.
 * - Detokenizes inbound via the adapter.
 * - SIGTERM closes the server cleanly. [ref:supervisor-stop]
 *
 * [ref:c7-no-reach-in] — imports from @sox/tokenguard-core only.
 * [tg-service.8] — port.txt written after listen.
 */

import * as http from 'node:http';
import * as https from 'node:https';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as net from 'node:net';
import * as url from 'node:url';

import {
  Mapper,
  tokenizeRequest,
  wireLeaks,
  detokenizeText,
} from '@sox/tokenguard-core';

import type { ProviderAdapter } from './adapters/generic.js';
import type { TokenGuardConfig } from './config.js';

// ── Audit log ──────────────────────────────────────────────────────────────

interface AuditEntry {
  ts: string;
  event: string;
  path?: string;
  leak_count?: number;
  outbound_size?: number;
  inbound_size?: number;
  outbound_body?: string;
  inbound_body?: string;
}

function auditLog(auditPath: string, entry: AuditEntry): void {
  try {
    fs.appendFileSync(auditPath, JSON.stringify(entry) + '\n', 'utf8');
  } catch {
    // best-effort — never crash on audit failure
  }
}

// ── Port walk ──────────────────────────────────────────────────────────────

async function tryBind(port: number): Promise<boolean> {
  return new Promise((resolve) => {
    const server = net.createServer();
    server.on('error', () => resolve(false));
    server.listen(port, '127.0.0.1', () => {
      server.close(() => resolve(true));
    });
  });
}

async function findFreePort(basePort: number, maxWalk = 9): Promise<number> {
  for (let i = 0; i <= maxWalk; i++) {
    if (await tryBind(basePort + i)) {
      return basePort + i;
    }
  }
  throw new Error(`tokenguard: no free port in range ${basePort}..${basePort + maxWalk}`);
}

// ── Body helpers ──────────────────────────────────────────────────────────

async function readBody(req: http.IncomingMessage): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    req.on('data', (chunk: Buffer) => chunks.push(chunk));
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}

// ── Capture helpers ───────────────────────────────────────────────────────

function maybeCapture(
  body: string,
  mode: 'full' | 'truncated' | 'none',
  maxBytes: number,
): string | undefined {
  if (mode === 'none') return undefined;
  if (mode === 'full') return body;
  // truncated
  return body.slice(0, maxBytes);
}

// ── Upstream request ──────────────────────────────────────────────────────

function upstreamRequest(
  upstreamBase: string,
  reqPath: string,
  method: string,
  headers: Record<string, string>,
  body: Buffer,
): Promise<{ status: number; headers: Record<string, string[]>; body: Buffer }> {
  return new Promise((resolve, reject) => {
    const parsed = new url.URL(upstreamBase);
    const isHttps = parsed.protocol === 'https:';
    const mod = isHttps ? https : http;

    const port = parsed.port
      ? parseInt(parsed.port, 10)
      : isHttps ? 443 : 80;

    const options: http.RequestOptions = {
      host: parsed.hostname,
      port,
      path: reqPath,
      method,
      headers: {
        ...headers,
        // Force plain encoding so we can read the response body as UTF-8
        'accept-encoding': 'identity',
        // Correct content-length for the (potentially modified) body
        'content-length': String(body.length),
      },
    };

    const req = mod.request(options, (res) => {
      const chunks: Buffer[] = [];
      res.on('data', (c: Buffer) => chunks.push(c));
      res.on('end', () => {
        const resHeaders: Record<string, string[]> = {};
        for (const [k, v] of Object.entries(res.headers)) {
          if (v === undefined) continue;
          resHeaders[k] = Array.isArray(v) ? v : [v];
        }
        resolve({
          status: res.statusCode ?? 200,
          headers: resHeaders,
          body: Buffer.concat(chunks),
        });
      });
      res.on('error', reject);
    });

    req.on('error', reject);
    req.write(body);
    req.end();
  });
}

// ── Proxy server ──────────────────────────────────────────────────────────

export interface ProxyOptions {
  config: TokenGuardConfig;
  mapper: Mapper;
  adapter: ProviderAdapter;
  /** Directory where port.txt (and optionally audit.jsonl) live. */
  storePath: string;
  /** Full path to audit.jsonl (inside captureDir). */
  auditPath: string;
}

export async function startProxy(opts: ProxyOptions): Promise<http.Server> {
  const { config, mapper, adapter, storePath, auditPath } = opts;

  const port = await findFreePort(config.port);

  const server = http.createServer((req, res) => {
    // Health endpoint
    if (req.url === '/_tokenguard/health' && req.method === 'GET') {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ status: 'ok', service: 'tokenguard', port }));
      return;
    }

    // All other requests: tokenize → upstream → detokenize
    void handleProxyRequest(req, res, opts, auditPath);
  });

  return new Promise((resolve, reject) => {
    server.on('error', reject);
    server.listen(port, '127.0.0.1', () => {
      // Write port.txt ONLY after actually listening [tg-service.8]
      try {
        fs.mkdirSync(storePath, { recursive: true });
        fs.writeFileSync(path.join(storePath, 'port.txt'), String(port), 'utf8');
      } catch {
        // best-effort
      }
      process.stderr.write(`tokenguard: listening on http://127.0.0.1:${port}\n`);
      resolve(server);
    });
  });
}

async function handleProxyRequest(
  req: http.IncomingMessage,
  res: http.ServerResponse,
  opts: ProxyOptions,
  auditPath: string,
): Promise<void> {
  const { config, mapper, adapter } = opts;

  try {
    const bodyBuf = await readBody(req);
    const bodyStr = bodyBuf.toString('utf8');

    // Parse body if JSON, otherwise pass as-is
    let parsed: unknown = bodyStr;
    let isJson = false;
    const ct = req.headers['content-type'] ?? '';
    if (ct.includes('application/json') && bodyStr.trim().startsWith('{')) {
      try {
        parsed = JSON.parse(bodyStr) as unknown;
        isJson = true;
      } catch {
        // not JSON — leave as string
      }
    }

    // Tokenize: use tokenizeRequest (engine) on the full parsed body.
    // The engine scopes to system/messages/metadata for Anthropic; for generic
    // we pass the whole body. We use a deep-clone to avoid mutating the original.
    const toTokenize = isJson ? JSON.parse(JSON.stringify(parsed)) as unknown : parsed;
    const tokenized = tokenizeRequest(toTokenize, mapper, null, {
      detectPhone: config.detectPhone,
      detectIpv6: config.detectIpv6,
    });

    // Leak self-check [inv:wire-guarantee]
    const leaks = wireLeaks(tokenized, mapper);
    const leakCount = leaks.length;

    // Emit audit event
    const reqPath = req.url ?? '/';
    const outboundStr = isJson ? JSON.stringify(tokenized) : String(tokenized);
    const capturedOut = maybeCapture(outboundStr, config.capture, config.captureMaxBytes);
    auditLog(auditPath, {
      ts: new Date().toISOString(),
      event: 'outbound',
      path: reqPath,
      leak_count: leakCount,
      outbound_size: outboundStr.length,
      ...(capturedOut !== undefined ? { outbound_body: capturedOut } : {}),
    });

    if (leakCount > 0) {
      process.stderr.write(`tokenguard: WARN leak detected: ${leaks.join(', ')}\n`);
    }

    // Build outbound headers (strip hop-by-hop)
    const outHeaders: Record<string, string> = {};
    const HOP_BY_HOP = new Set([
      'connection', 'keep-alive', 'proxy-authenticate', 'proxy-authorization',
      'te', 'trailers', 'transfer-encoding', 'upgrade',
    ]);
    for (const [k, v] of Object.entries(req.headers)) {
      if (HOP_BY_HOP.has(k.toLowerCase())) continue;
      if (Array.isArray(v)) {
        outHeaders[k] = v.join(', ');
      } else if (v !== undefined) {
        outHeaders[k] = v;
      }
    }

    // Build outbound body
    const outboundBody = isJson
      ? Buffer.from(JSON.stringify(tokenized), 'utf8')
      : Buffer.from(String(tokenized), 'utf8');

    // Forward to upstream
    const upstream = await upstreamRequest(
      config.upstream,
      reqPath,
      req.method ?? 'POST',
      outHeaders,
      outboundBody,
    );

    // Detokenize response
    const rawResponseStr = upstream.body.toString('utf8');
    const reversed = adapter.reverseStream(rawResponseStr, (s) =>
      detokenizeText(s, mapper, null),
    );

    // Audit inbound
    const capturedIn = maybeCapture(rawResponseStr, config.capture, config.captureMaxBytes);
    auditLog(auditPath, {
      ts: new Date().toISOString(),
      event: 'inbound',
      path: reqPath,
      inbound_size: rawResponseStr.length,
      ...(capturedIn !== undefined ? { inbound_body: capturedIn } : {}),
    });

    // Write response to client (strip hop-by-hop + content-encoding from upstream)
    // Build all headers FIRST, then call writeHead ONCE with them — calling
    // setHeader after writeHead throws ERR_HTTP_HEADERS_SENT.
    const STRIP = new Set(['content-encoding', 'transfer-encoding', 'connection', 'content-length']);
    const responseHeaders: Record<string, string | string[]> = {};
    for (const [k, vs] of Object.entries(upstream.headers)) {
      if (STRIP.has(k.toLowerCase())) continue;
      responseHeaders[k] = vs.length === 1 ? vs[0] : vs;
    }
    // Set content-length based on the detokenized body (may differ from upstream)
    responseHeaders['content-length'] = String(Buffer.byteLength(reversed, 'utf8'));
    res.writeHead(upstream.status, responseHeaders);
    res.end(reversed);

  } catch (err) {
    process.stderr.write(`tokenguard: proxy error: ${String(err)}\n`);
    if (!res.headersSent) {
      res.writeHead(502);
      res.end('tokenguard: proxy error');
    }
  }
}
