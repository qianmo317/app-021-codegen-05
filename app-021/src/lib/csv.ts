import type { ClassEntity } from '../types'
import type { FairnessReport } from './fairness'
import { buildSeatIndex } from './layout'
import {
  buildDeskmateLedger,
  overLimitPairs,
  pairHistory,
  summarizeStudents,
  termMonday,
} from './deskmates'

// CSV 导出（带 BOM，Excel 直接打开不乱码）
export function toCSV(rows: (string | number)[][]): string {
  const esc = (v: string | number): string => {
    const s = String(v)
    return /[",\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s
  }
  return '\uFEFF' + rows.map((r) => r.map(esc).join(',')).join('\r\n')
}

export function downloadCSV(filename: string, rows: (string | number)[][]): void {
  const blob = new Blob([toCSV(rows)], { type: 'text/csv;charset=utf-8' })
  const url = URL.createObjectURL(blob)
  const a = document.createElement('a')
  a.href = url
  a.download = filename
  a.click()
  URL.revokeObjectURL(url)
}

// 全班统计表（导出给家长看）
export function fairnessCSV(cls: ClassEntity, report: FairnessReport): (string | number)[][] {
  const rows: (string | number)[][] = []
  rows.push([`班级：${cls.name}`])
  rows.push([`统计周数：${report.totalWeeks}`])
  rows.push([
    '姓名',
    '身高(cm)',
    '视力状况',
    `前${cls.constraints.frontRows}排次数`,
    '前排次数',
    '中排次数',
    '后排次数',
    '中间列次数',
    '平均位置分',
    '最常同桌',
    '同桌次数',
    `重复超限(>${report.limit}次)`,
  ])
  const visionText = { none: '', front_required: '需前排', middle_required: '需中间' } as const
  for (const r of report.rows) {
    const top = r.deskmates[0]
    rows.push([
      r.student.name,
      r.student.heightCm ?? '',
      visionText[r.student.vision],
      r.frontRowsCount,
      r.frontCount,
      r.middleCount,
      r.backCount,
      r.middleColCount,
      r.avgScore.toFixed(2),
      top ? (cls.students.find((s) => s.id === top.studentId)?.name ?? '') : '',
      top ? top.count : 0,
      r.maxDeskmateRepeat > report.limit ? `与${r.deskmates.filter((d) => d.count > report.limit).length}人超限` : '',
    ])
  }
  rows.push([])
  rows.push(['位置分说明：位置分 = 前后排权重(0~2，越小越靠前) + 中间度权重(0~1，越小越靠中间)，分数越低位置越好'])
  if (report.deskmateOverLimit.length) {
    rows.push(['同桌超限对：', ...report.deskmateOverLimit.map((d) => `${d.a}-${d.b}(${d.count}次)`)])
  }
  return rows
}

// 按周座位表（每周一段）
export function weeksCSV(cls: ClassEntity): (string | number)[][] {
  const rows: (string | number)[][] = []
  rows.push([`班级：${cls.name}`])
  rows.push(['周次', '排', '列', '座位号', '学生', '标记'])
  const nameOf = new Map(cls.students.map((s) => [s.id, s.name]))
  const idx = buildSeatIndex(cls.seats, cls.layout)
  for (const asg of [...cls.assignments].sort((a, b) => a.week - b.week)) {
    for (const [seatId, studentId] of Object.entries(asg.map)) {
      const seat = idx.byId.get(seatId)
      if (!seat) continue
      const tagText = seat.tags.filter((t) => t !== 'middle').join('/')
      rows.push([asg.week, seat.row + 1, seat.col + 1, seat.id, nameOf.get(studentId) ?? studentId, tagText])
    }
  }
  return rows
}

// 同桌台账：全部同桌对及周次明细（超限 / 已标记分开另列）
export function deskmatePairsCSV(cls: ClassEntity): (string | number)[][] {
  const ledger = buildDeskmateLedger(cls)
  const nameOf = new Map(cls.students.map((s) => [s.id, s.name]))
  const rows: (string | number)[][] = []
  rows.push([`班级：${cls.name}`])
  rows.push([`统计周数：${ledger.totalWeeks}`])
  rows.push([`同桌次数上限：${ledger.limit}`])
  rows.push(['学生 A', '学生 B', '同桌次数', '同桌周次', '是否超限', '已标记以后不要再同桌'])
  const recs = [...ledger.pairs.values()].sort(
    (x, y) => y.count - x.count || (nameOf.get(x.a) ?? '').localeCompare(nameOf.get(y.a) ?? ''),
  )
  for (const p of recs) {
    rows.push([
      nameOf.get(p.a) ?? p.a,
      nameOf.get(p.b) ?? p.b,
      p.count,
      p.weeks.map((w) => `第${w}周`).join('、'),
      p.overLimit ? '是' : '',
      p.blocked ? '是' : '',
    ])
  }
  const over = overLimitPairs(ledger)
  if (over.length) {
    rows.push([])
    rows.push(['超限对（建议下次换座时分开）：', ...over.map((p) => `${nameOf.get(p.a)}-${nameOf.get(p.b)}(${p.count}次)`)])
  }
  return rows
}

// 每个学生的同桌汇总（最常同桌、整月同桌）
export function deskmateSummaryCSV(cls: ClassEntity): (string | number)[][] {
  const ledger = buildDeskmateLedger(cls)
  const summary = summarizeStudents(cls, ledger)
  const nameOf = new Map(cls.students.map((s) => [s.id, s.name]))
  const rows: (string | number)[][] = []
  const monday = termMonday(cls)
  const iso = `${monday.getFullYear()}-${String(monday.getMonth() + 1).padStart(2, '0')}-${String(monday.getDate()).padStart(2, '0')}`
  rows.push([`班级：${cls.name}`])
  rows.push([`学期第 1 周周一：${iso}`])
  rows.push(['姓名', '不同同桌人数', '最常同桌', '最常同桌次数', '整月同桌记录'])
  for (const s of cls.students) {
    const r = summary.get(s.id)
    rows.push([
      s.name,
      r?.totalPartners ?? 0,
      r?.top ? nameOf.get(r.top.otherId) ?? r.top.otherId : '',
      r?.top?.count ?? 0,
      (r?.monthRuns ?? []).map((m) => `${nameOf.get(m.otherId) ?? m.otherId}（${m.run.label}，第${m.run.weeks[0]}-${m.run.weeks[m.run.weeks.length - 1]}周）`).join('；'),
    ])
  }
  return rows
}

// 指定两个学生的同桌史（查询用）
export function pairHistoryCSV(cls: ClassEntity, aId: string, bId: string): (string | number)[][] {
  const ledger = buildDeskmateLedger(cls)
  const nameOf = new Map(cls.students.map((s) => [s.id, s.name]))
  const rec = pairHistory(ledger, aId, bId)
  const rows: (string | number)[][] = [
    [`班级：${cls.name}`],
    ['学生 A', nameOf.get(aId) ?? aId],
    ['学生 B', nameOf.get(bId) ?? bId],
    ['同桌次数', rec?.count ?? 0],
    ['同桌周次', rec ? rec.weeks.map((w) => `第${w}周`).join('、') : ''],
    ['是否超过上限', rec?.overLimit ? `是（上限 ${ledger.limit} 次，建议下次分开）` : '否'],
    ['已标记以后不要再同桌', rec?.blocked ? '是' : '否'],
  ]
  return rows
}
