# Enter 换行 / Enter newline

把 DSH 输入框的发送键从 Enter 改成 Ctrl/Cmd+Enter，并提供两套整体配置：

- **插件配置（默认）**：Enter 换行，Ctrl/Cmd+Enter 插话发送，Shift+Enter 排队发送；三个键还可以在设置页里逐键调整。
- **默认配置**：热关闭插件，三个键全部交还给 DSH、插件完全不拦截；设置页顶部会读取 DSH「繁忙时 Enter」的当前值，显示每个键现在实际会做什么。

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

**补全菜单的判定收敛到当前 composer**：只检查 `[data-composer-card]` 内可见的 `[data-trigger-menu]`（以及旧的 `[data-composer-overlay] [role="listbox"]`）。页面别处出现可见的 listbox 不再让当前输入框的三个键失效；找不到 composer 卡片时退回文档级判定。

设置页走 Client 的 `settings.section` 与 `settings.section.icon` 槽位：分区页由插件注册（`order: 5`，紧跟「通用设置」），导航图标与分区同 id，文案注册在插件自己的 locale 命名空间里，切换语言时整页跟随。

## 边界

- 输入法组合中的 Enter 不拦截，由输入法选中候选词。
- 草稿只读（发送中、会话不可用）时不拦截。
- 补全菜单打开时 Enter 归菜单，三种手势都暂时不生效。
- 命令 chip 阶段（`/命令` 已选中、`data-phase="claimed"`）仍按映射执行：插件配置下 Enter 仍然换行，提交命令请用 Ctrl/Cmd+Enter 或发送按钮。
- 同一页面内的所有 composer（含右侧边栏的子智能体会话）都生效。
- 只改前端按键映射，不改变 Host 的投递语义。

## 关闭与移除

- 临时关闭：设置页切到「默认配置」，三个键立即恢复原生，不需要重启。
- 彻底移除：在 **插件** 面板禁用或移除本插件。禁用会立刻撤掉按键拦截和设置页；重新启用会重新加载浏览器半件。

### 热加载

本插件只有浏览器半件。DSH 的 `client-hmr` 默认每 500ms `stat` 轮询每个已加载插件行的 `client.js`，发现 mtime/ctime/size 变化就发布新的 artifact rev，并通过 `/plugins/events` 的 SSE 通知页面；页面收到 `rebuilt` 后由模块表重新装载该插件（旧实例 dispose、新实例 apply）。所以用 `link:` 安装时，改完 `client.js` 保存，约半秒后当前页面就会用新代码，**不需要禁用再启用，也不需要重启**。

需要重启的只有 Host 半件（`index.js`、`cordis.patch.yml`、新安装的插件行）：那部分在进程启动时加载。禁用/启用插件仍然是可用的手动兜底。

## 已知限制

- 依赖 composer 的 `[data-composer-input]`、卡片的 `[data-composer-card]` 与菜单的 `[data-trigger-menu]`；DSH 改版后需要同步更新（设置页的锚点自检 + 控制台告警会提示）。
- 重放的是合成键盘事件（`isTrusted=false`）。DSH 目前不检查这个标记；插件用 `WeakSet` 忽略自己派发的事件，不会自激。
- 「插话/排队」依赖读取 `ui-conversation` 的 `busyEnter`；读不到时按 `queue` 处理。
- 会话不支持插话时，「插话发送」由 composer 自行退化为排队，与 DSH 原生行为一致。
- 输入框为空、且队列里已有消息时，走 Ctrl/Cmd 通道的动作按 DSH 原生语义变成「插话全部排队消息」。
- 按键映射与配置存在浏览器本地，不同浏览器/不同机器需要各自设置；1.3.0 提供导出/导入用于迁移。
- 内置的「繁忙时的发送行为」说明文字由 `ui-conversation` 拥有，插件无法替换（同一 locale 命名空间与语言只允许一个所有者）；想改那段文字只能走 DSH 上游。
- 浏览器半件由 client-hmr 热加载（见「热加载」）；Host 半件与插件行的增删仍需要重启桌面端。

## 测试

`npm test` 用最小的 React 与 window 打桩直接运行 `client.js`，覆盖：

- 默认映射、已保存映射、`busyEnter` 变化时手势的翻转；
- 默认配置完全不拦截；
- 输入法组合与结束后 12ms 窗口内发送重放的延迟、换行重放的即时性；
- 补全菜单收敛（卡片内菜单让路、页面别处的 listbox 不再影响）；
- 锚点缺失告警只出现一次；
- 设置页两张配置卡、一行状态摘要、锚点显示；
- 三键下拉与保存校验、保存按钮脏/净状态、恢复插件预设、放弃恢复；
- 配置切换立即写盘并立即生效；
- 导出内容、导入（信封/裸映射/非法 JSON/错误格式/错误插件/非法映射）、导入成功后的存储与生效；
- 中英文案键齐全且「换行」文案统一。

## 许可证

[MIT](LICENSE) © 2026 Librorum
