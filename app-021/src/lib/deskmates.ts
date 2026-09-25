import type { Assignment, BlockedPair, ClassEntity, StudentId } from '../types'
import { DEFAULT_MAX_DESKMATE_TIMES } from '../types'
import { buildSeatIndex } from './layout'

// ================= 同桌长期跟踪 =================
// 每周座位表中的「同桌对」由座位布局决定（行列模式 = 同排左右相邻且不隔过道；
// 小组模式 = 同组全部成员）。本模块把每一周的同桌对累积成学期台账，
// 支撑：任意两人查询、每人最常同桌、整月同桌、超限标记与「以后不要再同桌」。

/** 无向对的稳定 key（按 id 排序） */
export function pairKeyOf(a: StudentId, b: StudentId): string {
  return a < b ? `${a}|${b}` : `${b}|${a}`
}

/** 某一周座位表里的全部同桌对（无向去重，返回排序后的 id 对） */
export function weekDeskmatePairs(
  cls: ClassEntity,
  map: Record<string, string>,
): [StudentId, StudentId][] {
  const idx = buildSeatIndex(cls.seats, cls.layout)
  const out: [StudentId, StudentId][] = []
  for (const [seatId, studentId] of Object.entries(map)) {
    const seat = idx.byId.get(seatId)
    if (!seat) continue
    const si = seat.row * cls.layout.cols + seat.col
    for (const nb of idx.deskmates[si]) {
      if (nb < si) continue // 按座位下标去重
      const other = map[idx.seats[nb].id]
      if (other && other !== studentId) {
        out.push(studentId < other ? [studentId, other] : [other, studentId])
      }
    }
  }
  return out
}

export interface PairRecord {
  a: StudentId
  b: StudentId
  weeks: number[] // 同桌的周次（升序、去重）
  count: number
  /** 同桌次数是否超过上限（count > limit） */
  overLimit: boolean
  /** 教师是否标记「以后不要再同桌」 */
  blocked: boolean
}

export interface MonthRun {
  year: number
  month: number // 0-based
  label: string // 如 2026年3月
  weeks: number[] // 覆盖整个自然月的连续周次区间
}

export interface StudentDeskmateSummary {
  studentId: StudentId
  top?: { otherId: StudentId; count: number } // 坐得最多的人（并列取首个）
  tied: { otherId: StudentId; count: number }[] // 与 top 并列第一的全部人
  totalPartners: number // 不同同桌人数
  totalTimes: number // 同桌总次数（= 有同桌的周数 × 同桌数）
  monthRuns: { otherId: StudentId; run: MonthRun }[]
}

export interface DeskmateLedger {
  pairs: Map<string, PairRecord>
  byStudent: Map<StudentId, Map<StudentId, number>> // studentId → otherId → 次数
  totalWeeks: number
  limit: number
  blockedKeys: Set<string>
}

export function maxDeskmateLimit(cls: ClassEntity): number {
  const n = cls.constraints.maxDeskmateTimes
  return typeof n === 'number' && Number.isFinite(n) && n >= 1 ? Math.floor(n) : DEFAULT_MAX_DESKMATE_TIMES
}

export function blockedKeySet(cls: ClassEntity): Set<string> {
  const out = new Set<string>()
  for (const p of cls.blockedPairs ?? []) out.add(pairKeyOf(p.a, p.b))
  return out
}

export function isBlockedPair(cls: ClassEntity, a: StudentId, b: StudentId): boolean {
  return blockedKeySet(cls).has(pairKeyOf(a, b))
}

/** 从每周座位表重建学期同桌台账（生成 / 手工调整后直接重算，不另存副本） */
export function buildDeskmateLedger(cls: ClassEntity): DeskmateLedger {
  const pairs = new Map<string, PairRecord>()
  const byStudent = new Map<StudentId, Map<StudentId, number>>()
  for (const s of cls.students) byStudent.set(s.id, new Map())
  const blockedKeys = blockedKeySet(cls)
  const limit = maxDeskmateLimit(cls)

  const assignments: Assignment[] = [...cls.assignments].sort((x, y) => x.week - y.week)
  for (const asg of assignments) {
    for (const [a, b] of weekDeskmatePairs(cls, asg.map)) {
      byStudent.get(a)?.set(b, (byStudent.get(a)?.get(b) ?? 0) + 1)
      byStudent.get(b)?.set(a, (byStudent.get(b)?.get(a) ?? 0) + 1)
      const key = pairKeyOf(a, b)
      const rec =
        pairs.get(key) ??
        ({ a, b, weeks: [], count: 0, overLimit: false, blocked: blockedKeys.has(key) } as PairRecord)
      rec.weeks.push(asg.week)
      rec.count += 1
      pairs.set(key, rec)
    }
  }
  for (const rec of pairs.values()) {
    rec.weeks.sort((x, y) => x - y)
    rec.overLimit = rec.count > limit
    rec.blocked = blockedKeys.has(pairKeyOf(rec.a, rec.b))
  }
  return { pairs, byStudent, totalWeeks: assignments.length, limit, blockedKeys }
}

/** 查任意两个学生：同桌过几次、分别在第几周 */
export function pairHistory(
  ledger: DeskmateLedger,
  a: StudentId,
  b: StudentId,
): PairRecord | null {
  return ledger.pairs.get(pairKeyOf(a, b)) ?? null
}

/** 超过上限的同桌对（按次数降序），列表里标红 + 给出「下次分开」建议 */
export function overLimitPairs(ledger: DeskmateLedger): PairRecord[] {
  return [...ledger.pairs.values()]
    .filter((p) => p.overLimit)
    .sort((x, y) => y.count - x.count || x.a.localeCompare(x.b))
}

/** 每个学生「和谁坐得最多」与整月同桌情况（一眼看出） */
export function summarizeStudents(cls: ClassEntity, ledger: DeskmateLedger): Map<StudentId, StudentDeskmateSummary> {
  const monthRunsByStudent = wholeMonthRuns(cls, ledger)
  const out = new Map<StudentId, StudentDeskmateSummary>()
  for (const s of cls.students) {
    const others = [...(ledger.byStudent.get(s.id)?.entries() ?? [])]
      .map(([otherId, count]) => ({ otherId, count }))
      .sort((x, y) => y.count - x.count || x.otherId.localeCompare(y.otherId))
    const top = others[0]
    const tied = top ? others.filter((o) => o.count === top.count) : []
    let totalTimes = 0
    for (const o of others) totalTimes += o.count
    out.set(s.id, {
      studentId: s.id,
      top,
      tied,
      totalPartners: others.length,
      totalTimes,
      monthRuns: monthRunsByStudent.get(s.id) ?? [],
    })
  }
  return out
}

// ---------- 「一整个月都跟同一个人坐」 ----------

/** 学期第 1 周的周一（termStart 缺失时回退到建班日期所在周的周一） */
export function termMonday(cls: ClassEntity): Date {
  const iso = cls.termStart
  const base = iso ? new Date(iso) : new Date(cls.createdAt || Date.now())
  const d = Number.isNaN(base.getTime()) ? new Date() : new Date(base.getFullYear(), base.getMonth(), base.getDate())
  const day = d.getDay() // 0=周日
  const diff = day === 0 ? -6 : 1 - day
  d.setDate(d.getDate() + diff)
  d.setHours(0, 0, 0, 0)
  return d
}

function mondayOfWeek(cls: ClassEntity, week: number): Date {
  const d = termMonday(cls)
  d.setDate(d.getDate() + (week - 1) * 7)
  return d
}

function monthLabel(year: number, month: number): string {
  return `${year} 年 ${month + 1} 月`
}

/**
 * 找出「连续同桌周次区间完整覆盖某个自然月」的对：
 * 连续周次 w1..w2（每周一到周日）满足 w1 的周一 ≤ 当月 1 号 且 w2 的周日 ≥ 当月最后一天。
 * 返回 studentId → [{ otherId, run }]，每对每月只记一条。
 */
export function wholeMonthRuns(
  cls: ClassEntity,
  ledger: DeskmateLedger,
): Map<StudentId, { otherId: StudentId; run: MonthRun }[]> {
  const out = new Map<StudentId, { otherId: StudentId; run: MonthRun }[]>()
  const push = (sid: StudentId, otherId: StudentId, run: MonthRun) => {
    const list = out.get(sid) ?? []
    list.push({ otherId, run })
    out.set(sid, list)
  }

  for (const rec of ledger.pairs.values()) {
    const weeks = rec.weeks
    // 枚举连续周次段（周次相差 1 即连续）
    let start = 0
    while (start < weeks.length) {
      let end = start
      while (end + 1 < weeks.length && weeks[end + 1] === weeks[end] + 1) end++
      const w1 = weeks[start]
      const w2 = weeks[end]
      start = end + 1
      if (w2 - w1 + 1 < 3) continue // 覆盖整月至少跨 3 周
      const segStart = mondayOfWeek(cls, w1)
      const segEnd = mondayOfWeek(cls, w2)
      segEnd.setDate(segEnd.getDate() + 6) // 末周周日
      // 枚举与区间相交的自然月；连续段不重叠，每对每月最多记一条
      for (
        let cursor = new Date(segStart.getFullYear(), segStart.getMonth(), 1);
        cursor <= segEnd;
        cursor = new Date(cursor.getFullYear(), cursor.getMonth() + 1, 1)
      ) {
        const monthStart = new Date(cursor.getFullYear(), cursor.getMonth(), 1)
        const monthEnd = new Date(cursor.getFullYear(), cursor.getMonth() + 1, 0)
        if (segStart <= monthStart && segEnd >= monthEnd) {
          const run: MonthRun = {
            year: cursor.getFullYear(),
            month: cursor.getMonth(),
            label: monthLabel(cursor.getFullYear(), cursor.getMonth()),
            weeks: collectWeeksInRange(weeks, w1, w2),
          }
          push(rec.a, rec.b, run)
          push(rec.b, rec.a, run)
        }
      }
    }
  }
  for (const list of out.values()) {
    list.sort((x, y) => (y.run.year - x.run.year || y.run.month - x.run.month))
  }
  return out
}

function collectWeeksInRange(weeks: number[], w1: number, w2: number): number[] {
  const out: number[] = []
  for (const w of weeks) {
    if (w >= w1 && w <= w2) out.push(w)
    if (w > w2) break
  }
  return out
}

// ---------- 「以后不要再同桌」名单维护 ----------

export function addBlockedPair(cls: ClassEntity, a: StudentId, b: StudentId, note?: string): BlockedPair[] {
  if (a === b) return cls.blockedPairs ?? []
  const key = pairKeyOf(a, b)
  const cur = cls.blockedPairs ?? []
  if (cur.some((p) => pairKeyOf(p.a, p.b) === key)) return cur
  const [x, y] = a < b ? [a, b] : [b, a]
  return [...cur, { a: x, b: y, createdAt: Date.now(), note }]
}

export function removeBlockedPair(cls: ClassEntity, a: StudentId, b: StudentId): BlockedPair[] {
  const key = pairKeyOf(a, b)
  return (cls.blockedPairs ?? []).filter((p) => pairKeyOf(p.a, p.b) !== key)
}
