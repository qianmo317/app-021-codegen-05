import { expect, test, type Page } from '@playwright/test'
import { bulkAdd, dragSeat, generate, namesAt, readSeatMap } from './helpers'

// 场景三：同桌长期台账 —— 每周记录、任意两人查询、超限标红、整月同桌、黑名单避开

async function createTinyClass(page: Page, name: string) {
  await page.goto('/')
  await page.getByTestId('new-class-name').fill(name)
  await page.getByTestId('create-class').click()
  // 缩到 2×2 = 4 座（每周只有 2 对相邻座位，必然快速出现重复同桌）
  const rowsInput = page.locator('[data-testid="layout-editor"] input[type="number"]').first()
  const colsInput = page.locator('[data-testid="layout-editor"] input[type="number"]').nth(1)
  await rowsInput.fill('2')
  await colsInput.fill('2')
  await bulkAdd(page, '赵大\n钱二\n孙三\n李四')
}

test('同桌记录逐周累积：能查任意两人次数与周次、超限标红并给出建议', async ({ page }) => {
  await createTinyClass(page, 'E2E 同桌台账班')

  await page.getByRole('link', { name: '轮换结果' }).click()
  await generate(page, 4, 42)
  await expect(page.getByTestId('week-tab-4')).toBeVisible()

  await page.locator('a.tab[href*="/deskmates"]').click()
  await expect(page.getByTestId('desk-summary')).toBeVisible()
  await expect(page.getByTestId('desk-over-count')).toHaveText(/^\d+$/)

  // 上限调成 1（每周只有 2 对可选，4 周必有重复）→ 出现超限红行与建议
  await page.getByTestId('desk-limit-input').fill('1')
  const overList = page.getByTestId('over-limit-list')
  await expect(overList).toBeVisible()
  await expect(overList).toContainText('下次换座建议分开')
  const firstOver = page.getByTestId('over-row').first()
  const nameA = (await firstOver.locator('td').nth(0).textContent())!.trim()
  const nameB = (await firstOver.locator('td').nth(1).textContent())!.trim()
  const countText = (await firstOver.getByTestId('over-count').textContent())!.trim()
  const count = Number(countText.replace(/\D/g, ''))
  expect(count).toBeGreaterThan(1)
  // 周次筹码数 = 同桌次数
  await expect(firstOver.locator('.week-chip')).toHaveCount(count)

  // 任意两人查询：选这对 → 显示次数与逐周
  await page.getByTestId('query-a').selectOption({ label: nameA })
  await page.getByTestId('query-b').selectOption({ label: nameB })
  const result = page.getByTestId('query-result')
  await expect(result).toBeVisible()
  await expect(result.getByTestId('query-count')).toContainText(`同桌过 ${count} 次`)
  await expect(result.locator('.week-chip')).toHaveCount(count)
})

test('标记「以后不要再同桌」后：新生成的周次自动避开，手工拖成同桌被拒绝，可取消', async ({ page }) => {
  await createTinyClass(page, 'E2E 黑名单班')

  await page.getByRole('link', { name: '轮换结果' }).click()
  await generate(page, 4, 42)
  await page.getByTestId('week-tab-1').click()
  // 第 1 周 r0c0 与 r0c1 必然相邻同桌（2×2 无过道）
  const map = await readSeatMap(page)
  const x = map['r0c0']
  const y = map['r0c1']
  expect(x).toBeTruthy()
  expect(y).toBeTruthy()
  expect(x).not.toBe(y)

  // 台账页把这对拉黑
  await page.locator('a.tab[href*="/deskmates"]').click()
  await page.getByTestId('query-a').selectOption({ label: x })
  await page.getByTestId('query-b').selectOption({ label: y })
  await page.getByTestId('query-block').click()
  await expect(page.getByTestId('toast-ok')).toBeVisible()
  await expect(page.getByTestId('blocked-item')).toHaveCount(1)
  await expect(page.getByTestId('desk-blocked-count')).toHaveText('1')

  // 手工把相邻的两人互换 → 他们仍相邻，交换必须被拒绝
  await page.getByRole('link', { name: '轮换结果' }).click()
  await page.getByTestId('week-tab-1').click()
  const before = await namesAt(page, ['r0c0', 'r0c1'])
  await dragSeat(page, 'r0c0', 'r0c1')
  const preview = page.getByTestId('swap-preview')
  await expect(preview).toBeVisible()
  await expect(preview).toContainText('以后不要再同桌')
  await page.mouse.up()
  await expect(page.getByTestId('toast-err')).toBeVisible()
  await expect.poll(() => namesAt(page, ['r0c0', 'r0c1'])).toEqual(before)

  // 逐周重新生成 4 次（历史周次也含黑名单，重建后每周都必须 0 违反）
  for (let w = 1; w <= 4; w++) {
    await page.getByTestId(`week-tab-${w}`).click()
    await page.getByTestId('regen-week').click()
    await expect(page.getByTestId('toast-ok')).toBeVisible()
  }
  await expect(page.getByTestId('hard-violations')).toContainText('0')
  await expect(page.getByTestId('blocked-over')).toHaveText('1')

  // 台账里这对 0 次同桌
  await page.locator('a.tab[href*="/deskmates"]').click()
  await page.getByTestId('query-a').selectOption({ label: x })
  await page.getByTestId('query-b').selectOption({ label: y })
  await expect(page.getByTestId('query-result-none')).toBeVisible()
  // 取消标记
  await page.getByTestId('blocked-item').first().getByRole('button', { name: '取消标记' }).click()
  await expect(page.getByTestId('desk-blocked-count')).toHaveText('0')
})
