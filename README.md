# Enter 换行 / Enter newline

一个配置 DeepSeek Harness (DSH) 输入框的发送键的插件：启用后默认 Enter 不再发送，而是插入换行；发送交给 Ctrl/Cmd+Enter (插话) 与 Shift+Enter (排队)。它不替换输入框、不读写草稿、也不直接调用发送按钮，只把按键重放成 composer 原本认识的手势，所以附件、引用、命令 chip、撤销历史和输入法组合态都沿用原实现

插件的核心是两套整体配置：

- 插件配置 (默认)：Enter 换行，Ctrl/Cmd+Enter 插话发送，Shift+Enter 排队发送；三个键还可以在独立设置页里逐键改成任一动作，保存时校验“至少一个换行、至少一个发送”
- 默认配置：热关闭插件，三个键全部交还给 DSH、插件完全不拦截

设置页顶部会读取 DSH「繁忙时 Enter」的当前值，显示每个键现在实际会做什么

两套配置切换即生效、即写盘，不需要保存或重启。在此之上，当前版本把这些细节做成了默认行为：

- **绝对动作**：换行、插话、排队三个语义彼此独立，由插件决定重放哪个手势；用户改 DSH「繁忙时 Enter」不会让 Ctrl/Cmd+Enter 与 Shift+Enter 的含义漂移
- **输入法安全**：组合中的 Enter 归输入法；DSH 在 `compositionend` 后还有 10ms 的组合判定，这段窗口里的“发送”会延后重放而不是被宿主吞掉，中文选词后立刻发送不丢键 (换行重放不受影响)
- **补全菜单三态**：有高亮候选时让给菜单；菜单打开但没有高亮时，宿主会把它误判成提交，插件直接吞掉（不发、不换行）；没有菜单才按映射执行。页面别处的 listbox 不会让当前输入框失效
- **改版失败安全**：`[data-composer-input]` 不存在时只告警一次，并在输入框卡片内吞掉发送类 Enter（含 Ctrl/Cmd+Enter）——宁可“回车没反应”，也不把半截草稿发出去；Shift+Enter 仍由宿主换行
- **全 composer 生效**：主输入框和右侧边栏的子智能体会话一视同仁；只改前端按键映射，不改变 Host 的投递语义。
- **可观测和迁移**：`window.__dshEnterNewline` 暴露预设、映射、`busyEnter`、锚点状态、最近一次按键决策与菜单拦截计数；设置页「复制诊断」一键取快照。配置可导出/导入 JSON（校验插件与格式）；浏览器存储写失败时页面会明说“只在本次会话生效”，不谎报已保存
- **轻量**：零依赖，逻辑集中在浏览器半件 `client.js` (约 49 KB，含注释)，Host 入口只是占位；无构建步骤，用 `link:` 安装时改完保存约半秒热加载

## 安装

```sh
# npm
dsh plugin --profile web add dsh-enter-newline

# GitHub 源码（pnpm 第一次会要求放行构建脚本，按提示重试；建议钉定 commit）
dsh plugin --profile web add github:Librorum545/Enter_Newline#<commit>
```

桌面端的 profile 由应用自己的插件管理器管理：在 **设置 → 插件** 的安装入口填入 `dsh-enter-newline`。首次安装（新增了一条 Host 插件行）需要重启桌面端；只是更新本仓库的 `client.js` 时不用——DSH 0.2.x 的 client-hmr 会热加载（见「热加载」一节）。

要求 DSH `>=0.2.2-rc.5 <0.3.0-0`，见 `package.json` 的 `engines.dsh`。

## 两套配置

| 配置 | Enter | Ctrl/Cmd+Enter | Shift+Enter |
|---|---|---|---|
| 插件配置（默认） | 换行 | 插话发送 | 排队发送 |
| 默认配置 | DSH 繁忙时的 Enter 行为（排队或插话） | 相反的那个投递方式 | 换行 |

- 切换配置**立即生效**、立即写盘，不需要保存，也不需要重启；「默认配置」就是最轻的关闭方式（热关闭插件）。
- 空闲时「插话」和「排队」都只是正常发送，两者只在智能体运行时不同：插话立即进入当前回合，排队等本轮结束。
- 插件配置下，三个键可以分别改成「换行 / 插话发送 / 排队发送」；保存时会校验「至少一个换行、至少一个发送」。
- 任一键被改动后，「恢复插件预设」可一键回到 Enter 换行 / Ctrl/Cmd+Enter 插话发送 / Shift+Enter 排队发送，点击后立即写盘。

## 设置页

插件在 **设置** 里注册一页「Enter 换行」（排在「通用设置」之后）：

- 顶部「当前生效」一行摘要：一眼确认现在哪套配置、三个键分别是什么（默认配置下由 `ui-conversation` 的 `busyEnter` 换算）。
- 两张配置卡片：「默认配置」热关闭插件、把三个键交还 DSH；「插件配置」是用户自定义配置。只有选中「插件配置」时才显示三个下拉、恢复插件预设、放弃和保存。
- 「输入框锚点：已检测到 / 未检测到」：DSH 改版导致 `[data-composer-input]` 不存在时会提示，并在控制台告警一次。
- 「导出 / 导入」：导出当前已保存的方案为 JSON；粘贴 JSON 后点「导入」立即生效。

导出格式：

```json
{
  "plugin": "dsh-enter-newline",
  "format": 1,
  "preset": "plugin",
  "bindings": { "enter": "newline", "ctrlEnter": "steer", "shiftEnter": "queue" }
}
```

也接受裸的 `{ "enter": "newline", "ctrlEnter": "steer", "shiftEnter": "queue" }`（此时保持当前配置）。导入会校验 `plugin`、`format` 与映射是否还能换行/发送，失败不写存储。

映射与配置保存在浏览器本地（`localStorage` 的 `composer-enter-newline:bindings:v1` 与 `composer-enter-newline:preset`）：它描述的是"这台机器上这几个键怎么按"，不进入共享的设置文档。

DSH 内置的「繁忙时的发送行为」说明文字（`设置 → 通用`）属于 `ui-conversation`，不是本插件的地盘：Client locale 注册表对每个命名空间与语言只允许一个所有者，重复注册会直接抛错，所以插件不能改写那段文案，只能自己提供一页说明与配置。

## 实现方式

浏览器端插件在 window 捕获阶段接管 Enter 的三种组合，按当前配置与映射重放成 composer 已经认识的手势：

- 插入换行 → 重放 Shift+Enter 的 keydown，由 composer 的 Lexical 键位在同一次按键里插入换行节点。
- 插话发送 / 排队发送 → 重放普通 Enter 或 Ctrl+Enter 的 keydown。composer 的 `resolveSubmitMode` 规定：普通 Enter 走「繁忙时的发送行为」，Ctrl/Cmd+Enter 走相反的那个；插件读取该设置的当前值（`ui-conversation` 命名空间里的 `busyEnter`），据此挑选手势，所以「插话/排队」的含义不受用户改设置影响。
- 「默认配置」下不重放任何事件。

每次按键只派发这一个事件：再补发一次 `beforeinput` 会插入第二个换行，因为 Lexical 的 DOM 提交发生在派发返回之后。插件不直接调用发送按钮，也不读写草稿内容；附件、引用、命令 chip、撤销历史、输入法组合态都沿用原代码。

**输入法结束后的 10ms 宽限**：DSH 自己的 keymap 在 `compositionend` 之后还会把 Enter 当作组合中处理（Safari 会在 `compositionend` 之后才发 closing keydown）。插件监听组合事件，在这 12ms 窗口内把「发送类」重放推迟到窗口结束再派发（换行重放不受影响，因为 composer 先判断 Shift+Enter）。这样中文选词确认后立刻按发送不会丢键。

**补全菜单的判定分三态**：只检查 `[data-composer-card]` 内可见的 `[data-trigger-menu]`（以及旧的 `[data-composer-overlay] [role="listbox"]`）。菜单里有高亮候选（listbox 带 `aria-activedescendant`）时 Enter 归菜单；菜单可见但**没有**高亮候选时，DSH 会把 Enter 判成提交，所以插件直接把 Enter 吞掉（不发、不换行）；没有菜单时才按映射执行。页面别处出现可见的 listbox 不再让当前输入框的三个键失效；找不到 composer 卡片时退回文档级判定。

**锚点失效时失败安全**：`[data-composer-input]` 不存在时（DSH 改版），插件只告警一次，并在“输入框卡片内的可编辑块”上吞掉发送类 Enter（含 Ctrl/Cmd+Enter），不再退回宿主的发送路径；Shift+Enter 仍由宿主换行。宁可“回车没反应”，也不把半截草稿发出去。

设置页走 Client 的 `settings.section` 与 `settings.section.icon` 槽位：分区页由插件注册（`order: 5`，紧跟「通用设置」），导航图标与分区同 id，文案注册在插件自己的 locale 命名空间里，切换语言时整页跟随。

## 边界

- 输入法组合中的 Enter 不拦截，由输入法选中候选词。
- 草稿只读（发送中、会话不可用）时不拦截。
- 补全菜单打开时 Enter 归菜单：有高亮候选就选中它；**菜单可见但没有高亮候选时 Enter 被吞掉**（不发、不换行），先 Esc 关菜单或选中候选再换行。Shift+Enter 不受影响，仍由宿主换行。
- 命令 chip 阶段（`/命令` 已选中、`data-phase="claimed"`）仍按映射执行：插件配置下 Enter 仍然换行，提交命令请用 Ctrl/Cmd+Enter 或发送按钮（命令为什么会有这一阶段，见下方「斜杠命令什么时候执行」）。
- 同一页面内的所有 composer（含右侧边栏的子智能体会话）都生效。
- 只改前端按键映射，不改变 Host 的投递语义。

### 斜杠命令（`/`）什么时候执行

`/` 命令**不是**一律“回车就执行”。DSH 按命令类型分四类，另有一种“根本不是命令”的情况，按 Enter 的后果各不相同：

| 命令类型 | 例子 | 按 Enter 的后果 |
|---|---|---|
| 客户端动作（无参数） | `/file` | 立即执行：从草稿里吃掉 `/file`，打开文件选择器，不产生模型回合 |
| 弹出选择器 | `/model` | 打开选择浮层，不执行；选完才生效 |
| 宿主裸命令（无参数） | `/compact` | 立即执行（由 DSH 在会话里运行），不产生模型回合 |
| 需要参数的命令 | `/goal`、`/feedback` | 不执行：`/goal` 变成命令 chip（`data-phase="claimed"`），补完参数后再提交才执行 |
| 未注册的名字 | `/zzz` | 不匹配任何命令，按普通文本消息发给模型 |

命令目录按会话和代理预设解析，能用的命令随环境不同；上表的名字取自默认安装。

四个影响判断的细节：

- **两条 Enter 路径**：菜单里有高亮候选时，Enter 是“选中这个候选”；菜单可见但没有高亮时，Enter 是“提交这一整行”，由 DSH 再判断它是不是命令。
- **只有行首的 `/`** 才算命令；行中间出现的 `/xxx` 是普通文本。
- **需要参数的命令按空格就会变成 chip**，不用等 Enter；变成 chip 后，在本插件配置下 Enter 仍然是换行，提交命令要用 Ctrl/Cmd+Enter 或发送按钮。
- **打错的命令**（如 `/zzz`）在 DSH 原生行为里会被当普通消息发出去；本插件配置下 Enter 本来就不是发送键，所以不会因为按 Enter 发出半截内容，如果此时补全菜单还开着且没有高亮候选，这个 Enter 会被直接吞掉（不发、不换行）。

切到「默认配置」时，以上行为全部由 DSH 决定，插件不介入。

## 诊断

插件启用期间暴露一个只读的诊断入口（与 `window.__dshMobileKeys` 同一风格）：

```js
window.__dshEnterNewline.getStatus()      // 当前状态快照
window.__dshEnterNewline.getBindings()    // 当前三键映射
window.__dshEnterNewline.inspect()        // 快照的格式化 JSON
```

`getStatus()` 返回：

| 字段 | 说明 |
|---|---|
| `version` | 插件版本（与 `package.json` 一致） |
| `preset` | `plugin`（插件配置）或 `dsh`（默认配置） |
| `bindings` | `{ enter, ctrlEnter, shiftEnter }` 当前映射 |
| `busyEnter` | `ui-conversation` 的「繁忙时 Enter」：`steer` / `queue` / `unknown` |
| `anchor` | `found` / `missing` / `unknown`：是否还找得到 `[data-composer-input]` |
| `composers` | 页面上当前匹配到的 composer 数量 |
| `lastKey` | 最近一次 Enter 的 `{ at, gesture, decision }`，`decision` 说明这次为什么换行/为什么让路/为什么被吞 |
| `menuBlocks` | 被“菜单无高亮”吞掉的次数 |
| `storage` | `local`（已持久化）或 `volatile`（浏览器存储不可用，仅本次会话） |

`lastKey.decision` 取值：`preset-dsh`、`composing`、`readonly`、`reserved`、`menu-pick`、`menu-blocked`、`newline`、`native-newline`、`steer`、`queue`、`ime-deferred`、`anchor-missing-blocked`。

设置页锚点那一行右侧有「复制诊断」：把 `inspect()` 的结果复制到剪贴板，提 issue 时直接粘贴即可；剪贴板不可用时会把这段落进下方的导出文本框，手动全选复制。

## 关闭与移除

- 临时关闭：设置页切到「默认配置」，三个键立即恢复原生，不需要重启。
- 彻底移除：在 **插件** 面板禁用或移除本插件。禁用会立刻撤掉按键拦截和设置页；重新启用会重新加载浏览器半件。

### 热加载

本插件只有浏览器半件。DSH 的 `client-hmr` 默认每 500ms `stat` 轮询每个已加载插件行的 `client.js`，发现 mtime/ctime/size 变化就发布新的 artifact rev，并通过 `/plugins/events` 的 SSE 通知页面；页面收到 `rebuilt` 后由模块表重新装载该插件（旧实例 dispose、新实例 apply）。所以用 `link:` 安装时，改完 `client.js` 保存，约半秒后当前页面就会用新代码，**不需要禁用再启用，也不需要重启**。

需要重启的只有 Host 半件（`index.js`、`cordis.patch.yml`、新安装的插件行）：那部分在进程启动时加载。禁用/启用插件仍然是可用的手动兜底。

## 已知限制

- 依赖 composer 的 `[data-composer-input]`、卡片的 `[data-composer-card]` 与菜单的 `[data-trigger-menu]`；DSH 改版后需要同步更新（设置页的锚点自检 + `getStatus().anchor` 会提示）。锚点失效时会退化为“只告警 + 吞掉发送”，不会把半截草稿发出去。
- 重放的是合成键盘事件（`isTrusted=false`）。DSH 目前不检查这个标记；插件用 `WeakSet` 忽略自己派发的事件，不会自激。
- 「插话/排队」依赖读取 `ui-conversation` 的 `busyEnter`；读不到时按 `queue` 处理。
- 会话不支持插话时，「插话发送」由 composer 自行退化为排队，与 DSH 原生行为一致。
- 输入框为空、且队列里已有消息时，走 Ctrl/Cmd 通道的动作按 DSH 原生语义变成「插话全部排队消息」。
- 按键映射与配置存在浏览器本地，不同浏览器/不同机器需要各自设置；1.3.0 起提供导出/导入用于迁移。
- 浏览器存储不可用时（隐私模式、配额满）设置只对本次会话生效：设置页会明确提示，`getStatus().storage` 显示 `volatile`。
- 内置的「繁忙时的发送行为」说明文字由 `ui-conversation` 拥有，插件无法替换（同一 locale 命名空间与语言只允许一个所有者）；想改那段文字只能走 DSH 上游。
- 浏览器半件由 client-hmr 热加载（见「热加载」）；Host 半件与插件行的增删仍需要重启桌面端。

## 测试

`npm test` 用最小的 React 与 window 打桩直接运行 `client.js`，覆盖：

- 默认映射、已保存映射、`busyEnter` 变化时手势的翻转；
- 默认配置完全不拦截；
- 输入法组合与结束后 12ms 窗口内发送重放的延迟、换行重放的即时性；
- 补全菜单三态（有高亮让路、无高亮吞键、页面别处的 listbox 不影响、卡片消失后的兜底）；
- 锚点缺失只告警一次，以及失败安全吞键、只读/Alt/Composition/菜单高亮的豁免；
- 诊断 API（安装、字段、映射副本、`lastKey` 决策、禁用后移除、版本与 `package.json` 一致）与设置页「复制诊断」；
- 设置页两张配置卡、一行状态摘要、锚点显示；
- 三键下拉与保存校验、保存按钮脏/净状态、恢复插件预设、放弃恢复；
- 配置切换立即写盘并立即生效；
- 导出内容、导入（信封/裸映射/非法 JSON/错误格式/错误插件/非法映射）、导入成功后的存储与生效；
- 浏览器存储写入失败时页面明确提示且不谎报“已保存”；
- 中英文案键齐全且「换行」文案统一。

## 许可证

[MIT](LICENSE) © 2026 Librorum
