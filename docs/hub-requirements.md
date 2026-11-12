# grill-with-ui hub：需求整理（草稿，2026-11-12）

> 状态：需求草稿，尚未实现。分支 `feat/hub`（fork：`yaonan/grill-with-ui`）。
> 这个 fork 是个人定制版，不向上游 `jasonku09/grill-with-ui` 提 PR，只定期从上游同步。

## 0. 定制版约束

- **少碰上游文件。** 以后要持续 `git fetch upstream && git rebase upstream/main`（或 merge），
  对 `server.mjs`、`page.html`、`SKILL.md` 改得越多，同步时冲突越多。hub 的代码尽量放在新文件里，
  对上游文件只做必要的小改动（比如注册一个子命令）。
- **只读复用上游逻辑。** 需要 `runningServer`、`listenerOf` 这类函数时，优先调用 `server.mjs`
  的 CLI（`url`、`sessions`、`serve --detach`）或复制一份小实现，而不是重构上游代码去导出它们。
- **技能安装方式要换。** 现在用的 `~/.agents/skills/grill-with-ui` 是一份普通拷贝，
  定制版要生效，需要改成指向这个 fork 的软链接（或固定从某个分支复制）。

## 1. 问题

同时开多个 agent 会话、每个都在跑 grill-with-ui 时，每个 grill 是一个独立的本地服务，
各占一个端口、各开一个浏览器标签。要做的事情分散在多个标签里：哪个 grill 在等我回答、
哪个还在出题、哪个已经结束，都得逐个点开才知道；服务停掉之后，旧会话也没有入口可以回看。

目标是用**一个网页**看到本机所有 grill，按 tab 切换查看和作答。

## 2. 现状事实（实现约束）

以下是读 `server.mjs` / `page.html` 得出的，决定了方案的边界：

| 事实 | 出处 | 对 hub 的影响 |
|---|---|---|
| 所有会话在 `~/.grill-with-ui/sessions/<project-key>/<id>/`（`GRILL_HOME` 可覆盖） | `cmdNew` | 扫两层目录就能发现全部会话，不需要注册机制 |
| 每个会话有 `state.json`（topic、intent、questions、agent、finished…）和 `server.json`（url、port、pid） | `cmdNew`、`cmdServe` | 列表信息和在线状态都能从文件得到 |
| `sessions` 命令只列**当前项目**的会话 | `cmdSessions` | hub 需要跨项目扫描，不能直接复用 |
| 判断服务在线的现成逻辑：pid 存活 + 请求 `/listener` 返回的 `session` 匹配（防 pid 复用） | `runningServer` | hub 直接复用 |
| 会话页面没有设置 `X-Frame-Options` / `frame-ancestors` | `cmdServe` 路由 | 可以把各会话页面 iframe 进 hub |
| 页面的 POST 校验 Origin；iframe 里页面的 Origin 是会话自己的端口 | `originOk` | iframe 内 Send、主题切换都正常 |
| 页面草稿存在 `localStorage`，key 为 `grill:<project>:<created>` | `page.html` `onState` | 按会话区分，同源或不同源都不会串 |
| **Claude Code 靠 Monitor 读会话 `serve` 进程的 stdout 被唤醒**；`/send` 写 `events.jsonl` 并打印到 stdout | `/send` 路由 | **Send 必须进入该会话自己的 serve 进程**。hub 不能自己接收 Send 再写 `events.jsonl`，否则 Monitor 模式的 agent 收不到 |
| 没有 agent 在听时，Send 只排队，等 resume 时由 `pending` 回放 | README、`cmdPending` | 离线会话可以按需拉起服务作答，但要明确提示"只会排队" |
| `agent.status` 为 `working` / `waiting`；`agent.handled` 与 `events.jsonl` 的 lastSeq 比较可知是否有未处理的 Send | `state.json` 约定 | 可以算出"等我回答 / agent 在忙 / 有积压"等状态 |
| `listener.json` 心跳 + `state.json` mtime 判断"是否有 agent 在听"，30 秒内有效 | `listenerOf` | hub 可显示 agent 是否在线 |

## 3. 目标与非目标

**目标**

- G1：一个入口页列出本机所有 grill 会话，跨项目。
- G2：tab 方式打开多个会话，切换时保留各自页面状态（不重新加载）。
- G3：一眼看出哪些会话在等我回答。
- G4：服务已停的会话也能打开，用于回看或继续作答（排队）。
- G5：与现有设计一致：零依赖、无构建步骤、默认只监听 loopback。

**非目标（v1 不做）**

- 不替代单会话页面，也不修改它的交互；hub 只是外壳。
- 不唤醒已结束的 agent 回合，不启动 agent。
- 不做跨机器 / LAN 聚合。
- 不做会话删除、归档、改名等管理操作。
- 不跨会话搜索问题内容。

## 4. 用户故事

1. 我开了 3 个 Claude Code 会话在做不同的 grill，打开 hub，左侧看到 3 个进行中的会话，
   其中 2 个标着"等你回答 · 4 题"，点开就是熟悉的 grill 页面，作答后 Send，对应的 agent 被唤醒。
2. 我想回看昨天 RN02 那次补测定了什么，hub 里它显示"已结束 · 服务未运行"，点开后 hub
   拉起服务并显示页面（只读的结束状态）。
3. 一个会话的 agent 已经退出了，我点开后看到提示"当前没有 agent 在听，Send 会排队，
   下次 `/grill-with-ui resume` 时处理"，仍然可以作答。
4. 我关掉某个 tab，对应会话的服务不受影响。

## 5. 功能需求

### FR1 会话发现

- 扫描 `<GRILL_HOME>/sessions/*/*`，读取每个目录的 `state.json`；读失败的跳过。
- 每个会话的摘要：`project`、`topic`、`intent`、`created`、`finished`、`note`，
  题目统计（open / reopened / answered / deferred），`agent.status`、`agent.handled`、
  `events.jsonl` 的 lastSeq，`server.json` 的 url / pid。
- 按项目分组，项目内按 `created` 倒序。

### FR2 状态判定（每个会话一个主状态 + 若干标记）

主状态（互斥，按优先级）：

1. **已结束**：`finished` 存在。
2. **等你回答**：`agent.status === "waiting"` 且有 open/reopened 题目。
3. **agent 处理中**：`agent.status === "working"`，或有未处理的 Send（lastSeq > handled）。
4. **空闲**：其他情况。

标记：

- **服务在线 / 未运行**：复用 `runningServer` 的判定。
- **agent 在听 / 不在听**：复用 `listenerOf`；服务未运行时以 `listener.json`、`state.json` mtime 判定。
- **有可视化**：存在 `visual.html`。

### FR3 hub 页面布局

- 左侧：会话列表，按项目分组；每项显示主题、时间、主状态、待答题数。
  默认隐藏已结束会话，可切换显示。
- 顶部：已打开会话的 tab 条；tab 上显示主状态角标。
- 主区域：当前 tab 的会话页面（iframe）。
- 空状态：没有 tab 时显示"需要你处理"的会话清单。

### FR4 打开会话

- 服务在线：iframe 加载 `server.json` 中的 url。
- 服务未运行：hub 后台执行 `server.mjs serve --session <dir> --detach`，拿到 ready 行的 url 后加载。
  - 未结束的会话打开前提示：没有 agent 在听时 Send 只会排队。
  - 拉起失败时显示 `serve.log` 最后一行。
- 每个 tab 的 iframe 在切换时保留（隐藏而非销毁），避免丢失页面内状态。

### FR5 刷新

- 列表和角标定时刷新（暂定 2 秒，可按 `state.json` mtime 跳过未变化的会话）。
- 新出现的会话自动加入列表。

### FR6 关闭

- 关闭 tab 只移除 iframe，不停止会话服务。
- hub 退出时不影响任何会话服务。
- 由 hub 拉起的服务是否在 hub 退出时停止：**待定**（见第 9 节）。

### FR7 CLI

```
node hub.mjs [--port N] [--open | --open-command P] [--detach]
```

- 与 `serve` 一致：记住上次端口（写 `<GRILL_HOME>/hub.json`），`--open` 打开浏览器，`--detach` 后台运行。
- 已有 hub 在运行时直接打印它的 url（`"already": true`）。

## 6. 非功能需求

- **零依赖、无构建**：hub 逻辑放在新文件 `hub.mjs`，页面为 `hub.html`（见第 0 节）。
- **安全**：
  - 只监听 loopback，v1 不支持 `--lan`。
  - 复用现有的 Host 校验（防 DNS rebinding）和 Origin 校验。
  - "拉起服务"接口只接受已发现的会话目录，不接受任意路径，避免变成任意命令执行入口。
- **兼容性**：不改变单会话页面的行为；如需改 `page.html`（比如在 iframe 内隐藏重复的标题），只在嵌入时生效。
- **跨平台**：macOS / Linux / Windows 与现有 `serve --detach` 一致。
- **性能**：几十个会话时列表刷新不应明显占用 CPU；`events.jsonl` 只需读 lastSeq，大文件时考虑只读尾部。

## 7. 方案选型

| 方案 | 做法 | 结论 |
|---|---|---|
| A. iframe 嵌各会话端口 | hub 只是外壳，Send 直接进会话自己的 serve | **采用**。不破坏 Monitor 唤醒链路，改动最小 |
| B. hub 反向代理所有会话 | 统一到 hub 的一个源下，请求转发给各会话端口 | 可作为后续选项：要改 Host/Origin 校验，收益只是"单一源" |
| C. hub 直接读写会话文件，不启动会话服务 | hub 自己实现 `/state`、`/send` | **否决**：Monitor 模式下 agent 读的是会话 serve 的 stdout，hub 写的 Send 唤醒不了 agent |

## 8. 验收标准

- [ ] `hub --open` 后能看到 `~/.grill-with-ui/sessions` 下所有项目的会话，分组、排序正确。
- [ ] 在线会话在 iframe 中可作答，Send 后对应 agent（Monitor 模式与 wait 模式）都能收到。
- [ ] 离线会话点开后能自动拉起并显示；失败时有可读的错误。
- [ ] 主状态与角标在 agent patch 后 ≤ 3 秒更新。
- [ ] 切换 tab 不丢草稿、不重新加载页面。
- [ ] 关闭 tab / 退出 hub 不影响会话服务（除非第 9 节另有决定）。
- [ ] 非 loopback Host、跨源 POST、未知会话目录的拉起请求都被拒绝。
- [ ] 单元测试覆盖会话发现与状态判定；e2e 覆盖打开、作答、离线拉起。

## 9. 待定问题（建议用 grill-with-ui 本身来 grill）

1. hub 拉起的会话服务，在 hub 退出或 tab 关闭时要不要停？（倾向：不停，保持与 `serve --detach` 一致）
2. 已结束会话是否需要不拉起服务的只读视图（hub 直接渲染 `state.json` 摘要和决策）？
3. 等你回答的提醒要不要做到浏览器标题 / 桌面通知？
4. 是否显示与 agent 会话的对应关系（例如哪个终端或 Claude Code 会话）？目前文件里没有这个信息。
5. 入口是 `node hub.mjs` 独立命令，还是在 `server.mjs` 里加一行转发成 `server.mjs hub`？（倾向：独立的 `hub.mjs`，上游文件零改动）
6. 是否需要在 `SKILL.md` 里让 agent 在启动 grill 时提示 hub 的地址？（改 `SKILL.md` 会增加同步冲突，倾向先不改）
7. 定制版的技能怎么安装：软链接到这个 fork 的工作区，还是另建一个只跟踪稳定分支的 checkout？
