# 宿主升级方案

## 当前配对

| 插件版本                  | 对应 Harness | 状态                                                    |
| ------------------------- | ------------ | ------------------------------------------------------- |
| `0.1.0`                   | `0.2.1-rc.5` | 历史版本，不用于新宿主                                  |
| `0.1.1`                   | `0.2.2-rc.1` | 首次迁移版本，后续审查修复见 `0.1.2`                    |
| `0.1.2`                   | `0.2.2-rc.1` | 当前修复版本；具体验收范围见[验证记录](verification.md) |
| `0.1.3-compat.0.2.2-rc.5` | `0.2.2-rc.5` | 演练候选，已通过本地构建和回归；Windows 宿主验收待完成  |
| 其他 RC 或正式版本        | 未声明       | 必须先迁移和验收，不自动兼容                            |

从 `0.2.1-rc.5` 升级到 `0.2.2-rc.1` 时，旧包被拒绝加载的直接原因是 `engines.dsh =0.2.1-rc.5` 不匹配新宿主。官方 `0.2.2-rc.1` 同时更新了 Cordis 到 `4.1.0`，并调整了工具、存储和插件管理相关实现。不能只把引擎范围改为 `*`，而继续混用旧生成器、SDK 或 peer 实例。插件版本变化见[更新日志](../CHANGELOG.md)。

官方依据：[发布说明](https://github.com/deepseek-ai/deepseek-harness/releases/tag/dsh-v0.2.2-rc.1)、[打包与安装](https://deepseek-harness.github.io/deepseek-harness/develop/basic/publish)、[API Gateway](https://deepseek-harness.github.io/deepseek-harness/reference/api-gateway)。官方也提供精确版本豁免，但 Cicada 有不可逆动作，本项目不自动授予或建议用豁免代替验收。

## 用户升级流程

1. **升级宿主前**，在 Cicada 关闭自动触发或切回演练，确认保存成功，等待当前动作完成，再停用插件并退出宿主。停止保存失败时不要重启。
2. 备份当前 profile 和加密领域数据，记录插件/宿主版本以及安装包 SHA256。备份可能含凭据，不提交 Git，也不发到聊天。
3. 获取与新宿主匹配的插件，先在隔离 `DSH_HOME` 与独立 profile 中验证，再更换日常 profile 的包。
4. 启动后核对计时、目标、模式、授权和中断记录。仅在确认安全范围后重新授权，不能假设重装会重置旧授权。
5. 不兼容或测试失败时保持停用。回退需使用匹配的旧宿主与旧插件，并先确认数据格式可读；不要直接降级已经发生不可逆迁移的数据。

**已经升级、旧插件无法打开时**：不要直接启用新版而赌旧授权状态。保留停用状态和原数据；可用匹配旧版的隔离恢复环境、同一 Windows 用户的备份副本先核查并保存停止状态，再有意恢复到目标 profile。DPAPI 不保证换用户或换机器仍可解密。无法安全分离状态时应保持停用并人工处理，不能把损坏或不可解密字段变为空值。

插件随宿主运行，不能在被拒绝加载期间继续监控；沉默时长按上次打卡继续累计。恢复后存在预授权就可能立即跨级补执行，这是升级前确认停止的重要原因。

## 版本预检

源码工作区提供只读检查：

```powershell
pnpm compat:check
```

检查本机 `dsh --version`，并核对以下内容：

- `engines.dsh` 可列出单个精确版本，或用 `||` 连接多个精确版本。列表必须包含构建 SDK 的版本。
- DSH 的运行时 peer 覆盖相同的宿主列表。所有开发 SDK 固定为生成器版本。Cordis 的 peer/dev 范围与官方包的约束分别校验。
- 实际安装的 SDK、Cordis 和生成器满足 manifest，避免旧 `node_modules` 混入。
- 读取实际安装的官方 SDK 和生成器 manifest，检查共享 Cordis 及它们自身解析到的 Cordis 满足官方 peer 范围，且版本一致。不能只让插件自己的 peer/dev 声明彼此一致。
- 未验收的宿主版本以非零退出码拒绝，不修改任何 profile 或豁免。

没有本机 Harness 的 CI 可运行：

```powershell
pnpm compat:check --sdk-only
pnpm compat:check --host-version 0.2.2-rc.1
```

`--host-version` 只检查提供的版本，不证明现场已安装该版本。所有预检都不证明 API 可用；必须继续类型检查、回归和实际宿主验收。

## 维护者迁移流程

1. 阅读官方新版本发布说明、插件文档和相应 npm 类型，确认 Cordis、Remote、存储、工具与客户端模块变化。
2. 在已冻结安装依赖的源码工作区运行 `pnpm compat:prepare <精确宿主版本>`。例如，`pnpm compat:prepare 0.2.2-rc.2` 会从官方 npm 读取该版本生成器的 Cordis peer 和存储 SDK 使用的 Zod 版本，在新的 `artifacts/compat-*` 目录同步 SDK、生成器、引擎和 peer 声明，更新锁文件、安装依赖并做预检。成功时最后一行给出工作目录。每次使用独立目录，失败步骤可在该目录重试。
3. 进入输出目录完成下面的检查。候选包版本带有 `-compat.` 后缀，其 Host 构建仅允许演练。正式发布需在源码中明确记录支持范围及插件版本，使用待交付的实际包另行验收。
4. 修复类型或行为冲突，重生成严格协议。生成器脚本会刷新声明镜像的旧依赖链接，不修改 Harness 安装或官方依赖源码。
5. 顺序执行以下命令，避免边构建边运行 Vite UI 验证：

```powershell
pnpm compat:check
pnpm check
pnpm test:ui
pnpm pack:plugin
pnpm check:package
```

6. 用新包运行 `pnpm test:harness`，验证安装、配置组合、真实加载、严格 Remote、五页、演练、停用/重载与卸载。脚本自行创建全新 `DSH_HOME`、Agent 根和 profile，从自建进程输出取得系统分配端口的 URL，并通过 Windows 监听 PID 核验；不接受已有宿主 URL 或复用旧隔离目录。退出确认后才移除测试插件，保留隔离证据。保持演练和自动触发关闭，不调用模型或真实系统动作；旧数据恢复与 Desktop 原生壳仍须另行验收。
7. 在验证记录注明测试版本、实际范围、剩余风险和新包摘要；实际 Desktop 与真实 Windows 行为仍需分别验收。确认后再交付，不以只通过编译为完成。

`scripts/check-package.mjs` 从当前 manifest 读取包名和版本，并逐字节核对包内 manifest 和产物；以后版本升级不再依赖写死的旧 tarball 名。

## Windows CI

提交到 `main`、PR 或留空版本手动运行时，工作流构建一次当前分发包，在每个声明支持的版本上安装并验收同一份 tarball。运行器把指定版本的官方 npm DSH CLI 装入临时目录，再核对实际进程报告的版本。每次启动都使用独立 profile、回环端口和演练配置，保留已有的监听 PID 及退出检查。

隔离环境保留 PowerShell 和 .NET 使用的 Windows 系统目录、用户身份与处理器变量。CI 在普通环境和隔离环境中分别检查 DPAPI、互斥锁排他、辅助进程丢失保护及旧所有者退出后的恢复，再运行实际宿主验收。监控辅助进程等待就绪的限时为 30 秒。失败时保留退出原因，并上传隔离宿主日志、截图及合成 UI 报告。

工作流更新进入默认分支后，可在 GitHub Actions 的 **Harness compatibility regression → Run workflow** 中填写 `host_version` 试配新版本。定时任务每天查询官方 npm 的 `@deepseek-ai/dsh@next`，用同一流程验证该候选版本。候选流程在临时工作区构建和运行，日常使用的支持范围以分发 manifest 为准。结果见[工作流运行记录](https://github.com/fiatlux2333/dsh-Cicada/actions/workflows/compatibility.yml)。

CI 验收 Windows 上的 Web 宿主。本机 Desktop 安装的 Web 模式仍可通过 `pnpm test:harness --desktop-exe <路径>` 验收。Desktop 原生窗口和真实 Windows 动作属于单独的验收范围。
