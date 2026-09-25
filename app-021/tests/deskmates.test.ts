import { describe, expect, it } from 'vitest'
import { generatePlan, regenerateSingleWeek } from '../src/lib/engine'
import {
  addBlockedPair,
  buildDeskmateLedger,
  overLimitPairs,
  pairHistory,
  pairKeyOf,
  removeBlockedPair,
  summarizeStudents,
  weekDeskmatePairs,
  wholeMonthRuns,
} from '../src/lib/deskmates'
import { weekHardViolations } from '../src/lib/fairness'
import type { ClassEntity } from '../src/types'
import { makeClass } from './helpers'

function cls4(weeks = 4): ClassEntity {
  const cls = makeClass({ rows: 2, cols: 2, aisles: [], weeks })
  cls.students = cls.students.slice(0, 4)
  return cls
}

// 1 排 4 座无过道、四人固定座位：同桌关系每周恒定（相邻三对）
function fixedPairClass(weeks: number, termStart: string): ClassEntity {
  const cls = makeClass({ rows: 1, cols: 4, aisles: [], weeks, seed: 1 })
  cls.students = cls.students.slice(0, 4)
  cls.students[0].fixedSeatId = 'r0c0'
  cls.students[1].fixedSeatId = 'r0c1'
  cls.students[2].fixedSeatId = 'r0c2'
  cls.students[3].fixedSeatId = 'r0c3'
  cls.termStart = termStart
  return cls
}

describe('同桌台账：逐周累积与任意两人查询', () => {
  it('累积每周同桌对，周次升序', () => {
    const cls = cls4(6)
    cls.assignments = generatePlan(cls)
    const ledger = buildDeskmateLedger(cls)
    expect(ledger.totalWeeks).toBe(6)
    // 2×2 无过道：每排 1 对同桌，每周恰好 2 对（按对计）
    let total = 0
    for (const rec of ledger.pairs.values()) total += rec.count
    expect(total).toBe(6 * 2)
    for (const rec of ledger.pairs.values()) {
      expect(rec.weeks).toEqual([...rec.weeks].sort((a, b) => a - b))
      expect(rec.count).toBe(rec.weeks.length)
    }
  })

  it('pairHistory 查到次数与周次；没同桌过返回 null', () => {
    const cls = fixedPairClass(3, '2025-09-01')
    cls.assignments = generatePlan(cls)
    const ledger = buildDeskmateLedger(cls)
    const [a, b, c, d] = cls.students.map((s) => s.id)
    const rec = pairHistory(ledger, a, b)!
    expect(rec.count).toBe(3)
    expect(rec.weeks).toEqual([1, 2, 3])
    // a(c0) 与 d(c3) 不相邻，永不同桌
    expect(pairHistory(ledger, a, d)).toBeNull()
    // 无向：b,a 等价
    expect(pairHistory(ledger, b, a)?.weeks).toEqual([1, 2, 3])
    void c
  })

  it('过道两侧不算同桌（按周逐对校验座位）', () => {
    const cls = makeClass({ rows: 1, cols: 4, aisles: [1], weeks: 4 })
    cls.students = cls.students.slice(0, 4)
    cls.assignments = generatePlan(cls)
    // 过道在 c1|c2 之间：每周同桌对只能来自 (c0,c1) 与 (c2,c3) 两块座位
    for (const asg of cls.assignments) {
      const seatOf = new Map<string, string>()
      for (const [seatId, stId] of Object.entries(asg.map)) seatOf.set(seatId, stId)
      const allowed = new Set([
        pairKeyOf(seatOf.get('r0c0')!, seatOf.get('r0c1')!),
        pairKeyOf(seatOf.get('r0c2')!, seatOf.get('r0c3')!),
      ])
      const pairs = weekDeskmatePairs(cls, asg.map)
      expect(pairs).toHaveLength(2)
      for (const [x, y] of pairs) expect(allowed.has(pairKeyOf(x, y))).toBe(true)
    }
  })

  it('每人最常同桌：并列时全部列出', () => {
    const cls = cls4(2)
    cls.assignments = generatePlan(cls)
    const summary = summarizeStudents(cls, buildDeskmateLedger(cls))
    for (const s of cls.students) {
      const r = summary.get(s.id)!
      expect(r.top).toBeDefined()
      expect(r.tied.length).toBeGreaterThanOrEqual(1)
      for (const t of r.tied) expect(t.count).toBe(r.top!.count)
    }
  })
})

describe('同桌台账：超限标记与可配置上限', () => {
  it('默认上限 2：仅 count > 2 进超限列表', () => {
    const cls = cls4(20)
    cls.assignments = generatePlan(cls)
    const ledger = buildDeskmateLedger(cls)
    expect(ledger.limit).toBe(2)
    for (const rec of ledger.pairs.values()) expect(rec.overLimit).toBe(rec.count > 2)
    expect(overLimitPairs(ledger).every((p) => p.count > 2)).toBe(true)
  })

  it('上限改为 1 即时生效（重算台账，不改座位表）', () => {
    const cls = fixedPairClass(3, '2025-09-01')
    cls.assignments = generatePlan(cls)
    const snapshot = cls.assignments.map((a) => a.map)
    cls.constraints = { ...cls.constraints, maxDeskmateTimes: 1 }
    const ledger = buildDeskmateLedger(cls)
    expect(ledger.limit).toBe(1)
    // 1×4 固定座位：相邻三对每周同桌
    expect(overLimitPairs(ledger)).toHaveLength(3)
    expect(overLimitPairs(ledger).every((p) => p.count === 3)).toBe(true)
    // 座位表未被改动
    expect(cls.assignments.map((a) => a.map)).toEqual(snapshot)
  })
})

describe('同桌台账：以后不要再同桌', () => {
  it('添加 / 取消（无向去重）', () => {
    const cls = cls4(2)
    const [a, b] = cls.students.map((s) => s.id)
    cls.blockedPairs = addBlockedPair(cls, a, b)
    expect(cls.blockedPairs).toHaveLength(1)
    cls.blockedPairs = addBlockedPair(cls, b, a) // 反向不重复
    expect(cls.blockedPairs).toHaveLength(1)
    cls.blockedPairs = removeBlockedPair(cls, b, a)
    expect(cls.blockedPairs).toHaveLength(0)
  })

  it('生成的每一周都避开黑名单对，且历史周次不影响后续避开', () => {
    const cls = cls4(10)
    const [a, b] = cls.students.map((s) => s.id)
    cls.blockedPairs = addBlockedPair(cls, a, b)
    cls.assignments = generatePlan(cls)
    for (const asg of cls.assignments) {
      expect(weekHardViolations(cls, asg.week, asg.map).filter((v) => v.includes('不要再同桌'))).toHaveLength(0)
    }
    expect(pairHistory(buildDeskmateLedger(cls), a, b)).toBeNull()
  })

  it('拉黑一对后重新生成当周 → 该周不再同桌，其他周不变', () => {
    const cls = cls4(6)
    cls.assignments = generatePlan(cls)
    // 找第 3 周正在同桌的一对（无固定座位，重排可分开）
    const week3Pairs = [...buildDeskmateLedger(cls).pairs.values()].filter((p) => p.weeks.includes(3))
    expect(week3Pairs.length).toBeGreaterThan(0)
    const target = week3Pairs[0]
    cls.blockedPairs = addBlockedPair(cls, target.a, target.b)
    const keptWeeks = cls.assignments.filter((x) => x.week !== 3)
    const newW3 = regenerateSingleWeek(cls, 3)
    expect(weekHardViolations(cls, 3, newW3.map)).toHaveLength(0)
    const rebuilt: ClassEntity = { ...cls, assignments: [...keptWeeks, newW3].sort((x, y) => x.week - y.week) }
    const hist = pairHistory(buildDeskmateLedger(rebuilt), target.a, target.b)!
    expect(hist.weeks).not.toContain(3)
  })
})

describe('同桌台账：一整个月都跟同一个人坐', () => {
  it('连续同桌周次完整覆盖自然月 → 识别整月记录', () => {
    // 2025-09-01 周一；5 周 = 9/1..10/5，9 月被完整覆盖
    const cls = fixedPairClass(5, '2025-09-01')
    cls.assignments = generatePlan(cls)
    const ledger = buildDeskmateLedger(cls)
    const runs = wholeMonthRuns(cls, ledger)
    const aRuns = runs.get(cls.students[0].id)!
    expect(aRuns.some((m) => m.otherId === cls.students[1].id && m.run.label === '2025 年 9 月')).toBe(true)
    const run = aRuns.find((m) => m.run.label === '2025 年 9 月')!.run
    expect(run.weeks).toEqual([1, 2, 3, 4, 5])
  })

  it('只有 2 周连续同桌不构成整月', () => {
    const cls = fixedPairClass(2, '2025-09-01')
    cls.assignments = generatePlan(cls)
    expect(wholeMonthRuns(cls, buildDeskmateLedger(cls)).size).toBe(0)
  })

  it('整月记录进入每人汇总', () => {
    const cls = fixedPairClass(5, '2025-09-01')
    cls.assignments = generatePlan(cls)
    const summary = summarizeStudents(cls, buildDeskmateLedger(cls))
    const r = summary.get(cls.students[0].id)!
    expect(r.top).toEqual({ otherId: cls.students[1].id, count: 5 })
    expect(r.monthRuns.some((m) => m.otherId === cls.students[1].id)).toBe(true)
  })
})
