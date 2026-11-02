# 开发与验证

## 环境准备

- Windows，Node.js **24.9+**，pnpm **12.15.0**。
- 运行集成验收需要官方 DeepSeek Harness **0.2.1-rc.5**。不使用其他版本的接口代替兼容性验证。
- Playwright 配置使用本机 Microsoft Edge 的临时浏览器上下文，不使用日常浏览器 profile。

从仓库根目录执行：

```powershell
pnpm install --frozen-lockfile
pnpm check
pnpm test:ui
pnpm pack:plugin
pnpm check:package
```

`pnpm check` 包含两侧类型检查、业务测试和生产构建，不包含 UI 测试或安装包检查。`pnpm check:package` 需要已经生成安装包；它会核对包内容与当前构建，并写出摘要。修改文档后重新打包也会改变安装包摘要，不要沿用旧构建值。

## 目录结构

| 路径                                     | 职责                                                  |
| ---------------------------------------- | ----------------------------------------------------- |
| `packages/dsh-cicada/src/host/`          | 领域状态机、Cordis 服务、Remote、系统动作与存储接入   |
| `packages/dsh-cicada/src/client/`        | 五页管理界面、提醒与客户端挂载                        |
| `packages/dsh-cicada/src/shared/`        | 配置校验、共享类型、假历史生成                        |
| `packages/dsh-cicada/windows/bridge.ps1` | 固定 Windows 辅助操作、DPAPI 与互斥锁                 |
| `packages/dsh-cicada/cordis.patch.yml`   | 官方 bundle 配置补丁                                  |
| `scripts/`                               | 严格协议生成、构建、包检查与隔离验收脚本              |
| `tests/`                                 | 领域、系统替身、Remote 权限、导入、工具边界和 UI 回归 |
| `dev/`                                   | 不连接宿主的纯浏览器合成数据界面                      |
| `docs/`                                  | 使用、安全、开发与验证文档                            |

生成目录 `packages/*/lib/`、`packages/build-contracts/`、`dist/`、`artifacts/`、`test-results/` 及依赖目录均不提交。根 `THIRD_PARTY_NOTICES.md` 是声明源，构建时复制到分发包目录，该副本不单独提交。

## 常用命令

| 命令                 | 用途                                              |
| -------------------- | ------------------------------------------------- |
| `pnpm generate`      | 使用官方 Typert 生成严格 Host/Remote 约定         |
| `pnpm typecheck`     | 分别检查宿主和客户端，避免 Context 类型合并冲突   |
| `pnpm test`          | 使用内存存储、合成数据库和系统动作替身运行 Vitest |
| `pnpm test:ui`       | 使用 Edge 检查五页、主题、窄屏、草稿和确认流程    |
| `pnpm build`         | 生成 Host、Client 和协议产物                      |
| `pnpm pack:plugin`   | 构建并生成 `dist/dsh-cicada-0.1.0.tgz`            |
| `pnpm check:package` | 核对包清单、共享依赖、产物一致性并生成 SHA256     |
| `pnpm dev`           | 在 `http://127.0.0.1:4178/` 启动合成数据预览      |

UI 测试会复用 4178 端口已有服务；确认该端口确实是本项目合成预览，或先停止冲突服务再测试。预览禁止真实确认，不代表实际 Harness 集成已通过。

## 官方集成约定

- 生命周期使用 Cordis `Service`、`inject` 与 `ctx.effect`，卸载等待在途动作和存储结束。
- 通过 `dsh.bundle.patch` 安装，根包行声明 `dsh.client`，管理页挂载到 `plugins.bundle.config`。
- Host 与 Client 使用构建时生成的严格 Typert 约定；发布 `./typert`、`./remote`，不依赖源码模式弱校验回退。
- 客户端先 `$mount(TYPERT_REMOTE)`，再通过 `ctx.inject(['remote.cicada'])` 使用服务。
- 浏览器产物遵循官方 lazy-CJS factory 协议，共享宿主 React 等基础模块；不是普通 Vite/ESM 页面。
- 依赖宿主共享实例的官方包声明为 peer 依赖。生产插件不自建 HTTP 服务。
- 协议生成器的项目发现通过忽略的声明镜像适配，镜像只复制官方发布类型，不修改已安装依赖，不进入分发包。

接口依据见[项目首页的官方文档链接](../README.md#官方依据)。社区指南仅作补充。

## 测试边界

业务测试只使用临时目录、内存时钟、合成浏览器数据库和系统动作替身。新增测试不得清理真实浏览器、粉碎用户文件、卸载软件或清除系统日志。重点保留以下回归：

- 周期和配置版本绑定、并发请求、离线跨级、暂停到期、时钟回拨与重启补执行。
- 开始前持久化、未开始任务取消、执行中崩溃、完成写入失败及不确定动作不重放。
- 停止写入失败的运行时锁定与显式重试恢复。
- 密文缺失、DPAPI 替身失败、重复宿主与租约失效。
- 浏览器关联表和事务、恢复备份、路径及硬链接边界、卸载歧义拒绝。
- 严格 Remote 输入和所有者权限；模型工具无法进入危险路径。
- 草稿保留、保存中继续编辑、乱序刷新、确认和导入核查。

`scripts/check-windows-safe.ts` 和 `scripts/check-monitor-loss.mjs` 会调用真实 DPAPI、测试辅助进程及固定 HKCU 监控身份元数据，不是纯 mock 测试。`scripts/harness-ui.mjs` 会启用并修改指定隔离测试 profile 中的插件配置。只在明确隔离后运行，不能把这些脚本指向现有日常 profile。

实际 Harness 验收应将 `DSH_HOME`、`DSH_AGENTS_HOME` 指向工作区隔离目录，使用独立 profile，禁用遥测，Web 绑定回环地址；不登录账号、不调用模型，保持演练与自动触发关闭。完成后停止测试宿主并移除隔离 profile 中的插件，不修改现有 profile。最新结果与历史记录见[验证记录](verification.md)。

## 提交约定

只提交源码、配置、测试、文档和 `pnpm-lock.yaml`。不要提交安装包、EXE、依赖、恢复备份、浏览器数据库、截图、日志、隔离宿主数据或凭据。发布前检查暂存文件和敏感信息，核对远端与分支，不覆盖原 Cicada 仓库。
