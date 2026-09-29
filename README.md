# dsh-session-delete

[![CI](https://github.com/huimingli666/dsh-session-delete/actions/workflows/ci.yml/badge.svg)](https://github.com/huimingli666/dsh-session-delete/actions/workflows/ci.yml)

为 DSH（DeepSeek Harness）Web 界面新增**真正的“删除会话”能力**。

DSH 会话管理原本只支持：重命名、分叉（fork）、归档（archive）。归档只是把会话
从列表隐藏（registry 的 `archivedSessionIds` 集合），磁盘上的事件日志、工作区挂账
全部保留，也无法恢复显示。本插件补上缺失的“删除”：**彻底移除一个会话** ——
工作区挂账、归档集合条目、内存会话记录、磁盘事件日志一并清除。

## 功能

- 在打开会话的**头部操作区**（`conversation.session.header.actions` 官方插槽）
  新增「删除会话」危险按钮；
- 点击后弹出**二次确认模态框**（不可恢复操作），确认后调用宿主路由删除；
- 删除成功后自动把当前视图切到新会话，会话行通过既有 `host/session-removed`、
  `host/workspace-changed`、`host/archived-sessions-changed` 消息立即从 GUI 消失；
- 结果通过右下角 toast 反馈（成功 / 失败原因）。

## 删除管线（宿主端）

`src/delete.js` 的 `deleteSession()` 依次执行：

1. **校验**：会话 ID 必须形如 `session-<uuid>`；
2. **运行保护**：会话挂有**活跃** agent 循环（`agent.status === "running"`，含工作中
   与等待审批/回复）→ 拒绝删除（`code: running`），防止删掉正在写入的记录；仅驻留、
   已空闲的 agent（`status === "idle"`）允许删除——删除前先 `agent.cancel()` 清空
   inbox，避免残留输入复活写入；状态无法读取时按活跃处理（fail closed）；
3. **工作区挂账**：若会话被某个工作区记账（`sessionIds`），调用公开的
   `WorkspaceEntity.detachSession(id)` 移除（经 workspace 域表持久化，并自动触发
   `host/workspace-changed` 广播）；
4. **归档集合清理**：从 registry 全局 `archivedSessionIds` 中移除该 ID —— 官方无
   此接口，插件从**存活 registry 实例的原型**一次性安装清理方法（`src/unarchive.js`，
   只走类自身的 `enqueueOperation/requireState/setState`，保持在其写链与持久化路径
   上；实例原型方式避免了跨依赖树的模块解析问题）；补丁不可用时降级为警告，不阻断
   删除；
5. **磁盘日志**：先 `flush` 未落盘的缓冲事件（幂等），再按持久层
   `locate(header)` 删除会话目录（`~/.dsh/sessions/<项目键>/session-<uuid>/`），并
   兜底扫描会话根目录下残留的 `session-<uuid>` 目录/文件（`locate` 不可用时仍能删
   干净）；物理删除后 `sessionPersistence.list()` 自然不再枚举它，会话搜索索引
   （SQLite FTS）也会在对账时自动剔除；
6. **内存摘除 + 广播**：从 `sessions` store 移除该行并派发 `session/disposed`，
   GUI 经官方中继立即移除该会话行。

## 安全模型

- 路由 `POST /api/dsh-session-delete/delete` 带 **loopback-only 信任篱笆**
  （loopback socket + loopback Host + 浏览器同源标记；`X-Forwarded-For` 永不采信），
  与 DSH 宿主插件惯用的信任篱笆同一体例；
- 响应不携带任何会话内容；
- **正在运行的会话拒绝删除**；其余会话删除前强制二次确认；
- 插件所有阶段独立 `try/catch` 降级：任何一步失败只记日志，不拖垮宿主启动
  （fail-degrade）。

## 安装与激活

按 DSH 双面插件的注册方式（宿主 + 浏览器双面，靠 cordis bundle patch）。先把仓库
克隆到本地任意目录：

```bash
git clone https://github.com/huimingli666/dsh-session-delete.git
cd dsh-session-delete
```

```bash
# 1. 构建浏览器端 bundle（源码在 src/client/browser.js，产物 lib/client.js）
node scripts/build-client.mjs

# 2. 把插件包注册进 web profile 的 bundle 列表
dsh plugin --profile web add "$PWD"
#    并确保该包出现在 profile 的 dsh.profile.bundles 列表中
#    （或在 profile 配置中通过 cordis.patch.yml 的 insert 行启用）

# 3. 重启 dsh，刷新浏览器
```

激活后：

- 打开任意会话 → 会话标题右侧操作区出现垃圾桶图标按钮（标题悬浮提示
  「删除会话」）；
- 点击 → 确认模态框 → 永久删除；
- 运行中的会话会被拒绝并提示原因。

## 配置

无配置文件。可选的合成条目配置（`defaultConfig`）：

| 键 | 默认 | 说明 |
|---|---|---|
| `enabled` | `true` | 置 `false` 不挂载路由与通告 |
| `announceToAgent` | `true` | 是否向模型通告本插件能力 |

## 目录布局

```
src/index.js          宿主插件入口（路由挂载、引擎接线、systemPrompt 通告）
src/routes.js         loopback-only 路由 + 信任篱笆
src/delete.js         删除引擎（纯逻辑，可单测）
src/unarchive.js      archivedSessionIds 一次性清理补丁（可单测）
src/client/browser.js 浏览器端：header 删除按钮 + 确认模态 + toast
scripts/build-client.mjs  拼接浏览器 bundle（零依赖）
test/                 node:test 单元测试（引擎 / 路由 / 补丁 / bundle 冒烟）
lib/client.js        构建产物（勿手改）
```

## 测试与构建

```bash
npm test              # node --test test/*.test.js
node scripts/build-client.mjs   # 重新生成 lib/client.js
```

## 限制

- 删除入口位于**已打开会话的头部操作区**；会话列表行的操作菜单（重命名/分叉/归档）
  是 ui-workspace 内部固定组件，没有官方扩展点，本插件不采用脆弱的 DOM 注入改它；
- 删除会话时若其仍在 GUI 打开，删除成功后当前视图会切换到新会话；
- 归档集合清理依赖 `@deepseek-ai/dsh-workspace` 原型补丁，若未来 dsh 改动该类内部
  结构，该步骤降级为警告，其它删除步骤不受影响；
- 版本兼容：插件不锁宿主版本，但在 dsh 0.1.x 上开发与测试；依赖官方会话头部操作
  插槽 `conversation.session.header.actions`、`webServer` 路由注册、
  `sessionPersistence` 与既有 `host/*` 广播（官方 web profile 默认具备）。
  Node 运行时要求见 `engines`（`^22.0.0 || >=24.0.0`）。