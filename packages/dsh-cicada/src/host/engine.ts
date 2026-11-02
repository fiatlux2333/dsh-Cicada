import { createHash, randomUUID } from 'node:crypto';
import {
  actionLabels,
  configurationSchema,
  defaults,
  documentSchema,
  freshDocument,
  splitConfiguration,
  targetsSchema,
} from '../shared/config.ts';
import { generateHistory } from '../shared/history.ts';
import type {
  Configuration,
  Confirmation,
  ConfirmRequest,
  Document,
  ImportPreview,
  Level,
  LogEntry,
  RunRecord,
  SaveRequest,
  Status,
  StepResult,
  Targets,
  View,
} from '../shared/types.ts';

export interface Repository {
  load(): Promise<Document | null>;
  save(document: Document): Promise<void>;
}
export interface Secrets {
  protect(targets: Targets): Promise<string>;
  unprotect(token: string): Promise<Targets>;
}
export interface ActionRunner {
  run(config: Configuration, level: Level, live: boolean): Promise<StepResult[]>;
}
export interface EngineOptions {
  repository: Repository;
  secrets: Secrets;
  runner: ActionRunner;
  writable: boolean;
  lease?: () => boolean;
  now?: () => number;
}
interface PendingConfirmation {
  value: Confirmation;
  peer: string;
  imported?: ImportPreview;
}

export class CicadaEngine {
  private document!: Document;
  private targets: Targets = defaults().targets;
  private secretError = false;
  private clockWarning = false;
  private closed = false;
  private initialized = false;
  private leaseLost = false;
  private stopFailed = false;
  private pumping = false;
  private chain: Promise<unknown> = Promise.resolve();
  private pumpTask: Promise<void> | null = null;
  private confirmations = new Map<string, PendingConfirmation>();
  readonly now: () => number;

  constructor(private readonly options: EngineOptions) {
    this.now = options.now ?? Date.now;
  }
  private exclusive<T>(task: () => Promise<T>): Promise<T> {
    const next = this.chain.then(task);
    this.chain = next.catch(() => {});
    return next;
  }
  async initialize(): Promise<void> {
    const loaded = await this.options.repository.load();
    this.document = loaded ? documentSchema.parse(loaded) : freshDocument(this.now(), randomUUID());
    if (loaded && !this.document.encryptedTargets.trim()) this.secretError = true;
    if (this.document.encryptedTargets) {
      try {
        this.targets = targetsSchema.parse(
          await this.options.secrets.unprotect(this.document.encryptedTargets),
        );
      } catch {
        this.secretError = true;
      }
    }
    if (!this.options.writable) {
      this.initialized = true;
      return;
    }
    this.assertOwnership();
    const next = structuredClone(this.document);
    if (!loaded) next.encryptedTargets = await this.encryptTargets(this.targets);
    if (!next.settings.reminderEnabled) next.state.reminderPending = false;
    for (const run of next.runs) {
      if (run.state === 'started') {
        run.state = 'interrupted';
        run.finishedAt = this.now();
      }
      if (run.state === 'pending') {
        run.state = 'cancelled';
        run.finishedAt = this.now();
      }
    }
    await this.commit(next);
    this.initialized = true;
  }
  private config(): Configuration {
    return { ...structuredClone(this.document.settings), targets: structuredClone(this.targets) };
  }
  private authHash(config = this.config()): string {
    const {
      dryRun: _dryRun,
      autoTrigger: _autoTrigger,
      reminderEnabled: _reminderEnabled,
      reminderHour: _reminderHour,
      ...dangerous
    } = config;
    return createHash('sha256').update(JSON.stringify(dangerous)).digest('hex');
  }
  private authorized(): boolean {
    return !this.secretError && this.document.authorization?.hash === this.authHash();
  }
  private ownsStorage(): boolean {
    if (!this.options.writable) return false;
    if (this.options.lease && !this.options.lease()) this.leaseLost = true;
    return !this.leaseLost;
  }
  private assertOwnership(): void {
    if (!this.ownsStorage()) {
      if (this.leaseLost) throw new Error('监控互斥锁已失效，请重启宿主');
      throw new Error('其他宿主正在监控，或当前系统不是 Windows；此实例只读');
    }
  }
  private writable(): void {
    if (this.closed) throw new Error('插件已停止');
    this.assertOwnership();
  }
  private async encryptTargets(targets: Targets): Promise<string> {
    const token = await this.options.secrets.protect(targets);
    if (!token.trim()) throw new Error('敏感配置加密失败，未保存空密文');
    return token;
  }
  private async commit(next: Document): Promise<void> {
    this.assertOwnership();
    const drills = next.runs.filter(
      (r) =>
        r.mode === 'drill' &&
        r.source === 'manual' &&
        !['started', 'pending', 'interrupted'].includes(r.state),
    );
    const recentDrills = new Set(drills.slice(-200).map((r) => r.id));
    next.runs = next.runs.filter(
      (r) =>
        r.mode !== 'drill' ||
        r.source !== 'manual' ||
        ['started', 'pending', 'interrupted'].includes(r.state) ||
        recentDrills.has(r.id),
    );
    const history = next.runs.filter(
      (r) => r.cycle !== next.state.cycle && !['pending', 'started', 'interrupted'].includes(r.state),
    );
    const retained = new Set(history.slice(-1000).map((r) => r.id));
    next.runs = next.runs.filter(
      (r) =>
        r.cycle === next.state.cycle ||
        ['pending', 'started', 'interrupted'].includes(r.state) ||
        retained.has(r.id),
    );
    const parsed = documentSchema.parse(next);
    this.assertOwnership();
    await this.options.repository.save(parsed);
    this.assertOwnership();
    this.document = next;
  }
  private log(next: Document, text: string, level: LogEntry['level'] = 'info'): void {
    next.logs.push({ id: (next.logs.at(-1)?.id ?? 0) + 1, at: this.now(), level, text });
    next.logs = next.logs.slice(-3000);
  }
  private cancelPending(next: Document): void {
    for (const run of next.runs)
      if (run.state === 'pending') {
        run.state = 'cancelled';
        run.finishedAt = this.now();
      }
  }
  status(): Status {
    const now = this.now(),
      d = this.document;
    const ownsStorage = this.ownsStorage();
    const silenceDays = Math.max(0, (now - d.state.lastCheckin) / 86400000);
    const level = d.settings.levels.filter((v) => silenceDays >= v).length;
    const unresolved = d.runs.some((r) => r.mode === 'live' && r.state === 'interrupted');
    return {
      lastCheckin: d.state.lastCheckin,
      silenceDays,
      level,
      nextLevel: level < 4 ? level + 1 : null,
      remainingDays: level < 4 ? Math.max(0, d.settings.levels[level]! - silenceDays) : null,
      pausedUntil: d.state.pausedUntil !== null && d.state.pausedUntil > now ? d.state.pausedUntil : null,
      dryRun: d.settings.dryRun,
      autoTrigger: d.settings.autoTrigger,
      authorized: !this.stopFailed && this.authorized(),
      busy: this.pumping,
      writable: ownsStorage && !this.closed,
      revision: d.revision,
      clockWarning: this.clockWarning || now < d.state.lastObserved,
      secretError: this.secretError,
      reminderPending: d.settings.reminderEnabled && d.state.reminderPending,
      blocked: this.stopFailed
        ? '停止设置尚未保存，本次宿主已锁定后续动作；请重试关闭自动触发或切回演练'
        : unresolved
          ? '上次真实动作中断，请先核查并处理记录'
          : d.state.legacyLevels.length
            ? '旧版执行记录性质不明，请在运行日志中逐级核查；真实执行已锁定'
            : this.secretError
              ? '敏感配置缺失或解密失败，真实执行已锁定；请恢复并保存敏感目标'
              : now < d.state.lastObserved || this.clockWarning
                ? '检测到系统时钟回拨，自动触发已暂停'
                : this.leaseLost
                  ? '监控互斥锁已失效，已停止写入；请重启宿主'
                  : !this.options.writable
                    ? '只读实例，监控未启动'
                    : '',
    };
  }
  view(): View {
    return {
      status: this.status(),
      config: this.config(),
      legacyLevels: [...this.document.state.legacyLevels].sort((a, b) => a - b),
      runs: structuredClone(this.document.runs).reverse(),
      logs: structuredClone(this.document.logs),
    };
  }
  preview(persona: Configuration['persona'], days: number): ReturnType<typeof generateHistory> {
    configurationSchema.shape.persona.parse(persona);
    return generateHistory(persona, days, this.now(), 42, this.targets.keywords);
  }
  async checkin(): Promise<View> {
    return this.exclusive(async () => {
      this.writable();
      const next = structuredClone(this.document);
      this.cancelPending(next);
      next.state = {
        cycle: randomUUID(),
        lastCheckin: this.now(),
        lastObserved: this.now(),
        pausedUntil: null,
        remindedOn: '',
        reminderPending: false,
        legacyLevels: next.state.legacyLevels,
      };
      next.revision++;
      this.log(next, '已打卡，沉默计时重置');
      await this.commit(next);
      this.clockWarning = false;
      this.confirmations.clear();
      return this.view();
    });
  }
  async pause(hours: number): Promise<View> {
    if (![1, 4, 8, 24].includes(hours)) throw new Error('暂停时长无效');
    return this.exclusive(async () => {
      this.writable();
      const next = structuredClone(this.document);
      next.state.pausedUntil = this.now() + hours * 3600000;
      next.revision++;
      this.cancelPending(next);
      this.log(next, `已暂停 ${hours} 小时，沉默时间继续累计`);
      await this.commit(next);
      return this.view();
    });
  }
  async resume(): Promise<View> {
    await this.exclusive(async () => {
      this.writable();
      const next = structuredClone(this.document);
      next.state.pausedUntil = null;
      next.revision++;
      this.log(next, '已恢复监控');
      await this.commit(next);
    });
    await this.tick();
    return this.view();
  }
  async save(request: SaveRequest): Promise<View> {
    return this.exclusive(async () => {
      this.writable();
      if (this.pumping) throw new Error('动作执行中，暂不可保存');
      if (request.expectedRevision !== this.document.revision)
        throw new Error('配置已变化，请重新加载后再保存；草稿未提交');
      const current = this.config();
      const input = configurationSchema.parse(request.config);
      if (request.section === 'rules') {
        current.levels = input.levels;
        current.actions = input.actions;
        current.reminderEnabled = input.reminderEnabled;
        current.reminderHour = input.reminderHour;
        if (input.autoTrigger && !current.dryRun && !this.document.settings.autoTrigger)
          throw new Error('真实自动触发必须单独授权');
        current.autoTrigger = input.autoTrigger;
      } else if (request.section === 'targets') {
        current.targets = input.targets;
        current.browsers = input.browsers;
      } else if (request.section === 'history') current.persona = input.persona;
      else throw new Error('配置分区无效');
      const parsed = splitConfiguration(current);
      const next = structuredClone(this.document);
      const changesDanger = this.secretError || this.authHash(current) !== this.authHash();
      if (changesDanger) {
        next.authorization = null;
        if (!current.dryRun) parsed.settings.autoTrigger = false;
      }
      if (this.secretError && request.section !== 'targets')
        throw new Error('请先恢复敏感配置，原密文不会被覆盖');
      next.encryptedTargets = await this.encryptTargets(parsed.targets);
      next.settings = parsed.settings;
      if (!next.settings.reminderEnabled) next.state.reminderPending = false;
      next.revision++;
      this.cancelPending(next);
      this.log(next, changesDanger ? '设置已保存，危险配置变更需要重新授权' : '设置已保存');
      await this.commit(next);
      this.targets = parsed.targets;
      this.secretError = false;
      this.confirmations.clear();
      return this.view();
    });
  }
  async safeMode(): Promise<View> {
    return this.stop(true);
  }
  async stopAutomation(): Promise<View> {
    return this.stop(false);
  }
  private async stop(safe: boolean): Promise<View> {
    this.writable();
    // Fence admissions immediately, even while the serialized stop is waiting for storage.
    this.stopFailed = true;
    this.confirmations.clear();
    return this.exclusive(async () => {
      this.writable();
      this.stopFailed = true;
      const next = structuredClone(this.document);
      if (safe) next.settings.dryRun = true;
      next.settings.autoTrigger = false;
      next.authorization = null;
      next.revision++;
      this.cancelPending(next);
      this.log(
        next,
        safe ? '已切回演练并关闭自动触发' : '已关闭自动触发并取消未开始的请求；当前动作继续完成',
      );
      try {
        await this.commit(next);
      } catch {
        throw new Error(
          '停止设置保存失败，本次宿主已锁定后续动作；请重试关闭自动触发或切回演练，成功保存前不要重启宿主',
        );
      }
      this.stopFailed = false;
      return this.view();
    });
  }
  prepare(kind: Confirmation['kind'], peer: string, imported?: ImportPreview): Confirmation {
    this.writable();
    if (this.stopFailed) throw new Error('请先重试并保存停止设置');
    for (const [token, item] of this.confirmations)
      if (item.value.expiresAt < this.now()) this.confirmations.delete(token);
    if (this.confirmations.size >= 32) throw new Error('待确认请求过多，请稍后重试');
    if (this.secretError && kind !== 'import') throw new Error('敏感配置缺失或解密失败');
    if (kind !== 'import' && this.document.state.legacyLevels.length)
      throw new Error('请先在运行日志中核查旧版执行记录');
    if (this.pumping) throw new Error('动作执行中');
    if (kind === 'authorize' && this.document.settings.dryRun) throw new Error('请先确认真实模式');
    if (kind === 'execute' && this.document.runs.some((r) => r.mode === 'live' && r.state === 'interrupted'))
      throw new Error('请先核查中断记录');
    const config = imported?.config ?? this.config();
    const summary =
      kind === 'import'
        ? '导入只复制数据，不改变旧程序。导入后强制演练并关闭自动触发。旧版等级无法区分演练或真实执行，需在运行日志中逐级核查后才能真实执行。请勿同时运行两个程序的真实自动动作。'
        : `${kind === 'authorize' ? '授权无人值守真实自动执行；重启后立即补执行到期等级。' : kind === 'execute' ? '立即真实执行 L1 → L4，不受演练模式保护。' : '进入真实模式；自动触发仍关闭。'}\n${Object.entries(
            config.actions,
          )
            .map(([k, enabled]) => `${enabled ? '启用' : '关闭'} ${actionLabels[k]}`)
            .join('\n')}\n浏览器：${
            Object.entries(config.browsers)
              .filter(([, v]) => v)
              .map(([k]) => k)
              .join('、') || '无'
          }\n关键词：${config.targets.keywords.length ? '定向清理' : '未配置，将全量清理浏览数据'}\n文件夹：\n${config.targets.folders.join('\n') || '无'}\n软件：\n${config.targets.apps.join('\n') || '无'}\n操作可能不可逆；SSD 不保证物理擦除，云端同步记录不会被清理。`;
    const value: Confirmation = {
      token: randomUUID(),
      kind,
      summary,
      expiresAt: this.now() + 120000,
      revision: this.document.revision,
    };
    this.confirmations.set(value.token, { value, peer, ...(imported ? { imported } : {}) });
    return value;
  }
  async confirm(request: ConfirmRequest, peer: string): Promise<View> {
    await this.exclusive(async () => {
      this.writable();
      if (this.stopFailed) throw new Error('请先重试并保存停止设置');
      const pending = this.confirmations.get(request.token);
      this.confirmations.delete(request.token);
      if (
        !pending ||
        pending.peer !== peer ||
        pending.value.expiresAt < this.now() ||
        pending.value.revision !== this.document.revision ||
        request.phrase !== '我确认'
      )
        throw new Error('确认已过期、配置已变化或确认文字不匹配');
      if (this.pumping) throw new Error('动作执行中');
      const next = structuredClone(this.document);
      next.revision++;
      this.cancelPending(next);
      if (pending.value.kind === 'live') {
        next.settings.dryRun = false;
        next.settings.autoTrigger = false;
        next.authorization = null;
      }
      if (pending.value.kind === 'authorize') {
        next.encryptedTargets = await this.encryptTargets(this.targets);
        next.settings.autoTrigger = true;
        next.authorization = { hash: this.authHash(), at: this.now() };
      }
      if (pending.value.kind === 'import') {
        const imported = pending.imported;
        if (!imported) throw new Error('无可导入数据');
        const parsed = splitConfiguration(imported.config);
        next.encryptedTargets = await this.encryptTargets(parsed.targets);
        next.settings = { ...parsed.settings, dryRun: true, autoTrigger: false };
        next.authorization = null;
        next.state = {
          cycle: randomUUID(),
          lastCheckin: imported.lastCheckin ?? this.now(),
          pausedUntil: imported.pausedUntil,
          lastObserved: this.now(),
          remindedOn: '',
          reminderPending: false,
          legacyLevels: [...new Set([...next.state.legacyLevels, ...imported.executedLevels])],
        };
        this.log(next, '已导入副本，保持演练，自动触发关闭');
        await this.commit(next);
        this.targets = parsed.targets;
        this.secretError = false;
        this.confirmations.clear();
        return;
      }
      if (pending.value.kind === 'execute')
        for (const level of [1, 2, 3, 4]) next.runs.push(this.record(next, level, 'live'));
      this.log(next, `人工确认：${pending.value.kind}`);
      await this.commit(next);
      this.confirmations.clear();
    });
    this.kick();
    return this.view();
  }
  async resolveInterrupted(id: string, phrase: string): Promise<View> {
    if (phrase !== '已核查中断动作') throw new Error('请输入核查确认文字');
    return this.exclusive(async () => {
      this.writable();
      const next = structuredClone(this.document);
      const run = next.runs.find((r) => r.id === id && r.state === 'interrupted');
      if (!run) throw new Error('记录不存在');
      run.state = 'failed';
      next.revision++;
      this.log(next, '中断记录已由人工核查，自动执行不会重试该等级', 'warning');
      await this.commit(next);
      return this.view();
    });
  }
  async resolveLegacy(
    level: number,
    mode: 'drill' | 'live',
    phrase: string,
    expectedRevision: number,
  ): Promise<View> {
    if (![1, 2, 3, 4].includes(level) || !['drill', 'live'].includes(mode))
      throw new Error('旧版记录核查参数无效');
    if (phrase !== (mode === 'drill' ? '已核查仅为演练' : '已核查真实执行'))
      throw new Error('核查确认文字不匹配');
    return this.exclusive(async () => {
      this.writable();
      if (this.pumping) throw new Error('动作执行中，暂不可核查');
      if (expectedRevision !== this.document.revision) throw new Error('状态已变化，请重新核查');
      if (!this.document.state.legacyLevels.includes(level)) throw new Error('无待核查的旧版等级');
      const next = structuredClone(this.document);
      next.state.legacyLevels = next.state.legacyLevels.filter((value) => value !== level);
      next.settings.autoTrigger = false;
      next.authorization = null;
      next.revision++;
      this.cancelPending(next);
      const record = this.record(next, level, mode, 'legacy');
      record.state = 'completed';
      record.finishedAt = this.now();
      record.steps = [
        {
          action: 'legacy-review',
          status: 'completed',
          count: 0,
          detail:
            mode === 'drill'
              ? '人工核查：旧版仅为演练，不占用真实执行资格'
              : '人工核查：旧版已有真实执行，本周期不自动重试',
        },
      ];
      next.runs.push(record);
      this.log(
        next,
        `旧版 L${level} 已核查为${mode === 'drill' ? '演练' : '真实执行'}；自动触发关闭，需重新授权`,
      );
      await this.commit(next);
      this.confirmations.clear();
      return this.view();
    });
  }
  private record(
    d: Document,
    level: number,
    mode: RunRecord['mode'],
    source: RunRecord['source'] = 'manual',
  ): RunRecord {
    return {
      id: randomUUID(),
      cycle: d.state.cycle,
      revision: d.revision,
      level,
      mode,
      source,
      state: 'pending',
      createdAt: this.now(),
      finishedAt: null,
      steps: [],
    };
  }
  async drill(): Promise<View> {
    await this.exclusive(async () => {
      this.writable();
      if (this.stopFailed) throw new Error('请先重试并保存停止设置');
      if (this.pumping || this.document.runs.some((r) => r.state === 'pending'))
        throw new Error('已有动作排队或执行中');
      const next = structuredClone(this.document);
      next.runs.push(this.record(next, Math.max(1, this.status().level), 'drill'));
      await this.commit(next);
    });
    this.kick();
    return this.view();
  }
  async tick(): Promise<void> {
    if (!this.options.writable || this.closed) return;
    this.writable();
    await this.exclusive(async () => {
      const next = structuredClone(this.document),
        now = this.now();
      if (now < next.state.lastObserved) {
        this.clockWarning = true;
        return;
      }
      this.clockWarning = false;
      next.state.lastObserved = now;
      const s = this.status(),
        day = new Date(now).toLocaleDateString('sv-SE');
      if (
        next.settings.reminderEnabled &&
        !s.pausedUntil &&
        new Date(next.state.lastCheckin).toLocaleDateString('sv-SE') !== day &&
        next.state.remindedOn !== day &&
        new Date(now).getHours() >= next.settings.reminderHour
      ) {
        next.state.remindedOn = day;
        next.state.reminderPending = true;
        this.log(next, '今日尚未打卡', 'warning');
      }
      if (
        next.settings.autoTrigger &&
        !s.pausedUntil &&
        !s.blocked &&
        (next.settings.dryRun || this.authorized())
      ) {
        const mode = next.settings.dryRun ? 'drill' : 'live';
        for (let level = 1; level <= s.level; level++) {
          const admitted = next.runs.some(
            (r) =>
              r.cycle === next.state.cycle &&
              r.mode === mode &&
              (mode === 'live' || r.source === 'automatic') &&
              r.level === level &&
              r.state !== 'cancelled',
          );
          if (!admitted) next.runs.push(this.record(next, level, mode, 'automatic'));
        }
      }
      await this.commit(next);
    });
    this.kick();
  }
  private kick(): void {
    if (this.pumping || this.closed) return;
    this.pumping = true;
    this.pumpTask = this.pump().finally(() => {
      this.pumping = false;
      this.pumpTask = null;
    });
    this.pumpTask.catch(() => {
      this.closed = true;
    });
  }
  private async pump(): Promise<void> {
    while (!this.closed) {
      const admitted = await this.exclusive(async () => {
        if (!this.ownsStorage()) return null;
        const record = this.document.runs.find((r) => r.state === 'pending');
        if (!record) return null;
        const next = structuredClone(this.document),
          run = next.runs.find((r) => r.id === record.id)!;
        const status = this.status();
        const automaticBlocked =
          run.source === 'automatic' &&
          (!next.settings.autoTrigger ||
            status.pausedUntil !== null ||
            Boolean(status.blocked) ||
            (run.mode === 'live' && (!this.authorized() || next.settings.dryRun)));
        if (
          !status.writable ||
          this.stopFailed ||
          automaticBlocked ||
          run.revision !== next.revision ||
          run.cycle !== next.state.cycle ||
          (run.mode === 'live' &&
            (this.secretError ||
              next.state.legacyLevels.length > 0 ||
              status.clockWarning ||
              next.runs.some((r) => r.mode === 'live' && r.state === 'interrupted')))
        ) {
          run.state = 'cancelled';
          run.finishedAt = this.now();
          await this.commit(next);
          return { skipped: true as const };
        }
        run.state = 'started';
        await this.commit(next);
        return { skipped: false as const, record: structuredClone(run), config: this.config() };
      });
      if (!admitted) return;
      if (admitted.skipped) continue;
      let steps: StepResult[];
      try {
        steps = await this.options.runner.run(
          admitted.config,
          admitted.record.level as Level,
          admitted.record.mode === 'live',
        );
      } catch {
        steps = [
          { action: 'runner', status: 'failed', count: 0, detail: '动作执行异常；已隐藏原始目标及异常文本' },
        ];
      }
      await this.exclusive(async () => {
        // Leave persisted started records for the next owner to recover as interrupted.
        if (!this.ownsStorage()) return;
        const next = structuredClone(this.document),
          run = next.runs.find((r) => r.id === admitted.record.id)!;
        run.steps = steps;
        run.state = steps.some((s) => s.status === 'failed') ? 'failed' : 'completed';
        run.finishedAt = this.now();
        this.log(
          next,
          `${run.mode === 'live' ? '真实执行' : '演练'} L${run.level} ${run.state === 'completed' ? '完成' : '存在失败步骤'}`,
          run.state === 'failed' ? 'error' : 'info',
        );
        await this.commit(next);
      });
    }
  }
  async idle(): Promise<void> {
    await this.pumpTask;
    await this.chain;
  }
  async close(): Promise<void> {
    this.closed = true;
    this.confirmations.clear();
    try {
      await this.exclusive(async () => {
        if (this.initialized && this.ownsStorage()) {
          const next = structuredClone(this.document);
          this.cancelPending(next);
          await this.commit(next);
        }
      });
    } finally {
      await this.pumpTask;
    }
  }
}
