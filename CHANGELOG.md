# 更新日志

本项目在此之前没有成文的更新日志：二十轮构建都顶着 `0.1.0`，两处版本号（`package.json`
与客户端的 `CLIENT_VERSION`）互不校验，也没有记录任何一次改动的用户可见后果。本文件从
`0.2.0` 起逐版记录，并把规则写下来：

- **minor（0.x）**：一批已完成的用户可见改进。这里的一批可以是若干次提交，只要它们合起来
  回答同一个问题。
- **patch**：同一批之内的修正（文档、探针、测试、注释），用户可见行为不变。
- **major**：尚未发生。首次发布到 npm 之前不提升 major；一旦发布，破坏性变更（HTTP API、
  注册表 schema、数据文件格式）提升 minor 并在条目里显式标注「破坏性」。
- **版本号有两处**，必须同时改：`package.json` 的 `version`（宿主与更新检查读它，面板身份行
  也读它）和 `client/client.js` 里的 `CLIENT_VERSION` 字面量（打包进页面的那份自述）。二者
  由 `tools/client-smoke.mjs` 断言相等，并断言本文件的最新小节就是该版本——一份停在旧版本的
  更新日志，和一枚说谎的版本徽章是同一类问题。
- **批次号从历史取，不靠记忆**：提交标题里的「第 N 批」，必须是 `npm run batch:next` 当场
  打印出来的那个数（它读 `git log` 里已有的最大号再加一）。这个仓库同时被不止一个会话编辑，
  各自记得「上一批是 42」就会各自写下 42——第 40、41、42、43 批都这样撞过一次。

## 1.0.3 — 2026-11-03
- **context7 的「检查」不通过，根因在网络路径而不是端点**。本机 DNS 走 TUN/fake-ip 代理，到 `https://mcp.context7.com/mcp` 的 POST 会被随机重置：同一份 `initialize` 实测一次 200（SSE 正常返回，tools 有 `resolve-library-id` 与 `query-docs`），下一次 10 秒后 `ECONNRESET`，大约每两次中一次。宿主的挂载只有**一次**尝试，所以一次重置就让它整场会话都停在「未挂载、0 个工具」，只有重启或手动「更新」才可能恢复。
  - 现在，**传输类错误会重试两次**（0.8 s、2.5 s）：`ECONNRESET`、`EPIPE`、`ETIMEDOUT`、`fetch failed`、`socket hang up` 这类；命令不存在、重名冲突这类是结论而不是丢包，不重试。重试走同一个 mutation 队列，行被移除/停用、或名字已被别的 mount 占用时自动放弃，`dispose` 时清掉待执行的定时器。
  - 「检查」的 tools 行不再替端点背锅：**行没挂载就写「行未挂载」并带上 `connectError`**，网络抖动时还会说明会自动重试一次；只有真的连上了却拿不到工具表，才说「端点握手成功却没发布工具」。
- 测试：`test/index.test.mjs` 67 → 69（一次重置后重试并恢复为 `connected`；未挂载时 tools 行必须给出「未挂载」和具体错误，而不是「可能还在预热」）。门禁 509/509。

## 1.0.2 — 2026-10-30
- **在 Skill 市场搜索「什么都没发生」**。宿主的 anthropics 源把整份目录缓存十分钟，而缓存命中时直接把**未过滤**的列表返回：于是在这个窗口里，任何搜索词都拿回那 19 个官方 skill，命中的行被挤到下面（页面上看就是「输入了、点了搜索、没有任何变化」）。缓存现在只缓存**目录本身**，每次调用都按当次 query 过滤（和 SkillHub / ClawHub / GitHub 的缓存语义一致）。
- **搜索结果页不再放两张大的「★ anthropics 精选 / 🔥 热门」**：它们是浏览用的推荐位，压在一份过滤结果上面只会把命中项推下去；有搜索词时不渲染，清空搜索词后回来。
- **搜不到东西时说清楚**：四个来源都没命中时显示「没有匹配「…」的 skill。四个来源都问过了；换个词，或者点「刷新」重问一次。」，而不是留一片空白。
- 测试：`test/skill-market.test.mjs` 13 → 14（先浏览把缓存填满，再搜索必须过滤、`total` 仍是全集、无命中返回空）；渲染探针新增一节（搜索只能出命中卡片、无推荐位；无命中给文案；清空搜索恢复推荐位）。门禁 486/486。

## 1.0.1 — 2026-10-29
**首个公开发布**（仓库只含运行所需，见文末）。从 0.35.3 直接到 1.0.1，是因为这一轮把这些事一起收口了：

- **一个名字**：侧栏入口与页头统一为「全局 MCP & Skill」。侧栏此前只写「全局 MCP」，入口和它打开的页面不是一个名字。
- **索引真的走完过一个源**：SkillHub 全量 2,107 次请求 / 43 分钟，收到 205,037 行（上游 210,612）；索引文件 214,747 行 / 163 MB / `complete: true`，`modes.skillhub = "full"`。翻页、搜索、安装都直接读它。
- **索引跨进程可见**：缓存带文件身份（`mtime:size`），文件变了就重读。无界面收录（`tools/skill-walk.mjs`，开发工作区）写完不用重启宿主，面板下次打开就是新数据；面板里点「收录」也从新文件起步，不会把它启动时那份旧副本合并写回。
- **收录进度不再白跑**：无界面 runner 每 200 次请求落一次带 `partial` 的快照，Ctrl+C / SIGTERM 会等手上那次请求落地再写「已手动停止（…，下次接着走）」；重跑同一条命令从游标续走。
- **调用页把两条来源分开记、再合成一行**：模型经 `skill` 工具加载、以及你在输入框里敲的 `/技能名`（宿主把技能展开注入，不是工具 RPC）都算「触发」；窗口内的重复引用在**读**时折叠成一行并显示 `×N`，窗口（关 / 5 分 / 30 分）由面板选、由宿主记住（`ui-prefs.json`）。左栏与页头一起钉住，只有时间线滚。
- **两处「走一个源、抹掉另一个源的记录」修掉**：`minStars` 不再被后续 slice 走查抬高；`truncations` 只由**这次真正走过的源**退休——判据从可继承的 `done` 换成 `walked`。
- **发布形态**：这个仓库只包含运行所需——`index.js`、`lib/`、`client/`、`cordis.patch.yml`、`registry.json`、两份 README、`CHANGELOG.md` 与 `docs/images/` 里的截图。测试、渲染探针与构建脚本留在开发工作区，不发布。
- 门禁（开发工作区）485/485；五个位置的版本号同步（`package.json`、`client/client.js`、本文件、两份 README 徽标）。

## 0.35.3 — 2026-10-29
- **侧栏入口改名**：`label` 从「全局 MCP」改成「全局 MCP & Skill」，与页头一致（页头早在 0.22.0 就是两段式「全局 MCP & Skill」，侧栏一直只写前半截，入口和它打开的页面不是一个名字）。渲染失败时的兜底文案也一起改。
- 防止半途改名：`tools/client-smoke.mjs` 现在断言注册的 `label` 必须正好是 `全局 MCP & Skill`（原来只断言「非空字符串」），探针也补了页头必须带 `& Skill` 的断言。
- 文档同步：中文 README 的侧栏条目、快速开始那句「点左侧导航里插件下面那个…」、页头描述、以及自更新那段的 `全局 MCP & Skill v0.35.3`；英文 README 的 Sidebar panel 行改为照实写中文 label（并说明页头同名）。
- 门禁 485/485。

## 0.35.2 — 2026-10-29
- **一次只走 SkillHub 的全量走查，把 GitHub 的「少收了」记录抹掉了**。`mergeTruncations` 用 `cursors[source].done === true` 判断「这个源这次走完了」，可 `done` 会从上一轮继承：GitHub 的 slice 早已 done，于是这次根本没碰它的走查把 6 条「stars:N 的同星块超过窗口容量」当成过期记录删了——文件于是声称 GitHub 完整、无保留，而它的 7,722 行正是那些被截断的窗口收来的。
  - `walkSkillIndex` 现在回传 `walked`（本次真正请求过的源）；`mergeTruncations(previous, fresh, cursors, walked)` 只在「这次走过 + 已 done」时才retire旧记录。不传 `walked` 时保持旧语义（done 即过期），因此其它调用方与既有测试不受影响。
  - 宿主与 runner 都传了 `walked`；runner 的 checkpoint 也会累积本次已访问的源，中途停下同样不会误删别人的保留。
- 数据修复：这次全量已把真索引的 6 条 GitHub 记录清掉，按修复语义从跑前备份里恢复（GitHub 那 7,722 行没变，记录描述的正是它们）。
- 测试：`test/skill-index.test.mjs` 32 → 34（继承 done 但没走 → 保留；走过且 done → 退休；walk 回传 `walked` 时不会去问已 done 的源）。门禁 485/485。

## 0.35.1 — 2026-10-29
- **runner 不再白跑**：`tools/skill-walk.mjs` 每 `--checkpoint=<请求数>`（默认 200，`0` 关闭）落一次快照——和宿主一样走 `mergeSkillRows` → `skillIndexDocumentOf`，`complete: false` 且 `partial` 写明「正在收录（已收 N 行）」，所以中途停下来留下的是一份**能续跑**的索引，而不是空手而归（上一轮 20 分钟的进度就是这么丢的）。
- **Ctrl+C / SIGTERM 收得住**：信号只让手上那次请求落地（`AbortController` 传给 walk），然后写最后一张「已手动停止（…，下次接着走）」的快照并以 130 退出；第二次信号立刻退出，不再等。重跑同一条命令从游标接着走（实测：24 次请求停在第 24 页 → 再跑 2 次从第 24 页走到第 26 页，而不是从第 1 页）。
- **备份只做一次**：改成走查开始前把原文件 copy 一份（`*.bak-<时间戳>`），而不是每次收尾再复制——checkpoint 每 200 次请求写一次，不能每次都拷 200 MB。
- 顺手修掉快照里的一处口误：句子里的行数原先用「原有行 + 本次拿到」算，把「本次重读到的已有行」也数了进去（全量开头几页几乎全是已有行）；现在用文档自己的行数，句子和 `rows` 一定一致。
- 两份 README 的 Development 段补上 checkpoint 与中断语义。

## 0.35.0 — 2026-10-29
- **别人写的索引，宿主现在会自己看见**。`readSkillIndex` 把文档缓存在进程里直到退出，而页面的市场请求从不带 `refresh`——于是无界面 runner 写完 21 万行，面板照样显示旧的 19,774 行；更糟的是这时点「收录」，宿主会把它启动时那份旧副本合并后写回，直接盖掉 runner 的成果。现在缓存带文件身份（`mtime:size`）：戳变了就重读，写盘后记下自己的戳。
  - 走查进行中不重读自己的半成品快照（那会在五分钟里反复解析一个正在长到 200 MB 的文件）；走查结束后第一次读取自然拿到新文件。
  - `refresh` 参数保留原意——调用方强制跳过缓存；平时由戳决定。
  - 结果：runner 跑完**不用重启 DSH**，下次打开市场页就是新数据；面板里点「收录」也从新文件起步，不再从旧副本。
- 测试：`test/index.test.mjs` 62 → 63（宿主运行期间另一个进程替换文件 → 下一次市场请求拿到新行与新 `at`，走查状态也报新行数）。门禁 483/483。
- runner 与两份 README 的提示同步改口：不再说「重启才会读到」，改成「宿主发现时间戳变了会重读；只是别和面板的走查并行」。

## 0.34.2 — 2026-10-29
- **游标重置规则抽到库里，宿主与 runner 共用**：`full` 选择改变某个源的模式时，那个源必须从头走——否则「slice 已 done」的游标会让它被跳过，GitHub 的星窗也会保留旧的 floor。这条规则原先写在 `startSkillWalk` 里，runner 又抄了一份；现在是一个 `cursorsForWalk(previousCursors, previousModes, modes)`，两边都调它。抄本漂移是迟早的事，这个洞在加 runner 那天就埋下了。
- **`minStars` 不再被后一次 slice 走查悄悄抬高**：GitHub 全量走完记的是 `0`（无 floor），它的行会留在文件里；之后只走另外两个源（slice）时，旧代码会把这次 slice 的 floor（5）写回去——文件于是声称那 38k 行是「≥5★ 采样」。现在 `minStarsForWalk` 只在真的走到更低 floor 时下调，绝不因为一次 slice 走查而上抬。
- **`ui-prefs.json` 改成原子写**（临时文件 + rename），和其它文件的规矩一致：崩在中间只会留下旧偏好，不会留下半个 JSON。
- runner 收尾多两句提示：面板仍握着自己启动时读的那份文档，**重启 DSH 才会读新文件**；并且别在面板里先点「收录」（它会合并进旧副本再写回）。
- 两份 README 的 Development 段补上 `npm run skills:walk`，并说明「为什么必须有这个无界面入口」（整站 401）与「跑的时候别和面板的走查并行」。
- 测试：`test/skill-index.test.mjs` 30 → 32（模式变化只重置该源、resume 不动；floor 只降不升）。门禁 482/482。

## 0.34.1 — 2026-10-29
- **加了一个无界面的收录 runner**：`tools/skill-walk.mjs`（`npm run skills:walk -- --full=skillhub`）。全量收录是十几分钟到一小时级的活，而 Web GUI 的 token 从 shell 拿不到（`/api/overall-mcp/*` 一律 401，连首页都是），所以没法从外面驱动那条路由。这个 runner 调用的是插件自己那几个函数——`walkSkillIndex` / `mergeSkillRows` / `mergeTruncations` / `skillIndexDocumentOf`——同样重置「模式变了」的游标、同样按预算与上限合并、同样原子写盘并留备份；它只绕过了 HTTP 与面板那两层（那两层有宿主测试覆盖）。
- 两处工程化：`--dry-run`（走完不写盘）、`--max-requests=`（分块跑）；GitHub token 取 `--token=` / `GITHUB_TOKEN` / `gh auth token`；网络层对 TLS 抖动重试 3 次、遇到 429/`retry-after` 等待重试——walk 本身「一次失败即停、靠游标续跑」的语义没变。
- 已加入 `lint` 的 `node --check` 清单与 npm scripts。
- 门禁 480/480。

## 0.34.0 — 2026-10-29
走查剩下的两条缺口，按用户要求收口：
- **合并窗口的选择被宿主记住了**。原先它只活在页面状态里，DSH 一重启就回到 5 分——而页面 `localStorage` 也帮不上忙：Web GUI 每次重启换端口，浏览器存储按 origin 隔离，等于每次都是新存储。现在选择写到插件数据目录的 `ui-prefs.json`（与 `calls.jsonl` 同级），`GET/POST /api/overall-mcp/prefs` 读写它；面板启动时先读一次，`/calls` 在没带 `merge` 时也用它兜底。这是本插件唯一保存的显示偏好，**不碰任何 MCP 配置**——调用页「只读」的承诺仍然成立（这一点在 README 的路由说明里写明了）。
- **默认值不再有两份**。`summarize` 现在把实际使用的窗口放进响应（`merge`），面板据此显示当前选中项，不再硬编码第二个「5 分钟」。所以默认值只有宿主一处；客户端 `CALL_MERGES` 只是三个可选档位。
- **面板只送选择，不送默认值**：未选择时请求里不带 `merge`，由宿主用自己的默认/记住的值折叠并回传；选了之后才带。少一次状态同步，也少一处可能不一致。
- 测试：`test/calls.test.mjs` 16 → 17（响应回传实际窗口、MCP 空间恒为 0），`test/index.test.mjs` 61 → 62（`/prefs` 读写、越界窗口 400、`/calls` 采用记住的窗口、显式窗口优先）；探针补「面板读了记住的窗口」与「点 30 分后 `POST /prefs merge=1800000`」。门禁 480/480。

## 0.33.1 — 2026-10-29
- **钉住左栏之后它自己不能滚动**：0.33.0 把左栏移出滚动区，它就不再有任何滚动盒子——机器上服务器/skill 很多时，左栏下半截会被面板的 `overflow: hidden` 切掉，点不到。现在左栏 `maxHeight: 100%; minHeight: 0; overflowY: auto`，自己滚自己的（顺手去掉已经无意义的 `position: sticky`）。
- 探针补一条断言：钉住的左栏必须 `overflowY: auto`，否则长列表会再次不可达。
- 门禁 478/478。

## 0.33.0 — 2026-10-29
走查留下的三条缺口，按用户要求一次做完：
- **左栏也置顶**。上一版只钉了数字卡/说明/范围栏/条数，左栏（`Skill · 今日`、全部、各 skill）还在滚动区里——它是用来缩小列表的，跟着列表滚走就没意义了。现在 `layout`（左栏 + 滚动列）在滚动区外，只有右列的时间线滚。
- **合并窗口可调**。窗口从「写盘时硬编码」改成「读时折叠 + 面板选择」：`calls.jsonl` 保留每一次引用（事实），`foldReferences` 在 `GET /calls` 时按 `merge=<ms>` 折叠（0 = 不折叠）。Skill 空间的工具栏多了一组 `合并：关 / 5 分 / 30 分`，默认 5 分；切换会带新窗口重新问宿主。改窗口不再需要改代码、也不改写历史。
- **探针补上斜杠引用的页面级断言**：fixture 里加了一条 `via: 用户引用, count: 2` 的行，断言页面显示 `触发 · 用户引用 ×2`、行里说明了来源、左栏有 `skill-router`；再断言三个窗口 chip、默认 `merge=300000` 会发给宿主、点 `30 分` 后发出 `merge=1800000`；以及「左栏不在滚动容器内」。探针的请求记录也补了 `merge` 参数（不然这类断言看不见它）。
- 修掉折叠实现里的一个顺序 bug：分组比较用 `group.at - at < windowMs`，行不是最新在前时会算出负数并错误合并；改成 `Math.abs(at - group.at)`，并在折叠前按时间倒序，与版面一致。
- 测试：`test/calls.test.mjs` 16（折叠用例改成读时语义：文件保留每次调用、窗口内外、窗口 0 关闭、非引用行不参与），门禁 478/478。

## 0.32.1 — 2026-10-29
走查「逻辑和功能是否完善」时收掉的三处不一致（都是斜杠引用落地后没跟着改的地方）：
- **平均耗时不再被引用拉低**：斜杠引用按定义没有加载耗时（`ms: 0`），却进了 `summarize` 的平均值——每敲一次 `/name` 就把「平均耗时」往 0 拽。现在 `timed` 排除 `via === "用户引用"`；只有引用时显示 `—` 而不是 `0 ms`（「没有测量」和「测得 0」是两件事）。
- **文案**：Skill 空间的 chip 从「宿主加载」改成「触发」（现在两条来源都可能）；平均耗时说明改成「模型加载 skill 的耗时（斜杠引用不计）」；空态从「Skill 由宿主在会话启动时加载」改成「模型经 skill 工具加载、或你在输入框里用斜杠命令（如 /skill-router）引用，都会出现在这条时间线上」。
- **文档**：`README.zh-CN.md` 的调用页那一行补了「斜杠引用记一行、5 分钟内合并显示 ×N」；`README.md` 同一行还留着 0.21.0 就删掉的「会话加载 row」说法，已改成「`skill` 调用一行 + 斜杠命令一行」。
- 测试：`test/calls.test.mjs` 15 → 16（平均值排除引用；只有引用时是 `—`）；探针改成核对新的平均值文案；门禁 478/478。

## 0.32.0 — 2026-10-29
- **「调用」页的头部也钉住了。** 用户对着截图（红框圈住三张数字卡、说明行、时间范围/搜索/导出那一行、以及「展示 N 条」）说「这些要置顶，不能随着滑动向上走」——确实会：第 63 批只把已注册页的搜索与筛选钉住了，调用页整个 panel 还挂在页签的滚动容器里。
- 现在 `CallPanel` 自己分成两段：`callhead`（三张数字卡、说明、错误/提示、时间范围 + 搜索 + 导出、展示条数）`flex: 0 0 auto`；`scroll`（左栏 + 时间线）`flex: 1 1 auto; minHeight: 0; overflowY: auto` 并且是页签里**唯一**带 `data-omkt="scroller"` 的盒子（「回到顶部」还找得到它）。页签 body 从 `tabBody`（自己滚动）换成 `market`（不滚动），于是只有时间线会动。
- 探针：新增 5 条断言——body 必须 `overflow: hidden`、页签里只有一个 scroller、scroller 必须 `overflowY: auto` 且 `flex: 1 1 …`、`callhead` 不在 scroller 内、时间线在 scroller 内；另按文本核对「今日调用 / 当前筛选 / 近24小时 / 展示 3 条」都在 `callhead` 里。踩坑：一开始给头部起的 key 是 `head`，`findByKey` 在整页里找到了别的同名节点，断言报「数字没被钉住」——改成 `callhead` 后通过。
- 门禁 477/477，`missing in sheet: none`。

## 0.31.0 — 2026-10-29
- **那「七次」不是七次调用，是误记——两个 bug 叠在一起。** 用户对着截图问「一段时间内的只能算作调用一次，一下显示七次是否合理」：不合理，而且那七行里没有一行是真实的用户引用。
  1. **判据错了**：0.30.x 靠扫文本找 `<skill_content name="…">` 判断「有人引用了技能」。但 assistant 的回答里会引用这段文字，工具输出（我读日志、贴代码、看 CHANGELOG）里也有——于是 14:06–14:09 我自己的调查过程被记成了七次斜杠引用，其中一行的技能名是 `([^`：那是我写的正则原文被日志转储带进了扫描内容。
  2. **时长是假的**：那几行的 `299.6 s / 54.7 s` 来自 0.30.1 的「出生即 running、随后被没有 callId 的 tool/result 兜底结算」缺陷，不是引用的耗时。
- **改法：不猜，读宿主给的原因。** 会话日志里那条真正的引用长这样：`{"type":"user/message","data":{"role":"user","source":{"kind":"skill-invocation","name":"skill-router","form":"instructions"},"content":[…]}}`——宿主已经写明「这条消息是因为一次技能调用而生成的」。所以只认 `source.kind === "skill-invocation"`（名字优先取 `source.name`，缺了才回退到解析块），`agent/inbox/spliced` 那条原始文本路径整条删掉（它还会把 `/tmp/notes` 之类的路径当候选）。
- **同一技能 5 分钟内的重复引用合并成一行**，行上带 `count`，标签显示 `触发 · 用户引用 ×2`——用户要的「一段时间内算一次」，同时不丢「其实按了两次」这个事实；超过窗口再引用是新的一行。
- **旧的无标记行在加载时丢弃**（`via === "用户引用" && schema !== 2`），带 `schema: 2` 的新行保留并把 `ms` 归零。重启后那七行会自己消失。
- 测试：`test/calls.test.mjs` 16 → 14，但覆盖更准（只有 `skill-invocation` 才算、assistant 回声/工具转储/普通消息都不算、窗口内合并与窗口外新行、phantom 行加载时丢弃）；门禁 479 → 477。

## 0.30.2 — 2026-10-29
- **真的记上了——并且当场抓出两个只有真跑一遍才会暴露的缺陷。** 用户按提示重启后敲了 `/skill-router 随便看看`，`calls.jsonl` 里立刻出现 `skill-router / 触发 / via 用户引用` 行；但同一份数据里能看到它先以 `running` 落盘，随后被一次**没有 callId** 的 `tool/result` 用 `newestRunning` 兜底结算——把十秒后那条 `node --test` 的输出挂到了这条技能引用上（`res` 里能看到 `✖ one invocation is recorded once…`）。
- 根因：`CallStore.start()` 强制 `status: "running"`，而斜杠引用是在看到它的那一刻就已经结束的（宿主在回合开始前解析完）。修复：`CallStore.record()` 直接落一条已结算的行；两个采集通道（`agent/inbox/spliced`、`user/message`）都改用它。旧的 `running` 引用行也不必再背「结果没能取到」的失败说明——`readFromDisk` 把 `via === "用户引用"` 的残留 running 读成 `ok`，其余仍读成 `lost`。
- 测试：`test/calls.test.mjs` 14 → 16（引用行出生即结算、无 callId 的结果不会落到它上面、旧引用行重启后不会被标成 lost）；门禁 477 → 479。

## 0.30.1 — 2026-10-29
- **「重启后没出现」的真正原因：重启之后根本没有第二次斜杠调用。** 解开会话日志（`%USERPROFILE%\.dsh\sessions\<项目>\<会话>\session.v4.jsonl.zstd`，多帧 zstd，逐帧解压后可读）逐条核对：整个会话里 `<skill_content name="skill-router">` 只出现过一次，在 `13:02:20` 的 `seq=3297`——早于 0.30.0 落地的时间（13:5x）；调用页不回填历史，所以那次没有、也不可能有行。日志里后面几次都是普通消息（"可以"、"重启后没出现"）。教训写在这里：**重启只是让新代码上线，行是在下一次引用时产生的**。
- **主路径换成已被证实能到插件的那条**：`agent/inbox/spliced`。它在我们自己的 `events.ndjson` 里以 `unmodelled` 出现过（14:05:28），说明宿主确实会把它推给插件；而它携带的是**原始**文本（`/skill-router 审查一下…`），展开成 `<skill_content>` 是后面另一条消息。现在：从 `inserted[].content` 取 `^/name`，先对照本机技能清单（435 个，`skill-router` 在其中）再落行，避免把 `/tmp/notes` 之类的路径当成技能（正则本身也拒绝「名字后面跟 `/`」）。`user/message` 的展开块仍然保留作为第二条通道，两条通道同时看到同一次引用时按 15 秒窗口去重，一次引用只会有一行。
- 测试：`test/calls.test.mjs` 12 → 14（原始斜杠解析、路径不误判、两通道去重与窗口）；门禁 475 → 477。

## 0.30.0 — 2026-10-29
- **你在输入框里用斜杠引用的技能，现在会出现在「Skill → 调用」里。** 用户问「那会引用了 skill-router，为什么没有在调用里面显示」：`/skill-router` 在宿主里**不是** `tool/call`——宿主把它展开成 `<skill_content name="skill-router">` 注入用户消息，再开始这一回合，所以调用页（只认 `tool/call` + `tool/result`，且只收 `mcp__*` 与 `skill` 工具）一行都记不到。现在订阅 `user/message`：从展开块里取技能名，记一行 `触发 · 用户引用`，`status` 直接 `ok`（宿主在回合开始前就解析完了，没有耗时可测），`note` 写明这不是工具调用。只在 `role === 'user'` 时记，避免 assistant 回声或 `skill` 工具返回值里的同一块被重复记一次；解析有 1 MiB 扫描预算、8 条上限、6 层深度上限。**一次斜杠引用 + 随后模型又显式 `skill` 加载同一个技能，会出现两行**——这是两条不同的事件，故意不去重。
- **未建模的会话事件类型各记一条到 `events.ndjson`**（`kind: "session-event", action: "unmodelled", type, keys`）：这次能确认「斜杠不走工具调用」靠的就是这类取证；下次宿主换了事件形状，盘上会直接留下证据，而不是又要猜一轮。
- **发现并修掉一个一直存在的门禁漏洞**：`test/calls.test.mjs` 从第 56 批起就没进过 `npm test` 的文件清单，那 12 条用例（分类、脱敏、开→结、失败、重启 lost、prune、汇总……）一直在门外。已加入清单，门禁 463 → **475**。顺手核对了 `test/` 下 28 个文件，现在没有第二个漏网。
- 面板文案：Skill 空间的说明从「Skill 由宿主在会话启动时加载」改成「模型经 `skill` 工具加载，或你在输入框里用斜杠命令引用（宿主把技能直接展开注入，不是工具调用）」；行首标签在用户引用时显示「触发 · 用户引用」。
- 测试：`test/calls.test.mjs` 10 → 12（斜杠引用成行、role 与空消息不记、解析去重/上限/深度）；门禁 475/475。

## 0.29.0 — 2026-10-29
评审留下的三条判断项，按用户的选择定下来：
- **行数上限改成 `max(mode cap, 已持有行数)`**（用户：「改成 Math.max(cap, 已持有行数)」）。`mergeSkillRows` 原来把结果一律裁到 `maxRows`，于是「先全量 210k、后按切片收录」会把 210k 行写回 24k。现在有效上限是 `max(模式上限, 本次开头已持有的行数)`：上限只约束**增长**，不再是删除已有行的许可；30 天未见的行仍会被清理，只有更宽的模式能让文件长过已持有的行数。注释和测试都写清了这条语义（切片模式下更大的文件既不会被裁小、也不会再长大，只会被替换）。
- **TTL 从「门」改成「信号」**（用户问「这一块怎么做比较好」）。`needsSkillWalk` 原先只在 `force: true` 下被调用，TTL 分支是死代码。取舍上不该让它自动开走查——「收录是显式动作」是第 60 批就定下的规则，打开页面不该替用户花 14 分钟。所以给它一个真正的消费者：市场响应里的 `index` 现在带 `stale` / `ageMs` / `needsWalk`，面板据此在索引行说「索引已过期，建议重新收录」，按钮仍是「收录到本机」。TTL 因此从死代码变成「要不要提示」的判断，自动开走查这条路依然没有。
- **走查中换选择不再被静默丢掉**（用户问「这一块什么意思」）。`startSkillWalk` 在已有走查时早退，路由比较 `walk !== before` 后回 200 `started:false`——新的 `full` 选择被无声丢弃。现在路由先用 `sameWalkSelection` 分辨：同一份选择 → 依旧安静地回 200（重复点击不算错）；不同选择 → 409 +「正在收录中，当前选择与本次不同：先点「停止收录」，再按新的选择重来」，面板直接把这句话显示出来。
- 测试：`test/skill-index.test.mjs` 28 → 30（上限不缩、`sameWalkSelection` 的四种情形），`test/index.test.mjs` 59 → 61（过期索引只提示不自动走查；不同选择 409 / 同选择 200 —— 后者用一个「卡住的 fetch」让走查真的在飞，不靠竞速）。门禁 463/463。
- 版本 0.29.0。

## 0.28.0 — 2026-10-29
用户 `/skill-router` 后要求「审查一下代码，查看还有没有什么问题或者明显的逻辑问题」。按两轴（标准 / 规格）评审第 60–65 批的 2,449 行新增，修掉下面这些——前半是本轮自查发现的，后半是并行评审报出、我逐条核实过的。
- **全量收录的收尾合并漏了模式的 cap**：中途每 5 秒写盘用 `limitsForModes().maxRows`（全量 400,000），走完后的最后一次写盘却回落到默认 24,000——14 分钟收的 210k 行被裁回 24k，还写成 `complete: true`。现在收尾也用同一份 cap。
- **增量写盘没带 `modes`/`minStars`**：全量跑到一半重启，文件读回来是「全是切片、GitHub ≥5 星」，下一次 start 判定模式变了、清游标从第 1 页重走。现在每次增量写盘都带上这两项。
- **chip 的选择不跟文件对齐**：文件记着 `github: 'full'`、chip 显示「已全量」，但用户没点过 chip 时选择是空的，点收录发 `full: []` → 降级 + 按切片 cap 裁回 24k。现在未点过 chip 时从 `index.modes` 播种，点过之后刷新不覆盖。
- **索引分页的翻页条从第 2 页起消失**（第 60 批的「翻页」实际是死的）：门槛是 `rest.length > pageSize`，而索引模式下每页恰好 ≤ pageSize 行，只有首页被 19 条实时 official 行撑过门槛；第 2 页和任何一次搜索之后都没有上一页/下一页，21 行以后不可达。改为按「是否不止一页」判断，并让搜索把页码重置为 0（原先从第 3 页搜索会用第 0 页的数据显示「4 / N」）。
- **筛选的重复请求**：来源/每页条数各先 `onPage(0)` 再触发自己的请求（两次 POST 竞速，旧参数可能后到）；分类是纯客户端筛选却也发一次请求，与 0.22.0 的声明矛盾。现在来源与每页条数只走一条请求，分类只回卷页码不发请求。
- **有走查在跑时的失败请求被记成插件故障**：`unknown skill index action` / `the skill index action X must be sent as a POST` 都落到 500（`lib/http-status.js` 的 `^unknown \w+ action` 只认单词主语、POST 规则要求 action 与 must 相邻）。同一条规则也一直漏掉了 census/evidence 的同类消息。现在两种形状都映射 400，并补了断言。
- **截断记录会被抹掉**：走查只知道自己这轮截断；一轮里所有游标都已 `done` 时什么都没走，却把 `truncations: []` 写进文件、同时写 `complete: true`。新增 `mergeTruncations`：上一轮仍未解决的截断保留，源这次真的走完才丢弃，同一来源+理由只记一次。
- **GitHub 窗口边界的快照会把整条下潜判死**：5 秒增量写盘可能落在「本档最后一页之后、档位决策之前」，游标存下 `page = pagesPerWindow + 1`；恢复时顶部的守卫直接 `done = true`——剩下的所有档都不再读，且没有截断记录。现在改为把该档从第 1 页重读（重复行按 id 折叠），只多花一个窗口的请求。
- **停止时丢掉行数**：`partial` 只有「已手动停止」，而 census/evidence 都写「（已收 N 行，下次接着走）」。现在带行数。
- **「收录 N」把 19 条实时 official 行算进去了**：它们不在文件里，重启就没了。official 源不再报 `indexed`。
- **折叠按钮在走查期间会把盒子钉住**：点它写的是「取反 pinned」，而展开条件是 `pinned || walking`，走查结束后就再也不自动收起。现在写「取反当前可见状态」。另给已注册页的固定头加了 `maxHeight: 55%` + 自滚动，避免展开的 GitHub 盒把列表挤成 0 高。
- **文档与规范**：README 的 `skills-index.json` 字段表补 `modes`（中文那份还漏了 `minStars`）；chip 那句改成「三个可收录来源的 chip 是按钮」（官方与失败的源仍是标签）。顺手清掉 `MAX_ROWS`/`MAX_ROWS_FULL` 这对与 `SKILL_INDEX_MAX_ROWS(_FULL)` 同值不同名的别名，`normalizeSkillIndexDocument` 的来源集合改为从 `WALK_SOURCES` 派生，`skillIndexSummary` 的 `normalizeModes` 只算一次。
- **版本号规则**：本文件第 9 行写着 patch = 用户可见行为不变，但 0.26.1、0.27.0 都是可见改动却按 patch/批次递增。历史不重写，从这里起按规则：可见修复 → minor。
- 测试：`test/skill-index.test.mjs` 26 → 28（全量 cap、窗口边界恢复、截断合并），`test/http-status.test.mjs` 两处状态映射；门禁 459/459。
- 仍留给用户决定的判断项：一次全量之后再用切片模式收录，收尾合并会按 24,000 把已持有的 210k 行裁掉（`maxRows` 是内存护栏，不保护已持有行）；`needsSkillWalk` 目前只在 `force: true` 下被调用，TTL 分支在运行时是死代码；`startSkillWalk` 在已有走查时早退，新的选择被静默丢弃（常态下按钮此时已是「停止收录」，只有面板状态过期才可达）。
## 0.27.0 — 2026-10-29
- **「GitHub 访问」整块可折叠，默认收起。** 它是四行设置（token、说明、普查、恢复安装命令），压在服务器列表前面；收起后标题行仍然带着状态（`已认证：xxx · 剩余 4.9k/5k` 或 `匿名访问 · 60 次/小时`），所以「凭据现在是什么状况」一眼可见，要看细节点一下标题。标题变成带 `▾/▸` 与 `aria-expanded` 的按钮。
- **普查或恢复正在跑时强制展开**：折叠掉进度和「停止普查 / 停止恢复」按钮，等于把最需要操作的东西藏起来。所以展开条件是「用户点开过 **或** 有走查在跑」，走查结束自动回到收起（除非用户自己点开过）。收起用 `display: none` 而不是卸载，进度行与按钮的 DOM 状态不会因为折叠丢失。
- **探针**：新增折叠断言（控件与 body 的 `aria-expanded`/`display` 必须一致；先停掉进行中的走查，再断言默认收起、点一次展开、再点收起），并且都读**点击之后重新渲染**的树——用点击前的旧树断言过一次，结果把 `display: block` 当成了「收起失败」。
- 版本 0.27.0。

## 0.26.1 — 2026-10-29
- **滚动条只属于列表**：上一版把已注册页签的搜索/筛选栏做成 `position: sticky` 钉在滚动容器里，栏位是钉住了，但滚动条属于整个 tab body，于是轨道从最顶上起、与钉住的栏位并排。改成市场页那套结构：tab body 不再滚动（`overflow: hidden`），筛选行作为 chrome 留在外面，列表单独一个 `overflow-y: auto` 的盒子并持有 `data-omkt="scroller"`（回顶按钮绑的就是它）。现在滚动条从筛选行下面开始，只覆盖列表。MCP 与 Skill 两个空间都改了。
- Skill 空间钉住的是「全部来源 + 搜索」和「N 个 skill · N 个文件」；MCP 空间钉住的是统计行、来源已删除提示、更新队列与筛选行——这些本来就在列表之前，顺序没变，不是把它们塞进 sticky。
- 探针同步改成结构性断言：body 必须 `overflow: hidden`、内层盒子必须有 `data-omkt="scroller"`、筛选行与统计行必须在 scroller 之外（`containsNode` 为 false），列表文字必须在里面。上一版那两条「sticky」断言已删除。
- 版本 0.26.1。

## 0.26.0 — 2026-10-29
- **已注册页签的搜索与筛选栏钉在最上方**（MCP 和 Skill 两个空间都做了）。两个页签的滚动容器就是 tab body 本身（`omkt-tabbody` + `data-omkt="scroller"`），所以不能像市场页那样把 chrome 放在滚动盒外面，而是给这一行套一个 `position: sticky; top: 0` 的粘性盒，复用市场页同一份 `smSticky`（背景、阴影、上下内边距一致，滚动时不会露出一条缝）。Skill 空间连「N 个 skill · N 个文件」那行一起钉住——筛选之后第一眼要读的就是它；MCP 空间只钉筛选行（上面的统计、来源已删除提示、更新队列是「读一次」的信息，跟着滚）。
- **探针加了两条断言**：`stickyreg` / `stickyfilters` 必须存在、`position` 必须是 `sticky`、并且真的包含筛选行（`containsNode`），免得以后有人把 wrapper 拆掉、栏位又悄悄跟着列表滚走。
- 版本 0.26.0。

## 0.25.0 — 2026-10-29
- **每个来源可以自己选「切片」还是「全量」。** 之前只有一种收录方式：SkillHub 前 10,000 行、ClawHub 100 页、GitHub ≥5 星。现在 GitHub / SkillHub / ClawHub 三个来源的 chip 都是按钮，点一下选入「全量」，再点取消；「收录到本机」按当前选择走，索引行会写明「已选全量：GitHub（其余按切片）」。选过的模式记进 `skills-index.json` 的 `modes`，所以之后能分清「SkillHub 210k 全量」和「SkillHub 前 10k」——这两种情况的行数看起来像同一件事，含义正相反。
- **全量是什么，代价写在按钮旁边**：SkillHub 全量 = 210,208 行（约 200 MB JSON、2,102 页、约 14 分钟）；ClawHub 没有总数，3 秒 20 行，全量按小时计；GitHub 去掉星级下限 = 38,486 个仓库（约 39 个星标窗口、匿名约 4 分钟/窗口）。`FULL_SLICES` 就是这三组参数，`limitsForModes` 让一次全量收录可以用 3,500 次请求、400,000 行（切片仍是 400 / 24,000），两个上限跟着模式走，调用方没法只拿宽的切片、用窄的上限。
- **切换模式会让该来源从头走**：游标里 `done` 是「这个切片走完了」，不是「这个来源收全了」，所以模式一变就把该源的 `page`/`hi`/`windows`/`cursor` 清掉重走（行仍然保留，靠 id 并集去重）——否则一个已 `done` 的切片游标会让「全量」请求直接跳过。
- **界面**：三个来源 chip 变成 `button`（选中有描边、文案加「· 全量」，`aria-pressed` 跟随），官方 chip 仍是标签；收录失败或取不到的来源仍是标签并保留原因（探针里那条「失败的源要说清原因」没有放宽）。
- **测试**：`test/skill-index.test.mjs` 23 → 25 例（全量只放宽被选中的源、未知来源被忽略、上限随模式走、文档记录 `modes` 且旧文件读作切片）；`test/index.test.mjs` 58 → 59 例（`full: ['github']` 经路由进入 walk 并落进文件，未选中的源保持切片）。

## 0.24.0 — 2026-10-29
- **GitHub 切片不再停在 1,000 行：改成按星标窗口下潜。** 仓库搜索每个查询最多翻到 1,000 条，所以「agent-skills 到底有多少仓库」不是一个查询能问完的；现在先读 `stars:>=5` 的前 10 页，再读 `stars:5..<本档最低星>`（上界取上一档最后一页的最低星，**闭区间**——边界上的同星仓库宁可重读一遍靠 id 去重，也不跳过），直到某一档一次装得下、或者同一 Star 值本身就超过 1,000 条（记 `truncations`：`同一 Star 值无法继续收窄`）。实测 2026-10-29：`topic:agent-skills` 无下限 38,486 个仓库、≥1 星 20,503、**≥5 星 8,387**、≥20 星 2,521、≥50 星 1,584、≥500 星 424——于是下限定在 5 星，约 9 个窗口；真机跑 13 次请求拿到 1,294 行，第一档装满后下潜到 `stars:5..112`，边界与去重都按设计工作。
- **`minStars` 进了文档**：`skills-index.json` 多一个 `minStars` 字段，`/status` 的 `skillIndex` 与市场响应都带出来，GitHub chip 的悬停提示写成「上游报的总数（只算 ≥5 星的仓库）」——否则 `GitHub 8.4k` 会被读成「agent-skills 全部仓库」。`total` 也随之变成**该下限下的总体**，不是无下限的 38,486。
- **续跑更细了**：游标多了 `hi`（当前档的星标上界）与 `windows`（已读窗口数），所以中途停止后从**同一档的下一页**继续，而不是重新从最上面下潜；`MAX_RUN_REQUESTS` 300 → 400，够一次把 150（SkillHub）+ 100（ClawHub）+ 84（GitHub 九档）走完。
- **测试**：`test/skill-index.test.mjs` 17 → 23 例，新增六条用例（装满后下潜并重开第一页、一档装得下就结束、下限档溢出必须具名、续跑停在同一档、同星块原地打转时严格下降、续跑时「盘上已有行」只计一次），并把「GitHub 停在 1000 行」的旧用例换掉；切片断言改成「一档必须正好 1,000」「窗口数必须够到 8,387 行所需」，防止以后有人把上下限调歪。
- **真机建库时又发现并修掉三个问题**（都是只有真跑才会出现的）：① `pageCap` 被 `min(maxPages, target/pageSize)` 提前夹住，SkillHub 走到第 100 页就停了、只拿到 9,767 行——切片自己的页数上限不该假设「每页都产出满页新行」，改成只认 `maxPages`，并在停在页数上限时记 truncation；② 续跑时 `heldOf` 把「盘上基线行数 + 本轮行数」直接相加，而两者 id 大量重叠（重读已收的页/档），把 6,494 行算成 12,044、撞上 target 提前收工——改成传入 `previous` 行、按 **id 并集**计数；③ 星标下潜在「同星块比窗口还宽」时会原地打转：`stars:5..<最低星>` 重新取回同一批 1,000 行，边界不动（实测 44 次请求只增 25 行），改成「一趟没带来新行就严格降到 `最低星-1`」，并把被切掉的同星行记进 `truncations`（`gained===0` 的纯重读不记，那是已经收过的档）。
- **建库结果（2026-10-29 真机，`gh` token，2.5s/次）**：19,774 行 / 16.7 MB —— SkillHub 10,064（总体 210,208）、ClawHub 1,988（无总数，到 100 页上限并记 truncation）、GitHub 7,722（≥5 星总体 8,388；差额 666 行落在被窗口切掉的同星块里，`stars:5..6` 这一档实测 1,128 条、已收 1,128 条，尾部是完整的）。这一轮共 3 次尝试：205 次请求（撞匿名配额）→ 69 次（提前收工，暴露②）→ 77 次（暴露③后重下潜）。

## 0.23.0 — 2026-10-29
- **技能市场有了本地索引，翻页与搜索不再问上游。** 新增 `lib/skill-index.js` + `$DSH_HOME/overall-mcp/skills-index.json`：SkillHub 按下载排序收前 **10,000** 行（`pageSize=100`，每页间隔 400ms）、ClawHub 顺着 `nextCursor` 走到尽头或 **2,000** 行安全上限（每页间隔 3s）、GitHub 收搜索 API 能给的 **1,000** 行（10 页 × 100，匿名配额 6.5s/次，与 MCP 普查共用同一份预算）。实测（2026-10-29）它的列表在走的过程中会移动：连续两页各 100 条只有 **165** 个唯一 slug（18 条跨页重复，其余页内重复），所以 10,000 个唯一行约需 **120** 次请求而不是 100，页数上限取 **150** 留余量；`pageSize` 的上限就是 100（200/300 直接 `400`）。GitHub 排在最后走：它的配额一旦用空会结束本轮，放在最后就不会连累另外两个来源。索引有行之后，市场列表与搜索都从文件里分页（**0 个请求**，且搜索覆盖全部已收录行，而不是四个源的首屏），`install` 也能从索引里解析 id —— 以前只认「最近一次列表返回过的那一页」，从第 2 页起安装就会 404。
- **「已收录」和「上游总量」是两个数，没有被合成一个。** 来源 chip 变成 `SkillHub 209.6k · 已收录 10k` 这种写法：`total` 是上游报的总体（ClawHub 不报就仍然显示 `20+`），`indexed` 是本机实际持有的行数。页签同理，写成 `市场 (247.8k+ · 收录 11k)`。**没有**为了让 `+` 消失而把「爬到的行数」冒充成 `total` —— 那正是 `+` 存在的理由。
- **收录是一个可中断的后台动作，不是打开页面就开始。** 新路由 `GET/POST /api/overall-mcp/skills/market/walk`：`start` 开走、`stop` 停、GET 读状态；每收一页就把游标与已收行写进文件（标记 `complete:false`、`partial:"正在收录（已收 N 行）"`），所以被停止、崩溃或重载之后下次从断点继续，`done` 的切片不再重复走。市场页在计数下面多了一行：`收录到本机` / `停止收录`、已收行数与请求数、以及上次没走完的原因。**打开市场不会自动开始收录**——一万行不该因为有人看了一眼就花出去。
- **状态里的新字段**：`/status` 多了 `skillIndex`（每个源的 `rows` 与上游 `total` 分开、`done`、`page`、`truncations`、`walking/progress/ended/damaged`），数据文件清单里多了 `skills-index.json`。索引是派生数据：损坏就记一条警告、当作没有、下次重走，不隔离也不备份（与 `github-index.json` 同一条规矩）。
- **测试**：`test/skill-index.test.mjs` 16 例（分页与预算、断点续跑从下一页开始、GitHub 十页封顶、凭据只在有 token 时带、ClawHub 游标走到尽头、请求预算耗尽保留已收行、429 报「限流」而不是「坏了」、中止保留游标、合并保留 `firstSeen`、损坏文件只报告不修复、只收已知来源且按 id 去重、搜索跨全索引分页、摘要不把行数当总量、文档往返）。

## 0.22.0 — 2026-10-28
- **市场按八类分组，选分类不花请求。** 上排多了一个「分类」下拉（`全部分类` + 有内容的桶，各带条数），默认视图把卡片按桶分块，块头写桶名与条数。分类是**在客户端算的**：SkillHub 送来的 `category` 直接用，ClawHub 的自由 `topics` 先归一化，再退到「名字＋简介」里的关键词，都不中才落「其他」——选中某个桶只是过滤已经到手的那一页，不会再去问宿主。八个桶固定顺序：开发编程、搜索与检索、办公与文档、内容创作、数据分析、知识与笔记、自动化与智能体、其他。这套映射里有我们自己的判断成分（尤其 ClawHub 的长尾标签，以及官方目录里只有简介的那批条目），换口径时只改 `SKILL_CATEGORIES`／`SKILLHUB_CATEGORY`／`SKILL_CATEGORY_WORDS` 三张表即可。
- **页签报的是目录总量，不是这一页的条数。** 「市场」页签改成 `市场 (247.5k+)`：把各来源能给的最优数字相加——有上游 `total` 的用 `total`（官方 19、SkillHub 209,323、GitHub 38,093），没有的用刚交上来的这页条数（ClawHub 的 `/api/v1/skills` 只给 `items` 与 `nextCursor`，从不报总数），带 `+` 说明这是下限。之前那枚 `市场 (79)` 是四个源首屏 20×4（官方只 19）加出来的，看着像总量其实不是。
- **「官方」不再含糊，卡片也会报星数。** 来源徽章直接写仓库名——官方源显示 `anthropics/skills`，不再是一枚看不懂的「官方」；下载数旁边补上 `★ 4k` 这样的星数（ClawHub／SkillHub／GitHub 都报星，官方目录清单没有，就不画）。英雄卡的脚注按 `SkillHub ↓ 10.2M · ★ 3.1k · v1.2.4` 的顺序排，缺哪项就不出现哪项，不再留一个突兀的 `—`。
- **能折叠，也能先看到条数。** 四个 skill 目录（本插件／本机／Claude／Codex）各自可折叠：目录头就是开关（`▾`/`▸`，回车或空格同样可用），收起后只留目录名与条数。「市场」页签现在也带条数——切到 Skill 空间时顺手读一次列表，宿主对四个上游各有 60 秒到 10 分钟的缓存，所以整个会话只花一轮请求，不是每次点击都发。

- 页头只留一行：构建信息（版本 / pid / 运行时长 / 数据文件 / 日志条数）不再印在标题下，改为「运行日志」按钮的悬停提示；空间胶囊去掉副标题，页脚那句工具前缀说明也一并删掉。
- 页头按原型分成两行：上面一条淡色面板放标识与「本页自己的动作」（图标改成白底圆角块，标题「全局 MCP & Skill」，右侧「重新扫描宿主机」实心 + 「检查更新」纯文字），  面板下面一条更安静的 ident 行写「插件 v0.22.0 · pid · 已运行 · N 个数据文件 · 日志 N 条」，右端是「运行日志」与「导出日志」——构建事实和日志入口从此与页面动作分开，不再挤在标题旁边。
- 空间胶囊上的 Skill 计数不再是省略号：宿主机启动后就把 skill 清单读一次，两个空间在首屏都显示真实数字；还没数出来时干脆不画那枚计数，而不是先摆一个 `…` 让人以为坏了。
- 按 `prototype/mcp-skill-proto-v5.html` 把页面配色补齐：页头是一块淡色面板（中间空间色
  的极淡横向渐隐、同色 8% 描边、18px 圆角），版本号与「点个 star」胶囊改成原型那套暖乳白。
- 空间胶囊放大：图标 40×40、标签 14.5px／670、计数胶囊跟着空间上色（MCP 蓝、Skill 紫），
  选中态是白底加空间色描边；页签的下划线也换成当前空间的强调色，不再一律深灰。
- 调用页换成雾面色：三块头号数字是「白色到空间色」的双层渐变卡加同色描边，左侧服务器栏
  改成半透明卡（滚动时吸顶），选中项用空间色淡底；时间轴竖线是由上到下渐隐的空间色，
  状态点是 mint／salmon／浅蓝，带同色光晕。
- Skill 卡的来源徽章（GitHub／SkillHub／本插件）从名字行挪到描述下面单独一行，长名字不再
  把徽章顶到第二行——四张卡现在版本号与徽章都在同一水平线上。
- 市场卡的圆角与阴影对齐原型（14px、`0 1px 2px + 0 6px 16px` 两层），悬停上浮 2px；
  市场页的「安装」主按钮是空间蓝实心，而不是页头那个深色实心。
- Skill 的「查看」不再是贴右缘的抽屉：改成和 MCP 详情同一张居中卡片（同宽、同圆角、同阴影、
  同一套事实行），标题行是头像块 + 名称 + 「来源 · 文件数 · 体积」，下面依次 名称／版本／作者／
  许可／来源／目录／主页／更新，再往下是「目录结构」代码块与「需重启 DSH」提示，底部左「移除」、
  右「打开目录」。卡片只陈述磁盘上确有的事实——文件数与体积，不编造文件名清单。
- **分类覆盖全部条目，下方就是筛选结果，并且分页。** 每个条目都会落进八个桶之一：SkillHub 送来的
  `category` 直接用，ClawHub 的自由 `topics` 先归一化，再退到「名字＋简介」里的关键词，都不中才
  落「其他」——所以下拉里每个桶的数字加起来等于总数，不是只分了上游给过分类的那批。选一个桶之后，
  下面那张网格只剩这个桶的行，不再先摆一堆桶标题；每页 20／50／100 条，不够一页就不画页脚。
  换每页条数时会重新向各源要更大的页（宿主一个源最多给 60 行），所以「每页 100 条」翻的是真取回来
  的那 240 行，而不是把一页 79 行切碎；翻页、换分类则纯客户端切片，探针专门数了 POST 次数来钉住
  这一点。统计行也写明了翻页范围：「翻页只在这 N 条之内」——页签的 247.8k+ 是目录总量，两者不是
  一回事。
- Skill 市场按原型 v5 重排：顶部一行「需重启 DSH」提示，搜索框单独一行、筛选与刷新在第二行，
  统计行右侧按来源列出各自条数，中间两张 spotlight（★ 官方精选／🔥 热门，带渐变底与
  「安装到本插件」），下面三列卡片（头像块 + 名称 + 来源徽章 · 版本，描述三行截断，底部下载数
  与安装按钮），末尾是安装目录说明。
- **「市场 (79)」的真相**：那不是市场总量，是四个上游首屏条数之和（ClawHub／SkillHub／GitHub
  各 20，官方 19）。现在每个来源优先显示上游报的 `total`（官方 19、SkillHub 209.3k），
  ClawHub 的 `/api/v1/skills` 只给游标分页、没有总数，因此写成「20+」；四个来源齐全时才说
  「N 个可用 Skill」，缺任何一家就退成「N 个已列出（各源首屏） · 带 + 的来源按页给，没有总数」，
  页签计数改成「整个市场的总数」：把各源能给的最优数字相加（有 total 用 total，没有就用它刚给的这页），
  任何一家报不出总数时补一个「+」，表示这只是下限——ClawHub 永远报不出，所以真机上会看到类似
  「市场 (247.5k+)」而不是「(79)」。取不到的来源照旧标红并写原因。
- **修掉一条造假的行**：`calls.jsonl` 里 `0.20.x` 写下的「会话加载」旧行会被读成
  `skill: null`，在左栏聚成一个叫「未知 skill」的分组。现在读入时直接跳过这种行，并补了
  用例 `a legacy 会话加载 row from 0.20.x is skipped…`；空 id 的兜底文案也从「未知 skill」
  改成「未记录 skill」。

## 0.21.0 — 2026-10-28

- 调用页按时间轴重画：每行左边一条竖线加一个状态点，行与行接在同一条线上；标题是该行
  真正动的东西（MCP 是工具名，Skill 是被加载的 skill 名），会话只在下面标注一次。
- **不再记「会话加载」这种行**。宿主在会话启动时建 skill 目录不是一次调用，之前为了填满
  Skill 的调用页而造了这一行，现在删掉——Skill 的调用页只记「触发」事件，并在提示行里
  写明「触发」由宿主发起、不是远程 RPC 往返。
- 三块头号数字各带一条按小时的真实折线（24 个桶）；某一块没有数据就写 `-`，不画空线。
  成功率与平均耗时在筛选框为空时取宿主按整个时间窗算出的值，打字后才改成「当前这几条」——
  以前一律按屏幕上那几条算，数字会和「今日调用」自相矛盾。
- 搜索框改成即时本地过滤：不再有「搜索」按钮，也不再因为打字发请求。宿主仍然接受 `q`。
- 展开按钮统一成 `▸ 展开请求 / 响应`，展开后原地变成 `▾ 收起请求 / 响应`。
- 顶部提示行、时间窗文案（`近1小时`/`近24小时`/`近7天`）、统计小字（「当前筛选 · 成功 N /
  失败 M」「工具往返延迟」/「宿主加载 / 触发耗时」）与空态（波形图标 + 分空间的一句话）
  都按原型补齐。
- 卡片与开关补上样式规则（`.omkt-calltoggle`），布局探针不再报 `missing in sheet`。
- 图片按新界面重出。

## 0.20.1 — 2026-10-28

- Skill 空间的「已注册」不再和「调用」一起高亮。它原先的判定是「市场没开就算选中」，而「调用」也会关掉市场，于是两个标签同时点亮。现在只在既不是市场、也不是调用时才高亮，探针加了一条断言：任一空间里被选中的标签必须只有一个。
- 图片按新版本徽章重出。
## 0.20.0 — 2026-10-28

- Both spaces gain a third tab, 调用: what ran, not what is configured. It
  reads a call feed the plugin now records itself, and it never writes a
  configuration. 已注册 still answers "is it installed and healthy", 市场 still
  answers "what can I install", 调用 only answers "what happened".
- The feed is recorded by subscribing to the host's `session/event` stream
  (`tool/call` → `tool/result`, paired by `callId`): MCP rows are the
  `mcp__<server>__<tool>` round trips, with the latency the host measured and
  the failure text when the tool returned one. Native tools (`read`, `bash`, …)
  are deliberately not recorded — the page would otherwise drown in them.
- The Skill space's feed is host-side, and says so: one 会话加载 row per session
  (the host builds the skill catalogue once, at session start) plus one 触发 row
  per `skill` tool call. These are not remote RPC round trips, and a page line
  states that adding or removing a skill needs a DSH restart to reach a new
  session.
- Three numbers on top: 今日调用 (today's count, fixed meaning per space), plus
  a success rate and an average latency that follow the current filter. Left
  rail: 全部 or one server / one skill, each with today's count and a 24-hour
  spark; a name that is no longer installed still lists its history and is
  marked 已不在册. Windows: 近 1 小时 / 近 24 小时 / 近 7 天. Search narrows by
  tool or session id (MCP) and by skill name or event type (Skill).
- Cards keep the default view to one line — status dot, name, latency pill,
  short session id, time — and open onto the request and the response on
  click. A call still waiting says 进行中 and its response says it is waiting
  rather than showing an empty box. 导出 copies the current list as JSON.
- The feed is kept in `calls.jsonl` next to the registry: seven days, newest
  20,000 lines / 8 MiB, redacted (`authorization`, `token`, `api_key`, `secret`,
  `cookie`, `password`, `credential`), and a `running` row left behind by a
  host restart is read back as 无结果 instead of pretending to still be in
  flight.
- Deep links: `?space=mcp&tab=calls`, `?space=skill&tab=calls`, and the existing
  tab names, so a bookmark can open the feed directly.

## 0.19.1 — 2026-10-28

- The search pill on both Skill tabs now behaves like the MCP market's: the
  outer `.omkt-search` draws the only border, the input inside it uses
  `styles.searchInput` (borderless, `flex: 1`), and the injected sheet states
  the same rule as `.omkt-search .omkt-input` so a dropped inline style cannot
  bring the inner frame back. Before this the Skill box relied on a single
  inline `border: 0` and carried no `flex: 1`: it could draw its own frame
  inside the pill, and stopped at its default 20-character width — which read
  as a small input nested in a big empty pill.
- Pictures regenerated: `docs/images/skill.png`, `docs/images/skillmarket.png`
  (plus the header-version ones).

## 0.19.0 — 2026-10-28

**Skill 有了自己的市场，来源说的是真话**——「市场」标签页同时问 ClawHub、SkillHub、官方、GitHub 四个地方，一颗 chip 一个来源，取不到的那个写原因，而不是让整页跟着一起空白。

- 来源口径（四个都要，且四个都不一样）：
  - **ClawHub**：`GET https://clawhub.ai/api/v1/skills`（无 query，按 downloads 排序、`nonSuspiciousOnly=true`）与 `/api/v1/search?q=`（有 query）；安装走 `/api/v1/download?slug=&ownerHandle=&version=` 拿 ZIP。**必须带 `ownerHandle`**：slug 不全局唯一，不带就回 409 `Ambiguous skill slug`（实测过一次）。文档允许第三方目录读公开端点，但要求缓存、尊重 429/Retry-After、回链 `https://clawhub.ai/<owner>/skills/<slug>`，三条都做了：卡片 `pageUrl` 指原始页、无 query 的列表缓存 60 秒。
  - **官方 = `anthropics/skills`**：`/repos/anthropics/skills/contents/skills` 列 19 个目录，再取每个目录的 `SKILL.md` frontmatter 填标题与描述；安装按 `git/trees/<ref>?recursive=1` 下整目录。**这不是「DSH 官方」**：全量扫过 DSH 安装包（18,188 个文件），没有任何 skill 市场域名，DSH 自己的 skill 是随包分发、按六个固定目录加载的；npm 上 `keywords:dsh-skill` 目前 24 条几乎全是第三方插件（`dsh-plugin-guide`、`infoseek` 之类），把那些标成「官方」是误导。README 与面板都写清这条口径。
  - **SkillHub = `api.skillhub.cn`**：列表与搜索同一个端点 `GET /api/skills?page=&pageSize=<1..100>&sortBy=downloads&order=desc&keyword=`，行里带 `downloads/stars/version/category/description_zh/homepage`；安装 `GET /api/v1/download?slug=` 拿 ZIP。**这个站不存在的 slug 也回 200 + 一个 zip**，所以包内必须有根 `SKILL.md`，否则报「这个 slug 可能不存在」而不是往 skill 目录里写垃圾。SDK 文档里的 `skillhub.ing` 域名已失效（DNS 查不到），英文站 `skillhub.club` 匿名全 401/405。
  - **GitHub**：有 token 走 `/search/code?q=filename:SKILL.md`（能定位到目录）；无 token 走 `/search/repositories?q=topic:agent-skills`（只能到仓库根），匿名 search 配额是每分钟 10 次、按出口 IP 共享，`403 API rate limit exceeded` 会如实显示成该源错误，不影响另外三个。
- 每个源独立结算：`sources: [{id,label,count,error}]`，一个源挂掉只是它自己那颗 chip 变红并带 `title` 原文。
- `lib/zip.js`（新增，纯 Node，无依赖）：只读解包，拒绝 `..`、绝对路径、反斜杠、盘符、符号链接、加密条目与非常规压缩方法，上限 5000 条目 / 64 MiB 解压后体积；解包结果必须有根 `SKILL.md`。
- 安装落点只有本插件自己的目录：`$DSH_HOME/skills/<名字>/`，宿主只接受「我们自己列过的 id + 桶名」，不接受客户端给的路径；写完回显确切路径与文件数，并提示重启 DSH 才加载。
- 面板右下那句写清装到哪里、描述与版本都照抄各站、装之前先看一眼来源页的 `SKILL.md`；已安装过的卡片按钮变「已安装」，「不能装」的来源（只有索引的那种）禁用并 `title` 说明原因。
- 内存里保留 30 分钟的 id→物品索引（安装时按 id 找，避免客户端伪造安装描述）；各源缓存 60 秒到 10 分钟不等（官方 10 分钟、SkillHub 10 分钟，因为这两边条目变化慢）。
- 测试：`test/skill-market.test.mjs` 13 个用例（四源枚举、ClawHub 列表/搜索/解包安装/409 owner 消歧、GitHub 转交 JSON、官方列表与整目录安装、SkillHub 列表与搜索与缺 `SKILL.md` 拒装、单源失败不影响其它源、有无 token 两条路径、未知源不发请求），`test/zip.test.mjs` 4 个用例（store+deflate、越界路径、加密/符号链接/未知方法、无 EOCD 的坏包）。
- 探针：`tools/render-market-tab.mjs` 第 8 节再添 16 条断言（页面出现 `skillmarketbody` 且 `skillbody` 消失、四源 chip、红底 chip 的 `title` 是 403 原文、三张卡的名字/徽章/版本/下载量、点「安装」发出 `POST /skills/market/install id=… root=plugin` 并刷新列表、提交表单发出 `POST /skills/market query=pdf`）；README 第 6 张图 `docs/images/skillmarket.png`。

## 0.18.1 — 2026-10-28

**一个目录里的 skill 有几个，和它贡献了几行，不是同一个数**——原来的界面只印后一个，于是 `Claude（21）` 读起来像那个目录几乎是空的。

- 后端 `readSkills()` 的每个根现在同时给出 `found`（目录里实际有几个）、`count`（去掉重复后留下几行）、`folded`（被更靠前的目录遮住几个）；`duplicates` 仍是总和。真机一测就看出差别：`~/.agents/skills` 372 个全留下；`~/.claude/skills` **225 个里 204 个是共享目录的副本**，只贡献 21 行；`~/.codex/skills` 67 个里 25 个重复，贡献 42 行；合计 435 行、229 个重复副本——四个目录的来源都在这里，没有「无来源」的 skill。
- 界面跟着改：来源下拉和分组标题印 `found`（`Claude（225）`），不再是留下几行；一个有折叠的分组会补一句「这里共 225 个，其中 204 个与更靠前的目录重复，已折叠；下面列出独有的 21 个」；整组都被折叠时（`found` 有、`count` 是 0）只留那句「这 N 个都在更靠前的目录里出现过，已折叠」，不再重复两遍。
- 分组过滤也放宽到 `folded > 0`：否则整组被折叠的根会从页面上消失、而下拉框还写着它有几个。
- `test/skills.test.mjs` 的重复用例改成同时断言三个数（`codex` 目录里有 1 个、贡献 0 行、折叠 1 个）；`tools/render-market-tab.mjs` 的 fixture 带上 `found/folded`，断言下拉是 `Claude（6）`、折叠说明是「共 6 个，其中 4 个…」，共 35 条；`docs/images/skill.png` 重出（四组 + 折叠说明）。
## 0.18.0 — 2026-10-27

### Skill 从哪来：四个目录都列出来，移除只是搬走

- **第四个来源**：除了 `$DSH_HOME/skills`（本插件）、`~/.agents/skills`（本机）、`~/.codex/skills`（Codex），现在也列 `~/.claude/skills`（Claude）。这台机器上 Claude 的目录其实是 `~/.agents/skills` 的严格子集（225 个同名，0 个独有），列出来仍然是必要的：这一页要回答的是「这些 skill 从哪来」，只列三个是半答案——尤其是当某天它们不再重合时，没人会想起回来补。
- 被前面的目录抢先的同名 skill 记作重复副本，**分组不会因此消失**：`Claude（4）` 会显示出来并写明「这 4 个都在更靠前的目录里出现过，已折叠」。之前这种分组会整块消失，于是来源下拉框写着「Claude（4）」而页面上找不到它——两个地方对同一件事给出不同答案。
- **移除 = 移动，不删除**：任何一张卡与抽屉底部都有「移除」，点了先弹一张居中的确认框，写清四件事——只移动不删除、目标在 `$DSH_HOME/overall-mcp/skills-trash/<时间戳>/<来源>-<目录名>`、这个目录如果是别的工具（不是本插件建的）也照做、移完要重启 DSH 才从会话里消失。用弹窗而不是卡片上再点一次，是因为要展示**确切目录**；只确认一次，因为「移动」本身就是撤销手段。
- 目标重名时依次落 `-2`、`-3`，两次移除同一名字不会互相覆盖；跨盘移动（`EXDEV`/`EPERM`/`EACCES`）才降级为复制后删除。
- 宿主这次的新路由：`POST /api/overall-mcp/skills/remove`，同一个请求里必须带 `confirm: true`（少一个字段就是 400），只接受本次扫描列出的 id，成功回 200 与 `trashedTo`，并清掉 60 秒缓存——移除之后再普通读一次就必须看到磁盘。页面对不认识的 id 一律拒绝。
- 探针新增一条完整走线：打开确认 → 取消（不发请求、卡片还在）→ 再打开 → 确认 → 断言到达宿主、页面写出去向、卡片变两张、且重新读宿主发生在移动**之后**。单测从 406 增到 **411**（skills 7→12，宿主用例补移除契约）。
## 0.17.0 — 2026-10-27

### 页面有了两个空间：MCP 与 Skill

- 页头下面多了**两颗平分一行的胶囊**：左边 MCP（连接器、工具前缀、健康检查），右边 Skill（剧本能力包、会话启动加载）。它们不是筛选器，是两个空间——各有自己的条目、动作与颜色；胶囊上的数字是另一个空间唯一会显示的数目，切换之前就能知道那边有多少东西。
- 为什么不用下拉框：下拉框说的是「在这些里面筛出匹配的」，而这恰恰是它们不是的关系。
- Skill 空间按**目录来源分组**：本插件（`$DSH_HOME/skills`）、本机（`~/.agents/skills`）、Codex（`~/.codex/skills`）。分组是有边框的一块，因为来源是这一页唯一真实的层级——四百张卡片平铺，就看不出某一行来自哪个目录，而「这堆东西从哪来」正是这一页要回答的问题。
- 每个 skill 一张卡：首字母色块、名称、来源徽章（ECC / SkillHub / ClawHub / 内置…）、版本、两行描述、`N 个文件 · 体积 · 最近改动`，右侧「查看」「打开目录」。
- 「查看」开右侧抽屉：版本、许可、作者、主页、文件数、更新时间、完整路径与整段描述，底部一个「打开目录」。抽屉而不是居中弹窗，是为了让列表留在旁边——连着看第二个时不用重新找回位置。
- 「打开目录」走宿主（`POST /api/overall-mcp/skills/reveal`），只接受**本次扫描列出的 id**，页面无法用它启动任意程序；结果写在 Skill 页体顶端（「已在文件管理器里打开：…」），失败也照实说。
- 这一层没有「启用 / 停用」：skill 由宿主在会话启动时加载，页面能做的只有看清与打开，所以提示行直接写「新增或移除后要重启 DSH 才生效」。
- 目录不存在时**分组仍然显示**并说明「这个目录还不存在（第一次往这里放 skill 时会创建）」：把没有内容的根悄悄藏掉，看起来和「扫描漏了」一模一样。
- 重复的 skill（同名同描述）只保留先出现的那一份，计数行写「去掉 N 个重复副本」。
- 版本号两种写法都能显示：`version: 1.2.0` 与 `version: v1.2.0` 都只渲染出一个 `v`。
- 「市场」标签在 Skill 空间里先以**禁用**状态出现，`title` 写明还没接（来源要先定：ClawHub / SkillHub / 官方 / GitHub）。
- `tools/render-market-tab.mjs` 增加一节断言（22 条）：两颗胶囊的选中态与文案、切到 Skill 只发一次 `GET /skills`、registry 页体不再出现在 Skill 空间、两个标签与市场标签的禁用、分组与缺目录说明、卡片上的来源/版本/体积、抽屉开合、「打开目录」发出的 id 与结果文案。
- `tools/readme-shots.mjs` 增加第 5 张图 `docs/images/skill.png`（真客户端 + 固定数据），两份 README 都引用它。
- 后端新增 `lib/skills.js`（`skillRoots()` 三根、frontmatter 解析、按目录测量文件数与体积、`SKILL_FILE='SKILL.md'`、`MAX_FILES_PER_SKILL=500`）与两条路由 `GET/POST /api/overall-mcp/skills`、`POST /api/overall-mcp/skills/reveal`；`skillsPayload` 缓存 60 秒，`?refresh=1` 跳过。

## 0.16.0 — 2026-10-27

### 检测不到本机登录时，给一条能走的路

- 「检测本机登录」空手而归之后，同一个位置不再留着那个刚刚失败的动词，而是换成**「去网页登录」**：打开 github.com 的 token 创建页，只勾 `read:user`（插件唯一用到的权限），说明一栏预填 `dsh-overall-mcp`，方便几个月后在 token 列表里认出它。拿到的 token 粘到左边的输入框保存即可。
- 为什么必须换：本机检测依赖 `gh` 存在且已登录，这在本机上是「有」或「没有」的既成事实——再点一百次也是同一答案。网页那条路不依赖任何本机工具。
- 动词没被删掉，只是挪开了：旁边留一个「再检测一次」，给刚在终端里 `gh auth login` 过的人；而 token 被 GitHub 拒绝（401）时也直接进入网页路径，因为那也是「本机这条走不通」。
- 空手而归时会多一行说明，写清「在 github.com 创建只读 token → 粘贴 → 保存」这三步，因为此时面板之前的假设（读者手上已经有 token）不成立。
- `tools/render-market-tab.mjs` 增加断言：检测空手后按钮消失、出现指向 `settings/tokens/new?scopes=read:user` 的链接、「再检测一次」仍在。

## 0.15.0 — 2026-10-27

### 检测过的本机登录会被记住，重启不再重测

- 「检测本机登录」找到的账号写在数据目录的 `gh-login.json` 里；之后的启动直接读这份答案，**既不起 `gh` 进程也不发请求**。面板上那行会写「本机 gh（沿用上次检测）」，账号、配额、上次校验时间都还在。
- 记住的东西有边界：7 天窗口（过期回到匿名，按钮仍可手动再测）；`gh auth logout` 后再点检测，会连同记住的那份一起清掉；GitHub 回 401 时同样立即删除——重启不会复活一个已被拒绝的凭据。文件只存在本机，权限 0600，内容不含掩码之外的东西。
- 这一条是为了回应「不能每次重启都检测」：每次启动跑一次 `gh auth token` 并打两次网络请求，换来的信息和上次完全一样。

### 页头不再有两扇门

- 已注册页去掉了「打开 MCP 市场」文字按钮——下面那排页签本身就是切换器，重复一个入口只会让人点两次。市场页保留「重新扫描宿主机」，因为那里的「刷新」只重读目录，不重扫本机。

## 0.14.1 — 2026-10-27

### 远端服务器不再被塞一个「不确定」的配置项

- 以前的代码给**每一条** http/sse 行都写一个可选的 `Authorization` 头字段，理由是「多数远端可能要令牌」。没有任何端点声明过它，所以弹层只能把它标成「来源未声明」——一台能用的服务器旁边，挂着一个没人问过的问题。
- 现在字段跟着证据走：端点回过 401 才会出现这个字段，而且是**必填**、来源写「端点要求」；端点 200 应答过就说明不要凭据，不出现；还没探测过的行也不猜——弹层里的「加一行」仍然是手动补变量的入口。
- 老行里那个无值的发明字段会在加载注册表时删掉（有值的不动，那是用户自己填的）。
- 端点在回 401 时给的是 `Bearer <令牌>` 格式要求：`applyValues` 见到 `scheme: 'bearer'` 而值没有认证方案前缀，会自动补上 `Bearer `，回执把这一步记成 `prefixed`，不再让服务端因为「格式错」而拒绝一个正确的令牌。

### 检查不通过时，按通道说真相

- 远端（http/sse）行一个工具都没注册，以前也照抄 stdio 的说法「服务进程可能已经退出」——远端没有本地进程。现在：端点回过 401 的，说「端点拒绝了这次会话（HTTP 401）；检查配置里的凭据」；其余远端说「远端端点没有提供任何工具：可能还在预热，或这个地址不是 MCP 端点」；只有 stdio 才说进程可能退出。
- 弹层里字段来源的兜底文案从「来源未声明」改成「本插件补充」：它确实是本插件加的，而「未声明」听起来像服务器的错。

## 0.14.0 — 2026-10-27

一批「界面说一半、命令拼错」的修复，全部来自对现有实现的自查；每一条都有对应的用例或门禁。

### 配置弹层不再吞掉你填的值

- 保存**失败**时不再清空表单：之前无论成功失败都执行清空并关闭，服务端拒绝（缺必填、值不合法）时用户刚填的几行一起消失，只能从头再填。现在失败保留输入、列出被拒的项、按钮原地变「确认中…」。
- 空值的手填行不再被静默丢弃：保存前拦下并点名是哪一行，要么填值、要么删掉那一行。
- 保存请求在途时，配置按钮显示「确认中…」并禁用，不再出现「点了没反应又点一次」。

### 检查与安装期间的界面

- 一行正在「检查」时，它的启用/停用、配置、移除按钮一并禁用：之前可以在 12 秒的握手等待里把这一行删掉，结论回来时无行可落。
- 安装与检查双击不再重复提交（同一个动作在途时第二次点击直接忽略）。
- 市场翻页、搜索后再安装，不再被弹回第 1 页；收藏的回滚按行定位，不再因为对象身份变化回滚到别的卡片。
- 默认排序的标签改成「默认（多源均衡）」，它确实不按质量排——之前标签写着「默认（综合推荐）」而实际顺序由宿主轮换决定。
- 市场详情弹层支持 Esc 关闭（此前只能点遮罩）。

### 仓库安装命令拼得对

- `pyproject.toml` 现在读 `[project.scripts]` / `[tool.poetry.scripts]`：脚本名与分发包名不同时生成 `uvx --from <包> <脚本>`。之前只读包名，`uvx <包>` 在这些项目上根本没有可执行入口。同时按 section 切分，不再把后面某个表的 `name =` 当成本项目名。
- README 里的 `uvx --from <包> <脚本>` 不再被压成 `uvx <包>`，命令后面的 `--transport stdio` 这类参数也保留；但「`npx foo` to start the server」这种正文不会被当成参数。
- 中文标题的仓库不再全部撞成 `mcp`：slug 取不到 ASCII 时改用可复现的短哈希。
- 扫描补上两处漏读：Codex 的行内 `env` 表、Claude Code 项目级 `mcpServers`；安装诊断只对密钥类 flag 打码，`--auth-type oauth` 不再被涂成 `--auth-type <redacted>`。

### 宿主

- 两行同名（同一客户端配置里同一服务写了两个版本）不再共用一个检查结论：结论跟着行，没检查过的那行保持「未检查」，不再借用邻居的绿灯。
- 激活最多等 2.5 秒的启动握手：首次 `npx` 下载可以把一个挂载拖上几分钟，之前整个插件要等所有服务器都回答完才返回，面板连列表都画不出来。没答完的继续在后台连接，下一次读列表就是它的结果。

## 0.13.0 — 2026-10-27

### 八条会咬人的问题（P1）

这一批全部来自一次针对逻辑与功能的审查，每条都带回归测试。

- **并发写不再互相踩**：落盘用的临时文件名原本是固定的 `<文件>.tmp`，同一进程里两次写会共用它；而几条读路径（目录刷新、每行目的说明、配置提示）的保存根本不进写队列。现在临时名带进程号与序号，且**所有**保存共用一条写链。
- **检查与安装不再抢队列**：`检查更新` 曾把整个网络遍历放在变更队列里，八台慢注册表能把每一台服务器的开关冻住一分多钟。现在网络部分（更新查询、Smithery 补齐、授权复探）在队列外、按**有界并发**（4）跑，只有写回结论那一步进队列；写回时逐行确认该行**仍在注册表里**，检查期间被移除的行不会被写回来。
- **`检查` 不再在身后留下幽灵挂载**：重试挂载原本裸跑在队列外，一次等满 12 秒握手的检查若遇上用户把这一行移除，会挂上一个没有行可认领的 fiber（之后的移除/停用都碰不到它）。现在挂载进队列，并在队列槽内重新确认真实行、启用状态与已有 fiber。
- **VS Code 的服务器能被扫到了**：配置文件里服务器的键在 VS Code 是 `servers`（`mcp.json`）与 `mcp.servers`（`settings.json`），扫描器只认 `mcpServers`——十个服务器会被告知一个也没有。
- **带空格的「命令」不再能发布**：投稿校验原本只在参数栏为空时才拦带空格的命令，`npx -y foo` 加上参数就能通过，发布成一条把整句话当可执行文件的行；市场侧也不再为这种行显示安装按钮（不猜如何拆参数）。
- **docker 的运行参数不再被当镜像**：`--restart unless-stopped`、`-m 512m` 这类带值选项不在识别表里，`unless-stopped` 看似镜像，`-e` 键被插到它前面，容器带着错的 argv 起不来。识别表补齐了常用运行参数，并支持 `--memory=1g` 这种自含写法。
- **Gemini 的远程服务器能被导入**：Gemini CLI 把远端端点写在 `httpUrl`（`url` 留给 SSE），只认 `url` 会把它的远端行全丢掉。
- **检查中的行不能被改动**：检查一颗服务器期间，同一行的配置、更新、启用/停用、移除按钮都禁用——那只会在结论描述一个已经不存在的行时给出漂亮数字。安装按钮也加了单飞：一次只发一个安装请求。

## 0.12.9 — 2026-10-18

### 检查更新从此真的能跑完

- 根因：检查更新末尾有一段「补探需要授权的行」的修复步骤，读的是 `state.servers`——旧版 state-map 的残留，现在的注册表叫 `registry.servers`。这个名字在那一层作用域里根本不存在，于是每次点「检查更新」（以及模型调用 `overall_mcp_check_updates`）都在算完结论之后立刻抛 `ReferenceError`：接口 500，且紧随其后的 `save()` 不执行，算出来的结论永远落不了盘。
- 修掉变量名，并把这段修复步骤包进 `try/catch`：它是附带的修补，不该决定整个检查的成败。失败只记一条 warn，结论照旧保存。
- 回归测试 `the update check heals a legacy OAuth row instead of throwing`：造一行旧形状（`resourceUrl` 指向 RFC 9728 元数据），断言 `/api/overall-mcp/updates` 返回 200、该行被治愈（`resourceUrl` 消失、`oauth: true`）、注册表已落盘。把修复回退后，这条测试报的正是 `{"error":"state is not defined","status":500}`。
- 这个 bug 由 0.12.4（区分授权入口）引入，0.12.5–0.12.8 都在，期间每一次检查更新都是 500。

## 0.12.8 — 2026-10-18

### 批次号不再靠记忆

- 新增 `tools/next-batch.mjs`（`npm run batch:next`）：读 `git log --format=%s`，用 `/第\s*(\d+)\s*批/u` 取已有的最大号，加一打印成 `第 N 批`；`--bare` 只打印数字，供脚本拼接。
- 起因是重号：第 40、41、42、43 批各自出现了两个提交，因为两个会话在同一个工作树上编辑，都按各自的记忆报了下一位。规则改为「提交前当场问历史」，本文件开头也写进了这条。
- 第 40/41 批保持现状（改写要穿过另一个会话的提交再强推 main，收益不抵风险）；从 0.12.8 起不再产生新的重号。

## 0.12.7 — 2026-10-18

### 包里的 README，图片不再断

- `files` 里补上 `docs`：README 的两个语言版本都用相对路径引用 `docs/images/*.png`，而 `files` 决定包里有什么——此前从 GitHub 或 npm 装下来的那份，README 的每张图都是断链。截图总计约 450KB，换来包里文档自洽。
- 新增 `docs/install-check.md`：把「从 GitHub 装一次」的实测完整记录下来（2.4 秒、无构建授权、lockfile 钉到某个提交、装完自动启用、唯一的 peer 警告及其含义、移除后 profile 复原），并回答「为什么不发 npm 包」。

### 从 Git 源装的，不再去问 npm 有没有新版

- `lib/self-update.js` 新增 `isGitSpec(spec)`，识别 pnpm 接受的几种 Git 写法（`github:owner/repo`、`git+https://…`、`git://…`、裸 `https://….git`，均可带 `#tag`）。
- 命中 Git 源时自更新检查直接返回 `reason: 'git'`，不再请求 npm。在此之前它会走到 npm 查询分支、拿到必然的 404，界面于是显示「npm 上查不到 dsh-overall-mcp 的发布版本」——真话，但答非所问：这个包从没打算发到 npm。现在给出的提示是该执行的那条命令（`dsh plugin add <spec>`，想钉版本就加 `#<tag>`）。
- `updateSelf` 在这类安装上不会执行任何命令（此前会拼出 `dsh plugin add dsh-overall-mcp@<latest>`，那是个必然失败的命令）。

## 0.12.6 — 2026-10-18

### 装过的服务器，市场里不再说「安装」

- Smithery 的托管条目在列表里没有端点（要等安装时问详情接口），因此**建不出注册表条目**；上一版拿「能不能建出条目」判断装没装，于是 brave-search 已经装好、市场卡片上仍是一个「安装」按钮。现在名字单独算（`proposedNameOf`，只取决于标题），装没装按名字比对。
- 结果：装过的卡片显示「已安装」，点不进重复安装；要重装仍可以——先在注册表页移除那一行，再回市场装。

## 0.12.5 — 2026-10-18

### 检查结论不再钉死在失败上

- 「检查」写下的结论按会话保存，**成功时会被自动升级**：一行的旧结论失败、但此刻的事实（挂着、握手过、工具有）已经成立，列表会把结论换成一次真实的通过记录，不必等用户再点一次检查。装完客户端就当场看工具数的那次动作，最容易抓到「连接刚建好、工具还没注册」的一瞬间，旧行为会把这 12 秒的结论一直挂到重启。
- 判定抽成一个函数（`healthVerdict`），列表兜底、手动检查、后台自愈共用同一套事实，不再各写一份。

## 0.12.4 — 2026-10-18

### 授权说明不该点开是一页 JSON

- 一个远端端点回 `401` 并给出 `resource_metadata`，意思是「去问授权服务器」——那是一个给程序读的文档，不是发凭据的地方。上一版把它当成**授权说明 →** 的链接，点开就是一页 `{"authorization_servers":[…]}`，读的人看不出下一步该做什么。
- 现在会真的去读那份文档：读到 `authorization_servers` 就说明这是 **OAuth 登录**（浏览器授权，插件这边走不完，装上也调不通），并把链接换成这台服务器**自己的页面**（Smithery 托管的端点从 `<名字>--<作者>.run.tools` 直接推出 `smithery.ai/servers/@<作者>/<名字>`）；读不到也仍按 OAuth 处理，只是不点服务器名。
- 表单文案跟着分岔：OAuth 的写「除非服务商另外发了 API key，按 `Bearer <令牌>` 填在这里才能用」；普通 `Bearer` 挑战仍写「按文档填」。旧的 `Authorization` 字段（带 `resourceUrl` 的那种）在「检查更新」时重探一次并自愈，不必重装。
- 不变量：机器可读的元数据 URL 永远不会出现在标着「去获取」的位置。

## 0.12.3 — 2026-10-18

### 灯也不许说绿

- 有一个 fiber 不等于能用。挂上了、握手也过了、一个工具都没注册的那一行，圆点一直是绿的——因为灯只按 `connected` 上色，而 `connected` 只回答「有没有 fiber」。现在最近一次「检查」的结论排在它之前：没过就是黄灯，行下行为「已连接 · 检查未通过」，红字仍点名是哪一项没过。
- 结论只活在问它的那个会话里（`index.js` 的 `health` Map），所以这是「刚查过，没过」，而不是一个会跟着行一起存下去的永久状态；重新进面板不会继续挂着黄灯，除非再查一次。
## 0.12.2 — 2026-10-18

### 要填的键，顺手给个「去获取」

- 配置表单在字段下面给两个链接：**去获取 →** 指向描述里写明的那个页面（发布方的句子本来就有，不必让人从一句话里抄 URL），**授权说明 →** 指向端点 401 里给出的授权元数据。两个都在侧栏浏览器里打开，侧栏打不开就走系统浏览器。
- 链接只从**声明**的文字里认：错误信息里的 URL 是证据，不会被当成注册页。早先写下的字段没存链接的，也从发布的描述里补出来。
- 这两种链接回答的不是同一个问题——「去哪儿拿」和「它要哪种凭据」——所以分成两个名字，不合并成一句。

## 0.12.1 — 2026-10-18

- 修：从面板安装托管型 Smithery 条目**永远不会成功**。市场响应里 `raw` 被有意去掉（那是上游整条记录，页面不该背），只把安装需要的一个字段提成 `qualifiedName`；宿主却只读 `raw.qualifiedName`，于是详情端点一次也没被问过，报错还写成「详情端点没有给出 deploymentUrl」——把「没问」说成「对方没给」。现在两处都从 `qualifiedNameOf()` 取名字，宿主合同测试也改成面板真正发回来的形状。
- 修：详情请求失败（429/超时）不再伪装成「它没给端点」，而是如实说「详情端点这次没答上来（HTTP 429）—— 等几秒再点一次」。
- `fetchSmitheryConfig` 失败时返回带 `error`/`status` 的对象而不是 `null`，并补上记录顶层 `deploymentUrl` 的兜底（新记录不再只在 `connections[]` 里给端点）。

## 0.12.0 — 2026-10-18

### 检查，按下去就说在查
- 「检查」有了行内状态：点下后按钮变成「检查中…」并禁用，直到结论回来。一次检查等握手最多 12 秒，之前这 12 秒按钮毫无变化，读起来像没点上——于是被点了第二、第三次，每次都在同一行上再起一次检查。
- 一次点击会跟着同一个挂载连问最多 3 次（间隔 4 秒）。首跑的 `npx` 可能还在下载，中间态不再被当结论写下来；按钮在整段时间里都显示「检查中…」。

### 旧装法的行，说清它为什么红
- `@smithery/cli run …` 装下的行，握手不会完成——原因不是慢，而是 CLI 把记录解析成远程端点，拉起 `mcp-remote` 等浏览器登录。逻辑在 0.11.0 已经改掉（新装的行按来源装成远程 http），但已经装下的行不会自动改变。健康结论失败时，行下因此补一句「移除后重新安装，会按它自己托管的方式装成远程 http」，把唯一有效的下一步写在红字下面。

## 0.11.0 — 2026-10-18

### 装，就按来源写的方式装
- `catalog:smithery` 的条目现在分两种装法。Smithery 自己托管（`remote: true`）的，装成远程 http——端点去详情端点要（`connections[].deploymentUrl`）；只有他们不托管的，才走 `npx @smithery/cli run`。
- 之前一律装成后者，而它并不是一台本地服务器：CLI 把记录解析成同一个远程端点，拉起 `mcp-remote` 等交互式 OAuth 登录。无头挂载里这一步永远不会完成——实测 `run upstash/context7-mcp` 20 秒零响应，日志停在 `Another instance is running the sign-in for this server on port 4814`。这类行的状态因此永久停在「正在连接」。
- `docker run` 的条目把存下的环境变量变成 `-e KEY=value`，并且插在镜像之前。docker CLI 只读它自己的进程环境，`config.env` 从来没有进过容器；而写在镜像之后的参数会被当成容器自己的命令。
### 必填，只信端点的 401
- 新 `lib/remote-auth.js`：对 http 端点发一次 `initialize`，把 `401` 和它的 `WWW-Authenticate` 读成一条必填的 `Authorization`。读不出来（超时、`5xx`、端点拒绝探针）就一条都不加——「不知道」不再冒充「不需要」，也不冒充「需要」。
- 这样来的字段在表单里标成「这个端点自己要求的」，与「发布方声明的」分开，一眼能看出证据来自哪里。
## 0.10.0 — 2026-10-18

### 检查结论补上耗时

宿主一直在给握手计时：`health.ms` 从写入结论的那天起就在内存结论里，只是那一行没读它——
读者看到「检查健康 · 5 个工具 · 08:31:07」，知道它**能**用，不知道它**慢不慢**。

现在结论行是「检查健康 · 5 个工具 · 41ms · 08:31:07」。单位跟着量级走：不足一秒报毫秒
（`41ms`），超过一秒报秒（`1.2s`）；没有计时就不编一个（旧结论缺 `ms` 时这一段整段不出现）。

### `--config` 行的两个承诺

`--config` 这类服务器把凭据写在一个 JSON 参数里，两个后果以前都没兑现：

- **必填留空仍可保存**。发布方在 schema 里说了 `required: ['braveApiKey']`，表单只在标题上
  标一个「必填」，保存照发——于是拿到一次注定失败的重新挂载，再回来读「还缺 braveApiKey」。
  现在必填未填时保存按钮禁用，上方点名还差哪几个键（`还有必填项没填：braveApiKey`），
  输入框里只有空格也算没填；把已保存的必填值「清除」同样挡住——表单不该产出这一行已经
  知道是坏的形态。
- **看不见最终参数**。字段框里显示的是你输入了什么，不是 CLI 会收到什么；手加的键（「其他
  键值」里 `配置项` 那类）更是只存在于提交之后。现在表单底部直接给出成形的那一段
  `--config {"braveApiKey":"••••","extraMode":"fast"}`，密钥一律以 `••••` 出现，手加的键
  也在里面。

### 握手那一项要真的等

「检查不健康：握手未完成（8s 内没返回）· 21ms」——这两段时间不属于同一件事。前一句里的
8 秒是挂载自己的就绪期限，后一个 21ms 才是这次检查实际花掉的时间：那时它**一眼都没等**，
只读了一枚上次挂载留下的标记。把没观察过的事写成结论，比不检查更糟。

现在检查遇到「正在握手」的行会先等它一次，上限 12 秒（比挂载自己的期限长：这是用户唯一主动
问「到底能不能用」的地方，值得等；扫描和开关不能等，它们照旧立即返回）。等到了就连工具数
一起报健康；等不到才说不健康，并且句子里的秒数是**这次真的等过的**秒数。

顺带把原因写进话里：`@smithery/cli run <server>` 并不是本地 stdio 服务器——它把服务器解析成
远程 HTTP，再拉 `mcp-remote` 走 OAuth，等人交互登录。无头挂载里没人能应答，`initialize` 永远
不来，于是行停在「正在连接」。这类行现在会明说「这条命令可能要求交互式登录，或首次运行正在
下载」，而不是让人以为只是超时短了。

两条都由 `tools/render-config-dialog.mjs` 断言：必填为空时按钮禁用且点名、已保存时放行；
预览字符串逐字比对，并断言预览里不含明文凭据。

## 0.9.0 — 2026-10-18

### 「检查」的结论只活一次

上一版把体检结论写进了 `registry.json`：`row.health = { at, ok, toolCount, checks, ms }`。
写进文件的那一刻它就变成了这台服务器的属性——可它回答的是「此刻能不能用」。宿主重启过一次，
行上还在替一个已经不存在的进程报「检查健康」；用户的原话是「点击一次，只在本次显示，下次进来
之后就不会显示」。

现在结论有两道闸：

- **宿主侧**：结论只存内存（`health: Map<name, verdict>`），`publicList()` 从它读取；
  `/health` 不再 `save()`。旧文件里已经写下的 `health` 在启动时被删掉并回写，所以升级后
  第一次启动就把注册表清干净了。
- **页面侧**：`keepSessionHealth()` 只保留「本次进入界面亲手点过检查」的那几行
  （`checkedThisSession`）。刷新页面 = 新一轮会话 = 一行结论都不显示，直到你再点一次。
- 两道闸都必要：只有内存，刷新页面仍会看到本进程早先的结论；只有页面闸，重启宿主的旧结论
  还会被当成事实重新画出来。

### 说明文字说读者的话

每行那句「这台服务器是干什么的」取自服务器自己的 `initialize` 说明，语言由它的作者决定。
中文面板上于是出现「一行英文夹在中文里」：

- 新增 `POST /api/overall-mcp/about-i18n`，只翻 `source: "server"` 的散文；本插件自己写的
  `工具：…` 和启动命令原样返回（`source` 由客户端标出，没标的一律当散文）。
- 译文按「语言 + 原句」缓存在 `about-i18n.json`（**不在** `registry.json` 里：它是派生缓存，
  删掉只花一次模型调用）。同一句话整台机器只翻一次，重启也不算重复。
- 语言来自页面的 `<html lang>`，退回 `navigator.language`；`zh-CN` 与 `zh` 共用一个键。
- 模型不可用（`no-llm` / `no-route`）或答非所问（`translate-failed`）时，行上保留服务器
  原本的措辞——「翻译不了」不该比「看清这台服务器干什么」更重要，也不该变成一条报错。
- 译文在行上，原始措辞留在 tooltip（`about.original`），需要核对原文时仍拿得到。

## 0.8.0 — 2026-10-18

### 必填只信声明

上一版把「声明」读进了配置表单，但「必填」这一栏还留着一条自己的推断：启动命令里出现
`--env GITHUB_TOKEN`，或者一个形如凭据的大写令牌，就按名字猜它是必填。两种错都出在这条
推断上——真正必填的键可能因为名字不显眼而不算必填，而没人要求过的键会把整行顶成「待配置」。
被问到的原话是「MCP 不应该是个标准服务吗」：这话对，只是本插件把标准答案扔在了半路，
`argFields` 在猜，而 `officialFields` 读到的 `isRequired` 一路没被标记成「这是声明」。

现在每一档证据都留了痕：

- **发布方声明**（官方 Registry 的 `environmentVariables[].isRequired`、
  `remotes[].headers[]`、Smithery 的 `configSchema.required`）→ `declared: true`，只有它
  能产生「必填」「还缺 xxx」「待配置」。
- **从启动命令认出来的键** → 仍然列在表单里，标「来源未声明」，不计入缺项；表单顶上写明
  「一个都没有标必填——只有发布方声明过的才算」。
- `default` 与 `choices` 也一路带到表单（`默认：readonly · 可选值：readonly / readwrite`），
  并同时认 snake_case 拼法：`server.json` 规范写的是 `environment_variables` / `is_required`，
  服务端返回的是 camelCase，只认一种就等于只看了一半的目录。
- **同名服务器、不同记录，声明的东西可以完全不同**——这不是本插件的缺陷，是目录的现实：
  `io.github.brave/brave-search-mcp-server` 的包记录里 `BRAVE_API_KEY` 是
  `isRequired: true, isSecret: true`；而 `ai.smithery/brave`（同一份代码的托管变体）只声明了
  一条 `Authorization: Bearer {smithery_api_key}`，没有任何 `environmentVariables`。按它装的
  行走的是 Smithery 自己的 `configSchema`（`required: ["braveApiKey"]`）。三类记录都算「声明」，
  所以 `smitheryFieldsOf` 出来的字段同样带 `declared`，否则表单会把一个 schema 明写的键叫作
  「来源未声明」。

### 「检查」：这台服务器到底能不能用

圆点只回答「有没有一个 fiber」，回答不了「模型能不能调到它的工具」。进程死了、fiber 被
dispose、一个工具都没注册，行上照样是「已连接」——这是这一轮最贵的一个谎，因为它的后果
出现在工具调用时，而不是面板上。

每行多了一个「检查」按钮，把一次挂载拆成五项依次作答：启用、挂载、握手、工具、配置。工具数
按 `mcp__<serverName>__` 前缀在宿主工具表里数——不发请求、不花配额，也是唯一能证明「能用」
的信号。结论落盘成 `health`（`{at, ok, toolCount, checks, ms}`），刷新不丢；行上多一行
`检查健康 · 5 个工具 · 08:31:07`，不健康时把第一个 ✗ 的句子原样写出来（「一个工具都没注册：
服务进程可能已经退出」）。没被检查过的行不显示任何结论——一个会自己过期的健康判定，比没有
更难用。

`POST /api/overall-mcp/health` 收 `retry: true`，在行已启用却什么都没挂上时补一次挂载尝试，
于是「检查」要么把它救回来，要么带回真实的错误原文，而不是把「未挂载」原样还给点按钮的人。
`tools/render-server-health.mjs` 断言三种形状：没检查过不编造、健康带工具数与时间、不健康
点名失败的那一项。

### 一个键的去处

配置表单把「不是请求头的键」一律写进 `env`。对 `--config` 型的服务器（Smithery CLI：`npx
-y @smithery/cli run brave`）这是写错了袋子——它只读命令行上那串 JSON，`env` 里的
`braveApiKey` 它一辈子不会看。症状因此特别难查：保存回「已保存」，`configValues` 仍是空的，
行上继续写「还缺 braveApiKey」，看起来像表单没生效，其实是生效了但落到了没人读的地方。

现在按字段自己声明的通道分三袋：`header` → `headers`，`config` → `configValues`（挂载时序列化
成 `--config <json>`），其余 → `env`。同一处修理还带出「其他键值」那行：`--config` 行上新加的
键默认就是「配置项」，提示也从「没有列出来的变量可以自己加」改成「写进那份 --config JSON」，
否则界面替用户选了一条这台服务器读不到的通道。

`tools/render-config-dialog.mjs` 直接断言这条路由：声明的 `config` 键必须落在 `config` 袋里，
`env` 键必须落在 `env` 袋里，没人碰过的表单三个袋子都为空（这条同时挡住「把 `••••` 当值回传」）。
`test/index.test.mjs` 再从宿主侧验一遍：存进去之后 `composeMountArgs` 必须真的产出
`["--config", "{\"braveApiKey\":\"…\"}"]`。

「其他键值」还改了一处观感：那块不再预置一行空输入。一个空的输入框加一个空的类型下拉，读起来
就是「请填写」，而这一段恰好相反——它是**没有声明过的键**的兜底，可以永远不碰。现在只剩标题、
一句说明和一个「+ 加一行」，点它才出现一行；空行本来就不参与保存（键或值为空都跳过），于是
「选填」这件事在界面上和代码里终于一致。探针以「没有 移除 按钮」作为这条的断言：预置行必然
带一个 移除。

## 0.7.0 — 2026-10-17

### 页头多了一枚「点个 star」

版本号右侧、仅此一处：一枚胶囊形的 `<a>`，指向本仓库，`target="_blank"` +
`rel="noreferrer"`。它不参与面板的任何状态，也不读宿主数据——没有计数器，因为一个自己
攒的数字会把「请 star」变成「求 star」。

静止时只有一圈发丝描边和一颗琥珀色的星；指针压上去，星放大并倾斜 12°，胶囊上浮 1px、
描边转暖，背后浮起一层同色柔光，`.6s` 的斜向高光从左侧扫过一次。`prefers-reduced-motion:
reduce` 下只保留颜色与描边，不动。

它排在身份行的最后（品牌标记、标题、版本号、〔更新到 v…〕之后），没有填充色，也不占
「每页一个主操作」的名额；两个标签页都在同一位置。`tools/render-market-tab.mjs` 断言了
它是一枚链接、指向本仓库、在新标签页打开，且两个标签页都有。

## 0.6.0 — 2026-10-17

这一轮回答一个具体的事故：服务器装上了、挂上了、面板写「已连接」，然后每一次工具调用都回
`401`——因为它的 API key 从没填过，而插件从来没问过。目录里其实多数条目**已经声明**了自己
需要什么（官方 Registry 的 `environmentVariables` 带 `isRequired`/`isSecret`），这些字段此前
在安装时被丢掉了。

### 配置声明：读出来、存下来、只出掩码

- 新增 `lib/server-config.js`：`configSpecFor` 从三处收声明取并集——官方 Registry 的
  `packages[].environmentVariables[]` 与 `remotes[].headers[]`；条目自己的启动方式（`-e NAME`、
  `--env NAME`、命令/参数/地址里的 `$NAME`/`${NAME}`/`{NAME}` 占位符、裸凭据形状的名字如
  `GITHUB_PERSONAL_ACCESS_TOKEN`）；`streamable-http`/`sse` 条目固定给一个**可选**的
  `Authorization` 头。`origin` 记最强证据（`official` > `args` > `manual`）。声明为空的行不带
  `config`，既有消费者看到的响应不变。
- 声明写进注册表条目（`config: { origin, fields }`），不是每次列表重算：徽标重启后还在，手改
  过的文件也不会被二次判断。`maskedFields` 是唯一出口：密钥有值 `••••`、无值 `''`，非密钥
  （base URL）原样回显；`env`/`headers` 本身永不出现在任何响应里。
- `GET /servers` 每行多 `config` 与 `needConfig`（只有**必填**项为空才为真），整体多一个
  「已启用且还差配置」的计数。`lib/catalog.js` 的 `catalogItemToEntry` 在安装时把声明随行写入。

### 写回去：一个动作、一个工具、一条路由

- `POST /api/overall-mcp/configure` 与模型工具 `overall_mcp_configure`：按字段名写
  `{env, headers}`。空字符串等于删除该键（清除）；非法名、请求头里的换行、会写到
  `Object.prototype` 的键被拒绝并逐条回报。写入后**只重挂本来就启用的行**——停用行保持停用；
  确实什么都没改时回 `saved: false` 并说明，不谎报「已保存」。
- 安装路径提前读声明：必填项还空着时，回复带 `needConfig`、`config.missing` 与「还差 …」的
  note，且**跳过模型诊断**（`diagnosisSkipped: 'needs-config'`）。凭据形状的挂载错误同样跳过
  ——目录已经写明缺哪个键，再让模型从 `401` 反推只会更慢更差。

### 界面：在点坏之前就说

- 行上多一颗 **待配置** 徽标（没有它，`已连接` 与「工具全挂」长得一模一样），有配置声明的行
  多一颗 **配置** 按钮（缺必填值时用主色）；页顶在筛选行之上只写一次「有 N 台服务器装好了但
  还差配置」并给「去配置」。
- 配置弹层（`ConfigDialog`）按声明列出字段（掩码输入、`必填`、说明），底部留一行自定义键值；
  保存走 `/configure`，还缺必填项时不关闭而是继续列出缺什么。安装完成后若 `needConfig` 为真，
  面板直接为刚写入的那一行打开弹层，而不是只弹一句提示。

### 测试与文档

- `test/server-config.test.mjs`：17 条（声明来源/归一化/上限、掩码、写值与拒绝、缺口与状态、
  凭据错误分类、`configSpecFor` 的并集与 `origin`）。
- `test/index.test.mjs` 新增 4 条合同：声明的条目以「待配置」装好且不劳烦模型；保存写入并回
  掩码、清空即删除、无改动如实回报；停用行保存后仍停用且不产生挂载；同名行拒绝（409）而
  `slot` 选中目标行。
- README（中英）、模型工具清单、HTTP API 清单同步；`package.json` 导出 `./lib/server-config.js`。

## 0.5.0 — 2026-10-16

前两轮把两趟走查的启停交给读者，这一轮补上「看」：本机的普查索引现在可以当成一个来源来读，
代价是零请求；同时把 `package.json` 的三个仓库字段填成真实存在的页面。

### 普查视图（`?source=census`）

- `/catalog` 接受 `source=census`（`lib/catalog.js` 的 `CENSUS_SOURCE`）：这一趟归一成
  `github-mcp`，回复带 `aliasOf:'github-mcp'`。它**不是第七个来源**——普查那 ~1.8k 行本来
  就以 `github-mcp` 的身份计入本页，多一个来源会让「共 N 条」重复计一次，而来源列表是公开
  契约。「一个上游，一个数字」没变，缓存也各分一份（键里带 `|census`）。
- 这个视图**只读索引、一次请求都不花**：`fetchGithubMcp` 在 `indexOnly` 下只走索引分支并
  立刻返回（没有索引时写「本机还没有普查索引：在 GitHub 访问卡里开始一次普查，建好后这里
  直接读它，不发请求」），绝不落回「索引过期就顺手走一遍」那一段（视图下 `githubWalk` 固定为
  `null`）。索引超过 24 小时只决定它标不标「旧」，不决定能不能读。
- 视图不动任何状态：不触发普查、不推进恢复走查、也不算「有人看过 GitHub」。

### 面板

- 来源筛选里 `本地普查（索引）` 排在 `GitHub` 右边（不改 `MARKET_SOURCES`，那是计数键的
  来源）；数字行按读者选的那个名字写（`本地普查（索引） 1.8k`），名字取自选项自己的标签，
  所以筛选器与数字行不会各说一套。

### 仓库元数据

- `package.json` 填入 `repository`/`homepage`/`bugs`（`https://github.com/YunzhouLi-hub/dsh-overall-mcp`、
  其 `#readme`、其 `/issues`），`main` 已推到该远端。此前留空是因为不写未经验证的地址。

## 0.4.0 — 2026-10-16

第二趟走查（读仓库证据恢复安装命令）也从「打开市场就自己开始、只能靠卸载插件停下」变成一条
可以自己按的路由。普查回答「GitHub 上有哪些 MCP」，这一趟回答「这些仓库该怎么装」。

### 恢复走查的动词

- 新增 `GET|POST /api/overall-mcp/install-evidence`：`GET` 只读状态、不触发任何请求，
  `POST {action:'start'}` 开始或从断点续跑，`POST {action:'stop'}` 中止在飞的那一次。
  不带 `action` 的 `POST` 仍然等于 `start`——面板打开市场时发的就是这一种。
- `force: true` 才忽略新鲜度检查。不带 `force` 时，正新鲜的走查回 `skipped:'nothing-to-do'`，
  没有普查索引可依据时回 `skipped:'no-census'`；两者都不是错误。
- 已经在跑时 `start` 不会再起第二个（回 `started:false` 且 `walking:true`）；没有在跑时
  `stop` 回 `stopping:false`（「没有东西可停」不是错误）。
- 停止发生在**两个请求之间**：走查每读一个仓库都会检查停手把手，并把 `signal` 一路传给
  `readRepoFile` / `fetchText`，所以按了停止不会再等两千多个仓库。当前那条读完后收手，
  已恢复的命令照旧落盘，`partial` 写明停在哪（「已手动停止（已试 N 个仓库，下次接着走）」）。
- 状态里新增 `ended: {reason, at}`（`user` / `dispose`）与 `plan`/`progress`：文件在跑的时候
  只写「正在抓取」，走到第几个仓库只有宿主进程知道；「我按的停止」与「插件被卸载」也必须分开。
- `progressOf(id, kind)`（`lib/repo-install.js`）让主循环在每次开读之前记下「正在读哪个仓库、
  第几个」，于是进度是**对着它自己的计划**报的（`已试 78 / 2.1k 个仓库`），而不是一句「正在抓取」。

### 面板

- 「已注册」标签页的 GitHub 访问卡里新增第二行恢复状态（`查过 N 个仓库 · 恢复出 M 条安装命令 ·
  上次是手动停止的 · 没读完：…`），右侧按状态给动词：还有剩的写「接着恢复」（走查自己会跳过
  已试过的行），跑起来了写「停止恢复」并报进度。
- 两行各自带自己的动词，因为这两趟走查共享零预算、零时钟：把它们都叫「普查」正是有人按错按钮
  （点「继续普查」却在推动安装证据走查）的原因。
- 行上补回 `partial` 的原文（`没读完：停在 900 行：…`）：此前那一行只在处于「没有正在跑」时才说时间，
  没有说这一趟到底读完了没有，而「停止」正是为了让「没读完」可以发生。

### 错误码

- `unknown evidence action`（例如 `{action:'stpo'}`）→ **400**，与 `unknown census action` 同规矩。
- `GET /census?action=...`、`GET /install-evidence?action=...` → **400**（`lib/http-status.js`
  新增 `action must be sent as a POST` 规则）。读取面不改变状态：一次预取请求不该成为
  「一次正在跑的走查到底停没停」的分界线。

## 0.3.0 — 2026-10-16

普查从「只能等它自己开始、只能靠重启 DSH 让它停下」变成一条可以自己按的路由。

### 普查的动词

- 新增 `GET|POST /api/overall-mcp/census`：`GET` 读状态且不触发任何上游请求（索引是磁盘读），
  `POST {action:'start'}` 不等缓存过期就把缺的仓库补上，`POST {action:'stop'}` 中止正在跑的那一次。
- 已经在跑时 `start` 不会再起第二个（回 `started:false` 且 `walking:true`）；搜索额度未恢复时
  不起步并回 `skipped:'quota'` 与 `waitMs`，而不是花一次请求去换一个 403。
- 停止会中止步调等待本身（`MIN_INTERVAL_MS` 6.5 秒的 `sleep` 变成可中断的），所以「停止」是
  立刻生效的，不是「等这次请求回来之后」。
- 已收到的行在走的过程中就落盘，停止不丢行：下一次 `start` 从缺的仓库接着走。被停止的普查
  **不会**顺带去抓安装证据（那只在自然结束时触发）——既然按了停止，就不该在别处继续花额度。
- 状态里新增 `ended: {reason, at}`（`user` / `dispose`）与 `stopping`：`crawlGithubRepos` 自己只报
  「已中止」，而读者要区分「我按的」与「插件被卸载」，理由只有宿主知道，所以由宿主写下来。

### 面板

- 「已注册」标签页的 GitHub 访问卡里新增一行普查状态（索引行数、读完/上次读到的时间、谁停的），
  右侧按状态给动词：「开始普查」或「停止普查」（后者同时显示进度）。
- 面板不再需要重启 DSH 才能停下普查；页面刷新后这一行也照旧可读（它读的是 `GET /status`）。

### 错误码

- `unknown census action`（例如 `{action:'stpo'}`）→ **400**，`lib/http-status.js` 新增
  `unknown <x> action` 规则。不拒绝的话它会读成「没有动作」并回一份状态，对发送者而言与成功
  无法区分。

## 0.2.0 — 2026-10-16

首个带更新日志的版本。以下内容在 2026-09 至 2026-10 的二十轮构建中陆续落地，此前均以
`0.1.0` 交付、无发布记录；这里按能力归类，不按提交顺序。

### 面板与定位

- 侧边栏面板，两个标签页：「已注册」（这份配置里实际挂载了什么）与「MCP 市场」（开放目录里
  还有什么可装）。搜索、分类、排序、分页、收藏、详情面板、一键安装与卸载。
- **身份行**（第十八轮）：面板顶部显示正在运行的插件版本、宿主 pid、已运行时长、数据文件数与
  日志条数。版本号本身说明不了进程加载的是哪份代码——面板状态里给出 `source.stale`（磁盘文件
  比进程新）并提示重启 DSH。这一条是在一次真实误诊之后加的：2026-10-16 的「github-mcp 源不可用」
  来自一个前一天启动、早于修复的宿主进程。
- **动作日志**（第十八轮）：宿主把每次扫描、普查、安装、更新、挂载、来源增删写成一行
  NDJSON（`events.ndjson`，上限 400 行 / 256 KB，超出时前置一条裁剪记录）。面板可折叠查看，
  导出包含宿主信息与日志。

### 市场聚合

- 五个开放来源：官方 registry、Smithery、Docker MCP Catalog、awesome-remote-mcp-servers、
  awesome-mcp-servers；外加一个基于 GitHub 搜索的补充来源。同一仓库被多个来源收录时按仓库
  键去重合并。
- **计数口径**（第二十轮）：每源数字与「共 N 条」并排显示，因此两者必须同口径——现在是去重
  合并后**计入本页**的条数，重叠部分单独写成「去重合并 N 条」，原始抓取数仍在宿主返回体里。
- **两种时间分开**（第二十轮）：条目的「上游更新于」是仓库最近一次 push；列表的「列表读取于」
  是本机的读取时间。此前两处都写「更新于」，用户无法分辨哪个时钟在说话。
- 目录缓存带条件请求（ETag / Last-Modified），离线或限流时读缓存并标注 `stale`。
- GitHub 不可达时的镜像链；搜索配额耗尽时如实显示为「等待」，不静默降级。
- 流行度数字给出取数口径（哪个来源的哪个字段、何时抓的）。

### 安装、诊断与更新

- 一键安装：优先用来源自带的传输方式，必要时回落到包运行器（`npx` / `uvx`）；同名手工条目
  存在时拒绝覆盖（409），除非显式 `overwrite=true`。
- 安装失败自动诊断：把失败分解成可核对的事实，可选让模型解释（没有可用模型时给出原始错误，
  不假装解释过）。
- 更新检查与自更新队列；安装记录 `installs.json`；注册表重复行与同名竞态的显式处理。
- **安装回复一义一名**（第二十轮）：`server` 永远是服务器名字，`installed` 永远是与市场条目
  同义的布尔。

### 普查（GitHub 仓库索引）

- 全量普查把每个条目的仓库元数据（stars、push 时间、README 入口、发布包）落到本地索引，供
  面板离线读取。
- **凭据**（第十九轮）：`GITHUB_TOKEN` 环境变量 → 数据目录 `github-auth.json` → 面板粘贴 →
  `gh auth token` → 匿名，五级来源；token 只发给 GitHub，日志与导出里只出现掩码。
  **匿名路径保留**：有 token 只是更快、配额更高，没有 token 依然能跑完（更慢）。
- **续跑**（第十九轮）：一次网络失败不再终结整场普查——失败按 `planned / attempted / remaining`
  记账并退避重试，面板如实显示进度与重试次数。

### 界面一致性（第二十轮）

- **组开关有界并发**：分组总开关与扫描后的新条目挂载改为每名一次、最多 4 路并发。此前串行，
  五个成员最坏 40 秒卡在「正在切换…」；并发下同名兄弟共享同一裁决，不会出现「另一个
  mcp-client 已提供」这种不真实的宿主断言。
- **推断分类在详情与下拉里也标注**：分类胶囊只在卡片 `title` 里写过「按名称与描述推断」，
  现在详情面板可见文本与下拉选项都带「（推断）」。
- **「无使用量数据」明说**：按「使用量最多」排序时，没有使用量数据的条目此前静默回落到质量分，
  现在卡片上写明并说明它为何排在后面。

### 工程化（第二十一轮）

- **收藏路由的往返契约用例**：`on` 幂等、裸 `key` 仍然是翻转、写入落到 `registry.json`；
  畸形 `on`（非布尔）从 500 降为 400。
- **两支持续探测进入 `test:probes`**（详情链接完整性、分类 chips 的显示/隐藏判定）。两者读实时
  目录，因此在没有任何来源应答时以退出码 2 结束并写明「未验证任何东西」，而不是让「0 个死链」
  在 0 个条目上冒充绿色。
- **CI 矩阵**（`.github/workflows/verify.yml`）：每次 push / PR 在 Node 22 与 24 上跑
  `npm run verify:ci`（语法检查、单元测试、注册表文档校验、渲染探针）。插件运行时零依赖，
  所以没有安装步骤与锁文件；两个需要真实 Chromium 的视觉探针（`test:layout`）仍留在本地。
- **英文 `README.md`** 与 `CHANGELOG.md`；版本号与更新日志由探针互相钉住。
- 空间胶囊不再被桌面外壳画上深色焦点框：这两颗原本是裸 `<button>`，鼠标点一下就被画上平台默认的焦点框（`outline:none` 与 `:focus-visible` 都压不住，而且点过的胶囊会各自留一圈，切几次就累积成一排）。
  最终做法是让胶囊**根本不能获得焦点**——两颗胶囊改成 `<div role="tab" tabIndex={-1}>`，键盘导航上提到 tablist 容器（`tabIndex=0`，`←`/`→` 换空间），焦点环改用空间本色画在容器上（MCP `rgba(91,124,250,.55)`、Skill `rgba(139,143,214,.62)`）。
  探针断言：两颗胶囊必须是 `div`、tablist 必须 `tabIndex=0` 且有 `onKeyDown`、注入样式必须含 `.omkt-spaceswitch:focus-visible{` 且不得出现 `NaN.omkt-`（曾有一条规则以一元 `+` 开头被算成 `NaN`，规则整段作废）。