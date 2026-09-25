import type { Assignment, ClassEntity, StudentId } from '../types'
import { buildSeatIndex } from './layout'

// ================= 同桌台账（长期盯同桌这件事） =================
// 台账由每周座位表（assignments）直接派生：任何一周重新生成或手工调整后，
// 重新调用 buildLedger() 即可，不存冗余数据，天然跟着更新。

export type PairKey = string // 规范化无向对：`${小id}|${大id}`

export interface PairEntry {
  a: StudentId
  b: StudentId
  weeks: number[] // 升序、去重
  count: number
}

export interface PartnerEntry {
  other: StudentId
  count: number
  weeks: number[]
  longestRun: number // 最长连续同桌周数
  monthRuns: { startWeek: number; endWeek: number; length: number }[] // 连续 ≥ monthWeeks 周的段
}

export interface MonthLongPair {
  a: StudentId
  b: StudentId
  startWeek: number
  endWeek: number
  length: number
}

export interface DeskmateLedger {
  totalWeeks: number
  weeks: number[] // 已生成周次（升序）
  pairs: Map<PairKey, PairEntry>
  partners: Map<StudentId, PartnerEntry[]> // 已按同桌次数降序
}

/** 规范化无向对（按 id 排序，保证 a-b 与 b-a 是同一条记录） */
export function canonicalPair(a: StudentId, b: StudentId): [StudentId, StudentId] {
  return a < b ? [a, b] : [b, a]
}

export function pairKeyOf(a: StudentId, b: StudentId): PairKey {
  const [x, y] = canonicalPair(a, b)
  return `${x}|${y}`
}

export function parsePairKey(key: PairKey): [StudentId, StudentId] {
  const i = key.indexOf('|')
  return [key.slice(0, i), key.slice(i + 1)]
}

/** 提取某一周座位表中全部同桌对（无向、去重）。行列模式=左右相邻不隔过道；小组模式=同组全员 */
export function weekDeskmatePairs(cls: ClassEntity, map: Record<string, string>): [StudentId, StudentId][] {
  const idx = buildSeatIndex(cls.seats, cls.layout)
  const out: [StudentId, StudentId][] = []
  for (const [seatId, studentId] of Object.entries(map)) {
    const seat = idx.byId.get(seatId)
    if (!seat) continue
    const si = seat.row * cls.layout.cols + seat.col
    for (const nb of idx.deskmates[si]) {
      if (nb < si) continue // 每对只收一次（按座位下标去重）
      const other = map[idx.seats[nb].id]
      if (other && other !== studentId) out.push(canonicalPair(studentId, other))
    }
  }
  return out
}

interface Run {
  startWeek: number
  endWeek: number
  length: number
}

/** 把升序周次序列切成连续段（如 [1,2,3,5,6] → 1-3 / 5-6） */
export function runsOf(weeks: number[]): Run[] {
  const runs: Run[] = []
  let start = -1
  let prev = -1
  for (const w of weeks) {
    if (start < 0) {
      start = w
    } else if (w !== prev + 1) {
      runs.push({ startWeek: start, endWeek: prev, length: prev - start + 1 })
      start = w
    }
    prev = w
  }
  if (start >= 0) runs.push({ startWeek: start, endWeek: prev, length: prev - start + 1 })
  return runs
}

/** 由全部周次座位表构建同桌台账 */
export function buildLedger(cls: ClassEntity, monthWeeks = 4): DeskmateLedger {
  const pairWeeks = new Map<PairKey, number[]>()
  const weeks: number[] = []
  const sorted = [...cls.assignments].sort((a: Assignment, b: Assignment) => a.week - b.week)
  for (const asg of sorted) {
    weeks.push(asg.week)
    const seenThisWeek = new Set<PairKey>()
    for (const [a, b] of weekDeskmatePairs(cls, asg.map)) {
      const key = pairKeyOf(a, b)
      if (seenThisWeek.has(key)) continue // 小组模式下同组可能产生重复
      seenThisWeek.add(key)
      const list = pairWeeks.get(key)
      if (list) list.push(asg.week)
      else pairWeeks.set(key, [asg.week])
    }
  }

  const pairs = new Map<PairKey, PairEntry>()
  const byStudent = new Map<StudentId, Map<StudentId, number[]>>()
  for (const [key, list] of pairWeeks) {
    const [a, b] = parsePairKey(key)
    pairs.set(key, { a, b, weeks: list, count: list.length })
    if (!byStudent.has(a)) byStudent.set(a, new Map())
    if (!byStudent.has(b)) byStudent.set(b, new Map())
    byStudent.get(a)!.set(b, list)
    byStudent.get(b)!.set(a, list)
  }

  const partners = new Map<StudentId, PartnerEntry[]>()
  for (const s of cls.students) {
    const map2 = byStudent.get(s.id) ?? new Map<StudentId, number[]>()
    const entries: PartnerEntry[] = [...map2.entries()].map(([other, w]) => {
      const runs = runsOf(w)
      const longestRun = runs.reduce((m, r) => Math.max(m, r.length), 0)
      return {
        other,
        count: w.length,
        weeks: w,
        longestRun,
        monthRuns: runs.filter((r) => r.length >= monthWeeks),
      }
    })
    entries.sort((x, y) => y.count - x.count || x.other.localeCompare(y.other))
    partners.set(s.id, entries)
  }

  return { totalWeeks: weeks.length, weeks, pairs, partners }
}

/** 查询任意两个学生：同桌过几次、分别在第几周 */
export function queryPair(
  ledger: DeskmateLedger,
  a: StudentId,
  b: StudentId,
): { count: number; weeks: number[] } {
  const entry = ledger.pairs.get(pairKeyOf(a, b))
  return entry ? { count: entry.count, weeks: entry.weeks } : { count: 0, weeks: [] }
}

/** 某学生与谁坐得最多（ties 全部返回），含每位同桌的完整统计 */
export function topPartners(ledger: DeskmateLedger, studentId: StudentId): PartnerEntry[] {
  const list = ledger.partners.get(studentId) ?? []
  if (list.length === 0) return []
  const max = list[0].count
  return list.filter((p) => p.count === max)
}

/** 全部「一整个月（连续 monthWeeks 周，默认 4 周）都跟同一个人坐」的同桌段 */
export function monthLongPairs(ledger: DeskmateLedger, monthWeeks = 4): MonthLongPair[] {
  const out: MonthLongPair[] = []
  const seen = new Set<PairKey>()
  for (const entry of ledger.pairs.values()) {
    for (const run of runsOf(entry.weeks)) {
      if (run.length >= monthWeeks) {
        const key = pairKeyOf(entry.a, entry.b)
        if (seen.has(key)) continue
        seen.add(key)
        out.push({ a: entry.a, b: entry.b, ...run })
      }
    }
  }
  return out.sort((x, y) => y.length - x.length || x.startWeek - y.startWeek)
}

/** 同桌次数超过上限（默认 > 2）的全部对，按次数降序 */
export function pairsOverLimit(ledger: DeskmateLedger, limit: number): PairEntry[] {
  return [...ledger.pairs.values()]
    .filter((p) => p.count > limit)
    .sort((x, y) => y.count - x.count || x.weeks[0] - y.weeks[0])
}

/** 全部同桌对（台账列表用），按次数降序、同次数按首次同桌周次升序 */
export function allPairs(ledger: DeskmateLedger): PairEntry[] {
  return [...ledger.pairs.values()].sort(
    (x, y) => y.count - x.count || x.weeks[0] - y.weeks[0] || x.a.localeCompare(y.a),
  )
}
