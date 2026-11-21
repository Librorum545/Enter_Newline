# Enter 换行 / Enter newline

把 DSH 输入框的发送键从 Enter 改成 Ctrl/Cmd+Enter：Enter 只负责换行。

## 行为

| 按键 | 空闲会话 | 智能体运行中 |
|---|---|---|
| Enter | 插入换行 | 插入换行 |
| Ctrl+Enter / Cmd+Enter | 发送 | 按「繁忙时的发送行为」投递 |
| Shift+Enter | 插入换行 | 插入换行 |

「繁忙时的发送行为」在 **设置 → 通用** 中设置：

- 选「插话发送」：运行中按 Ctrl/Cmd+Enter 立刻注入当前回合；发送按钮同样走插话。
- 选「排队发送」：运行中按 Ctrl/Cmd+Enter 把消息排进队列。

补全菜单（`/` 命令、`@` 引用）打开时，Enter 仍然用于选中当前候选项，不会换行。

## 实现方式

浏览器端插件在 window 捕获阶段改写 Enter 的修饰键，再把事件按 composer 原来的路径重放：

- 普通 Enter → 重放为 Shift+Enter 的 keydown，由 composer 的 Lexical 键位在同一次按键里插入换行节点。
  每次按键只派发这一个事件：再补发一次 `beforeinput` 会插入第二个换行，因为 Lexical 的 DOM 提交发生在派发返回之后。
- Ctrl/Cmd+Enter → 重放为普通 Enter 的 keydown，由 composer 自己的提交流程决定投递方式。

插件不直接调用发送按钮，也不读写草稿内容；附件、引用、命令 chip、撤销历史、输入法组合态都沿用原代码。

## 边界

- 输入法组合中的 Enter 不拦截，由输入法选中候选词。
- 草稿只读（发送中、会话不可用）时不拦截。
- 同一页面内的所有 composer（含右侧边栏的子智能体会话）都生效。
- 只改前端按键映射，不改变 Host 的投递语义。

## 关闭与移除

在 **插件** 面板禁用或移除本插件即可恢复原来的 Enter 发送行为；刷新页面后生效，桌面端需要重启窗口。

## 已知限制

- 依赖 composer 的 `data-composer-input` 标记与补全菜单的 `role="listbox"`；DSH 改版后需要同步更新。
- 仅适用于 Chromium 内核（桌面端、Chrome/Edge 打开的 Web 页面）；Safari/WebKit 把换行交给原生事件，这里没有覆盖。
- 补全菜单打开时 Enter 会被菜单消费，这是有意保留的行为。
- 插件在 DSH 启动时加载；安装或修改后需要重启桌面端（或刷新 Web 页面）。

## 许可证

[MIT](LICENSE) © 2026 Librorum
