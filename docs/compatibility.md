# 宿主升级方案

## 当前配对

| 插件版本           | 对应 Harness | 状态                                                    |
| ------------------ | ------------ | ------------------------------------------------------- |
| `0.1.0`            | `0.2.1-rc.5` | 历史版本，不用于新宿主                                  |
| `0.1.1`            | `0.2.2-rc.1` | 首次迁移版本，后续审查修复见 `0.1.2`                    |
| `0.1.2`            | `0.2.2-rc.1` | 当前修复版本；具体验收范围见[验证记录](verification.md) |
| 其他 RC 或正式版本 | 未声明       | 必须先迁移和验收，不自动兼容                            |

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

- `engines.dsh` 与官方生成器目标版本一致。
- 全部官方 DSH SDK 的 peer 和 dev 版本一致，共享 peer 有对应开发声明。
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
2. 修改根 `package.json` 的 Typert 生成器版本、分发包全部官方 SDK 的 peer/dev 版本及 Cordis 范围，使其来自同一个官方版本。将 `engines.dsh` 指向本次待验收目标，不开放未来 RC。
3. **递增插件版本**，更新锁文件。首次更新依赖使用 `pnpm install --registry=https://registry.npmjs.org`；后续验证使用 `--frozen-lockfile`。
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

## CI 与边界

`.github/workflows/compatibility.yml` 在提交到 `main`、PR 和手工触发时运行 Windows 验证：冻结锁文件安装、SDK 预检、类型/业务回归、合成 UI、构建打包和内容检查。失败截图只来自合成界面，不上传真实 profile 或凭据。

CI 结果以[工作流运行记录](https://github.com/fiatlux2333/dsh-Cicada/actions/workflows/compatibility.yml)为准；本地验证和 YAML 检查不等于 GitHub CI 通过。本工作流不轮询官方版本、不自动改依赖、不安装到日常 profile，也不进行真实清理。新版宿主仍需维护者发起迁移与隔离验收，不能保证未来不再出现破坏性 API 变化。

本策略把升级故障变为可提前检查的明确拒绝和可复现的迁移流程，不承诺任意未来 Harness 版本自动兼容。
