import { expect, test, type Page } from '@playwright/test'
import { bulkAdd, generate } from './helpers'

// 「同桌记录」页全链路：台账随生成更新 → 两人查询 → 超限高亮与建议 →
// 标记永不同桌自动重排受影响周 → 换种子重新生成仍避开 → 取消标记

async function createClass(page: Page, name: string) {
  await page.goto('/')
  await page.getByTestId('new-class-name').fill(name)
  await page.getByTestId('create-class').click()
  return /\/class\/([^/]+)/.exec(page.url())![1]
}

// 2 行 2 列、无过道：每周只有 2 个同桌位，4 人 6 周必然出现重复同桌
async function makeTinyRoom(page: Page) {
  const rowsInput = page.locator('[data-testid="layout-editor"] input[type="number"]').first()
  const colsInput = page.locator('[data-testid="layout-editor"] input[type="number"]').nth(1)
  await rowsInput.fill('2')
  await colsInput.fill('2')
}

test('同桌台账：记录、两人查询、超限高亮、标记永不同桌并自动重排', async ({ page }) => {
  await createClass(page, 'E2E 同桌台账班')
  await makeTinyRoom(page)
  await bulkAdd(page, '赵一\n钱二\n孙三\n李四')

  await page.getByRole('link', { name: '轮换结果' }).click()
  await generate(page, 6, 42)

  // 进同桌记录页：台账已逐周记好
  await page.getByRole('link', { name: '同桌记录' }).click()
  await expect(page.getByTestId('desk-summary')).toBeVisible()
  await expect(page.getByText('已记录周次')).toBeVisible()
  await expect(page.getByTestId('desk-ledger-row')).not.toHaveCount(0)

  // 任意两人查询
  await page.getByTestId('desk-query-a').selectOption({ label: '赵一' })
  await page.getByTestId('desk-query-b').selectOption({ label: '钱二' })
  const result = page.getByTestId('desk-query-result')
  await expect(result).toContainText('同桌')
  await expect(result).toContainText('次')

  // 上限改成 1 → 出现超限对（列表高亮 + 「下次换座建议分开」+ 周次）
  await page.getByTestId('desk-limit-input').fill('1')
  await expect(page.getByTestId('desk-over-count')).not.toHaveText('0')
  const firstOverRow = page.getByTestId('desk-over-row').first()
  await expect(firstOverRow).toBeVisible()
  await expect(firstOverRow).toContainText('建议分开')
  const nameA = (await firstOverRow.locator('td').nth(0).textContent())!.trim()
  const nameB = (await firstOverRow.locator('td').nth(1).textContent())!.trim()
  await expect(firstOverRow.locator('td').nth(3)).toContainText('周') // 分别在第几周

  // 标记永不同桌 → 自动重排受影响周
  await firstOverRow.getByTestId('desk-ban-btn').click()
  await expect(page.getByTestId('toast-ok')).toBeVisible()
  await expect(page.getByTestId('toast-ok')).toContainText('自动重排')

  // 名单出现这一对；两人查询归零
  await expect(page.getByTestId('desk-never-list')).toContainText(nameA)
  await expect(page.getByTestId('desk-never-list')).toContainText(nameB)
  await page.getByTestId('desk-query-a').selectOption({ label: nameA })
  await page.getByTestId('desk-query-b').selectOption({ label: nameB })
  await expect(page.getByTestId('desk-query-result')).toContainText('同桌 0 次')
  await expect(page.getByTestId('desk-query-result')).toContainText('还没同桌过')

  // 重排没有破坏硬约束
  await page.getByRole('link', { name: '公平性报告' }).click()
  await expect(page.getByTestId('fair-hard')).toContainText('0')

  // 台账 CSV 导出
  await page.getByRole('link', { name: '同桌记录' }).click()
  const [dl] = await Promise.all([page.waitForEvent('download'), page.getByTestId('export-ledger').click()])
  expect(dl.suggestedFilename()).toContain('同桌台账.csv')
})

test('标记永不同桌后换种子重新生成全部周，该对始终被避开；可取消标记', async ({ page }) => {
  await createClass(page, 'E2E 永不同桌班')
  await makeTinyRoom(page)
  await bulkAdd(page, '甲一\n乙二\n丙三\n丁四')
  await page.getByRole('link', { name: '轮换结果' }).click()
  await generate(page, 4, 7)

  await page.getByRole('link', { name: '同桌记录' }).click()
  // 手动添加一对永不同桌
  await page.getByTestId('desk-never-a').selectOption({ label: '甲一' })
  await page.getByTestId('desk-never-b').selectOption({ label: '乙二' })
  await page.getByTestId('desk-never-add').click()
  await expect(page.getByTestId('toast-ok')).toBeVisible()
  await expect(page.getByTestId('toast-ok')).toContainText('自动重排')

  // 历史撞车周被重排 → 0 次
  await page.getByTestId('desk-query-a').selectOption({ label: '甲一' })
  await page.getByTestId('desk-query-b').selectOption({ label: '乙二' })
  await expect(page.getByTestId('desk-query-result')).toContainText('同桌 0 次')

  // 换种子重新生成全部 4 周后仍然避开、硬约束 0
  await page.getByRole('link', { name: '轮换结果' }).click()
  await page.getByTestId('seed-input').fill('999')
  await page.getByTestId('gen-all').click()
  await expect(page.getByTestId('toast-ok')).toBeVisible()
  await expect(page.getByTestId('hard-violations')).toContainText('0')

  await page.getByRole('link', { name: '同桌记录' }).click()
  await page.getByTestId('desk-query-a').selectOption({ label: '甲一' })
  await page.getByTestId('desk-query-b').selectOption({ label: '乙二' })
  await expect(page.getByTestId('desk-query-result')).toContainText('同桌 0 次')

  // 台账中该对显示「永不同桌」徽标
  await expect(page.getByTestId('desk-never-count')).toHaveText('1')

  // 取消标记后名单清空
  await page.getByTestId('desk-never-remove').click()
  await expect(page.getByTestId('desk-never-list')).toHaveCount(0)
  await expect(page.getByTestId('desk-never-count')).toHaveText('0')
})
