import { MemoryStore } from './store'
import { StatsTracker } from './stats'
import { computeKey } from './key'
import type { EmbedCacheOptions, EmbedOptions, EmbedCache } from './types'

export function createCache(options: EmbedCacheOptions): EmbedCache {
  const store = new MemoryStore(options.maxSize ?? 10000)
  const statsTracker = new StatsTracker()
  const algorithm = options.algorithm ?? 'sha256'
  const normalize = options.normalizeText !== false
  const pricePerMillion = options.modelPricePerMillion ?? 0.1
  const docHashes = new Map<string, string>()

  function getKey(text: string): string {
    return computeKey(text, options.model, algorithm, normalize)
  }

  function estimateTokens(text: string): number {
    return Math.ceil(text.length / 4)
  }

  return {
    async embed(text: string, embedOptions?: EmbedOptions): Promise<number[]> {
      if (embedOptions?.bypassCache) {
        const [vec] = await options.embedder([text])
        return vec
      }
      const key = getKey(text)
      const cached = store.get(key)
      if (cached) {
        statsTracker.recordHit(estimateTokens(text))
        return cached
      }
      statsTracker.recordMiss()
      const [vec] = await options.embedder([text])
      store.set(key, vec, { ttl: embedOptions?.ttl ?? options.ttl })
      return store.get(key) ?? vec
    },

    async embedBatch(texts: string[], embedOptions?: EmbedOptions): Promise<number[][]> {
      if (embedOptions?.bypassCache) {
        return options.embedder(texts)
      }

      const results: number[][] = new Array(texts.length)
      const missIndices: number[] = []
      const missTexts: string[] = []

      for (let i = 0; i < texts.length; i++) {
        const key = getKey(texts[i])
        const cached = store.get(key)
        if (cached) {
          results[i] = cached
          statsTracker.recordHit(estimateTokens(texts[i]))
        } else {
          missIndices.push(i)
          missTexts.push(texts[i])
          statsTracker.recordMiss()
        }
      }

      if (missTexts.length > 0) {
        const newVectors = await options.embedder(missTexts)
        for (let j = 0; j < missIndices.length; j++) {
          const i = missIndices[j]
          store.set(getKey(texts[i]), newVectors[j], { ttl: embedOptions?.ttl ?? options.ttl })
          results[i] = store.get(getKey(texts[i])) ?? newVectors[j]
        }
      }

      return results
    },

    async hasChanged(docId: string, content: string): Promise<boolean> {
      const newHash = computeKey(content, 'doc', 'sha256', normalize)
      const oldHash = docHashes.get(docId)
      return oldHash !== newHash
    },

    async trackDocument(docId: string, content: string): Promise<void> {
      const hash = computeKey(content, 'doc', 'sha256', normalize)
      docHashes.set(docId, hash)
    },

    stats() {
      return statsTracker.get(options.model, store.size(), pricePerMillion)
    },

    serialize(): string {
      const entries: Array<{ key: string; vector: number[] }> = []
      for (const key of store.keys()) {
        const v = store.get(key)
        if (v) entries.push({ key, vector: v })
      }
      return JSON.stringify({ entries, model: options.model, version: 1 })
    },

    clear(): void {
      store.clear()
      statsTracker.reset()
    },

    get size(): number {
      return store.size()
    },
  }
}
