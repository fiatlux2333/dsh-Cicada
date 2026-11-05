# dsh-cicada

面向本机 Windows / DeepSeek Harness **0.2.2-rc.1** 的 Cicada 原生插件，要求 Node.js **24.9+**。仅支持本机 Desktop / 本机 Web，浏览器动作仅支持 Chrome、Edge。

> **0.1.2 尚未完成全部真实 Windows 行为验收。** 首次安装为演练、自动触发关闭。真实动作可能不可逆，应先在可恢复快照的虚拟机中验收。

## 安装与升级

退出目标 profile 的宿主，将路径和 profile 名替换为实际值：

```powershell
dsh plugin --profile desktop add 'C:\path\dsh-cicada-0.1.2.tgz'
```

启动该 profile，在「插件」中启用 `dsh-cicada` 并打开详情，或使用 `/cicada open`。

升级同版本本地包时，先停用插件并退出宿主，再执行 `dsh plugin --profile desktop remove dsh-cicada` 后重新添加，避免缓存旧包。卸载不自动删除加密领域数据；已有数据升级或重装不保证重置计时或模式。

`0.1.0` 仅对应旧版 `0.2.1-rc.5`。本版升级官方 SDK 和 Cordis 到 `0.2.2-rc.1` / `4.1.0`，不使用版本豁免。已有真实预授权仍可能在启动后补执行；升级前须成功关闭自动触发。源码工作区可运行 `pnpm compat:check` 预检，未知版本应先迁移 SDK 并隔离验收，不直接放宽 `engines.dsh`。

`0.1.2` 修复中文卸载名称误匹配、定向清理的聚类标签与关键词残留，补强官方 Cordis peer 预检及自建隔离宿主验收。卸载目标建议填写完整显示名称；名称歧义会拒绝执行。

## 功能与命令

沉默时间只由打卡重置，键鼠活动、暂停和关闭宿主期间继续累计。启动立即评估，运行中每 60 秒评估，跨级按 L1 → L4 补执行。

| 等级 | 默认阈值 | 动作                               |
| ---- | -------- | ---------------------------------- |
| L1   | 3 天     | 浏览数据清理及 14 天假历史补位     |
| L2   | 7 天     | 少量假历史注入                     |
| L3   | 14 天    | 已保存文件夹粉碎、Windows 痕迹清理 |
| L4   | 30 天    | 指定软件卸载                       |

五页管理界面提供总览、触发规则、动作配置、假历史、运行日志。支持六种人设、分区草稿和演练。默认保留 Cookies、关闭系统事件日志清理，每日本地时间 21 点提醒。

人工命令：`/cicada status`、`/cicada checkin`、`/cicada pause 4`、`/cicada resume`、`/cicada drill`、`/cicada open`。暂停只支持 1、4、8、24 小时。

模型工具只有 `cicada_status`、`cicada_preview_history`、`cicada_drill`，不能打卡、暂停、修改配置或真实执行，不接受任意路径、SQL 或命令。

## 真实执行与数据保护

- 真实模式、无人值守预授权、全流程真实执行和旧版导入均需所有者在图形界面确认。全流程真实执行即使当前为演练模式也会真实执行，并重新执行全部启用等级。
- 目标、动作或阈值等危险配置变化撤销授权。关闭自动触发、暂停、打卡或配置版本变化取消未开始请求，不强行中断当前等级。
- 执行中可关闭自动触发或切回演练，不提交其他草稿；保存期间的新输入继续保留。
- 停止设置保存失败时，本次宿主锁定后续动作，但磁盘配置可能仍开启。解决存储问题并重试，成功保存前不要重启宿主；打卡、刷新和存储恢复不解除该锁定。
- 敏感目标仅以当前 Windows 用户 DPAPI 密文持久保存。空目标首次安装时也必须加密；密文缺失或解密失败锁定真实执行，不解释为空关键词的全量清理。需恢复并保存目标或导入有效副本。
- 崩溃后的不确定真实动作需要人工核查，失败或已核查等级不自动重试。监控锁失效后旧实例停止写入，需退出并重启原宿主。

## 导入与恢复

旧版数据只读复制，导入后强制演练、关闭自动触发并清除授权，不修改原文件。请勿与旧版 Cicada 同时运行真实自动动作。

旧等级无法证明演练或真实执行性质。导入及已有 `legacyLevels` 均先待核查，在运行日志逐级选择结论并输入 `已核查仅为演练` 或 `已核查真实执行`。前者不消耗真实资格，后者在当前周期不自动重试。核查本身不执行动作，打卡、重启或再次导入不清除待核查等级。

## 限制与文档

未配置关键词意味着全量浏览数据清理，不代表关闭清理。浏览器关闭失败则拒绝写入，不强制杀进程。失败可能保留 `.cicada.*.bak` 恢复备份，不要随意删除。不自动提权，不保证 SSD 物理擦除，不清理云端同步记录。

关闭每日提醒会清除待提醒状态；同日重新开启不重复已产生过的提醒，次日恢复。管理仅限本机，宿主应绑定回环地址，不共享所有者凭据。本插件不是独立守护进程，宿主关闭期间不执行动作。

本包包含源码、预构建 Host、官方 lazy-CJS Client 和严格 Typert 约定，不依赖 Python 或独立 HTTP 服务。公开源码仓库不包含预构建包，源码 ZIP 不能直接作为插件安装，需按开发文档构建。

- [公开源码仓库](https://github.com/fiatlux2333/dsh-Cicada)
- [更新日志](https://github.com/fiatlux2333/dsh-Cicada/blob/main/CHANGELOG.md)
- [使用指南](https://github.com/fiatlux2333/dsh-Cicada/blob/main/docs/usage.md)
- [安全与行为](https://github.com/fiatlux2333/dsh-Cicada/blob/main/docs/safety.md)
- [开发与验证](https://github.com/fiatlux2333/dsh-Cicada/blob/main/docs/development.md)
- [宿主升级方案](https://github.com/fiatlux2333/dsh-Cicada/blob/main/docs/compatibility.md)
- [验证记录](https://github.com/fiatlux2333/dsh-Cicada/blob/main/docs/verification.md)
- [第三方声明](THIRD_PARTY_NOTICES.md)

反馈问题请提供版本与脱敏复现步骤，不上传目标、关键词、profile、密文、凭据或所有者访问 URL。本项目当前未声明项目许可证，源码公开不等于授予开源许可。
