export type EmbedderFn = (texts: string[]) => Promise<number[][]>

export interface EmbedCacheOptions {
  embedder: EmbedderFn
  model: string
  ttl?: number
  maxSize?: number
  modelPricePerMillion?: number
  algorithm?: 'sha256' | 'sha1' | 'md5'
  normalizeText?: boolean
}

export interface EmbedOptions {
  ttl?: number
  bypassCache?: boolean
}

export interface CacheStats {
  totalRequests: number
  hits: number
  misses: number
  hitRate: number
  size: number
  tokensEstimatedSaved: number
  costEstimatedSaved: number
  model: string
  createdAt: string
}

export interface EmbedCache {
  embed(text: string, options?: EmbedOptions): Promise<number[]>
  embedBatch(texts: string[], options?: EmbedOptions): Promise<number[][]>
  hasChanged(docId: string, content: string): Promise<boolean>
  trackDocument(docId: string, content: string): Promise<void>
  stats(): CacheStats
  serialize(): string
  clear(): void
  readonly size: number
}
