import type { CacheStats } from './types'

export class StatsTracker {
  private _hits = 0
  private _misses = 0
  private _totalRequests = 0
  private _tokensEstimated = 0
  private createdAt = new Date().toISOString()

  recordHit(estimatedTokens: number): void {
    this._hits++
    this._totalRequests++
    this._tokensEstimated += estimatedTokens
  }

  recordMiss(): void {
    this._misses++
    this._totalRequests++
  }

  get(model: string, size: number, pricePerMillion: number): CacheStats {
    return {
      totalRequests: this._totalRequests,
      hits: this._hits,
      misses: this._misses,
      hitRate: this._totalRequests > 0 ? this._hits / this._totalRequests : 0,
      size,
      tokensEstimatedSaved: this._tokensEstimated,
      costEstimatedSaved: (this._tokensEstimated / 1_000_000) * pricePerMillion,
      model,
      createdAt: this.createdAt,
    }
  }

  reset(): void {
    this._hits = 0
    this._misses = 0
    this._totalRequests = 0
    this._tokensEstimated = 0
  }
}
