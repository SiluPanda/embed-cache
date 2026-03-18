# embed-cache — Task Breakdown

This file tracks all tasks required to implement `embed-cache` per SPEC.md. Tasks are grouped into phases matching the implementation roadmap.

---

## Phase 1: Project Setup and Scaffolding

- [ ] **Install dev dependencies** — Add `typescript`, `vitest`, `eslint`, `@types/node`, `@types/better-sqlite3`, and `ioredis-mock` as devDependencies in package.json. | Status: not_done
- [ ] **Add peer dependencies** — Declare `better-sqlite3` (^9.0.0) and `ioredis` (^5.0.0) as optional peerDependencies in package.json with `peerDependenciesMeta` marking them optional. | Status: not_done
- [ ] **Configure CLI binary** — Add `"bin": { "embed-cache": "dist/cli.js" }` to package.json so the CLI is available after global install or via npx. | Status: not_done
- [ ] **Add test and build scripts** — Ensure `npm run test`, `npm run lint`, `npm run build`, `npm run test:integration`, and `npm run bench` scripts are defined in package.json. | Status: not_done
- [ ] **Create directory structure** — Create `src/backends/`, `src/__tests__/`, `src/__tests__/backends/`, `src/__tests__/integration/`, and `src/__benchmarks__/` directories. | Status: not_done

---

## Phase 2: Core Types (src/types.ts)

- [ ] **Define EmbedderFn type** — `type EmbedderFn = (texts: string[]) => Promise<number[][]>`. A function accepting an array of texts and returning an array of embedding vectors in the same order. | Status: not_done
- [ ] **Define EmbedCacheOptions interface** — Include all required and optional fields: `embedder` (required), `model` (required), `storage` (default `'memory'`), `ttl`, `maxSize`, `modelPricePerMillion`, `algorithm` (`'sha256' | 'sha1' | 'md5'`, default `'sha256'`), `normalizeText` (default `true`). | Status: not_done
- [ ] **Define EmbedOptions interface** — Options for individual embed calls: `ttl?: number` (override default TTL) and `bypassCache?: boolean` (default false, skip cache and always call embedder). | Status: not_done
- [ ] **Define StorageBackendOption union type** — Support `'memory'`, `{ type: 'memory' }`, `{ type: 'filesystem'; path: string; debounceMs?: number }`, `{ type: 'filesystem-binary'; path: string }`, `{ type: 'sqlite'; path: string; walMode?: boolean }`, `{ type: 'redis'; url: string; keyPrefix?: string }`, and custom `StorageBackend` instances. | Status: not_done
- [ ] **Define StorageBackend interface** — Required methods: `get(key)`, `set(key, vector, options?)`, `has(key)`, `delete(key)`, `clear(options?)`, `keys()`, `size()`. Optional methods: `getMany?(keys)`, `setMany?(entries, options?)`, `flush?()`. All return Promises. | Status: not_done
- [ ] **Define CacheStats interface** — Fields: `totalRequests`, `hits`, `misses`, `hitRate`, `size`, `tokensEstimatedSaved`, `costEstimatedSaved`, `model`, `createdAt` (ISO 8601), `lastHitAt` (ISO 8601 or null), `lastMissAt` (ISO 8601 or null). | Status: not_done
- [ ] **Define CacheEntry internal type** — Internal type for stored entries containing: `vector: number[]`, `model: string`, `createdAt: number`, `accessedAt: number`, `ttl?: number`. | Status: not_done

---

## Phase 3: Text Normalization (src/normalize.ts)

- [ ] **Implement normalizeForKey function** — Apply Unicode NFC normalization, trim leading/trailing whitespace, and collapse internal whitespace runs (spaces, tabs, `\r\n`, `\r`) to a single space. Must be deterministic and idempotent. | Status: not_done
- [ ] **Ensure normalization is key-only** — The normalized form is used only for cache key computation. The original text must be passed to the embedder unchanged. Document this contract clearly. | Status: not_done
- [ ] **Write normalize.test.ts** — Test: trailing/leading whitespace trimmed, internal whitespace collapsed, NFC normalization applied, idempotent (normalize(normalize(x)) === normalize(x)), original text preserved for embedder. Edge cases: empty string, whitespace-only string, Unicode combining characters, mixed newlines (\r\n, \n, \r). | Status: not_done

---

## Phase 4: Key Derivation (src/key.ts)

- [ ] **Implement computeKey function** — Signature: `computeKey(text: string, model: string, algorithm: 'sha256' | 'sha1' | 'md5', normalize: boolean): string`. Uses `node:crypto` `createHash`. Key = hash of `normalizedText + "\x00" + canonicalModel`. Returns lowercase hex string. | Status: not_done
- [ ] **Implement model ID canonicalization** — Normalize known model aliases to canonical form: `text-embedding-3-small` -> `openai/text-embedding-3-small`, `text-embedding-3-large` -> `openai/text-embedding-3-large`, `text-embedding-ada-002` -> `openai/text-embedding-ada-002`, `embed-english-v3.0` -> `cohere/embed-english-v3.0`, `embed-multilingual-v3.0` -> `cohere/embed-multilingual-v3.0`. Unknown models pass through as-is, lowercased. | Status: not_done
- [ ] **Support configurable hash algorithm** — Support `sha256` (64-char hex, default), `sha1` (40-char hex), and `md5` (32-char hex). Validate that the algorithm string is one of the three allowed values. | Status: not_done
- [ ] **Use null byte separator** — Use `\x00` (null byte) between normalizedText and modelId to prevent collisions where text endings look like model ID prefixes. | Status: not_done
- [ ] **Write key.test.ts** — Test: same text + same model -> same key, different text -> different key, different model -> different key, model alias canonicalization, null byte prevents collision, sha1 produces 40-char key, md5 produces 32-char key, normalize=false uses raw text for hashing. | Status: not_done

---

## Phase 5: Stats Tracking (src/stats.ts)

- [ ] **Implement StatsTracker class** — Track `hits`, `misses`, `totalRequests`, `tokensEstimatedSaved`, `costEstimatedSaved`, `createdAt`, `lastHitAt`, `lastMissAt`. Provide `recordHit(text)`, `recordMiss()`, and `stats()` methods. | Status: not_done
- [ ] **Implement token estimation** — `estimatedTokens(text) = Math.ceil(text.length / 4)`. Add to `tokensEstimatedSaved` on each cache hit. | Status: not_done
- [ ] **Implement cost estimation** — `costEstimatedSaved = tokensEstimatedSaved / 1_000_000 * modelPricePerMillion`. Use built-in model prices for known models, or caller-provided `modelPricePerMillion`, or 0 for unknown models. | Status: not_done
- [ ] **Implement built-in model price map** — Map of canonical model IDs to price per million tokens: `openai/text-embedding-3-small` = 0.02, `openai/text-embedding-3-large` = 0.13, `openai/text-embedding-ada-002` = 0.10, `cohere/embed-english-v3.0` = 0.10, `cohere/embed-multilingual-v3.0` = 0.10. | Status: not_done
- [ ] **Implement hitRate calculation** — `hitRate = hits / totalRequests`. Return `NaN` if `totalRequests` is 0. | Status: not_done
- [ ] **Write stats.test.ts** — Test: initial stats all zeros, recordHit increments hits and tokensEstimatedSaved, recordMiss increments misses, hitRate is correct ratio, hitRate is NaN when totalRequests is 0, costEstimatedSaved computed correctly for known and unknown models, lastHitAt/lastMissAt timestamps update correctly. | Status: not_done

---

## Phase 6: In-Memory Storage Backend (src/backends/memory.ts)

- [ ] **Implement MemoryBackend class** — Implement `StorageBackend` interface using a JavaScript `Map<string, CacheEntry>`. Support all required methods: `get`, `set`, `has`, `delete`, `clear`, `keys`, `size`. | Status: not_done
- [ ] **Implement TTL expiry on read** — When `get` is called, check if `Date.now() - entry.createdAt > entry.ttl`. If expired, delete the entry and return `undefined`. Lazy expiry only (no background sweep). | Status: not_done
- [ ] **Implement LRU eviction** — When `maxSize` is configured and the cache is at capacity on `set`, evict the least recently used entry. Maintain LRU order with a doubly-linked list for O(1) promotion on hit and O(1) eviction. Each `get` hit promotes the entry to the front. | Status: not_done
- [ ] **Implement getMany batch method** — Accept an array of keys, return a Map of key -> vector for all found (non-expired) entries. More efficient than individual get calls for batch operations. | Status: not_done
- [ ] **Implement setMany batch method** — Accept a Map of key -> vector and optional TTL, store all entries. Respect maxSize/LRU if configured. | Status: not_done
- [ ] **Implement clear with model filter** — `clear({ model })` scans all entries and removes those whose `model` field matches. `clear()` without filter removes everything. | Status: not_done
- [ ] **Write memory.test.ts** — Test: get/set roundtrip, get returns undefined for missing key, has returns true/false correctly, delete removes entry and returns true (false if not exists), clear empties cache, keys returns all keys, size returns count. TTL tests: entry expires after TTL, entry accessible before TTL. LRU tests: eviction of oldest entry at maxSize, access promotes entry in LRU order. getMany/setMany batch operations. clear({ model }) filters correctly. | Status: not_done

---

## Phase 7: EmbedCache Core (src/cache.ts)

- [ ] **Implement EmbedCache class** — Main class that wraps a storage backend, embedder function, and configuration. Manages key derivation, cache-through logic, stats tracking, and change detection. | Status: not_done
- [ ] **Implement createCache factory** — `createCache(options: EmbedCacheOptions): EmbedCache`. Validate required options (`embedder`, `model`). Resolve the storage backend from the `StorageBackendOption`. Instantiate and return an `EmbedCache`. | Status: not_done
- [ ] **Implement cache.embed(text, options?)** — Single-text cache-through method. Normalize text, compute key, check cache. On hit: increment stats, update LRU, return vector. On miss: call `embedder([text])`, store result with TTL, increment stats, return vector. If embedder throws, propagate error without caching. | Status: not_done
- [ ] **Implement bypassCache option** — When `options.bypassCache` is true, skip cache lookup and always call the embedder. Still store the result in cache. | Status: not_done
- [ ] **Implement cache.embedBatch(texts, options?)** — Batch cache-through method. Compute keys for all texts. Deduplicate within the batch (same key appears once). Query storage for all unique keys (use `getMany` if available). Collect misses. Call `embedder(missedTexts)` once for all misses. Cache results. Reconstruct output in input order. Return `number[][]`. | Status: not_done
- [ ] **Handle intra-batch deduplication** — If the same text (same key after normalization) appears multiple times in the input array, fetch/embed it once and reuse the same vector reference for all occurrences. | Status: not_done
- [ ] **Implement cache.get(text)** — Read-only method. Normalize text, compute key, query storage. Return the vector or undefined. Do not call embedder. Do not update stats. | Status: not_done
- [ ] **Implement cache.has(text)** — Check if text is cached. Normalize text, compute key, call `storage.has(key)`. Do not call embedder. | Status: not_done
- [ ] **Implement cache.set(text, vector, options?)** — Manually insert a vector. Normalize text, compute key, call `storage.set(key, vector, { ttl })`. Respect default TTL if no per-entry TTL is given. | Status: not_done
- [ ] **Implement cache.delete(text)** — Remove a cached entry. Normalize text, compute key, call `storage.delete(key)`. Return boolean indicating if entry existed. | Status: not_done
- [ ] **Implement cache.clear(options?)** — Clear all entries or entries matching a model filter. Delegate to `storage.clear(options)`. | Status: not_done
- [ ] **Implement cache.stats()** — Return current `CacheStats` object. Include current cache size from storage. | Status: not_done
- [ ] **Implement cache.flush()** — Delegate to `storage.flush()` if the method exists. Used for filesystem/SQLite backends to persist pending writes before process exit. | Status: not_done
- [ ] **Implement per-entry TTL override** — When `options.ttl` is provided to `embed` or `set`, use that value instead of the default TTL. | Status: not_done
- [ ] **Handle embedder errors gracefully** — If the embedder function throws during `embed` or `embedBatch`, propagate the error to the caller. Do not write anything to the cache for the failed entries. Ensure stats are not incorrectly updated. | Status: not_done

---

## Phase 8: Core Unit Tests (src/__tests__/cache.test.ts)

- [ ] **Test embed() cache miss** — First call with a new text calls the embedder and returns the vector. | Status: not_done
- [ ] **Test embed() cache hit** — Second call with the same text does not call the embedder. | Status: not_done
- [ ] **Test embed() different text** — Calling with different text calls the embedder again. | Status: not_done
- [ ] **Test embedBatch() all hits** — When all texts are cached, embedder is called zero times. | Status: not_done
- [ ] **Test embedBatch() all misses** — When no texts are cached, embedder is called exactly once with all texts. | Status: not_done
- [ ] **Test embedBatch() mixed hits and misses** — Embedder is called once with only the missed texts. | Status: not_done
- [ ] **Test embedBatch() intra-batch deduplication** — Duplicate texts in the same batch result in one embedder call per unique text, and all duplicates share the same vector reference. | Status: not_done
- [ ] **Test embedBatch() preserves input order** — Returned vectors array matches the order of the input texts array. | Status: not_done
- [ ] **Test get() returns undefined for uncached text** — Calling get on a text not in cache returns undefined without calling embedder. | Status: not_done
- [ ] **Test has() returns false/true** — Returns false for uncached text, true after embed or set. | Status: not_done
- [ ] **Test set() and get() roundtrip** — Manually set a vector, then get it back. Same vector is returned. | Status: not_done
- [ ] **Test delete() removes entry** — Delete returns true and subsequent get returns undefined. Delete of non-existent key returns false. | Status: not_done
- [ ] **Test clear() empties cache** — After clear, all previously cached texts return undefined from get. | Status: not_done
- [ ] **Test stats() correctness** — Verify hits, misses, totalRequests, hitRate, tokensEstimatedSaved, costEstimatedSaved after a sequence of operations. | Status: not_done
- [ ] **Test TTL expiry** — Entry expires and is re-fetched after TTL elapses. Use fake timers or short TTL. | Status: not_done
- [ ] **Test LRU eviction** — With maxSize=2, inserting a 3rd entry evicts the least recently used entry. Accessing an entry promotes it so it is not evicted. | Status: not_done
- [ ] **Test model-aware keys** — Same text with different model produces different cache entries. Changing model option produces cache misses for previously cached text. | Status: not_done
- [ ] **Test text normalization sharing** — `embed('hello  ')` and `embed('hello')` share the same cache entry (same key). | Status: not_done
- [ ] **Test normalizeText=false** — When normalization is disabled, `'hello '` and `'hello'` produce different keys. | Status: not_done
- [ ] **Test embedder error propagation** — If embedder throws, embed() rejects with the same error. Nothing is cached. Stats are not incorrectly updated. | Status: not_done
- [ ] **Test bypassCache option** — With bypassCache=true, embedder is called even when text is cached. The new result replaces the cached value. | Status: not_done

---

## Phase 9: Change Detection (src/change-detection.ts)

- [ ] **Implement ChangeDetector class** — Manages document-level and chunk-level content hash tracking. Stores document hashes and chunk manifests. Uses SHA-256 for content hashing. | Status: not_done
- [ ] **Implement trackDocument(docId, content)** — Compute SHA-256 hash of the full document content. Store the hash under the docId in the document hash index. Persist to the same storage backend as embeddings (using `doc:sha256:<docId>` key prefix). | Status: not_done
- [ ] **Implement hasChanged(docId, content)** — Compute SHA-256 hash of `content`. Compare to stored hash for `docId`. Return `true` if hashes differ or if document is untracked. Return `false` if hashes match. This method is synchronous (computes hash and compares against in-memory index). | Status: not_done
- [ ] **Implement trackDocumentChunks(docId, chunks)** — Compute SHA-256 hash for each chunk. Store the array of hashes as the chunk manifest for `docId` (using `docchunks:<docId>` key prefix). | Status: not_done
- [ ] **Implement hasChangedBatch(docId, chunks)** — For each chunk, compute its SHA-256 hash and compare against the stored chunk manifest. Return `boolean[]` — true for new or changed chunks, false for unchanged. If document has no stored manifest, all chunks are considered changed. | Status: not_done
- [ ] **Write change-detection.test.ts** — Test: hasChanged returns true for untracked document, returns false after trackDocument with same content, returns true after content changes. hasChangedBatch identifies new chunks, changed chunks, and unchanged chunks. trackDocumentChunks stores manifest correctly. Edge cases: empty chunks array, document with no prior tracking. | Status: not_done

---

## Phase 10: Serialization (src/serialization.ts)

- [ ] **Implement cache.serialize(format?)** — Serialize the entire cache state (embeddings + document hashes + chunk manifests + stats metadata) to JSON string or binary Buffer. JSON format: `{ version: 1, model: string, entries: Array<{ key, vector, createdAt, ttl? }>, documents: Record<docId, hash>, chunkManifests: Record<docId, hash[]> }`. | Status: not_done
- [ ] **Implement binary serialization** — When format is `'binary'`, produce a Buffer with a JSON header (index) followed by packed float32 vectors. More compact than JSON for large caches. | Status: not_done
- [ ] **Implement EmbedCache.deserialize(data, options)** — Static method. Parse the serialized data. Create a new EmbedCache with the provided options. Populate the storage backend with the deserialized entries. Restore document hashes and chunk manifests. | Status: not_done
- [ ] **Handle version field** — Include a `version` field in serialized output for future format compatibility. Current version is 1. Deserialize should validate the version and throw a clear error for unsupported versions. | Status: not_done
- [ ] **Write serialization.test.ts** — Test: serialize then deserialize roundtrip preserves all entries, document hashes, and chunk manifests. JSON format is valid JSON. Binary format is more compact than JSON. Deserialize with mismatched model still loads data (keys will be different but data is preserved). Version validation. Empty cache serialization/deserialization. | Status: not_done

---

## Phase 11: Filesystem JSON Backend (src/backends/filesystem.ts)

- [ ] **Implement FilesystemBackend class** — On initialization, read and parse the JSON cache file (create if not exists). Keep all data in memory for fast reads. Implement all `StorageBackend` interface methods. | Status: not_done
- [ ] **Implement write debouncing** — After any `set` or `delete`, schedule a write to disk after `debounceMs` (default: 1000ms). If another write is scheduled before the debounce fires, reset the timer. Only one write happens per debounce window. | Status: not_done
- [ ] **Implement flush()** — Write the entire cache map to disk immediately, bypassing the debounce. Call this before process exit to ensure all pending writes are persisted. | Status: not_done
- [ ] **Handle file creation** — If the cache file does not exist on initialization, create it with an empty cache. Create parent directories if needed. | Status: not_done
- [ ] **Handle corrupt file gracefully** — If the JSON file is corrupt or cannot be parsed, log a warning and start with an empty cache rather than crashing. | Status: not_done
- [ ] **Write filesystem.test.ts** — Test: set then get roundtrip, persistence across backend instances (create backend, set entries, create new backend with same path, verify entries exist), flush writes immediately, debounce batches writes, corrupt file handled gracefully. Use os.tmpdir() for test files and clean up after. | Status: not_done

---

## Phase 12: Filesystem Binary Backend (src/backends/filesystem-binary.ts)

- [ ] **Implement FilesystemBinaryBackend class** — Store vectors as packed little-endian float32 binary data. Maintain a JSON header/index mapping keys to byte offsets and vector dimensions. Support random-access reads without loading the entire file. | Status: not_done
- [ ] **Implement binary vector encoding/decoding** — Encode `number[]` as `Buffer` of little-endian 32-bit floats (4 bytes per dimension). Decode back to `number[]`. A 1536-dimensional vector = 6144 bytes. | Status: not_done
- [ ] **Implement file format** — Header block (JSON) with key-to-offset index, followed by concatenated binary vectors. On write, append new vectors and update the header. | Status: not_done
- [ ] **Write filesystem-binary.test.ts** — Test: set/get roundtrip, vector values preserved exactly (float32 precision), persistence across backend instances, file is ~5x smaller than equivalent JSON, random-access reads work. Use os.tmpdir() for test files. | Status: not_done

---

## Phase 13: SQLite Backend (src/backends/sqlite.ts)

- [ ] **Implement SqliteBackend class** — Use `better-sqlite3` (peer dependency). Create table: `CREATE TABLE IF NOT EXISTS embeddings (key TEXT PRIMARY KEY, vector BLOB, model TEXT, created_at INTEGER, accessed_at INTEGER, ttl INTEGER)`. Store vectors as BLOBs (packed float32). | Status: not_done
- [ ] **Enable WAL mode** — If `walMode` option is true (default), execute `PRAGMA journal_mode=WAL` on initialization for better concurrent read performance. | Status: not_done
- [ ] **Implement TTL via SQL query** — On `get`, check `ttl IS NOT NULL AND (created_at + ttl) < now`. Return undefined for expired entries. | Status: not_done
- [ ] **Implement clear with model filter** — `clear({ model })` executes `DELETE FROM embeddings WHERE model = ?`. `clear()` executes `DELETE FROM embeddings`. | Status: not_done
- [ ] **Implement getMany with SQL IN clause** — Batch get using `SELECT * FROM embeddings WHERE key IN (?, ?, ...)` for efficient batch lookups. | Status: not_done
- [ ] **Implement setMany with transaction** — Batch insert/upsert using a prepared statement inside a transaction for efficiency. | Status: not_done
- [ ] **Handle missing peer dependency** — If `better-sqlite3` is not installed, throw a clear error: "SQLite backend requires 'better-sqlite3'. Install it with: npm install better-sqlite3". | Status: not_done
- [ ] **Write sqlite.test.ts** — Test: all StorageBackend interface methods, persistence across backend instances, WAL mode enabled, TTL expiry, clear with model filter, getMany/setMany batch operations, vector BLOB encoding roundtrip. Use temp file and clean up. | Status: not_done

---

## Phase 14: Redis Backend (src/backends/redis.ts)

- [ ] **Implement RedisBackend class** — Use `ioredis` (peer dependency). Store each entry as a Redis hash: `HSET <prefix><key> vector <buffer> model <string> created_at <int>`. Use `keyPrefix` (default: `'embed-cache:'`) for all keys. | Status: not_done
- [ ] **Implement Redis TTL** — Pass TTL to Redis's native `EXPIRE` command so entries expire at the storage level. | Status: not_done
- [ ] **Implement getMany with MGET or pipeline** — Use Redis pipeline to fetch multiple keys in a single round-trip. | Status: not_done
- [ ] **Implement setMany with pipeline** — Use Redis pipeline to set multiple entries in a single round-trip. | Status: not_done
- [ ] **Implement clear with SCAN and DEL** — Use `SCAN` with match pattern `<prefix>*` to find and delete all keys. For model-filtered clear, scan and check model field before deleting. | Status: not_done
- [ ] **Implement keys() with SCAN** — Use `SCAN` to iterate all keys matching the prefix. | Status: not_done
- [ ] **Handle missing peer dependency** — If `ioredis` is not installed, throw a clear error: "Redis backend requires 'ioredis'. Install it with: npm install ioredis". | Status: not_done
- [ ] **Write redis.test.ts** — Test all StorageBackend interface methods using `ioredis-mock`. Test TTL expiry, key prefix isolation, pipeline batch operations, clear with model filter. Skip tests if REDIS_URL not set for real Redis tests. | Status: not_done

---

## Phase 15: Storage Backend Factory

- [ ] **Implement resolveBackend function** — Accept a `StorageBackendOption` and return a `StorageBackend` instance. Handle: `'memory'` string, `{ type: 'memory' }`, `{ type: 'filesystem', path }`, `{ type: 'filesystem-binary', path }`, `{ type: 'sqlite', path }`, `{ type: 'redis', url }`, and custom `StorageBackend` objects (pass-through). | Status: not_done
- [ ] **Validate custom backend** — If a custom object is passed as storage, validate that it implements the required methods (`get`, `set`, `has`, `delete`, `clear`, `keys`, `size`). Throw a descriptive error if any required method is missing. | Status: not_done

---

## Phase 16: CLI Implementation (src/cli.ts)

- [ ] **Set up CLI entry point** — Add `#!/usr/bin/env node` shebang. Parse command-line arguments (use minimal argument parsing or `node:util.parseArgs`). Route to subcommand handlers. | Status: not_done
- [ ] **Implement `embed-cache stats` command** — Accept `--path`, `--redis-url`, `--model`, `--format` (human/json). Open the cache backend read-only. Print entry count, file size (for filesystem/SQLite), model, and any stored metadata. JSON format outputs `CacheStats` as JSON to stdout. | Status: not_done
- [ ] **Implement `embed-cache prewarm` command** — Accept `--input` (JSONL file path), `--path`, `--redis-url`, `--model` (required), `--format`. Read JSONL file line by line, parse each line as `{ text, embedding }`, call `cache.set(text, embedding)` for each. Report count of entries added. | Status: not_done
- [ ] **Implement `embed-cache embed` command** — Accept `--input` (text file or JSONL), `--model` (required), `--path`, `--api-key`, `--provider` (openai/cohere), `--batch-size` (default 100), `--format`. Create an embedder function based on provider and API key. Read input texts, call `cache.embedBatch()` in batches. Report stats. | Status: not_done
- [ ] **Implement `embed-cache clear` command** — Accept `--path`, `--redis-url`, `--model`, `--confirm` (required for safety). Refuse to run without `--confirm`. Call `cache.clear({ model })` or `cache.clear()`. Report number of entries removed. | Status: not_done
- [ ] **Implement `embed-cache export` command** — Accept `--path`, `--output` (file path or stdout), `--model`, `--format` (jsonl/json). Iterate all cache entries, serialize each as `{ key, text_hash, vector, model, created_at }` in JSONL format to output. | Status: not_done
- [ ] **Implement environment variable fallbacks** — Read `EMBED_CACHE_MODEL`, `EMBED_CACHE_STORAGE`, `EMBED_CACHE_PATH`, `EMBED_CACHE_REDIS_URL`, `EMBED_CACHE_TTL`, `EMBED_CACHE_MAX_SIZE` from environment when CLI flags are not provided. | Status: not_done
- [ ] **Implement exit codes** — Exit 0 on success, 1 on operation failure (IO error, connection error, invalid data), 2 on configuration error (missing required options, invalid flags). | Status: not_done
- [ ] **Write CLI tests** — Spawn the CLI as a subprocess using `child_process.execFile`. Test each command with valid and invalid inputs. Verify stdout output and exit codes. Test environment variable fallbacks. Test `--confirm` requirement for clear command. | Status: not_done

---

## Phase 17: Public API Exports (src/index.ts)

- [ ] **Export createCache factory** — The primary entry point for creating an EmbedCache instance. | Status: not_done
- [ ] **Export EmbedCache class** — For type checking, `instanceof` checks, and the static `deserialize` method. | Status: not_done
- [ ] **Export all public types** — Export `EmbedderFn`, `EmbedCacheOptions`, `EmbedOptions`, `StorageBackendOption`, `StorageBackend`, `CacheStats` from types.ts. | Status: not_done
- [ ] **Export backend classes** — Export `MemoryBackend`, `FilesystemBackend`, `FilesystemBinaryBackend`, `SqliteBackend`, `RedisBackend` for advanced users who want to instantiate backends directly. | Status: not_done
- [ ] **Export utility functions** — Export `normalizeForKey` from normalize.ts and `computeKey` from key.ts for users who need to compute keys manually (e.g., for cache inspection or debugging). | Status: not_done

---

## Phase 18: Integration Tests (src/__tests__/integration/)

- [ ] **Write cache-through integration test** — Full end-to-end flow: create cache with mock embedder, embed a batch, verify all cached, embed same batch again (zero embedder calls), change one text (exactly one embedder call for the changed text). | Status: not_done
- [ ] **Write change detection + embedding integration test** — Track a document, chunk it, embed chunks. Modify the document, detect changes, re-embed only changed chunks. Verify embedder is called minimally. | Status: not_done
- [ ] **Write serialization roundtrip integration test** — Create cache, populate with entries, serialize, create new cache, deserialize, verify all entries accessible and change detection state preserved. | Status: not_done
- [ ] **Write multi-model integration test** — Create two caches with different models but same storage backend. Verify entries are isolated by model key namespace. | Status: not_done
- [ ] **Gate integration tests behind environment variable** — Run integration tests only when `TEST_INTEGRATION=true` is set. Exclude from default `npm test` run. Add `npm run test:integration` script. | Status: not_done

---

## Phase 19: Performance Benchmarks (src/__benchmarks__/)

- [ ] **Write key computation benchmark** — Measure SHA-256 computation throughput for 2 KB strings. Target: >100,000 ops/second. | Status: not_done
- [ ] **Write in-memory hit benchmark** — Measure `embed(text)` throughput for cached text on in-memory backend. Target: >500,000 ops/second. | Status: not_done
- [ ] **Write batch optimization benchmark** — Verify that `embedBatch(1000 texts)` with 900 cached calls embedder exactly once. Measure wall-clock time. | Status: not_done
- [ ] **Add npm run bench script** — Add a script to run the benchmark suite. | Status: not_done

---

## Phase 20: Error Handling and Edge Cases

- [ ] **Handle empty string input** — `embed('')` should work (hash the empty normalized string). Document behavior. | Status: not_done
- [ ] **Handle empty batch input** — `embedBatch([])` should return `[]` immediately without calling the embedder. | Status: not_done
- [ ] **Handle null/undefined input** — `embed(null)` and `embed(undefined)` should throw a TypeError with a clear message. | Status: not_done
- [ ] **Validate embedder return length** — After calling `embedder(texts)`, verify that the returned array has the same length as the input. If not, throw an error: "Embedder returned N vectors for M texts. Expected lengths to match." | Status: not_done
- [ ] **Handle concurrent embed calls for same text** — Two concurrent `embed(sameText)` calls may both miss and both call the embedder. This is acceptable (idempotent writes) but document it. Consider logging a warning for high-concurrency scenarios. | Status: not_done
- [ ] **Handle storage backend errors** — If the storage backend throws on `get` or `set`, propagate the error to the caller with context about which operation failed. | Status: not_done

---

## Phase 21: Documentation

- [ ] **Write README.md** — Include: package overview, installation instructions (with peer deps for SQLite/Redis), quickstart example, API reference summary, storage backend comparison table (latency, persistence, multi-process), configuration reference, CLI usage, integration examples with monorepo packages, cost savings explanation. | Status: not_done
- [ ] **Add JSDoc comments to all public APIs** — Document every public method, type, and interface with JSDoc comments. Include `@param`, `@returns`, `@throws`, and `@example` tags. | Status: not_done
- [ ] **Document StorageBackend interface for custom backends** — Provide a guide for implementing custom storage backends, including which methods are required vs optional and performance implications. | Status: not_done

---

## Phase 22: Final Polish and Publishing Prep

- [ ] **Verify zero runtime dependencies** — Confirm that `package.json` has no `dependencies` field (only `devDependencies` and `peerDependencies`). The core in-memory mode must work with zero npm installs beyond the package itself. | Status: not_done
- [ ] **Verify Node.js 18+ compatibility** — Ensure all code uses only APIs available in Node.js 18. No Node.js 20+ features. Test on Node.js 18. | Status: not_done
- [ ] **Ensure all tests pass** — Run `npm test` and verify all unit tests pass. Run `npm run lint` and verify no lint errors. Run `npm run build` and verify TypeScript compilation succeeds. | Status: not_done
- [ ] **Verify package.json fields** — Confirm `main`, `types`, `files`, `bin`, `engines`, `publishConfig`, `keywords`, `description`, `license` are all correct. | Status: not_done
- [ ] **Bump version to 0.1.0** — Ensure package.json version is set to `0.1.0` for initial publish. | Status: not_done
- [ ] **Test npm pack** — Run `npm pack` and inspect the tarball to verify only `dist/` files are included (no source, no tests, no benchmarks). | Status: not_done
- [ ] **Verify prepublishOnly script** — Confirm `prepublishOnly` runs `npm run build` so the package is always built before publishing. | Status: not_done
