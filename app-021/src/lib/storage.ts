import type { ClassEntity, NeverPair } from '../types'

// 数据留在浏览器（IndexedDB），不上传任何学生信息（隐私底线）
export interface Storage {
  getAll(): Promise<ClassEntity[]>
  put(cls: ClassEntity): Promise<void>
  remove(id: string): Promise<void>
}

// 旧版本数据归一化：补齐后加的字段（deskmateLimit / neverPairs），并清洗「永不同桌」名单
export function normalizeClass(raw: ClassEntity): ClassEntity {
  const cls: ClassEntity = { ...raw }
  cls.constraints = {
    frontRows: cls.constraints?.frontRows ?? 2,
    heightRule: cls.constraints?.heightRule ?? true,
    mixTiers: cls.constraints?.mixTiers ?? true,
    deskmateLimit: cls.constraints?.deskmateLimit ?? 2,
  }
  if (!Number.isFinite(cls.constraints.deskmateLimit) || cls.constraints.deskmateLimit < 1) {
    cls.constraints.deskmateLimit = 2
  }
  const valid = new Set((cls.students ?? []).map((s) => s.id))
  const seen = new Set<string>()
  const neverPairs: NeverPair[] = []
  for (const np of cls.neverPairs ?? []) {
    if (!np || !valid.has(np.a) || !valid.has(np.b) || np.a === np.b) continue
    const [a, b] = np.a < np.b ? [np.a, np.b] : [np.b, np.a]
    const key = `${a}|${b}`
    if (seen.has(key)) continue
    seen.add(key)
    neverPairs.push({ a, b, createdAt: np.createdAt ?? 0, note: np.note })
  }
  cls.neverPairs = neverPairs
  cls.assignments ??= []
  return cls
}

export class MemoryStorage implements Storage {
  private map = new Map<string, ClassEntity>()
  async getAll(): Promise<ClassEntity[]> {
    return [...this.map.values()].map((c) => normalizeClass(structuredClone(c)))
  }
  async put(cls: ClassEntity): Promise<void> {
    this.map.set(cls.id, structuredClone(cls))
  }
  async remove(id: string): Promise<void> {
    this.map.delete(id)
  }
}

const DB_NAME = 'app-021-seating'
const STORE = 'classes'

export class IndexedDBStorage implements Storage {
  private dbp: Promise<IDBDatabase> | null = null

  private db(): Promise<IDBDatabase> {
    if (!this.dbp) {
      this.dbp = new Promise((resolve, reject) => {
        const req = indexedDB.open(DB_NAME, 1)
        req.onupgradeneeded = () => {
          const db = req.result
          if (!db.objectStoreNames.contains(STORE)) db.createObjectStore(STORE, { keyPath: 'id' })
        }
        req.onsuccess = () => resolve(req.result)
        req.onerror = () => reject(req.error ?? new Error('IndexedDB 打开失败'))
      })
    }
    return this.dbp
  }

  private async tx<T>(mode: IDBTransactionMode, fn: (store: IDBObjectStore) => IDBRequest<T>): Promise<T> {
    const db = await this.db()
    return new Promise<T>((resolve, reject) => {
      const tx = db.transaction(STORE, mode)
      const req = fn(tx.objectStore(STORE))
      req.onsuccess = () => resolve(req.result)
      req.onerror = () => reject(req.error ?? new Error('IndexedDB 操作失败'))
    })
  }

  async getAll(): Promise<ClassEntity[]> {
    const all = await this.tx<ClassEntity[]>('readonly', (s) => s.getAll() as IDBRequest<ClassEntity[]>)
    return (all ?? []).map(normalizeClass)
  }
  async put(cls: ClassEntity): Promise<void> {
    await this.tx('readwrite', (s) => s.put(cls))
  }
  async remove(id: string): Promise<void> {
    await this.tx('readwrite', (s) => s.delete(id))
  }
}

export const storage: Storage = typeof indexedDB !== 'undefined' ? new IndexedDBStorage() : new MemoryStorage()
