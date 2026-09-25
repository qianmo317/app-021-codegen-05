import { createContext, useCallback, useContext, useEffect, useMemo, useState } from 'react'
import type { ReactNode } from 'react'
import type { Assignment, ClassEntity } from './types'
import { DEFAULT_MAX_DESKMATE_TIMES } from './types'
import { storage } from './lib/storage'
import { uid } from './lib/id'
import { buildSeats } from './lib/layout'
import {
  generateMissingWeeks,
  generatePlan,
  regenerateFrom,
  regenerateSingleWeek,
} from './lib/engine'
import { previewSwap } from './lib/fairness'
import { addBlockedPair, removeBlockedPair } from './lib/deskmates'

// ================= 集中式状态：所有业务逻辑在 Store，组件只做展示与派发 =================

export type RegenMode = 'all' | 'from' | 'week' | 'missing'

export interface RegenOptions {
  week?: number
  seed?: number
  weeks?: number
}

export interface RegenResult {
  ok: boolean
  error?: string
}

// 旧版本数据（无同桌上限 / 黑名单字段）加载时补齐默认值
function normalizeClass(c: ClassEntity): ClassEntity {
  let changed = false
  if (typeof c.constraints?.maxDeskmateTimes !== 'number') {
    c.constraints = { ...c.constraints, maxDeskmateTimes: DEFAULT_MAX_DESKMATE_TIMES }
    changed = true
  }
  if (!Array.isArray(c.blockedPairs)) {
    c.blockedPairs = []
    changed = true
  }
  return changed ? { ...c } : c
}

function thisWeekMondayISO(): string {
  const d = new Date()
  const day = d.getDay() // 0=周日
  d.setDate(d.getDate() - (day === 0 ? 6 : day - 1))
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`
}

interface StoreValue {
  ready: boolean
  classes: ClassEntity[]
  getClass(id: string | undefined): ClassEntity | undefined
  createClass(name: string): Promise<ClassEntity>
  importSample(): Promise<ClassEntity | null>
  deleteClass(id: string): Promise<void>
  updateClass(cls: ClassEntity): Promise<void>
  /** 更新配置（布局/学生/约束）。若影响已生成结果则清空 assignments（noKeep=true 时直接清） */
  updateSetup(cls: ClassEntity, clearAssignments: boolean): Promise<void>
  regenerate(id: string, mode: RegenMode, opts?: RegenOptions): Promise<RegenResult>
  swapStudents(id: string, week: number, seatA: string, seatB: string): Promise<RegenResult>
  undoSwap(id: string): Promise<void>
  canUndo(id: string): boolean
  /** 设置同桌次数上限（默认 2），即时影响超限标记；不改动已有座位表 */
  setDeskmateLimit(id: string, limit: number): Promise<void>
  /** 标记某一对「以后不要再同桌」（此后每周生成都按硬约束避开） */
  blockPair(id: string, a: string, b: string, note?: string): Promise<void>
  /** 取消「以后不要再同桌」标记 */
  unblockPair(id: string, a: string, b: string): Promise<void>
  /** 设置学期第 1 周周一（用于按自然月判定整月同桌）；传空串清空 */
  setTermStart(id: string, iso: string): Promise<void>
}

const Ctx = createContext<StoreValue | null>(null)

export function useStore(): StoreValue {
  const v = useContext(Ctx)
  if (!v) throw new Error('StoreProvider 缺失')
  return v
}

export function StoreProvider({ children }: { children: ReactNode }) {
  const [classes, setClasses] = useState<ClassEntity[]>([])
  const [ready, setReady] = useState(false)
  const [undoRef, setUndoRef] = useState<{ classId: string; week: number; map: Record<string, string> } | null>(null)

  useEffect(() => {
    storage
      .getAll()
      .then((all) =>
        setClasses(
          all
            .map(normalizeClass)
            .sort((a, b) => a.createdAt - b.createdAt),
        ),
      )
      .catch((e) => console.error('读取本地数据失败', e))
      .finally(() => setReady(true))
  }, [])

  const persist = useCallback(async (cls: ClassEntity) => {
    cls.updatedAt = Date.now()
    await storage.put(cls)
    setClasses((prev) => {
      const i = prev.findIndex((c) => c.id === cls.id)
      if (i === -1) return [...prev, cls]
      const copy = [...prev]
      copy[i] = { ...cls }
      return copy
    })
  }, [])

  const getClass = useCallback((id: string | undefined) => classes.find((c) => c.id === id), [classes])

  const createClass = useCallback(
    async (name: string) => {
      const now = Date.now()
      const cls: ClassEntity = {
        id: uid(),
        name: name.trim() || '未命名班级',
        createdAt: now,
        updatedAt: now,
        layout: { rows: 6, cols: 7, aisles: [3], mode: 'rows', doorSide: 'right' },
        seats: [],
        students: [],
        constraints: { frontRows: 2, heightRule: true, mixTiers: true, maxDeskmateTimes: DEFAULT_MAX_DESKMATE_TIMES },
        weeks: 20,
        seed: 42,
        assignments: [],
        blockedPairs: [],
        termStart: thisWeekMondayISO(),
      }
      cls.seats = buildSeats(cls.layout)
      await persist(cls)
      return cls
    },
    [persist],
  )

  const importSample = useCallback(async () => {
    try {
      const res = await fetch('/samples/demo-class.json')
      if (!res.ok) throw new Error(`HTTP ${res.status}`)
      const sample = normalizeClass((await res.json()) as ClassEntity)
      const exists = classes.some((c) => c.id === sample.id)
      if (exists) sample.id = uid()
      if (exists) sample.name = `${sample.name}（副本）`
      sample.createdAt = Date.now()
      sample.updatedAt = Date.now()
      await storage.put(sample)
      setClasses((prev) => [...prev, sample])
      return sample
    } catch (e) {
      console.error('导入示例班级失败', e)
      return null
    }
  }, [classes])

  const deleteClass = useCallback(
    async (id: string) => {
      await storage.remove(id)
      setClasses((prev) => prev.filter((c) => c.id !== id))
    },
    [],
  )

  const updateClass = useCallback(
    async (cls: ClassEntity) => persist(cls),
    [persist],
  )

  const updateSetup = useCallback(
    async (cls: ClassEntity, clearAssignments: boolean) => {
      const next = { ...cls }
      if (clearAssignments && cls.assignments.length > 0) {
        next.assignments = []
      }
      await persist(next)
    },
    [persist],
  )

  const regenerate = useCallback(
    async (id: string, mode: RegenMode, opts?: RegenOptions): Promise<RegenResult> => {
      const cls = classes.find((c) => c.id === id)
      if (!cls) return { ok: false, error: '班级不存在' }
      let working: ClassEntity = { ...cls }
      if (opts?.weeks !== undefined || opts?.seed !== undefined) {
        working = {
          ...working,
          weeks: opts.weeks ?? working.weeks,
          seed: opts.seed ?? working.seed,
        }
      }
      try {
        let assignments: Assignment[]
        switch (mode) {
          case 'all':
            assignments = generatePlan(working, { seed: opts?.seed })
            break
          case 'from':
            assignments = regenerateFrom(working, opts?.week ?? 1, { seed: opts?.seed })
            break
          case 'week':
            assignments = (() => {
              const w = regenerateSingleWeek(working, opts?.week ?? 1, { seed: opts?.seed })
              return working.assignments
                .filter((a) => a.week !== w.week && a.week <= working.weeks)
                .map((a) => ({ ...a, map: { ...a.map }, score: { ...a.score } }))
                .concat([w])
                .sort((a, b) => a.week - b.week)
            })()
            break
          case 'missing':
            assignments = generateMissingWeeks(working, { seed: opts?.seed })
            break
        }
        working.assignments = assignments
        await persist(working)
        return { ok: true }
      } catch (e) {
        const msg = e instanceof Error ? e.message : String(e)
        return { ok: false, error: msg }
      }
    },
    [classes, persist],
  )

  const swapStudents = useCallback(
    async (id: string, week: number, seatA: string, seatB: string): Promise<RegenResult> => {
      const cls = classes.find((c) => c.id === id)
      if (!cls) return { ok: false, error: '班级不存在' }
      const pv = previewSwap(cls, week, seatA, seatB)
      if (!pv.ok) return { ok: false, error: pv.reasons[0] ?? '交换违反硬约束' }
      const asg = cls.assignments.find((a) => a.week === week)
      if (!asg) return { ok: false, error: '该周尚未生成' }
      const map: Record<string, string> = { ...asg.map }
      const a = map[seatA]
      const b = map[seatB]
      if (b) map[seatA] = b
      else delete map[seatA]
      if (a) map[seatB] = a
      setUndoRef({ classId: id, week, map: { ...asg.map } })
      const working: ClassEntity = {
        ...cls,
        assignments: cls.assignments.map((x) =>
          x.week === week ? { ...x, map } : x,
        ),
      }
      await persist(working)
      return { ok: true }
    },
    [classes, persist],
  )

  const undoSwap = useCallback(
    async (id: string) => {
      if (!undoRef || undoRef.classId !== id) return
      const cls = classes.find((c) => c.id === id)
      if (!cls) return
      const working: ClassEntity = {
        ...cls,
        assignments: cls.assignments.map((x) =>
          x.week === undoRef.week ? { ...x, map: { ...undoRef.map } } : x,
        ),
      }
      setUndoRef(null)
      await persist(working)
    },
    [undoRef, classes, persist],
  )

  const canUndo = useCallback((id: string) => undoRef?.classId === id, [undoRef])

  const setDeskmateLimit = useCallback(
    async (id: string, limit: number) => {
      const cls = classes.find((c) => c.id === id)
      if (!cls) return
      const n = Math.max(1, Math.min(20, Math.floor(limit) || DEFAULT_MAX_DESKMATE_TIMES))
      await persist({ ...cls, constraints: { ...cls.constraints, maxDeskmateTimes: n } })
    },
    [classes, persist],
  )

  const blockPair = useCallback(
    async (id: string, a: string, b: string, note?: string) => {
      const cls = classes.find((c) => c.id === id)
      if (!cls || a === b) return
      await persist({ ...cls, blockedPairs: addBlockedPair(cls, a, b, note) })
    },
    [classes, persist],
  )

  const unblockPair = useCallback(
    async (id: string, a: string, b: string) => {
      const cls = classes.find((c) => c.id === id)
      if (!cls) return
      await persist({ ...cls, blockedPairs: removeBlockedPair(cls, a, b) })
    },
    [classes, persist],
  )

  const setTermStart = useCallback(
    async (id: string, iso: string) => {
      const cls = classes.find((c) => c.id === id)
      if (!cls) return
      await persist({ ...cls, termStart: iso || undefined })
    },
    [classes, persist],
  )

  const value = useMemo<StoreValue>(
    () => ({
      ready,
      classes,
      getClass,
      createClass,
      importSample,
      deleteClass,
      updateClass,
      updateSetup,
      regenerate,
      swapStudents,
      undoSwap,
      canUndo,
      setDeskmateLimit,
      blockPair,
      unblockPair,
      setTermStart,
    }),
    [
      ready,
      classes,
      getClass,
      createClass,
      importSample,
      deleteClass,
      updateClass,
      updateSetup,
      regenerate,
      swapStudents,
      undoSwap,
      canUndo,
      setDeskmateLimit,
      blockPair,
      unblockPair,
      setTermStart,
    ],
  )

  return <Ctx.Provider value={value}>{children}</Ctx.Provider>
}
