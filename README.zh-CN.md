<p align="center">
 <img src="https://raw.githubusercontent.com/YunzhouLi-hub/dsh-overall-mcp/main/docs/images/icon.png" width="112" height="112" alt="全局 MCP & Skill：一个蓝色中心连着五个卫星点">
</p>

<h1 align="center">全局 MCP &amp; Skill</h1>

<p align="center">中文 | <a href="README.md">English</a></p>

<p align="center">
 <a href="CHANGELOG.md"><img src="https://img.shields.io/badge/version-1.0.1-4d6bfe" alt="version 1.0.1"></a>
 <a href="LICENSE"><img src="https://img.shields.io/badge/license-MIT-4d6bfe" alt="license MIT"></a>
 <img src="https://img.shields.io/badge/node-%5E22.19%20%7C%7C%20%3E%3D24-4d6bfe" alt="node ^22.19 || >=24">
</p>

**DeepSeek Harness 里的一个面板，管两件事：这台机器上有哪些 MCP 服务器，以及有哪些 Skill。** 首次加载扫描宿主机全部 MCP 配置并注册；把六个开放 MCP 目录和四个 skill 市场放到同一个搜索框后面；为本机留一份收录索引，翻页、搜索、安装都不再走网络；并记录**真正跑过什么**——工具往返与 skill 触发——让「配了」和「用了」不再是同一个词。

面板在侧栏注册为 **全局 MCP & Skill**，就在「插件」正下方（`sidebar.panellist` 里 `order: 5`）。

## 一页看全

| | |
|---|---|
| **已注册** | 宿主机各份 MCP 配置里的服务器，按来源文件分组；可启用、停用、移除、打开目录。 |
| **MCP 市场** | 六个目录（官方 Registry、Smithery、Docker MCP、GitHub MCP、Awesome 远程、Awesome 本地）去重成一张列表；搜索、分类、一键接入。 |
| **Skill 空间** | 从 `~/skills`、`~/.agents/skills`、`~/.claude/skills`、`~/.codex/skills` 四处读取，按来源分组；可打开目录，移除只是搬进回收目录。 |
| **Skill 市场** | ClawHub、SkillHub、官方集、GitHub 同时问；安装由插件自己解包。 |
| **调用** | 真正跑过的：`tool/call` → `tool/result` 往返，以及每一次 skill 触发（`skill` 工具，和你在输入框里敲的 `/技能名`）。今日次数、成功率、平均耗时，1 小时 / 24 小时 / 7 天。 |
| **索引** | SkillHub、ClawHub、GitHub 的本机收录：切片，或把某个源一直走到尽头。有索引之后翻页与搜索直接读文件，零网络请求。 |

## 截图

这些是**真实面板**：用同一份 `client/client.js` 渲在固定数据上，所以图不会和代码画出来的东西脱节。

### 已注册 — 服务器按来源分组

![已注册页：服务器按来源文件分组，下面是 GitHub 访问卡片（普查索引、上次走查停在哪、继续恢复）](https://raw.githubusercontent.com/YunzhouLi-hub/dsh-overall-mcp/main/docs/images/registered.png)

### MCP 市场 — 六个目录，一个搜索框

![MCP 市场：搜索、分类与来源筛选、每个来源各自的条数，以及带星数、许可证和标签的卡片墙](https://raw.githubusercontent.com/YunzhouLi-hub/dsh-overall-mcp/main/docs/images/market.png)

### 详情 — 一张卡背后的全部信息

![详情面板：启动命令、服务器需要的配置项、传输方式、星数、许可证，以及能做的事](https://raw.githubusercontent.com/YunzhouLi-hub/dsh-overall-mcp/main/docs/images/detail.png)

### Skill 空间 — 同一个页面，一颗胶囊切过来

![Skill 空间：skill 按所在目录分组，每张卡带来源、版本、大小与最后修改时间](https://raw.githubusercontent.com/YunzhouLi-hub/dsh-overall-mcp/main/docs/images/skill.png)

### Skill 市场 — 四个市场，一个框

![Skill 市场：一个搜索框同时问四个来源，每个来源报自己的条数，失败的那个直接说明原因](https://raw.githubusercontent.com/YunzhouLi-hub/dsh-overall-mcp/main/docs/images/skillmarket.png)

### 调用 — 真正跑过什么

![调用页：顶部今日次数、成功率、平均耗时；钉住的左栏按服务器或 skill 分组；时间线是工具往返与 skill 触发，工具栏带合并窗口与时间范围](https://raw.githubusercontent.com/YunzhouLi-hub/dsh-overall-mcp/main/docs/images/calls.png)

## 安装

```sh
git clone https://github.com/YunzhouLi-hub/dsh-overall-mcp.git
dsh plugin --profile <profile> add /path/to/dsh-overall-mcp
# 重启 DSH：宿主代码在启动时载入，面板随页面重新载入
```

- **Node** `^22.19.0 || >=24.0.0`。
- **GitHub 访问是可选的**，但决定两个能力：存了 token（或 `gh auth login`）之后，搜索是 30 次/分钟，能用代码搜索，全量普查走自己的配额；没有 token 时浏览退化为仓库搜索，配额（10 次/分钟）用完时面板会显示 GitHub 自己给的 403。
- 插件的自更新是拿本包和 npm 比版本；本地检出（也就是这个仓库）按设计**跳过**自更新——更新方式是 `git pull` 再重启。

## 它会写什么，绝不碰什么

它自己的东西都在 `$DSH_HOME/overall-mcp/` 下：

| 文件 | 是什么 |
|---|---|
| `registry.json` | 已注册服务器：来源、版本、传输方式、挂载状态。 |
| `catalog-cache.json` | 各来源最后一次 MCP 目录（未过期前读它，不读网络）。 |
| `skills-index.json` | 收录索引：行、各源游标、`modes`、`truncations`、`minStars`。 |
| `calls.jsonl` | 调用记录，一次往返 / 一次触发一行。每次调用都留；「同一窗口内合成一行」是**读**时的规则，不改写历史。 |
| `ui-prefs.json` | 只放显示偏好（调用页的合并窗口），不放任何配置。 |
| `events.ndjson` | 页头展开的动作日志。 |
| `skills-trash/<时间>/` | 「移除」把 skill 目录搬到这里——只移动，不删除。 |

它**读**宿主机的 MCP 配置文件，从不写它们；它装新 skill 时写 `$DSH_HOME/skills/<名字>/`，并把确切路径说出来。

## HTTP 接口

面板用的路由（Connection 鉴权；是给页面用的，不是公开 API）：

```
GET  /status           GET  /registry        GET  /catalog
POST /scan             GET  /skills          GET  /skills/market
POST /skills/market/install                   POST /skills/market/walk   {action: start|stop}
GET  /calls?space=mcp|skill&range=1h|24h|7d&merge=<ms>&filter=&q=
GET|POST /prefs        GET  /events          GET  /favorites
POST /install          POST /toggle          POST /remove               POST /self-update
```

## 2026-10 实测

面板报的数字，以及它们各自的意思：

- **SkillHub 全量**：43 分钟、2,107 次请求，收到 **205,037 行**，上游 total 210,612。列表在被翻页的过程中本身在漂移，2,107 页 × 100 行去重后是 20.5 万；文件记 `modes.skillhub = "full"`，游标 `done`。
- **GitHub 切片**：**7,722 个仓库**（≥ 5★）。GitHub 的搜索翻不过 1,000 条，所以走的是「按星数分档下潜」；有七个档的同星块比一个窗口还宽，它们被写进文件的 `truncations`，而不是悄悄丢掉。
- **ClawHub 切片**：1,988 行。ClawHub 不公布总数，面板也不编一个。
- **整个索引**：214,747 行、163 MB、`complete: true`。翻页、搜索、安装都直接读它，零网络请求。

## 它承认的限制

- GitHub 搜索：匿名 10 次/分钟，带 token 30 次/分钟；全量走查故意按每次 6.5 秒的节奏。
- SkillHub 全量翻的是一个会漂移的列表，所以行数是「实际收到了多少」，不是对目录的承诺。
- 索引是缓存而不是镜像：某个源没走到底时，`truncations` 会说明它停在哪；`modes` 说明哪些源是走到尽头的。

## 开发

这个仓库就是**发布出来的插件**：`index.js`、`lib/`、`client/`、profile patch、`registry.json`、两份 README、`CHANGELOG.md` 与截图。测试、渲染探针与构建脚本留在开发工作区，不在这个仓库里。

## 许可证

MIT — 见 [LICENSE](LICENSE)。每个版本的改动见 [CHANGELOG.md](CHANGELOG.md)。
