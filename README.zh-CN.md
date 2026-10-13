# dsh-overall-mcp

**DeepSeek Harness 插件：首次安装自动扫描宿主机全部 MCP 配置并注册；实时聚合 5 个网络开放 MCP 目录共 5000+ 条目（官方 Registry / Smithery / Docker MCP Catalog / Awesome 远程 / Awesome 本地），以卡片形式浏览与一键接入。**

简体中文

## 核心特性

| | 能力 | 说明 |
|---|---|---|
| 🔍 | 首装全盘扫描 | 安装后自动发现 Claude Desktop、Claude Code、Cursor、VS Code (Copilot)、Windsurf、Codex CLI、Gemini CLI 配置中的所有 MCP 服务器并自动注册 |
| 🌐 | MCP 市场 | 自动发现市面上已有的 MCP：官方 Registry、Smithery、Docker MCP Catalog、Awesome 远程、Awesome 本地共 **5 源并行聚合，实测 5364 条**，无需输入关键词即可浏览，带来源筛选与搜索 |
| ⚡ | 一键接入 | 市场条目直接安装：npm 包→`npx -y <pkg>`，Python 包→`uvx`，托管端点→streamable-http，Docker 镜像→`docker run -i --rm mcp/<name>`；社区清单条目提供仓库链接 |
| 🛠️ | 原生工具桥接 | 启用的服务器以每服务器一个 `dsh-mcp-client` 实例挂载，工具以 `mcp__<name>__<tool>` 注册为 DSH 原生工具 |
| 🖥️ | 设置页 UI | 设置 → Overall MCP：**已注册**（按来源分组、可折叠、分组开关、统计筛选）与 **MCP 市场**（浏览/搜索/安装）两个标签页 |
| 🎛️ | 分组批量启停 | 每个来源分组一个总开关，一次启用/停用该来源的全部服务器（模型工具 `overall_mcp_set_source_enabled` 同能力） |
| ⬆️ | 版本检查与更新 | 对经 `npx`/`uvx`（含 Windows `cmd.exe /c` 包装）启动的服务器检查 npm / PyPI 最新版本，界面上一键更新并自动重连 |

## 快速开始

```sh
dsh plugin --profile web add ./dsh-overall-mcp
```

重启 Profile 后：首次加载自动扫描宿主机 MCP 配置；打开 **设置 → Overall MCP**。

### 「已注册」标签页（对齐 Skills Manager 来源分组）

- 顶部统计：`N 台服务器 · M 已启用 · K 已停用 · C 已连接 · X 连接异常`
- 筛选：来源下拉、状态下拉（已启用/已停用/已连接/连接异常）、名称搜索
- 分组：按导入来源聚合（Claude Desktop / Claude Code / Cursor / VS Code / Windsurf / Codex CLI / Gemini CLI / 官方 Registry …），每组显示数量与"已启用"计数，右侧总开关批量启停，点击组头折叠/展开
- 每行：连接状态点、名称、传输方式、状态、工具前缀（`mcp__<serverName>__`）、启用/停用、移除

### 「MCP 市场」标签页（自动发现市面上的 MCP）

- 打开即自动拉取**整份市场列表**（全部 ~5.4k 条一次载入：上游成本与小切片完全相同，本地载荷 ~3MB；10 分钟缓存，可手动「刷新」）
- 总数以紧凑形式显示：`5.3k 个可用 MCP`（5364 → 5.3k，**截断而非四舍五入**，避免标题数大于真实条数）
- 统计：各来源条数 · 已安装数 · 当前页码 · 缓存时间
- **排序**（用户自选，切换即生效，不重新请求上游）：
  - `默认（综合推荐）` — 质量分：已认证(400) > 官方(300) > 可安装(120)，再加 log 量纲的流行度；已废弃 −500
  - `使用量最多` — 按 `installs` 倒序
  - `Star 最多` — 按 GitHub Star 倒序
  - `最近更新` — 按 `updatedAt` 倒序
  - `名称 A→Z`
- **分页**：每页 20 / 50 / 100 条三档可切，带「« 首页 / ‹ 上一页 / n / N / 下一页 › / 末页 »」。5364 条在每页 20 下为 20 页、50 下 8 页、100 下 4 页
- **功能分类**（排列式 chip 行，与插件市场一致）：筛选行下方一排可换行的分类按钮——「全部 (N)」开头（总数只在「全部」上显示），随后是功能组（不带数量、仍按数量降序排列），「未分类」收尾；点选中项一次即回到全部。75 个上游 `###` 标题（两清单合计，含同义异名如 Finance / Finance & Fintech、两个 Multimedia）归并为 **19 个功能组**（金融支付、开发工具、办公协作、搜索与知识、营销与客户、多媒体创作、数据与存储、安全与身份、聚合网关、出行与生活、商业与法律、云与运维、其他、社交媒体、自然环境、浏览器自动化、医疗健康、游戏娱乐、语音与语言）。归并在宿主完成（`group` 字段），上游原标题保留在条目上（`category` + 卡片第一个标签）用于溯源；未映射的新标题兜底进「其他」而非消失；三个 registry 不发布类目，其条目归入「未分类」桶；合并记录时类目跟随存活（Smithery 赢得合并的条目仍能按功能组筛出）
- 排序、分类与分页都是**视图层**行为：宿主一次返回整份列表，翻页/换排序/切分类不产生任何上游请求- 任一字段缺失的条目不会因此排到最后——缺失不等于 0：有数字的条目优先于无数字的，两者皆无时回落到质量分
- Star 补充只覆盖**当前页**可见的仓库，翻页不重复消耗 GitHub 额度
- 统计：`N 个可用 MCP · 官方 x · Smithery y · Docker z · 远程 a · Awesome b · 其中 M 个已安装 · 更新于 时间`
- 来源筛选：全部市场 / 官方 Registry / Smithery / Docker MCP Catalog / Awesome 远程 / Awesome 清单；支持关键词搜索（关键词同样匹配安装命令，搜 `docker` 或端点域名也能命中）
- **卡片形式**呈现（与 dsh-market 插件一致）：图标（Smithery 图标 / GitHub 头像，缺失时用首字母色块）、**标题即入口**（有仓库链仓库、否则链上游官网、Smithery 条目链其目录页——与 dshmarket 卡片名一致的真锚点；卡片正文是 div 而不是 button，链接不会和点击详情打架）、标题旁**GitHub 标记**（只在 `repository` 真的是 GitHub 仓库时出现，悬停才上色）、作者行末尾的**版本**、✓认证/官方/已安装/已废弃徽标、来源 · 传输方式 · 使用次数 · ★ Star、三行描述、标签（分类 / 语言 / 部署范围 / 操作系统 / 仓库 topics）。悬停反馈通过注入的样式表实现（内联样式表达不了 :hover / keyframes）：卡片描边高亮、主按钮蓝色、详情弹窗入场动画
- **卡片布局**：按 `frontend-card-style-v4.html` 原型——卡片左右分栏（左内容 / 右「安装 + 详情」），下方是标签 + 收藏/详情图标按钮的页脚；**收藏与 ⋯ 在正文外**，点星星不会顺带打开详情。卡片流用 CSS `column-count` 砌墙（≥1100px 三列、≤720px 单列），因为卡片高度随描述与标签数变化，等高网格会留下参差的空白
- **预览位放仓库自己的图**：v4 原型卡片中部是 3 张彩色预览图。没有任何 MCP 目录发布产品截图，编造占位图等于用装饰冒充信息，因此同一位置改放**该仓库自己的图**：优先 README 里引用的截图（按文档出现顺序，最多 8 张，`images.weserv.nl` 代理缩放并统一高度），一张都没有时退回 GitHub 的社交卡片（`opengraph.githubassets.com`，它就是这张卡在社交平台上的样子）；两者皆无就不渲染这一格（不硬凑装饰）。滚动条隐藏、`scroll-snap` 对齐，左右圆钮手动翻页、**永不自动播放**——阅读时图片自己走位是干扰。图片按仓库缓存到 `$DSH_HOME/overall-mcp/media.json`（TTL 7 天，最多 300 个仓库）
- **事实静态印在卡片上**（用户要求）：Star · 使用量 · 更新时间 · 安装方式这些数字直接在卡片正面，不藏在轮播里——要等的数字就是没法比较的数字
- **收藏**：卡片页脚与详情面板都可收藏；宿主持久化到 `registry.favorites`，界面只本地改自己那份列表（为了一颗星重新拉 ~3MB 市场列表不值当下次浏览/安装/开会话会与宿主对齐）
- **页面头**（按 v4 原型）：星座图标（一个品牌蓝中枢 + 五个 `currentColor` 卫星，深色主题自动反色）+「总体 MCP」+ 版本 chip（与 `package.json` 一致，`tools/client-smoke.mjs` 断言两者相等——会撒谎的版本号比不显示更糟）+ 副标题「宿主机扫描 · 市场发现 · 一键接入 · 申请收录插件 ↗」（链 awesome-mcp-servers 的贡献指南）
- **每个标签页一个主操作**：注册表页主按钮是「重新扫描宿主机」，市场页主按钮是「更新插件市场」（强制重拉，绕过 10 分钟缓存）；另一页的主操作以次级按钮留在同一行（「打开 MCP 市场」/「重新扫描宿主机」），两个主按钮等于没有主按钮
- **⤓ 导出日志**：把这一页知道的东西写成 JSON 文件（插件版本、注册表全量、市场各源条数/缓存时间/返回条数、当前筛选与页码、两处错误）——排查问题时缺的正是这些。客户端本地拼装并下载，不新增宿主路由：宿主自己的日志不归这个插件导出
- **回到顶部**：设置面板滚的是自己的容器而不是 window，因此监听挂在第一个可滚动祖先上（退化为 window）。只在滚动超过 400px 后才出现，短页面不留一个死按钮
- 操作：可安装的显示「安装」，已注册的显示「已安装」，只有仓库链接的显示「需手动配置」+「仓库」/「主页」
- **详情页**：点卡片主体或「详情」按钮弹出完整面板（仿 dshmarket 的安装对话框），含：完整描述（卡片只显示 3 行）、全部标签、**GitHub 仓库区块**（owner/repo 锚点、★ Star · Fork · Issue · Watch 四个统计、语言/许可证/最近推送/创建于事实行、归档警示；缺失数字保持缺失——没有任何目录发布 GitHub 数据，缺数字不等于 0，也不等于排最后）、逐项标注的事实表（来源/作者/版本/传输/Star/使用量口径/更新时间（优先 GitHub pushed_at）/安装方式）、**将执行的确切命令**（stdio 为完整命令行，http 为端点 URL）、按 URL 去重的链接组（官网 / GitHub 仓库 / **GitHub 镜像** / MCP 端点 / Smithery 页面）、安装与取消。Smithery 的 `repository` 指向它自己的列表页而非上游项目，因此额外提供其目录页链接（实测 `smithery.ai/server/<name>` 308 到 `/servers/<name>`，直接用后者）
- **GitHub 镜像链接**：GitHub 在本网络环境下时通时断（实测连续数小时 TCP 超时后恢复 200）。实测（2026-10-12）`gh-proxy.com` 现已代理 github.com 仓库页面（200/640ms）——与 dshmarket 2026-09 实测的 403 相反，其注释明确要求"重新测量而非推断"。因此有仓库的条目同时提供直连与镜像两个链接，由用户择一
- **废弃标记**：上游标记为 deprecated 的条目不隐藏、仍可安装（有人可能需要旧版），但降到最后、显示橙色「已废弃」徽标、按钮改为「仍要安装」，并附上上游自己的 `statusMessage` 说明。目前仅官方 Registry（`_meta…official.status`）与 Smithery（`inactive`）发布该信号；两个 Awesome 清单没有生命周期字段，因此这些条目的 `status` 为**缺省**而非 `active`——界面不会把"没人扫过"显示成"正常"

### GitHub 不可达时的镜像链（实测）

这台网络环境下 github.com、raw.githubusercontent.com、hub.docker.com 会**整体 TCP 连接超时**，而两个 MCP registry 正常——此时 awesome 两源（占市场 96% 条目）会整体消失。两个清单因此按信任顺序走镜像链：`raw.githubusercontent.com` → `cdn.jsdelivr.net` → `fastly.jsdelivr.net` → `testingcf.jsdelivr.net`，四个镜像**同时起跑（Promise 竞速）**，第一个成功的胜出、其余中止——串行等待曾是市场首开慢的主因：GitHub 整体封锁时 raw 与 fastly 各 ~10s 连接超时，串行链要烧掉 ~25s 才轮到可达节点；竞速后健康网络仍是 raw 秒回（其余中止于半途），封锁期只付最慢**成功**镜像的成本而非失败之和（实测健康期 450ms 完成拉取）。

- 镜像链内**不做逐 URL 重试**：下一个镜像就是重试，叠加会把最坏情况翻倍
- 普通（非镜像）请求保留一次 1.5s 的快速重试，仅针对 `fetch failed` 类瞬态失败；超时不重试
- 结果缓存 10 分钟，镜像链的成本被摊薄
- Docker Hub 目前无可用的开放镜像（国内镜像站只代理镜像拉取、不代理 Registry API），该源在网络封锁期按源降级，其余源不受影响

### 流行度数字的口径（重要）

各源发布的流行度字段**不是同一个单位**，卡片因此各自标注，绝不合并成一个"热度"：

| 来源 | 字段 | 卡片显示 | 口径 |
|---|---|---|---|
| Smithery | `useCount` | `87.6k 次启动` | 平台上的启动次数 |
| Docker MCP Catalog | `pull_count` | `1.9M 次拉取（累计）` | 镜像**累计**拉取，非滚动窗口 |
| 官方 Registry | — | 不显示 | **不发布任何流行度字段**，不伪造 |
| 两个 Awesome 清单 | — | 不显示 | 同上 |

排序时流行度只是弱信号（满分 400，而"可安装"是 1000），且取 log10 量纲，避免 190 万拉取的镜像压平其他条目。GitHub Star 仍单独一路，来自本地补充而非目录。
- 「全部市场」默认按来源**轮转交错**排列（各目录体量差异极大，纯按热度排序会把其中两个目录完全埋掉），因此打开即可同时看到三类来源；单来源筛选时则按热度排序
- GitHub Star 数是本地补充的：目录本身不提供，卡片先渲染，随后一次性补齐当前可见的 GitHub 仓库（最多 30 个，宿主缓存 6 小时）
- GitHub 未认证接口**每小时仅 60 次**且没有批量端点，因此宿主会读取额度状态：一旦耗尽即暂停补充并显示提示，下个整点后自动恢复。Star 只是装饰，额度不足时卡片内容依然完整

### 与 dshmarket 的 4508 条相比

dshmarket 的插件市场显示约 4508 条，但它**不是爬来的**：它读取发布在 npm 上的 `dsh-plugin-catalog` 包内的 `plugins.json`（约 5.4 MB），那是 [awesome-dsh-plugin.com](https://awesome-dsh-plugin.com) 每天流水线收录、构建并发布的产物，每条自带 `stars`、`downloads`、`capabilities`（权限标记）和双语描述。

MCP 生态目前**没有对等物**——没有站点把上千个 MCP 收录成同样结构化的产物。最接近的 PulseMCP（自称索引 8000+）公开 API 已日落，Glama 需要 API Key。所以本插件选择现场聚合开放 API：数字会随生态增长，字段来自一手来源，代价是 Star/下载量需本地补充、且受各上游限流约束。

## 模型工具

- `overall_mcp_scan` — 重新扫描宿主机 MCP 配置并导入（幂等，按名称去重；同名不同契约会改名导入，绝不覆盖）
- `overall_mcp_list` — 查看本地注册表（来源、传输、启停、连接状态）
- `overall_mcp_catalog [query] [source] [limit] [refresh]` — 浏览 MCP 市场（可不带关键词），返回条目含 `installable` / `installed` / `author` / `tags` / `installs`
- `overall_mcp_search <query>` — 按关键词搜索市场（与市场标签页同源）
- `overall_mcp_install <item>` — 安装市场条目并连接（`npx -y <pkg>` / `uvx <pkg>` / streamable-http）
- `overall_mcp_set_enabled <name> <bool>` — 启用/停用单台（停用即断开并卸载工具；启用即重连）
- `overall_mcp_set_source_enabled <source> <bool>` — 按来源批量启用/停用（等同界面上的分组开关）
- `overall_mcp_check_updates` — 检查所有启用服务器的可用更新（npm / PyPI）
- `overall_mcp_update <name>` — 更新到最新版（重写包参数为精确版本）并重连
- `overall_mcp_remove <name>` — 删除条目并断开

## 版本检查与更新

「已注册」标签页顶部有 **检查更新** 按钮；有可用更新的行显示绿色徽标 `可更新 → x.y.z` 与 **更新** 按钮。

能检测到版本的前提是该条目**通过包管理器启动**：

| 形式 | 可检测 | 说明 |
|---|---|---|
| `npx -y pkg@1.2.3 …` | ✅ | 对比 npm `dist-tags.latest` |
| `cmd.exe /d /c npx -y pkg@1.2.3 …` | ✅ | Windows 包装形式（从其它客户端导入的常见形态），会自动解包 |
| `uvx pkg` / `pipx pkg` | ✅ | 对比 PyPI `info.version` |
| `npx -y pkg`（未固定版本） | ⚪ | 视为始终最新，不提示更新 |
| `codegraph serve --mcp`、`python server.py` 等直接命令 | ❌ | 显示「not launched through a package runner」，不做猜测 |

更新动作会把包参数重写为**精确最新版本**（可复现），保存注册表，并断开重连让新版本真正生效。`GET|POST /api/overall-mcp/updates` 与 `POST /api/overall-mcp/update` 提供同等能力。

安装/连接采用**有界等待**：8 秒内未完成（例如首次 `npx` 下载）即返回 `starting: true`，连接在后台继续，页面刷新后显示最终状态。

## Schema 守卫（防止一个坏 schema 打挂整轮对话）

部分 MCP 服务器发布的工具 JSON Schema 含有模型 API 正则校验器无法接受的写法。典型例子是 REA v6.1.0 的 `"pattern": "^[^\\0]*$"`，DeepSeek 会直接拒绝**整个请求**：

```
Invalid schema for function 'mcp__rea-om__analyze_javascript_application':
"^[^\\0]*$" is not a "regex"
```

本插件在本进程内为 `mcp__*` 工具装了窄范围守卫（只影响 MCP 工具，卸载时还原），按保守策略修复：

| 情况 | 处理 |
|---|---|
| `\0`（NUL 转义） | 改写为等价的 `\x00` |
| 其他不可移植写法（反向引用 `\1`、lookbehind、`\p{...}` 等） | 删除该 `pattern` 关键字（schema 变宽松，不会变错） |

修复会写日志，并可通过 `GET /api/overall-mcp/tools` 查看**注册后的真实 schema**进行取证。

## 重复挂载的处理

若某个服务器名已被其它 mcp-client 挂载占用（例如 harness 家目录补丁里的 `rea-mcp` 已提供 REA），本插件**不再重复挂载**，该条目状态标为 `provided-externally`（界面显示蓝色点 +「已由其他插件提供（跳过重复挂载）」）。这样既避免重复工具集膨胀上下文，也避免重复连接把坏 schema 带进请求。

## HTTP API（界面使用，Connection 鉴权）

`GET /api/overall-mcp/servers`、`GET /api/overall-mcp/tools`（schema 取证）、
`GET|POST /api/overall-mcp/updates`（版本检查）、`POST /api/overall-mcp/update`（更新并重连）、
`GET|POST /api/overall-mcp/catalog?query=&source=&limit=&refresh=`、
`POST /api/overall-mcp/scan`、`POST /api/overall-mcp/search`、
`POST /api/overall-mcp/install`、`POST /api/overall-mcp/set-enabled`、
`POST /api/overall-mcp/set-source-enabled`、`POST /api/overall-mcp/remove`、
`POST /api/overall-mcp/favorite`（收藏，见下）、
`GET /api/overall-mcp/repo-stats?repos=owner/name,...`

### 收藏（favorite）

`POST /api/overall-mcp/favorite`，body `{"key":"<source>:<id|title>","on":true|false}`（缺省 `on` 时按当前状态取反）。
key 就是市场卡片的 React key，因为官方 Registry 的 id 随版本变化，所以用「来源 + 标题」做稳定身份。
收藏集存在 `registry.favorites`，随注册表一起持久化；`/catalog` 每条都会标注 `favorite`。
实测：`{"key":"official-registry:official:ai.0si/disclosures","favorite":true,"favorites":[...]}`，再次浏览同一条目即返回 `favorite: true`。

## 扫描的宿主机位置

| 应用 | 位置（按平台展开） |
|---|---|
| Claude Desktop | `%APPDATA%/Claude/claude_desktop_config.json`、`~/Library/Application Support/Claude/...`、`~/.config/Claude/...` |
| Claude Code | `~/.claude.json`、`~/.claude/settings.json` |
| Cursor | `~/.cursor/mcp.json` |
| VS Code (Copilot) | `.../Code/User/mcp.json`（Windows 用 `%APPDATA%` 路径） |
| Windsurf | `~/.codeium/windsurf/mcp_config.json` |
| Codex CLI | `~/.codex/config.toml`（`[mcp_servers.*]`） |
| Gemini CLI | `~/.gemini/settings.json`（`mcpServers`） |

仅读取上述白名单路径；不递归扫描任意目录，不收集遥测。

## 市场数据来源（2026-10 实测）

| 来源 | 端点 | 说明 |
|---|---|---|
| 官方 Registry | `registry.modelcontextprotocol.io/v0/servers` | 记录**按版本存储**（一条一个 version），因此全量翻页约 7242 条记录对应 2582 个 server；插件按 `_meta.io.modelcontextprotocol.registry/official.isLatest` 去重（无该标记时退到 `updatedAt`，再退到版本号），翻页后保留每个 server 的最新记录。安装信息取 `packages`（npm→`npx`，其他→`uvx`）或 `remotes`（streamable-http）；作者取 `namespace` |
| Smithery | `registry.smithery.ai/servers` | 使用 `displayName`；`useCount`→使用次数、`iconUrl`→卡片图标、`verified`→认证徽标；安装走 `npx -y @smithery/cli run <qualifiedName>` |
| Docker MCP Catalog | `hub.docker.com/v2/repositories/mcp/` | 约 245 个命名空间镜像，安装走 `docker run -i --rm mcp/<name>`；`pull_count`→使用次数（这个列表上比 Star 更可靠的流行度信号）；官方镜像标 ✓认证 |
| Awesome 远程 | `raw.githubusercontent.com/punkpeye/awesome-remote-mcp-servers/main/README.md` | **托管端点**清单，条目形如 `- [标题](主页) \`https://端点/mcp\``，反引号里的 URL 可直接装成 streamable-http；🔓 免登录 / 🔐 需凭据，转成标签 |
| Awesome 清单 | `raw.githubusercontent.com/punkpeye/awesome-mcp-servers/main/README.md` | 社区索引（200+ 条），解析 `### <emoji> <分类>` + `- [owner/repo](url) [glama 徽标] <语言/范围/系统 emoji> - 描述`；跳过 `![...]` 徽标图，取真正的仓库链接；作者/头像取 GitHub owner。仅发现 + 仓库链接（无法安全推断启动命令，显示「需手动配置」） |

> PulseMCP 的公开 API 已被上游日落（`v0beta` 返回 410 `API_SUNSET`，其他路径 404），因此**不再是默认来源**；适配器保留但默认不启用。Glama 的 API 需要 API Key，也未纳入。
>
> 评估过但未纳入的来源：
> - **npm search**（`registry.npmjs.org/-/v1/search`）：无鉴权时 `popularity` 评分恒为 1，无法区分真正的 MCP server 与泛泛提到 mcp 的包，噪音过大；
> - **GitHub topic search**：未认证仅 10 次/小时，且 `topic:mcp-server` 下混入 n8n、gemini-cli 这类并非 MCP server 的仓库。
>
> 同名服务器跨目录合并：以 GitHub 仓库作为共享身份，若同一仓库同时出现在多个目录中，只保留一条（优先可安装的那条），并在 `sources` 中记录全部来源。官方 Registry 与两个 Awesome 清单之间靠仓库 URL 互相去重，Docker 与远程端点各自独立。

## 数据

- `$DSH_HOME/overall-mcp/registry.json` — 注册表（权威）
- `$DSH_HOME/overall-mcp/scan-report.json` — 最近一次扫描报告
- 市场列表在内存中缓存 10 分钟（只缓存原始数据，"已安装"标记每次读取时重新计算）
- GitHub Star 补充数据缓存 6 小时（失败结果同样缓存，避免反复冲击 GitHub 的未认证额度）

## 安全

- 扫描只读白名单文件；stdio env 只引用变量名，不展开宿主机密值。
- 市场条目安装前在界面/工具结果中可见启动命令与来源，由用户确认。
- 本地插件，无对外 HTTP 面。

## 开发

```sh
node --test test/scanner.test.mjs test/catalog.test.mjs test/schema-guard.test.mjs test/updates.test.mjs test/media.test.mjs
                                                          # 纯逻辑测试（lib/ 零依赖，80 例全过）
node tools/client-smoke.mjs                               # 客户端注册契约 smoke（模拟前端 module loader；并断言客户端版本号 == package.json）
node tools/render-detail.mjs                              # 渲染详情页：事实表有值、链接齐全、命令可见
node tools/render-card.mjs                                # 渲染卡片：标题是链接、正文不是 button、无嵌套交互元素、GitHub 标记/版本在位
node tools/render-market-tab.mjs                          # 渲染整个市场页 chrome：页头、页签计数、统计行、分页、卡片流、页脚分工
node tools/verify-css.mjs                                 # 校验所有 className 在注入的样式表里都有对应规则
node tools/layout-probe.mjs                               # 真实 Chrome 量卡片几何：长名称必须省略号、CTA 必须在卡内（npm run test:layout）
node tools/preview-paged.mjs "<base-url-with-?token=…>" 20 1 installs
                                                          # 按设置页的方式渲染某一页（可带 pageSize/page/sort/group，group 如"金融支付"/"__none__"）
node tools/verify-sort-paging.mjs                         # 校验 5 种排序、3 种页宽、越界夹取、紧凑计数
node tools/verify-detail-links.mjs                        # 校验详情页链接：逐源覆盖、零死链、零重复 URL
node tools/probe-real-cards.mjs                           # 拉真实市场条目逐条渲染卡片+详情（活实例）
node tools/probe-media.mjs <token>                        # 实测 /repo-media：五个真实仓库的图片数/尺寸/缓存命中耗时
node tools/probe-favorites.mjs <token>                    # 收藏闭环实测（活实例：POST /favorite → /catalog 回读）
node tools/measure-awesome.mjs                           # 测量两个 Awesome 清单的真实深度（4224 + 928）
node tools/measure-sources.mjs                           # 逐源测上游返回条数（分页与截断的真相）
node tools/inspect-dsh-catalog.mjs [pkg]                 # 剖析 dshmarket 的 dsh-plugin-catalog 包结构
node tools/probe-sources.mjs                              # 探测各市场端点可用性与响应形状
node tools/probe-mcp-schema.mjs -- <cmd> [args...]        # 体检某个 MCP 服务器的工具 schema
node tools/dump-mcp-tool.mjs <tool> -- <cmd> [args...]    # 打印某个 MCP 工具的原始 schema
node tools/fixture-bad-schema-mcp.mjs                     # 故意带 `^[^\0]*$` 的测试用 MCP 服务器
```

| 文件 | 职责 |
|---|---|
| `lib/scanner.js` | 宿主机 MCP 配置扫描与规范化（纯函数） |
| `lib/catalog.js` | 5 个远程开放目录的拉取、归一化、跨目录合并、排序与 GitHub 补充（纯 fetch） |
| `index.js` | cordis 宿主插件（`inject:['tools']`）：注册表、每服务器 `ctx.plugin(mcpClient)` 桥接、`defineTool` 管理工具、HTTP 路由 |
| `client/client.js` | `__ModuleLoader__` 客户端插件：`settings.section` 插槽展示区块 |
| `cordis.patch.yml` | 宿主 composition 补丁 |

## 市场来源配额（每次浏览的实际上限）

| 来源 | 上游请求 | 读取条数 | 说明 |
|---|---|---|---|
| 官方 Registry | 8 | 800（去重后约 220 个 server） | 单页上限 100，按 `nextCursor` 翻页后按 `isLatest` 去重 |
| Smithery | 1 | 10 | 上游列表本身只返回 10 条 |
| Docker MCP Catalog | 3 | 300 | `hub.docker.com` 分页，`next` 为空即停；网络封锁期 403/超时，该源降级、其余源不受影响 |
| Awesome 远程 | 1（+镜像链） | 1000 | 单个 README，实测 928 行；经镜像链获取（见上节） |
| Awesome 本地 | 1（+镜像链） | 5000 | 单个 README，实测 **4224** 行；经镜像链获取（见上节） |

默认一次浏览约 15 个上游请求，聚合 **5364 个去重 MCP**（2026-10 实测），结果内存缓存 10 分钟；单来源筛选时只请求该来源。

> 两个 Awesome 清单必须整份读取：它们合计约 5150 条，而读取其中 200 条与读取整份的请求数完全相同（都是 1 次）——之前市场只有 551 条，正是因为把社区清单截断到了 200。

## 仿照 dshmarket 的取舍

对照 `dshmarket` 的插件市场（4508 条来自 `dsh-plugin-catalog` npm 包，由 awesome-dsh-plugin.com 每日构建），逐项评估后**搬了这些**：

| 机制 | dshmarket | 本插件 |
|---|---|---|
| 废弃标记 | 目录提供 `deprecated` + `replacement` | ✅ 采用，但只认上游真实发布的信号；缺省时显示"未提供"而非"正常" |
| 流行度口径 | 下载量带统计区间 + 核对时间，放 Tooltip | ✅ 采用：每个数字带自己的单位和窗口（见上） |
| 能力标记分组 | 按"触及什么"分组，明确拒绝打分 | ⚠️ 见下 |
| 双语描述 | 上游提供 | ❌ 不可搬：除官方 Registry 有 title 外无上游双语数据 |

**能力标记没有照搬**，原因是适配性：dshmarket 的 `capabilities` 来自对 DSH 插件产物的静态扫描（一个 npm 包、可下载、可分析）；而 MCP 侧的五个源里，官方 Registry 只给元数据、两个 Awesome 清单只给一行 markdown，**没有可扫描的产物**。要对 MCP 做等价扫描，得先下载安装包再分析，那会把市场浏览变成一次安装前的深度审计——成本和风险都不对等。因此本插件选择在**安装前**展示完整的启动命令与来源（`index.js` 的 `doInstall`），把判断留给用户，而不是伪造一个未扫描的"安全"结论。


## 常见问题

**「MCP 市场」显示 `HTTP 404` / 一直停在「正在发现…」**

宿主插件的代码在 DSH **启动时**载入一次。若在 DSH 已经打开的情况下更新了插件（本插件用 `link:` 安装在工作区时尤其常见），设置页里的前端是新版、而宿主仍是旧版，`/api/overall-mcp/catalog` 这个路由就还不存在，于是返回 404。

- 完全退出 DSH（桌面版注意托盘图标，关窗口不等于退出）后重新打开；
- 新版设置页会直接把这种情况提示为「宿主插件还是旧版本（缺少 /api/overall-mcp/catalog）」，而不是只显示一个 404。

**市场里某条显示「需手动配置」**

该来源只提供仓库地址（社区 Awesome 清单即如此），无法安全推断启动命令。点「仓库」按该项目的 README 自行配置；官方 Registry 与 Smithery 的条目通常可直接「安装」。

## License

MIT



