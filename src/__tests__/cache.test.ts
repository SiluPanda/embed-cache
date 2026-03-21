import { describe, it, expect, vi } from 'vitest'
import { createCache } from '../cache'
import type { EmbedderFn } from '../types'

function makeEmbedder(dim = 4): { fn: EmbedderFn; callCount: () => number; lastInput: () => string[] } {
  let count = 0
  let last: string[] = []
  const fn: EmbedderFn = async (texts: string[]) => {
    count++
    last = texts
    return texts.map((t, i) => Array.from({ length: dim }, (_, j) => (i + 1) * (j + 1) + t.length * 0.001))
  }
  return { fn, callCount: () => count, lastInput: () => last }
}

describe('embed()', () => {
  it('caches result: second call does not invoke embedder', async () => {
    const { fn, callCount } = makeEmbedder()
    const cache = createCache({ embedder: fn, model: 'test-model' })
    const v1 = await cache.embed('hello')
    const v2 = await cache.embed('hello')
    expect(callCount()).toBe(1)
    expect(v1).toEqual(v2)
  })

  it('different text triggers a cache miss', async () => {
    const { fn, callCount } = makeEmbedder()
    const cache = createCache({ embedder: fn, model: 'test-model' })
    await cache.embed('hello')
    await cache.embed('world')
    expect(callCount()).toBe(2)
  })

  it('same text different case maps to same key when normalize=true', async () => {
    const { fn, callCount } = makeEmbedder()
    const cache = createCache({ embedder: fn, model: 'test-model', normalizeText: true })
    await cache.embed('  Hello  ')
    await cache.embed('Hello')
    // both normalize to "Hello" so second call is a hit
    expect(callCount()).toBe(1)
  })

  it('bypassCache always calls embedder', async () => {
    const { fn, callCount } = makeEmbedder()
    const cache = createCache({ embedder: fn, model: 'test-model' })
    await cache.embed('hello')
    await cache.embed('hello', { bypassCache: true })
    expect(callCount()).toBe(2)
  })
})

describe('embedBatch()', () => {
  it('collects misses: 3 texts with 1 cached → embedder called with 2 texts', async () => {
    const { fn, callCount, lastInput } = makeEmbedder()
    const cache = createCache({ embedder: fn, model: 'test-model' })
    // pre-warm 'alpha'
    await cache.embed('alpha')
    expect(callCount()).toBe(1)

    const results = await cache.embedBatch(['alpha', 'beta', 'gamma'])
    expect(callCount()).toBe(2)
    expect(lastInput()).toEqual(['beta', 'gamma'])
    expect(results).toHaveLength(3)
    expect(results[0]).toBeDefined()
    expect(results[1]).toBeDefined()
    expect(results[2]).toBeDefined()
  })

  it('bypassCache calls embedder for all texts', async () => {
    const { fn, callCount } = makeEmbedder()
    const cache = createCache({ embedder: fn, model: 'test-model' })
    await cache.embedBatch(['a', 'b'])
    await cache.embedBatch(['a', 'b'], { bypassCache: true })
    expect(callCount()).toBe(2)
  })

  it('returns vectors in correct order', async () => {
    const embedder: EmbedderFn = async (texts) => texts.map((t) => [t.length])
    const cache = createCache({ embedder, model: 'test-model' })
    const results = await cache.embedBatch(['ab', 'abc', 'abcd'])
    expect(results[0]).toEqual([2])
    expect(results[1]).toEqual([3])
    expect(results[2]).toEqual([4])
  })
})

describe('stats', () => {
  it('tracks hits, misses and hitRate correctly', async () => {
    const { fn } = makeEmbedder()
    const cache = createCache({ embedder: fn, model: 'my-model' })
    await cache.embed('x')   // miss
    await cache.embed('x')   // hit
    await cache.embed('x')   // hit
    await cache.embed('y')   // miss
    const s = cache.stats()
    expect(s.hits).toBe(2)
    expect(s.misses).toBe(2)
    expect(s.totalRequests).toBe(4)
    expect(s.hitRate).toBeCloseTo(0.5)
    expect(s.model).toBe('my-model')
  })

  it('reports size and token/cost estimates', async () => {
    const { fn } = makeEmbedder()
    const cache = createCache({ embedder: fn, model: 'my-model', modelPricePerMillion: 2.0 })
    await cache.embed('hello') // miss
    await cache.embed('hello') // hit — 'hello'.length / 4 = ~1 token saved
    const s = cache.stats()
    expect(s.size).toBe(1)
    expect(s.tokensEstimatedSaved).toBeGreaterThan(0)
    expect(s.costEstimatedSaved).toBeGreaterThan(0)
    expect(typeof s.createdAt).toBe('string')
  })
})

describe('clear()', () => {
  it('resets cache entries and stats', async () => {
    const { fn, callCount } = makeEmbedder()
    const cache = createCache({ embedder: fn, model: 'test-model' })
    await cache.embed('hello')
    expect(cache.size).toBe(1)
    cache.clear()
    expect(cache.size).toBe(0)
    await cache.embed('hello')
    expect(callCount()).toBe(2)  // had to re-embed after clear
    const s = cache.stats()
    expect(s.hits).toBe(0)
    expect(s.misses).toBe(1)
  })
})

describe('hasChanged / trackDocument', () => {
  it('hasChanged returns true for unseen docId', async () => {
    const { fn } = makeEmbedder()
    const cache = createCache({ embedder: fn, model: 'test-model' })
    expect(await cache.hasChanged('doc-1', 'content')).toBe(true)
  })

  it('hasChanged returns false after trackDocument with same content', async () => {
    const { fn } = makeEmbedder()
    const cache = createCache({ embedder: fn, model: 'test-model' })
    await cache.trackDocument('doc-1', 'content')
    expect(await cache.hasChanged('doc-1', 'content')).toBe(false)
  })

  it('hasChanged returns true after content changes', async () => {
    const { fn } = makeEmbedder()
    const cache = createCache({ embedder: fn, model: 'test-model' })
    await cache.trackDocument('doc-1', 'original')
    expect(await cache.hasChanged('doc-1', 'modified')).toBe(true)
  })
})

describe('size property', () => {
  it('reflects number of cached entries', async () => {
    const { fn } = makeEmbedder()
    const cache = createCache({ embedder: fn, model: 'test-model' })
    expect(cache.size).toBe(0)
    await cache.embed('a')
    expect(cache.size).toBe(1)
    await cache.embed('b')
    expect(cache.size).toBe(2)
    await cache.embed('a')
    expect(cache.size).toBe(2)
  })
})

describe('serialize()', () => {
  it('returns valid JSON with entries and model', async () => {
    const { fn } = makeEmbedder()
    const cache = createCache({ embedder: fn, model: 'test-model' })
    await cache.embed('hello')
    const raw = cache.serialize()
    const parsed = JSON.parse(raw)
    expect(parsed.model).toBe('test-model')
    expect(parsed.version).toBe(1)
    expect(Array.isArray(parsed.entries)).toBe(true)
    expect(parsed.entries).toHaveLength(1)
    expect(parsed.entries[0]).toHaveProperty('key')
    expect(Array.isArray(parsed.entries[0].vector)).toBe(true)
  })
})

describe('LRU eviction', () => {
  it('evicts least recently used entry when maxSize is exceeded', async () => {
    const calls: string[][] = []
    const embedder: EmbedderFn = async (texts) => {
      calls.push(texts)
      return texts.map(() => [1, 2, 3])
    }
    const cache = createCache({ embedder, model: 'test-model', maxSize: 2 })
    await cache.embed('a')
    await cache.embed('b')
    expect(cache.size).toBe(2)
    // access 'a' to make it MRU, 'b' becomes LRU
    await cache.embed('a')
    // adding 'c' should evict 'b'
    await cache.embed('c')
    expect(cache.size).toBe(2)
    // 'b' was evicted so embedding it again calls embedder
    const beforeCount = calls.length
    await cache.embed('b')
    expect(calls.length).toBe(beforeCount + 1)
  })
})

describe('TTL', () => {
  it('entry expires after TTL and re-embeds on next call', async () => {
    vi.useFakeTimers()
    const { fn, callCount } = makeEmbedder()
    const cache = createCache({ embedder: fn, model: 'test-model', ttl: 100 })
    await cache.embed('hello')
    expect(callCount()).toBe(1)
    vi.advanceTimersByTime(200)
    await cache.embed('hello')
    expect(callCount()).toBe(2)
    vi.useRealTimers()
  })
})
