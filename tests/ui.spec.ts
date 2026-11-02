import { expect, test, type Page } from '@playwright/test';

async function allowFixtureConfirmation(page: Page, conflict = false): Promise<void> {
  await page.route(
    (url) => url.pathname === '/dev/main.tsx',
    async (route) => {
      const response = await route.fetch();
      const body = await response.text();
      const stub = conflict
        ? `view.status.revision++; throw new Error('配置已变化，草稿保留');`
        : `view.status.revision++;
         view.status.dryRun = false;
         return clone();`;
      const replaced = body.replace(/throw new Error\([^\n]*隔离预览禁止确认真实操作[^\n]*\);/, stub);
      expect(replaced).not.toBe(body);
      await route.fulfill({ response, body: replaced });
    },
  );
}

async function confirmFixture(page: Page): Promise<void> {
  await page.getByRole('textbox', { name: '确认文字' }).fill('我确认');
  await page.getByRole('button', { name: '确认', exact: true }).click();
  await expect(page.getByRole('dialog')).toBeHidden();
}
async function transformFixture(page: Page, transform: (body: string) => string): Promise<void> {
  await page.route(
    (url) => url.pathname === '/dev/main.tsx',
    async (route) => {
      const response = await route.fetch();
      const body = await response.text();
      const replaced = transform(body);
      expect(replaced).not.toBe(body);
      await route.fulfill({ response, body: replaced });
    },
  );
}
async function seedFixture(page: Page, setup: string): Promise<void> {
  await transformFixture(page, (body) =>
    body.replace(
      'const clone = () => structuredClone(view);',
      `${setup}\nconst clone = () => structuredClone(view);`,
    ),
  );
}
type SaveFixtureWindow = Window & { finishFixtureSave?: () => void };
async function releaseFixtureSave(page: Page): Promise<void> {
  await page.evaluate(() => {
    const fixture = window as SaveFixtureWindow;
    if (!fixture.finishFixtureSave) throw new Error('No pending fixture save');
    fixture.finishFixtureSave();
    delete fixture.finishFixtureSave;
  });
}
type ViewFixtureWindow = Window & {
  delayFixtureView?: boolean;
  finishStaleView?: () => void;
  staleViewReleased?: boolean;
  fixtureBusy?: boolean;
};
async function delayViewFixture(page: Page, fail = false): Promise<void> {
  await transformFixture(page, (body) =>
    body.replace(
      'view: async () => clone(),',
      `view: async () => {
      view.status.busy = Boolean(window.fixtureBusy);
      const snapshot = clone();
      if (window.delayFixtureView) {
        window.delayFixtureView = false;
        await new Promise(resolve => { window.finishStaleView = resolve; });
        window.staleViewReleased = true;
        ${fail ? "throw new Error('stale connection failure');" : ''}
      }
      return snapshot;
    },`,
    ),
  );
}
async function startDelayedView(page: Page): Promise<void> {
  await page.evaluate(() => {
    (window as ViewFixtureWindow).delayFixtureView = true;
  });
  await page.getByRole('button', { name: '刷新状态', exact: true }).click();
  await expect
    .poll(() => page.evaluate(() => Boolean((window as ViewFixtureWindow).finishStaleView)))
    .toBe(true);
}
async function releaseDelayedView(page: Page): Promise<void> {
  await page.evaluate(() => {
    const fixture = window as ViewFixtureWindow;
    if (!fixture.finishStaleView) throw new Error('No pending fixture view');
    fixture.finishStaleView();
  });
  await expect
    .poll(() => page.evaluate(() => Boolean((window as ViewFixtureWindow).staleViewReleased)))
    .toBe(true);
}

for (const fail of [false, true])
  test(`ignores a stale refresh ${fail ? 'error' : 'response'} after saving without regressing draft revisions`, async ({
    page,
  }) => {
    await page.clock.install();
    await delayViewFixture(page, fail);
    await page.goto('/');
    await page.getByRole('tab', { name: '触发规则' }).click();
    await startDelayedView(page);
    await page.getByRole('spinbutton', { name: 'L1 天数' }).fill('2.5');
    await page.getByRole('button', { name: '保存', exact: true }).click();
    await expect(page.getByRole('status').filter({ hasText: '设置已保存' })).toBeVisible();
    await releaseDelayedView(page);
    await expect(page.getByRole('spinbutton', { name: 'L1 天数' })).toHaveValue('2.5');
    await expect(page.getByRole('alert')).toHaveCount(0);
    await page.getByRole('spinbutton', { name: 'L1 天数' }).fill('2.6');
    await page.getByRole('button', { name: '保存', exact: true }).click();
    await expect(page.getByText('已与宿主同步', { exact: true })).toBeVisible();
    await expect(page.getByRole('spinbutton', { name: 'L1 天数' })).toHaveValue('2.6');
    await expect(page.getByRole('alert')).toHaveCount(0);
  });

test('ignores an older refresh even when the configuration revision is unchanged', async ({ page }) => {
  await page.clock.install();
  await delayViewFixture(page);
  await page.goto('/');
  await expect(page.getByRole('heading', { name: '蝉蜕 Cicada' })).toBeVisible();
  await startDelayedView(page);
  await page.evaluate(() => {
    (window as ViewFixtureWindow).fixtureBusy = true;
  });
  await page.getByRole('button', { name: '刷新状态', exact: true }).click();
  await expect(page.getByText('动作执行中', { exact: true })).toBeVisible();
  await releaseDelayedView(page);
  await expect(page.getByText('动作执行中', { exact: true })).toBeVisible();
});

for (const width of [390, 1100])
  for (const theme of ['light', 'dark']) {
    test(`${width}px ${theme}: five views, drafts and layout`, async ({ page }) => {
      await page.setViewportSize({ width, height: 850 });
      await page.goto(`/?theme=${theme}`);
      await expect(page.getByRole('heading', { name: '蝉蜕 Cicada' })).toBeVisible();
      await page.getByRole('tab', { name: '触发规则' }).click();
      await page.getByRole('spinbutton', { name: 'L1 天数' }).fill('2.5');
      await page.getByRole('tab', { name: '动作配置' }).click();
      await expect(page.getByRole('textbox', { name: '待粉碎文件夹' })).toBeVisible();
      await page.getByRole('textbox', { name: '浏览记录关键词' }).fill('fixture');
      await page.getByRole('tab', { name: '触发规则' }).click();
      await expect(page.getByRole('spinbutton', { name: 'L1 天数' })).toHaveValue('2.5');
      await page.getByRole('button', { name: '保存', exact: true }).click();
      await expect(page.getByRole('status').filter({ hasText: '设置已保存' })).toBeVisible();
      await page.getByRole('tab', { name: '动作配置' }).click();
      await expect(page.getByRole('textbox', { name: '浏览记录关键词' })).toHaveValue('fixture');
      await page.getByRole('button', { name: '保存', exact: true }).click();
      await expect(page.getByRole('status').filter({ hasText: '设置已保存' })).toBeVisible();
      await page.getByRole('tab', { name: '假历史' }).click();
      await page.getByRole('button', { name: '生成预览' }).click();
      await expect(page.locator('tbody tr').first()).toBeVisible();
      await page.getByRole('tab', { name: '运行日志' }).click();
      await expect(page.getByRole('log')).toBeVisible();
      await page.getByRole('tab', { name: '总览' }).click();
      await page.screenshot({ path: `artifacts/ui/overview-${width}-${theme}.png`, fullPage: true });
      expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
      await page.getByRole('button', { name: '切换真实模式' }).click();
      await expect(page.getByRole('dialog')).toBeVisible();
      await expect(page.getByRole('button', { name: '确认', exact: true })).toBeDisabled();
      await page.getByRole('textbox', { name: '确认文字' }).fill('我确认');
      await expect(page.getByRole('button', { name: '确认', exact: true })).toBeEnabled();
      await page.screenshot({ path: `artifacts/ui/confirmation-${width}-${theme}.png`, fullPage: true });
      await page.getByRole('button', { name: '取消', exact: true }).click();
    });
  }
test('failed save retains the draft and unsaved warning', async ({ page }) => {
  await page.goto('/');
  await page.getByRole('tab', { name: '触发规则' }).click();
  await page.getByRole('spinbutton', { name: 'L1 天数' }).fill('8');
  await page.getByRole('button', { name: '保存', exact: true }).click();
  await expect(page.getByRole('alert')).toContainText('严格递增');
  await expect(page.getByRole('spinbutton', { name: 'L1 天数' })).toHaveValue('8');
  await expect(page.getByText('有未保存的修改', { exact: true })).toBeVisible();
});

for (const kind of ['live', 'authorize', 'execute', 'safeMode'] as const) {
  test(`${kind} confirmation preserves all drafts and keeps them saveable`, async ({ page }) => {
    await allowFixtureConfirmation(page);
    await page.goto('/');
    if (kind === 'authorize' || kind === 'safeMode') {
      await page.getByRole('button', { name: '切换真实模式' }).click();
      await confirmFixture(page);
    }
    await page.getByRole('tab', { name: '触发规则' }).click();
    await page.getByRole('spinbutton', { name: 'L1 天数' }).fill('2.5');
    await page.getByRole('tab', { name: '动作配置' }).click();
    await page.getByRole('textbox', { name: '浏览记录关键词' }).fill('retained-synthetic');
    await page.getByRole('tab', { name: '假历史' }).click();
    await page.getByRole('radio', { name: '学生', exact: true }).check();
    if (kind === 'execute') {
      await page.getByRole('tab', { name: '动作配置' }).click();
      await page.getByRole('button', { name: '全流程真实执行' }).click();
    } else if (kind === 'safeMode') {
      await page.getByRole('tab', { name: '总览' }).click();
      await page.getByRole('button', { name: '切回演练' }).click();
      await expect(page.getByRole('status').filter({ hasText: '已切回演练' })).toBeVisible();
    } else {
      await page.getByRole('tab', { name: '总览' }).click();
      await page.getByRole('button', { name: kind === 'live' ? '切换真实模式' : '授权自动触发' }).click();
    }
    if (kind !== 'safeMode') await confirmFixture(page);
    for (const tab of ['触发规则', '动作配置', '假历史']) {
      await page.getByRole('tab', { name: tab }).click();
      await expect(page.getByText('有未保存的修改', { exact: true })).toBeVisible();
      if (tab === '触发规则')
        await expect(page.getByRole('spinbutton', { name: 'L1 天数' })).toHaveValue('2.5');
      else if (tab === '动作配置')
        await expect(page.getByRole('textbox', { name: '浏览记录关键词' })).toHaveValue('retained-synthetic');
      else await expect(page.getByRole('radio', { name: '学生', exact: true })).toBeChecked();
      await page.getByRole('button', { name: '保存', exact: true }).click();
      await expect(page.getByRole('status').filter({ hasText: '设置已保存' })).toBeVisible();
    }
  });
}

test('failed confirmation preserves drafts without rebasing a conflict', async ({ page }) => {
  await allowFixtureConfirmation(page, true);
  await page.goto('/');
  await page.getByRole('tab', { name: '触发规则' }).click();
  await page.getByRole('spinbutton', { name: 'L1 天数' }).fill('2.5');
  await page.getByRole('tab', { name: '总览' }).click();
  await page.getByRole('button', { name: '切换真实模式' }).click();
  await page.getByRole('textbox', { name: '确认文字' }).fill('我确认');
  await page.getByRole('button', { name: '确认', exact: true }).click();
  await expect(page.getByRole('alert')).toContainText('配置已变化');
  await page.getByRole('button', { name: '取消', exact: true }).click();
  await page.getByRole('tab', { name: '触发规则' }).click();
  await expect(page.getByRole('spinbutton', { name: 'L1 天数' })).toHaveValue('2.5');
  await page.getByRole('button', { name: '保存', exact: true }).click();
  await expect(page.getByRole('alert')).toContainText('配置已变化');
  await expect(page.getByText('有未保存的修改', { exact: true })).toBeVisible();
});

test('import requires separate permission before discarding drafts', async ({ page }) => {
  await allowFixtureConfirmation(page);
  await page.goto('/');
  await page.getByRole('tab', { name: '触发规则' }).click();
  await page.getByRole('spinbutton', { name: 'L1 天数' }).fill('2.5');
  await page.getByRole('tab', { name: '动作配置' }).click();
  await page.getByRole('button', { name: '预览旧版导入' }).click();
  await page.getByRole('button', { name: '确认导入副本' }).click();
  await page.getByRole('textbox', { name: '确认文字' }).fill('我确认');
  page.once('dialog', async (dialog) => {
    expect(dialog.message()).toContain('放弃所有分区');
    await dialog.dismiss();
  });
  await page.getByRole('button', { name: '确认', exact: true }).click();
  await expect(page.getByRole('dialog')).toBeVisible();
  await page.getByRole('button', { name: '取消', exact: true }).click();
  await page.getByRole('tab', { name: '触发规则' }).click();
  await expect(page.getByRole('spinbutton', { name: 'L1 天数' })).toHaveValue('2.5');
  await page.getByRole('tab', { name: '动作配置' }).click();
  await page.getByRole('button', { name: '确认导入副本' }).click();
  await page.getByRole('textbox', { name: '确认文字' }).fill('我确认');
  page.once('dialog', async (dialog) => {
    await dialog.accept();
  });
  await page.getByRole('button', { name: '确认', exact: true }).click();
  await expect(page.getByRole('dialog')).toBeHidden();
  await page.getByRole('tab', { name: '触发规则' }).click();
  await expect(page.getByRole('spinbutton', { name: 'L1 天数' })).toHaveValue('3');
  await expect(page.getByText('有未保存的修改', { exact: true })).toHaveCount(0);
});

for (const section of ['rules', 'targets', 'history'] as const) {
  test(`${section} keeps edits made while a save response is pending`, async ({ page }) => {
    await transformFixture(page, (body) =>
      body.replace(
        'const input = structuredClone(request.config);',
        'const input = structuredClone(request.config); await new Promise(resolve => { window.finishFixtureSave = resolve; });',
      ),
    );
    await page.goto('/');
    await page
      .getByRole('tab', { name: { rules: '触发规则', targets: '动作配置', history: '假历史' }[section] })
      .click();
    const change = async (second: boolean) => {
      if (section === 'rules')
        await page.getByRole('spinbutton', { name: 'L1 天数' }).fill(second ? '2.6' : '2.5');
      else if (section === 'targets')
        await page
          .getByRole('textbox', { name: '浏览记录关键词' })
          .fill(second ? 'new-synthetic' : 'submitted-synthetic');
      else await page.getByRole('radio', { name: second ? '游戏玩家' : '学生', exact: true }).check();
    };
    const assertLatest = async () => {
      if (section === 'rules')
        await expect(page.getByRole('spinbutton', { name: 'L1 天数' })).toHaveValue('2.6');
      else if (section === 'targets')
        await expect(page.getByRole('textbox', { name: '浏览记录关键词' })).toHaveValue('new-synthetic');
      else await expect(page.getByRole('radio', { name: '游戏玩家', exact: true })).toBeChecked();
    };
    await change(false);
    await page.getByRole('button', { name: '保存', exact: true }).click();
    await expect
      .poll(() => page.evaluate(() => Boolean((window as SaveFixtureWindow).finishFixtureSave)))
      .toBe(true);
    await change(true);
    await releaseFixtureSave(page);
    await expect(page.getByRole('status').filter({ hasText: '设置已保存' })).toBeVisible();
    await assertLatest();
    await expect(page.getByText('有未保存的修改', { exact: true })).toBeVisible();
    await page.getByRole('button', { name: '保存', exact: true }).click();
    await expect
      .poll(() => page.evaluate(() => Boolean((window as SaveFixtureWindow).finishFixtureSave)))
      .toBe(true);
    await releaseFixtureSave(page);
    await expect(page.getByText('已与宿主同步', { exact: true })).toBeVisible();
    await assertLatest();
  });
}

for (const action of ['stopAutomation', 'safeMode'] as const) {
  test(`${action} remains available during a live action without saving unrelated drafts`, async ({
    page,
  }) => {
    await seedFixture(
      page,
      `
      view.status.busy = true;
      view.status.dryRun = view.config.dryRun = false;
      view.status.autoTrigger = view.config.autoTrigger = true;
      view.status.authorized = true;
    `,
    );
    await page.goto('/');
    await page.getByRole('tab', { name: '触发规则' }).click();
    await page.getByRole('spinbutton', { name: 'L1 天数' }).fill('8');
    await expect(page.getByRole('button', { name: '保存', exact: true })).toBeDisabled();
    if (action === 'stopAutomation') {
      await page.getByRole('checkbox', { name: '自动触发', exact: true }).uncheck();
      await expect(page.getByRole('status').filter({ hasText: '自动触发已关闭' })).toBeVisible();
    } else {
      await page.getByRole('tab', { name: '总览' }).click();
      await expect(page.getByRole('button', { name: '切回演练', exact: true })).toBeEnabled();
      await page.getByRole('button', { name: '切回演练', exact: true }).click();
      await expect(page.getByRole('status').filter({ hasText: '已切回演练' })).toBeVisible();
      await page.getByRole('tab', { name: '触发规则' }).click();
    }
    await expect(page.getByRole('checkbox', { name: '自动触发', exact: true })).not.toBeChecked();
    await expect(page.getByRole('spinbutton', { name: 'L1 天数' })).toHaveValue('8');
    await expect(page.getByText('有未保存的修改', { exact: true })).toBeVisible();
    await page.getByRole('tab', { name: '总览' }).click();
    await expect(page.getByText('自动触发关闭', { exact: true })).toBeVisible();
    await expect(page.getByText('动作执行中', { exact: true })).toBeVisible();
  });
}

test('overview provides an independent stop button while busy', async ({ page }) => {
  await seedFixture(
    page,
    'view.status.busy = true; view.status.autoTrigger = view.config.autoTrigger = true;',
  );
  await page.goto('/');
  await page.getByRole('button', { name: '关闭自动触发', exact: true }).click();
  await expect(page.getByRole('status').filter({ hasText: '自动触发已关闭' })).toBeVisible();
  await expect(page.getByRole('button', { name: '关闭自动触发', exact: true })).toHaveCount(0);
});

for (const mode of ['drill', 'live'] as const) {
  test(`legacy ${mode} review requires a deliberate conclusion and matching phrase`, async ({ page }) => {
    await seedFixture(page, 'view.legacyLevels = [1, 2];');
    await page.setViewportSize({ width: 390, height: 850 });
    await page.goto('/?theme=dark');
    await page.getByRole('tab', { name: '运行日志' }).click();
    await page.getByRole('button', { name: '核查 L1', exact: true }).click();
    await expect(page.getByRole('button', { name: '确认核查', exact: true })).toBeDisabled();
    await page.getByRole('combobox', { name: '旧记录核查结论' }).selectOption(mode);
    const text = page.getByRole('textbox', { name: '旧记录核查文字' });
    await text.fill(mode === 'drill' ? '已核查真实执行' : '已核查仅为演练');
    await expect(page.getByRole('button', { name: '确认核查', exact: true })).toBeDisabled();
    await text.fill(mode === 'drill' ? '已核查仅为演练' : '已核查真实执行');
    await page.screenshot({ path: `artifacts/ui/legacy-${mode}-390-dark.png`, fullPage: true });
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
    await page.getByRole('button', { name: '确认核查', exact: true }).click();
    await expect(page.getByRole('dialog')).toBeHidden();
    await expect(page.getByRole('button', { name: '核查 L1', exact: true })).toHaveCount(0);
    await expect(page.getByRole('button', { name: '核查 L2', exact: true })).toBeVisible();
    await expect(page.getByText('自动触发关闭', { exact: true })).toBeVisible();
  });
}
