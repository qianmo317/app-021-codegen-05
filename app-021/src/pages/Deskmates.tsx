import { useMemo, useState } from 'react'
import { Link } from '../router'
import { useStore } from '../store'
import type { ClassEntity } from '../types'
import {
  allPairs,
  buildLedger,
  monthLongPairs,
  pairKeyOf,
  queryPair,
} from '../lib/deskmates'
import { downloadCSV, ledgerCSV } from '../lib/csv'
import {
  AlertTriangle,
  ArrowLeft,
  Ban,
  CalendarRange,
  CheckCircle2,
  Download,
  HeartHandshake,
  Search,
  Table2,
  Users,
  X,
} from 'lucide-react'

const MONTH_WEEKS = 4 // 「一整个月」= 连续 4 次换座

function weekRanges(weeks: number[]): string {
  if (weeks.length === 0) return '—'
  const out: string[] = []
  let start = weeks[0]
  let prev = weeks[0]
  const flush = () => out.push(start === prev ? `第${start}周` : `第${start}-${prev}周`)
  for (const w of weeks.slice(1)) {
    if (w === prev + 1) {
      prev = w
    } else {
      flush()
      start = w
      prev = w
    }
  }
  flush()
  return out.join('、')
}

export function Deskmates({ classId }: { classId: string }) {
  const store = useStore()
  const cls = store.getClass(classId)
  const [toast, setToast] = useState<{ text: string; kind: 'ok' | 'err' } | null>(null)

  const ledger = useMemo(() => (cls ? buildLedger(cls, MONTH_WEEKS) : null), [cls])
  const limit = cls?.constraints.deskmateLimit ?? 2
  const pairs = useMemo(() => (ledger ? allPairs(ledger) : []), [ledger])
  const overLimit = useMemo(() => pairs.filter((p) => p.count > limit), [pairs, limit])
  const monthLong = useMemo(() => (ledger ? monthLongPairs(ledger, MONTH_WEEKS) : []), [ledger])

  const flash = (text: string, kind: 'ok' | 'err' = 'ok') => {
    setToast({ text, kind })
    window.setTimeout(() => setToast(null), 3600)
  }

  const markNever = async (a: string, b: string) => {
    const res = await store.addNeverPair(cls!.id, a, b)
    if (!res.ok) flash(res.error ?? '标记失败', 'err')
    else if ((res.weeks?.length ?? 0) > 0) flash(`已标记，并自动重排受影响的第 ${res.weeks!.join('、')} 周`)
    else flash('已标记：以后每周生成都会避开这一对')
  }

  if (!cls || !ledger) {
    return (
      <div className="page">
        <p>班级不存在。</p>
        <Link to="/">返回</Link>
      </div>
    )
  }

  const nameOf = new Map(cls.students.map((s) => [s.id, s.name]))
  const neverSet = new Set((cls.neverPairs ?? []).map((np) => pairKeyOf(np.a, np.b)))

  const exportLedger = () => downloadCSV(`${cls.name}-同桌台账.csv`, ledgerCSV(cls))

  return (
    <div className="page page-wide">
      <div className="page-head">
        <Link className="back" to="/">
          <ArrowLeft size={14} /> 班级列表
        </Link>
        <h1>{cls.name} · 同桌记录</h1>
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
          <span className="tab tab-active">同桌记录</span>
          <Link className="tab" to={`/class/${cls.id}/print`}>
            打印
          </Link>
        </nav>
      </div>

      {ledger.totalWeeks === 0 ? (
        <div className="empty-hint">
          <p>还没有生成轮换结果。先生成座位表，同桌记录会自动逐周记下来。</p>
          <Link className="btn btn-primary" to={`/class/${cls.id}/rotations`}>
            去生成
          </Link>
        </div>
      ) : (
        <>
          <section className="card" data-testid="desk-summary">
            <div className="summary-cards">
              <div className="card stat">
                <span className="stat-num">{ledger.totalWeeks}</span>
                <span className="stat-label">已记录周次（{weekRanges(ledger.weeks)}）</span>
              </div>
              <div className="card stat">
                <span className="stat-num">{pairs.length}</span>
                <span className="stat-label">出现过的同桌对</span>
              </div>
              <div className="card stat">
                <span className={`stat-num ${overLimit.length ? 'warn' : 'good'}`} data-testid="desk-over-count">
                  {overLimit.length}
                </span>
                <span className="stat-label">超过上限（{limit} 次）的对</span>
              </div>
              <div className="card stat">
                <span className={`stat-num ${monthLong.length ? 'warn' : 'good'}`} data-testid="desk-month-count">
                  {monthLong.length}
                </span>
                <span className="stat-label">连续 ≥ {MONTH_WEEKS} 周同一同桌</span>
              </div>
              <div className="card stat">
                <span className={`stat-num ${neverSet.size ? 'bad' : ''}`} data-testid="desk-never-count">
                  {neverSet.size}
                </span>
                <span className="stat-label">「永不同桌」名单</span>
              </div>
            </div>
            <div className="row-flex" style={{ marginTop: 12 }}>
              <label className="inline-label">
                同桌次数上限
                <input
                  type="number"
                  min={1}
                  max={20}
                  className="input input-sm"
                  value={limit}
                  data-testid="desk-limit-input"
                  onChange={(e) => store.setDeskmateLimit(cls.id, Number(e.target.value))}
                />
                次（默认 2）
              </label>
              <span className="spacer" />
              <button className="btn" data-testid="export-ledger" onClick={exportLedger}>
                <Download size={15} /> 导出台账 CSV
              </button>
            </div>
            <p className="muted small" style={{ marginTop: 8 }}>
              记录由每周座位表自动汇总：重新生成或手工调整任意一周后，本页立即跟着更新；手工调整受硬约束校验，不会产生「永不同桌」的新同桌。
            </p>
          </section>

          <PairQuery cls={cls} />

          <MonthLongCard monthLong={monthLong} nameOf={nameOf} onBan={markNever} neverSet={neverSet} />

          <section className="card" data-testid="desk-over-card">
            <h2 className="with-action">
              <AlertTriangle size={17} /> 同桌超限（&gt; {limit} 次）—— 下次换座建议分开
              <span className="spacer" />
            </h2>
            {overLimit.length === 0 ? (
              <p className="muted">
                <CheckCircle2 size={14} className="good" /> 没有超限的同桌对。
              </p>
            ) : (
              <div className="table-wrap">
                <table className="table">
                  <thead>
                    <tr>
                      <th>学生 A</th>
                      <th>学生 B</th>
                      <th>同桌次数</th>
                      <th>分别在第几周</th>
                      <th>操作</th>
                    </tr>
                  </thead>
                  <tbody>
                    {overLimit.map((p) => (
                      <tr key={pairKeyOf(p.a, p.b)} className="row-warn" data-testid="desk-over-row">
                        <td>{nameOf.get(p.a) ?? p.a}</td>
                        <td>{nameOf.get(p.b) ?? p.b}</td>
                        <td className="warn-text">{p.count} 次</td>
                        <td>{weekRanges(p.weeks)}</td>
                        <td>
                          <BanButton
                            banned={neverSet.has(pairKeyOf(p.a, p.b))}
                            onClick={() => markNever(p.a, p.b)}
                          />
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </section>

          <NeverPairsCard
            cls={cls}
            nameOf={nameOf}
            onRemove={(a, b) => store.removeNeverPair(cls.id, a, b)}
            onAdd={markNever}
            flash={flash}
          />

          <section className="card" data-testid="desk-ledger-card">
            <h2>
              <Table2 size={17} /> 全班同桌台账（{pairs.length} 对，按次数降序）
            </h2>
            {pairs.length === 0 ? (
              <p className="muted">暂无同桌记录。</p>
            ) : (
              <div className="table-wrap">
                <table className="table">
                  <thead>
                    <tr>
                      <th>学生 A</th>
                      <th>学生 B</th>
                      <th>次数</th>
                      <th>周次</th>
                      <th>状态</th>
                    </tr>
                  </thead>
                  <tbody>
                    {pairs.map((p) => {
                      const banned = neverSet.has(pairKeyOf(p.a, p.b))
                      const over = p.count > limit
                      return (
                        <tr key={pairKeyOf(p.a, p.b)} className={over ? 'row-warn' : ''} data-testid="desk-ledger-row">
                          <td>{nameOf.get(p.a) ?? p.a}</td>
                          <td>{nameOf.get(p.b) ?? p.b}</td>
                          <td>{p.count}</td>
                          <td>{weekRanges(p.weeks)}</td>
                          <td>
                            {banned ? (
                              <span className="badge badge-ban">
                                <Ban size={11} /> 永不同桌
                              </span>
                            ) : over ? (
                              <span className="warn-text">超限 · 建议分开</span>
                            ) : (
                              <span className="muted">正常</span>
                            )}
                          </td>
                        </tr>
                      )
                    })}
                  </tbody>
                </table>
              </div>
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

// ---------- 任意两人查询 ----------
function PairQuery({ cls }: { cls: ClassEntity }) {
  const ledger = useMemo(() => buildLedger(cls), [cls])
  const [a, setA] = useState('')
  const [b, setB] = useState('')
  const result = a && b && a !== b ? queryPair(ledger, a, b) : null
  const over = result && result.count > (cls.constraints.deskmateLimit ?? 2)
  return (
    <section className="card" data-testid="desk-query-card">
      <h2>
        <Search size={17} /> 查任意两人：这学期同桌过几次、分别在第几周
      </h2>
      <div className="row-flex">
        <select className="input" value={a} data-testid="desk-query-a" onChange={(e) => setA(e.target.value)}>
          <option value="">选择学生…</option>
          {cls.students.map((s) => (
            <option key={s.id} value={s.id}>
              {s.name}
            </option>
          ))}
        </select>
        <span className="muted">×</span>
        <select className="input" value={b} data-testid="desk-query-b" onChange={(e) => setB(e.target.value)}>
          <option value="">选择学生…</option>
          {cls.students.filter((s) => s.id !== a).map((s) => (
            <option key={s.id} value={s.id}>
              {s.name}
            </option>
          ))}
        </select>
        {result && (
          <div className={`query-result ${over ? 'query-result-warn' : ''}`} data-testid="desk-query-result">
            <b>
              同桌 {result.count} 次
            </b>
            <span>{result.count > 0 ? weekRanges(result.weeks) : '这学期还没同桌过'}</span>
            {over && <span className="warn-text">已超过上限 {cls.constraints.deskmateLimit ?? 2} 次，建议下次换座分开</span>}
          </div>
        )}
      </div>
    </section>
  )
}

// ---------- 一整个月同一同桌 ----------
function MonthLongCard({
  monthLong,
  nameOf,
  onBan,
  neverSet,
}: {
  monthLong: ReturnType<typeof monthLongPairs>
  nameOf: Map<string, string>
  onBan: (a: string, b: string) => void
  neverSet: Set<string>
}) {
  return (
    <section className="card" data-testid="desk-month-card">
      <h2>
        <CalendarRange size={17} /> 一整个月都跟同一个人坐（连续 {MONTH_WEEKS} 周）
      </h2>
      {monthLong.length === 0 ? (
        <p className="muted">
          <CheckCircle2 size={14} className="good" /> 没有连续 {MONTH_WEEKS} 周同桌的对子。
        </p>
      ) : (
        <div className="table-wrap">
          <table className="table">
            <thead>
              <tr>
                <th>学生 A</th>
                <th>学生 B</th>
                <th>连续周数</th>
                <th>区间</th>
                <th>操作</th>
              </tr>
            </thead>
            <tbody>
              {monthLong.map((m) => (
                <tr key={pairKeyOf(m.a, m.b)} className="row-warn" data-testid="desk-month-row">
                  <td>{nameOf.get(m.a) ?? m.a}</td>
                  <td>{nameOf.get(m.b) ?? m.b}</td>
                  <td className="warn-text">{m.length} 周</td>
                  <td>
                    第 {m.startWeek} ～ {m.endWeek} 周
                  </td>
                  <td>
                    <BanButton banned={neverSet.has(pairKeyOf(m.a, m.b))} onClick={() => onBan(m.a, m.b)} />
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </section>
  )
}

// ---------- 永不同桌名单 ----------
function NeverPairsCard({
  cls,
  nameOf,
  onRemove,
  onAdd,
  flash,
}: {
  cls: ClassEntity
  nameOf: Map<string, string>
  onRemove: (a: string, b: string) => void
  onAdd: (a: string, b: string) => void
  flash: (t: string, k?: 'ok' | 'err') => void
}) {
  const [a, setA] = useState('')
  const [b, setB] = useState('')
  const existing = new Set((cls.neverPairs ?? []).map((np) => pairKeyOf(np.a, np.b)))
  const add = () => {
    if (!a || !b) return flash('请先选择两个学生', 'err')
    if (a === b) return flash('不能选择同一名学生', 'err')
    if (existing.has(pairKeyOf(a, b))) return flash('这一对已在名单中', 'err')
    setA('')
    setB('')
    onAdd(a, b)
  }
  return (
    <section className="card" data-testid="desk-never-card">
      <h2>
        <Ban size={17} /> 以后不要再同桌（每周生成与手工交换都会强制避开）
      </h2>
      <div className="row-flex">
        <select className="input" value={a} data-testid="desk-never-a" onChange={(e) => setA(e.target.value)}>
          <option value="">选择学生…</option>
          {cls.students.map((s) => (
            <option key={s.id} value={s.id}>
              {s.name}
            </option>
          ))}
        </select>
        <span className="muted">×</span>
        <select className="input" value={b} data-testid="desk-never-b" onChange={(e) => setB(e.target.value)}>
          <option value="">选择学生…</option>
          {cls.students.filter((s) => s.id !== a).map((s) => (
            <option key={s.id} value={s.id}>
              {s.name}
            </option>
          ))}
        </select>
        <button className="btn btn-primary" data-testid="desk-never-add" onClick={add}>
          <Ban size={14} /> 标记永不同桌
        </button>
      </div>
      {(cls.neverPairs ?? []).length === 0 ? (
        <p className="muted small" style={{ marginTop: 8 }}>
          <Users size={13} /> 还没有标记。标记后若他们在已生成的周里正同桌，会自动重排受影响的周次。
        </p>
      ) : (
        <div className="chip-list-static" data-testid="desk-never-list">
          {(cls.neverPairs ?? []).map((np) => (
            <span key={pairKeyOf(np.a, np.b)} className="ban-chip" data-testid="desk-never-chip">
              <Ban size={12} />
              {nameOf.get(np.a) ?? np.a} × {nameOf.get(np.b) ?? np.b}
              <button
                className="icon-btn"
                title="取消标记"
                data-testid="desk-never-remove"
                onClick={() => onRemove(np.a, np.b)}
              >
                <X size={12} />
              </button>
            </span>
          ))}
        </div>
      )}
      <p className="muted small" style={{ marginTop: 8 }}>
        <HeartHandshake size={12} /> 与学生条目里的「必须分开」效果相同（都是硬约束）；这里可以在学期中随时追加，
        追加后已生成周中撞车的对子会被立即重排。
      </p>
    </section>
  )
}

function BanButton({ banned, onClick }: { banned: boolean; onClick: () => void }) {
  if (banned) {
    return (
      <span className="badge badge-ban">
        <Ban size={11} /> 已标记永不同桌
      </span>
    )
  }
  return (
    <button className="btn btn-sm" data-testid="desk-ban-btn" onClick={onClick}>
      <Ban size={13} /> 永不同桌并分开
    </button>
  )
}
