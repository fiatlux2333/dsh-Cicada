# 开发与验证

## 环境准备

- Windows，Node.js **24.9+**，pnpm **12.15.0**。
- 运行集成验收需要官方 DeepSeek Harness **0.2.2-rc.1**。不使用其他版本的接口代替兼容性验证。
- Playwright 配置使用本机 Microsoft Edge 的临时浏览器上下文，不使用日常浏览器 profile。

从仓库根目录执行：

```powershell
pnpm install --frozen-lockfile
pnpm compat:check
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
| `pnpm test:harness`  | 自行创建、核验并关闭官方隔离 Host，验收本机 Web   |
| `pnpm build`         | 生成 Host、Client 和协议产物                      |
| `pnpm pack:plugin`   | 构建并生成 `dist/dsh-cicada-0.1.2.tgz`            |
| `pnpm check:package` | 核对包清单、共享依赖、产物一致性并生成 SHA256     |
| `pnpm dev`           | 在 `http://127.0.0.1:4178/` 启动合成数据预览      |

合成 UI 测试自行启动本项目 4178 端口服务，不复用已有实例；端口占用会失败，不会停止冲突服务。预览禁止真实确认，不代表实际 Harness 集成已通过。

## 官方集成约定

- 生命周期使用 Cordis `Service`、`inject` 与 `ctx.effect`，卸载等待在途动作和存储结束。
- 通过 `dsh.bundle.patch` 安装，根包行声明 `dsh.client`，管理页挂载到 `plugins.bundle.config`。
- Host 与 Client 使用构建时生成的严格 Typert 约定；发布 `./typert`、`./remote`，不依赖源码模式弱校验回退。
- 客户端先 `$mount(TYPERT_REMOTE)`，再通过 `ctx.inject(['remote.cicada'])` 使用服务。
- 浏览器产物遵循官方 lazy-CJS factory 协议，共享宿主 React 等基础模块；不是普通 Vite/ESM 页面。
- 依赖宿主共享实例的官方包声明为 peer 依赖。生产插件不自建 HTTP 服务。
- 协议生成器的项目发现通过忽略的声明镜像适配，镜像只复制官方发布类型，不修改已安装依赖，不进入分发包。

接口依据见[项目首页的官方文档链接](../README.md#官方依据)。社区指南仅作补充。

`pnpm compat:check` 检查本机版本、官方 SDK/peer 声明和实际安装依赖，并读取官方 SDK/生成器自身的 Cordis peer 要求及解析版本，不修改 profile；无本机宿主的 CI 使用 `--sdk-only`。当前 SDK 锁定 `0.2.2-rc.1`，Cordis 使用 `~4.1.0`。新宿主适配流程见[宿主升级方案](compatibility.md)。

[Windows CI](https://github.com/fiatlux2333/dsh-Cicada/actions/workflows/compatibility.yml) 在 push、PR 和手工触发时执行 Windows 合成回归；不登录账号、不启动日常 profile、不进行真实破坏性操作。实际结果以对应提交的工作流运行记录为准，不能把本地 YAML 检查当作已运行的 CI。

## 测试边界

业务测试只使用临时目录、内存时钟、合成浏览器数据库和系统动作替身。新增测试不得清理真实浏览器、粉碎用户文件、卸载软件或清除系统日志。重点保留以下回归：

- 周期和配置版本绑定、并发请求、离线跨级、暂停到期、时钟回拨与重启补执行。
- 开始前持久化、未开始任务取消、执行中崩溃、完成写入失败及不确定动作不重放。
- 停止写入失败的运行时锁定与显式重试恢复。
- 密文缺失、DPAPI 替身失败、重复宿主与租约失效。
- 浏览器关联表、孤立/混合聚类、敏感标签及关键词、事务回滚和恢复备份；路径及硬链接边界、Unicode 卸载名称和歧义拒绝。
- 官方 peer 元数据替身、共享 Core 解析版本，隔离宿主身份替身及正常关闭的无害 Node IPC 子进程。
- 严格 Remote 输入和所有者权限；模型工具无法进入危险路径。
- 草稿保留、保存中继续编辑、乱序刷新、确认和导入核查。

`scripts/check-windows-safe.ts` 和 `scripts/check-monitor-loss.mjs` 会调用真实 DPAPI、测试辅助进程及固定 HKCU 监控身份元数据，不是纯 mock 测试。不得在未确认监控所有者的情况下运行。

## 自建隔离宿主验收

先完成打包和内容检查，再运行：

```powershell
pnpm test:harness
# CLI 不在 PATH 或有多个安装时，显式选择官方 Desktop 安装：
pnpm test:harness --desktop-exe 'D:\dsh\DeepSeek Harness.exe'
```

`scripts/harness-ui.mjs` 不再接受 `CICADA_TEST_URL`，设置此旧变量会在创建或修改 profile 前拒绝运行。脚本在 `artifacts/harness-owned-*` 下新建 Home、Agent 根和工作区，移除继承的产品路径、模型凭据和 Node preload 环境，使用官方 CLI 模板、安装与启动入口，不修改安装文件。

宿主绑定 `127.0.0.1` 的系统分配端口，不打开用户浏览器。测试 URL 只来自自建进程的官方输出；Windows 固定脚本仅查询监听 PID，UI 修改前再次核验，宿主异常退出会关闭测试浏览器上下文。测试使用 Edge 的临时上下文，不登录账号、不调用模型，保持演练和自动触发关闭，只取消真实模式确认。

结束时经私有 IPC 发送官方有界关闭信号，等待退出后才移除该测试 profile 的插件。超时仅终止自建子进程并将本次验收判为失败；退出未确认则拒绝移除运行中插件。不会停止其他宿主，不递归删除隔离数据；截图和日志留在本次目录，不提交或上传。此入口要求本机 Windows 官方 Desktop CLI，CI 的合成 UI 不能替代它。最新结果与历史记录见[验证记录](verification.md)。

## 提交约定

只提交源码、配置、测试、文档和 `pnpm-lock.yaml`。不要提交安装包、EXE、依赖、恢复备份、浏览器数据库、截图、日志、隔离宿主数据或凭据。发布前检查暂存文件和敏感信息，核对远端与分支，不覆盖原 Cicada 仓库。

修改插件行为或适配 SDK 时同步更新[更新日志](../CHANGELOG.md)、[宿主升级方案](compatibility.md)与[验证记录](verification.md)。改变分发包 README 或第三方声明后重新打包和生成摘要；文档只引用实际执行的验证，不把历史结果当作本次结果。
