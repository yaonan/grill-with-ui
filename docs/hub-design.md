# grill-with-ui hub：设计文档

> 2026-11-12，由 grill-with-ui 访谈得出（12 题，4 轮）。分支 `feat/hub`，fork `yaonan/grill-with-ui`。
> 需求背景见 [hub-requirements.md](hub-requirements.md)；两份文档不一致时以本文为准（差异列在文末）。

hub 是一个常驻本机的网页，列出 `~/.grill-with-ui/sessions` 下所有项目的 grill 会话，并以 tab 方式打开它们。
服务在线的会话用 iframe 直接嵌入会话自己端口上的会话页面，作答和 Send 仍进该会话自己的 serve 进程；
服务已停的会话由 hub 读 `state.json` 渲染只读摘要。新开的 grill 通过 `serve --open-command <hub-open>` 进入 hub，
不再各开一个浏览器标签。hub 的代码全部放在新文件里，对上游文件只改 `SKILL.md` 的一个参数。

## Terms

- **hub**：一个本机网页，列出并以 tab 方式打开所有 grill 会话。避免使用：dashboard、聚合页、总览页。
- **会话**：一次 grill，对应 `~/.grill-with-ui/sessions/<项目>/<id>/` 一个目录和它自己的 serve 进程。避免使用：session 页、grill 实例。
- **会话页面**：现有单会话的 `page.html`，由该会话自己的 serve 进程提供。避免使用：子页面、详情页。
- **hub-open**：传给 `serve --open-command` 的小程序，确保 hub 在跑，并让 hub 打开指定会话。避免使用：opener 脚本、launcher。
- **只读摘要**：服务已停的会话在 hub 里的视图，hub 直接读 `state.json` 渲染，不能作答。避免使用：离线页面、归档视图。

## Why

用户的原话：“我现在的很多对齐都是通过 grill-with-ui 这个技能来做，但我同时有很多 session，有没有办法把所有的
grill-with-ui session 聚合在一个网页中，比如分成不同的 tab 来看具体的内容？”

现状是每个 grill 一个独立的本地服务、一个端口、一个浏览器标签。哪个在等回答、哪个 agent 还在出题、哪个已结束，
要逐个标签点开才知道；服务停掉后，旧会话没有入口可以回看。

## Locked decisions

### D1 聚合方式：iframe 外壳（Q1）

hub 只负责列表和 tab。每个在线会话的 tab 是一个 iframe，直接加载该会话自己端口上的会话页面。

| 选项 | User experience | Technical correctness | Risk | Cost |
|---|---|---|---|---|
| **A. iframe 外壳** | good | good | good | good |
| B. 反向代理 | good | mixed | mixed | good |
| C. hub 直接读写会话文件 | mixed | poor | poor | good |

**决定：A。** Send 仍进会话自己的 serve，Monitor 模式和 wait 模式的唤醒链路都不变，`server.mjs`、`page.html`
一行不改。A 在四个维度上都不输，代价只是每个会话仍各占一个端口。

- B 落选：要改 Host/Origin 校验和页面里的绝对路径，换来的只是所有页面同源。
- C 落选：Claude Code 靠 Monitor 读会话 serve 进程的 stdout 被唤醒，hub 自己写 `events.jsonl` 唤醒不了 agent。

### D2 新 grill 进入 hub 的方式：SKILL.md 改用 `--open-command <hub-open>`（Q2）

`SKILL.md` 的 Start 第 3 步把 `--open` 换成 `--open-command <hub-open 的路径>`。hub-open 收到会话 URL 后：
确保 hub 在跑（没跑就后台拉起），通知 hub 打开该会话；当前没有任何 hub 页面在轮询时才打开浏览器。

| 选项 | User experience | Technical correctness | Risk | Cost |
|---|---|---|---|---|
| A. 手动开 hub，技能不改 | poor | good | good | good |
| **B. SKILL.md 改一处，用 hub-open** | good | good | mixed | good |
| C. 改 `server.mjs` 的 `--open` | good | mixed | poor | good |

**决定：B。** 只有 B 和 C 真正做到“一个网页”。B 最弱的是 risk：`SKILL.md` 是上游改得最勤的文件，
每次同步要确认这一处改动还在，属于“可能要手工合并”，不是“会坏”。

- A 落选：新 grill 仍然不停弹新标签，hub 只是事后补救。
- C 落选：改的是 `server.mjs` 的打开逻辑，上游这块最近还在动（localhost hardening），同步冲突概率更高。

Resume 不带 `--open`（上游既有规则），所以 resume 的会话不经过 hub-open；hub 靠扫描目录发现它，
用户在列表里点开即可。

### D3 服务已停的会话：不拉起，hub 渲染只读摘要（Q5）

hub **不**替用户执行 `serve --detach`。服务未运行的会话点开后显示只读摘要，要作答需先在 agent 会话里
`/grill-with-ui resume`。

| 选项 | User experience | Technical correctness | Risk | Cost |
|---|---|---|---|---|
| A. hub 拉起，之后不管 | good | good | mixed | mixed |
| B. hub 拉起并在关 tab/退出时停掉 | good | mixed | mixed | good |
| **C. 不拉起，只读摘要** | mixed | good | good | good |

**决定：C（用户选择；访谈中的推荐是 B）。** hub 不产生也不管理任何会话进程，没有进程泄漏和误停的可能。
它放弃的是 ux：服务已停时不能在 hub 里排队作答。

- A 落选：翻看多个旧会话会留下一串没人要的后台进程和端口。
- B 落选：要记录“谁拉起的”，停之前还要查 `listener`，判断错会停掉正在用的服务。

由此带来的连带结论：需求草稿里的 FR4“服务未运行时后台拉起”、G4 中的“继续作答（排队）”、
“拉起服务”接口及其安全约束全部取消。

## Routine choices

- **安装方式（Q3）**：`~/.agents/skills/grill-with-ui` 直接软链到本工作区
  `/Users/yaonanli/Developer/git/github/jasonku09/grill-with-ui`（用户选择；推荐是独立的 main checkout）。
  后果：工作区里切分支或改到一半的代码会立刻被所有正在跑的 grill 用到。
- **hub 生命周期（Q4）**：由 hub-open 按需后台拉起，之后常驻，直到手动停止或重启电脑；
  端口记在 `~/.grill-with-ui/hub.json`，下次尽量复用，使地址可收藏。
- **新 grill 到来时（Q6）**：hub 页面已开着就新增 tab 但不切换；tab 上显示“等你回答”角标，
  浏览器标签标题显示待处理数量。
- **只读摘要深度（Q7）**：主题、意图、状态，加每题标题和最终答案一行；题目可展开看选项、推荐理由和讨论线程；
  有 `visual.html` 就用 sandbox iframe 嵌入；已结束的会话给出设计文档路径；顶部提示“要作答请 `/grill-with-ui resume`”。
  不复刻评分色块和级别标签。
- **列表分组（Q8）**：按状态分组，顺序为 等你回答 → agent 处理中 → 空闲 → 已结束（默认折叠），每项带项目名。
- **额外提醒（Q9）**：只加 favicon 角标（有待处理时图标上加一个点）。不做桌面通知，不做提示音。
- **tab 恢复（Q10）**：已打开的 tab 和当前选中项记在 hub 页面的 `localStorage`，刷新或重开后恢复；
  已不存在的会话恢复时丢弃。
- **管理操作（Q11）**：只做隐藏。隐藏标记记在 `hub.json`，不动会话目录；不做删除、归档、改名。
- **对应的 agent 会话（Q12）**：由 hub-open 记录它被调用时的环境（harness 名称、能拿到的会话 id），
  不改 `SKILL.md`，拿不到就留空（用户选择；推荐是不做）。这份信息存在 `hub.json` 里，按会话目录索引，
  不写进会话目录，因为 `state.json` 只归 agent 写。

状态判定沿用需求草稿 FR2（未在访谈中改动）：已结束（`finished` 存在）；等你回答（`agent.status === "waiting"`
且有 open/reopened 题）；agent 处理中（`working`，或 `events.jsonl` 的 lastSeq 大于 `agent.handled`）；其余为空闲。

## Verified facts

以下是读代码和本机环境得出的，不是访谈得出的：

- 所有会话在 `~/.grill-with-ui/sessions/<project-key>/<id>/`（`GRILL_HOME` 可覆盖），扫两层目录即可发现。
- `server.mjs sessions` 只列当前项目的会话，hub 需要自己跨项目扫描。
- 会话页面没有设置 `X-Frame-Options` / `frame-ancestors`，可以被 iframe。
- 页面的 POST 校验 Origin；iframe 内页面的 Origin 是会话自己的端口，Send 不受影响。
- `/send` 写 `events.jsonl` 并打印到 serve 的 stdout；Claude Code 靠 Monitor 读这个 stdout 被唤醒。
- `serve` 已支持 `--open-command P`：用程序 P 代替系统 opener，调用形式为 `P <url>`，与 `--open` 互斥。
- `runningServer` 判断服务在线的方式：`server.json` 的 pid 存活，且请求 `/listener` 返回的 `session` 匹配。
- `state.json` 只有 `project`、`topic`、`intent`，没有指向具体终端或 agent 会话的字段。
- 本机 `~/.claude/skills/grill-with-ui` 软链到 `~/.agents/skills/grill-with-ui`，后者目前是普通拷贝，
  `server.mjs` 与本仓库内容一致。
- 在 Claude Code 桌面端，Monitor 最长 30 分钟到期，到期时 serve 进程随之结束；重新挂上后 serve 复用原端口。

## Risks

- **tab 打开期间服务停止。** agent 监听到期或退出时 iframe 会失效。hub 需要检测到服务下线并把该 tab 换成只读摘要，
  服务回来后换回会话页面。会话页面的草稿存在它自己端口的 `localStorage`，端口复用时不丢，端口变了就丢。
- **工作区即线上。** 软链到工作区后，`hub.mjs` 或 `server.mjs` 的语法错误会同时影响所有正在跑的 grill。
- **SKILL.md 同步冲突。** 每次从上游同步后要确认 `--open-command` 那一处仍在。
- **hub-open 路径。** `SKILL.md` 里要写 hub-open 的路径，它应以 `$SKILL` 为基准，避免写死绝对路径。
- **harness 信息时有时无。** 各 harness 是否把会话 id 放进环境变量并不一致，Q12 的显示项经常为空。
- **只读摘要与上游字段漂移。** 上游给 `state.json` 加字段时摘要不会坏，但不会显示新内容。
- **sandbox iframe 嵌 visual.html。** 该文件由 agent 生成并含脚本，嵌入时必须隔离，不能与 hub 同源执行。

## Deferred

无。

## Open threads

- hub-open 的具体形态（独立的 `hub-open.mjs` 还是 `hub.mjs open <url>` 的包装）未讨论；
  `--open-command` 只接受一个程序路径、不带参数，所以需要是一个可直接执行的文件。
- hub 的停止命令形式（`hub.mjs stop`）只在 Q4 选项里提到，未单独确认。
- 需求草稿第 9 节第 5 条（入口是独立 `hub.mjs`）未单独提问；按“上游文件少改”的约束，默认采用独立的 `hub.mjs` + `hub.html`。

## 与需求草稿的差异

| 草稿 | 本文 |
|---|---|
| FR3 按项目分组 | 按状态分组（Q8） |
| FR4 服务未运行时由 hub 拉起 | 不拉起，显示只读摘要（Q5） |
| FR6 “hub 拉起的服务是否停止”待定 | 不再适用，hub 不拉起任何服务 |
| 非目标：不做管理操作 | 做隐藏，仍不做删除、归档、改名（Q11） |
| 第 9 节第 6 条倾向不改 SKILL.md | 改一处：`--open` 换成 `--open-command`（Q2） |
| 第 9 节第 4 条 agent 对应关系待定 | 由 hub-open 尽力记录（Q12） |
