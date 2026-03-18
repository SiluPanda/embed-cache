# embed-cache -- Specification

## 1. Overview

`embed-cache` is a content-addressable embedding cache with deduplication, TTL, change detection, and pluggable storage backends. It accepts raw text and an embedding function, transparently checks a cache before calling the embedding API, stores the result, and returns the vector -- all without the caller needing to manage cache keys, deduplication logic, or storage. When text has not changed, the API is never called. When it has changed, only the changed text is re-embedded. The package tracks cost savings, hit rates, and tokens saved to give operators visibility into how much the cache is reducing API spend.

The gap this package fills is specific and well-defined. Embedding API calls are the dominant ongoing cost in most RAG (Retrieval-Augmented Generation) pipelines. OpenAI `text-embedding-3-small` charges $0.02 per million tokens; `text-embedding-3-large` charges $0.13 per million tokens; the legacy `ada-002` charges $0.10 per million tokens; Cohere Embed charges $0.10 per million tokens. In production pipelines, the same text is routinely embedded multiple times: documents are re-indexed when the pipeline restarts, chunked text reappears across overlapping documents, periodic re-indexing jobs sweep all content even when most of it has not changed, and parallel ingestion workers independently embed the same source files. Despite this, no npm package provides content-hashed embedding storage -- a cache where the key is derived from the text content itself, ensuring that identical text always hits the cache regardless of what called it or when.

The closest existing tools address adjacent problems. LangChain's `CacheBackedEmbeddings` class wraps an embedding model with an in-memory or Redis-backed cache keyed by text, but it is Python-only and tightly coupled to the LangChain framework. LlamaIndex provides `VectorStoreIndex` with a `use_async` flag and a `transformations` cache, but again Python-only and framework-coupled. In the JavaScript ecosystem, `keyv` provides a generic key-value cache with multiple adapters, but has no concept of embedding semantics, batch optimization, model-aware keys, or cost tracking. `node-cache` and `lru-cache` provide in-memory caching primitives but require callers to manage their own cache keys and have no batch embedding optimization. No package in the npm ecosystem provides the combination of content-addressable keys (text hash + model ID), batch optimization (collect all misses, single API call), change detection (detect when a document has changed and only re-embed changed chunks), cost tracking (count tokens saved, estimate dollars saved), and pluggable storage backends.

`embed-cache` provides both a TypeScript/JavaScript API for programmatic use and a CLI for cache management. The API wraps any embedding function -- `(texts: string[]) => Promise<number[][]>` -- and returns vectors, using the cache transparently. The CLI supports pre-warming the cache, inspecting stats, clearing stale entries, and serializing the cache for transfer to another environment. Both interfaces support multiple storage backends: in-memory, filesystem, SQLite, Redis, and custom adapters.

---

## 2. Goals and Non-Goals

### Goals

- Provide a `createCache(options)` factory that returns an `EmbedCache` instance wrapping any embedding function with content-addressable caching.
- Provide a `cache.embed(text)` method that returns `Promise<number[]>`, transparently returning a cached vector or calling the embedding API on a cache miss.
- Provide a `cache.embedBatch(texts)` method that accepts an array of texts, identifies which are cache misses, groups all misses into a single batched API call, caches all results, and returns all vectors in input order.
- Implement content-addressable keys: the cache key for a text is `SHA-256(normalize(text) + ":" + model)`, where `model` is the embedding model identifier. Same text and model always produce the same key. Same text with a different model produces a different key.
- Normalize text before hashing: trim leading and trailing whitespace, collapse internal whitespace sequences to a single space, and apply Unicode NFC normalization. The normalized form is used only for key computation; the original text is what gets sent to the embedding API.
- Make the cache model-aware: changing the `model` option changes the key namespace, invalidating all entries from the old model without requiring an explicit cache clear.
- Support TTL (time-to-live) per entry or as a default for all entries, with automatic expiry on access.
- Support LRU (Least Recently Used) eviction when a maximum entry count is configured, ensuring the cache does not grow beyond a set size.
- Provide change detection via `cache.hasChanged(key, content)` and `cache.trackDocument(docId, content)` for document-level change tracking. Only re-embed chunks whose content has changed since last indexing.
- Track and report cost savings: total calls, cache hits, cache misses, tokens saved (estimated), and estimated dollar cost avoided.
- Support multiple storage backends via a `StorageBackend` interface: in-memory (`Map`), filesystem (JSON file), SQLite (single-file database), Redis (key-value store), and custom adapters.
- Support cache serialization and deserialization (`cache.serialize()` / `EmbedCache.deserialize()`) for exporting and importing cache state across environments.
- Provide a CLI (`embed-cache`) for pre-warming, inspecting stats, clearing, and exporting the cache.
- Integrate with `memory-dedup`, `chunk-smart`, `embed-drift`, and `embed-cluster` from this monorepo.
- Zero runtime dependencies for the core in-memory mode. Optional peer dependencies for storage backends (better-sqlite3, ioredis).
- Target Node.js 18+. Use `node:crypto` for SHA-256 hashing.

### Non-Goals

- **Not an embedding provider.** This package does not call any embedding API directly. It wraps a caller-provided embedding function. The caller chooses the model and provides the function. Bring your own OpenAI client, Cohere client, or local model.
- **Not a vector database.** This package stores embedding vectors by their content hash for cache lookup. It does not provide nearest-neighbor search, similarity queries, metadata filtering, or vector indexing for retrieval. Use Vectra, Pinecone, Weaviate, or Qdrant for that.
- **Not a semantic cache.** This package does not detect that "Paris is the capital of France" and "The capital city of France is Paris" should share a cache entry. Two different normalized strings produce two different keys. Semantic caching (embedding-based near-duplicate cache lookup) is out of scope because it requires embedding-based similarity search, which is circularly expensive to bootstrap. Use `prompt-dedup` for text normalization that increases cache hit rates.
- **Not a persistence layer.** The filesystem and SQLite backends persist across restarts, but `embed-cache` is not a general-purpose data store. It does not support transactions, schemas, migrations, or complex queries.
- **Not a distributed cache coordinator.** The Redis backend enables shared caching across multiple processes, but `embed-cache` does not handle distributed cache invalidation, write conflicts, or Lua scripting. It uses Redis as a simple key-value store.
- **Not a request deduplicator.** This package does not coalesce concurrent in-flight embedding requests for the same text. For in-flight request deduplication, combine with `llm-dedup`. `embed-cache` deduplicates at the stored result level, not at the in-flight request level.
- **Not a model benchmarking tool.** `embed-cache` tracks which model produced each cached entry for key namespacing purposes but does not compare embedding quality across models. Use `embed-drift` for detecting embedding distribution drift.

---

## 3. Target Users and Use Cases

### RAG Pipeline Engineers

Teams building document ingestion and retrieval pipelines where documents are chunked, embedded, and indexed into a vector database. The pipeline runs on a schedule: nightly, hourly, or on every document update. Without a cache, every run re-embeds every chunk, even if 95% of the documents have not changed. With `embed-cache`, unchanged chunks hit the cache, and only new or modified chunks trigger API calls. A pipeline ingesting 100,000 chunks at 512 tokens each using `text-embedding-3-small` costs approximately $1.00 per full run. If only 5% of chunks change per run, a cache reduces that to $0.05 per run -- $950 saved every 1,000 runs, or $34,675 per year on a daily pipeline.

### Document Re-Indexing Operators

Teams that periodically re-index their entire corpus to keep their vector database in sync. Without change detection, re-indexing re-embeds everything. With `cache.hasChanged(docId, content)`, the pipeline skips unchanged documents entirely, and with `cache.embedBatch()`, changed chunks are embedded in a single batched API call rather than one call per chunk. The combination of change detection and batch optimization dramatically reduces both API cost and wall-clock time for re-indexing jobs.

### AI Application Developers

Developers building applications that embed user queries, documents, or context snippets before sending them to a retrieval layer. User queries repeat: "how do I reset my password?" is asked many times across many users. If each query is embedded on every request, the embedding cost scales linearly with request volume. With `embed-cache`, the first request embeds and caches the query vector; subsequent identical requests (or requests with identical normalized text) return the cached vector in under 1ms, with zero API cost.

### Cost Optimization Engineers

Engineers tasked with reducing the embedding API spend for large-scale deployments. `cache.stats()` returns `{ hits, misses, hitRate, tokensEstimatedSaved, costEstimatedSaved }` with a model-specific cost per million tokens. This gives a concrete dollar figure for the cache's value. The CLI's `stats` command exports this as JSON for dashboards and cost reporting.

### Multi-Worker Ingestion Systems

Teams running parallel document ingestion workers that independently process document sets. Without a shared cache, two workers that process overlapping documents (or documents with shared boilerplate text, headers, or repeated passages) independently embed the same text. With a shared Redis backend, the first worker to embed a piece of text populates the cache; subsequent workers hit the cache, even across process boundaries.

### Development and Testing Environments

Developers iterating on RAG pipelines during development. Embedding API calls slow down iteration cycles and accumulate cost during testing. A persistent filesystem or SQLite cache pre-populated with development corpus embeddings makes re-runs instant and free. The CLI's `prewarm` command populates the cache from a JSON file of texts, so the first run of a new environment is already cached.

---

## 4. Core Concepts

### Content-Addressable Key

A content-addressable key is derived from the content itself, not from an external identifier. In git, a file's key is `SHA-1(content)` -- the same file always has the same key, regardless of filename, path, or timestamp. In Docker, image layer keys are `SHA-256(layer content)` -- the same layer is stored exactly once, regardless of how many images reference it. In IPFS, Content Identifiers (CIDs) are `SHA-256(data)` -- the same data block has the same CID across all nodes in the network.

`embed-cache` applies this principle to embedding vectors. The key for a text is `SHA-256(normalizedText + ":" + modelId)`. The same text always produces the same key. The same embedding vector is stored once and returned on every cache hit, regardless of which part of the codebase requested it. No cache invalidation is needed for content that has not changed -- the key is the content.

### Text Normalization Before Hashing

Before computing the cache key, the text is normalized to collapse cosmetic variations that produce identical embeddings. Two texts that differ only in leading/trailing whitespace, internal whitespace sequences, or Unicode normalization form are semantically identical for embedding purposes. Normalizing before hashing ensures these variants share the same cache key.

Normalization steps (applied in order, used only for key computation):
1. Unicode NFC normalization (`text.normalize('NFC')`)
2. Trim leading and trailing whitespace (`text.trim()`)
3. Collapse runs of internal whitespace (spaces, tabs, `\r\n`, `\r`) to a single space

The normalized form is the key input. The original text is what gets sent to the embedding API on a cache miss, preserving any formatting that the model's tokenizer handles.

### Model-Aware Keys

The cache key includes the model identifier. Embedding vectors from different models are not interchangeable -- a vector from `text-embedding-3-small` (1536 dimensions) cannot substitute for a vector from `text-embedding-3-large` (3072 dimensions), and the cosine similarity space is model-specific. If an application migrates from `ada-002` to `text-embedding-3-small`, all cached `ada-002` vectors become invalid.

By including the model ID in the key, the cache naturally separates entries by model. When the model changes, old entries remain in storage but are never accessed by the new model's key space. An explicit `cache.clear({ model: 'old-model' })` can evict old entries to reclaim storage.

### Cache-Through Pattern

The cache-through pattern means the cache sits between the application and the embedding API. The application always calls `cache.embed(text)` rather than the embedding API directly. The cache handles the hit/miss logic transparently:

```
Application → cache.embed(text)
                ↓
            key = sha256(normalize(text) + ":" + model)
                ↓
            cache.get(key) → hit → return vector (sub-1ms)
                ↓ miss
            embedder([text]) → [vector]
                ↓
            cache.set(key, vector)
                ↓
            return vector
```

The application code does not change based on whether the result was cached. The cache is transparent.

### Batch Optimization

The `cache.embedBatch(texts)` method implements batch optimization as a core feature, not an afterthought. The algorithm is:

1. Compute keys for all input texts.
2. Query the storage backend for all keys in a single batch lookup.
3. Separate the inputs into hits (keys found in cache) and misses (keys not found).
4. If there are any misses, call `embedder(missedTexts)` once with all missing texts as a single batch.
5. Store all returned vectors in the cache.
6. Reconstruct the results in the original input order, interleaving cached hits and newly computed vectors.
7. Return the full results array.

This ensures the embedding API is called at most once per `embedBatch` invocation, regardless of how many cache misses there are. All misses are grouped into a single API call, minimizing latency and taking advantage of the API's batch pricing (most embedding APIs offer the same or lower per-token price for batch calls).

### Change Detection

Change detection answers the question: has this document or chunk changed since the last time it was embedded? The cache maintains an optional content-hash index alongside the embedding index. When a document is tracked with `cache.trackDocument(docId, content)`, the cache records the SHA-256 hash of the full document content. On subsequent calls, `cache.hasChanged(docId, newContent)` returns `true` if the hash of `newContent` differs from the stored hash, indicating the document has been modified and needs re-embedding.

At the chunk level, `cache.hasChangedBatch(docId, chunks)` accepts an array of chunk texts and returns a boolean array -- one per chunk -- indicating which chunks are new or changed. Only changed chunks need to be re-embedded; unchanged chunks can be looked up by their embedding key.

Change detection is independent of embedding caching but is designed to work together with it. A document re-indexing loop checks `hasChanged` first (free), then calls `embedBatch` on the changed chunks only (cache-through, so already-embedded chunks hit the cache even across re-indexing runs).

### Cache Hit Rate and Cost Tracking

The cache tracks four counters:

- `hits`: Number of `embed` / `embedBatch` calls that returned a cached vector.
- `misses`: Number of calls that triggered an embedding API call.
- `tokensEstimatedSaved`: Sum of estimated token counts for all hits, computed using a character-to-token approximation (4 characters per token).
- `costEstimatedSaved`: `tokensEstimatedSaved / 1_000_000 * modelPricePerMillion` in USD.

The model price per million tokens is set via the `modelPricePerMillion` option. Default prices for known models are built in (see Section 12: Configuration).

---

## 5. Content-Addressable Design

### Key Derivation

The cache key is a 64-character lowercase hexadecimal string produced by:

```
key = SHA-256( normalizedText + "\x00" + modelId )
```

The null byte separator (`\x00`) prevents key collisions between texts that contain the model ID as a suffix. `node:crypto`'s `createHash('sha256').update(input).digest('hex')` produces the key in under 0.05ms for typical chunk-length inputs (512 tokens ≈ 2 KB).

### Why SHA-256

SHA-256 is chosen for its collision resistance and universal tooling support. No collision has ever been found in SHA-256. The probability of an accidental collision in a cache with 1 billion entries is approximately `1 billion^2 / 2^256 ≈ 5 × 10^-59` -- effectively zero. SHA-256 is implemented in Node.js's built-in `node:crypto` module via OpenSSL, requiring no external dependency.

For performance-critical scenarios where collision resistance is less important than speed, the implementation also accepts `algorithm: 'sha1'` (produces a 40-character key) or `algorithm: 'md5'` (produces a 32-character key). These are faster but not collision-resistant and should not be used when security matters. The default and recommended algorithm is `sha256`.

### Hash Computation Speed

For a 2 KB chunk of text (approximately 512 tokens), SHA-256 computation takes under 0.05ms on modern hardware. For a batch of 1,000 such chunks, key computation takes approximately 50ms -- negligible compared to the embedding API latency (30-500ms per batch call).

### Model ID in Key

The model ID included in the key is a canonical, lowercase string. `embed-cache` recognizes a set of known model aliases and normalizes them:

| Input | Canonical model ID |
|---|---|
| `text-embedding-3-small` | `openai/text-embedding-3-small` |
| `text-embedding-3-large` | `openai/text-embedding-3-large` |
| `text-embedding-ada-002` | `openai/text-embedding-ada-002` |
| `embed-english-v3.0` | `cohere/embed-english-v3.0` |
| `embed-multilingual-v3.0` | `cohere/embed-multilingual-v3.0` |
| (any other string) | passed through as-is |

If the model ID changes, the key namespace changes automatically. Old keys remain in storage but are unreachable under the new model namespace. No explicit cache bust is required when changing models.

### Text Normalization Details

The normalization function is deterministic and idempotent. Applying it twice to the same input produces the same output as applying it once.

```typescript
function normalizeForKey(text: string): string {
  return text
    .normalize('NFC')        // Unicode normalization form C
    .trim()                  // remove leading/trailing whitespace
    .replace(/\s+/g, ' ');   // collapse internal whitespace runs
}
```

This normalization does not modify the text sent to the embedding API. The original `text` argument is passed to the embedder unchanged. Only the normalized form is used to compute the key.

### Cache Validity

Under the content-addressable model, a cached embedding is valid as long as:
1. The text has not changed (different text → different key → cache miss automatically).
2. The model has not changed (different model → different key → cache miss automatically).
3. The TTL has not expired (if TTL is configured).

When conditions 1 and 2 hold, the cache never requires explicit invalidation. This is the fundamental advantage of content-addressable design over identifier-based design: the cache is self-consistent by construction.

---

## 6. Cache-Through Embedding

### The `embed` Method

`cache.embed(text)` is the primary single-text API. It accepts a text string and returns a `Promise<number[]>`.

```typescript
const vector = await cache.embed('Paris is the capital of France.');
// Returns number[] (e.g., 1536-dimensional float array for text-embedding-3-small)
// First call: cache miss → calls embedder(['Paris is the capital of France.']) → caches → returns
// Second call (same text): cache hit → returns cached vector in <1ms, no API call
```

Internally:
1. Normalize the input text for key computation.
2. Compute the SHA-256 key.
3. Query the storage backend for the key.
4. On hit: increment `hits` counter, update LRU order, return the vector.
5. On miss: call `embedder([text])`, cache the result with optional TTL, increment `misses` counter, return the vector.

If `embedder` throws, the error propagates to the caller. Nothing is written to the cache.

### The `embedBatch` Method

`cache.embedBatch(texts)` accepts an array of texts and returns `Promise<number[][]>` in the same order as the input.

```typescript
const vectors = await cache.embedBatch([
  'Paris is the capital of France.',
  'Berlin is the capital of Germany.',
  'Paris is the capital of France.',   // duplicate of index 0
  'Tokyo is the capital of Japan.',
]);
// vectors[0] === vectors[2] (same object reference, same cached vector)
// API is called with ['Berlin is the capital of Germany.', 'Tokyo is the capital of Japan.'] only
```

The batch algorithm:
1. Compute keys for all `n` texts.
2. Deduplicate: if the same key appears multiple times in the batch, it is fetched once and the result is used for all occurrences.
3. Query the storage backend for all unique keys.
4. Identify misses.
5. If misses exist, call `embedder(missedTexts)` once with all distinct missed texts.
6. Cache all returned vectors.
7. Reconstruct the output array in input order.
8. Return the array.

This means a batch of 1,000 texts where 950 are cached and 50 are new triggers exactly one API call with 50 texts. The cache hit path adds less than 1ms of overhead for the batch lookup.

### The Read-Only `get` and `has` Methods

`cache.get(text)` returns the cached vector or `undefined` without calling the embedder. Useful for checking the cache without triggering an API call.

`cache.has(text)` returns `true` if the text is cached. Does not trigger an API call.

Both methods normalize the text for key computation identically to `embed`.

### The `set` Method

`cache.set(text, vector)` manually inserts a vector into the cache. Useful for pre-populating the cache from a previously computed dataset.

```typescript
// Pre-populate from a dataset with known embeddings
for (const { text, embedding } of existingDataset) {
  cache.set(text, embedding);
}
```

If a TTL is configured globally, manually set entries respect the default TTL unless an entry-specific TTL is provided.

---

## 7. Change Detection

### Document-Level Change Detection

`cache.trackDocument(docId, content)` records the SHA-256 hash of `content` under the key `docId`. On subsequent calls, `cache.hasChanged(docId, newContent)` computes `SHA-256(newContent)` and compares it to the stored hash. It returns `true` if the hashes differ (content has changed) and `false` if they match (content is unchanged).

```typescript
// First indexing run
await cache.trackDocument('docs/readme.md', readmeContent);

// On next run, check if document changed
const changed = cache.hasChanged('docs/readme.md', newReadmeContent);
if (!changed) {
  // Skip re-embedding entirely
  return;
}

// Content changed: re-embed and re-index
const chunks = chunkText(newReadmeContent);
const vectors = await cache.embedBatch(chunks);
await vectorDb.upsert(docId, chunks, vectors);
await cache.trackDocument('docs/readme.md', newReadmeContent); // update stored hash
```

The document hash index is stored separately from the embedding cache. It persists to the same backend. Document IDs are arbitrary strings; they are not used as embedding cache keys.

### Chunk-Level Change Detection

`cache.hasChangedBatch(docId, chunks)` accepts an array of chunk texts and returns `boolean[]` -- one boolean per chunk. A chunk is considered "changed" if either:
- Its content hash is not in the document's chunk manifest (new chunk).
- Its content hash differs from the stored hash for that chunk position (modified chunk).

The chunk manifest maps chunk position to content hash. `cache.trackDocumentChunks(docId, chunks)` stores the manifest.

```typescript
const chunks = chunkText(document);
const changedFlags = cache.hasChangedBatch('docs/guide.md', chunks);

const changedChunks = chunks.filter((_, i) => changedFlags[i]);
const changedVectors = await cache.embedBatch(changedChunks);

// changedVectors are new; unchanged chunks already have valid embeddings in the vector DB
await vectorDb.updateChunks(docId, changedChunks, changedVectors);
await cache.trackDocumentChunks('docs/guide.md', chunks);
```

### Change Detection Storage

Document and chunk hashes are stored in the same backend as embedding vectors, using a key prefix to separate namespaces: `doc:sha256:<docId>` for document hashes, `docchunks:<docId>` for chunk manifests.

### When Change Detection Is Most Valuable

Change detection is most valuable in pipelines that re-index the same corpus repeatedly. Without it, each run must call `cache.has(chunk)` for every chunk to determine which ones are cached. With change detection, unchanged documents are skipped at the document level (one hash comparison per document) before checking chunk-level caches -- a much cheaper pre-filter.

---

## 8. Storage Backends

### In-Memory (Default)

The default backend stores all data in a JavaScript `Map`. It is the fastest option (sub-microsecond reads and writes) and requires no external dependencies.

**Characteristics:**
- Data is lost when the process exits.
- Memory usage scales linearly with the number of cached entries. A 1536-dimensional float vector takes approximately 6 KB as a JSON array. 100,000 cached vectors take approximately 600 MB.
- Suitable for: development environments, unit tests, short-lived processes, scenarios where persistence is not needed.

**Configuration:**
```typescript
createCache({ storage: 'memory' }) // default
createCache({ storage: { type: 'memory' } })
createCache({ storage: new MemoryBackend() })
```

**LRU eviction**: If `maxSize` is configured, the in-memory backend evicts the least recently used entry when the limit is exceeded. LRU order is maintained using a doubly-linked list with O(1) hit promotion and O(1) eviction.

### Filesystem (JSON)

The filesystem backend writes cached embeddings to a JSON file on disk. On initialization, the full file is loaded into memory; writes are debounced (default: 1 second) to avoid excessive disk I/O.

**Characteristics:**
- Persists across process restarts.
- Suitable for development, CI, and single-process production deployments with moderate corpus sizes.
- JSON serialization of float arrays is verbose: 100,000 entries may produce a 600 MB JSON file.
- Startup latency: loading and parsing a 600 MB JSON file takes approximately 2-5 seconds.
- Not suitable for multi-process environments (no write locking).

**Configuration:**
```typescript
createCache({
  storage: { type: 'filesystem', path: './cache/embeddings.json' }
})
```

**Write behavior**: Writes are batched. After any `set`, the backend waits for the debounce interval before writing the full map to disk. If the process exits before the debounce fires, the `cache.flush()` method writes immediately and should be called in process shutdown handlers.

### Filesystem (Binary)

An alternative filesystem backend that stores embedding vectors in a compact binary format: a header block containing the key-to-offset index (JSON), followed by a packed binary buffer of float arrays (little-endian 32-bit floats). Random access reads retrieve a specific vector without loading the full file.

**Characteristics:**
- Approximately 5x smaller than JSON format (6 KB per entry instead of ~30 KB for JSON-serialized float arrays).
- Faster startup (no JSON parsing of vectors).
- Suitable for larger corpora on disk.
- Not suitable for multi-process environments.

**Configuration:**
```typescript
createCache({
  storage: { type: 'filesystem-binary', path: './cache/embeddings.bin' }
})
```

### SQLite

The SQLite backend stores embeddings in a single-file SQLite database using `better-sqlite3` (peer dependency). Vectors are stored as BLOBs (packed 32-bit floats). The schema is a single table: `CREATE TABLE embeddings (key TEXT PRIMARY KEY, vector BLOB, model TEXT, created_at INTEGER, accessed_at INTEGER, ttl INTEGER)`.

**Characteristics:**
- Persists across restarts with ACID guarantees.
- Supports concurrent reads (WAL mode).
- Faster than JSON for large corpora (index-based lookups).
- Suitable for single-machine production deployments.
- Peer dependency: `better-sqlite3`.

**Configuration:**
```typescript
createCache({
  storage: {
    type: 'sqlite',
    path: './cache/embeddings.db',
    walMode: true, // default: true
  }
})
```

### Redis

The Redis backend stores embeddings in Redis using `ioredis` (peer dependency). Each entry is stored as a hash under the embedding key, with fields for the model, creation time, and the vector serialized as a binary buffer.

**Characteristics:**
- Shared across multiple processes and machines.
- Redis TTL support (entries expire automatically, no eviction logic needed in `embed-cache`).
- Suitable for distributed production deployments and multi-worker ingestion systems.
- Peer dependency: `ioredis`.

**Configuration:**
```typescript
createCache({
  storage: {
    type: 'redis',
    url: 'redis://localhost:6379',
    keyPrefix: 'embed-cache:', // default
  }
})
```

**Multi-process behavior**: Multiple processes sharing the same Redis instance share the embedding cache. The first process to miss and call the embedder populates the cache; subsequent processes with the same miss hit the cache. Note that `embed-cache` does not implement distributed locking -- two processes may simultaneously miss the same key and both call the embedder, with both writing the same result. This is safe (both writes are idempotent) but wastes an API call. For high-concurrency scenarios, consider adding a singleflight layer at the application level.

### Custom Backend

Any object implementing the `StorageBackend` interface can be passed as the `storage` option:

```typescript
interface StorageBackend {
  /** Get a cached vector by key. Returns undefined if not found or expired. */
  get(key: string): Promise<number[] | undefined>;

  /** Set a cached vector for a key with optional TTL in milliseconds. */
  set(key: string, vector: number[], options?: { ttl?: number }): Promise<void>;

  /** Check if a key exists without retrieving the vector. */
  has(key: string): Promise<boolean>;

  /** Delete a cached entry by key. Returns true if the key existed. */
  delete(key: string): Promise<boolean>;

  /** Clear all entries, or entries matching a pattern (if supported). */
  clear(options?: { model?: string; prefix?: string }): Promise<void>;

  /** Return all keys currently in the cache. */
  keys(): Promise<string[]>;

  /** Return the number of entries currently in the cache. */
  size(): Promise<number>;

  /** Optional: batch get multiple keys in a single operation. */
  getMany?(keys: string[]): Promise<Map<string, number[]>>;

  /** Optional: batch set multiple entries. */
  setMany?(entries: Map<string, number[]>, options?: { ttl?: number }): Promise<void>;

  /** Optional: flush any pending writes to durable storage. */
  flush?(): Promise<void>;
}
```

The `getMany` and `setMany` optional methods are called if present and significantly improve performance for batch operations. Backends that do not implement them have their single-key methods called in parallel.

---

## 9. API Surface

### Installation

```bash
npm install embed-cache
```

For SQLite backend:
```bash
npm install embed-cache better-sqlite3
```

For Redis backend:
```bash
npm install embed-cache ioredis
```

### Factory: `createCache`

Creates an `EmbedCache` instance.

```typescript
import { createCache } from 'embed-cache';

const cache = createCache({
  model: 'text-embedding-3-small',
  embedder: async (texts) => {
    const response = await openai.embeddings.create({
      model: 'text-embedding-3-small',
      input: texts,
    });
    return response.data.map(d => d.embedding);
  },
});
```

**Signature:**
```typescript
function createCache(options: EmbedCacheOptions): EmbedCache;
```

### `cache.embed`

Returns the embedding vector for a single text, using the cache.

```typescript
const vector: number[] = await cache.embed(text);
```

**Signature:**
```typescript
embed(text: string, options?: EmbedOptions): Promise<number[]>;
```

**Options:**
```typescript
interface EmbedOptions {
  /** Override the default TTL for this specific entry (milliseconds). */
  ttl?: number;
  /** If true, bypass the cache and always call the embedder. Default: false. */
  bypassCache?: boolean;
}
```

### `cache.embedBatch`

Returns embedding vectors for an array of texts, using the cache. All cache misses are grouped into a single embedder call.

```typescript
const vectors: number[][] = await cache.embedBatch(texts);
```

**Signature:**
```typescript
embedBatch(texts: string[], options?: EmbedOptions): Promise<number[][]>;
```

The returned array has the same length as `texts`. `vectors[i]` is the embedding for `texts[i]`.

### `cache.get`

Returns the cached vector for a text, or `undefined` if not cached. Does not call the embedder.

```typescript
const vector: number[] | undefined = cache.get(text);
// Returns undefined if not in cache -- no API call made
```

**Signature:**
```typescript
get(text: string): Promise<number[] | undefined>;
```

### `cache.set`

Manually inserts a vector into the cache.

```typescript
await cache.set(text, vector);
await cache.set(text, vector, { ttl: 3_600_000 }); // TTL: 1 hour
```

**Signature:**
```typescript
set(text: string, vector: number[], options?: { ttl?: number }): Promise<void>;
```

### `cache.has`

Returns `true` if a cached entry exists for the text.

```typescript
const cached: boolean = await cache.has(text);
```

**Signature:**
```typescript
has(text: string): Promise<boolean>;
```

### `cache.delete`

Removes the cached entry for a text. Returns `true` if the entry existed and was removed.

```typescript
const removed: boolean = await cache.delete(text);
```

**Signature:**
```typescript
delete(text: string): Promise<boolean>;
```

### `cache.clear`

Removes all entries from the cache, or entries matching a filter.

```typescript
await cache.clear();                          // clear everything
await cache.clear({ model: 'ada-002' });      // clear only ada-002 entries
```

**Signature:**
```typescript
clear(options?: { model?: string }): Promise<void>;
```

### `cache.hasChanged`

Returns `true` if the content of a tracked document has changed since last tracked.

```typescript
const changed: boolean = cache.hasChanged('docs/readme.md', currentContent);
```

**Signature:**
```typescript
hasChanged(docId: string, content: string): boolean;
```

This method is synchronous because it only computes and compares SHA-256 hashes -- no storage access required if the document index is held in memory.

### `cache.hasChangedBatch`

Returns a boolean array indicating which chunks have changed since the last `trackDocumentChunks` call.

```typescript
const changedFlags: boolean[] = cache.hasChangedBatch('docs/guide.md', chunks);
```

**Signature:**
```typescript
hasChangedBatch(docId: string, chunks: string[]): boolean[];
```

### `cache.trackDocument`

Records the current content hash of a document for future change detection.

```typescript
await cache.trackDocument('docs/readme.md', content);
```

**Signature:**
```typescript
trackDocument(docId: string, content: string): Promise<void>;
```

### `cache.trackDocumentChunks`

Records the chunk content hashes for a document.

```typescript
await cache.trackDocumentChunks('docs/guide.md', chunks);
```

**Signature:**
```typescript
trackDocumentChunks(docId: string, chunks: string[]): Promise<void>;
```

### `cache.stats`

Returns the current cache statistics.

```typescript
const stats: CacheStats = cache.stats();
console.log(stats.hitRate);              // 0.847 (84.7% hit rate)
console.log(stats.costEstimatedSaved);   // "$12.34 saved"
```

**Signature:**
```typescript
stats(): CacheStats;
```

### `cache.flush`

Writes any pending changes to the underlying storage backend. Call before process exit for filesystem and SQLite backends.

```typescript
await cache.flush();
```

**Signature:**
```typescript
flush(): Promise<void>;
```

### `cache.serialize`

Serializes the entire cache state (embeddings + document hashes) to a JSON string or Buffer.

```typescript
const serialized: string = await cache.serialize();
```

**Signature:**
```typescript
serialize(format?: 'json' | 'binary'): Promise<string | Buffer>;
```

### `EmbedCache.deserialize`

Creates an `EmbedCache` from serialized state.

```typescript
const cache = await EmbedCache.deserialize(serialized, options);
```

**Signature:**
```typescript
static deserialize(
  data: string | Buffer,
  options: EmbedCacheOptions,
): Promise<EmbedCache>;
```

### Type Definitions

```typescript
// ── Embedder Function ─────────────────────────────────────────────────

/**
 * A function that embeds an array of texts and returns an array of vectors.
 * The returned array must have the same length and order as the input array.
 */
type EmbedderFn = (texts: string[]) => Promise<number[][]>;

// ── Options ───────────────────────────────────────────────────────────

/** Options for creating an EmbedCache instance. */
interface EmbedCacheOptions {
  /**
   * The embedding function to call on cache misses.
   * Accepts an array of texts, returns an array of embedding vectors.
   * Required.
   */
  embedder: EmbedderFn;

  /**
   * The embedding model identifier.
   * Included in the cache key -- changing the model invalidates all
   * existing entries for the old model automatically.
   * Required.
   * Examples: 'text-embedding-3-small', 'openai/text-embedding-3-large'
   */
  model: string;

  /**
   * Storage backend for cached embeddings.
   * 'memory' (default) | 'filesystem' | 'filesystem-binary' | 'sqlite' | 'redis'
   * Or a custom StorageBackend instance.
   * Default: 'memory'
   */
  storage?: StorageBackendOption;

  /**
   * Default TTL for cached entries, in milliseconds.
   * Entries older than this are treated as cache misses.
   * Undefined means entries never expire.
   * Default: undefined (no expiry)
   */
  ttl?: number;

  /**
   * Maximum number of entries to keep in the cache.
   * When exceeded, the least recently used entry is evicted.
   * Only applicable to the 'memory' backend.
   * Default: undefined (unlimited)
   */
  maxSize?: number;

  /**
   * Price per million tokens for the configured model.
   * Used to estimate cost savings in stats().
   * If not provided, embed-cache uses built-in prices for known models.
   * For unknown models, cost savings are reported as 0.
   * Default: built-in price for the model, or 0 for unknown models.
   */
  modelPricePerMillion?: number;

  /**
   * Algorithm used to compute cache keys.
   * 'sha256' is collision-resistant and recommended.
   * 'sha1' and 'md5' are faster but have known collision vulnerabilities.
   * Default: 'sha256'
   */
  algorithm?: 'sha256' | 'sha1' | 'md5';

  /**
   * Whether to normalize input text before computing the cache key.
   * Normalization: NFC, trim, collapse whitespace.
   * Setting to false disables normalization (exact string matching).
   * Default: true
   */
  normalizeText?: boolean;
}

// ── Storage Backend Options ───────────────────────────────────────────

type StorageBackendOption =
  | 'memory'
  | { type: 'memory' }
  | { type: 'filesystem'; path: string; debounceMs?: number }
  | { type: 'filesystem-binary'; path: string }
  | { type: 'sqlite'; path: string; walMode?: boolean }
  | { type: 'redis'; url: string; keyPrefix?: string }
  | StorageBackend; // custom

// ── Cache Stats ───────────────────────────────────────────────────────

/** Statistics for the current cache session. */
interface CacheStats {
  /** Total number of embed/embedBatch calls (per text, not per batch call). */
  totalRequests: number;

  /** Number of requests served from the cache. */
  hits: number;

  /** Number of requests that resulted in an embedder call. */
  misses: number;

  /** Cache hit rate: hits / totalRequests. NaN if totalRequests is 0. */
  hitRate: number;

  /** Number of entries currently in the cache. */
  size: number;

  /** Estimated total tokens saved (4 chars per token approximation). */
  tokensEstimatedSaved: number;

  /** Estimated cost saved in USD based on modelPricePerMillion. */
  costEstimatedSaved: number;

  /** Model identifier this cache is configured for. */
  model: string;

  /** ISO 8601 timestamp of when this cache instance was created. */
  createdAt: string;

  /** ISO 8601 timestamp of the most recent cache hit. */
  lastHitAt: string | null;

  /** ISO 8601 timestamp of the most recent cache miss. */
  lastMissAt: string | null;
}

// ── EmbedCache Class ──────────────────────────────────────────────────

interface EmbedCache {
  embed(text: string, options?: EmbedOptions): Promise<number[]>;
  embedBatch(texts: string[], options?: EmbedOptions): Promise<number[][]>;
  get(text: string): Promise<number[] | undefined>;
  set(text: string, vector: number[], options?: { ttl?: number }): Promise<void>;
  has(text: string): Promise<boolean>;
  delete(text: string): Promise<boolean>;
  clear(options?: { model?: string }): Promise<void>;
  hasChanged(docId: string, content: string): boolean;
  hasChangedBatch(docId: string, chunks: string[]): boolean[];
  trackDocument(docId: string, content: string): Promise<void>;
  trackDocumentChunks(docId: string, chunks: string[]): Promise<void>;
  stats(): CacheStats;
  flush(): Promise<void>;
  serialize(format?: 'json' | 'binary'): Promise<string | Buffer>;
  static deserialize(data: string | Buffer, options: EmbedCacheOptions): Promise<EmbedCache>;
}
```

---

## 10. Cost Tracking

### How Savings Are Estimated

When `cache.embed(text)` returns a cached vector (cache hit), the text never reaches the embedding API. The tokens that would have been consumed are "saved." `embed-cache` estimates token count using the widely-used approximation of 4 characters per token, which is accurate to within 10-20% for typical English text and code.

```
estimatedTokens(text) = Math.ceil(text.length / 4)
```

For each cache hit, `estimatedTokens(text)` is added to `tokensEstimatedSaved`.

```
costEstimatedSaved = tokensEstimatedSaved / 1_000_000 * modelPricePerMillion
```

### Built-In Model Prices

The following prices are built in (as of March 2026; update if API pricing changes):

| Model | Price per 1M tokens |
|---|---|
| `openai/text-embedding-3-small` | $0.02 |
| `openai/text-embedding-3-large` | $0.13 |
| `openai/text-embedding-ada-002` | $0.10 |
| `cohere/embed-english-v3.0` | $0.10 |
| `cohere/embed-multilingual-v3.0` | $0.10 |

For unknown models, `modelPricePerMillion` defaults to `0` and `costEstimatedSaved` reports `0`. Set `modelPricePerMillion` explicitly in `EmbedCacheOptions` for custom or unlisted models.

### Example Cost Calculation

A RAG pipeline embeds 100,000 chunks of 512 tokens each (approximately 2,048 characters per chunk) using `text-embedding-3-small`.

- Without cache: 100,000 chunks × 512 tokens = 51.2M tokens × $0.02/1M = $1.024
- With 90% hit rate: 10,000 misses × 512 tokens = 5.12M tokens × $0.02/1M = $0.102
- Savings per run: $0.922
- After 365 runs: $336.43 saved

`cache.stats()` would report:
```json
{
  "totalRequests": 100000,
  "hits": 90000,
  "misses": 10000,
  "hitRate": 0.9,
  "tokensEstimatedSaved": 46080000,
  "costEstimatedSaved": 0.922,
  "model": "openai/text-embedding-3-small"
}
```

### Limitations

Cost estimation is approximate. The 4-char-per-token approximation underestimates token count for non-Latin scripts (Japanese, Chinese, Arabic) and overestimates for some programming languages. For exact token counts, integrate with a tokenizer library (e.g., `tiktoken-node` for OpenAI models) and set actual token counts via a custom `tokenCounter` option.

---

## 11. TTL and Eviction

### TTL (Time-to-Live)

TTL specifies how long a cached entry is valid, in milliseconds. Expired entries are treated as cache misses and re-embedded on the next request.

TTL is optional. When not configured (the default), entries never expire. This is appropriate for most embedding use cases: text is deterministic -- the same text with the same model always produces the same vector, so vectors never become "stale" due to the passage of time. They only become invalid if the model changes (which is handled by the model-aware key) or if storage is cleared.

TTL is appropriate in scenarios where:
- Embeddings are generated from dynamic content that may be updated (e.g., live documents fetched from an external URL).
- The cache is used as a soft cache with budget constraints, not as a permanent store.
- Compliance requirements mandate data retention limits.

**Setting TTL:**
```typescript
// Default TTL for all entries
const cache = createCache({ model: '...', embedder, ttl: 7 * 24 * 60 * 60 * 1000 }); // 7 days

// Per-entry TTL override
const vector = await cache.embed(text, { ttl: 60 * 60 * 1000 }); // 1 hour for this entry
```

**TTL implementation**: Each cached entry stores a `createdAt` timestamp. On read, if `Date.now() - createdAt > ttl`, the entry is treated as a miss and the embedder is called. The expired entry is replaced with the newly computed vector. Expired entries are not proactively evicted from storage (lazy expiry).

For Redis backends, the TTL is passed to Redis's native `EXPIRE` command, which handles expiry at the storage level.

### LRU Eviction

When `maxSize` is configured, the in-memory backend enforces a maximum entry count. When the limit is reached, the least recently used entry is evicted before the new entry is inserted.

LRU order is maintained using a doubly-linked list:
- Every cache hit promotes the accessed entry to the front of the list (most recently used).
- When an entry is inserted and the cache is at capacity, the entry at the tail of the list (least recently used) is evicted.
- Promotion and eviction are O(1).

For filesystem and SQLite backends, `maxSize` is not enforced automatically. Call `cache.evictOldest(n)` to manually evict the `n` least recently accessed entries.

### Model-Change Invalidation

When the `model` option changes between cache instances, the old entries are effectively invisible to the new model (different key namespace). To explicitly reclaim the storage they occupy:

```typescript
// Evict all entries from old model
await cache.clear({ model: 'openai/text-embedding-ada-002' });
```

For the in-memory and filesystem backends, `clear({ model })` scans all keys and evicts those whose model field matches. For SQLite, it executes `DELETE FROM embeddings WHERE model = ?`. For Redis, it uses `SCAN` with a pattern and `DEL`.

---

## 12. Configuration

### `EmbedCacheOptions` Reference

| Option | Type | Default | Description |
|---|---|---|---|
| `embedder` | `EmbedderFn` | required | Embedding function called on cache misses |
| `model` | `string` | required | Embedding model ID, included in cache key |
| `storage` | `StorageBackendOption` | `'memory'` | Storage backend |
| `ttl` | `number` | `undefined` | Default entry TTL in milliseconds |
| `maxSize` | `number` | `undefined` | Max entries before LRU eviction (memory backend only) |
| `modelPricePerMillion` | `number` | built-in or `0` | Cost per 1M tokens in USD for stats |
| `algorithm` | `'sha256' \| 'sha1' \| 'md5'` | `'sha256'` | Hash algorithm for key derivation |
| `normalizeText` | `boolean` | `true` | Normalize text before hashing |

### Storage Backend Configuration Reference

**Filesystem:**

| Option | Type | Default | Description |
|---|---|---|---|
| `path` | `string` | required | Absolute path to the JSON cache file |
| `debounceMs` | `number` | `1000` | Write debounce delay in milliseconds |

**Filesystem-Binary:**

| Option | Type | Default | Description |
|---|---|---|---|
| `path` | `string` | required | Absolute path to the binary cache file |

**SQLite:**

| Option | Type | Default | Description |
|---|---|---|---|
| `path` | `string` | required | Absolute path to the SQLite database file |
| `walMode` | `boolean` | `true` | Enable WAL mode for better concurrency |

**Redis:**

| Option | Type | Default | Description |
|---|---|---|---|
| `url` | `string` | required | Redis connection URL |
| `keyPrefix` | `string` | `'embed-cache:'` | Key prefix for all entries |

### Environment Variable Overrides

The CLI reads configuration from environment variables when flags are not provided:

| Environment Variable | CLI Flag | Description |
|---|---|---|
| `EMBED_CACHE_MODEL` | `--model` | Embedding model ID |
| `EMBED_CACHE_STORAGE` | `--storage` | Backend type: `memory`, `filesystem`, `sqlite`, `redis` |
| `EMBED_CACHE_PATH` | `--path` | Filesystem or SQLite path |
| `EMBED_CACHE_REDIS_URL` | `--redis-url` | Redis connection URL |
| `EMBED_CACHE_TTL` | `--ttl` | Default TTL in milliseconds |
| `EMBED_CACHE_MAX_SIZE` | `--max-size` | Maximum entry count |

---

## 13. CLI

### Installation and Invocation

```bash
# Global install
npm install -g embed-cache
embed-cache stats --path ./cache/embeddings.json

# npx (no install)
npx embed-cache stats --path ./cache/embeddings.json

# Package script
# package.json: { "scripts": { "cache-stats": "embed-cache stats" } }
npm run cache-stats
```

### CLI Binary Name

`embed-cache`

### Commands

#### `embed-cache stats`

Prints cache statistics for a cache file or Redis instance.

```
embed-cache stats [options]

Options:
  --path <path>       Path to filesystem or SQLite cache file
  --redis-url <url>   Redis URL for Redis backend
  --model <model>     Filter stats to a specific model
  --format <format>   Output format: human (default) | json
```

**Human output example:**
```
  embed-cache stats

  Backend:  filesystem (./cache/embeddings.json)
  Model:    openai/text-embedding-3-small
  Entries:  47,293
  File size: 284 MB

  Session stats (since process start):
    Total requests:    0 (no active session)

  Stored metadata (if available):
    Estimated tokens saved:   1,234,567,890
    Estimated cost saved:     $24.69
```

**JSON output**: Emits the `CacheStats` object as a JSON string to stdout.

#### `embed-cache prewarm`

Pre-populates the cache from a JSONL file of texts and their embeddings.

```
embed-cache prewarm [options]

Options:
  --input <path>      Path to JSONL file. Each line: {"text": "...", "embedding": [...]}
  --path <path>       Path to filesystem or SQLite cache file
  --redis-url <url>   Redis URL
  --model <model>     Model ID for the embeddings (required)
  --format <format>   Output format: human (default) | json
```

Each line of the input JSONL file must have a `text` field and an `embedding` field (array of numbers). The command inserts all entries into the cache using `cache.set`.

#### `embed-cache embed`

Embeds a list of texts and stores the results, using a configured embedder.

```
embed-cache embed [options]

Options:
  --input <path>      Path to a text file (one text per line) or JSONL file
  --model <model>     Embedding model (required)
  --path <path>       Cache output path
  --api-key <key>     API key (or set OPENAI_API_KEY / COHERE_API_KEY)
  --provider <name>   Provider: openai (default) | cohere
  --batch-size <n>    Batch size for API calls. Default: 100
  --format <format>   Output format: human (default) | json
```

#### `embed-cache clear`

Clears all entries or entries matching a filter.

```
embed-cache clear [options]

Options:
  --path <path>       Path to filesystem or SQLite cache file
  --redis-url <url>   Redis URL
  --model <model>     Clear only entries for this model
  --confirm           Required flag to confirm the destructive operation
```

#### `embed-cache export`

Exports the cache to a JSONL file.

```
embed-cache export [options]

Options:
  --path <path>       Path to filesystem or SQLite cache file
  --output <path>     Output JSONL file path. Default: stdout
  --model <model>     Export only entries for this model
  --format <fmt>      Output format: jsonl (default) | json
```

### Exit Codes

| Code | Meaning |
|---|---|
| `0` | Success |
| `1` | Operation failed (IO error, connection error, invalid data) |
| `2` | Configuration error (missing required options, invalid flags) |

---

## 14. Integration

### Integration with `memory-dedup`

`memory-dedup` (this monorepo) deduplicates agent memory entries using embedding-based cosine similarity. It requires an `embedder` function and benefits enormously from caching: memory entries are short texts that repeat frequently across sessions. Configure `embed-cache` as the embedder for `memory-dedup`:

```typescript
import { createCache } from 'embed-cache';
import { createDeduplicator } from 'memory-dedup';

const embedCache = createCache({
  model: 'text-embedding-3-small',
  embedder: openaiEmbedder,
  storage: { type: 'sqlite', path: './cache/memory-dedup-embeddings.db' },
});

const dedup = createDeduplicator({
  embedder: (text) => embedCache.embed(text),
  threshold: 0.90,
});
```

When `memory-dedup` calls `sweep()` to re-check all stored entries, `embed-cache` ensures that previously embedded entries are served from cache, reducing the sweep cost to near-zero for unchanged entries.

### Integration with `chunk-smart`

`chunk-smart` (this monorepo) provides intelligent text chunking for RAG pipelines. After chunking, embed the chunks through `embed-cache` to avoid re-embedding unchanged chunks on subsequent runs:

```typescript
import { chunk } from 'chunk-smart';
import { createCache } from 'embed-cache';

const embedCache = createCache({
  model: 'text-embedding-3-small',
  embedder: openaiEmbedder,
  storage: { type: 'sqlite', path: './embed-cache.db' },
});

async function indexDocument(docId: string, content: string) {
  if (!embedCache.hasChanged(docId, content)) return; // skip unchanged docs

  const chunks = chunk(content, { maxTokens: 512 });
  const vectors = await embedCache.embedBatch(chunks);

  await vectorDb.upsert(docId, chunks, vectors);
  await embedCache.trackDocument(docId, content);
}
```

### Integration with `rag-eval-node-ts`

`rag-eval-node-ts` (this monorepo) evaluates RAG pipeline quality. During evaluation, it repeatedly embeds the same test queries, reference chunks, and generated answers for similarity scoring. Wrapping the evaluation embedder with `embed-cache` eliminates redundant embedding calls across evaluation runs:

```typescript
import { createCache } from 'embed-cache';

const evalCache = createCache({
  model: 'text-embedding-3-small',
  embedder: openaiEmbedder,
  storage: { type: 'filesystem', path: './eval-embed-cache.json' },
});

// Pass the cached embedder to the eval framework
const evalResults = await runEval({
  embedder: (texts) => evalCache.embedBatch(texts),
  queries: testQueries,
  retrievedDocs: retrievedResults,
});
```

### Integration with `embed-drift`

`embed-drift` (this monorepo) detects when the distribution of embedding vectors shifts over time, indicating model drift or content distribution changes. `embed-drift` reads stored embeddings and computes distribution statistics. An `embed-cache` SQLite or filesystem backend can serve as the embedding store that `embed-drift` reads from, avoiding the need for a separate embedding storage layer:

```typescript
import { createCache } from 'embed-cache';
import { detectDrift } from 'embed-drift';

const cache = createCache({
  model: 'text-embedding-3-small',
  embedder: openaiEmbedder,
  storage: { type: 'sqlite', path: './embeddings.db' },
});

// Embed current corpus
const currentVectors = await cache.embedBatch(corpusTexts);

// Run drift detection against reference distribution
const driftReport = await detectDrift({
  reference: referenceVectors,
  current: currentVectors,
});
```

### Integration with `embed-cluster`

`embed-cluster` (this monorepo) performs k-means or hierarchical clustering on embedding vectors for topic discovery, content organization, and outlier detection. After embedding a corpus through `embed-cache`, pass the vectors directly to `embed-cluster`:

```typescript
import { createCache } from 'embed-cache';
import { cluster } from 'embed-cluster';

const cache = createCache({ model: 'text-embedding-3-small', embedder: openaiEmbedder });
const vectors = await cache.embedBatch(documentChunks);

const clusters = cluster(vectors, { k: 10, algorithm: 'kmeans' });
```

---

## 15. Testing Strategy

### Unit Tests

Unit tests cover the core cache logic without any embedding API calls. The embedder is a mock function (`jest.fn()` or a manual stub) that returns deterministic vectors.

**Core functionality tests:**
- `embed(text)` calls `embedder` on first call and returns the vector.
- `embed(text)` does not call `embedder` on second call with the same text.
- `embed(text)` does call `embedder` on second call with different text.
- `embedBatch(texts)` with all hits calls `embedder` zero times.
- `embedBatch(texts)` with all misses calls `embedder` exactly once with all texts.
- `embedBatch(texts)` with mixed hits/misses calls `embedder` once with only the missed texts.
- `embedBatch(texts)` with duplicate texts calls `embedder` once per unique text.
- `embedBatch(texts)` returns results in input order.
- `get(text)` returns `undefined` for uncached text.
- `has(text)` returns `false` for uncached text, `true` after `set`.
- `delete(text)` removes the entry and returns `true`.
- `clear()` empties the cache.
- `stats()` reports correct hits, misses, and hitRate.
- TTL expiry: entry is re-fetched after TTL expires.
- LRU eviction: oldest entry is evicted when `maxSize` is exceeded.
- Model-aware keys: `embed(text)` with model A and model B produce different cache entries.
- Text normalization: `embed('hello ')` and `embed('hello')` share the same cache entry.
- `set(text, vector)` followed by `get(text)` returns the same vector.
- Embedder error: if `embedder` throws, `embed` propagates the error and does not cache.

**Change detection tests:**
- `hasChanged(docId, content)` returns `true` for an untracked document.
- `hasChanged(docId, content)` returns `false` after `trackDocument`.
- `hasChanged(docId, newContent)` returns `true` after content changes.
- `hasChangedBatch(docId, chunks)` correctly identifies new and changed chunks.

**Stats tests:**
- `tokensEstimatedSaved` increases by `Math.ceil(text.length / 4)` per hit.
- `costEstimatedSaved` is computed correctly for built-in model prices.

### Backend Tests

Each storage backend has its own test suite that verifies the `StorageBackend` interface contract:
- `get`, `set`, `has`, `delete`, `clear`, `keys`, `size` all behave correctly.
- `set` then `get` returns the same vector.
- `delete` of non-existent key returns `false`.
- `clear()` empties all entries.
- TTL: entries expire after the configured TTL.
- `getMany` (if implemented) returns correct entries for a batch of keys.
- `setMany` (if implemented) stores all entries.
- Persistence (filesystem, SQLite): creating a new backend pointing to the same file sees existing entries.

The filesystem backend test creates a temporary directory (`os.tmpdir()`) and removes it after the test. The SQLite backend test similarly uses a temp file. The Redis backend test runs against a real Redis instance (or a mock via `ioredis-mock`) behind a `REDIS_URL` environment variable; the test suite is skipped if `REDIS_URL` is not set.

### Integration Tests

An integration test suite verifies the full cache-through flow with a real (or recorded) embedding API:
- Pre-warm the cache with a batch of texts.
- Verify that subsequent `embedBatch` calls for the same texts return results without calling the embedder.
- Verify that changing one text in the batch causes exactly one embedder call.

These tests are behind a `TEST_INTEGRATION=true` environment variable flag and are excluded from `npm test` (run via `npm run test:integration`).

### Performance Tests

A benchmark script (`src/__benchmarks__/cache-throughput.ts`) measures:
- Key computation throughput: SHA-256 of a 2 KB string, repetitions per second.
- In-memory cache hit throughput: `embed(text)` on cached text, operations per second.
- Batch optimization: verify that `embedBatch(1000 texts)` with 900 cached calls `embedder` once.

Expected benchmarks on a MacBook Pro M3:
- Key computation: > 100,000 ops/second
- In-memory hit: > 500,000 ops/second
- Batch optimization: verified by asserting `embedder.mock.calls.length === 1`

---

## 16. Performance

### Key Computation Latency

SHA-256 computation for a 2 KB string takes approximately 0.03ms. For a batch of 1,000 strings, key computation takes approximately 30ms -- an imperceptible overhead compared to a typical embedding API call (50-500ms for 1,000 texts in a single batch).

### In-Memory Hit Latency

A cache hit in the in-memory backend is a `Map.get` call followed by a vector copy. For a 1536-dimensional vector, this takes under 0.01ms. The in-memory backend can serve over 500,000 hits per second on a single thread.

### Batch Optimization Gains

The central performance advantage of `embedBatch` over repeated `embed` calls is the API round-trip reduction. Embedding APIs have per-call overhead (HTTP handshake, request serialization, server queue time) of 10-50ms, regardless of how many texts are in the batch. Sending 100 texts in one batch call takes approximately the same time as sending 1 text in one call. Without batch optimization, 100 cache misses in a loop would require 100 API calls totaling 1,000-5,000ms of latency. With `embedBatch`, they require 1 API call totaling 50-100ms.

### Storage Backend Latency

| Backend | Read latency | Write latency |
|---|---|---|
| In-memory | < 0.01ms | < 0.01ms |
| Filesystem (JSON, cached in memory) | < 0.01ms | 1ms (debounced) |
| Filesystem-binary | < 0.1ms | < 0.5ms |
| SQLite (WAL mode) | < 0.5ms | < 1ms |
| Redis (local) | 0.5-2ms | 0.5-2ms |
| Redis (remote) | 1-10ms | 1-10ms |

For latency-sensitive applications, the in-memory backend is the only option with sub-millisecond reads. For persistence with good read performance, SQLite in WAL mode is the recommended choice.

### Memory Footprint

In-memory storage:
- Each 1536-dimensional float vector, stored as `number[]`, occupies approximately 12 KB of JavaScript heap (8 bytes per float × 1536 + array overhead ≈ 12 KB).
- For the binary/JSON key (64 bytes SHA-256 hex): negligible.
- Total per entry: approximately 12 KB.
- 10,000 entries: approximately 120 MB.
- 100,000 entries: approximately 1.2 GB.

For large corpora, use the SQLite or filesystem-binary backend. Both store vectors as packed 32-bit floats (4 bytes per dimension × 1536 = 6,144 bytes per vector), cutting storage to approximately half the in-memory size.

---

## 17. Dependencies

### Runtime Dependencies

The core `embed-cache` package has **zero runtime dependencies** for the in-memory backend. All core functionality uses Node.js built-in modules:

- `node:crypto` -- SHA-256 key computation
- `node:fs/promises` -- filesystem backend reads and writes
- `node:path` -- path utilities
- `node:os` -- temporary directory for tests

### Peer Dependencies (Optional Backends)

| Backend | Peer Dependency | Version |
|---|---|---|
| SQLite | `better-sqlite3` | `^9.0.0` |
| Redis | `ioredis` | `^5.0.0` |

Peer dependencies are not installed automatically. Install them explicitly when using the corresponding backend.

### Dev Dependencies

| Package | Purpose |
|---|---|
| `typescript` | TypeScript compiler |
| `vitest` | Test runner |
| `eslint` | Linting |
| `@types/node` | Node.js type definitions |
| `@types/better-sqlite3` | SQLite type definitions |
| `@types/ioredis` | Redis type definitions |
| `ioredis-mock` | In-memory Redis mock for Redis backend tests |

---

## 18. File Structure

```
embed-cache/
├── src/
│   ├── index.ts                    # Public API exports
│   ├── cache.ts                    # EmbedCache class, main logic
│   ├── key.ts                      # Key derivation: SHA-256(normalize(text) + model)
│   ├── normalize.ts                # Text normalization: trim, NFC, collapse whitespace
│   ├── stats.ts                    # CacheStats tracking and computation
│   ├── backends/
│   │   ├── memory.ts               # In-memory Map backend with LRU
│   │   ├── filesystem.ts           # Filesystem JSON backend
│   │   ├── filesystem-binary.ts    # Filesystem binary backend
│   │   ├── sqlite.ts               # SQLite backend (better-sqlite3)
│   │   └── redis.ts                # Redis backend (ioredis)
│   ├── change-detection.ts         # Document/chunk hash tracking
│   ├── serialization.ts            # cache.serialize / EmbedCache.deserialize
│   ├── cli.ts                      # CLI entry point and command implementations
│   └── types.ts                    # All TypeScript type definitions
├── src/__tests__/
│   ├── cache.test.ts               # Core EmbedCache unit tests
│   ├── key.test.ts                 # Key derivation tests
│   ├── normalize.test.ts           # Text normalization tests
│   ├── stats.test.ts               # Stats tracking tests
│   ├── change-detection.test.ts    # Change detection tests
│   ├── serialization.test.ts       # Serialize/deserialize tests
│   ├── backends/
│   │   ├── memory.test.ts
│   │   ├── filesystem.test.ts
│   │   ├── filesystem-binary.test.ts
│   │   ├── sqlite.test.ts
│   │   └── redis.test.ts
│   └── integration/
│       └── cache-through.test.ts   # Full cache-through integration tests
├── src/__benchmarks__/
│   └── cache-throughput.ts         # Performance benchmarks
├── package.json
├── tsconfig.json
├── README.md
└── SPEC.md
```

---

## 19. Implementation Roadmap

### Phase 1: Core (MVP)

**Goal**: A working in-memory content-addressable embedding cache.

- Implement `key.ts`: `computeKey(text, model, algorithm)` using `node:crypto`.
- Implement `normalize.ts`: `normalizeForKey(text)`.
- Implement `backends/memory.ts`: `MemoryBackend` with `get`, `set`, `has`, `delete`, `clear`, `keys`, `size`.
- Implement `cache.ts`: `EmbedCache` class with `embed`, `embedBatch`, `get`, `set`, `has`, `delete`, `clear`.
- Implement `stats.ts`: `StatsTracker` class tracking hits, misses, tokens saved.
- Implement `createCache(options)` factory.
- Write unit tests for all Phase 1 functionality.
- Export all public types from `types.ts`.
- Wire up `index.ts` exports.

### Phase 2: Change Detection and Serialization

**Goal**: Enable incremental re-indexing and cache portability.

- Implement `change-detection.ts`: `hasChanged`, `hasChangedBatch`, `trackDocument`, `trackDocumentChunks`.
- Implement `serialization.ts`: `cache.serialize()` and `EmbedCache.deserialize()`.
- Add change detection storage to `MemoryBackend`.
- Write unit tests for Phase 2 functionality.
- Add LRU eviction to `MemoryBackend` (`maxSize` option).
- Add TTL support to `MemoryBackend`.

### Phase 3: Persistent Backends

**Goal**: Enable filesystem and SQLite persistence.

- Implement `backends/filesystem.ts`: JSON file backend with write debouncing.
- Implement `backends/filesystem-binary.ts`: packed float32 binary backend.
- Implement `backends/sqlite.ts`: `better-sqlite3` backend with WAL mode.
- Write backend-specific unit tests.
- Test serialization roundtrip with persistent backends.
- Add `flush()` method to `EmbedCache`.

### Phase 4: Redis Backend and CLI

**Goal**: Enable distributed caching and operator tooling.

- Implement `backends/redis.ts`: `ioredis` backend.
- Write Redis backend tests with `ioredis-mock`.
- Implement `cli.ts`: `stats`, `prewarm`, `embed`, `clear`, `export` commands.
- Add CLI binary to `package.json`.
- Write CLI integration tests (spawn CLI as subprocess, verify output and exit codes).
- Add environment variable configuration.

### Phase 5: Polish and Integration

**Goal**: Production-ready quality, integration documentation, and benchmarks.

- Write performance benchmarks (`__benchmarks__/cache-throughput.ts`).
- Document integration patterns with `memory-dedup`, `chunk-smart`, `rag-eval-node-ts`, `embed-drift`, `embed-cluster`.
- Write `README.md` with quickstart, examples, and storage backend comparison table.
- Add `prepublishOnly` checks (build, lint, test).
- Publish v0.1.0 to npm.

---

## 20. Example Use Cases

### Example 1: RAG Re-Indexing with Change Detection

A nightly pipeline re-indexes a document corpus of 50,000 files. Without caching or change detection, every run re-embeds all chunks. With `embed-cache`:

```typescript
import { createCache } from 'embed-cache';
import { chunk } from 'chunk-smart';
import { readdir, readFile } from 'node:fs/promises';

const cache = createCache({
  model: 'text-embedding-3-small',
  embedder: openaiEmbedder,
  storage: { type: 'sqlite', path: './embed-cache.db' },
});

let skipped = 0;
let reembedded = 0;

for await (const file of getDocumentFiles('./corpus')) {
  const content = await readFile(file, 'utf-8');
  const docId = file;

  if (!cache.hasChanged(docId, content)) {
    skipped++;
    continue; // No change -- skip entirely
  }

  const chunks = chunk(content, { maxTokens: 512 });
  const vectors = await cache.embedBatch(chunks);
  await vectorDb.upsert(docId, chunks, vectors);
  await cache.trackDocument(docId, content);
  reembedded++;
}

const stats = cache.stats();
console.log(`Skipped: ${skipped}, Re-embedded: ${reembedded}`);
console.log(`Estimated cost saved this run: $${stats.costEstimatedSaved.toFixed(4)}`);
```

On the second run, if only 5% of documents changed, 95% are skipped by the `hasChanged` check. The 5% that changed call `embedBatch`, which serves any previously embedded chunks from cache and only calls the API for genuinely new text.

### Example 2: Cost Savings Dashboard

A monitoring endpoint exposes real-time cache savings for a high-volume embedding service:

```typescript
import { createCache } from 'embed-cache';
import http from 'node:http';

const cache = createCache({
  model: 'text-embedding-3-small',
  embedder: openaiEmbedder,
  storage: { type: 'redis', url: process.env.REDIS_URL! },
});

// Serve the embedding API with cache-through
app.post('/embed', async (req, res) => {
  const { text } = req.body;
  const vector = await cache.embed(text);
  res.json({ embedding: vector });
});

// Expose cache stats for dashboards
app.get('/cache-stats', (req, res) => {
  res.json(cache.stats());
});
// Returns:
// {
//   "totalRequests": 1234567,
//   "hits": 1049482,
//   "misses": 185085,
//   "hitRate": 0.8501,
//   "tokensEstimatedSaved": 8395856,
//   "costEstimatedSaved": 0.168,
//   "model": "openai/text-embedding-3-small"
// }
```

### Example 3: Document Update Detection in a CMS

A content management system re-embeds documents when they are updated. Using chunk-level change detection, only modified paragraphs are re-embedded:

```typescript
import { createCache } from 'embed-cache';
import { chunk } from 'chunk-smart';

const cache = createCache({
  model: 'text-embedding-3-small',
  embedder: openaiEmbedder,
  storage: { type: 'sqlite', path: './cms-embed-cache.db' },
});

async function onDocumentUpdated(docId: string, newContent: string) {
  const chunks = chunk(newContent, { maxTokens: 512 });
  const changedFlags = cache.hasChangedBatch(docId, chunks);

  const changedIndexes = changedFlags
    .map((changed, i) => (changed ? i : -1))
    .filter(i => i !== -1);

  if (changedIndexes.length === 0) {
    console.log(`Document ${docId}: no chunks changed, skipping re-embed`);
    return;
  }

  const changedChunks = changedIndexes.map(i => chunks[i]);
  const newVectors = await cache.embedBatch(changedChunks);

  await vectorDb.updateChunks(
    docId,
    changedIndexes.map((i, j) => ({ chunkIndex: i, chunk: changedChunks[j], vector: newVectors[j] })),
  );

  await cache.trackDocumentChunks(docId, chunks);
  console.log(`Document ${docId}: re-embedded ${changedIndexes.length}/${chunks.length} changed chunks`);
}
```

### Example 4: Shared Cache Across Multiple Ingestion Workers

A horizontally scaled ingestion system runs 10 workers in parallel. Each worker processes a shard of the document corpus. They share a Redis cache to avoid redundant embedding of common text:

```typescript
// Each worker initializes the same cache pointing to shared Redis
const cache = createCache({
  model: 'text-embedding-3-small',
  embedder: openaiEmbedder,
  storage: {
    type: 'redis',
    url: process.env.REDIS_URL!, // shared Redis instance
    keyPrefix: 'prod-embeddings:',
  },
});

// Worker processes its shard
for (const chunk of workerShard) {
  const vector = await cache.embed(chunk);
  await vectorDb.insert(chunk, vector);
}

// Workers processing overlapping content (shared boilerplate, headers, repeated passages)
// share cached embeddings automatically via Redis
```

The first worker to embed a given text stores it in Redis. All other workers hit the cache for that text. In practice, corpora often have 20-40% of their total text repeated across documents (licenses, headers, boilerplate, quoted passages). Shared caching eliminates embedding cost for all of that repeated content.

### Example 5: Pre-Warming a Development Environment

A developer joining the team can pre-warm their local cache from a shared export file, avoiding hundreds of API calls on first run:

```bash
# On the shared build server, export the current cache
embed-cache export --path /shared/embed-cache.db --output ./cache-export.jsonl

# Developer downloads the export and pre-warms their local cache
embed-cache prewarm \
  --input ./cache-export.jsonl \
  --model text-embedding-3-small \
  --path ./local-embed-cache.db

# Now running the pipeline locally hits the cache instead of calling the API
npm run index-corpus
# 99.8% cache hit rate -- only new documents require API calls
```
