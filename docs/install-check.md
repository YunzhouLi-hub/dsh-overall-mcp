# 从 GitHub 安装：一次实测

这份记录回答一个反复出现的问题：**为什么不发 npm 包？**

答案不是「发不出去」，而是「发了没用」——我们没有任何安装期要执行的构建步骤，所以
npm 那条最常被引用的好处（预构建包可以跳过 `allowBuilds` 构建授权）在我们这里等于零。
下面是把「用户从 GitHub 装一次」完整跑过一遍得到的数字，以及顺带发现的几个真实行为。

- **实测日期**：2026-10-18
- **被测版本**：`0.12.6`（提交 `17b1b2f`）
- **DSH**：`dsh` CLI（`dsh plugin` 是 pnpm 11.23.0 的透传）
- **方法**：新建一个空的 `DSH_HOME` 临时目录，在其中装、卸各一次，全程不碰真实的桌面 profile

## 一条命令就装完

```sh
dsh plugin --profile test add github:YunzhouLi-hub/dsh-overall-mcp
```

```
[WARN] Issues with peer dependencies found. Run "pnpm peers check" to list them.

dependencies:
+ dsh-overall-mcp github:YunzhouLi-hub/dsh-overall-mcp

Progress: resolved 1, reused 0, downloaded 1, added 1, done
Done in 2.4s using pnpm v11.23.0
```

2.4 秒，一次网络拉取，没有第二句需要回答的提问。

## 装完自动启用

`dsh plugin add` 不只写 `dependencies`，它把包名加进 profile 的 bundle 列表：

```json
{
  "dependencies": { "dsh-overall-mcp": "github:YunzhouLi-hub/dsh-overall-mcp" },
  "dsh": { "profile": { "bundles": ["@deepseek-ai/dsh-base", "dsh-overall-mcp"] } }
}
```

也就是说，用户不需要再手工挂载一次。移除时这两处会一起复原（见文末）。

## 装的是哪个版本：锁文件钉住一个提交

```
dsh-overall-mcp:
  specifier: github:YunzhouLi-hub/dsh-overall-mcp
  version: https://codeload.github.com/YunzhouLi-hub/dsh-overall-mcp/tar.gz/17b1b2f63b...
```

这条值得单独说，因为它推翻了一个常见猜测——「从 GitHub 装就等于永远跟着 main 跑」。
实际上 pnpm 把 Git 依赖解析成**某个提交的 tarball**并写进 lockfile：装一次就钉住，
只有显式 `pnpm update` / 重新 `add` 才会移动。GitHub 安装本来就是可复现的。

## 没有构建授权这一步

整个安装过程没有出现 `allowBuilds` 询问。原因在 `package.json` 里：

```
prepare=—  postinstall=—  install=—  build=—  prepack=—
```

一个构建脚本都没有：`client/client.js` 是手写源码，不是构建产物。构建授权只在包
声明了构建脚本时才会出现，所以「npm 包能省掉构建授权」这条对我们不成立。

## 唯一的警告，以及它的含义

```
[WARN] Issues with peer dependencies found.
```

这是**空 profile** 的必然结果：`@deepseek-ai/cordis`、`@deepseek-ai/dsh-tools`、
`@deepseek-ai/dsh-mcp-client`、`@deepseek-ai/dsh-llm` 都是 `peerDependencies`，
在刚建出来的空 profile 里当然不存在。真实用户桌面 profile 里它们由
`@deepseek-ai/dsh-base` 提供，因此不会看到这一行。

即使出现，它也只是 `WARN`：pnpm 不会因此中止安装。

> 附带一条与本插件无关的发现：`pnpm peers check` 自己会在 pnpm 11.23.0 上崩溃
> （`Cannot read properties of undefined (reading 'devDependencies')`）。所以那句
> 「Run "pnpm peers check" to list them」在当前 pnpm 版本上无法执行。

## 装进去的到底是什么

`files` 字段决定了包里有什么，实测生效：

| 路径 | 是否随包发布 | 说明 |
| --- | --- | --- |
| `index.js` | ✅ | 插件入口 |
| `lib/` | ✅ | 全部实现 |
| `client/` | ✅ | 面板前端 |
| `cordis.patch.yml` | ✅ | `dsh.bundle.patch` 指向它，缺了就无法挂载 |
| `registry.json` | ✅ | 空模板；运行时数据写在 `DSH_HOME/overall-mcp/`，不在这里 |
| `README*.md`、`CHANGELOG.md`、`LICENSE` | ✅ | |
| `docs/` | ✅ | 自 `0.12.7` 起包含；此前两份 README 在包内的图片链接是断的 |
| `test/`、`tools/`、`.github/` | ❌ | 不随包发布，安装体积因此保持在数百 KB |

## 重复安装与移除

| 动作 | 结果 |
| --- | --- |
| 再 `add` 一次 | 1.1 秒，`added 0`，不重复下载 |
| `remove` | 284 毫秒，`dependencies` 键整条消失、`bundles` 复原为 `["@deepseek-ai/dsh-base"]`、`node_modules` 清空 |

## 自更新：GitHub 安装没有「npm 上的新版本」可比

`lib/self-update.js` 区分三种安装形态：

| 形态 | 自更新检查 | 说明 |
| --- | --- | --- |
| `link:` / 本地检出 | 不检查（`reason: 'linked'`） | 本地代码就是版本来源 |
| npm 安装 | 查 npm 的 `dist-tags.latest` | 真正可比，可用 `dsh plugin add <pkg>@<v>` 升级 |
| **Git 安装** | 不检查（`reason: 'git'`） | 锁文件钉住某个提交，只能重新 `add` 同一 spec |

第三行是 `0.12.7` 补上的。在此之前，GitHub 安装会走到 npm 查询分支，拿到一个必然的
404，界面于是显示「npm 上查不到 dsh-overall-mcp 的发布版本」——一句真话，但答非所问：
这个包从来没打算发到 npm。现在这一类会被直接识别出来，并给出该执行的那条命令
（含「想钉版本可加 `#<tag>`」的提示）。

## 所以：发不发 npm

不发。三条理由，按分量排列：

1. **没有可省的步骤**。构建授权只对有构建脚本的包成立，我们没有构建脚本，从 GitHub 装
   与从 npm 装在用户那边没有区别。
2. **版本固定这条已经被满足**。lockfile 把 Git 依赖钉到提交 tarball，可复现性不靠 npm。
3. **发 npm 会新增一处必须维护的真相**。npm 的版本不可变，发一次就是一次发布动作；
   与本仓库两天内从 `0.7.0` 走到 `0.12.7` 的节奏并排，人工发布会立刻漂移，界面和市场
   就会同时显示「GitHub 的最新版」和「npm 的旧版」。

剩下的好处只有两个，都是观感：短安装名（`dsh plugin add dsh-overall-mcp` 而不是一串
Git URL），以及市场按下载量排序。

**什么时候再考虑**，满足任意一条即可：

- 有外部用户稳定使用，希望他们敲短名字；
- 希望市场按下载量把插件排到前面；
- 给客户端引入构建步骤（例如开始用 JSX 编译）——那时 npm 包才真正省事；
- 需要「钉住某个已发布版本」以便回滚（GitHub 侧可以改写 spec 为 `#<tag>`，但 npm 更直观）。

真要做的话，需要动的地方是固定的：加一个 tag 触发的发布工作流（`npm publish --provenance`）、
把 `repository` 字段确认指回本仓库（已指向）、确认 `files` 覆盖 README 需要的资源（已覆盖）。

## 复现这次实测

```sh
tmp=$(mktemp -d)
export DSH_HOME="$tmp/home"
dsh plugin --profile test add github:YunzhouLi-hub/dsh-overall-mcp
# 看锁文件钉了什么
grep -A2 'dsh-overall-mcp:' "$DSH_HOME/profiles/test/pnpm-lock.yaml"
# 看它是否自动启用
cat "$DSH_HOME/profiles/test/package.json"
# 清理
dsh plugin --profile test remove dsh-overall-mcp
rm -rf "$tmp"
```
