# 社区收录与插件搜索

核对日期为 2026-11-20。本次发布 `0.1.3` 预构建包，面向 DSH `0.2.2-rc.5`，并向 `awesome-dsh-plugin` 提交社区收录。社区网站和市场在条目合并后更新，官方「发现」页的社区索引还需要 npm 包关联。

## 三个入口的收录方式

| 入口 | 发布方式 | 用户如何找到 |
| --- | --- | --- |
| Awesome DSH Plugin 网站与列表 | 向社区仓库提交一个 YAML 条目，维护者合并后自动构建网站 | 搜索名称和功能描述，或浏览安全分类 |
| `dsh-market` 社区市场 | 使用同一份社区目录，安装来源可以是 npm 或条目声明的 GitHub Release tarball | 在市场中搜索插件名、包名、作者、双语描述或分类 |
| DSH 官方「发现」页 | 用户启用「自定义插件索引」，添加社区索引源 | 在该索引内搜索和安装兼容版本 |

官方文档说明 DSH 不内置任何索引源。该社区目前提供的 format 1 索引只包含已关联 npm 包、具有明确版本和发布时间的条目。GitHub Release 方式可以满足社区网站和 `dsh-market` 的分发需求，进入他们提供给官方「发现」页的索引还需要发布 npm 包。官方通用索引格式也支持固定提交的 Git 来源，社区当前的生成脚本只输出 npm 来源。[官方插件索引](https://deepseek-harness.github.io/deepseek-harness/guide/plugin-market) · [社区入口说明](https://github.com/awesome-dsh-plugin/awesome-dsh-plugin/blob/main/README.zh.md) · [社区索引生成实现](https://github.com/awesome-dsh-plugin/awesome-dsh-plugin/blob/main/scripts/lib/market-index.mjs)

社区推荐添加的索引 URL 为 `https://cdn.jsdelivr.net/npm/dsh-plugin-catalog/index.json`。这一步由使用该目录的用户在自己的 DSH profile 中完成。[社区入口说明](https://github.com/awesome-dsh-plugin/awesome-dsh-plugin/blob/main/README.zh.md)

## Cicada 当前的准备情况

| 项目 | 核对结果 |
| --- | --- |
| 公开仓库与仓库年龄 | 已公开，2026-11-03 北京时间创建，满足创建满一天的要求 |
| 可安装组合包声明 | `packages/dsh-cicada/package.json` 已有 `dsh.bundle` 和对应 patch |
| 测试 | Windows Web 宿主、182 项回归、22 项合成界面测试已通过 |
| 社区收录 | 核对时目录中没有 Cicada 条目，也没有查到以 `fiatlux2333` 为关键词的相关投稿 |
| GitHub Topics | 已添加 `dsh-plugin`、`dsh`、`deepseek-harness`、`privacy`、`windows` |
| 公开安装包 | 发布前完成 Windows 验收，Release 交付同一份 `.tgz` 与 SHA256。npm 待账号登录后发布 |
| 发布元数据 | 已补齐 `repository`、`homepage`、`author`、`bugs` 与 `keywords` |
| 宿主兼容 | `0.1.3` 对齐官方 `0.2.2-rc.5` SDK、生成器和 Zod。`rc.5` 候选的 Windows 宿主验收已通过 |
| 项目许可 | 项目尚未选择开源许可证，包元数据使用 `UNLICENSED` |

插件位于 monorepo 子目录，应将投稿 URL 指向 `packages/dsh-cicada`。社区的 npm 关联脚本会读取该 URL 对应目录的 `package.json` 包名，并检查 npm 发布包的 `repository` 是否指回这个仓库。根目录包名是 `cicada-workspace`，指向根目录会影响自动关联。[社区贡献指南](https://github.com/awesome-dsh-plugin/awesome-dsh-plugin/blob/main/contributing.md) · [npm 关联实现](https://github.com/awesome-dsh-plugin/awesome-dsh-plugin/blob/main/scripts/probe-npm.mjs)

当前源码中的 `lib/` 由仓库根脚本生成且没有提交，插件子包也没有可独立运行的 `prepare` 脚本。上架时应交付已经构建并检查过的 npm 包或 Release tarball。官方文档解释了 Git 安装需要的构建脚本和用户授权。[官方打包与安装](https://deepseek-harness.github.io/deepseek-harness/develop/basic/publish)

## 发布流程

1. 准备精确宿主版本的候选，完成 Windows 宿主验收，再确定正式插件版本和支持范围。候选准备和验收步骤见[宿主升级方案](compatibility.md)。
2. 为插件子包补齐下面的发布元数据。GitHub 仓库添加 `dsh-plugin`、`dsh`、`deepseek-harness`、`privacy`、`windows` 等与功能相符的 Topics。
3. 从确定的源码提交生成并核对 tarball，向 npm 发布 `dsh-cicada`。公开查询返回 404 只能说明查询时没有可见包，包名是否可用仍以 npm 发布时的检查为准。发布前核对 npm 账号、包名、版本、内容和许可决定。
4. 验证已发布版本能通过官方 DSH 安装。Release 可以同时提供相同源码构建的 `.tgz` 和 SHA256，方便直接下载。
5. 向 `awesome-dsh-plugin/awesome-dsh-plugin` 提交一个 PR，只新增本插件的 YAML 条目。草稿见[收录条目](community/fiatlux2333__dsh-Cicada--packages-dsh-cicada.yml)。
6. 等待社区 CI 和维护者审阅。合并后网站自动重建，npm 关联由目录定期采集，之后分别验证社区网站、`dsh-market` 和官方「发现」页的搜索结果。

已补充到 `packages/dsh-cicada/package.json` 的搜索和仓库信息如下。版本、引擎范围和依赖随验收结果更新。

```json
{
  "author": "fiatlux2333",
  "homepage": "https://github.com/fiatlux2333/dsh-Cicada#readme",
  "repository": {
    "type": "git",
    "url": "git+https://github.com/fiatlux2333/dsh-Cicada.git",
    "directory": "packages/dsh-cicada"
  },
  "bugs": {
    "url": "https://github.com/fiatlux2333/dsh-Cicada/issues"
  },
  "keywords": [
    "dsh",
    "dsh-plugin",
    "deepseek-harness",
    "cicada",
    "privacy",
    "watchdog",
    "check-in",
    "browser-history",
    "fake-history",
    "windows"
  ]
}
```

社区条目中没有 `npm:` 字段，手写该字段会被校验拒绝。npm 关联依靠包名和 `repository` 自动完成。若选择只发 Release，条目必须补充已经存在的 `tarball:` 链接，固定版本文件名应配固定 tag 的 URL。[社区贡献指南](https://github.com/awesome-dsh-plugin/awesome-dsh-plugin/blob/main/contributing.md)

## 搜索文字与展示

投稿草稿的名称采用 `Cicada 蝉蜕`，分类采用 `security`。双语描述包含手动打卡、浏览记录清理、假历史、文件夹删除、Windows 使用记录清理和软件卸载，方便用户按功能搜索。描述按当前功能编写，明确以未打卡时长计时。键鼠空闲检测和一天统一执行仍是待开发功能。

`dsh-market` 的搜索实现读取名称、npm 包名、作者、双语描述和分类。因此社区条目中的功能描述需要写全。官方参考生成器还会从 npm 包的 `keywords` 提取搜索关键词，但该社区的索引生成器目前没有复制这一字段。[社区市场搜索实现](https://github.com/dsh-market/dsh-market/blob/main/src/client/market-data.ts) · [官方参考生成器](https://github.com/deepseek-ai/deepseek-harness/blob/master/apps/plugin-market-generator/README.zh.md)

图标和截图均为可选项。社区图标接受 GitHub 托管的 PNG、JPEG、WebP。可在插件子目录的 `package.json` 旁添加 `screenshots.json`，列出一到八张图片。现有截图位于仓库根的 `docs/images/`，声明时可以使用 GitHub 托管的绝对 HTTPS 地址。社区禁止相对截图路径中的 `..`。现有总览截图应继续标明使用演示数据。[社区图标与截图规则](https://github.com/awesome-dsh-plugin/awesome-dsh-plugin/blob/main/contributing.md)

## 本次投稿

条目采用 `Cicada 蝉蜕`，分类为 `security`，指向 `packages/dsh-cicada` 子目录。双语描述声明支持 DSH `0.2.2-rc.5`，提供固定版本 Release tarball 链接。[收录条目](community/fiatlux2333__dsh-Cicada--packages-dsh-cicada.yml)

发布地址和社区 PR 会在提交完成后记录于此。
