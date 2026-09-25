import { useMemo, useState } from 'react'
import { Link } from '../router'
import { useStore } from '../store'
import {
  buildDeskmateLedger,
  overLimitPairs,
  pairHistory,
  pairKeyOf,
  summarizeStudents,
  wholeMonthRuns,
  type PairRecord,
} from '../lib/deskmates'
import { downloadCSV, deskmatePairsCSV, deskmateSummaryCSV, pairHistoryCSV } from '../lib/csv'
import {
  AlertTriangle,
  ArrowLeft,
  Ban,
  CalendarRange,
  CheckCircle2,
  Download,
  RotateCcw,
  Search,
  Sparkles,
  UserCheck,
  Users,
  X,
} from 'lucide-react'

export function Deskmates({ classId }: { classId: string }) {
  const store = useStore()
  const cls = store.getClass(classId)
  const [qA, setQA] = useState('')
  const [qB, setQB] = useState('')
  const [onlyOver, setOnlyOver] = useState(false)
  const [toast, setToast] = useState<{ text: string; kind: 'ok' | 'err' } | null>(null)

  const ledger = useMemo(() => (cls ? buildDeskmateLedger(cls) : null), [cls])
  const summaries = useMemo(() => (cls && ledger ? summarizeStudents(cls, ledger) : null), [cls, ledger])
  const monthRuns = useMemo(() => (cls && ledger ? wholeMonthRuns(cls, ledger) : null), [cls, ledger])

  if (!cls || !ledger || !summaries || !monthRuns) {
    return (
      <div className="page">
        <p>班级不存在。</p>
        <Link to="/">返回</Link>
      </div>
    )
  }

  const nameOf = new Map(cls.students.map((s) => [s.id, s.name]))
  const flash = (text: string, kind: 'ok' | 'err' = 'ok') => {
    setToast({ text, kind })
    window.setTimeout(() => setToast(null), 3200)
  }

  const block = async (a: string, b: string) => {
    await store.blockPair(cls.id, a, b)
    flash('已标记「以后不要再同桌」，之后每周生成都会自动避开这一对（已生成的周次可在轮换页重排）')
  }
  const unblock = async (a: string, b: string) => {
    await store.unblockPair(cls.id, a, b)
    flash('已取消标记')
  }

  const over = overLimitPairs(ledger)
  const queried = qA && qB && qA !== qB ? pairHistory(ledger, qA, qB) : null

  const allRecs = [...ledger.pairs.values()].sort((x, y) => {
    if (y.count !== x.count) return y.count - x.count
    return (nameOf.get(x.a) ?? '').localeCompare(nameOf.get(y.a) ?? '')
  })
  const shownRecs = onlyOver ? allRecs.filter((r) => r.overLimit) : allRecs

  // 整月同桌：聚合所有学生的记录，按对+月份去重
  const monthEntries = (() => {
    const seen = new Set<string>()
    const out: { key: string; a: string; b: string; label: string; weeks: number[] }[] = []
    for (const rec of allRecs) {
      const runs = monthRuns.get(rec.a)?.filter((m) => m.otherId === rec.b) ?? []
      for (const m of runs) {
        const dedupKey = `${rec.a}|${rec.b}|${m.run.label}`
        if (seen.has(dedupKey)) continue
        seen.add(dedupKey)
        out.push({ key: pairKeyOf(rec.a, rec.b), a: rec.a, b: rec.b, label: m.run.label, weeks: m.run.weeks })
      }
    }
    return out
  })()

  // 最常同桌：按次数排序（并列保留全部）
  const topList = cls.students
    .map((s) => ({ s, sum: summaries.get(s.id)! }))
    .filter((x) => x.sum.top)
    .sort((x, y) => (y.sum.top?.count ?? 0) - (x.sum.top?.count ?? 0))

  const blockedPairs = cls.blockedPairs ?? []

  return (
    <div className="page page-wide">
      <div className="page-head">
        <Link className="back" to="/">
          <ArrowLeft size={14} /> 班级列表
        </Link>
        <h1>{cls.name} · 同桌台账</h1>
        <nav className="tabs">
          <Link className="tab" to={`/class/${cls.id}/setup`}>
            座位与学生
          </Link>
          <Link className="tab" to={`/class/${cls.id}/rotations`}>
            轮换结果
          </Link>
          <Link className="tab" to={`/class/${cls.id}/fairness`}>
            公平性报告
          </Link>
          <span className="tab tab-active">同桌台账</span>
          <Link className="tab" to={`/class/${cls.id}/print`}>
            打印
          </Link>
        </nav>
      </div>

      {/* 汇总卡片 */}
      <div className="summary-cards" data-testid="desk-summary">
        <div className="card stat">
          <span className="stat-num">{ledger.totalWeeks}</span>
          <span className="stat-label">已记录周数</span>
        </div>
        <div className="card stat">
          <span className={`stat-num ${over.length ? 'bad' : 'good'}`} data-testid="desk-over-count">
            {over.length}
          </span>
          <span className="stat-label">同桌超 {ledger.limit} 次的对</span>
        </div>
        <div className="card stat">
          <span className={`stat-num ${monthEntries.length ? 'warn' : ''}`} data-testid="desk-month-count">
            {monthEntries.length}
          </span>
          <span className="stat-label">整月同桌记录</span>
        </div>
        <div className="card stat">
          <span className="stat-num" data-testid="desk-blocked-count">
            {blockedPairs.length}
          </span>
          <span className="stat-label">已标记「不要再同桌」</span>
        </div>
      </div>

      {/* 设置条：上限 / 学期起始周一 / 导出 */}
      <section className="card gen-panel" data-testid="desk-settings">
        <div className="row-flex wrap">
          <label className="inline-label">
            同桌次数上限（超过即标红）
            <input
              type="number"
              min={1}
              max={10}
              className="input input-sm"
              value={ledger.limit}
              data-testid="desk-limit-input"
              onChange={(e) => {
                const v = Number(e.target.value)
                if (v >= 1) store.setDeskmateLimit(cls.id, v)
              }}
            />
          </label>
          <label className="inline-label">
            学期第 1 周周一（用于按自然月判定整月同桌）
            <input
              type="date"
              className="input input-sm"
              value={cls.termStart ?? ''}
              data-testid="term-start-input"
              onChange={(e) => store.setTermStart(cls.id, e.target.value)}
            />
          </label>
          <span className="spacer" />
          <button
            className="btn"
            data-testid="export-pairs-csv"
            onClick={() => downloadCSV(`${cls.name}-同桌台账.csv`, deskmatePairsCSV(cls))}
          >
            <Download size={15} /> 导出同桌对
          </button>
          <button
            className="btn"
            data-testid="export-summary-csv"
            onClick={() => downloadCSV(`${cls.name}-同桌汇总.csv`, deskmateSummaryCSV(cls))}
          >
            <Download size={15} /> 导出每人汇总
          </button>
        </div>
      </section>

      {ledger.totalWeeks === 0 ? (
        <div className="empty-hint">
          <p>还没有任何周的座位记录。先到「轮换结果」页生成，之后每周同桌都会自动记到这里。</p>
          <Link className="btn btn-primary" to={`/class/${cls.id}/rotations`}>
            去生成轮换
          </Link>
        </div>
      ) : (
        <>
          {/* 任意两人查询 */}
          <section className="card" data-testid="pair-query">
            <h2>
              <Search size={18} /> 查两个学生这学期同桌过几次
            </h2>
            <div className="row-flex wrap">
              <select className="input select-md" value={qA} data-testid="query-a" onChange={(e) => setQA(e.target.value)}>
                <option value="">选择学生 A</option>
                {cls.students.map((s) => (
                  <option key={s.id} value={s.id}>
                    {s.name}
                  </option>
                ))}
              </select>
              <span className="muted">×</span>
              <select className="input select-md" value={qB} data-testid="query-b" onChange={(e) => setQB(e.target.value)}>
                <option value="">选择学生 B</option>
                {cls.students.map((s) => (
                  <option key={s.id} value={s.id}>
                    {s.name}
                  </option>
                ))}
              </select>
              {qA && qB && qA === qB && <span className="bad">请选择两个不同的学生</span>}
              {queried && (
                <button
                  className="btn btn-sm"
                  data-testid="query-export"
                  onClick={() =>
                    downloadCSV(
                      `${nameOf.get(qA)}-${nameOf.get(qB)}-同桌记录.csv`,
                      pairHistoryCSV(cls, qA, qB),
                    )
                  }
                >
                  <Download size={13} /> 导出这对
                </button>
              )}
            </div>
            {queried ? (
              <PairResult cls={cls} rec={queried} onBlock={() => block(qA, qB)} onUnblock={() => unblock(qA, qB)} />
            ) : (
              qA &&
              qB &&
              qA !== qB && (
                <div className="query-result" data-testid="query-result-none">
                  <CheckCircle2 size={16} className="good" />
                  <span>
                    <b>{nameOf.get(qA)}</b> 与 <b>{nameOf.get(qB)}</b> 这学期还没有同桌过（0 次）。
                  </span>
                </div>
              )
            )}
          </section>

          {/* 超限对：标红 + 建议 */}
          {over.length > 0 && (
            <section className="card error-card" data-testid="over-limit-list">
              <h2>
                <AlertTriangle size={18} /> 同桌超过上限（{ledger.limit} 次）—— 下次换座建议分开
              </h2>
              <div className="table-wrap">
                <table className="table">
                  <thead>
                    <tr>
                      <th>学生 A</th>
                      <th>学生 B</th>
                      <th>同桌次数</th>
                      <th>同桌周次</th>
                      <th>操作</th>
                    </tr>
                  </thead>
                  <tbody>
                    {over.map((p) => (
                      <tr key={pairKeyOf(p.a, p.b)} className="row-danger" data-testid="over-row">
                        <td>{nameOf.get(p.a)}</td>
                        <td>{nameOf.get(p.b)}</td>
                        <td>
                          <span className="badge badge-danger" data-testid="over-count">
                            {p.count} 次
                          </span>
                        </td>
                        <td className="week-chips">
                          {p.weeks.map((w) => (
                            <span key={w} className="week-chip">
                              第 {w} 周
                            </span>
                          ))}
                        </td>
                        <td>
                          {p.blocked ? (
                            <button className="btn btn-sm" data-testid="unblock-btn" onClick={() => unblock(p.a, p.b)}>
                              <RotateCcw size={13} /> 取消「不要再同桌」
                            </button>
                          ) : (
                            <button className="btn btn-sm btn-danger-outline" data-testid="block-btn" onClick={() => block(p.a, p.b)}>
                              <Ban size={13} /> 以后不要再同桌
                            </button>
                          )}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </section>
          )}

          {/* 整月同桌 */}
          <section className="card" data-testid="month-runs">
            <h2>
              <CalendarRange size={18} /> 一整个月都跟同一个人坐（一眼看出）
            </h2>
            {monthEntries.length === 0 ? (
              <p className="muted">
                没有发现整月同桌的对 —— 连续同桌周次没有完整覆盖任何一个自然月。
                {!cls.termStart && '（未设置学期第 1 周周一，当前按建班日期估算，可在上方设置准确日期）'}
              </p>
            ) : (
              <ul className="month-run-list">
                {monthEntries.map((m) => (
                  <li key={`${m.key}-${m.label}`} className="month-run-item" data-testid="month-run-item">
                    <span className="badge badge-warn">{m.label}</span>
                    <b>{nameOf.get(m.a)}</b> 与 <b>{nameOf.get(m.b)}</b> 连续 {m.weeks.length} 周同桌（第{' '}
                    {m.weeks[0]}–{m.weeks[m.weeks.length - 1]} 周），覆盖整个月
                    <span className="spacer" />
                    {ledger.blockedKeys.has(m.key) ? (
                      <em className="muted small">已标记不要再同桌</em>
                    ) : (
                      <button className="btn btn-sm btn-danger-outline" onClick={() => block(m.a, m.b)}>
                        <Ban size={13} /> 以后不要再同桌
                      </button>
                    )}
                  </li>
                ))}
              </ul>
            )}
          </section>

          {/* 每人最常同桌 */}
          <section className="card" data-testid="top-deskmates">
            <h2>
              <UserCheck size={18} /> 每个学生和谁坐得最多
            </h2>
            <div className="table-wrap">
              <table className="table">
                <thead>
                  <tr>
                    <th>学生</th>
                    <th>最常同桌（并列全列）</th>
                    <th>次数</th>
                    <th>不同同桌人数</th>
                    <th>整月同桌</th>
                  </tr>
                </thead>
                <tbody>
                  {topList.map(({ s, sum }) => {
                    const overHere = sum.tied.some((t) => t.count > ledger.limit)
                    return (
                      <tr key={s.id} data-testid="top-row">
                        <td>{s.name}</td>
                        <td>
                          <span className="tied-names">
                            {sum.tied.map((t) => (
                              <span
                                key={t.otherId}
                                className={t.count > ledger.limit ? 'warn-text' : ''}
                                data-testid="top-name"
                              >
                                {nameOf.get(t.otherId)}
                                {ledger.blockedKeys.has(pairKeyOf(s.id, t.otherId)) && <Ban size={11} className="inline-ico" />}
                              </span>
                            ))}
                          </span>
                        </td>
                        <td className={overHere ? 'warn-text' : ''} data-testid="top-count">
                          {sum.top?.count}
                        </td>
                        <td>{sum.totalPartners}</td>
                        <td>
                          {(monthRuns.get(s.id) ?? []).length > 0 ? (
                            <span className="warn-text">
                              {(monthRuns.get(s.id) ?? [])
                                .map((m) => `${nameOf.get(m.otherId)}·${m.run.label}`)
                                .join('；')}
                            </span>
                          ) : (
                            '—'
                          )}
                        </td>
                      </tr>
                    )
                  })}
                </tbody>
              </table>
            </div>
          </section>

          {/* 全部同桌对 */}
          <section className="card" data-testid="all-pairs">
            <h2 className="with-action">
              <Users size={18} /> 全部同桌对（{allRecs.length} 对）
              <span className="spacer" />
              <label className="checkbox">
                <input type="checkbox" checked={onlyOver} onChange={(e) => setOnlyOver(e.target.checked)} />
                只看超限
              </label>
            </h2>
            <div className="table-wrap">
              <table className="table">
                <thead>
                  <tr>
                    <th>学生 A</th>
                    <th>学生 B</th>
                    <th>次数</th>
                    <th>周次</th>
                    <th>状态</th>
                    <th></th>
                  </tr>
                </thead>
                <tbody>
                  {shownRecs.map((p) => (
                    <tr key={pairKeyOf(p.a, p.b)} className={p.overLimit ? 'row-danger' : ''} data-testid="pair-row">
                      <td>{nameOf.get(p.a)}</td>
                      <td>{nameOf.get(p.b)}</td>
                      <td className={p.overLimit ? 'warn-text' : ''}>{p.count}</td>
                      <td className="week-chips">
                        {p.weeks.map((w) => (
                          <span key={w} className="week-chip">
                            {w}
                          </span>
                        ))}
                      </td>
                      <td>
                        {p.blocked ? (
                          <span className="badge badge-danger">
                            <Ban size={11} /> 不要再同桌
                          </span>
                        ) : p.overLimit ? (
                          <span className="badge badge-warn">超限 · 建议下次分开</span>
                        ) : (
                          <span className="muted small">正常</span>
                        )}
                      </td>
                      <td className="row-actions">
                        {p.blocked ? (
                          <button className="icon-btn" title="取消标记" onClick={() => unblock(p.a, p.b)}>
                            <X size={14} />
                          </button>
                        ) : (
                          <button className="icon-btn" title="以后不要再同桌" onClick={() => block(p.a, p.b)}>
                            <Ban size={14} />
                          </button>
                        )}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
            {shownRecs.length === 0 && <p className="muted">没有超限的同桌对。</p>}
          </section>

          {/* 黑名单 */}
          <section className="card" data-testid="blocked-list">
            <h2>
              <Ban size={18} /> 以后不要再同桌（{blockedPairs.length} 对，每周生成自动避开）
            </h2>
            {blockedPairs.length === 0 ? (
              <p className="muted">
                暂无。可在上方「超限对」或「全部同桌对」中点 <Ban size={12} className="inline-ico" />{' '}
                标记；标记后新生成的每一周都会把这两人当硬约束分开，手工把他们拖成同桌也会被拒绝。
              </p>
            ) : (
              <ul className="blocked-list">
                {blockedPairs.map((p) => (
                  <li key={pairKeyOf(p.a, p.b)} className="blocked-item" data-testid="blocked-item">
                    <Ban size={14} className="bad" />
                    <b>{nameOf.get(p.a)}</b> 与 <b>{nameOf.get(p.b)}</b>
                    <span className="spacer" />
                    <button className="btn btn-sm" onClick={() => unblock(p.a, p.b)}>
                      <RotateCcw size={13} /> 取消标记
                    </button>
                  </li>
                ))}
              </ul>
            )}
          </section>
        </>
      )}

      {toast && (
        <div className={`toast ${toast.kind}`} data-testid={toast.kind === 'err' ? 'toast-err' : 'toast-ok'}>
          {toast.text}
        </div>
      )}
    </div>
  )
}

function PairResult({
  cls,
  rec,
  onBlock,
  onUnblock,
}: {
  cls: { termStart?: string }
  rec: PairRecord
  onBlock: () => void
  onUnblock: () => void
}) {
  const over = rec.overLimit
  return (
    <div className={`query-result card-inner ${over ? 'query-result-bad' : ''}`} data-testid="query-result">
      <div className="query-head">
        {over ? <AlertTriangle size={18} className="bad" /> : <Sparkles size={18} className="good" />}
        <b data-testid="query-count">
          同桌过 {rec.count} 次
        </b>
        {rec.blocked && (
          <span className="badge badge-danger">
            <Ban size={11} /> 已标记不要再同桌
          </span>
        )}
        {over && !rec.blocked && <span className="badge badge-warn">超过上限，建议下次换座时把这两人分开</span>}
        <span className="spacer" />
        {rec.blocked ? (
          <button className="btn btn-sm" onClick={onUnblock}>
            <RotateCcw size={13} /> 取消标记
          </button>
        ) : (
          <button className="btn btn-sm btn-danger-outline" data-testid="query-block" onClick={onBlock}>
            <Ban size={13} /> 以后不要再同桌
          </button>
        )}
      </div>
      <div className="week-chips" data-testid="query-weeks">
        {rec.weeks.map((w) => (
          <span key={w} className="week-chip week-chip-strong">
            第 {w} 周
          </span>
        ))}
      </div>
      {!cls.termStart && <p className="muted small">提示：未设置「学期第 1 周周一」，整月统计按建班日期估算。</p>}
    </div>
  )
}
