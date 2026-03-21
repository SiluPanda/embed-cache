# embed-cache

Content-addressable embedding cache with deduplication, LRU eviction, TTL support, and batch optimization. Zero external runtime dependencies — caller supplies the embedder function.

## Install

```bash
npm install embed-cache
```

## Quick start

```typescript
import { createCache } from 'embed-cache'

// Provide your own embedder function
const cache = createCache({
  embedder: async (texts) => {
    // call OpenAI, Cohere, or any embedding API
    const resp = await openai.embeddings.create({ model: 'text-embedding-3-small', input: texts })
    return resp.data.map(d => d.embedding)
  },
  model: 'text-embedding-3-small',
  maxSize: 50000,
  ttl: 60 * 60 * 1000,  // 1 hour
})

// Single embed — repeated calls never call the embedder twice for the same text
const vec = await cache.embed('Hello world')

// Batch embed — collects all cache misses and makes ONE embedder call
const vecs = await cache.embedBatch(['Hello', 'World', 'Hello'])
// ^ only calls embedder with ['World'] if 'Hello' is already cached
```

## Batch optimization

`embedBatch()` separates hits from misses before calling the embedder:

1. Check the cache for every text in the batch.
2. Collect all misses into a single array.
3. Call `embedder(missTexts)` once.
4. Store the new vectors and return the full results in original order.

This minimises API calls when a batch contains repeated or previously seen texts.

## Stats

```typescript
const s = cache.stats()
console.log(s.hitRate)              // 0–1
console.log(s.tokensEstimatedSaved) // rough token count saved via cache hits
console.log(s.costEstimatedSaved)   // USD saved (uses modelPricePerMillion option)
```

## Change detection

Track documents so you can skip re-indexing when content has not changed:

```typescript
await cache.trackDocument('doc-42', content)

// later...
if (await cache.hasChanged('doc-42', newContent)) {
  // re-index
  await cache.trackDocument('doc-42', newContent)
}
```

## Options

| Option | Type | Default | Description |
|---|---|---|---|
| `embedder` | `(texts: string[]) => Promise<number[][]>` | required | Embedding function |
| `model` | `string` | required | Model identifier (used as part of cache key) |
| `ttl` | `number` | none | Milliseconds before an entry expires |
| `maxSize` | `number` | `10000` | Maximum number of entries (LRU eviction) |
| `modelPricePerMillion` | `number` | `0.1` | USD per 1M tokens (for cost estimation) |
| `algorithm` | `'sha256'\|'sha1'\|'md5'` | `'sha256'` | Hash algorithm for key derivation |
| `normalizeText` | `boolean` | `true` | NFC + trim + collapse whitespace before hashing |

## Per-call options

```typescript
await cache.embed(text, { bypassCache: true })        // always call embedder
await cache.embed(text, { ttl: 5000 })                // override TTL for this entry
```

## License

MIT
