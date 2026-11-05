import { chromium, expect } from '@playwright/test';
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { checkCompatibility } from './check-compatibility.mjs';
import { assertNoExternalTarget, localHarnessRuntime, withOwnedHarness } from './harness-fixture.mjs';

async function checkHarnessUi(fixture) {
  await fixture.assertOwned();
  const browser = await chromium.launch({ channel: 'msedge', headless: true });
  let page, context;
  const closeOnHostExit = () => {
    void context?.close().catch(() => {});
  };
  try {
    context = await browser.newContext({ viewport: { width: 1350, height: 1000 } });
    fixture.signal.addEventListener('abort', closeOnHostExit, { once: true });
    if (fixture.signal.aborted) throw new Error('Owned Host exited before browser startup');
    page = await context.newPage();
    const origin = new URL(fixture.url).origin;
    await page.route('**/*', async (route) => {
      if (fixture.signal.aborted || new URL(route.request().url()).origin !== origin) await route.abort();
      else await route.continue();
    });
    const failures = [];
    page.on('pageerror', (error) => failures.push(error.message));
    await page.goto(fixture.url);
    expect(new URL(page.url()).origin).toBe(origin);
    await page.waitForTimeout(4000);
    const welcome = page.getByRole('button', { name: '继续', exact: true });
    if (await welcome.isVisible()) await welcome.click();
    const onboarding = page.getByRole('dialog', { name: '开始使用', exact: true });
    await onboarding.waitFor({ state: 'visible', timeout: 5000 }).catch(() => {});
    if (await onboarding.isVisible())
      await onboarding.getByRole('button', { name: '关闭', exact: true }).click();
    await page.keyboard.press('Escape');
    await page.getByRole('button', { name: '插件', exact: true }).click();
    await page.getByRole('button', { name: '查看 dsh-cicada', exact: true }).click();
    const enabled = page.getByRole('switch', { name: '启用 dsh-cicada', exact: true });
    await fixture.assertOwned();
    if ((await enabled.getAttribute('aria-checked')) === 'false') await enabled.click();
    await expect(page.getByRole('heading', { name: '蝉蜕 Cicada' })).toBeVisible();
    await expect(page.getByText('演练模式', { exact: true })).toBeVisible();
    await expect(page.getByText('自动触发关闭', { exact: true })).toBeVisible();
    await page.getByRole('tab', { name: '动作配置' }).click();
    await page.getByRole('textbox', { name: '浏览记录关键词' }).fill('cicada-fixture-secret');
    await fixture.assertOwned();
    await page.getByRole('button', { name: '保存', exact: true }).click();
    await expect(page.getByRole('status').filter({ hasText: '设置已保存' })).toBeVisible();
    await page.getByRole('textbox', { name: '浏览记录关键词' }).fill('');
    await fixture.assertOwned();
    await page.getByRole('button', { name: '保存', exact: true }).click();
    await expect(page.getByRole('status').filter({ hasText: '设置已保存' })).toBeVisible();
    for (const tab of ['触发规则', '假历史', '运行日志', '总览'])
      await page.getByRole('tab', { name: tab, exact: true }).click();
    await fixture.assertOwned();
    await page.getByRole('button', { name: '立即演练', exact: true }).click();
    await expect(page.getByText('演练 · L1', { exact: true }).first()).toBeVisible();
    await page.getByRole('button', { name: '切换真实模式', exact: true }).click();
    await expect(page.getByRole('dialog', { name: '人工确认' })).toBeVisible();
    await page.getByRole('button', { name: '取消', exact: true }).click();
    await mkdir(join(fixture.directory, 'ui'));
    await page.getByRole('heading', { name: '蝉蜕 Cicada' }).scrollIntoViewIfNeeded();
    await page.screenshot({ path: join(fixture.directory, 'ui', 'initial.png'), fullPage: true });
    await fixture.assertOwned();
    await enabled.click();
    await expect(enabled).toHaveAttribute('aria-checked', 'false');
    await expect(page.getByRole('heading', { name: '蝉蜕 Cicada' })).toHaveCount(0);
    await enabled.click();
    await expect(page.getByRole('heading', { name: '蝉蜕 Cicada' })).toBeVisible();
    expect(await page.locator('style[data-cicada]').count()).toBe(1);
    await fixture.assertOwned();
    await page.getByRole('treeitem', { name: '新会话', exact: true }).click();
    const composer = page.getByRole('textbox', { name: '描述你想要构建的内容, / 调用指令, @ 文件或对话' });
    await composer.fill('/cicada open');
    await composer.press('Enter');
    await expect(page.getByRole('heading', { name: '蝉蜕 Cicada' })).toBeVisible();
    console.log(
      'Actual Harness integration: five views, DPAPI save, dry run, confirmation cancellation, unload/reload, /cicada open passed.',
    );
    expect(failures).toEqual([]);
  } catch (error) {
    if (page && !page.isClosed()) {
      console.error(await page.locator('body').ariaSnapshot());
      await mkdir(join(fixture.directory, 'ui'), { recursive: true });
      await page.screenshot({ path: join(fixture.directory, 'ui', 'failure.png'), fullPage: true });
    }
    throw error;
  } finally {
    fixture.signal.removeEventListener('abort', closeOnHostExit);
    await browser.close();
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  assertNoExternalTarget(process.env);
  const args = process.argv.slice(2);
  if (args.length && (args.length !== 2 || args[0] !== '--desktop-exe'))
    throw new Error('Usage: pnpm test:harness [--desktop-exe <installed Harness executable>]');
  checkCompatibility(['--sdk-only']);
  execFileSync(process.execPath, [fileURLToPath(new URL('./check-package.mjs', import.meta.url))], {
    cwd: fileURLToPath(new URL('../', import.meta.url)),
    stdio: 'inherit',
    windowsHide: true,
  });
  const plugin = JSON.parse(
    readFileSync(new URL('../packages/dsh-cicada/package.json', import.meta.url), 'utf8'),
  );
  const runtime = await localHarnessRuntime(
    plugin,
    (version) => checkCompatibility(['--host-version', version]),
    args[1],
  );
  const result = await withOwnedHarness(runtime, checkHarnessUi);
  console.log(`Owned test Host stopped and its plugin removed. Isolated evidence: ${result.directory}`);
}
