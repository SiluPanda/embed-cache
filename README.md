# embed-cache

Content-addressable embedding cache with deduplication, LRU eviction, TTL support, and batch optimization. Zero external runtime dependencies -- caller supplies the embedder function.

[![npm version](https://img.shields.io/npm/v/embed-cache.svg)](https://www.npmjs.com/package/embed-cache)
[![license](https://img.shields.io/npm/l/embed-cache.svg)](https://github.com/SiluPanda/embed-cache/blob/master/LICENSE)
[![node](https://img.shields.io/node/v/embed-cache.svg)](https://nodejs.org/)
[![TypeScript](https://img.shields.io/badge/TypeScript-strict-blue.svg)](https://www.typescriptlang.org/)

---

## Description

Embedding API calls are the dominant ongoing cost in most RAG (Retrieval-Augmented Generation) pipelines. The same text is routinely embedded multiple times: documents are re-indexed on restart, chunked text reappears across overlapping documents, periodic re-indexing jobs sweep all content even when most of it has not changed, and parallel ingestion workers independently embed the same source files.

`embed-cache` wraps any embedding function with a transparent, content-addressable cache. Cache keys are derived from the text content itself (SHA-256 of normalized text + model ID), so identical text always hits the cache regardless of what called it or when. When text has not changed, the API is never called. When it has changed, only the changed text is re-embedded.

Key properties:

- **Content-addressable keys** -- same text + same model always produces the same cache key.
- **Batch optimization** -- `embedBatch()` collects all cache misses and makes a single embedder call.
- **Change detection** -- track documents by ID and detect when content has changed before re-embedding.
- **Cost tracking** -- hit rate, estimated tokens saved, and estimated dollar cost avoided.
- **LRU eviction** -- configurable maximum cache size with least-recently-used eviction.
- **TTL expiry** -- entries expire after a configurable time-to-live, per-entry or globally.
- **Zero runtime dependencies** -- only uses Node.js built-in `node:crypto`. You bring your own embedder.

---

## Installation

```bash
npm install embed-cache
```

Requires Node.js 18 or later.

---

## Quick Start

```typescript
import { createCache } from 'embed-cache';

const cache = createCache({
  embedder: async (texts) => {
    // Call OpenAI, Cohere, or any embedding API
    const resp = await openai.embeddings.create({
      model: 'text-embedding-3-small',
      input: texts,
    });
    return resp.data.map((d) => d.embedding);
  },
  model: 'text-embedding-3-small',
  maxSize: 50_000,
  ttl: 60 * 60 * 1000, // 1 hour
});

// Single embed -- repeated calls never invoke the embedder twice for the same text
const vec = await cache.embed('Hello world');

// Batch embed -- collects all cache misses and makes ONE embedder call
const vecs = await cache.embedBatch(['Hello', 'World', 'Hello']);
// Only calls embedder with ['World'] if 'Hello' is already cached

// Check stats
const s = cache.stats();
console.log(s.hitRate);              // 0-1
console.log(s.tokensEstimatedSaved); // estimated tokens saved via cache hits
console.log(s.costEstimatedSaved);   // estimated USD saved
```

---

## Features

### Batch Optimization

`embedBatch()` separates hits from misses before calling the embedder:

1. Compute a content-addressable key for every text in the batch.
2. Look up all keys in the cache. Cached vectors are returned immediately.
3. Collect all misses into a single array.
4. Call `embedder(missedTexts)` once.
5. Store the new vectors and return all results in the original input order.

This minimizes API calls when a batch contains repeated or previously seen texts.

### Change Detection

Track documents by ID so you can skip re-embedding when content has not changed:

```typescript
await cache.trackDocument('doc-42', content);

// Later, check if the document has changed
if (await cache.hasChanged('doc-42', newContent)) {
  // Content changed -- re-embed
  await cache.trackDocument('doc-42', newContent);
  const vecs = await cache.embedBatch(chunks);
}
```

`hasChanged()` computes a SHA-256 hash of the content and compares it to the stored hash. For untracked documents, it returns `true`.

### Text Normalization

Before computing cache keys, text is normalized to collapse cosmetic variations that produce identical embeddings:

1. Unicode NFC normalization
2. Trim leading and trailing whitespace
3. Collapse runs of internal whitespace to a single space

The normalized form is used only for key computation. The original text is passed to the embedder unchanged.

Normalization is enabled by default. Set `normalizeText: false` to disable it.

### Model-Aware Keys

The model identifier is included in every cache key. Vectors from different models are never mixed. Changing the `model` option automatically separates the key namespace -- no explicit cache bust is required.

Known model aliases are canonicalized automatically:

| Input | Canonical form |
|---|---|
| `text-embedding-3-small` | `openai/text-embedding-3-small` |
| `text-embedding-3-large` | `openai/text-embedding-3-large` |
| `text-embedding-ada-002` | `openai/text-embedding-ada-002` |
| `embed-english-v3.0` | `cohere/embed-english-v3.0` |
| `embed-multilingual-v3.0` | `cohere/embed-multilingual-v3.0` |

Unknown model strings are lowercased and used as-is.

### LRU Eviction

When the cache reaches `maxSize`, the least recently used entry is evicted to make room. Every cache hit promotes the accessed entry to the front of the LRU list. Eviction is O(1) via a doubly-linked list.

### TTL Expiry

Entries expire lazily on access. When a cached entry is read after its TTL has elapsed, it is deleted and treated as a cache miss. TTL can be set globally via the `ttl` option or overridden per-call via `EmbedOptions`.

### Cost Tracking

The cache estimates tokens saved on each hit using a character-to-token approximation (`Math.ceil(text.length / 4)`) and computes dollar cost avoided using the configured `modelPricePerMillion`.

### Serialization

Export the entire cache state as a JSON string for persistence or transfer:

```typescript
const data = cache.serialize();
// data is a JSON string: { entries: [...], model: "...", version: 1 }
```

---

## API Reference

### `createCache(options: EmbedCacheOptions): EmbedCache`

Factory function. Creates and returns a new `EmbedCache` instance.

```typescript
import { createCache } from 'embed-cache';

const cache = createCache({
  embedder: myEmbedderFn,
  model: 'text-embedding-3-small',
});
```

**Parameters:**

| Parameter | Type | Required | Default | Description |
|---|---|---|---|---|
| `options.embedder` | `EmbedderFn` | Yes | -- | Function that accepts an array of texts and returns an array of embedding vectors. |
| `options.model` | `string` | Yes | -- | Model identifier. Included in cache keys to namespace entries by model. |
| `options.ttl` | `number` | No | `undefined` | Default time-to-live in milliseconds for all cache entries. |
| `options.maxSize` | `number` | No | `10000` | Maximum number of cached entries. LRU eviction kicks in when this limit is reached. |
| `options.modelPricePerMillion` | `number` | No | `0.1` | Price in USD per 1 million tokens. Used for cost savings estimation. |
| `options.algorithm` | `'sha256' \| 'sha1' \| 'md5'` | No | `'sha256'` | Hash algorithm for cache key derivation. |
| `options.normalizeText` | `boolean` | No | `true` | Whether to apply NFC normalization, trim, and whitespace collapsing before hashing. |

**Returns:** `EmbedCache`

---

### `EmbedCache.embed(text: string, options?: EmbedOptions): Promise<number[]>`

Embed a single text string. Returns the embedding vector from the cache if available, otherwise calls the embedder, caches the result, and returns it.

```typescript
const vector = await cache.embed('Hello world');
```

**Parameters:**

| Parameter | Type | Required | Default | Description |
|---|---|---|---|---|
| `text` | `string` | Yes | -- | The text to embed. |
| `options.ttl` | `number` | No | global `ttl` | Override the default TTL for this specific entry. |
| `options.bypassCache` | `boolean` | No | `false` | When `true`, skip the cache lookup and always call the embedder. The result is not stored in the cache. |

**Returns:** `Promise<number[]>` -- the embedding vector.

---

### `EmbedCache.embedBatch(texts: string[], options?: EmbedOptions): Promise<number[][]>`

Embed multiple texts in a single call. Looks up all texts in the cache, collects misses, calls the embedder once for all misses, caches the results, and returns all vectors in the original input order.

```typescript
const vectors = await cache.embedBatch(['Hello', 'World', 'Hello']);
// vectors[0] and vectors[2] are the same (both from 'Hello')
// The embedder was only called with the uncached texts
```

**Parameters:**

| Parameter | Type | Required | Default | Description |
|---|---|---|---|---|
| `texts` | `string[]` | Yes | -- | Array of texts to embed. |
| `options.ttl` | `number` | No | global `ttl` | Override the default TTL for entries created by this call. |
| `options.bypassCache` | `boolean` | No | `false` | When `true`, skip all cache lookups and call the embedder with all texts. |

**Returns:** `Promise<number[][]>` -- array of embedding vectors in the same order as the input texts.

---

### `EmbedCache.hasChanged(docId: string, content: string): Promise<boolean>`

Check whether a tracked document's content has changed since it was last tracked.

```typescript
const changed = await cache.hasChanged('doc-42', newContent);
// true if content differs from last trackDocument call, or if docId is untracked
```

**Parameters:**

| Parameter | Type | Required | Description |
|---|---|---|---|
| `docId` | `string` | Yes | Unique identifier for the document. |
| `content` | `string` | Yes | Current content to compare against the stored hash. |

**Returns:** `Promise<boolean>` -- `true` if the content has changed or the document is untracked, `false` if the content matches.

---

### `EmbedCache.trackDocument(docId: string, content: string): Promise<void>`

Record a document's content hash for future change detection via `hasChanged()`.

```typescript
await cache.trackDocument('doc-42', content);
```

**Parameters:**

| Parameter | Type | Required | Description |
|---|---|---|---|
| `docId` | `string` | Yes | Unique identifier for the document. |
| `content` | `string` | Yes | Document content to hash and store. |

**Returns:** `Promise<void>`

---

### `EmbedCache.stats(): CacheStats`

Return current cache statistics including hit rate, token savings, and cost savings.

```typescript
const s = cache.stats();
console.log(s.hitRate);              // 0.75
console.log(s.tokensEstimatedSaved); // 12500
console.log(s.costEstimatedSaved);   // 0.0025
```

**Returns:** `CacheStats` object with the following fields:

| Field | Type | Description |
|---|---|---|
| `totalRequests` | `number` | Total number of embed/embedBatch lookups performed. |
| `hits` | `number` | Number of cache hits. |
| `misses` | `number` | Number of cache misses. |
| `hitRate` | `number` | Ratio of hits to total requests (0 to 1). Returns 0 when no requests have been made. |
| `size` | `number` | Current number of entries in the cache. |
| `tokensEstimatedSaved` | `number` | Estimated total tokens saved via cache hits. |
| `costEstimatedSaved` | `number` | Estimated USD saved, computed as `tokensEstimatedSaved / 1_000_000 * modelPricePerMillion`. |
| `model` | `string` | The model identifier this cache was created with. |
| `createdAt` | `string` | ISO 8601 timestamp of when the cache was created. |

---

### `EmbedCache.serialize(): string`

Serialize the entire cache state to a JSON string. The output includes all cached entries, the model identifier, and a version field.

```typescript
const json = cache.serialize();
// Store to disk, transfer to another environment, etc.
```

**Returns:** `string` -- JSON string with the structure:

```json
{
  "entries": [
    { "key": "abc123...", "vector": [0.1, 0.2, ...] }
  ],
  "model": "text-embedding-3-small",
  "version": 1
}
```

---

### `EmbedCache.clear(): void`

Remove all cached entries and reset all statistics.

```typescript
cache.clear();
console.log(cache.size); // 0
```

---

### `EmbedCache.size: number` (read-only)

The current number of entries in the cache.

```typescript
console.log(cache.size); // 42
```

---

## Types

### `EmbedderFn`

```typescript
type EmbedderFn = (texts: string[]) => Promise<number[][]>;
```

A function that accepts an array of text strings and returns a promise resolving to an array of embedding vectors. Each vector is a `number[]`. The returned array must have the same length as the input array, with vectors in corresponding order.

### `EmbedCacheOptions`

```typescript
interface EmbedCacheOptions {
  embedder: EmbedderFn;
  model: string;
  ttl?: number;
  maxSize?: number;
  modelPricePerMillion?: number;
  algorithm?: 'sha256' | 'sha1' | 'md5';
  normalizeText?: boolean;
}
```

### `EmbedOptions`

```typescript
interface EmbedOptions {
  ttl?: number;
  bypassCache?: boolean;
}
```

### `CacheStats`

```typescript
interface CacheStats {
  totalRequests: number;
  hits: number;
  misses: number;
  hitRate: number;
  size: number;
  tokensEstimatedSaved: number;
  costEstimatedSaved: number;
  model: string;
  createdAt: string;
}
```

### `EmbedCache`

```typescript
interface EmbedCache {
  embed(text: string, options?: EmbedOptions): Promise<number[]>;
  embedBatch(texts: string[], options?: EmbedOptions): Promise<number[][]>;
  hasChanged(docId: string, content: string): Promise<boolean>;
  trackDocument(docId: string, content: string): Promise<void>;
  stats(): CacheStats;
  serialize(): string;
  clear(): void;
  readonly size: number;
}
```

---

## Configuration

### Hash Algorithms

The `algorithm` option controls which hash function is used for cache key derivation:

| Algorithm | Key length | Speed | Collision resistance |
|---|---|---|---|
| `sha256` (default) | 64 hex chars | Fast | Excellent -- no known collisions |
| `sha1` | 40 hex chars | Faster | Weak -- not recommended for adversarial inputs |
| `md5` | 32 hex chars | Fastest | Broken -- use only when speed matters more than security |

For virtually all use cases, the default `sha256` is recommended. Hash computation for a 2 KB text chunk takes under 0.05ms.

### Model Price Defaults

When `modelPricePerMillion` is not provided, it defaults to `0.1` USD per million tokens. For accurate cost tracking, provide the actual price for your model. Reference prices for common models:

| Model | Price per 1M tokens (USD) |
|---|---|
| `text-embedding-3-small` | $0.02 |
| `text-embedding-3-large` | $0.13 |
| `text-embedding-ada-002` | $0.10 |
| `embed-english-v3.0` | $0.10 |
| `embed-multilingual-v3.0` | $0.10 |

### LRU and TTL Interaction

When both `maxSize` and `ttl` are configured, both mechanisms are active independently. An entry can be evicted by LRU pressure (cache is full and the entry is the least recently used) or by TTL expiry (entry is older than its TTL). TTL expiry is lazy -- expired entries are only removed when accessed.

---

## Error Handling

- **Embedder errors propagate.** If the embedder function throws during `embed()` or `embedBatch()`, the error is propagated to the caller. Nothing is written to the cache for the failed call.
- **TTL expiry is transparent.** Expired entries are silently removed on access and treated as cache misses. The embedder is called to produce a fresh vector.
- **LRU eviction is silent.** When the cache is full, the least recently used entry is evicted without notification.

---

## Advanced Usage

### Bypass Cache for Specific Calls

Force a fresh embedding even when the text is cached:

```typescript
const fresh = await cache.embed('Hello', { bypassCache: true });
```

### Per-Entry TTL Override

Set a custom TTL for a specific embed call, overriding the global default:

```typescript
// This entry expires in 5 seconds, regardless of the global TTL
const vec = await cache.embed('time-sensitive query', { ttl: 5000 });
```

### Document Re-Indexing Pipeline

Combine change detection with batch embedding for efficient document re-indexing:

```typescript
const cache = createCache({
  embedder: myEmbedder,
  model: 'text-embedding-3-small',
  modelPricePerMillion: 0.02,
});

for (const doc of documents) {
  if (await cache.hasChanged(doc.id, doc.content)) {
    const chunks = chunkDocument(doc.content);
    const vectors = await cache.embedBatch(chunks);
    await vectorStore.upsert(doc.id, chunks, vectors);
    await cache.trackDocument(doc.id, doc.content);
  }
}

console.log(cache.stats().costEstimatedSaved); // USD saved
```

### Export and Restore Cache State

Serialize the cache for persistence or transfer between environments:

```typescript
import { writeFileSync, readFileSync } from 'fs';

// Export
const data = cache.serialize();
writeFileSync('embedding-cache.json', data);

// The serialized format is a JSON string containing all entries,
// the model identifier, and a version field for forward compatibility.
```

### Custom Embedder Functions

Any function matching the `EmbedderFn` signature works as an embedder:

```typescript
import { createCache, type EmbedderFn } from 'embed-cache';

// OpenAI
const openaiEmbedder: EmbedderFn = async (texts) => {
  const resp = await openai.embeddings.create({
    model: 'text-embedding-3-small',
    input: texts,
  });
  return resp.data.map((d) => d.embedding);
};

// Cohere
const cohereEmbedder: EmbedderFn = async (texts) => {
  const resp = await cohere.embed({
    model: 'embed-english-v3.0',
    texts,
    inputType: 'search_document',
  });
  return resp.embeddings;
};

// Local model (e.g., via HTTP)
const localEmbedder: EmbedderFn = async (texts) => {
  const resp = await fetch('http://localhost:8080/embed', {
    method: 'POST',
    body: JSON.stringify({ texts }),
    headers: { 'Content-Type': 'application/json' },
  });
  const json = await resp.json();
  return json.embeddings;
};
```

---

## TypeScript

`embed-cache` is written in TypeScript with strict mode enabled. All public types are exported from the package entry point:

```typescript
import {
  createCache,
  type EmbedderFn,
  type EmbedCacheOptions,
  type EmbedOptions,
  type CacheStats,
  type EmbedCache,
} from 'embed-cache';
```

Type declarations are included in the published package (`dist/index.d.ts`).

---

## License

MIT
