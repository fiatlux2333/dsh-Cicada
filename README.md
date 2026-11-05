# Cicada for DeepSeek Harness

[![Windows CI](https://github.com/fiatlux2333/dsh-Cicada/actions/workflows/compatibility.yml/badge.svg)](https://github.com/fiatlux2333/dsh-Cicada/actions/workflows/compatibility.yml)

将 [Cicada](https://github.com/fiatlux2333/Cicada) 的打卡监控与隐私维护功能重新实现为 DeepSeek Harness 原生插件。使用 TypeScript，不依赖 Python，不修改原项目或 Harness 安装文件。

> **当前版本：0.1.2，尚未完成全部真实 Windows 行为验收。** 首次安装为演练模式，自动触发关闭。真实动作可能不可逆，请先阅读[安全与行为](docs/safety.md)，并在具有可恢复快照的虚拟机中验收。

## 兼容范围

| 项目     | 要求                                          |
| -------- | --------------------------------------------- |
| 系统     | 本机 Windows                                  |
| 宿主     | DeepSeek Harness **0.2.2-rc.1**，精确版本约束 |
| 运行时   | Node.js **24.9+**                             |
| 客户端   | 本机 Desktop / 本机 Web，不包含远程管理       |
| 浏览器   | Chrome、Edge                                  |
| 源码开发 | pnpm **12.15.0**；UI 测试需要 Microsoft Edge  |

插件随 Harness 运行，不安装独立服务、开机任务或后台守护程序。关闭宿主期间不执行动作，但沉默时间继续累计，重新启动后评估到期等级。

## 主要功能

| 等级 | 默认沉默阈值 | 配置启用时的动作                       |
| ---- | ------------ | -------------------------------------- |
| L1   | 3 天         | 浏览数据清理，并补入 14 天假历史       |
| L2   | 7 天         | 少量假历史注入                         |
| L3   | 14 天        | 已保存文件夹粉碎、Windows 使用痕迹清理 |
| L4   | 30 天        | 指定软件卸载                           |

支持程序员、学生、设计师、投资者、游戏玩家、日常生活六种假历史人设。管理页包含总览、触发规则、动作配置、假历史、运行日志五个视图，提供分区草稿、保存失败反馈和未保存提示。

默认保留 Cookies，不清理系统事件日志；每日本地时间 21 点提醒。沉默计时只由打卡重置，暂停和键鼠活动不重置计时。阈值可配置为严格递增的有限正数，支持小数天。

## 获取与安装

本仓库公开源码、测试、文档和依赖锁文件，**不提交 `dist/`、预构建安装包或本地测试数据**。当前没有附带安装包的 GitHub Release，不能把源码 ZIP 直接作为插件安装。

先安装 Node.js、pnpm 和兼容版本的 Harness，确认 `dsh --version` 为 `0.2.2-rc.1`，再从源码生成并检查安装包：

```powershell
git clone https://github.com/fiatlux2333/dsh-Cicada.git
cd dsh-Cicada
pnpm install --frozen-lockfile
pnpm compat:check
pnpm check
pnpm test:ui
pnpm pack:plugin
pnpm check:package
```

安装包输出到 `dist/dsh-cicada-0.1.2.tgz`，摘要输出到 `dist/SHA256SUMS.txt`。无需仓库访问授权即可克隆；运行不需要向 Cicada 提供模型 API 密钥。完整环境准备和命令说明见[开发与验证](docs/development.md)。

首次安装时先退出拟安装 profile 的宿主，再从项目根目录执行。已有插件升级时，先关闭自动触发并确认保存成功，再停用插件和退出宿主，按[升级步骤](docs/usage.md#安装升级与卸载)移除旧包：

```powershell
# 将 desktop 替换为实际使用的 profile 名。
$package = (Resolve-Path '.\dist\dsh-cicada-0.1.2.tgz').Path
dsh plugin --profile desktop add $package
```

启动该 profile，在「插件」中启用 `dsh-cicada` 并打开详情，或执行 `/cicada open`。首次安装后先核对演练模式和自动触发关闭状态，再配置目标、预览历史并演练。

升级同版本本地 tarball 时，应先停用插件、退出宿主，再 `remove` 后 `add`，避免缓存旧包。卸载不自动删除加密领域数据。完整操作见[使用指南](docs/usage.md)。

`0.1.0` 对应旧宿主 `0.2.1-rc.5`，不能直接用于新宿主。今后升级先运行 `pnpm compat:check`；未知宿主版本会明确拒绝，不绕过官方兼容限制。SDK 迁移、隔离验收、回退和 CI 流程见[宿主升级方案](docs/compatibility.md)。已有真实预授权不会因换包自动清除，关闭宿主期间的沉默仍累计。

`0.1.2` 修复中文卸载名称的词边界和定向浏览清理的聚类元数据残留，并加强官方 SDK 的 Cordis peer 校验。`pnpm test:harness` 自行创建、核验并关闭隔离宿主，不接受已有宿主 URL。各版本变化见[更新日志](CHANGELOG.md)。

## 人工与模型权限

人工命令：`/cicada status`、`/cicada checkin`、`/cicada pause 1|4|8|24`、`/cicada resume`、`/cicada drill`、`/cicada open`。

模型工具固定为 `cicada_status`、`cicada_preview_history`、`cicada_drill`。模型不能打卡、暂停、修改配置或真实执行，不接受任意路径、SQL 或命令。真实模式、预授权和真实执行必须由所有者在图形界面确认，聊天中的布尔确认无效。

## 安全要点

- 真实自动执行需要对已保存配置单独预授权；危险配置变化撤销授权。
- 关闭自动触发或切回演练取消未开始任务，当前等级继续完成，不提交其他草稿。
- 停止设置保存失败时，本次宿主锁定后续动作；必须重试并成功保存，**此前不要重启宿主**。运行时锁定不等于磁盘设置已保存。
- 敏感目标使用当前 Windows 用户 DPAPI 加密。密文缺失或解密失败锁定真实动作，不解释为空关键词的全量清理。
- 崩溃后的不确定真实动作、性质不明的旧版执行等级需要人工核查，不自动重放。
- 不保证 SSD 物理擦除，不清理云端同步副本，不自动提权。

## 文档导航

| 文档                                  | 内容                                           |
| ------------------------------------- | ---------------------------------------------- |
| [文档索引](docs/README.md)            | 按安装、开发和验收需求查阅                     |
| [使用指南](docs/usage.md)             | 安装升级、五页管理、命令、授权、导入和故障处理 |
| [安全与行为](docs/safety.md)          | 状态机、敏感数据、并发保护和不可逆操作边界     |
| [开发与验证](docs/development.md)     | 环境准备、目录结构、构建与安全测试             |
| [宿主升级方案](docs/compatibility.md) | 版本预检、SDK 迁移、隔离验收、回退与 CI        |
| [更新日志](CHANGELOG.md)              | 插件版本与对应宿主、重要修复                   |
| [验证记录](docs/verification.md)      | 最新自动验证、历史集成证据和待人工验收项       |
| [第三方声明](THIRD_PARTY_NOTICES.md)  | 第三方依赖与许可证声明                         |

## 官方依据

- [插件开发](https://deepseek-harness.github.io/deepseek-harness/develop/basic/)
- [打包与安装](https://deepseek-harness.github.io/deepseek-harness/develop/basic/publish)
- [API Gateway](https://deepseek-harness.github.io/deepseek-harness/reference/api-gateway)
- [客户端模块](https://deepseek-harness.github.io/deepseek-harness/reference/subsystems/client-modules)
- [Slots](https://deepseek-harness.github.io/deepseek-harness/reference/subsystems/slots)、[Typert](https://deepseek-harness.github.io/deepseek-harness/reference/subsystems/typert)、[Storage](https://deepseek-harness.github.io/deepseek-harness/reference/subsystems/storage)

官方文档为接口依据；运行时签名与本项目锁定的官方 `0.2.2-rc.1` 发布物对应，不宣称兼容其他版本。[社区指南](https://lgiang517.github.io/deepseek-harness-plugin-guide/) 仅辅助理解。

## 问题反馈与许可

通过 [GitHub Issues](https://github.com/fiatlux2333/dsh-Cicada/issues) 报告问题时，请附插件、Harness、Node.js 版本及脱敏复现步骤。不要上传 profile、DPAPI 密文、目标路径、关键词、所有者访问 URL、凭据或浏览器数据库；仅使用合成数据复现。

源码公开不等于授予开源许可证。本项目当前未声明项目许可证；[第三方声明](THIRD_PARTY_NOTICES.md) 只说明相应依赖的许可，不替换本项目或原 Cicada 的许可。
