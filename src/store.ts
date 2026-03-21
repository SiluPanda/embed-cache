interface StoreEntry {
  vector: Float32Array
  createdAt: number
  ttl?: number
}

interface LruNode {
  prev: string | null
  next: string | null
}

export class MemoryStore {
  private entries = new Map<string, StoreEntry>()
  private nodes = new Map<string, LruNode>()
  private head: string | null = null  // MRU
  private tail: string | null = null  // LRU

  constructor(private maxSize: number) {}

  get(key: string): number[] | null {
    const entry = this.entries.get(key)
    if (!entry) return null
    if (entry.ttl != null && Date.now() > entry.createdAt + entry.ttl) {
      this.removeNode(key)
      this.entries.delete(key)
      return null
    }
    this.moveToFront(key)
    return Array.from(entry.vector)
  }

  set(key: string, vector: number[], options?: { ttl?: number }): void {
    if (this.entries.has(key)) {
      this.moveToFront(key)
      return
    }
    if (this.entries.size >= this.maxSize) {
      this.evictLRU()
    }
    this.entries.set(key, {
      vector: new Float32Array(vector),
      createdAt: Date.now(),
      ttl: options?.ttl,
    })
    this.addToFront(key)
  }

  has(key: string): boolean {
    return this.get(key) !== null
  }

  delete(key: string): void {
    this.removeNode(key)
    this.entries.delete(key)
  }

  clear(): void {
    this.entries.clear()
    this.nodes.clear()
    this.head = null
    this.tail = null
  }

  size(): number {
    return this.entries.size
  }

  keys(): string[] {
    return Array.from(this.entries.keys())
  }

  private addToFront(key: string): void {
    const node: LruNode = { prev: null, next: this.head }
    this.nodes.set(key, node)
    if (this.head !== null) {
      const headNode = this.nodes.get(this.head)
      if (headNode) headNode.prev = key
    }
    this.head = key
    if (this.tail === null) {
      this.tail = key
    }
  }

  private removeNode(key: string): void {
    const node = this.nodes.get(key)
    if (!node) return
    if (node.prev !== null) {
      const prevNode = this.nodes.get(node.prev)
      if (prevNode) prevNode.next = node.next
    } else {
      this.head = node.next
    }
    if (node.next !== null) {
      const nextNode = this.nodes.get(node.next)
      if (nextNode) nextNode.prev = node.prev
    } else {
      this.tail = node.prev
    }
    this.nodes.delete(key)
  }

  private moveToFront(key: string): void {
    if (this.head === key) return
    this.removeNode(key)
    this.addToFront(key)
  }

  private evictLRU(): void {
    if (this.tail === null) return
    const lruKey = this.tail
    this.removeNode(lruKey)
    this.entries.delete(lruKey)
  }
}
