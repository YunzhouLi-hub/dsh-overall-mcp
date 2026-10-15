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
| 🖥️ | 侧栏页面 | 左侧导航「插件」正下方的 **全局 MCP** 入口：**已注册**（按来源分组、可折叠、分组开关、统计筛选）与 **MCP 市场**（浏览/搜索/安装）两个标签页 |
| 🎛️ | 分组批量启停 | 每个来源分组一个总开关，一次启用/停用该来源的全部服务器（模型工具 `overall_mcp_set_source_enabled` 同能力） |
| ⬆️ | 版本检查与更新 | 对经 `npx`/`uvx`（含 Windows `cmd.exe /c` 包装）启动的服务器检查 npm / PyPI 最新版本，「已注册」页一条 `全部更新（N）` 串行更新并自动重连，带条目级进度与逐条明细，跑完无剩余项时变为绿色 `✓ 已完成` |

## 快速开始

```sh
dsh plugin --profile web add ./dsh-overall-mcp
```

重启 Profile 后：首次加载自动扫描宿主机 MCP 配置；点左侧导航里 **插件** 下面那个 **全局 MCP**。

页面是侧栏里的一个**全局面板**（不是设置项，也不是插件页里的配置区）：侧栏图标行由 `sidebar.panellist` 列表插槽注册（`order: 5`，官方「插件」页是 0、「任务」是 10，所以本入口正好在「插件」正下方），面板本体注册在布局的 `main` 键控插槽里，两者共用同一个 id `overall-mcp`；`main` 用不存在的 key 选中会抛错，所以这两个字符串必须一致，`tools/client-smoke.mjs` 会把它们钉在一起。页面自己就是滚动容器（居中、最宽 1180px），顶部内边距叠了 `--dsh-frame-top-clearance`，避免在 macOS 红绿灯／Windows 标题栏下面被盖住。

### 「已注册」标签页（对齐 Skills Manager 来源分组）

- 顶部统计：`N 台服务器 · M 已启用 · K 已停用 · C 已连接 · X 连接异常`
- 筛选：来源下拉、状态下拉（已启用/已停用/已连接/连接异常）、名称搜索
- 分组：按导入来源聚合（Claude Desktop / Claude Code / Cursor / VS Code / Windsurf / Codex CLI / Gemini CLI / 官方 Registry …），每组显示数量与"已启用"计数，右侧总开关批量启停，点击组头折叠/展开
- 每行：连接状态点、名称、**用途行**、事实行（传输方式 · 状态 · 工具数 · 工具前缀 `mcp__<serverName>__` · 包名版本）、启用/停用、移除
- **写者串行、原子落盘、工具说真话（第十二轮）**：这一轮修的是「宿主自己的账本」——审核时发现的都是同一类问题：**文档/工具描述说的和代码做的不一致，而失败的样子和成功长得一样**。
  1. **一次只让一个写者改注册表**：宿主每个「读整份注册表 → await（扫盘 / 起 npx / 查 npm）→ 写回」的动作（扫描、安装、启停、来源总开关、移除、清理来源已删除、检查更新、更新、收藏）现在排在同一条 promise 队列上（`serialized()`，`index.js`）。交错的两次「读-改-写」会让后一次写回它开始时的快照，把前一次的改动丢掉（例如一次早于安装开始的扫描，结束后会把刚装的那条覆盖掉）。读路径（列表、市场）不进队列，仍然并行。
  2. **落盘走临时文件 + rename**（`writeJson`）：原来注册表是就地 `writeFile`，写一半崩掉就留下半截 JSON——而这是唯一一份「丢了就所有服务器都挂不上」的文件（`lib/installs.js` 早就用了临时文件 + rename，注册表反而是漏的那个）。
  3. **坏文件不再被当成首次运行**：`readJson` 的「解析失败 → 返回空」换成 `readRegistryDocument()` 的三态——没有文件（真正的首次运行）、**解析失败（损坏）**、正常文档。损坏时先把原文件复制成 `registry.json.corrupt-<时间戳>`，再把原因随每个列表响应带给面板，在页签上方显示一行红字。旧行为下「读不出来」和「你从没加过服务器」完全一样，而随后的第一次保存会把用户唯一的一份覆盖成空注册表。
  4. **扫描不再清空收藏**：`favorites` 和 `servers` 在同一个文档里，而 `mergeIntoRegistry` 只返回 `{version, servers}`，调用方又保存它的返回值——一次扫描就会把所有星标清掉。现在它保留自己不负责的顶层键（单测 `mergeIntoRegistry keeps the document keys a scan does not own`）。
  5. **安装不覆盖手工条目**：`source: manual`（或没有 source）的行是用户自己写的配置，扫描器一直保护它，只有「从市场安装」这条路会把它连同命令、args、env 一起替换掉，还回报成功。现在冲突返回 **409**，要用 `overwrite: true` 明说；`overall_mcp_install` 与 `/install` 都接受这个参数。
  6. **失败安装不计数**：「本市场 N 次」现在只在**挂载成功之后** +1。进了注册表但没挂起来的条目仍然留着（用户能修好再重试），但返回体会带 `counted: false` 和一句说明，而不是像成功一样回答。
  7. **来源总开关按名字收敛**（`syncFiber`）：关掉一个来源时，同名条目可能还属于别的来源，那个来源没关就不该把它的 fiber 拿走。旧循环逐行断开再逐行重连，会把不属于这个来源的同名行的工具一起带走。
  8. **工具描述与参数对齐代码**（`overall_mcp_scan` 不再声称「同名不同契约会改名导入，绝不覆盖」——改名导入早在 `820641c` 就删了，现在是同名原地更新、手工条目不动）；`overall_mcp_update` 补上 `slot`/`from`，而且**同名不唯一时报错而不是取第一条**（此前只有面板能指明是哪一行，agent 只能猜，更新错行的结果还回报「无需更新」）；`overall_mcp_remove` 的「不带 `slot` 就删第一条」改成同一套 409 语义。
  9. **宿主契约有了单测**：`test/index.test.mjs` 用假宿主跑 `apply(ctx)`（mount 必定失败，正好走容错路径），覆盖路由/工具面、同名行的拒绝与 `slot` 命中、手工条目 409 与 `overwrite`、失败安装不计数、损坏注册表被隔离并上报、以及工具参数与文案。两个宿主 peer 依赖（`@deepseek-ai/dsh-tools`、`@deepseek-ai/dsh-mcp-client`）本仓库不安装，由 `test/hooks.mjs` 映射到 `test/stubs/`；每个用例一个临时 `DSH_HOME`，绝不碰真实 `~/.dsh`。`package.json` 的 `test` 脚本是显式文件列表，这个文件也已列进去（否则新增测试会被静默跳过）。
  10. **面板能看见注册表坏掉**：`registryError` 随 `/servers` 返回，页签上方显示「⚠ 注册表文件无法解析（…），本次以空注册表启动；原文件已备份为 registry.json.corrupt-…」——空的列表不再等于「你从没加过服务器」。
- **用途行（第十一轮）**：用户要求「MCP下载好之后后面的应该是解释这个MCP的作用」——一行只说 `stdio · 已连接 · 工具前缀 mcp__x__` 等于没说它是干什么的。宿主现在按**证据强度**取一句人话（`lib/about.js`，上限 150 字符、渲染两行）：
  1. **服务器自己的说明**（`source: 'server'`）：MCP `initialize` 结果里的 `instructions`。dsh-mcp-client 把它**原样**发布成 system prompt 的 `mcp:<serverName>` 节（`### MCP server: <name>` 前缀由它加，宿主会剥掉），所以宿主只要 `ctx.inject(['systemPrompt'])` + `assemble({})` 把这一段读回来，就是服务器自我介绍的原话——不是我们从名字猜的；
  2. **已注册的工具**（`source: 'tools'`）：服务器没写说明时的兜底，形如「工具：search、fetch、describe 等 4 个」（`ctx.tools.schemas()` 按 `mcp__<serverName>__` 前缀筛出）；
  3. **启动命令**（`source: 'command'`）：还没连上过的条目至少能看到将要运行什么。
  三者的取舍写在 `describeAbout()` 里，来源用 `aboutSourceLabel()` 标注成用途行的 `title`（「来自服务器自身的说明（MCP initialize）」/「根据该服务器已注册的工具推断」/「尚未连接，显示启动命令」），**不把推断伪装成事实**；三样都没有（连名字都推不出 serverName）就**不显示**这一行，而不是编一句。`lib/about.js` 还会剥掉行内 markdown（`###`、`**`、反引号、图片），跳过 `Tools:` 这类标签行与纯图片行——`instructions` 常常整段是 markdown 文档，第一段往往只是它的标题。
  重读规则（`needsInstructionsRead()`，单测 + 探针都钉住）：dsh-mcp-client **只在服务器连接期间**发布该节，所以「没找到」不能当成最终结论缓存——否则第一次读到的是启动命令、连上之后也永远不会换成服务器自己的说明。宿主记下**上次读取时该服务器的存活状态**，只有状态翻转（或从未读过）才重新 `assemble()`；`source: 'server'` 即终态，`tools`/`command` 只在服务器存活时按 30 秒节流重试，停用的服务器不再产生任何读取。宿主日志里每次补齐都会留一行 `overall-mcp: purpose lines — server N, tools M, command K`，用来核对每台服务器实际命中的是哪一种证据。探针：`tools/probe-server-about.mjs`（离屏渲染三行，断言用途行在事实行之前、被 clamp、`title` 与证据一致）

### 「MCP 市场」标签页（自动发现市面上的 MCP）

- 打开即自动拉取**整份市场列表**（全部 ~5.4k 条一次载入：上游成本与小切片完全相同，本地载荷 ~3MB；每个来源各 60 秒 TTL，可手动「刷新」）
- **抓取本身是有条件的**：每个上游 URL 记住自己上一次的 `ETag`，下一次带 `If-None-Match` 去问；上游答 `304` 就直接复用本地那份正文，连 JSON 都不重新解析（GitHub raw / jsDelivr / 官方 registry / Smithery / Docker 都支持）。源级 TTL 内连问都不问；TTL 过了才去问，而问的结果又常常是 `304`。元信息行会把这件事实写出来：`更新于 12:34:56（缓存）· 3 源未变`——否则「刚刷新过」和「问了、上游说没变」在界面上长得一模一样
- 抓取**失败时保留上一次的那份列表**（标 `stale`，条目照常可用），同时把错误照报给界面；冷启动失败才真的报空。上游抽风不该让整个市场页变空
- 总数以紧凑形式显示：`5.3k 个可用 MCP`（5364 → 5.3k，**截断而非四舍五入**，避免标题数大于真实条数）
- **市场页三段式 chrome**（按 v4 原型）：① 一整行搜索胶囊（🔍 + 输入框 + 右侧「搜索」按钮，回车即搜）；② 分类 chip 行（可横向滚动）+ 同一行右端的紧凑筛选控件（来源下拉 / 排序下拉 / 刷新，描边小按钮样式，不是大蓝块）；③ 灰字元信息行 `5.3k 个可用 MCP · 第 1 / 1 页 · 每页 20 条`，右端是缓存时间；各来源条数与已安装数退到下面一行更轻的灰字——控件是一行，数字是另一行，互不挤占
- 统计：各来源条数 · 已安装数 · 当前页码 · 缓存时间。各来源那一行现在带**每个源自己的时间与状态**（`官方 800（12:03）· acme/mcp-registry 42（缓存 12:01）· …`）：每个源有自己的 TTL 和验证器，所以它们是**各自变旧**的，一个时间戳说不清五份上游
- **排序**（用户自选，切换即生效，不重新请求上游）：
  - `默认（综合推荐）` — 质量分：已认证(400) > 官方(300) > 可安装(120)，再加 log 量纲的流行度（`installs` 与 Star 各最多 +200）；已废弃 −500
  - `质量最高` — 与默认**同一个**加权分。下拉把它单列，是为了让标签承诺的排序真的被应用，而不是一个和默认同序的空选项
  - `使用量最多` — 按**合并后的使用量**倒序：Smithery 的调用次数 + Docker 的拉取次数 + 本面板的安装次数。三者单位不同（`lib/catalog.js` 自己也标注为不可比），因此它只是热度参考；下拉的悬停提示与列表上方的提示行都写明了这一点
  - `Star 最多` — 按 GitHub Star 倒序
  - `最近更新` — 按 `updatedAt` 倒序
  - `名称 A→Z`
- **分页**：每页 20 / 50 / 100 条三档可切，带「« 首页 / ‹ 上一页 / n / N / 下一页 › / 末页 »」。5364 条在每页 20 下为 20 页、50 下 8 页、100 下 4 页
- **功能分类**（下拉选择，不是 chip 行）：筛选行左端是「分类 + 下拉」——「全部分类 (N)」开头（总数只在它上面显示），随后是功能组（不带数量、仍按数量降序排列），「未分类」收尾；右端是来源 / 排序 / 刷新，用 `margin-left:auto` 贴到行尾，所以分类与筛选之间是行内的空白而不是固定的 8px。19 个功能组放不进一行：早先的横向滚动 chip 行永远有一半看不见，换成换行的 chip 行又会撑出三行「表单感」，因此改成原生下拉。75 个上游 `###` 标题（两清单合计，含同义异名如 Finance / Finance & Fintech、两个 Multimedia）归并为 **19 个功能组**（金融支付、开发工具、办公协作、搜索与知识、营销与客户、多媒体创作、数据与存储、安全与身份、聚合网关、出行与生活、商业与法律、云与运维、其他、社交媒体、自然环境、浏览器自动化、医疗健康、游戏娱乐、语音与语言）。归并在宿主完成（`group` 字段），上游原标题保留在条目上（`category` + 卡片第一个标签）用于溯源；未映射的新标题兜底进「其他」而非消失；三个 registry 不发布类目，其条目归入「未分类」桶；合并记录时类目跟随存活（Smithery 赢得合并的条目仍能按功能组筛出）
- 排序、分类与分页都是**视图层**行为：宿主一次返回整份列表，翻页/换排序/切分类不产生任何上游请求- 任一字段缺失的条目不会因此排到最后——缺失不等于 0：有数字的条目优先于无数字的，两者皆无时回落到质量分
- **「未分类」为什么这么多，以及怎么减少**（第十轮）：五个来源里只有两个社区清单带类目（它们的 `###` 标题），**Smithery 与官方 registry 一个类目字段都不发**——实测（2026-10-14）Smithery `/servers` 只发 `id, qualifiedName, namespace, slug, displayName, description, iconUrl, verified, useCount, remote, isDeployed, unlisted, inactive, createdAt, homepage, bySmithery, owner, score`，官方 `/v0/servers` 只发 `name, description, title, version, remotes, packages`。这两类合计 233 条（约 5.4k 条里的 4%），但默认「综合推荐」排序恰好把它们排在第一页（官方 + 认证的 Smithery 条目质量分最高），所以首屏曾经 100% 是「未分类」。现在宿主对**没有上游类目**的条目做一次**关键词推断**（`lib/catalog.js` 的 `inferGroupOf`：19 组词表 + 标题双权重 + 词组越长越优先，`\b` 只加在词首以免 `\bspreadsheet\b` 匹配不到 `spreadsheets`；刻意不收 `server` 这种词——每条都是 MCP server，会把「招聘」的 DevMatch 拖进「云与运维」）。实测官方 registry 抽样 100 条里 **78 条**得到分类、Smithery 10/10；匹配不到的仍然老实显示「未分类」（`其他` 的语义是「上游说了但我们归不了」，与「我们不知道」不同）。推断结果带 `groupSource:'inferred'`，卡片胶囊的悬停提示写「分类（按名称与描述推断）：…」，绝不把我们的判断伪装成上游事实。单测见 `test/catalog.test.mjs`（真实条目做样本：Brave Search→搜索与知识、Gmail/Google Sheets→办公协作、DevMatch→商业与法律、匹配不到→未分类）
- **本市场安装计数**（第十轮）：上游的使用量只覆盖 Smithery（`useCount`→次启动）与 Docker（`pull_count`→次拉取），谁都不统计「从本面板装的」。用户要求「下载量以后从我们市场下载的也要统计一下」，因此宿主新增 `lib/installs.js`，把每次**成功**安装记到 `$DSH_HOME/overall-mcp/installs.json`（键就是目录条目的 `id`，和卡片、收藏、安装按钮用的是同一个；无 id 时回退成 `name:<服务器名>`；写盘走临时文件 + rename，缺文件/坏文件都退化成「还没装过」而不是抛错）。面板上它是**第二条序列**：卡片统计行显示「⤓ 3 本市场」（悬停给出最近一次安装日期），详情面板有「本市场安装」一行；只有当**排序**用「使用量最多」时两者才相加（`usageOf()`），因为那个问题问的是「这东西有多常用」，而对那 233 条上游不发数字的条目来说，我们自己的安装就是唯一的证据。单测见 `test/installs.test.mjs`（计数递增/首次时间不动/坏文件容错/键回退/写读往返 + 不留临时文件）
- **卡片墙是「行优先」的等宽网格，不是多列瀑布流**（第九轮）：`column-count` 的多列墙是**竖着**铺的（先把第 1 列填到底再开第 2 列），于是排好序的列表读起来是「顺着每列往下」——用户选了「使用量最多」后横向扫一眼看到 87.5k / 9.1k / 无数据，就断定排序没生效（实际每列内部都是降序，第三个来源根本没发布使用量），并明确要求「应该是从左到右排序而不是从上到下的排序，这样第三列都是最后的」。现在 `.omkt-grid` 是 `display:grid` + `grid-template-columns:repeat(N, minmax(0,1fr))`（N 由容器查询给出，内联的 `repeat(2, …)` 是没有容器支持时的兜底），卡片按行从左到右铺、名次 `#1` 落在左上角。两个要点：① 必须是 `minmax(0,1fr)` 而不是裸 `1fr`（裸 `1fr` 会被最宽卡片的 min-content 顶开，墙的最小内容宽度从 12082px 降到 14px）；② 行的对齐**不是** `align-items:start`——那样一行的矮卡片下面会留个洞（fixture 里那张超高卡片留了 300px），所以用默认的 `stretch` 把整行拉齐，再由卡片自己的 `grid-template-rows:1fr auto` 把富余高度放在正文与页脚之间，页脚始终贴在卡片底边；卡片正文的 `alignContent:start` 保证这些富余不会摊到正文各行之间。`tools/shot.mjs` 的列数断言随之从 `getComputedStyle(grid).columnCount` 改成数 `gridTemplateColumns` 的轨道数（两种窗口盒子：1140px→3 列、820px→2 列）
- **排序必须看得见**（第六轮修复，第九轮改口径）：① 一旦选了非默认排序，每张卡片页脚最前面出现 `#1 #2 #3…` 名次胶囊（`title` 写明「当前排序下的名次：第 N 名」，等宽数字对齐）；② 筛选行里**正在起作用的控件**（排序、来源、分类、注册表的状态/来源）显示为墨色边框 + 浅灰底（`omkt-select-on`），默认态不标记；③ meta 行写出「按使用量最多排序」（`title` 补充「名次从左到右、再下一行；没有该项数据的条目排在后面」）。另外这些控件的 inline `border` 会盖住样式表里的 `:hover`/`:focus` 规则，所以注入样式表里的悬停/聚焦规则都带 `!important`；搜索胶囊没有自己的边框（边框画在胶囊上），聚焦时用 `.omkt-search:has(.omkt-input:focus-visible)` 把胶囊本身染成墨色。`tools/render-market-tab.mjs` 现在直接驱动真实 `<select>`：断言「使用量最多」把卡片按 installs 降序重排（缺失项垫底）、名次胶囊是 `#1 #2 #3`、meta 行写出排序名、控件带上 `omkt-select-on`，并断言分类下拉原地收窄为 1 张卡、来源下拉会带 `source=` 重新问宿主
- Star 补充只覆盖**当前页**可见的仓库，翻页不重复消耗 GitHub 额度
- 统计：`N 个可用 MCP · 官方 x · Smithery y · Docker z · 远程 a · Awesome b · 其中 M 个已安装 · 更新于 时间`；整份列表来自缓存时时间后面缀「（缓存）」，本次有来源答 `304` 时再缀上「· N 源未变」
- 来源筛选：全部市场 / 官方 Registry / Smithery / Docker MCP Catalog / Awesome 远程 / Awesome 清单；支持关键词搜索（关键词同样匹配安装命令，搜 `docker` 或端点域名也能命中）
- **自定义目录源**：市场不再只有编译进来的那五个来源。市场页有一块可折叠的「目录源」——内置五源列出**各自的条数与时间**，下面是你自己加的源（标签 / 地址 / 条数或错误 / 移除），底部是地址输入框 + 「添加」。宿主把它存在 `$DSH_HOME/overall-mcp/sources.json`（`{version:1, sources:[{id,label,url}]}`，写盘走临时文件 + rename；文件读不出来时面板照报原因，内置五源不受影响），**只接受 https**：地址里的安装命令会被本机执行，所以 `http://` 和带用户名口令的地址在入口就被拒；最多 8 个；重复地址报 409、非法地址报 400、删除未知 id 报 404——三种都在面板上原样显示，不吞成「失败」。源的 id 由宿主签发（`custom:<host+path 的 slug>`，≤48 字符），标签默认从地址推（GitHub raw / jsDelivr 能解析出 `owner/repo`，否则取主机名），也可以自己给。一个自定义源与内置源**完全同权**：它出现在来源下拉里、能单独筛（`/catalog?source=<id>`）、参与合并与排序，抓取同样走 ETag/304 + 60 秒 TTL，失败同样保留上一次的清单并标 `stale`（错误照报）。移除一个源只是把它从下一次抓取里拿掉，并顺手丢掉它的缓存行——正在显示的列表要等下一次刷新。这一块需要新版宿主：旧 bundle 上这里写明「需要新版宿主插件」，而不是显示成一个空列表
- **卡片形式**呈现（与 dsh-market 插件一致）：图标（Smithery 图标 / GitHub 头像，缺失时用首字母色块）、**标题即入口**（有仓库链仓库、否则链上游官网、Smithery 条目链其目录页——与 dshmarket 卡片名一致的真锚点；卡片正文是 div 而不是 button，链接不会和点击详情打架）、标题旁**GitHub 标记**（只在 `repository` 真的是 GitHub 仓库时出现，悬停才上色）、作者行末尾的**版本**、✓认证/官方/已安装/已废弃徽标、三行描述、标签（分类 / 语言 / 部署范围 / 操作系统 / 仓库 topics）。悬停反馈通过注入的样式表实现（内联样式表达不了 :hover / keyframes / 宽度断点）：卡片描边高亮、主按钮不透明度、详情弹窗入场动画
- **卡片布局**：按 `frontend-card-style-v4.html` 原型——卡片左右分栏（左内容 / 右「安装 + 详情」，右列**右对齐**贴在卡片右上角），下方是标签 + 收藏/⋯ 图标按钮的页脚（**无分隔线**，标签是描边胶囊而非灰底）；**收藏与 ⋯ 在正文外**，点星星不会顺带打开详情。卡片流用**行优先的等宽网格**砌墙（宽容器三列约 371px、中等两列、≤720px 单列；见下一条为何不是 `column-count`）。断点用**容器查询**（`@container`）而不是媒体查询：面板只是应用窗口里的一块，窗口 1600px 而面板 820px 时必须仍是两列——`tools/shot.mjs` 在一个 1600px 窗口里同时摆 1140px 与 820px 两个盒子来钉住这一点（内联 `repeat(2, minmax(0,1fr))` 只是没有容器支持时的兜底，`@media` 同理）。页面自己**不加水平内边距**：卡片区外面那层「板」已经是 20px 内衬，再叠一层就会把 1140px 的容器压到 1060px，正好掉出三列区间（1100px 是临界值）。整条宽度链（`page` → `tabBody` → `gridHost` → `.omkt-grid`）都显式写了 `min-width: 0`：它们都是网格项，默认的 `min-width: auto` 解析成 min-content——真机上这条链把自动轨道撑到 1891px（621px × 3 列）而页面只有 1180px，于是整页出现横向滚动条、第三列被推到屏幕外（`minmax(0,1fr)` 之后墙的 min-content 只剩 14px 的行间距）。更根本的修法是**轴的选择**：`page` 与 `tabBody` 现在都是 `display:flex; flex-direction:column`（而不是 `display:grid`）——列向 flex 的主轴竖直、横向不存在 `min-width:auto`，子项一律按容器宽度拉伸，所以墙宽恒等于可用宽度；这同时修掉另一个真机现象：`height:100%` 的网格会把隐式行**拉伸铺满整个面板**（`align-content: normal` 即 stretch），于是「刚切到 MCP 市场」的加载态里页头、页签、搜索框被摊在一屏空白上，列向 flex 把主轴内容压在顶部、剩余空间留在底部。`tools/shot.mjs` 因此有两组探针：**框架探针**（240px 侧栏 + 中栏、4 种窗口宽度，注入超长 URL、660px 宽幻灯片、94 字符长名字，外加一张 min-content 达 6000px 的卡片）断言「墙宽 == 可用宽度、页面无横向溢出、最宽卡片不溢出自身盒子、描述截断到 3 行」；**首帧探针**把目录请求挂起后冷启动渲染一次，断言「没有任何一行比自己内容更高」（旧版网格页面是 315px 的拉伸空白，现在 7px 取整误差）。两个探针各带一个反向自检开关（`OMKT_RED_FRAME` / `OMKT_RED_PAINT`），能把旧设计原样装回去，用来证明探针真的会失败。列向 flex 有一个必须显式关掉的行为：**主轴上的子项默认会收缩**，而页面是有确定高度的滚动容器——市场页内容很高时页签行是最便宜的可收缩项，于是它被压成 1px 的边框、「已注册」按钮消失，市场页变成单向门。所以注入样式表里有一条 `.omkt-page > *,.omkt-tabbody > *{flex-shrink:0;min-width:0}`，框架探针同时断言「页面每一行都保留自己的高度」（输出里的 `page rows [...]`；把旧行为装回去时页签行是 1px，探针立刻失败）
- **卡上的传输方式是一枚小 chip 而不是命令行**：v4 原型卡片只有 `MCP · stdio` / `MCP · remote` 这样的兼容性小标（`title` 仍是可执行命令，悬停可见），完整命令留给详情面板——每张卡再压一段等宽字体，正是原型刻意去掉的东西
- **卡片页脚先说事实，再说上游标签**：页脚的前两枚胶囊固定是「**分类**」（宿主机算出的 19 个功能组，`title` 补上游原标题）与「**安装方式**」（`stdio · npx` / `stdio · uvx` / `stdio · python` / `远程 · 免安装` / `需手动配置`，`title` 补完整命令或端点）。此前的页脚直接铺上游标签，而五个来源给 `tags` 打的根本不是一回事——Smithery 打「托管 / 本地」（是**托管形态**，既不是分类也不是安装方式）、官方 registry 打 `npm` / `pypi`（是包管理器，已被安装方式覆盖）、awesome 清单打自己的 `###` 标题（与分类重复）——于是卡片上出现了对读者没有信息量的「托管」。现在这四类标签不再作为胶囊出现（`category`、`托管`、`本地`、`npm`、`pypi` 以及等于分类的标签都被过滤），只保留真正补充说明的上游标签（最多 3 枚，`title` 标明「上游标签」）。断言在 `tools/render-card.mjs`：四类样本（官方 / awesome / Smithery / 远程端点）逐张检查前两枚胶囊的文案与 `title` 前缀，并断言「托管」不再出现
- **分类胶囊一定在，哪怕上游没给分类**：实测（2026-10-14，直接取两个上游的实时 payload）Smithery 只发 `id/qualifiedName/namespace/slug/displayName/description/iconUrl/verified/useCount/remote/isDeployed/unlisted/inactive/createdAt/homepage/bySmithery/owner/score`、官方 registry 只发 `name/description/title/version/remotes/packages`——**两者都没有任何类目字段**（`category` 来自 awesome 清单的 `###` 标题与 awesome-remote 的分类行）。这类条目因此显示**「未分类」**，与筛选下拉里的同名桶一致，而不是干脆不显示那枚胶囊（`title` 写明「该来源未发布功能分类」）。`tools/render-card.mjs` 与 `tools/render-market-tab.mjs` 各有一张「没有任何分类字段」的样本卡，断言它渲染出 `未分类`，并断言**每张卡都恰好带一枚 `title` 以「分类：」开头的胶囊**——这条断言此前是缺的，正是它让「页脚只剩安装方式」漏了过去
- **搜索框**：真正的搜索框是那一圈圆角胶囊（`width:100%` + 内边距 + 1px 边框），**必须写 `boxSizing: border-box`**——content-box 下它会比父容器宽出「内边距 + 边框」，而市场页现在是 `overflow:hidden` 的滚动宿主，于是胶囊右端连同里面的「搜索」按钮被裁掉（真机截图上按钮只剩 38px、文字被切一半）。同时所有按钮都带 `whiteSpace: nowrap` + `flexShrink: 0`：CJK 标签可以在字间换行，一个被压缩的 flex 按钮的 min-content 只有**一个字**宽，按钮会缩到比文字窄并把第二行裁掉。`tools/shot.mjs` 的框架探针为此加了三条断言——没有任何按钮裁切/换行自己的标签、没有任何控件越过市场页内容框、市场页自身 `scrollWidth == clientWidth`（`OMKT_RED_FRAME=1` 注入一个 2000px 宽的假行时立刻失败）
- **预览位放仓库自己的图**：v4 原型卡片中部是 3 张彩色预览图。没有任何 MCP 目录发布产品截图，编造占位图等于用装饰冒充信息，因此同一位置改放**该仓库自己的图**：优先 README 里引用的截图（按文档出现顺序，最多 8 张，`images.weserv.nl` 代理缩放并统一高度），一张都没有时退回 GitHub 的社交卡片（`opengraph.githubassets.com`，它就是这张卡在社交平台上的样子）；两者皆无就不渲染这一格（不硬凑装饰）。滚动条隐藏、`scroll-snap` 对齐，左右圆钮手动翻页、**永不自动播放**——阅读时图片自己走位是干扰。图片按仓库缓存到 `$DSH_HOME/overall-mcp/media.json`（TTL 7 天，最多 300 个仓库）
- **事实静态印在卡片上**（用户要求）：Star · 使用量 · 更新时间这些数字直接在卡片正面，不藏在轮播里——要等的数字就是没法比较的数字。来源名（官方 Registry / Awesome 清单 / Smithery）**排在数字行末尾的灰字**里，不占名行——名行只放标题、GitHub 标记和最多两枚徽标
- **收藏**：卡片页脚与详情面板都可收藏；宿主持久化到 `registry.favorites`，界面只本地改自己那份列表（为了一颗星重新拉 ~3MB 市场列表不值当下次浏览/安装/开会话会与宿主对齐）。市场筛选行有**仅看收藏 (N)**：对已加载列表做视图过滤，并在 `GET /api/overall-mcp/favorites` 报告的宿主总数大于可见数时说明差了多少（见「收藏」一节）
- **往清单里投稿**：如果这份清单住在 GitHub 仓库里（`raw.githubusercontent.com/owner/repo/...`、`cdn.jsdelivr.net/gh/owner/repo@...`，或直接一个仓库地址），那一行右侧会出现「投稿 ↗」——它打开的是**已经预填好字段**的 `issues/new` 页面（`?title=&body=`，零令牌、零后端），提交后由仓库里的工作流校验并写回 `registry.json`。托管在别处的清单不显示这个链接（没有可投稿的地方），面板不会画一个点了没用的按钮。详见「投稿到社区清单（GitHub 上行）」
- **页面头**（按 v4 原型，两行）：第一行 = 星座图标（一个品牌蓝中枢 + 五个 `currentColor` 卫星，深色主题自动反色）+「全局 MCP」+ 版本号（与 `package.json` 一致，`tools/client-smoke.mjs` 断言两者相等——会撒谎的版本号比不显示更糟）｜右侧主操作；第二行 = 副标题「宿主机扫描 · 市场发现 · 一键接入」｜右侧「⤓ 导出日志」。主按钮是**墨色**（`T.text` 铺底 + `T.cardBg` 作字色，深浅色主题自动翻转）而不是品牌蓝：品牌蓝留给链接、页签下划线、徽标和 gh 仓库名
- **每个标签页最多一个主操作**：注册表页主按钮是「重新扫描宿主机」；市场页**没有主按钮**——重拉目录是「分类」那一行里 `刷新` 的活，一个常驻的填充按钮会和小按钮重复。另一页的主操作以无边框文字按钮留在同一行（「打开 MCP 市场」/「重新扫描宿主机」），两个主按钮等于没有主按钮。**本插件自己的更新不属于任何一个页签**：它跟着版本号走（页头 `全局 MCP v0.1.0` 右侧），「检查更新」报出新版时才出现，点了走 `POST /self-update`（宿主执行 `dsh plugin --profile <p> add dsh-overall-mcp@<v>`，装完提示重启 DSH 生效）——插件自身的版本判定见 `lib/self-update.js`：`link:`/本地检出（正是本仓库的开发形态）**不提供**自更新，因为那份代码就是版本来源，`npm` 上的新版本与它无关
- **⤓ 导出日志**：把这一页知道的东西写成 JSON 文件（插件版本、注册表全量、市场各源条数/**每个来源各自的时间/是否命中缓存/是否 stale/是否 304/返回条数**/未变更来源数/返回条数、当前筛选与页码、两处错误）——排查问题时缺的正是这些。客户端本地拼装并下载，不新增宿主路由：宿主自己的日志不归这个插件导出
- **只有卡片区滚动**：这一页是**固定外壳**（`height:100%` + `overflow:hidden`，自己不滚），滚动属于内部两个盒子——「已注册」的标签页主体整段可滚；「MCP 市场」里只有**卡片区**（`data-omkt="scroller"`，`flex:1 1 auto` + `min-height:0` + `overflow-y:auto`）可滚，搜索框、分类下拉、筛选行与 meta 行都是钉住的 chrome，翻页条留在滚动区下方。`tools/shot.mjs` 的框架探针把这条契约量出来：把卡片区往下拖 240px 后，页签行与搜索框的 `top` 位移必须为 0，页面外壳的 `scrollTop` 必须为 0（四种窗口宽度下实测 0/0/0）。注意 flex 的自动最小尺寸在**滚动容器**里会失效（这正是当初页签行被压成 1px 的原因），所以 chrome 行统一 `.omkt-page > *,.omkt-tabbody > *{flex-shrink:0}`，而「该让出高度」的两个盒子用内联 `flex:1 1 auto` 明确覆盖
- **回到顶部**：监听挂在「本页内部第一个 `[data-omkt="scroller"]`，否则本页或它之上的第一个可滚动元素」（退化为 window），只在滚动超过 400px 后才出现，短页面不留一个死按钮。市场页签的滚动盒是卡片墙本身，**已注册页签的滚动盒是它的页体**（两者都带该 hook）——早先只有卡片墙带 hook，而页体是它的祖先，向上查找找不到，于是已注册页签上这个按钮从不出现。重新绑定的时机是「页签、市场列表、服务器列表任一变化」，因为卡片墙要等列表到达才存在（首次打开时若只按页签绑定，会绑到 window 且之后不再重绑）
- 操作：可安装的显示「安装」，已注册的显示「已安装」，只有仓库链接的显示「需手动配置」+「仓库」/「主页」
- **站外链接**：卡片标题/GitHub 标、详情页标题与仓库链接等外链默认**在右侧栏的浏览器标签页里打开**（`ctx.sidebarRight.openTab("browser", { params: { url } })`，与 DSH 自家 markdown 链接同一入口）；侧栏浏览器没注册时不动手，让 `<a target="_blank">` 继续走 Electron 的「交给系统浏览器」。带修饰键（⌘/Ctrl/Shift/Alt）或中键的点击一律不拦，属平台原生行为（新窗口/后台标签）。这些锚点仍保留 `target="_blank" rel="noreferrer"` 作为无 JS 回落
- **详情页**：点卡片主体或「详情」按钮弹出完整面板（按 v4 原型：680px、圆角 16、**一整张白纸**——页头不再是灰底带、底部只有一条分隔线），含：页头（头像 + 标题 + 贴着标题的徽标，关闭按钮在右上角）、完整描述（卡片只显示 3 行）、全部标签、**GitHub 仓库区块**（浅灰底卡片、owner/repo 锚点用品牌蓝、★ Star · Fork · Issue（含 PR）· Watch（订阅）竖排大数字带小标签、语言/许可证/最近推送/创建于事实行、归档警示；缺失数字保持缺失——没有任何目录发布 GitHub 数据，缺数字不等于 0，也不等于排最后）、逐项标注的**无底色事实表**（来源/作者/版本/传输/Star/使用量口径/更新时间（优先 GitHub pushed_at）/安装方式）、**将执行的确切命令**（stdio 为完整命令行，http 为端点 URL；标题右侧有**复制**按钮，成功显示「已复制」、两条复制路径都失败时显示「复制失败，请手动选中」而不是谎报成功）、按 URL 去重的链接组（官网 / GitHub 仓库 / **GitHub 镜像** / MCP 端点 / Smithery 页面）、底部「安装 + ♡ 收藏」。Smithery 的 `repository` 指向它自己的列表页而非上游项目，因此额外提供其目录页链接（实测 `smithery.ai/server/<name>` 308 到 `/servers/<name>`，直接用后者）
- **GitHub 镜像链接**：GitHub 在本网络环境下时通时断（实测连续数小时 TCP 超时后恢复 200）。实测（2026-10-12）`gh-proxy.com` 现已代理 github.com 仓库页面（200/640ms）——与 dshmarket 2026-09 实测的 403 相反，其注释明确要求"重新测量而非推断"。因此有仓库的条目同时提供直连与镜像两个链接，由用户择一
- **废弃标记**：上游标记为 deprecated 的条目不隐藏、仍可安装（有人可能需要旧版），但降到最后、显示橙色「已废弃」徽标、按钮改为「仍要安装」，并附上上游自己的 `statusMessage` 说明。目前仅官方 Registry（`_meta…official.status`）与 Smithery（`inactive`）发布该信号；两个 Awesome 清单没有生命周期字段，因此这些条目的 `status` 为**缺省**而非 `active`——界面不会把"没人扫过"显示成"正常"

### 投稿到社区清单（GitHub 上行）

自定义目录源解决了「读」，这一节解决「写」：别人怎么把**他自己**的 MCP 服务送进你这份清单。答案是**不经过任何本机服务**——清单住在哪，投稿就在哪发生：

| 角色 | 东西 | 位置 |
| --- | --- | --- |
| 清单仓库 | 已收录的条目（`{version, updatedAt, servers:[…]}`，就是市场读的那种文档） | `registry.json` |
| 清单仓库 | 一条 issue 进来就校验并写回上面那个文件 | `.github/workflows/registry-submission.yml` |
| 清单仓库 | 校验与写入的全部逻辑（无依赖，Node 直接跑） | `tools/registry-submission.mjs` |
| 清单仓库 | 人手填写的表单（字段与解析器一一对应） | `.github/ISSUE_TEMPLATE/mcp-listing.yml` |
| 投稿者面板 | 该清单那一行上的「投稿 ↗」→ 预填好的 `issues/new` | `lib/submission.js` 的 `buildIssueUrl` |
| 宿主 | 清单地址 → 它的 GitHub 仓库坐标 | `index.js` 的 `submissionTargetFor`（跟着 `/sources` 返回体走） |

工作流只做四件事，失败都留下可读的原因：解析 issue 正文 → 校验 → `--check` 复核整份清单 → 提交并在 issue 里回复。**投稿正文是不可信输入**，所以它既在解析时校验、也在写入前复核，而且整段正文只通过 `env:` 传给 shell，绝不插值进脚本（那是个注入面）。退出码就是控制流：`0` 收录/更新/无变化，`1` 校验不过（回帖列出原因，文件不动），`2` 程序自身出错（job 失败，不静默）。

可以单独跑：

```bash
node tools/registry-submission.mjs --body-file /tmp/issue.md                  # 只校验，不改文件
node tools/registry-submission.mjs --body-file /tmp/issue.md --write --comment /tmp/comment.md
node tools/registry-submission.mjs --check --registry registry.json           # 复核已提交的清单
npm run test:registry                                                         # 上面那条，进 verify
```

**投稿规则（`lib/submission.js`，单测 `test/submission.test.mjs`）**：名称与说明必填（120 / 600 字符）；**启动命令**（stdio）与**服务地址**（streamable-http）二选一，都填或都不填都被拒；命令上限 200 字符、参数最多 32 个（每个 120 字符）；命令与参数里出现 `|` `;` `&&` 反引号 重定向 或 `$()` 一律拒绝——这一行会在**别人的机器上**执行，一个需要 shell 的条目不是这个格式能承载的，宁可拒掉也不静默执行；仓库/主页只接受 https；标签最多 8 个；所有字段都剥掉控制字符（否则一个字段就能伪造出别的字段）。**同一份清单只保留一行**：先按仓库地址（`github.com/owner/repo`，小写、去 `.git`）认，其次服务地址，最后名称；所以「编辑 issue 补个说明」是就地更新而不是新增第二份。写入按这个键排序（diff 小），而且**内容没变时连 `updatedAt` 都不动**——工作流据此判断「没有东西要提交」，编辑一次 issue 不会凭空产生一个 commit。

正文有两种形状，解析器都吃：GitHub 表单渲染出来的 `### 名称` + 值，以及面板预填链接里的 `名称: …` 行（表单里没填的可选项 GitHub 会写 `_No response_`，解析器当空值丢掉）。这条是**刻意**的：投稿者从哪进来都行，工作流不需要知道。未识别的 issue 一律忽略、不回帖（`action: ignored`）——普通 bug 报告不该被机器人搭话。

**订阅**：在面板「目录源」里加上 `https://raw.githubusercontent.com/<owner>/<repo>/<branch>/registry.json` 就完了（也可以直接填仓库地址，标签会从地址推出来）。合入后的条目会在 60 秒 TTL 内自动出现，与内置五源同权。

维护者注意：默认直提默认分支；那条分支若开了保护，把工作流里的 commit/push 换成开 PR（`gh pr create`）即可——审核就变成一次普通的 `registry.json` diff 审阅，这也是这个设计里唯一的「审核」环节。

### GitHub 不可达时的镜像链（实测）

这台网络环境下 github.com、raw.githubusercontent.com、hub.docker.com 会**整体 TCP 连接超时**，而两个 MCP registry 正常——此时 awesome 两源（占市场 96% 条目）会整体消失。两个清单因此按信任顺序走镜像链：`raw.githubusercontent.com` → `cdn.jsdelivr.net` → `fastly.jsdelivr.net` → `testingcf.jsdelivr.net`，四个镜像**同时起跑（Promise 竞速）**，第一个成功的胜出、其余中止——串行等待曾是市场首开慢的主因：GitHub 整体封锁时 raw 与 fastly 各 ~10s 连接超时，串行链要烧掉 ~25s 才轮到可达节点；竞速后健康网络仍是 raw 秒回（其余中止于半途），封锁期只付最慢**成功**镜像的成本而非失败之和（实测健康期 450ms 完成拉取）。

- 镜像链内**不做逐 URL 重试**：下一个镜像就是重试，叠加会把最坏情况翻倍
- 普通（非镜像）请求保留一次 1.5s 的快速重试，仅针对 `fetch failed` 类瞬态失败；超时不重试
- 结果按来源缓存 60 秒，并且每个镜像 URL 各自带 `ETag`（`If-None-Match` → `304` 复用正文），镜像链的成本被摊薄
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
- 「全部市场」默认按质量分排序（`默认（综合推荐）` 与 `质量最高` 用同一个加权分）；宿主在一次响应里按来源**轮转交错**返回（各目录体量差异极大，纯按上游顺序会把其中两个目录埋掉），而界面会对整份列表重排，所以默认视图最前面的是质量分最高的条目，不是来源轮转的结果；选单来源时同样按所选的排序（默认即质量分）
- GitHub Star 数是本地补充的：目录本身不提供，卡片先渲染，随后一次性补齐当前可见的 GitHub 仓库（最多 30 个，宿主缓存 6 小时）
- GitHub 未认证接口**每小时仅 60 次**且没有批量端点，因此宿主会读取额度状态：一旦耗尽即暂停补充并显示提示「额度恢复后会自动补齐」（额度是自首次请求起 60 分钟滚动恢复，不是整点重置）。Star 只是装饰，额度不足时卡片内容依然完整
- 配图（详情页轮播与卡片头像）同样来自外部（GitHub OG 图与仓库图片）：单个仓库取图失败时**不会**被当成「这个仓库没有图」缓存 6 小时，而是按 5 分钟短 TTL 重试，并把失败的仓库报给界面——市场页与详情页都会显示「配图加载失败（可能被 GitHub 限流）」和「重试」按钮

### 与 dshmarket 的 4508 条相比

dshmarket 的插件市场显示约 4508 条，但它**不是爬来的**：它读取发布在 npm 上的 `dsh-plugin-catalog` 包内的 `plugins.json`（约 5.4 MB），那是 [awesome-dsh-plugin.com](https://awesome-dsh-plugin.com) 每天流水线收录、构建并发布的产物，每条自带 `stars`、`downloads`、`capabilities`（权限标记）和双语描述。

MCP 生态目前**没有对等物**——没有站点把上千个 MCP 收录成同样结构化的产物。最接近的 PulseMCP（自称索引 8000+）公开 API 已日落，Glama 需要 API Key。所以本插件选择现场聚合开放 API：数字会随生态增长，字段来自一手来源，代价是 Star/下载量需本地补充、且受各上游限流约束。

## 模型工具

- `overall_mcp_scan` — 重新扫描宿主机 MCP 配置并导入（幂等，按名称去重；同名不同契约**原地更新**，手工添加的条目永不被覆盖，只报告为跳过。返回值含 `orphans`：这次读到的来源已经不再定义的行）
- `overall_mcp_list` — 查看本地注册表（来源、传输、启停、连接状态）
- `overall_mcp_catalog [query] [source] [limit] [refresh]` — 浏览 MCP 市场（可不带关键词），返回条目含 `installable` / `installed` / `author` / `tags` / `installs`
- `overall_mcp_search <query>` — 按关键词搜索市场（与市场标签页同源）
- `overall_mcp_install <item> [overwrite]` — 安装市场条目并连接（`npx -y <pkg>` / `uvx <pkg>` / streamable-http）。同名条目是**手工添加**的记录时拒绝安装（409），要带 `overwrite: true` 才替换它；挂载失败的安装不计数（返回值带 `counted: false`）
- `overall_mcp_set_enabled <name> <bool> [slot] [from]` — 启用/停用单台（停用即断开并卸载本插件挂载的那份工具；启用即重连）
- `overall_mcp_set_source_enabled <source> <bool>` — 按来源批量启用/停用（等同界面上的分组开关）
- `overall_mcp_check_updates` — 检查所有启用服务器的可用更新（npm / PyPI）
- `overall_mcp_update <name> [slot] [from]` — 更新到最新版（重写包参数为精确版本）并重连
- `overall_mcp_remove <name> [slot] [from]` — 删除本插件的注册表条目并断开它挂载的那份

`overall_mcp_update` / `overall_mcp_remove` / `overall_mcp_set_enabled` 在**同名多条目**时必须由 `slot`（`overall_mcp_list` 里的行序号）或 `from`（该行显示的版本）指明是哪一行：不唯一时报错（HTTP 409，`ambiguous server name: …（N 条同名记录）；请带上 slot`），不再默认取第一条——更新错行会回报「无需更新」，删错行会删掉不相关的记录。

对 `overall_mcp_list` 报成 `provided-externally` 的条目（工具由别的 mcp-client 挂载提供，本插件从未挂载过），上面这几个变更类工具的**返回值**会带 `stillProvided: true` 与一句 `note`：停用只记录本插件的意图、移除只删掉本插件的记录，那些 `mcp__<name>__` 工具都不会消失（`overall_mcp_set_source_enabled` 则回报 `externallyProvided: N`）。

## 版本检查与更新

「已注册」标签页顶部有 **检查更新** 按钮；有可用更新的行显示绿色徽标 `可更新 → x.y.z` 与 **更新** 按钮。**查不到最新版本不是「已是最新」**：那一类有单独的计数与文案（宿主报 `failed`，面板写 `N 个查不到最新版本`；一个都查不到时直接说「网络或包注册表不可用」），对应行还会留下一枚红色 `检查失败` 胶囊，悬停给出原因——早先它和「无需更新」共用一条汇总，一个离线的人会被告知「均已是最新版本」。统计行下方是**更新队列**：`全部更新（N）` 一次跑完所有已标可更新的服务器，一条进度条按「已完成 / 总数」推进并显示已用时，多条任务时 `展开明细` 列出每一条的 `等待中 / 更新中 / 旧 → 新（已重连）/ 无需更新的原因 / 失败原因`。

**运行期间，每一条自己的按钮就是它的状态**：轮到它时按钮变灰并写 `更新中…`，还排在后面的写 `等待中`，两者都不可点——同一时刻只能有一个写者，注册表条目只有一个。**一旦某条被回答，它的 `更新` 按钮就消失**，那个位置留给结果本身：更新过的行显示 `✓ 已更新到 x.y.z`，无需更新的行连徽标一起撤掉，而不是继续摆一个已经没用的按钮。

**队列跑完并且没有剩余项时，这个位置不再继续兜售「全部更新（N）」，而是变成绿色的 `✓ 已完成（N 台已更新 / 无需更新）`**：已经回答过的问题不该再问一遍。计数也以队列自己的结果为准——本次已结算（已更新 / 无需更新）的条目从计数里划掉，**失败项会留下**（重试它正是读者接下来要做的事）。只要还有别的可更新服务器在等着，这个位置就仍然是批量按钮，不会被「已完成」顶掉。宿主侧配合这一点：「无需更新」的回答现在也会重写该条目的 `updateCheck`（`index.js` 的 `doUpdate`），否则上一轮检查留下的陈旧徽标会比回答它的那次更新活得更久。

进度条报的是**队列自己的进度**，不是下载百分比：宿主的 `/update` 只在重写注册表并重连完成之后回答一次，中间没有任何字节级信息可报，所以这里不编造百分比。队列**串行**执行（同一时刻只有一个写者：注册表文件与 mcp-client fiber 都只有一个），因此「i / N」是真实计数。失败不会中断队列，其余条目照常继续；结束时汇总成一句 `N 台已更新，M 台无需更新，K 台失败`，只要有失败就按错误呈现（读者必须处理那一条，成功提示会把它埋掉）。`关闭进度` 只清掉已完成的进度面，不改变注册表——**而且关掉之后不会再被顶回来**：客户端按**行地址**记住「这条已经被回答过」（宿主报出的 `slot`，缺失时退回名字），所以即使宿主的列表仍挂着那枚回答之前的徽标，它也不会重新算进 `全部更新（N）`；只有当列表报出比被回答的版本**更新**的版本时，这一条才会重新出现在计数里。

**「同名的第二行」是另一条记录。** 同一份客户端配置可以把一个服务器定义两次（本机就是这样：`rea-cursor` 有四条，其中三条 `serverName` 为空）。所以名字不是行身份：面板发往宿主的每条更新都带上 `slot`（该行在列表里的位置）与 `from`（它当时显示的版本），宿主优先按 `slot` 认条目，认不到再拿 `from` 与该条目固定住的版本比对，最后才退回名字。写回判决时同理——`checkAllUpdates` 的结果与传入条目**按位置一一对应**，宿主据此逐条写入；早先按名字 `find` 的写法会让四条同名条目里只有第一条拿到判决（并被后面的覆盖），其余三条永远是空的。读取时还有一道闸：`publicList()` 只在 `updateCheck.current` 与该条目当前固定的版本一致时才给出这枚徽标（`lib/updates.js` 的 `checkDescribesEntry`，有单测），所以为一个版本算出的判决不会活到条目换了版本之后——本机那条「明明已经在跑 6.5.0 却显示 `可更新 → 6.5.0`」的行，正是这两处叠加的结果。

**「来源已删除」的行是同一个身份问题的第三面。** 那四条 `rea-cursor` 里，只有一条被 `connect()` 真正挂载（`serverName` 有值，就是 `mcp__rea-cursor__*` 这套工具背后的那份），另外三条是旧扫描器 `name-<source>` 重命名留下的惰性记录——重命名本身已在 `820641c` 里删掉，但它当年写进注册表的三条记录留了下来，而全机任何配置文件都不再包含这个名字（都固定着 6.1.0，正是报告里那三条）。它们既不会被重新导入，也不提供任何工具（fiber 按**名字**存放，`connect()` 见到已有名字就短路），却照样被算作服务器、响应行操作（按名字找第一条，正是「点最后一行、删掉第一行」的由来）。现在扫描器把这次的**证据**写进注册表（`registry.scanned`，`lib/scanner.js` 的 `scannedSources` / `findOrphans`）：读了哪些来源、各自定义了哪些名字；面板据此把这些行标成 `来源已删除`（琥珀色胶囊，不显示更新徽标——没有人会重新导入它），并把整个集合收成一条提示 + 一个动作「清理 N 条」（`POST /api/overall-mcp/forget-orphans`，一次请求处理全部）。判定**只在扫描确实读到过该来源时**才做：`not-found` 不算「空配置」，其余读取错误进 `unreadable` 也不参与——一份读不到的配置不能当成「这个服务器不存在」的证据；`source: manual` 的手工条目永不动。**正在持有挂载的行（`serverName` 非空）永远不在清理范围内**：那一行此刻就在供工具，配置文件没有它并不能成为把它拿走的理由。这个标记现在由 `connect()` / `disconnect()` 经 `setMountHolder` / `clearMountHolder` 维护，同名条目里**只有真正挂载成功的那一行**带 `serverName`——`fibers` 是按名字存放的，早先每点一次「更新」都会重挂一次，于是标记被留在刚刚重挂过的那一行上，四条同名记录里会有三条同时自称「持有挂载」，清理反倒漏掉它们。因为持有者不在清理范围内，清理既不需要断开也不需要重连任何 fiber（`syncFiber` 的循环已随之删掉），返回体只有 `{name, source, version}`。`停用` / `移除` 也带 `slot`，不再是按名字找第一条。

同一个按钮还回答第二个问题：**本插件自己**（`dsh-overall-mcp`）在 npm 上有没有更新。有新版时，**版本号旁边**（页头 `全局 MCP v0.1.0` 的右侧）出现 `更新到 v<新版>` 按钮，两个标签页都在同一位置——这是唯一一件关于本页自身而不是本页内容的事，所以它属于版本号。两种安装形态给出的答案不同（`lib/self-update.js`，`test/self-update.test.mjs` 断言）：

| 安装形态 | 判定 | 面板行为 |
| --- | --- | --- |
| profile 的 `node_modules/dsh-overall-mcp` | 版本由 pnpm 拥有，可查 npm `dist-tags.latest` 并比较 | 有新版时页头版本号旁出现「更新到 v0.2.0」，点了执行 `dsh plugin --profile <p> add <pkg>@<v>`，随后提示重启 DSH |
| `link:` / 本地检出（本仓库的开发形态） | 加载的就是源码目录，npm 上的版本与它无关 | **不出现**更新按钮，检查结果里注明「插件为 link 安装，跳过自身更新」 |
| npm 查询失败（未发布 / 404 / 超时） | 无法判定 | 不出现按钮，检查结果里原样给出原因 |

`GET /api/overall-mcp/self` 可以在不触发服务器检查的情况下单独看插件自身的版本判定（10 分钟记忆化，避免每次点按钮都打 npm）；`POST /api/overall-mcp/self-update` 执行安装并把命令行原样回给面板。

能检测到版本的前提是该条目**通过包管理器启动**：

| 形式 | 可检测 | 说明 |
|---|---|---|
| `npx -y pkg@1.2.3 …` | ✅ | 对比 npm `dist-tags.latest` |
| `cmd.exe /d /c npx -y pkg@1.2.3 …` | ✅ | Windows 包装形式（从其它客户端导入的常见形态），会自动解包 |
| `uvx pkg` / `pipx pkg` | ✅ | 对比 PyPI `info.version` |
| `npx -y pkg`（未固定版本） | ⚪ | 视为始终最新，不提示更新 |
| `codegraph serve --mcp`、`python server.py` 等直接命令 | ❌ | 显示「not launched through a package runner」，不做猜测 |

更新动作会把包参数重写为**精确最新版本**（可复现），保存注册表，并断开重连让新版本真正生效。`GET|POST /api/overall-mcp/updates` 与 `POST /api/overall-mcp/update` 提供同等能力；`/update` 每次只处理一个条目，请求体是 `{ name, slot, from }`（同名的行只有一条时可省略；同名多条目时**必须**给出其中之一，否则报 409 而不是猜一条），界面上的「全部更新」是客户端把这些请求**排队串行**发出去，而不是宿主提供的批量接口——这样每一条的成败都能单独报出来。`/remove` 与 `/set-enabled` 接受同样的 `{ name, slot, from }`：同名多条时**只有带 `slot` 才敢动手**（否则宁可报「同名记录不唯一」也不猜），因为这两条命令一个会断开真实工具、一个会删掉注册表里的一行。

`POST /api/overall-mcp/forget-orphans` 是「来源已删除」那一类记录的清理入口：只删扫描**已证明**不再被任何配置定义、且当前**没有持有挂载**的行，返回每一条的 `{name, source, version}` 与总数；持有挂载的行永远不会被它碰到，所以它不需要断开或重连任何 fiber。

安装/连接采用**有界等待**：8 秒内未完成（例如首次 `npx` 下载）即返回 `starting: true`，连接在后台继续，页面刷新后显示最终状态。**这次等待失败或超时不会留下幽灵 fiber**：只有真正挂载成功的那一次才把 fiber 记进 `fibers` 并写下 `serverName`，后台那次失败（或超时后才报错）会连同挂载标记一起回收并 `dispose()`，同一行之后的重试不会撞上「已经有 fiber」的短路判断。

**页面上的每个请求都有截止时间**（`client/client.js` 的 `api()`）：默认 30 秒，会拉网络或起进程的路由各自放宽（`/scan` 120s、`/catalog` 与仓库统计 120s、`/updates`、`/update`、`/install` 300s、`/self-update` 600s），超时即中止并写出「等待超过 N 秒仍未响应……重启 DSH」的提示。此前没有任何超时：宿主一旦挂住，`busy` 会跟着那个永不 settle 的 promise 一起卡死，整页按钮同时变灰，既没有提示也没有恢复路径。宿主侧「你读到的那一行已经不在原来的位置」也会被明说：按 `slot` 找不到该行时返回 `stale entry: <名字>（注册表已变化，请刷新后重试）`，同名不唯一时返回 `ambiguous server name: …（N 条同名记录）；请带上 slot`，HTTP 上都映射为 409（`lib/http-status.js`，有单测）——这是「刷新后重试」，不是宿主内部错误（502）。

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

这类条目没有本插件挂载的 fiber，所以本插件**无法**停掉或移除那些工具：界面上仍然可以点「停用」/「移除」（那是在记录本插件的意图或清掉本插件的记录），但两个按钮的悬停提示、动作返回的 `note` 与模型工具的描述都会说明「工具仍由另一个插件提供」，不会反过来宣称已经断开（返回体带 `stillProvided: true`）。

## HTTP API（界面使用，Connection 鉴权）

`GET /api/overall-mcp/servers`、`GET /api/overall-mcp/tools`（schema 取证）、
`GET|POST /api/overall-mcp/updates`（版本检查）、`POST /api/overall-mcp/update`（更新并重连）、
`GET|POST /api/overall-mcp/catalog?query=&source=&limit=&refresh=`、
`GET|POST /api/overall-mcp/sources`（自定义目录源：列出 / 添加）、`POST /api/overall-mcp/sources/remove`（移除一个，见下）、
`POST /api/overall-mcp/scan`、
`POST /api/overall-mcp/install`、`POST /api/overall-mcp/set-enabled`、
`POST /api/overall-mcp/set-source-enabled`、`POST /api/overall-mcp/remove`、
`POST /api/overall-mcp/forget-orphans`（清理「来源已删除」的记录，见上）、
`POST /api/overall-mcp/favorite`（收藏，见下）、`GET /api/overall-mcp/favorites`（列出收藏）、
`GET /api/overall-mcp/repo-stats?repos=owner/name,...`

错误码分层（`lib/http-status.js`，单测 `test/http-status.test.mjs`）：`unknown server`/`unknown source` → **404**；缺参数（`item/key/name/source/enabled ... required`）、`no installable transport`、`is not launched through a package runner` → **400**；`ambiguous server name`（同名多条目，没带 `slot`/`from`）、`stale entry`（你读到的那一行已经不在原位）、`manual entry`（这个名字属于手工添加的记录，安装不覆盖它）→ **409**；上游版本查询失败（`version lookup failed`）→ **502**；其余一律 **500** 并由宿主 `log.warn` 记一行（含方法、URL 与消息）——500 的含义就是「这条路径我们没预料到」，早先它和「你参数写错了」共用 400，真正的事故看起来像用户的错。

`POST /api/overall-mcp/install` 的 body 是 `{ item, overwrite? }`；`/update`、`/remove`、`/set-enabled` 是 `{ name, slot?, from? }`（同名多条目时不带 `slot`/`from` 返回 409）；`POST /api/overall-mcp/sources` 是 `{ url, label? }`（`label` 省略时由地址推断）；`POST /api/overall-mcp/sources/remove` 是 `{ id }`。

`GET|POST /api/overall-mcp/sources` 与 `POST /api/overall-mcp/sources/remove` 是「自定义目录源」的读写面（`lib/custom-sources.js`，单测 `test/custom-sources.test.mjs`）：GET 回 `{sources:[{id,label,url,submission}], max:8, error}`（`error` 是 `sources.json` 读不出来的原因，此时 `sources` 为空**但仍然可用内置五源**），POST 添加一个。`submission` 由宿主从地址推出（`lib/submission.js` 的 `githubRepoOfSourceUrl`）：住在 GitHub 仓库里的清单得到 `{repo, url}`（`url` 就是预填好的 `issues/new` 地址），别处托管的清单得到 `null`、面板于是不画那个链接。校验在 `normalizeSourceUrl`（只放行 `https:`、必须带主机、拒掉带用户名口令的地址、长度上限 600）与 `validateSourceInput`（地址重复 → 409，含与自己的对比；标签上限 40 字符），落盘前还兜一层 `addSourceTo` 的上限检查（第 9 个 → 409 `too-many-sources`）。id 由 `sourceIdFor` 从 `host + pathname` 生成 `custom:<slug>`（≤48 字符，小写、非字母数字折成 `-`、去重尾），所以「同一个地址」永远是同一个 id；标签由 `defaultLabelFor` 推出 `owner/repo`（GitHub raw、jsDelivr 的 `gh/owner/repo@ref`）或主机名。`normalizeSourcesDocument` 在**读取时**重跑地址校验：手改文件塞进来的 `http://` / 带口令 / 超长的行会被丢掉而不是带着进市场。删除成功会调 `catalogCache.forgetSourceId(id)`，否则被删源的行还能从来源层缓存里活 60 秒。

`/catalog` 的缓存分两层（都在 `lib/catalog-cache.js` 里，单测 `test/catalog-cache.test.mjs`）：

- **URL 层（条件请求）**：每个上游 URL 记住上一次的 `ETag` 与正文，下次带 `If-None-Match` 去问，`304` 就直接把那份正文交回去（不重新解析 JSON）。LRU 上限 64 个 URL / 8MB 正文，按写入时间淘汰。上游不支持 `ETag` 时这层自动退化为「空 validator + 每次都是 200」，不需要按来源写分支。
- **来源层（TTL）**：抓取结果按 `来源|查询串|单源上限` 缓存 **60 秒**，TTL 内连上游都不问；TTL 过了才去问，而问的结果又常常是 `304`。上游失败时回退到同一个键上一次的结果（条目标 `stale`、错误照报），冷启动失败才真的报空——上游抽风不该让整页变空。
- 缓存按参数显式传入（`browseCatalog({ cache })`），不传就是老行为（每次真抓）——单测里近百次 `browseCatalog({ fetchImpl })` 因此不需要知道缓存存在。
- 查询串截断到 200 字符后才参与缓存键（否则请求方可以拿超长 query 撑出无界键空间、每条都吃一份整份列表的内存）。手动 `refresh` 跳过来源层 TTL，但**仍然**走 URL 层的条件请求：刷新通常就是一次 `304`，元信息行会把「N 源未变」写出来。
- 用户自己加的目录源（见「MCP 市场」一节）走的是**同一条**路径：它们进 `CATALOG_SOURCES` 之外的动态列表，来源层缓存键就是它们的 id，`/catalog?source=<自定义 id>` 与内置源行为一致；`sources` 返回体因此把每个源写成 `{at, cached, stale, notModified, items}`（或一个 `{error}`），面板的各源时间/状态行读的就是它。

模型工具 `overall_mcp_search` 与市场页共用同一条聚合查询（`lib/catalog.js` 的 `browseCatalog`）：同一套去重、分组与排序，只是服务端把结果截到 50 条。

### 收藏（favorite）

`POST /api/overall-mcp/favorite`，body `{"key":"<source>:<id|title>","on":true|false}`：写入想要的**终态**（`on: true` 必加、`false` 必删）；不带 `on` 时退化成**切换**（宿主旧行为，见 `index.js` 的 `doToggleFavorite`；`on` 给了但不是布尔会报错，而不是当成切换）。
key 就是市场卡片的 React key，因为官方 Registry 的 id 随版本变化，所以用「来源 + 标题」做稳定身份。
收藏集存在 `registry.favorites`，随注册表一起持久化；`/catalog` 每条都会标注 `favorite`。
`GET /api/overall-mcp/favorites` → `{"favorites":["<source>:<id|title>",...],"count":N}`：**读取面**。需要它是因为 `/catalog` 只标注本次查询命中的条目：来源筛选或搜索词会把其余的藏起来，于是「我到底收藏了什么」需要独立答案。
面板上对应的是市场页筛选行里的**仅看收藏 (N)** 按钮：它是对当前列表的视图过滤（不是重新查询），并在宿主总数多于当前可见数时明说「共 N 条收藏；当前来源与搜索下能看到 M 条」，免得筛出来的空列表看起来像「一条都没收藏」。
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

- `$DSH_HOME/overall-mcp/registry.json` — 注册表（权威）。写盘走临时文件 + `rename`（不会留下半截 JSON）；解析失败时先把原文件复制成 `registry.json.corrupt-<时间戳>`，再用空注册表启动，并把原因随列表响应报给面板（`registryError`）——**不会被当成「首次运行」而覆盖**
- `$DSH_HOME/overall-mcp/installs.json` — 本市场安装计数（键是目录条目的 `id`，无 id 时回退 `name:<服务器名>`；只在挂载成功之后 +1）
- `$DSH_HOME/overall-mcp/scan-report.json` — 最近一次扫描报告
- 市场列表每个来源各缓存 60 秒（只缓存原始数据，"已安装"标记每次读取时重新计算）；上游 URL 的 `ETag` 与正文另存一层，`304` 时复用而不重抓（详见上文 `/catalog` 的两层缓存）
- GitHub Star 补充数据缓存 6 小时（失败结果同样缓存，避免反复冲击 GitHub 的未认证额度）

## 安全

- 扫描只读白名单文件；stdio env 只引用变量名，不展开宿主机密值。
- 市场条目安装前在界面/工具结果中可见启动命令与来源，由用户确认。
- 本地插件，无对外 HTTP 面。

## 开发

```sh
node --test test/*.mjs                                     # 纯逻辑测试（lib/ 零依赖）
node --test test/index.test.mjs                            # 宿主契约测试：真跑 apply(ctx)，假宿主 + 临时 DSH_HOME（见下）
#   两个宿主 peer 依赖本仓库不安装，由 test/hooks.mjs 映射到 test/stubs/；npm test 的脚本是显式文件列表，新增测试要加进去
node tools/client-smoke.mjs                               # 客户端注册契约 smoke（模拟前端 module loader；并断言客户端版本号 == package.json）
node tools/render-detail.mjs                              # 渲染详情页：事实表有值、链接齐全、命令可见、复制按钮真的把命令交给剪贴板（打桩 navigator.clipboard 后驱动真实按钮）
node tools/render-card.mjs                                # 渲染卡片：标题是链接、正文不是 button、无嵌套交互元素、GitHub 标记/版本在位、命令行只在详情面板
node tools/render-market-tab.mjs                          # 渲染整个市场页 chrome：页头两行、页签计数、搜索行、筛选行、元信息行、卡片流、页脚分工，以及「仅看收藏」过滤后如实说明藏了多少条
node tools/probe-server-about.mjs                          # 渲染「已注册」行：用途行在事实行之前、被 clamp 成两行、title 与证据来源一致、无证据时不留空元素
node tools/verify-css.mjs                                 # 校验所有 className 在注入的样式表里都有对应规则（探针选择器除外，见文件内 HOOKS）
node tools/layout-probe.mjs                               # 真实 Chrome 量卡片几何：长名称必须省略号、CTA 必须在卡内（npm run test:layout）
node tools/shot.mjs                                       # 把真页面渲染成 HTML 交给 headless Chrome：出七张对照截图（tools/out/*.png，含带 240px 侧栏的 frame-2col.png / frame-wide.png / frame-loading.png），断言栅格列数跟着**容器**走而不是窗口走、四种窗口宽度下面板都不出现横向滚动、且加载态不会把行拉伸铺满面板（`npm run test:layout`）
node tools/preview-paged.mjs "<base-url-with-?token=…>" 20 1 installs
                                                          # 按面板页的方式渲染某一页（可带 pageSize/page/sort/group，group 如"金融支付"/"__none__"）
node tools/verify-sort-paging.mjs                         # 校验 6 种排序、3 种页宽、越界夹取、紧凑计数
node tools/verify-detail-links.mjs                        # 校验详情页链接：逐源覆盖、零死链、零重复 URL
node tools/registry-submission.mjs --check --registry registry.json
                                                          # 复核已发布的清单（npm run test:registry，进 verify）
node tools/registry-submission.mjs --body-file /tmp/issue.md
                                                          # 单独跑一遍投稿校验（--write 才写盘；退出码 0/1/2 见「投稿到社区清单」）
node tools/probe-real-cards.mjs                           # 拉真实市场条目逐条渲染卡片+详情（活实例）
node tools/probe-media.mjs <token>                        # 实测 /repo-media：五个真实仓库的图片数/尺寸/缓存命中耗时
node tools/probe-favorites.mjs <token>                    # 收藏闭环实测（活实例：POST /favorite on/off → GET /favorites 计数 → /catalog 回读）
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
| `lib/about.js` | 「这个 MCP 是干什么的」：从服务器 `instructions` / 已注册工具 / 启动命令中取一句人话，含 markdown 剥离、截断与证据标签；以及判断何时需要重读 system prompt 的 `needsInstructionsRead()` |
| `lib/http-status.js` | 把宿主内部的错误映射成 HTTP 状态码（`unknown server|source`→404、缺参数/不可安装传输→400、上游版本查询失败→502、其余 500），供 `index.js` 的 `guard` 使用 |
| `index.js` | cordis 宿主插件（`inject:['tools']`）：注册表、每服务器 `ctx.plugin(mcpClient)` 桥接、`defineTool` 管理工具、HTTP 路由 |
| `client/client.js` | `__ModuleLoader__` 客户端插件：注册侧栏入口（`sidebar.panellist`，id `overall-mcp`，order 5）与面板本体（布局的 `main` 键控插槽，同一 id） |
| `cordis.patch.yml` | 宿主 composition 补丁 |

## 市场来源配额（每次浏览的实际上限）

| 来源 | 上游请求 | 读取条数 | 说明 |
|---|---|---|---|
| 官方 Registry | 8 | 800（去重后约 220 个 server） | 单页上限 100，按 `nextCursor` 翻页后按 `isLatest` 去重 |
| Smithery | 1 | 10 | 上游列表本身只返回 10 条 |
| Docker MCP Catalog | 3 | 300 | `hub.docker.com` 分页，`next` 为空即停；网络封锁期 403/超时，该源降级、其余源不受影响 |
| Awesome 远程 | 1（+镜像链） | 1000 | 单个 README，实测 928 行；经镜像链获取（见上节） |
| Awesome 本地 | 1（+镜像链） | 5000 | 单个 README，实测 **4224** 行；经镜像链获取（见上节） |

默认一次浏览约 15 个上游请求，聚合 **5364 个去重 MCP**（2026-10 实测），结果按来源各缓存 60 秒；单来源筛选时只请求该来源。**这 15 个请求里，重复浏览时绝大多数会变成 `304`**（正文不重传），而 60 秒内的第二次浏览一个请求都不发。

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

宿主插件的代码在 DSH **启动时**载入一次。若在 DSH 已经打开的情况下更新了插件（本插件用 `link:` 安装在工作区时尤其常见），侧栏页面里的前端是新版、而宿主仍是旧版，`/api/overall-mcp/catalog` 这个路由就还不存在，于是返回 404。

- 完全退出 DSH（桌面版注意托盘图标，关窗口不等于退出）后重新打开；
- 新版页面会直接把这种情况提示为「宿主插件还是旧版本（缺少 /api/overall-mcp/catalog）」，而不是只显示一个 404。

**市场里某条显示「需手动配置」**

该来源只提供仓库地址（社区 Awesome 清单即如此），无法安全推断启动命令。点「仓库」按该项目的 README 自行配置；官方 Registry 与 Smithery 的条目通常可直接「安装」。

## License

MIT



