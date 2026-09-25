import { describe, expect, it } from 'vitest'
import type { Assignment, ClassEntity, Student } from '../src/types'
import { makeClass, makeStudent } from './helpers'
import {
  allPairs,
  buildLedger,
  monthLongPairs,
  pairKeyOf,
  queryPair,
  topPartners,
  weekDeskmatePairs,
} from '../src/lib/deskmates'
import { generatePlan, regenerateWeeks } from '../src/lib/engine'
import { blockedHistoryViolations, computeFairness, previewSwap, weekBlockedPairs, weekHardViolations } from '../src/lib/fairness'
import { normalizeClass } from '../src/lib/storage'
import { ledgerCSV } from '../src/lib/csv'

// 2 排 4 列，过道在第 2|3 列之间：同桌对固定为 (c0,c1) (c2,c3)（每排）
function tinyClass(weeks = 4): ClassEntity {
  const cls = makeClass({ rows: 2, cols: 4, aisles: [1], weeks, seed: 7, frontRows: 1 })
  cls.students = Array.from({ length: 8 }, (_, i) =>
    makeStudent({ id: `t${i + 1}`, name: `同${i + 1}` }),
  )
  return cls
}

function seat(row: number, col: number): string {
  return `r${row}c${col}`
}

// 按「每排两组同桌」给定学生顺序生成 map
function mapOf(ids: [string, string, string, string, string, string, string, string]): Record<string, string> {
  return {
    [seat(0, 0)]: ids[0], [seat(0, 1)]: ids[1], [seat(0, 2)]: ids[2], [seat(0, 3)]: ids[3],
    [seat(1, 0)]: ids[4], [seat(1, 1)]: ids[5], [seat(1, 2)]: ids[6], [seat(1, 3)]: ids[7],
  }
}

const ORDER = ['t1', 't2', 't3', 't4', 't5', 't6', 't7', 't8'] as [string, string, string, string, string, string, string, string]

function asg(week: number, ids: string[]): Assignment {
  return { week, map: mapOf(ids as [string, string, string, string, string, string, string, string]), score: { fairness: 0, repeats: 0 } }
}

describe('同桌台账：逐周记录、任意两人查询', () => {
  it('统计次数与周次（第 1/2/4 周同桌）', () => {
    const cls = tinyClass(4)
    const w2 = [...ORDER]
    // 第 3 周：t1/t2 拆开（t1 与同组右座 t4 换位 → t1 到 c3）
    const w3 = ['t3', 't2', 't4', 't1', 't5', 't6', 't7', 't8']
    cls.assignments = [asg(1, [...ORDER]), asg(2, w2), asg(3, w3), asg(4, [...ORDER])]
    const ledger = buildLedger(cls)

    expect(ledger.totalWeeks).toBe(4)
    expect(queryPair(ledger, 't1', 't2')).toEqual({ count: 3, weeks: [1, 2, 4] })
    expect(queryPair(ledger, 't2', 't1')).toEqual({ count: 3, weeks: [1, 2, 4] }) // 无向
    expect(queryPair(ledger, 't1', 't4')).toEqual({ count: 1, weeks: [3] })
    expect(queryPair(ledger, 't1', 't5')).toEqual({ count: 0, weeks: [] })

    const list = allPairs(ledger)
    const t12 = list.find((p) => p.a === 't1' && p.b === 't2')!
    expect(t12.count).toBe(3)
    expect(t12.weeks).toEqual([1, 2, 4])
  })

  it('某学生和谁坐得最多（并列全部返回）', () => {
    const cls = tinyClass(3)
    cls.assignments = [
      asg(1, [...ORDER]),
      asg(2, ['t2', 't1', 't3', 't4', 't5', 't6', 't7', 't8']), // t1/t2 仍同桌
      asg(3, ['t1', 't2', 't3', 't4', 't5', 't6', 't7', 't8']),
    ]
    const ledger = buildLedger(cls)
    const tops = topPartners(ledger, 't3')
    expect(tops.map((t) => t.other)).toEqual(['t4'])
    expect(tops[0].count).toBe(3)
    // t1：与 t2 三次
    expect(topPartners(ledger, 't1')[0]).toMatchObject({ other: 't2', count: 3 })
    expect(topPartners(ledger, 't999')).toEqual([])
  })

  it('识别「一整个月都跟同一个人坐」（连续 4 周）', () => {
    const cls = tinyClass(6)
    cls.assignments = [
      asg(1, [...ORDER]),
      asg(2, [...ORDER]),
      asg(3, [...ORDER]),
      asg(4, [...ORDER]), // t1/t2 连续 1-4
      asg(5, ['t3', 't2', 't1', 't4', 't5', 't6', 't7', 't8']),
      asg(6, ['t3', 't2', 't1', 't4', 't5', 't6', 't7', 't8']), // t2/t3 连续 5-6（不足 4）
    ]
    const month = monthLongPairs(buildLedger(cls), 4)
    const keys = month.map((m) => pairKeyOf(m.a, m.b))
    expect(keys).toContain('t1|t2')
    expect(keys).not.toContain('t2|t3')
    const t12 = month.find((m) => pairKeyOf(m.a, m.b) === 't1|t2')!
    expect(t12).toMatchObject({ startWeek: 1, endWeek: 4, length: 4 })
  })

  it('连续 5 周也算一个月（段长 5）', () => {
    const cls = tinyClass(5)
    cls.assignments = [1, 2, 3, 4, 5].map((w) => asg(w, [...ORDER]))
    const month = monthLongPairs(buildLedger(cls), 4)
    expect(month.some((m) => pairKeyOf(m.a, m.b) === 't1|t2' && m.length === 5)).toBe(true)
  })
})

describe('同桌次数上限（默认 2，可配置）', () => {
  it('默认上限 2：第 3 次同桌进入超限列表并带周次', () => {
    const cls = tinyClass(3)
    cls.assignments = [1, 2, 3].map((w) => asg(w, [...ORDER]))
    const report = computeFairness(cls)
    expect(report.deskmateLimit).toBe(2)
    const over = report.deskmateOverLimit.find((d) => d.aId === 't1' && d.bId === 't2')
    expect(over).toMatchObject({ count: 3, weeks: [1, 2, 3] })
  })

  it('上限调成 3：同样数据不再超限', () => {
    const cls = tinyClass(3)
    cls.constraints.deskmateLimit = 3
    cls.assignments = [1, 2, 3].map((w) => asg(w, [...ORDER]))
    expect(computeFairness(cls).deskmateOverLimit).toHaveLength(0)
  })

  it('上限调成 1：第 2 次即超限', () => {
    const cls = tinyClass(2)
    cls.constraints.deskmateLimit = 1
    cls.assignments = [1, 2].map((w) => asg(w, [...ORDER]))
    const over = computeFairness(cls).deskmateOverLimit
    expect(over.some((d) => d.aId === 't1' && d.bId === 't2' && d.count === 2)).toBe(true)
  })
})

describe('「以后不要再同桌」：生成强制避开', () => {
  it('20 周生成中，neverPairs 的对一次都不同桌', () => {
    const cls = tinyClass(20)
    cls.neverPairs = [{ a: 't1', b: 't2', createdAt: 1 }]
    cls.assignments = generatePlan(cls)
    for (const a of cls.assignments) {
      expect(weekBlockedPairs(cls, a.map)).toEqual([])
      expect(weekHardViolations(cls, a.week, a.map)).toHaveLength(0)
    }
    // 台账里 t1/t2 记录为 0
    expect(queryPair(buildLedger(cls), 't1', 't2').count).toBe(0)
  })

  it('30 人班 × 4 对永不同桌 × 12 周：零撞车、零硬违反', () => {
    const cls = makeClass({ rows: 5, cols: 8, aisles: [3], weeks: 12, seed: 123, frontRows: 2 })
    cls.students = cls.students.slice(0, 30)
    const ids = cls.students.map((s) => s.id)
    cls.neverPairs = [
      { a: ids[0], b: ids[1], createdAt: 1 },
      { a: ids[2], b: ids[3], createdAt: 1 },
      { a: ids[4], b: ids[5], createdAt: 1 },
      { a: ids[6], b: ids[7], createdAt: 1 },
    ]
    cls.assignments = generatePlan(cls)
    for (const a of cls.assignments) {
      expect(weekBlockedPairs(cls, a.map)).toHaveLength(0)
      expect(weekHardViolations(cls, a.week, a.map)).toHaveLength(0)
    }
  })

  it('手工交换：新制造永不同桌会被拒绝；历史遗留的撞车不拦无关交换', () => {
    const cls = tinyClass(1)
    cls.neverPairs = [{ a: 't1', b: 't2', createdAt: 1 }]
    // t1 在 c0、t2 在 c2（不同桌）；交换 c1(t2 邻座的 t?)…
    cls.assignments = [asg(1, ['t1', 't3', 't2', 't4', 't5', 't6', 't7', 't8'])]
    // 交换 c1(t3) 与 c2(t2) → t1、t2 成为同桌
    const bad = previewSwap(cls, 1, seat(0, 1), seat(0, 2))
    expect(bad.ok).toBe(false)
    expect(bad.reasons.join(' ')).toContain('不要再同桌')

    // 历史遗留：第 1 周 t1/t2 已同桌（标记是事后加的）；交换无关座位应放行
    const legacy = tinyClass(1)
    legacy.neverPairs = [{ a: 't1', b: 't2', createdAt: 1 }]
    legacy.assignments = [asg(1, [...ORDER])]
    expect(blockedHistoryViolations(legacy)).toHaveLength(1)
    const ok = previewSwap(legacy, 1, seat(0, 2), seat(0, 3)) // t3⇄t4，与 t1/t2 无关
    expect(ok.ok).toBe(true)
  })

  it('标记后 regenerateWeeks：只重排受影响周，其他周 map 原样保留', () => {
    const cls = tinyClass(4)
    // t1/t2 在第 2、3 周同桌
    cls.assignments = [
      asg(1, [...ORDER]),
      asg(2, [...ORDER]),
      asg(3, [...ORDER]),
      asg(4, ['t3', 't2', 't1', 't4', 't5', 't6', 't7', 't8']),
    ]
    const week1Before = JSON.stringify(cls.assignments[0].map)
    const week4Before = JSON.stringify(cls.assignments[3].map)
    cls.neverPairs = [{ a: 't1', b: 't2', createdAt: 1 }]
    const next = regenerateWeeks(cls, new Set([2, 3]))
    expect(next).toHaveLength(4)
    expect(JSON.stringify(next.find((a) => a.week === 1)!.map)).toBe(week1Before)
    expect(JSON.stringify(next.find((a) => a.week === 4)!.map)).toBe(week4Before)
    for (const w of [2, 3]) {
      expect(weekBlockedPairs(cls, next.find((a) => a.week === w)!.map)).toHaveLength(0)
    }
  })
})

describe('台账派生随生成/手工调整更新（无冗余存储）', () => {
  it('重新生成某周后，台账周次列表随之变化', () => {
    const cls = tinyClass(4)
    cls.assignments = [1, 2, 3, 4].map((w) => asg(w, [...ORDER]))
    expect(queryPair(buildLedger(cls), 't1', 't2').weeks).toEqual([1, 2, 3, 4])
    // 手工调整第 2 周：t1/t2 拆开
    const a2 = cls.assignments.find((x) => x.week === 2)!
    const map = { ...a2.map }
    map[seat(0, 0)] = 't3'
    map[seat(0, 2)] = 't1'
    a2.map = map
    expect(queryPair(buildLedger(cls), 't1', 't2').weeks).toEqual([1, 3, 4])
  })

  it('小组围坐模式：同组 4 人互为同桌', () => {
    const cls = makeClass({ rows: 2, cols: 2, aisles: [], mode: 'groups', weeks: 1 })
    const students: Student[] = [
      makeStudent({ id: 'g1', name: '甲' }),
      makeStudent({ id: 'g2', name: '乙' }),
      makeStudent({ id: 'g3', name: '丙' }),
      makeStudent({ id: 'g4', name: '丁' }),
    ]
    cls.students = students
    cls.assignments = [
      { week: 1, map: { r0c0: 'g1', r0c1: 'g2', r1c0: 'g3', r1c1: 'g4' }, score: { fairness: 0, repeats: 0 } },
    ]
    const pairs = weekDeskmatePairs(cls, cls.assignments[0].map).map(([a, b]) => `${a}-${b}`)
    expect(pairs.sort()).toEqual(['g1-g2', 'g1-g3', 'g1-g4', 'g2-g3', 'g2-g4', 'g3-g4'].sort())
  })
})

describe('旧数据归一化', () => {
  it('补齐 deskmateLimit / neverPairs，清洗失效与重复的永不同桌对', () => {
    const raw = {
      ...tinyClass(0),
      constraints: { frontRows: 1, heightRule: true, mixTiers: true },
      neverPairs: undefined as never,
    } as unknown as ClassEntity
    const fixed = normalizeClass(raw)
    expect(fixed.constraints.deskmateLimit).toBe(2)
    expect(fixed.neverPairs).toEqual([])

    const messy = {
      ...tinyClass(0),
      neverPairs: [
        { a: 't2', b: 't1', createdAt: 5 }, // 顺序颠倒 → 规范化
        { a: 't1', b: 't2', createdAt: 6 }, // 重复
        { a: 't1', b: 'ghost', createdAt: 7 }, // 学生不存在
        { a: 't3', b: 't3', createdAt: 8 }, // 自己
        { a: 't3', b: 't4', createdAt: 9 },
      ],
    }
    const cleaned = normalizeClass(messy)
    expect(cleaned.neverPairs).toEqual([
      { a: 't1', b: 't2', createdAt: 5, note: undefined },
      { a: 't3', b: 't4', createdAt: 9, note: undefined },
    ])
  })
})

describe('同桌台账 CSV', () => {
  it('含上限、每人最常同桌与全部对的周次', () => {
    const cls = tinyClass(3)
    cls.assignments = [1, 2, 3].map((w) => asg(w, [...ORDER]))
    const rows = ledgerCSV(cls)
    expect(rows[2]).toContain('同桌次数上限：2')
    // 学生行：赵… 同1 的最常同桌为同2、次数 3、周次 1/2/3
    const s1 = rows.find((r) => r[0] === '同1')!
    expect(s1[1]).toBe('同2')
    expect(s1[2]).toBe(3)
    expect(String(s1[3])).toContain('同2:3:第1/2/3周')
    // 全部对表头
    expect(rows.some((r) => r[0] === '全部同桌对（按次数降序）')).toBe(true)
    const pairRow = rows.find((r) => String(r[0]).includes('同1-同2'))!
    expect(pairRow[1]).toBe(3)
    expect(pairRow[2]).toBe('1/2/3')
    expect(pairRow[3]).toBe('是') // 超默认上限 2
  })
})
