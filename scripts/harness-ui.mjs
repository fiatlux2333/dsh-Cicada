import { chromium, expect } from '@playwright/test';
import { mkdir } from 'node:fs/promises';
if (!process.env.CICADA_TEST_URL?.startsWith('http://127.0.0.1:4189/'))
  throw new Error('Isolated test URL required');
const browser = await chromium.launch({ channel: 'msedge', headless: true });
try {
  const page = await browser.newPage({ viewport: { width: 1350, height: 1000 } });
  const failures = [];
  page.on('pageerror', (error) => failures.push(error.message));
  await page.goto(process.env.CICADA_TEST_URL);
  await page.waitForTimeout(4000);
  const welcome = page.getByRole('button', { name: '继续', exact: true });
  if (await welcome.isVisible()) await welcome.click();
  await page.keyboard.press('Escape');
  await page.getByRole('button', { name: '插件', exact: true }).click();
  await page.getByRole('button', { name: '查看 dsh-cicada', exact: true }).click();
  const enabled = page.getByRole('switch', { name: '启用 dsh-cicada', exact: true });
  if ((await enabled.getAttribute('aria-checked')) === 'false') await enabled.click();
  await expect(page.getByRole('heading', { name: '蝉蜕 Cicada' })).toBeVisible();
  await expect(page.getByText('演练模式', { exact: true })).toBeVisible();
  await expect(page.getByText('自动触发关闭', { exact: true })).toBeVisible();
  await page.getByRole('tab', { name: '动作配置' }).click();
  await page.getByRole('textbox', { name: '浏览记录关键词' }).fill('cicada-fixture-secret');
  await page.getByRole('button', { name: '保存', exact: true }).click();
  await expect(page.getByRole('status').filter({ hasText: '设置已保存' })).toBeVisible();
  await page.getByRole('textbox', { name: '浏览记录关键词' }).fill('');
  await page.getByRole('button', { name: '保存', exact: true }).click();
  await expect(page.getByRole('status').filter({ hasText: '设置已保存' })).toBeVisible();
  for (const tab of ['触发规则', '假历史', '运行日志', '总览'])
    await page.getByRole('tab', { name: tab, exact: true }).click();
  await page.getByRole('button', { name: '立即演练', exact: true }).click();
  await expect(page.getByText('演练 · L1', { exact: true }).first()).toBeVisible();
  await page.getByRole('button', { name: '切换真实模式', exact: true }).click();
  await expect(page.getByRole('dialog', { name: '人工确认' })).toBeVisible();
  await page.getByRole('button', { name: '取消', exact: true }).click();
  console.log(await page.locator('body').ariaSnapshot());
  console.log('Browser errors:', failures);
  await mkdir('artifacts/harness', { recursive: true });
  await page.getByRole('heading', { name: '蝉蜕 Cicada' }).scrollIntoViewIfNeeded();
  await page.screenshot({ path: 'artifacts/harness/initial.png', fullPage: true });
  await enabled.click();
  await expect(enabled).toHaveAttribute('aria-checked', 'false');
  await expect(page.getByRole('heading', { name: '蝉蜕 Cicada' })).toHaveCount(0);
  await enabled.click();
  await expect(page.getByRole('heading', { name: '蝉蜕 Cicada' })).toBeVisible();
  expect(await page.locator('style[data-cicada]').count()).toBe(1);
  await page.getByRole('treeitem', { name: '新会话', exact: true }).click();
  const composer = page.getByRole('textbox', { name: '描述你想要构建的内容, / 调用指令, @ 文件或对话' });
  await composer.fill('/cicada open');
  await composer.press('Enter');
  await expect(page.getByRole('heading', { name: '蝉蜕 Cicada' })).toBeVisible();
  console.log(
    'Actual Harness integration: five views, DPAPI save, dry run, confirmation cancellation, unload/reload, /cicada open passed.',
  );
  expect(failures).toEqual([]);
} finally {
  await browser.close();
}
