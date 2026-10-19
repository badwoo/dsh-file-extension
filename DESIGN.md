# dsh-file-extension — 技术侦察结论与设计方案

> 侦察基准：本机实际安装的 **dsh `0.2.1-rc.2`**（`C:\Users\10254\AppData\Roaming\npm\node_modules\@deepseek-ai\dsh`）
> 与桌面版 Electron `44.7.0`（`D:\AI\dsh\resources\app.asar`）。所有结论均来自实机源码/类型定义/在线 Inspect，
> 未使用记忆推测。

---

## 一、侦察结论

### 1.1 右侧栏文件面板归属

| 问题 | 结论 | 证据 |
|---|---|---|
| 面板由谁提供 | **官方包** `@deepseek-ai/dsh-client-ui-sidebar-files@0.2.1-rc.2` | 该包 `README.md`；其 `lib/client.js` 渲染 `FilesBody` |
| 是否 DSH-better-sidebar | **否**，未安装 | `profiles/{web,desktop}/package.json`、`cordis.patch.yml`、`node_modules` 全量检索均无 `better-sidebar`（仅在 patch 注释里作为"历史"提及） |
| 文件行 DOM 契约 | **有稳定数据属性**：`<li data-files-entry="file|directory|other" data-files-path="<绝对路径>">` | `dsh-client-ui-sidebar-files/lib/client.js:496-553` |

> 关键发现：文件树**不是**给外部插件设计的可扩展行，但它对外暴露了 `data-files-entry` / `data-files-path`
> 两个语义化数据属性。这比 CSS Module 类名（`k-1LKG_row` 这种带哈希的）稳定得多，是事实上的锚点。

### 1.2 可用 Slot 扩展点（在线 Inspect 实查）

在 `client/Slots.listSubTree` 中逐个核对了与文件树相关的 seat：

| Slot | kind / scope | 结论 |
|---|---|---|
| `sidebar.right.tab.files.actions` | list / session | **只有表头工具栏**（刷新按钮右侧），当前 occupant 仅 `open-in-app`。**不是**逐行扩展点 |
| `sidebar.right.pane.tab` | keyed / session | 用于替换整个 tab 类型 body（按 type id 分发），不是行级 |
| `sidebar.right.tab.menu.item` | list / session | 扩展**标签页**的操作菜单，不是文件条目 |
| `sidebar.right.tab.guide(.entry)` | chain / keyed | 引导页，无关 |
| `sidebar.right.pane.tab.title` | keyed / session | 标签标题，无关 |

**结论：目标面板没有任何"文件行级"的官方 Slot。** 官方 README 也明确写着
`Known Limitations: Listing only. No search, artifact filter, drag-and-drop, rename, context menu`。

因此，实现右键菜单与悬停 @ 按钮**必须**走 DOM 事件委托方案（任务书第三节第 4 条允许的分支），
并在 README 中标注耦合风险。

**可用的 UI 挂载点**（用于承载菜单/对话框/toast 等浮层）：
- `shell.overlay` — list / **root** scope，官方描述："Frame-wide floating layer, above every column and outside their scroll containers. The layer itself is click-through — entries opt back into pointer events"。**这是为这类浮层准备的官方 seat**，无需 DOM 游离挂载。
- `conversation.input.dock` — list / session scope，可拿到 `inputActions`（用于"添加到对话"）。

### 1.3 Host / Client 通信通道

| 通道 | 可用性 | 说明 |
|---|---|---|
| **Typert Remote**（`TypertRemoteService` + `@Remote` + `ctx.typert.register`） | ✅ 首选 | 官方标准做法。Host 侧注册 service，Client 侧 `ctx.remote.$mount({package, descriptors})` 后经 `ctx.reflect.get("remote.<ns>")` 调用；共享进程级浏览器 Cookie 鉴权，无需自建 Token |
| `ctx.webServer.register()` 裸 HTTP 路由 | ✅ 备选 | `dsh-host-open-in-app` 用的方式，需自己做 `connection.requestRejection()` 鉴权 |
| `host.call()` builtin | ❌ 不可用 | 仅限**动态 Cordis package**（`dsh-cordis-client-runner`），静态 bundle 拿不到 |
| `ctx.connection` 通用 RPC | ✅ 存在但偏底层 | 不必要 |

**选定：Typert Remote**，与社区插件 `dsh-at-file@0.7.0` 完全同构（该包已解包至 `_recon/` 作参考）。

### 1.4 各功能已有的官方能力（能复用就绝不自造）

| 功能 | 官方能力 | 用法 |
|---|---|---|
| **在文件管理器中显示** | ✅ **已有** | `ctx.remote.session.openWorkspacePath({ path, action: 'reveal' })`；可用性用 `ctx.remote.session.canOpenWorkspacePath()` 探测。Host 侧 `sessionController.workspaceDesktop()` 返回 `{name, available, fileManager: 'finder'\|'explorer'\|'directory'\|null}` |
| **添加到对话** | ✅ **已有** | session-scoped slot 的标准 prop `inputActions.captureInsertion()` → `inputActions.insertText(text, span)`。这正是"光标处插入、不覆盖草稿、不破坏引用 chip、单步 undo"的官方语义 |
| **在新标签页打开** | ✅ **已有** | `ctx.sidebarRight.openResource(address)`（`SidebarRightController`，跨插件公开面），地址用 `sessionFileAddress(sessionId, path)` 生成 |
| **关闭预览标签** | ✅ **已有** | `ctx.sidebarRight.tabsIn(sessionId)` 找 `contentId` 匹配的 tab → `ctx.sidebarRight.closeIn(sessionId, tabId)` |
| **文件树自动刷新** | ✅ **已有** | 文件树对每个展开目录持有 `workspaceFiles.changes` watch，外部 fs 变更自动刷新。rename/delete/save-as 后无需手动 refresh |
| **选择目录** | ✅ **已有** | `ctx.remote.directoryPicker.pick()`；桌面版走原生 `dsh-desktop:directory-pick` 对话框 |
| **回收站** | ❌ **完全没有** | 全量检索官方 200+ 包：`trashItem` / `Recycle` / `trash` **零命中**。必须自建 |
| **原生另存为对话框** | ❌ **没有通道** | Electron 侧 `DESKTOP_IPC` 只有 `directoryPick`，无 `showSaveDialog`；`app.asar` 内 `showSaveDialog` 零命中 |

### 1.5 回收站实现通道（已实机验证）

- **Windows**：PowerShell `Microsoft.VisualBasic.FileIO.FileSystem::DeleteFile/DeleteDirectory(path, OnlyErrorDialogs, SendToRecycleBin)`。
  **已实测**：临时文件删除后 `Test-Path` 为 False，且在其 SID 的 `C:\$Recycle.Bin\...` 内按 `$I` 记录解析出原始路径，**确认进入回收站**。
- **macOS**：优先 `trash` CLI（Homebrew `macos-trash`）；否则 `osascript -e 'tell application "Finder" to delete POSIX file "..."'`。
- **Linux**：按 FreeDesktop Trash 规范自行移动到 `~/.local/share/Trash/{files,info}`（生成 `.trashinfo`）。
- **降级**：以上全部失败（无权限 / 无桌面 / 远程 SSH）→ 永久删除，且确认框文案切换为红色警示。

### 1.6 主题令牌（在线 `Theme.listTokens` 实查）

`--dsw-alias-bg-overlay`、`--dsw-alias-bg-layer-1/2`、`--dsw-alias-border-l1/l2`、
`--dsw-alias-label-primary/secondary`、`--dsw-alias-interactive-bg-hover`、
`--dsw-alias-state-error-primary`、`--dsw-alias-state-success-primary`、`--dsw-alias-state-warn-primary`、
`--dsw-radius-sm/md`、`--dsw-specific-sidebar-fill`。
深浅色由 `body[data-ds-dark-theme]` 驱动，令牌自动跟随 → 无需自定义主题逻辑。

---

## 二、选定方案与理由

### 2.1 方案对比

| | 方案 A：纯 DOM 事件委托 | 方案 B：替换整个 tab 类型（`sidebar.right.pane.tab` 注册自己的 files body） | 方案 C：等官方加行级 slot |
|---|---|---|---|
| 可行性 | ✅ 立即可做 | ⚠️ 技术可行但**必须重写整棵树**（列表/展开/滚动/自动刷新/watch 全都要自己实现），且会与官方 tab 类型争抢同一 kind | ❌ 当前版本没有 |
| 侵入性 | 低（只读 DOM 属性 + 浮层在官方 overlay） | 高（完全接管面板，官方升级即坏） | 无 |
| 升级风险 | 中（依赖 `data-files-entry`/`data-files-path`） | 高 | 无 |
| 工作量 | 小 | 极大 | — |

**选定方案 A**。理由：
1. 官方**没有**行级扩展点，B 会为了加一个右键菜单而重写整个文件树，明显不划算，且会与 `sidebar-files` 争抢 `kind: 'files'` 的 keyed 注册，风险远大于收益。
2. 树对外暴露了语义化 `data-files-*` 属性，是比类名更稳的锚点；即使未来类名哈希变化，属性契约仍可用。
3. 所有**新 UI**（菜单、对话框、toast、行内重命名输入框）都挂在官方 `shell.overlay` slot 里，是正规 React 渲染，不是 `document.body.appendChild` 游离节点。
4. 事件监听、MutationObserver、样式、slot 注册全部包在 `ctx.effect()` 内，卸载即回收。

### 2.2 包结构

```
dsh-file-extension/
├── package.json            # exports["."] / exports["./client"] / dsh.bundle / dsh.client
├── cordis.patch.yml        # loader insert 一条 host 行
├── lib/                    # 预构建产物（提交入库，GitHub 安装免构建）
│   ├── index.js            # Host 入口（apply + Typert service + typert manifest）
│   └── client.js           # Client 入口（__ModuleLoader__ factory）
├── src/                    # 可读源码（构建输入，随仓库发布便于审计）
│   ├── host/
│   │   ├── index.js        # apply / Config / inject
│   │   ├── runtime.js      # FileExtensionRuntime extends TypertRemoteService
│   │   ├── contract.js     # InvocationDescriptor[] + zod 编解码
│   │   ├── capabilities.js # 平台探测：reveal / trash / saveDialog
│   │   ├── trash.js        # 跨平台回收站（win/mac/linux + 永久删除降级）
│   │   ├── fsops.js        # rename / delete / copy / saveAs / stat / 冲突检测
│   │   └── typert.js       # TYPERT_MANIFEST
│   └── client/
│       ├── index.js        # inject / apply：locale、slot 注册、effect
│       ├── controller.js   # 委托事件 + MutationObserver + 菜单状态机
│       ├── menu.js         # 上下文菜单组件（键盘导航/边缘翻转/Esc）
│       ├── overlay.js      # 浮层根（菜单 + 对话框 + toast 栈）
│       ├── dialogs.js      # 确认框 / 另存为框 / 重命名行内编辑
│       ├── dock.js         # 隐藏的 conversation.input.dock 探针，捕获 inputActions
│       ├── styles.js       # CSS（仅 --dsw-alias-* 令牌）
│       └── locales.js      # zh / en 词典
├── locale/{en,zh}.json     # 插件元数据（meta.title / meta.description）
├── icon.svg
├── build.mjs               # esbuild 打包 src -> lib
├── README.md / README.zh.md
├── LICENSE                 # MIT
└── DESIGN.md               # 本文件
```

### 2.3 Host / Client 划分

```
┌────────────────────────── Browser (Client half) ──────────────────────────┐
│  controller.js                                                            │
│   ├─ document 委托：contextmenu / mouseover / click  (capture)            │
│   ├─ MutationObserver：树节点增删时清理行内编辑态                          │
│   └─ 读取 data-files-entry / data-files-path  ← 唯一对官方树的依赖        │
│                                                                           │
│  shell.overlay  (root scope)  → overlay.js                                │
│   ├─ Menu（图标 + 键盘导航 + 视口边缘翻转）                                │
│   ├─ ConfirmDialog（回收站 / 永久删除 两套文案）                           │
│   ├─ SaveAsDialog（默认名「原名-副本.ext」，目录按钮走原生 picker）         │
│   ├─ InlineRename（绝对定位覆盖在行名上，Enter/Esc）                       │
│   └─ Toast 栈                                                            │
│                                                                           │
│  conversation.input.dock (session scope) → dock.js                        │
│   └─ 捕获 inputActions → 供「添加到对话」调用 captureInsertion/insertText   │
└───────────────────────────────────┬───────────────────────────────────────┘
                                    │  Typert Remote (JSON, Cookie 鉴权)
                                    │  ctx.remote.$mount({package, descriptors})
┌───────────────────────────────────▼───────────────────────────────────────┐
│                       Host half (Node, dsh process)                       │
│  FileExtensionRuntime extends TypertRemoteService                         │
│   @Remote capabilities()  → { platform, reveal, trash, saveDialog }        │
│   @Remote stat(path)      → { exists, kind, bytes, mtime }                │
│   @Remote rename(path,name)                                               │
│   @Remote remove(path,{mode:'trash'|'permanent'})                         │
│   @Remote copyTo(path,{targetDir,name,overwrite})                         │
│   @Remote saveDialogAvailable() / pickSaveTarget(...)                     │
│                                                                           │
│  trash.js  ── win: PowerShell VB SendToRecycleBin（已实测）               │
│           ── mac: trash CLI → osascript                                    │
│           ── linux: FreeDesktop ~/.local/share/Trash                       │
│           ── 全失败 → permanent（客户端切红色警示文案）                     │
└───────────────────────────────────────────────────────────────────────────┘
```

### 2.4 数据流：删除（含回收站降级）

```
右键 → controller 定位 [data-files-entry] → 取 data-files-path
  → Host capabilities()（页面级缓存一次）
  → trash 可用 ? 「该文件将被移动到回收站，可以从回收站恢复」
               : 「该操作将永久删除，不可恢复」+ 红色警示
  → 用户确认 → Host remove(path, mode)
  → 成功：toast + 关闭该文件的预览标签（tabsIn → contentId 匹配 → closeIn）
          + 文件树由官方 watch 自动刷新
  → 失败：toast 显示 RemoteError.code + message，原文件不动
```

### 2.5 数据流：添加到对话

```
「添加到对话」/ 悬停 @ 按钮
  → dock.js 已捕获该 session 的 inputActions
  → span = inputActions.captureInsertion()
  → text = `@${relativePath}`（含空格/特殊字符时用 `@"path with spaces"` 语法）
  → inputActions.insertText(text, span)
  → 返回 false（草稿已变/提交锁定）→ toast 提示「请重试」
```

---

## 三、已知限制（将写入 README）

1. **依赖官方树的 DOM 数据属性** `data-files-entry` / `data-files-path`。官方若改名，右键菜单与 @ 按钮会静默失效（不会白屏，controller 找不到锚点即不动作）。已在代码中集中为单一常量，便于跟随升级。
2. **行内重命名**是绝对定位覆盖输入框（因为无法向官方行内注入组件）；树在重命名期间若被 watch 刷新导致行位移，输入框会跟随该行重新定位。
3. **纯网页版降级**：
   - 在文件管理器中显示 → 依赖 `canOpenWorkspacePath()`；为 false 时菜单项置灰 + tooltip 说明。
   - 另存为 → 桌面版可走原生目录选择器；纯网页版退化为浏览器下载（`<a download>` + Blob，走浏览器默认下载流程），超过 32 MiB 先提示大小。
   - 回收站 → 取决于 **Host 所在机器**（不是浏览器所在机器）。Host 无回收站能力时降级为永久删除 + 红色警示。
4. **`showSaveDialog` 不存在**：dsh 的 Electron 壳只开放 `directoryPick`。方案是「原生目录选择器 + 自有文件名输入框」，语义上等价（可改名、可换目录、有覆盖确认），但不叫 `showSaveDialog`。

---

## 四、待确认事项

1. 是否接受 **DOM 事件委托** 方案（官方无行级 slot，已论证）。
2. 是否接受 **「原生目录选择器 + 文件名输入框」** 代替严格意义的 `showSaveDialog`（dsh 无此通道）。
3. GitHub 仓库 `badwoo/dsh-file-extension` 的推送凭据（本机 `gh` 未登录）。
