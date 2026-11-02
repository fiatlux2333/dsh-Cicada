import { useEffect, useRef, useState, type ReactNode } from 'react';
import {
  Activity,
  AlertTriangle,
  ArrowDownToLine,
  Check,
  ChevronRight,
  Clock3,
  FileClock,
  FlaskConical,
  History,
  List,
  LoaderCircle,
  Pause,
  Play,
  RefreshCw,
  Save,
  Settings2,
  ShieldCheck,
  ShieldOff,
  Trash2,
  X,
} from 'lucide-react';
import type { CicadaClient, Draft } from './api.ts';
import type { Confirmation, ImportPreview, Persona, SaveRequest, View, Visit } from '../shared/types.ts';
import { actionLabels, personaLabels } from '../shared/config.ts';

const pages = [
  { id: 'overview', name: '总览', icon: Activity },
  { id: 'rules', name: '触发规则', icon: Settings2 },
  { id: 'targets', name: '动作配置', icon: ShieldCheck },
  { id: 'history', name: '假历史', icon: History },
  { id: 'logs', name: '运行日志', icon: List },
] as const;
type Page = (typeof pages)[number]['id'];
const sessionDrafts = new WeakMap<CicadaClient, Partial<Record<SaveRequest['section'], Draft>>>();
const formatDate = (ms: number | null): string =>
  ms === null ? '暂无' : new Date(ms).toLocaleString('zh-CN', { hour12: false });
const runLabels: Record<string, string> = {
  pending: '待执行',
  started: '执行中',
  completed: '已完成',
  failed: '失败 / 已核查',
  interrupted: '中断待核查',
  cancelled: '已取消',
};
function Toggle({
  label,
  checked,
  onChange,
  disabled = false,
}: {
  label: string;
  checked: boolean;
  onChange: (value: boolean) => void;
  disabled?: boolean;
}): ReactNode {
  return (
    <label className="ci-toggle">
      <span>{label}</span>
      <input
        type="checkbox"
        checked={checked}
        onChange={(e) => onChange(e.target.checked)}
        disabled={disabled}
      />
      <span className="ci-switch" aria-hidden="true" />
    </label>
  );
}
function Button({
  children,
  onClick,
  disabled,
  danger,
  title,
  className = '',
}: {
  children: ReactNode;
  onClick: () => void;
  disabled?: boolean;
  danger?: boolean;
  title?: string;
  className?: string;
}): ReactNode {
  return (
    <button
      type="button"
      title={title}
      className={`ci-button ${danger ? 'ci-danger' : ''} ${className}`}
      onClick={onClick}
      disabled={disabled}
    >
      {children}
    </button>
  );
}
export function CicadaApp({ api }: { api: CicadaClient }): ReactNode {
  const [view, setView] = useState<View | null>(null),
    [page, setPage] = useState<Page>('overview');
  const [error, setError] = useState(''),
    [notice, setNotice] = useState(''),
    [working, setWorking] = useState(false);
  const [drafts, setDrafts] = useState<Partial<Record<SaveRequest['section'], Draft>>>(
    () => sessionDrafts.get(api) ?? {},
  );
  const [confirmation, setConfirmation] = useState<Confirmation | null>(null),
    [phrase, setPhrase] = useState('');
  const [legacyReview, setLegacyReview] = useState<{
    level: number;
    revision: number;
    mode: '' | 'drill' | 'live';
  } | null>(null);
  const [imported, setImported] = useState<ImportPreview | null>(null),
    [visits, setVisits] = useState<Visit[]>([]),
    [days, setDays] = useState(7);
  const [hours, setHours] = useState(4),
    [logFilter, setLogFilter] = useState('all'),
    [autoScroll, setAutoScroll] = useState(true);
  const alive = useRef(true),
    logEnd = useRef<HTMLDivElement>(null),
    busyRef = useRef(false);
  const draftsRef = useRef(drafts);
  const viewRef = useRef<View | null>(null);
  const loadSequence = useRef(0);
  draftsRef.current = drafts;
  sessionDrafts.set(api, drafts);
  const accept = (next: View, rebaseRevision?: number, stopped = false): void => {
    if (!alive.current) return;
    const current = viewRef.current;
    if (current && next.status.revision < current.status.revision) return;
    const canRebase =
      current?.status.revision === rebaseRevision &&
      JSON.stringify({
        ...current?.config,
        dryRun: next.config.dryRun,
        autoTrigger: next.config.autoTrigger,
      }) === JSON.stringify(next.config);
    viewRef.current = next;
    setView(next);
    setDrafts((previous) =>
      Object.fromEntries(
        (['rules', 'targets', 'history'] as const).map((key) => [
          key,
          previous[key]?.dirty
            ? {
                ...previous[key],
                config: stopped ? { ...previous[key].config, autoTrigger: false } : previous[key].config,
                revision:
                  canRebase && previous[key].revision === rebaseRevision
                    ? next.status.revision
                    : previous[key].revision,
              }
            : { config: structuredClone(next.config), revision: next.status.revision, dirty: false },
        ]),
      ),
    );
  };
  const load = async (afterCommand = false): Promise<void> => {
    if (busyRef.current && !afterCommand) return;
    const sequence = ++loadSequence.current;
    try {
      const next = await api.view();
      if (sequence === loadSequence.current) accept(next);
    } catch {
      if (alive.current && sequence === loadSequence.current)
        setError('无法连接 Cicada 宿主，请检查插件是否启用。');
    }
  };
  useEffect(() => {
    alive.current = true;
    void load();
    const timer = setInterval(() => {
      if (!busyRef.current) void load();
    }, 3000);
    return () => {
      alive.current = false;
      loadSequence.current++;
      clearInterval(timer);
    };
  }, [api]);
  useEffect(() => {
    const beforeUnload = (event: BeforeUnloadEvent): void => {
      if (Object.values(draftsRef.current).some((d) => d?.dirty)) {
        event.preventDefault();
        event.returnValue = '';
      }
    };
    window.addEventListener('beforeunload', beforeUnload);
    return () => window.removeEventListener('beforeunload', beforeUnload);
  }, []);
  useEffect(() => {
    if (autoScroll && page === 'logs') logEnd.current?.scrollIntoView({ block: 'nearest' });
  }, [view?.logs.length, page, autoScroll]);
  useEffect(() => {
    if (!confirmation && !legacyReview) return;
    const previous = document.activeElement as HTMLElement | null;
    const keydown = (event: KeyboardEvent): void => {
      if (event.key === 'Escape' && !busyRef.current) {
        setConfirmation(null);
        setLegacyReview(null);
      }
      if (event.key !== 'Tab') return;
      const nodes = [
        ...document.querySelectorAll<HTMLElement>(
          '.ci-modal button:not(:disabled), .ci-modal input:not(:disabled), .ci-modal select:not(:disabled)',
        ),
      ];
      const first = nodes[0],
        last = nodes.at(-1);
      if (event.shiftKey && document.activeElement === first) {
        event.preventDefault();
        last?.focus();
      } else if (!event.shiftKey && document.activeElement === last) {
        event.preventDefault();
        first?.focus();
      }
    };
    document.addEventListener('keydown', keydown);
    return () => {
      document.removeEventListener('keydown', keydown);
      previous?.focus();
    };
  }, [confirmation, legacyReview?.level]);
  const perform = async (task: () => Promise<unknown>, success = ''): Promise<void> => {
    if (busyRef.current) return;
    busyRef.current = true;
    loadSequence.current++;
    setWorking(true);
    setError('');
    setNotice('');
    try {
      await task();
      if (alive.current) {
        await load(true);
        setNotice(success);
      }
    } catch (e) {
      if (alive.current) setError(e instanceof Error ? e.message : '操作未完成，草稿已保留。');
    } finally {
      busyRef.current = false;
      if (alive.current) setWorking(false);
    }
  };
  const edit = (section: SaveRequest['section'], update: (config: Draft['config']) => void): void =>
    setDrafts((previous) => {
      const draft = previous[section];
      if (!draft) return previous;
      const config = structuredClone(draft.config);
      update(config);
      if (JSON.stringify(config) === JSON.stringify(draft.config)) return previous;
      return { ...previous, [section]: { ...draft, config, dirty: true } };
    });
  const save = (section: SaveRequest['section']): void => {
    const draft = drafts[section];
    if (!draft) return;
    void perform(async () => {
      const next = await api.save({ section, config: draft.config, expectedRevision: draft.revision });
      setDrafts((previous) =>
        Object.fromEntries(
          (['rules', 'targets', 'history'] as const).map((key) => [
            key,
            // A successful submission only clears the exact draft that was sent.
            previous[key]?.dirty &&
            (key !== section || JSON.stringify(previous[key].config) !== JSON.stringify(draft.config))
              ? {
                  ...previous[key]!,
                  revision:
                    previous[key]!.revision === draft.revision
                      ? next.status.revision
                      : previous[key]!.revision,
                }
              : { config: structuredClone(next.config), revision: next.status.revision, dirty: false },
          ]),
        ),
      );
      accept(next);
    }, '设置已保存');
  };
  const prepare = (kind: 'live' | 'authorize' | 'execute'): void => {
    void perform(async () => {
      setConfirmation(await api.prepare(kind));
      setPhrase('');
    });
  };
  const stopAutomation = (): void => {
    const revision = view?.status.revision;
    void perform(async () => {
      accept(await api.stopAutomation(), revision, true);
    }, '自动触发已关闭，未开始任务已取消');
  };
  const abandon = (section: SaveRequest['section']): void => {
    if (!view) return;
    setDrafts((previous) => ({
      ...previous,
      [section]: { config: structuredClone(view.config), revision: view.status.revision, dirty: false },
    }));
  };
  const saveBar = (section: SaveRequest['section']): ReactNode => (
    <div className="ci-savebar">
      <span>{drafts[section]?.dirty ? '有未保存的修改' : '已与宿主同步'}</span>
      <Button
        title="重新加载本页，放弃草稿"
        onClick={() => {
          if (!drafts[section]?.dirty || window.confirm('放弃本页未保存的修改？')) abandon(section);
        }}
        disabled={working}
      >
        <RefreshCw size={15} />
        重新加载
      </Button>
      <Button
        className="ci-primary"
        onClick={() => save(section)}
        disabled={working || !drafts[section]?.dirty || !view?.status.writable || view.status.busy}
      >
        <Save size={15} />
        保存
      </Button>
    </div>
  );
  if (!view)
    return (
      <div className="cicada ci-loading">
        {error ? (
          <>
            <AlertTriangle />
            {error}
            <Button onClick={() => void load()}>
              <RefreshCw size={16} />
              重试
            </Button>
          </>
        ) : (
          <>
            <LoaderCircle className="ci-spin" />
            连接 Cicada…
          </>
        )}
      </div>
    );
  const status = view.status,
    disabled = working || !status.writable;
  const rule = drafts.rules?.config ?? view.config,
    targets = drafts.targets?.config ?? view.config,
    history = drafts.history?.config ?? view.config;
  const visibleLogs = view.logs.filter((v) => logFilter === 'all' || v.level === logFilter);
  return (
    <div className="cicada" lang="zh-CN">
      <header className="ci-header">
        <div className="ci-brand">
          <div className="ci-mark">
            <ShieldCheck size={24} />
          </div>
          <div>
            <h1>
              蝉蜕 <span>Cicada</span>
            </h1>
            <p>最后打卡 {formatDate(status.lastCheckin)}</p>
          </div>
        </div>
        <div className="ci-header-status">
          <span className={`ci-badge ${status.dryRun ? 'ci-green' : 'ci-red'}`}>
            {status.dryRun ? '演练模式' : '真实模式'}
          </span>
          <span className="ci-badge">{status.autoTrigger ? '自动触发开启' : '自动触发关闭'}</span>
          <button className="ci-icon" title="刷新状态" aria-label="刷新状态" onClick={() => void load()}>
            <RefreshCw size={17} />
          </button>
        </div>
      </header>
      <nav className="ci-tabs" role="tablist">
        {pages.map(({ id, name, icon: Icon }) => (
          <button
            role="tab"
            aria-selected={page === id}
            key={id}
            className={page === id ? 'active' : ''}
            onClick={() => setPage(id)}
          >
            <Icon size={16} />
            {name}
            {drafts[id as SaveRequest['section']]?.dirty && <span className="ci-dirty" aria-label="未保存" />}
          </button>
        ))}
      </nav>
      {error && (
        <div className="ci-banner ci-error" role="alert">
          <AlertTriangle size={17} />
          <span>{error}</span>
          <button className="ci-icon" aria-label="关闭错误" onClick={() => setError('')}>
            <X size={16} />
          </button>
        </div>
      )}
      {notice && (
        <div className="ci-banner ci-success" role="status">
          <Check size={17} />
          {notice}
        </div>
      )}
      {status.blocked && (
        <div className="ci-banner ci-warning">
          <AlertTriangle size={17} />
          {status.blocked}
        </div>
      )}
      {page === 'overview' && (
        <main className="ci-body">
          <section className="ci-overview">
            <div className="ci-count">
              <span className="ci-eyebrow">距上次打卡</span>
              <div>
                <strong>{status.silenceDays.toFixed(2)}</strong>
                <span>天</span>
              </div>
              <span className="ci-current">
                当前等级 L{status.level}
                {status.pausedUntil ? ` · 暂停至 ${formatDate(status.pausedUntil)}` : ''}
              </span>
            </div>
            <div className="ci-overview-actions">
              <Button
                className="ci-primary"
                onClick={() => void perform(() => api.checkin(), '打卡成功，计时已重置')}
                disabled={disabled}
              >
                <Check size={18} />
                现在打卡
              </Button>
              <div className="ci-inline">
                <select
                  aria-label="暂停时长"
                  value={hours}
                  onChange={(e) => setHours(Number(e.target.value))}
                >
                  {[1, 4, 8, 24].map((h) => (
                    <option key={h} value={h}>
                      {h} 小时
                    </option>
                  ))}
                </select>
                <Button
                  onClick={() => void perform(() => (status.pausedUntil ? api.resume() : api.pause(hours)))}
                  disabled={disabled}
                >
                  {status.pausedUntil ? <Play size={16} /> : <Pause size={16} />}
                  {status.pausedUntil ? '恢复' : '暂停'}
                </Button>
              </div>
              <Button
                onClick={() => void perform(() => api.drill(), '演练已排队')}
                disabled={disabled || status.busy}
              >
                <FlaskConical size={16} />
                立即演练
              </Button>
              {status.autoTrigger && (
                <Button onClick={stopAutomation} disabled={disabled}>
                  <ShieldOff size={16} />
                  关闭自动触发
                </Button>
              )}
            </div>
          </section>
          {status.reminderPending && (
            <div className="ci-banner ci-warning">
              <Clock3 size={17} />
              今日尚未打卡
              <Button onClick={() => void perform(() => api.checkin(), '打卡成功')} disabled={disabled}>
                打卡
                <ChevronRight size={15} />
              </Button>
            </div>
          )}
          <section className="ci-section">
            <h2>等级时间轴</h2>
            <div className="ci-timeline">
              {view.config.levels.map((day, i) => (
                <div key={i} className={`ci-level ${status.level > i ? 'reached' : ''}`}>
                  <span className="ci-level-node">L{i + 1}</span>
                  <strong>{day} 天</strong>
                  <span>
                    {['浏览数据清理与补位', '少量假历史注入', '文件粉碎与痕迹清理', '指定软件卸载'][i]}
                  </span>
                </div>
              ))}
            </div>
            <div className="ci-meta">
              <Clock3 size={15} />
              {status.nextLevel
                ? `距 L${status.nextLevel} 阈值 ${status.remainingDays!.toFixed(2)} 天`
                : '已达到最高等级阈值'}
              <span>{status.busy ? '动作执行中' : status.autoTrigger ? '监控中' : '仅统计时间'}</span>
            </div>
          </section>
          <section className="ci-section">
            <div className="ci-section-head">
              <h2>最近执行</h2>
              <button className="ci-link" onClick={() => setPage('logs')}>
                全部记录
                <ChevronRight size={14} />
              </button>
            </div>
            {view.runs.length ? (
              <div className="ci-run-list">
                {view.runs.slice(0, 5).map((run) => (
                  <div className="ci-run" key={run.id}>
                    <FlaskConical size={17} />
                    <span>
                      <strong>
                        {run.source === 'legacy' ? '旧版核查 · ' : ''}
                        {run.mode === 'live' ? '真实执行' : '演练'} · L{run.level}
                      </strong>
                      <small>{formatDate(run.createdAt)}</small>
                    </span>
                    <span
                      className={`ci-badge ${run.state === 'interrupted' || run.state === 'failed' ? 'ci-red' : ''}`}
                    >
                      {runLabels[run.state]}
                    </span>
                  </div>
                ))}
              </div>
            ) : (
              <p className="ci-empty">暂无执行记录</p>
            )}
          </section>
          <section className="ci-section ci-mode">
            <div>
              <h2>运行模式</h2>
              <span>{status.authorized ? '已授权无人值守真实执行' : '尚未授权无人值守真实执行'}</span>
            </div>
            <Button
              onClick={() =>
                status.dryRun
                  ? prepare('live')
                  : void perform(async () => {
                      accept(await api.safeMode(), status.revision, true);
                    }, '已切回演练')
              }
              disabled={disabled || (status.dryRun && status.busy)}
            >
              {status.dryRun ? <ShieldOff size={16} /> : <ShieldCheck size={16} />}
              {status.dryRun ? '切换真实模式' : '切回演练'}
            </Button>
            {!status.dryRun && (
              <Button danger onClick={() => prepare('authorize')} disabled={disabled || status.busy}>
                授权自动触发
              </Button>
            )}
          </section>
        </main>
      )}
      {page === 'rules' && (
        <main className="ci-body">
          <section className="ci-section">
            <h2>分级阈值</h2>
            <div className="ci-thresholds">
              {rule.levels.map((day, i) => (
                <label key={i}>
                  L{i + 1}
                  <div className="ci-number">
                    <input
                      aria-label={`L${i + 1} 天数`}
                      type="number"
                      step="0.1"
                      min="0.001"
                      value={day}
                      onChange={(e) =>
                        edit('rules', (c) => {
                          c.levels[i] = Number(e.target.value);
                        })
                      }
                    />
                    <span>天</span>
                  </div>
                </label>
              ))}
            </div>
          </section>
          <section className="ci-section">
            <h2>等级动作</h2>
            <div className="ci-toggle-grid">
              {Object.entries(actionLabels).map(([key, label]) => (
                <Toggle
                  key={key}
                  label={label}
                  checked={rule.actions[key as keyof typeof rule.actions]}
                  onChange={(value) =>
                    edit('rules', (c) => {
                      c.actions[key as keyof typeof c.actions] = value;
                    })
                  }
                />
              ))}
            </div>
          </section>
          <section className="ci-section">
            <h2>监控与提醒</h2>
            <Toggle
              label="自动触发"
              checked={rule.autoTrigger}
              disabled={
                disabled || (!status.dryRun && !rule.autoTrigger) || (status.busy && !status.autoTrigger)
              }
              onChange={(value) => {
                if (!value && status.autoTrigger) stopAutomation();
                else
                  edit('rules', (c) => {
                    c.autoTrigger = value;
                  });
              }}
            />
            <Toggle
              label="每日打卡提醒"
              checked={rule.reminderEnabled}
              onChange={(value) =>
                edit('rules', (c) => {
                  c.reminderEnabled = value;
                })
              }
            />
            <label className="ci-form-row">
              提醒时间
              <select
                aria-label="提醒时间"
                value={rule.reminderHour}
                onChange={(e) =>
                  edit('rules', (c) => {
                    c.reminderHour = Number(e.target.value);
                  })
                }
              >
                {Array.from({ length: 24 }, (_, i) => (
                  <option key={i} value={i}>
                    {String(i).padStart(2, '0')}:00
                  </option>
                ))}
              </select>
            </label>
          </section>
          {saveBar('rules')}
        </main>
      )}
      {page === 'targets' && (
        <main className="ci-body">
          <section className="ci-section">
            <h2>浏览器</h2>
            <div className="ci-toggle-grid">
              {(['chrome', 'edge'] as const).map((id) => (
                <Toggle
                  key={id}
                  label={id === 'chrome' ? 'Google Chrome' : 'Microsoft Edge'}
                  checked={targets.browsers[id]}
                  onChange={(value) =>
                    edit('targets', (c) => {
                      c.browsers[id] = value;
                    })
                  }
                />
              ))}
            </div>
          </section>
          <section className="ci-section">
            <h2>敏感目标</h2>
            {(
              [
                { key: 'folders', name: '待粉碎文件夹' },
                { key: 'apps', name: '待卸载软件' },
                { key: 'keywords', name: '浏览记录关键词' },
              ] as const
            ).map(({ key, name }) => (
              <label className="ci-text-field" key={key}>
                <span>
                  {name}
                  <small>{targets.targets[key].length} 项</small>
                </span>
                <textarea
                  aria-label={name}
                  rows={4}
                  value={targets.targets[key].join('\n')}
                  onChange={(e) =>
                    edit('targets', (c) => {
                      c.targets[key] = e.target.value.split('\n');
                    })
                  }
                  onBlur={() =>
                    edit('targets', (c) => {
                      c.targets[key] = c.targets[key].map((v) => v.trim()).filter(Boolean);
                    })
                  }
                />
              </label>
            ))}
          </section>
          {saveBar('targets')}
          <section className="ci-section">
            <h2>旧版数据</h2>
            <Button
              onClick={() =>
                void perform(async () => {
                  setImported(await api.importPreview());
                })
              }
              disabled={disabled}
            >
              <ArrowDownToLine size={16} />
              预览旧版导入
            </Button>
            {imported && (
              <div className="ci-import">
                <p>
                  上次打卡 {formatDate(imported.lastCheckin)} · 待核查旧等级{' '}
                  {imported.executedLevels.map((level) => `L${level}`).join('、') || '无'}
                </p>
                <p>
                  文件夹 {imported.config.targets.folders.length} 项 · 软件{' '}
                  {imported.config.targets.apps.length} 项 · 关键词 {imported.config.targets.keywords.length}{' '}
                  项
                </p>
                <details className="ci-details">
                  <summary>导入配置明细</summary>
                  <p>
                    阈值：{imported.config.levels.join(' / ')} 天 · 人设：
                    {personaLabels[imported.config.persona]}
                  </p>
                  {Object.entries(imported.config.actions).map(([key, value]) => (
                    <p key={key}>
                      {actionLabels[key]}：{value ? '开启' : '关闭'}
                    </p>
                  ))}
                  {(['folders', 'apps', 'keywords'] as const).map((key) => (
                    <p key={key}>
                      {{ folders: '文件夹', apps: '软件', keywords: '关键词' }[key]}：
                      {imported.config.targets[key].join('；') || '无'}
                    </p>
                  ))}
                </details>
                {imported.warnings.map((w) => (
                  <p key={w}>{w}</p>
                ))}
                <Button
                  onClick={() =>
                    void perform(async () => {
                      setConfirmation(await api.prepareImport());
                      setPhrase('');
                    })
                  }
                  disabled={disabled}
                >
                  <ArrowDownToLine size={16} />
                  确认导入副本
                </Button>
              </div>
            )}
          </section>
          <section className="ci-section ci-danger-zone">
            <h2>
              <AlertTriangle size={18} />
              危险操作
            </h2>
            <p>使用已保存配置真实执行 L1 → L4。该操作不受演练模式保护，可能不可逆。</p>
            <Button
              danger
              onClick={() => prepare('execute')}
              disabled={disabled || status.busy || status.secretError}
            >
              <Trash2 size={16} />
              全流程真实执行
            </Button>
          </section>
        </main>
      )}
      {page === 'history' && (
        <main className="ci-body">
          <section className="ci-section">
            <h2>假历史人设</h2>
            <div className="ci-personas">
              {Object.entries(personaLabels).map(([id, label]) => (
                <label key={id} className={history.persona === id ? 'selected' : ''}>
                  <input
                    type="radio"
                    name="persona"
                    value={id}
                    checked={history.persona === id}
                    onChange={() =>
                      edit('history', (c) => {
                        c.persona = id as Persona;
                      })
                    }
                  />
                  <span>{label}</span>
                </label>
              ))}
            </div>
          </section>
          {saveBar('history')}
          <section className="ci-section">
            <div className="ci-section-head">
              <h2>访问记录预览</h2>
              <div className="ci-inline">
                <select aria-label="预览天数" value={days} onChange={(e) => setDays(Number(e.target.value))}>
                  {[2, 7, 14, 30].map((n) => (
                    <option key={n} value={n}>
                      {n} 天
                    </option>
                  ))}
                </select>
                <Button
                  onClick={() =>
                    void perform(async () => {
                      setVisits(await api.preview(history.persona, days));
                    })
                  }
                  disabled={working}
                >
                  <RefreshCw size={15} />
                  生成预览
                </Button>
              </div>
            </div>
            <div className="ci-table-wrap">
              <table>
                <thead>
                  <tr>
                    <th>时间</th>
                    <th>站点与标题</th>
                    <th>停留</th>
                  </tr>
                </thead>
                <tbody>
                  {visits.map((visit, i) => (
                    <tr key={i}>
                      <td>{formatDate(visit.at)}</td>
                      <td>
                        <strong>{visit.title}</strong>
                        <span className="ci-url">{visit.url}</span>
                      </td>
                      <td>{visit.dwellSeconds} 秒</td>
                    </tr>
                  ))}
                </tbody>
              </table>
              {!visits.length && <p className="ci-empty">暂无预览记录</p>}
            </div>
          </section>
        </main>
      )}
      {page === 'logs' && (
        <main className="ci-body">
          {view.legacyLevels.length > 0 && (
            <section className="ci-section">
              <h2>旧版记录核查</h2>
              <div className="ci-inline">
                {view.legacyLevels.map((level) => (
                  <Button
                    key={level}
                    disabled={disabled || status.busy}
                    onClick={() => {
                      setLegacyReview({ level, revision: status.revision, mode: '' });
                      setPhrase('');
                    }}
                  >
                    <FileClock size={16} />
                    核查 L{level}
                  </Button>
                ))}
              </div>
            </section>
          )}
          <section className="ci-section">
            <div className="ci-section-head">
              <h2>
                运行日志 <span className="ci-muted">{visibleLogs.length}</span>
              </h2>
              <div className="ci-inline">
                <select
                  aria-label="日志等级"
                  value={logFilter}
                  onChange={(e) => setLogFilter(e.target.value)}
                >
                  <option value="all">全部等级</option>
                  <option value="info">信息</option>
                  <option value="warning">警告</option>
                  <option value="error">错误</option>
                </select>
                <label className="ci-checkbox">
                  <input
                    type="checkbox"
                    checked={autoScroll}
                    onChange={(e) => setAutoScroll(e.target.checked)}
                  />
                  自动滚动
                </label>
              </div>
            </div>
            <div className="ci-log" role="log">
              {visibleLogs.length ? (
                visibleLogs.map((log) => (
                  <div key={log.id} className={`ci-log-line ${log.level}`}>
                    <time>{formatDate(log.at)}</time>
                    <span>{log.level.toUpperCase()}</span>
                    <p>{log.text}</p>
                  </div>
                ))
              ) : (
                <p className="ci-empty">暂无日志</p>
              )}
              <div ref={logEnd} />
            </div>
          </section>
          <section className="ci-section">
            <h2>执行明细</h2>
            {view.runs.map((run) => (
              <details key={run.id} className="ci-details">
                <summary>
                  <FileClock size={16} />
                  <span>
                    {run.source === 'legacy' ? '旧版核查 · ' : ''}
                    {run.mode === 'live' ? '真实' : '演练'} L{run.level} · {formatDate(run.createdAt)}
                  </span>
                  <span className="ci-badge">{runLabels[run.state]}</span>
                </summary>
                {run.steps.map((step, i) => (
                  <p key={i}>
                    {step.action} · {step.status} · {step.count} 项 · {step.detail}
                  </p>
                ))}
                {run.state === 'interrupted' && (
                  <Button
                    danger
                    onClick={() => {
                      const text = window.prompt(
                        '请先人工核查实际动作结果。输入「已核查中断动作」后，该等级保持不自动重试。',
                      );
                      if (text) void perform(() => api.resolveInterrupted(run.id, text));
                    }}
                    disabled={disabled}
                  >
                    已人工核查
                  </Button>
                )}
              </details>
            ))}
          </section>
        </main>
      )}
      {working && (
        <div className="ci-working" role="status">
          <LoaderCircle size={15} className="ci-spin" />
          处理中
        </div>
      )}
      {legacyReview && (
        <div className="ci-modal-backdrop">
          <div className="ci-modal" role="dialog" aria-modal="true" aria-labelledby="ci-legacy-title">
            <header>
              <h2 id="ci-legacy-title">
                <FileClock size={20} />
                旧版 L{legacyReview.level} 核查
              </h2>
              <button
                className="ci-icon"
                aria-label="取消核查"
                disabled={working}
                onClick={() => setLegacyReview(null)}
              >
                <X size={19} />
              </button>
            </header>
            <p>旧记录未保存执行模式。核查只记录结论，不执行动作；自动触发保持关闭。</p>
            <label className="ci-text-field">
              <span>核查结论</span>
              <select
                aria-label="旧记录核查结论"
                autoFocus
                value={legacyReview.mode}
                disabled={working}
                onChange={(e) => {
                  setLegacyReview({ ...legacyReview, mode: e.target.value as '' | 'drill' | 'live' });
                  setPhrase('');
                }}
              >
                <option value="">请选择</option>
                <option value="drill">仅为演练，恢复真实执行资格</option>
                <option value="live">已有真实执行，本周期不重试</option>
              </select>
            </label>
            {legacyReview.mode && (
              <label className="ci-text-field">
                <span>输入「{legacyReview.mode === 'drill' ? '已核查仅为演练' : '已核查真实执行'}」</span>
                <input
                  aria-label="旧记录核查文字"
                  value={phrase}
                  disabled={working}
                  onChange={(e) => setPhrase(e.target.value)}
                />
              </label>
            )}
            <div className="ci-modal-actions">
              <Button disabled={working} onClick={() => setLegacyReview(null)}>
                取消
              </Button>
              <Button
                disabled={
                  working ||
                  !legacyReview.mode ||
                  phrase !== (legacyReview.mode === 'drill' ? '已核查仅为演练' : '已核查真实执行')
                }
                onClick={() => {
                  if (!legacyReview.mode) return;
                  const { level, mode, revision } = legacyReview;
                  void perform(async () => {
                    accept(await api.resolveLegacy(level, mode, phrase, revision), revision, true);
                    setLegacyReview(null);
                  }, '旧版记录已核查，自动触发保持关闭');
                }}
              >
                <Check size={16} />
                确认核查
              </Button>
            </div>
          </div>
        </div>
      )}
      {confirmation && (
        <div className="ci-modal-backdrop">
          <div className="ci-modal" role="dialog" aria-modal="true" aria-labelledby="ci-confirm-title">
            <header>
              <h2 id="ci-confirm-title">
                <AlertTriangle size={20} />
                人工确认
              </h2>
              <button
                className="ci-icon"
                aria-label="取消确认"
                onClick={() => setConfirmation(null)}
                disabled={working}
              >
                <X size={19} />
              </button>
            </header>
            <pre>{confirmation.summary}</pre>
            <label className="ci-text-field">
              <span>输入「我确认」</span>
              <input
                autoFocus
                aria-label="确认文字"
                value={phrase}
                onChange={(e) => setPhrase(e.target.value)}
              />
            </label>
            <div className="ci-modal-actions">
              <Button onClick={() => setConfirmation(null)} disabled={working}>
                取消
              </Button>
              <Button
                danger
                disabled={phrase !== '我确认' || working || confirmation.expiresAt < Date.now()}
                onClick={() => {
                  if (
                    confirmation.kind === 'import' &&
                    Object.values(draftsRef.current).some((draft) => draft?.dirty) &&
                    !window.confirm('导入将替换已保存配置，并放弃所有分区的未保存修改。继续导入？')
                  )
                    return;
                  void perform(async () => {
                    const next = await api.confirm({ token: confirmation.token, phrase });
                    setConfirmation(null);
                    setImported(null);
                    if (confirmation.kind === 'import') {
                      setDrafts({});
                      setVisits([]);
                      accept(next);
                    } else accept(next, confirmation.revision);
                  }, '操作已确认');
                }}
              >
                <Check size={16} />
                确认
              </Button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
