"use strict";
var __create = Object.create;
var __defProp = Object.defineProperty;
var __getOwnPropDesc = Object.getOwnPropertyDescriptor;
var __getOwnPropNames = Object.getOwnPropertyNames;
var __getProtoOf = Object.getPrototypeOf;
var __hasOwnProp = Object.prototype.hasOwnProperty;
var __commonJS = (cb, mod) => function __require() {
  return mod || (0, cb[__getOwnPropNames(cb)[0]])((mod = { exports: {} }).exports, mod), mod.exports;
};
var __export = (target, all) => {
  for (var name in all)
    __defProp(target, name, { get: all[name], enumerable: true });
};
var __copyProps = (to, from, except, desc) => {
  if (from && typeof from === "object" || typeof from === "function") {
    for (let key of __getOwnPropNames(from))
      if (!__hasOwnProp.call(to, key) && key !== except)
        __defProp(to, key, { get: () => from[key], enumerable: !(desc = __getOwnPropDesc(from, key)) || desc.enumerable });
  }
  return to;
};
var __toESM = (mod, isNodeMode, target) => (target = mod != null ? __create(__getProtoOf(mod)) : {}, __copyProps(
  // If the importer is in node compatibility mode or this is not an ESM
  // file that has been converted to a CommonJS file using a Babel-
  // compatible transform (i.e. "__esModule" has not been set), then set
  // "default" to the CommonJS "module.exports" for node compatibility.
  isNodeMode || !mod || !mod.__esModule ? __defProp(target, "default", { value: mod, enumerable: true }) : target,
  mod
));
var __toCommonJS = (mod) => __copyProps(__defProp({}, "__esModule", { value: true }), mod);

// lazy-external:better-sqlite3
var require_better_sqlite3 = __commonJS({
  "lazy-external:better-sqlite3"(exports2, module2) {
    "use strict";
    var _cr = require("module").createRequire(typeof __filename !== "undefined" ? __filename : __dirname + "/index.js");
    module2.exports = _cr("better-sqlite3");
  }
});

// lazy-external:sqlite-vec
var require_sqlite_vec = __commonJS({
  "lazy-external:sqlite-vec"(exports2, module2) {
    "use strict";
    var _cr = require("module").createRequire(typeof __filename !== "undefined" ? __filename : __dirname + "/index.js");
    module2.exports = _cr("sqlite-vec");
  }
});

// node_modules/.pnpm/ulid@3.0.2/node_modules/ulid/dist/node/index.cjs
var require_node = __commonJS({
  "node_modules/.pnpm/ulid@3.0.2/node_modules/ulid/dist/node/index.cjs"(exports2) {
    "use strict";
    var crypto2 = require("node:crypto");
    var B32_CHARACTERS = "0123456789ABCDEFGHJKMNPQRSTVWXYZ";
    var ENCODING = "0123456789ABCDEFGHJKMNPQRSTVWXYZ";
    var ENCODING_LEN = 32;
    var MAX_ULID = "7ZZZZZZZZZZZZZZZZZZZZZZZZZ";
    var MIN_ULID = "00000000000000000000000000";
    var RANDOM_LEN = 16;
    var TIME_LEN = 10;
    var TIME_MAX = 281474976710655;
    var ULID_REGEX = /^[0-7][0-9a-hjkmnp-tv-zA-HJKMNP-TV-Z]{25}$/;
    var UUID_REGEX = /^[0-9a-fA-F]{8}-(?:[0-9a-fA-F]{4}-){3}[0-9a-fA-F]{12}$/;
    exports2.ULIDErrorCode = void 0;
    (function(ULIDErrorCode) {
      ULIDErrorCode["Base32IncorrectEncoding"] = "B32_ENC_INVALID";
      ULIDErrorCode["DecodeTimeInvalidCharacter"] = "DEC_TIME_CHAR";
      ULIDErrorCode["DecodeTimeValueMalformed"] = "DEC_TIME_MALFORMED";
      ULIDErrorCode["EncodeTimeNegative"] = "ENC_TIME_NEG";
      ULIDErrorCode["EncodeTimeSizeExceeded"] = "ENC_TIME_SIZE_EXCEED";
      ULIDErrorCode["EncodeTimeValueMalformed"] = "ENC_TIME_MALFORMED";
      ULIDErrorCode["PRNGDetectFailure"] = "PRNG_DETECT";
      ULIDErrorCode["ULIDInvalid"] = "ULID_INVALID";
      ULIDErrorCode["Unexpected"] = "UNEXPECTED";
      ULIDErrorCode["UUIDInvalid"] = "UUID_INVALID";
    })(exports2.ULIDErrorCode || (exports2.ULIDErrorCode = {}));
    var ULIDError = class extends Error {
      constructor(errorCode, message) {
        super(`${message} (${errorCode})`);
        this.name = "ULIDError";
        this.code = errorCode;
      }
    };
    function randomChar(prng) {
      const randomPosition = Math.floor(prng() * ENCODING_LEN) % ENCODING_LEN;
      return ENCODING.charAt(randomPosition);
    }
    function replaceCharAt(str, index, char) {
      if (index > str.length - 1) {
        return str;
      }
      return str.substr(0, index) + char + str.substr(index + 1);
    }
    function crockfordEncode(input) {
      const output = [];
      let bitsRead = 0;
      let buffer = 0;
      const reversedInput = new Uint8Array(input.slice().reverse());
      for (const byte of reversedInput) {
        buffer |= byte << bitsRead;
        bitsRead += 8;
        while (bitsRead >= 5) {
          output.unshift(buffer & 31);
          buffer >>>= 5;
          bitsRead -= 5;
        }
      }
      if (bitsRead > 0) {
        output.unshift(buffer & 31);
      }
      return output.map((byte) => B32_CHARACTERS.charAt(byte)).join("");
    }
    function crockfordDecode(input) {
      const sanitizedInput = input.toUpperCase().split("").reverse().join("");
      const output = [];
      let bitsRead = 0;
      let buffer = 0;
      for (const character of sanitizedInput) {
        const byte = B32_CHARACTERS.indexOf(character);
        if (byte === -1) {
          throw new Error(`Invalid base 32 character found in string: ${character}`);
        }
        buffer |= byte << bitsRead;
        bitsRead += 5;
        while (bitsRead >= 8) {
          output.unshift(buffer & 255);
          buffer >>>= 8;
          bitsRead -= 8;
        }
      }
      if (bitsRead >= 5 || buffer > 0) {
        output.unshift(buffer & 255);
      }
      return new Uint8Array(output);
    }
    function fixULIDBase32(id) {
      return id.replace(/i/gi, "1").replace(/l/gi, "1").replace(/o/gi, "0").replace(/-/g, "");
    }
    function incrementBase32(str) {
      let done = void 0, index = str.length, char, charIndex, output = str;
      const maxCharIndex = ENCODING_LEN - 1;
      while (!done && index-- >= 0) {
        char = output[index];
        charIndex = ENCODING.indexOf(char);
        if (charIndex === -1) {
          throw new ULIDError(exports2.ULIDErrorCode.Base32IncorrectEncoding, "Incorrectly encoded string");
        }
        if (charIndex === maxCharIndex) {
          output = replaceCharAt(output, index, ENCODING[0]);
          continue;
        }
        done = replaceCharAt(output, index, ENCODING[charIndex + 1]);
      }
      if (typeof done === "string") {
        return done;
      }
      throw new ULIDError(exports2.ULIDErrorCode.Base32IncorrectEncoding, "Failed incrementing string");
    }
    function decodeTime(id) {
      if (id.length !== TIME_LEN + RANDOM_LEN) {
        throw new ULIDError(exports2.ULIDErrorCode.DecodeTimeValueMalformed, "Malformed ULID");
      }
      const time = id.substr(0, TIME_LEN).toUpperCase().split("").reverse().reduce((carry, char, index) => {
        const encodingIndex = ENCODING.indexOf(char);
        if (encodingIndex === -1) {
          throw new ULIDError(exports2.ULIDErrorCode.DecodeTimeInvalidCharacter, `Time decode error: Invalid character: ${char}`);
        }
        return carry += encodingIndex * Math.pow(ENCODING_LEN, index);
      }, 0);
      if (time > TIME_MAX) {
        throw new ULIDError(exports2.ULIDErrorCode.DecodeTimeValueMalformed, `Malformed ULID: timestamp too large: ${time}`);
      }
      return time;
    }
    function detectPRNG(root) {
      const rootLookup = detectRoot();
      const globalCrypto = rootLookup && (rootLookup.crypto || rootLookup.msCrypto) || (typeof crypto2 !== "undefined" ? crypto2 : null);
      if (typeof globalCrypto?.getRandomValues === "function") {
        return () => {
          const buffer = new Uint8Array(1);
          globalCrypto.getRandomValues(buffer);
          return buffer[0] / 256;
        };
      } else if (typeof globalCrypto?.randomBytes === "function") {
        return () => globalCrypto.randomBytes(1).readUInt8() / 256;
      } else if (crypto2?.randomBytes) {
        return () => crypto2.randomBytes(1).readUInt8() / 256;
      }
      throw new ULIDError(exports2.ULIDErrorCode.PRNGDetectFailure, "Failed to find a reliable PRNG");
    }
    function detectRoot() {
      if (inWebWorker())
        return self;
      if (typeof window !== "undefined") {
        return window;
      }
      if (typeof global !== "undefined") {
        return global;
      }
      if (typeof globalThis !== "undefined") {
        return globalThis;
      }
      return null;
    }
    function encodeRandom(len, prng) {
      let str = "";
      for (; len > 0; len--) {
        str = randomChar(prng) + str;
      }
      return str;
    }
    function encodeTime(now, len = TIME_LEN) {
      if (isNaN(now)) {
        throw new ULIDError(exports2.ULIDErrorCode.EncodeTimeValueMalformed, `Time must be a number: ${now}`);
      } else if (now > TIME_MAX) {
        throw new ULIDError(exports2.ULIDErrorCode.EncodeTimeSizeExceeded, `Cannot encode a time larger than ${TIME_MAX}: ${now}`);
      } else if (now < 0) {
        throw new ULIDError(exports2.ULIDErrorCode.EncodeTimeNegative, `Time must be positive: ${now}`);
      } else if (Number.isInteger(now) === false) {
        throw new ULIDError(exports2.ULIDErrorCode.EncodeTimeValueMalformed, `Time must be an integer: ${now}`);
      }
      let mod, str = "";
      for (let currentLen = len; currentLen > 0; currentLen--) {
        mod = now % ENCODING_LEN;
        str = ENCODING.charAt(mod) + str;
        now = (now - mod) / ENCODING_LEN;
      }
      return str;
    }
    function inWebWorker() {
      return typeof WorkerGlobalScope !== "undefined" && self instanceof WorkerGlobalScope;
    }
    function isValid(id) {
      return typeof id === "string" && id.length === TIME_LEN + RANDOM_LEN && id.toUpperCase().split("").every((char) => ENCODING.indexOf(char) !== -1);
    }
    function monotonicFactory2(prng) {
      const currentPRNG = prng || detectPRNG();
      let lastTime = 0, lastRandom;
      return function _ulid(seedTime) {
        const seed = !seedTime || isNaN(seedTime) ? Date.now() : seedTime;
        if (seed <= lastTime) {
          const incrementedRandom = lastRandom = incrementBase32(lastRandom);
          return encodeTime(lastTime, TIME_LEN) + incrementedRandom;
        }
        lastTime = seed;
        const newRandom = lastRandom = encodeRandom(RANDOM_LEN, currentPRNG);
        return encodeTime(seed, TIME_LEN) + newRandom;
      };
    }
    function ulid2(seedTime, prng) {
      const currentPRNG = prng || detectPRNG();
      const seed = !seedTime || isNaN(seedTime) ? Date.now() : seedTime;
      return encodeTime(seed, TIME_LEN) + encodeRandom(RANDOM_LEN, currentPRNG);
    }
    function ulidToUUID(ulid3) {
      const isValid2 = ULID_REGEX.test(ulid3);
      if (!isValid2) {
        throw new ULIDError(exports2.ULIDErrorCode.ULIDInvalid, `Invalid ULID: ${ulid3}`);
      }
      const uint8Array = crockfordDecode(ulid3);
      let uuid = Array.from(uint8Array).map((byte) => byte.toString(16).padStart(2, "0")).join("");
      uuid = uuid.substring(0, 8) + "-" + uuid.substring(8, 12) + "-" + uuid.substring(12, 16) + "-" + uuid.substring(16, 20) + "-" + uuid.substring(20);
      return uuid.toUpperCase();
    }
    function uuidToULID(uuid) {
      const isValid2 = UUID_REGEX.test(uuid);
      if (!isValid2) {
        throw new ULIDError(exports2.ULIDErrorCode.UUIDInvalid, `Invalid UUID: ${uuid}`);
      }
      const bytes = uuid.replace(/-/g, "").match(/.{1,2}/g);
      if (!bytes) {
        throw new ULIDError(exports2.ULIDErrorCode.Unexpected, `Failed parsing UUID bytes: ${uuid}`);
      }
      const uint8Array = new Uint8Array(bytes.map((byte) => parseInt(byte, 16)));
      return crockfordEncode(uint8Array);
    }
    exports2.MAX_ULID = MAX_ULID;
    exports2.MIN_ULID = MIN_ULID;
    exports2.TIME_LEN = TIME_LEN;
    exports2.TIME_MAX = TIME_MAX;
    exports2.ULIDError = ULIDError;
    exports2.decodeTime = decodeTime;
    exports2.encodeTime = encodeTime;
    exports2.fixULIDBase32 = fixULIDBase32;
    exports2.incrementBase32 = incrementBase32;
    exports2.isValid = isValid;
    exports2.monotonicFactory = monotonicFactory2;
    exports2.ulid = ulid2;
    exports2.ulidToUUID = ulidToUUID;
    exports2.uuidToULID = uuidToULID;
  }
});

// extensions/mcp-servers/memory-server/src/index.ts
var index_exports = {};
__export(index_exports, {
  buildCtxFromEnv: () => buildCtxFromEnv,
  compilePolicyFromEnv: () => compilePolicyFromEnv,
  handleToolCall: () => handleToolCall,
  memoryRecallHandler: () => memoryRecallHandler,
  memoryWriteHandler: () => memoryWriteHandler
});
module.exports = __toCommonJS(index_exports);
var import_node_readline = require("node:readline");
var path4 = __toESM(require("node:path"));
var os = __toESM(require("node:os"));

// extensions/mcp-servers/memory-server/src/db.ts
var import_better_sqlite3 = __toESM(require_better_sqlite3());
var sqliteVec = __toESM(require_sqlite_vec());
var path = __toESM(require("node:path"));
var fs = __toESM(require("node:fs"));

// extensions/mcp-servers/memory-server/src/schema.ts
var PRAGMAS = `
PRAGMA journal_mode = WAL;
PRAGMA busy_timeout = 5000;
PRAGMA synchronous  = NORMAL;
PRAGMA foreign_keys = ON;
PRAGMA cache_size   = -64000;
`;
var DDL = `
-- scope metadata (one row)
CREATE TABLE IF NOT EXISTS memory_scope (
  scope        TEXT PRIMARY KEY CHECK (scope IN ('project','user','org','local')),
  scope_id     TEXT NOT NULL,
  embed_model  TEXT NOT NULL,
  embed_dim    INTEGER NOT NULL,
  schema_ver   INTEGER NOT NULL DEFAULT 1,
  created_at   TEXT NOT NULL
);

-- nodes (Episode/Entity/Claim/Community/Session unified)
CREATE TABLE IF NOT EXISTS node (
  rowid        INTEGER PRIMARY KEY,
  uid          TEXT UNIQUE NOT NULL,
  kind         TEXT NOT NULL CHECK (kind IN ('episode','entity','claim','community','session')),
  content      TEXT, name TEXT, summary TEXT,
  agent_id     TEXT,
  session_id   TEXT,
  source       TEXT CHECK (source IN ('message','tool_output','observation','document','reflection','import')),
  importance   REAL DEFAULT 1.0,
  confidence   REAL,
  content_hash TEXT,
  level        INTEGER,
  resume_state TEXT,
  t_created    TEXT NOT NULL, t_occurred TEXT,
  t_valid      TEXT,  t_invalid TEXT,
  last_access  TEXT,  access_count INTEGER DEFAULT 0
);
CREATE INDEX IF NOT EXISTS ix_node_kind       ON node(kind);
CREATE INDEX IF NOT EXISTS ix_node_hash       ON node(content_hash);
CREATE INDEX IF NOT EXISTS ix_node_agent      ON node(agent_id);
CREATE INDEX IF NOT EXISTS ix_node_session    ON node(session_id);
CREATE INDEX IF NOT EXISTS ix_node_validity   ON node(t_invalid) WHERE t_invalid IS NULL;
CREATE INDEX IF NOT EXISTS ix_node_importance ON node(importance);
CREATE INDEX IF NOT EXISTS ix_node_temporal   ON node(t_invalid, t_created DESC) WHERE t_invalid IS NULL;

-- edges (bi-temporal)
CREATE TABLE IF NOT EXISTS edge (
  rowid     INTEGER PRIMARY KEY,
  src       INTEGER NOT NULL REFERENCES node(rowid) ON DELETE CASCADE,
  dst       INTEGER NOT NULL REFERENCES node(rowid) ON DELETE CASCADE,
  rel       TEXT NOT NULL CHECK (rel IN
              ('MENTIONS','SUPPORTS','RELATES_TO','SUPERSEDES','DERIVED_FROM','MEMBER_OF','PART_OF','SAME_AS')),
  weight     REAL DEFAULT 1.0, confidence REAL,
  origin     TEXT CHECK (origin IN ('extracted','inferred','user_asserted')),
  t_created  TEXT NOT NULL, t_expired TEXT,
  t_valid    TEXT,          t_invalid TEXT,
  meta       TEXT
);
CREATE INDEX IF NOT EXISTS ix_edge_src  ON edge(src, rel) WHERE t_expired IS NULL;
CREATE INDEX IF NOT EXISTS ix_edge_dst  ON edge(dst, rel) WHERE t_expired IS NULL;
CREATE INDEX IF NOT EXISTS ix_edge_live ON edge(t_invalid) WHERE t_invalid IS NULL;

-- vec0 virtual table (dim from embed_model: 768 for nomic)
CREATE VIRTUAL TABLE IF NOT EXISTS vec_node USING vec0(node_id INTEGER PRIMARY KEY, embedding FLOAT[768]);

-- FTS5 virtual table
CREATE VIRTUAL TABLE IF NOT EXISTS fts_node USING fts5(content, name, summary,
  content='node', content_rowid='rowid', tokenize='unicode61');

-- organizer work queue
CREATE TABLE IF NOT EXISTS organizer_queue (
  seq        INTEGER PRIMARY KEY AUTOINCREMENT,
  op         TEXT NOT NULL CHECK (op IN ('ingest','extract','link','consolidate','decay','reindex')),
  payload    TEXT NOT NULL,
  priority   INTEGER NOT NULL DEFAULT 100,
  enqueued   TEXT NOT NULL, claimed_at TEXT, done_at TEXT,
  attempts   INTEGER DEFAULT 0
);
CREATE INDEX IF NOT EXISTS ix_q_open ON organizer_queue(done_at, priority, seq) WHERE done_at IS NULL;

-- scope-promotion candidates (internal detail; surfaced via host ScopePromotionProposed event)
CREATE TABLE IF NOT EXISTS promotion_queue (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  node_uid      TEXT NOT NULL, from_scope TEXT NOT NULL, to_scope TEXT NOT NULL,
  occurrences   INTEGER NOT NULL, first_seen TEXT NOT NULL, age_days INTEGER NOT NULL,
  status        TEXT NOT NULL DEFAULT 'pending'
                  CHECK (status IN ('pending','proposed','approved','rejected','applied')),
  decided_by    TEXT, decided_at TEXT
);
`;
var FTS_TRIGGERS = `
CREATE TRIGGER IF NOT EXISTS fts_node_ai AFTER INSERT ON node BEGIN
  INSERT INTO fts_node(rowid, content, name, summary)
    VALUES (new.rowid, new.content, new.name, new.summary);
END;
CREATE TRIGGER IF NOT EXISTS fts_node_ad AFTER DELETE ON node BEGIN
  INSERT INTO fts_node(fts_node, rowid, content, name, summary)
    VALUES ('delete', old.rowid, old.content, old.name, old.summary);
END;
CREATE TRIGGER IF NOT EXISTS fts_node_au AFTER UPDATE ON node BEGIN
  INSERT INTO fts_node(fts_node, rowid, content, name, summary)
    VALUES ('delete', old.rowid, old.content, old.name, old.summary);
  INSERT INTO fts_node(rowid, content, name, summary)
    VALUES (new.rowid, new.content, new.name, new.summary);
END;
`;

// extensions/mcp-servers/memory-server/src/embed.ts
var EMBED_DIM = 768;
var providerCallCount = 0;
function getProviderCallCount() {
  return providerCallCount;
}
function embedText(text) {
  const normalized = text.toLowerCase().replace(/[^\w\s]/g, " ").trim();
  const tokens = normalized.split(/\s+/).filter(Boolean);
  const vec = new Float32Array(EMBED_DIM);
  for (const token of tokens) {
    const h1 = hash32(token, 2166136261);
    const h2 = hash32(token, 16777619);
    for (let d = 0; d < EMBED_DIM; d++) {
      const seed = d * 2654435769 + h1 >>> 0;
      const val = (seed ^ h2) / 2147483648 - 1;
      vec[d] = vec[d] + val / Math.max(tokens.length, 1);
    }
  }
  let norm = 0;
  for (let d = 0; d < EMBED_DIM; d++) {
    norm += vec[d] * vec[d];
  }
  norm = Math.sqrt(norm) || 1;
  for (let d = 0; d < EMBED_DIM; d++) {
    vec[d] = vec[d] / norm;
  }
  return vec;
}
function vecToJson(vec) {
  const arr = Array.from(vec);
  return "[" + arr.map((v) => v.toFixed(8)).join(",") + "]";
}
function hash32(str, basis) {
  let h = basis >>> 0;
  for (let i = 0; i < str.length; i++) {
    h ^= str.charCodeAt(i);
    h = Math.imul(h, 16777619) >>> 0;
  }
  return h;
}

// extensions/mcp-servers/memory-server/src/db.ts
function openDb(dbPath) {
  const dir = path.dirname(dbPath);
  fs.mkdirSync(dir, { recursive: true });
  const db = new import_better_sqlite3.default(dbPath);
  sqliteVec.load(db);
  for (const pragma of PRAGMAS.trim().split("\n").filter(Boolean)) {
    const line = pragma.trim();
    if (line) db.exec(line);
  }
  db.exec(DDL);
  db.exec(FTS_TRIGGERS);
  return db;
}

// extensions/mcp-servers/memory-server/src/write.ts
var crypto = __toESM(require("node:crypto"));
var import_ulid = __toESM(require_node());

// extensions/mcp-servers/memory-server/src/memoryd.ts
var net = __toESM(require("node:net"));
var path2 = __toESM(require("node:path"));
var import_better_sqlite32 = __toESM(require_better_sqlite3());
var sqliteVec2 = __toESM(require_sqlite_vec());
var SOCKET_PATH = path2.join(process.env["HOME"] ?? "/tmp", ".memory", "memoryd.sock");
function enqueueIngest(db, uid, scope, agentId) {
  const now = (/* @__PURE__ */ new Date()).toISOString();
  const payload = JSON.stringify({ uid, scope, agent_id: agentId });
  const priority = scope === "project" ? 0 : agentId ? 1 : 2;
  db.prepare(
    `INSERT INTO organizer_queue (op, payload, priority, enqueued)
     VALUES ('ingest', ?, ?, ?)`
  ).run(payload, priority, now);
}
function nudgeDaemon() {
  try {
    const client = net.createConnection(SOCKET_PATH);
    client.on("connect", () => {
      client.write("nudge");
      client.end();
    });
    client.on("error", () => {
    });
  } catch {
  }
}

// extensions/mcp-servers/memory-server/src/write.ts
var ulid = (0, import_ulid.monotonicFactory)();
function memoryWrite(db, params) {
  const {
    content,
    session_id,
    t_occurred,
    agent_id,
    source = "message",
    importance = 1,
    // default; organizer will update via LLM scoring
    scope = "project"
  } = params;
  if (!content || !content.trim()) {
    return { code: "E_SCOPE_RO", message: "content must not be empty" };
  }
  const normalized = content.trim().toLowerCase();
  const contentHash = crypto.createHash("sha256").update(normalized).digest("hex");
  const existing = db.prepare("SELECT uid FROM node WHERE content_hash = ?").get(contentHash);
  if (existing) {
    return {
      code: "E_DEDUP",
      message: `Duplicate content: ${contentHash}`,
      existing_uid: existing.uid
    };
  }
  const uid = ulid();
  const now = (/* @__PURE__ */ new Date()).toISOString();
  const tValid = now;
  const tOccurred = t_occurred ?? now;
  const embeddingVec = embedText(content);
  const embeddingJson = vecToJson(embeddingVec);
  const tx = db.transaction(() => {
    const result = db.prepare(
      `INSERT INTO node (uid, kind, content, agent_id, session_id, source, importance,
                         content_hash, t_created, t_occurred, t_valid)
       VALUES (?, 'episode', ?, ?, ?, ?, ?, ?, ?, ?, ?)
       RETURNING rowid`
    ).get(
      uid,
      content,
      agent_id ?? null,
      session_id ?? null,
      source,
      importance,
      contentHash,
      now,
      tOccurred,
      tValid
    );
    if (!result) throw new Error("Insert failed: no rowid returned");
    const rowid = result.rowid;
    db.prepare("INSERT INTO vec_node(node_id, embedding) VALUES (CAST(? AS INTEGER), ?)").run(
      rowid,
      embeddingJson
    );
    enqueueIngest(db, uid, scope, agent_id ?? null);
    return uid;
  });
  const episodeUid = tx();
  nudgeDaemon();
  return { episode_uid: episodeUid };
}

// extensions/mcp-servers/memory-server/src/recall.ts
var path3 = __toESM(require("node:path"));
var RRF_K = 60;
var RECENCY_DECAY_PER_HOUR = 0.995;
var DEFAULT_TOKEN_BUDGET = 4e3;
var DEFAULT_DEPTH = 1;
var KNN_LIMIT = 20;
var FTS_LIMIT = 20;
function estimateTokens(text) {
  return Math.ceil(text.length / 4);
}
function recencyMultiplier(tCreated) {
  if (!tCreated) return 1;
  const ageMs = Date.now() - new Date(tCreated).getTime();
  const ageHours = ageMs / (1e3 * 60 * 60);
  return Math.pow(RECENCY_DECAY_PER_HOUR, ageHours);
}
function rrfScore(rank) {
  return 1 / (RRF_K + rank);
}
function memoryRecall(db, scope, params) {
  const {
    query,
    agent_id,
    as_of,
    token_budget = DEFAULT_TOKEN_BUDGET,
    depth = DEFAULT_DEPTH,
    limit = 10
  } = params;
  const beforeCount = getProviderCallCount();
  const queryVec = embedText(query);
  const queryVecJson = vecToJson(queryVec);
  const validityPred = as_of ? `(n.t_valid IS NULL OR n.t_valid <= '${as_of}') AND (n.t_invalid IS NULL OR n.t_invalid > '${as_of}')` : "n.t_invalid IS NULL";
  const agentFilter = agent_id ? `AND n.agent_id = '${agent_id.replace(/'/g, "''")}'` : "";
  const vecRows = db.prepare(
    `SELECT v.node_id, v.distance
       FROM vec_node v
       WHERE v.embedding MATCH ? AND k = ?
       ORDER BY v.distance`
  ).all(queryVecJson, KNN_LIMIT);
  const vecRanks = /* @__PURE__ */ new Map();
  vecRows.forEach((r, i) => vecRanks.set(r.node_id, i + 1));
  const ftsQuery = query.replace(/['"*\-+]/g, " ").trim().split(/\s+/).filter((t) => t.length > 1).join(" ");
  const ftsRowids = /* @__PURE__ */ new Map();
  if (ftsQuery) {
    try {
      const ftsRows = db.prepare(
        `SELECT rowid, rank FROM fts_node WHERE fts_node MATCH ? ORDER BY rank LIMIT ?`
      ).all(ftsQuery, FTS_LIMIT);
      ftsRows.forEach((r, i) => ftsRowids.set(r.rowid, i + 1));
    } catch {
    }
  }
  const temporalRows = db.prepare(
    `SELECT n.rowid, n.t_created FROM node n
       WHERE ${validityPred} ${agentFilter}
       ORDER BY n.t_created DESC LIMIT ?`
  ).all(KNN_LIMIT);
  const temporalRanks = /* @__PURE__ */ new Map();
  temporalRows.forEach((r, i) => temporalRanks.set(r.rowid, i + 1));
  const allRowids = /* @__PURE__ */ new Set([
    ...vecRanks.keys(),
    ...ftsRowids.keys(),
    ...temporalRanks.keys()
  ]);
  if (allRowids.size === 0) {
    return { results: [], provider_call_count: 0 };
  }
  const rrfScores = /* @__PURE__ */ new Map();
  for (const rowid of allRowids) {
    let score = 0;
    const vr = vecRanks.get(rowid);
    const fr = ftsRowids.get(rowid);
    const tr = temporalRanks.get(rowid);
    if (vr !== void 0) score += rrfScore(vr);
    if (fr !== void 0) score += rrfScore(fr);
    if (tr !== void 0) score += rrfScore(tr);
    rrfScores.set(rowid, score);
  }
  const rowidList = [...allRowids].join(",");
  const nodes = db.prepare(
    `SELECT rowid, uid, content, name, summary, importance, t_created, t_valid, t_invalid, agent_id, content_hash
       FROM node WHERE rowid IN (${rowidList})`
  ).all();
  const validNodes = nodes.filter((n) => {
    if (as_of) {
      const validStart = !n.t_valid || n.t_valid <= as_of;
      const validEnd = !n.t_invalid || n.t_invalid > as_of;
      return validStart && validEnd;
    }
    return n.t_invalid === null;
  });
  const ranked = validNodes.map((n) => {
    const baseRrf = rrfScores.get(n.rowid) ?? 0;
    const recency = recencyMultiplier(n.t_created);
    const imp = (n.importance ?? 1) / 10;
    const finalScore = baseRrf * recency * (0.5 + 0.5 * imp);
    return { node: n, score: finalScore };
  });
  ranked.sort((a, b) => b.score - a.score);
  const topRowids = ranked.slice(0, limit).map((r) => r.node.rowid);
  const expandedRowids = new Set(topRowids);
  if (depth > 0 && topRowids.length > 0) {
    const validPred = as_of ? `(t_valid IS NULL OR t_valid <= '${as_of}') AND (t_invalid IS NULL OR t_invalid > '${as_of}')` : "t_invalid IS NULL";
    const neighborRows = db.prepare(
      `SELECT DISTINCT CASE WHEN src IN (${topRowids.join(",")}) THEN dst ELSE src END AS neighbor_id
         FROM edge
         WHERE (src IN (${topRowids.join(",")}) OR dst IN (${topRowids.join(",")}))
           AND t_expired IS NULL AND ${validPred}`
    ).all();
    neighborRows.forEach((r) => expandedRowids.add(r.neighbor_id));
  }
  const alreadyRanked = new Set(topRowids);
  const expandedNew = [...expandedRowids].filter((id) => !alreadyRanked.has(id));
  let expandedNodes = [];
  if (expandedNew.length > 0) {
    const nodeValidPred = as_of ? `(t_valid IS NULL OR t_valid <= '${as_of.replace(/'/g, "''")}') AND (t_invalid IS NULL OR t_invalid > '${as_of.replace(/'/g, "''")}')` : "t_invalid IS NULL";
    expandedNodes = db.prepare(
      `SELECT rowid, uid, content, name, summary, importance, t_created, t_valid, t_invalid, agent_id, content_hash
         FROM node WHERE rowid IN (${expandedNew.join(",")}) AND ${nodeValidPred}`
    ).all();
  }
  const results = [];
  let tokenCount = 0;
  const addResult = (node, score, provenance) => {
    const text = [node.content, node.name, node.summary].filter(Boolean).join(" ");
    const tokens = estimateTokens(text);
    if (tokenCount + tokens > token_budget && results.length > 0) return false;
    tokenCount += tokens;
    results.push({
      uid: node.uid,
      content: node.content,
      score,
      t_valid: node.t_valid,
      scope,
      provenance,
      importance: node.importance,
      content_hash: node.content_hash ?? null,
      agent_id: node.agent_id ?? null
    });
    return true;
  };
  for (const { node, score } of ranked) {
    const provenance = [];
    if (vecRanks.has(node.rowid)) provenance.push("vec");
    if (ftsRowids.has(node.rowid)) provenance.push("fts");
    if (temporalRanks.has(node.rowid)) provenance.push("temporal");
    if (!addResult(node, score, provenance)) break;
    if (results.length >= limit) break;
  }
  for (const node of expandedNodes) {
    if (results.length >= limit) break;
    const baseRrf = rrfScores.get(node.rowid) ?? 1e-3;
    const recency = recencyMultiplier(node.t_created);
    const imp = (node.importance ?? 1) / 10;
    const score = baseRrf * 0.5 * recency * (0.5 + 0.5 * imp);
    addResult(node, score, ["graph"]);
  }
  const afterCount = getProviderCallCount();
  const providerCallCount2 = afterCount - beforeCount;
  return { results, provider_call_count: providerCallCount2 };
}
var REGISTRY_PATH = path3.join(process.env["HOME"] ?? "/tmp", ".memory", "registry.json");

// extensions/mcp-servers/memory-server/src/index.ts
function expandTilde(p) {
  if (p === "~" || p.startsWith("~/")) {
    return os.homedir() + p.slice(1);
  }
  return p;
}
function globToRegex(pattern) {
  const expanded = expandTilde(pattern);
  let regexStr = "";
  let i = 0;
  while (i < expanded.length) {
    if (expanded[i] === "*" && expanded[i + 1] === "*") {
      regexStr += ".*";
      i += 2;
      if (expanded[i] === "/") i++;
    } else if (expanded[i] === "*") {
      regexStr += "[^/]*";
      i++;
    } else {
      const ch = expanded[i];
      regexStr += /[.+^${}()|[\]\\]/.test(ch) ? `\\${ch}` : ch;
      i++;
    }
  }
  return new RegExp(`^${regexStr}$`);
}
function matchGlob(pattern, absPath) {
  return globToRegex(pattern).test(absPath);
}
function normalizePath(p) {
  return path4.resolve(expandTilde(p));
}
function isPathAllowed(patterns, subject) {
  if (patterns === void 0) return true;
  const norm = normalizePath(subject);
  return patterns.some((p) => matchGlob(p, norm));
}
function compilePolicyFromEnv() {
  if (!process.env.SOX_PERM_ENFORCE) {
    return {
      enforced: false,
      allowsFsRead: () => true,
      allowsFsWrite: () => true
    };
  }
  function parseRaw(raw) {
    if (raw === void 0) return void 0;
    try {
      const parsed = JSON.parse(raw);
      if (Array.isArray(parsed)) return parsed;
    } catch {
    }
    return void 0;
  }
  const fsRead = parseRaw(process.env.SOX_PERM_FS_READ);
  const fsWrite = parseRaw(process.env.SOX_PERM_FS_WRITE);
  return {
    enforced: true,
    allowsFsRead: (absPath) => isPathAllowed(fsRead, absPath),
    allowsFsWrite: (absPath) => isPathAllowed(fsWrite, absPath)
  };
}
function buildCtxFromEnv() {
  const policy = compilePolicyFromEnv();
  return {
    enforced: policy.enforced,
    allowsFsRead: (p) => policy.allowsFsRead(p),
    allowsFsWrite: (p) => policy.allowsFsWrite(p),
    allowsNetwork: () => true,
    // network domain not used by memory-server
    allowsSocket: () => true
    // socket domain not used by memory-server
  };
}
function checkDbPathCtx(dbPath, ctx) {
  if (!ctx.enforced) return null;
  const resolved = path4.resolve(expandTilde(dbPath));
  if (!ctx.allowsFsWrite(resolved) || !ctx.allowsFsRead(resolved)) {
    return {
      isError: true,
      content: [{
        type: "text",
        text: `permission denied: db_path ${resolved} outside declared fs allowlist`
      }]
    };
  }
  return null;
}
function memoryWriteHandler(args, ctx) {
  const dbPath = args["db_path"];
  if (!dbPath) {
    return { isError: true, content: [{ type: "text", text: "db_path is required" }] };
  }
  const denied = checkDbPathCtx(dbPath, ctx);
  if (denied) return denied;
  const db = getDb(dbPath);
  const result = memoryWrite(db, {
    content: args["content"],
    session_id: args["session_id"],
    t_occurred: args["t_occurred"],
    agent_id: args["agent_id"],
    source: args["source"],
    importance: args["importance"]
  });
  return { content: [{ type: "text", text: JSON.stringify(result) }] };
}
function memoryRecallHandler(args, ctx) {
  const dbPath = args["db_path"];
  if (!dbPath) {
    return { isError: true, content: [{ type: "text", text: "db_path is required" }] };
  }
  const denied = checkDbPathCtx(dbPath, ctx);
  if (denied) return denied;
  const db = getDb(dbPath);
  const result = memoryRecall(db, args["scope"] ?? "project", {
    query: args["query"],
    agent_id: args["agent_id"],
    as_of: args["as_of"],
    token_budget: args["token_budget"],
    depth: args["depth"],
    limit: args["limit"]
  });
  return { content: [{ type: "text", text: JSON.stringify(result) }] };
}
var dbCache = /* @__PURE__ */ new Map();
function getDb(dbPath) {
  const cached = dbCache.get(dbPath);
  if (cached) return cached;
  const db = openDb(dbPath);
  dbCache.set(dbPath, db);
  return db;
}
var TOOLS = [
  {
    name: "memory_ping",
    description: "Health check \u2014 returns {ok:true} without accessing any database. Use to verify the server is running.",
    inputSchema: {
      type: "object",
      properties: {},
      required: []
    }
  },
  {
    name: "memory_write",
    description: "Write a memory episode to the store. Returns {episode_uid}. Enqueues organize; never blocks on LLM.",
    inputSchema: {
      type: "object",
      properties: {
        content: { type: "string", description: "The content to memorize" },
        db_path: { type: "string", description: "Path to the .db file" },
        session_id: { type: "string" },
        t_occurred: { type: "string", description: "ISO timestamp when this occurred" },
        agent_id: { type: "string" },
        source: {
          type: "string",
          enum: ["message", "tool_output", "observation", "document", "reflection", "import"]
        },
        importance: { type: "number", minimum: 1, maximum: 10 }
      },
      required: ["content", "db_path"]
    }
  },
  {
    name: "memory_recall",
    description: "Recall memories using hybrid vec+BM25+temporal search. <50ms, zero LLM. Returns ranked results.",
    inputSchema: {
      type: "object",
      properties: {
        query: { type: "string", description: "The query to recall" },
        db_path: { type: "string", description: "Path to the .db file" },
        scope: { type: "string", description: "Scope name (project/user/org/local)" },
        agent_id: { type: "string" },
        as_of: { type: "string", description: "ISO timestamp for point-in-time recall" },
        token_budget: { type: "number", default: 4e3 },
        depth: { type: "number", default: 1 },
        limit: { type: "number", default: 10 }
      },
      required: ["query", "db_path"]
    }
  },
  {
    name: "memory_search_entities",
    description: "Search for entities by name/type. Returns matching entity nodes.",
    inputSchema: {
      type: "object",
      properties: {
        query: { type: "string" },
        db_path: { type: "string" },
        entity_type: { type: "string" },
        limit: { type: "number", default: 10 }
      },
      required: ["query", "db_path"]
    }
  },
  {
    name: "memory_get_session_state",
    description: "Get session working memory state.",
    inputSchema: {
      type: "object",
      properties: {
        session_id: { type: "string" },
        db_path: { type: "string" }
      },
      required: ["session_id", "db_path"]
    }
  },
  {
    name: "memory_save_session_state",
    description: "Save session working memory state.",
    inputSchema: {
      type: "object",
      properties: {
        session_id: { type: "string" },
        state: { type: "object" },
        db_path: { type: "string" }
      },
      required: ["session_id", "state", "db_path"]
    }
  },
  {
    name: "memory_get_community",
    description: "Get community node for an entity.",
    inputSchema: {
      type: "object",
      properties: {
        entity_uid: { type: "string" },
        db_path: { type: "string" },
        level: { type: "number", default: 0 }
      },
      required: ["entity_uid", "db_path"]
    }
  },
  {
    name: "memory_invalidate",
    description: "Invalidate a claim (bi-temporal: sets t_invalid, never deletes).",
    inputSchema: {
      type: "object",
      properties: {
        claim_uid: { type: "string" },
        reason: { type: "string" },
        db_path: { type: "string" },
        t_transition: { type: "string" },
        replacement_uid: { type: "string" }
      },
      required: ["claim_uid", "reason", "db_path"]
    }
  }
];
function handleToolCall(name, args) {
  if (name === "memory_ping") {
    return { content: [{ type: "text", text: '{"ok":true}' }] };
  }
  const dbPath = args["db_path"];
  if (!dbPath) {
    return { isError: true, content: [{ type: "text", text: "db_path is required" }] };
  }
  const ctx = buildCtxFromEnv();
  if (name === "memory_write") return memoryWriteHandler(args, ctx);
  if (name === "memory_recall") return memoryRecallHandler(args, ctx);
  const policyDenied = checkDbPathCtx(dbPath, ctx);
  if (policyDenied) return policyDenied;
  const db = getDb(dbPath);
  switch (name) {
    case "memory_search_entities": {
      const query = args["query"];
      const limit = args["limit"] ?? 10;
      const rows = db.prepare(
        `SELECT uid, name, kind, summary, importance FROM node
           WHERE kind = 'entity' AND (name LIKE ? OR summary LIKE ?)
             AND t_invalid IS NULL
           ORDER BY importance DESC LIMIT ?`
      ).all(`%${query}%`, `%${query}%`, limit);
      return {
        content: [{ type: "text", text: JSON.stringify({ entities: rows }) }]
      };
    }
    case "memory_get_session_state": {
      const sessionId = args["session_id"];
      const row = db.prepare(
        `SELECT resume_state FROM node WHERE kind = 'session' AND session_id = ? AND t_invalid IS NULL`
      ).get(sessionId);
      const state = row?.resume_state ? JSON.parse(row.resume_state) : null;
      return {
        content: [{ type: "text", text: JSON.stringify({ state }) }]
      };
    }
    case "memory_save_session_state": {
      const sessionId = args["session_id"];
      const state = JSON.stringify(args["state"]);
      const now = (/* @__PURE__ */ new Date()).toISOString();
      const uid = `session-${sessionId}-${now}`;
      db.transaction(() => {
        db.prepare(
          `UPDATE node SET t_invalid = ? WHERE kind = 'session' AND session_id = ? AND t_invalid IS NULL`
        ).run(now, sessionId);
        db.prepare(
          `INSERT INTO node (uid, kind, session_id, resume_state, t_created, t_valid)
           VALUES (?, 'session', ?, ?, ?, ?)`
        ).run(uid, sessionId, state, now, now);
      })();
      return {
        content: [{ type: "text", text: JSON.stringify({ ok: true }) }]
      };
    }
    case "memory_get_community": {
      const entityUid = args["entity_uid"];
      const level = args["level"] ?? 0;
      const row = db.prepare(
        `SELECT n2.uid, n2.name, n2.summary, n2.level
           FROM node n1
           JOIN edge e ON e.src = n1.rowid AND e.rel = 'MEMBER_OF' AND e.t_invalid IS NULL
           JOIN node n2 ON n2.rowid = e.dst AND n2.kind = 'community' AND n2.level = ? AND n2.t_invalid IS NULL
           WHERE n1.uid = ? AND n1.t_invalid IS NULL`
      ).get(level, entityUid);
      if (!row) {
        return {
          isError: true,
          content: [{ type: "text", text: JSON.stringify({ code: "E_NOT_FOUND", entity_uid: entityUid }) }]
        };
      }
      return {
        content: [{ type: "text", text: JSON.stringify({ community: row }) }]
      };
    }
    case "memory_invalidate": {
      const claimUid = args["claim_uid"];
      const reason = args["reason"];
      const tTransition = args["t_transition"] ?? (/* @__PURE__ */ new Date()).toISOString();
      const replacementUid = args["replacement_uid"];
      const claim = db.prepare(`SELECT rowid FROM node WHERE uid = ? AND t_invalid IS NULL`).get(claimUid);
      if (!claim) {
        return {
          isError: true,
          content: [{ type: "text", text: JSON.stringify({ code: "E_NOT_FOUND", claim_uid: claimUid }) }]
        };
      }
      let supersedgesEdgeUid;
      db.transaction(() => {
        db.prepare(`UPDATE node SET t_invalid = ? WHERE uid = ?`).run(tTransition, claimUid);
        if (replacementUid) {
          const replacement = db.prepare(`SELECT rowid FROM node WHERE uid = ? AND t_invalid IS NULL`).get(replacementUid);
          if (replacement) {
            supersedgesEdgeUid = `sup-${Date.now()}`;
            db.prepare(
              `INSERT INTO edge (src, dst, rel, origin, t_created, meta)
               VALUES (?, ?, 'SUPERSEDES', 'user_asserted', ?, ?)`
            ).run(replacement.rowid, claim.rowid, tTransition, JSON.stringify({ reason }));
          }
        }
      })();
      return {
        content: [{
          type: "text",
          text: JSON.stringify({ ok: true, supersedes_edge_uid: supersedgesEdgeUid })
        }]
      };
    }
    default:
      return {
        isError: true,
        content: [{ type: "text", text: `Unknown tool: ${name}` }]
      };
  }
}
async function handleRequest(req) {
  const { method, id, params } = req;
  if (method === "initialize") {
    return {
      jsonrpc: "2.0",
      id,
      result: {
        protocolVersion: "2024-11-05",
        capabilities: { tools: {} },
        serverInfo: { name: "memory-server", version: "0.1.0" }
      }
    };
  }
  if (method === "tools/list") {
    return {
      jsonrpc: "2.0",
      id,
      result: { tools: TOOLS }
    };
  }
  if (method === "tools/call") {
    const p = params;
    const args = p.arguments ?? {};
    const toolResult = handleToolCall(p.name, args);
    return {
      jsonrpc: "2.0",
      id,
      result: toolResult
    };
  }
  return {
    jsonrpc: "2.0",
    id,
    error: { code: -32601, message: `Method not found: ${method}` }
  };
}
process.stderr.write("[serve] real-path: " + __dirname + "\n");
var rl = (0, import_node_readline.createInterface)({ input: process.stdin, crlfDelay: Infinity });
rl.on("line", (line) => {
  const trimmed = line.trim();
  if (!trimmed) return;
  void (async () => {
    try {
      const req = JSON.parse(trimmed);
      const res = await handleRequest(req);
      process.stdout.write(JSON.stringify(res) + "\n");
    } catch (e) {
      process.stdout.write(
        JSON.stringify({ jsonrpc: "2.0", error: { code: -32700, message: String(e) } }) + "\n"
      );
    }
  })();
});
// Annotate the CommonJS export names for ESM import in node:
0 && (module.exports = {
  buildCtxFromEnv,
  compilePolicyFromEnv,
  handleToolCall,
  memoryRecallHandler,
  memoryWriteHandler
});
//# sourceMappingURL=index.js.map
