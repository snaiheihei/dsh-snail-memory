# Snail Memory

DeepSeek Harness（dsh）插件：单用户、**全局 / workspace 分层**的记忆。在 Web 面板里查看、控制记忆条目，调整对话记忆的整理与整合；启用后索引常驻上下文、详情按需加载，每个对话手动选择要加载的记忆层。

> Layered single-user global and workspace memory for DeepSeek Harness, with a web panel to browse entries and tune distillation and consolidation, an index kept in context with records loaded on demand, and a per-session choice of layer.

- npm 包名：`dsh-snail-memory`
- 源码：<https://github.com/snaiheihei/dsh-snail-memory>
- 兼容：dsh `>=0.2.1-rc.3 <0.3.0-0`，Node `>=22.19.0`
- 协议：MIT

## 功能

- **两级记忆**：`global`（跨工作区）与 `workspace`（绑定单个工作区）相互独立，各自有 revision。
- **显式开关**：记忆不会自动进入上下文。每个 Session 里手动启用某一层，用 `refresh` 生成新快照，`disable` 关闭。
- **只追加注入**：快照通过 `agent.inject()` 作为一条 `user` 消息追加（`source.kind = "snail-memory"`），插件从不改写、替换或删除既有会话消息。
- **可对账的注入**：每次注入带稳定 `injectionId`，区分 `desired → queued → committed`；只有观察到会话里真正落盘的 `user/message` 才算 committed，重启后按会话日志对账，不会重复注入。
- **生命周期维护**：统计完成的真实用户轮次，按空闲时间蒸馏记忆，分别调度 workspace 与 global 的 consolidation，并按分类执行 retention 清理。会话活动只推进内存中的空闲期限，最近一次 transcript 不可用的 Session 会退避重试并在有限次数后放弃。
- **模型工具**：`snail_memory_read`（按 id 读取，大对象先返回分片清单）、`snail_memory_feedback`（对已 committed 快照里的记忆打 helpful / unhelpful / incorrect）。
- **斜杠命令**：`/memory status`、`/memory remember workspace <text>`、`/memory correct workspace <id> <text>`、`/memory forget workspace <id>`。
- **Web UI**：输入框左侧记忆按钮，侧栏 `Memory` 面板（全局 / 工作区 / 设置三个标签），可查看条目、引用、最近一次已提交快照与 token 估算。
- **单写者**：同一数据根目录下允许多个 Host 启动，但只有一个持有写锁，其余自动只读；锁有心跳与 stale 回收，写操作带 fencing 校验。

## 安装

任选一种，然后重启 Host 并刷新页面。

```powershell
# 1) 从 npm 安装
dsh plugin --profile web add dsh-snail-memory

# 2) 从 tarball 安装
dsh plugin --profile web add .\dsh-snail-memory-0.1.0.tgz

# 3) 从解压后的目录安装
dsh plugin --profile web add .\dsh-snail-memory

# 4) 从 Git 安装（需要该 tag/commit 带上构建产物）
dsh plugin --profile web add github:snaiheihei/dsh-snail-memory#v0.1.0
```

装完先确认组合层生效，再启动：

```powershell
dsh --profile web --dump-config   # 应出现 "# == dsh-snail-memory"
```

卸载：`dsh plugin --profile web remove dsh-snail-memory`。

## 使用

1. 打开一个 Session，点击输入框左侧的记忆按钮，选择 **global** 或 **workspace** 启用。
2. 启用后当前记忆索引会作为一条快照注入；之后对话中可随时 `refresh` 生成新快照。
3. 侧栏 `Memory` 面板可浏览条目、查看详情、删除、promote 到 global，以及调整全局设置。
4. 需要沉淀新记忆时用 `/memory remember workspace <text>`，或让模型在对话中写入；读取与反馈由两个工具完成。

快照里的 token 数字是**估算值**，用于控制上下文预算，不代表 provider 的精确 usage。

## 配置

配置写在 profile 的 `cordis.patch.yml` 中，按行 id `snail-memory` 覆盖。**patch 会整体替换该行的 `config`**，所以需要把想保留的键一起写全：

```yaml
- id: snail-memory
  config:
    provider: deepseek
    model: deepseek-chat
    reviewEveryUserTurns: 15
    idleDelayMinutes: 60
    consolidationCooldownHours: 20
    globalConsolidationCooldownDays: 7
    retentionSweepHours: 24
```

| 键 | 默认值 | 说明 |
| --- | --- | --- |
| `dshHome` | 宿主解析值 | 数据根目录；默认跟随 `DSH_HOME` |
| `provider` / `model` | 未设置 | 辅助模型路由。留空时从当前 agent 列表中选择可用模型 |
| `reviewEveryUserTurns` | `15` | 每累计多少个完成的用户轮次触发一次记忆蒸馏 |
| `idleDelayMinutes` | `60` | 会话空闲多久后触发蒸馏 |
| `consolidationCooldownHours` | `20` | workspace consolidation 冷却时间；一次 dirty 窗口只在首次需要排期时定时，后续写入不再推迟 |
| `globalConsolidationCooldownDays` | `7` | global consolidation 冷却时间，语义同上 |
| `retentionSweepHours` | `24` | retention 清理的间隔 |

## 数据位置

默认在 `$DSH_HOME/snail_memory/`（设置了 `config.dshHome` 时随之变化）：

```text
snail_memory/
├── state.v2.json          # 唯一权威状态（原子发布）
├── details/               # 可重建的 Markdown 投影
├── detail-data/           # 详情记录（按 revision）
├── global/
├── workspaces/
├── settings.v1.json
├── audit.v1.jsonl         # 只记 operation / revision / 时间
├── projection-pending.v1.json
└── lock.json              # 单写者锁（心跳 + fencing）
```

Markdown 投影可以从 `state.v2.json` 重建，两者不是双事实源。审计日志只记录操作元数据，不记录提示词、记忆正文或路径。

## 隐私与安全

- 记忆数据只落在本地 `$DSH_HOME` 下，不采集遥测、不上传到第三方。
- 蒸馏/合并需要调用模型时，走宿主注入的 `ctx.llm`，即你自己配置的 provider 与凭据；插件不自行发起网络请求。
- 写入与蒸馏前会做秘密扫描与长度限制，模型输出一律按不可信数据处理。
- 插件的 RPC 挂在宿主 `webServer` 的同源路由上（`/snail-memory/rpc/*`）。**请勿把 dsh Web 服务绑定到不受信任的网络**（`--host` 默认只监听本机）。

## 开发

```powershell
npm install
npm run build       # tsc + esbuild，产出 dist/ 与 dist/client.js
npm run typecheck
npm test            # vitest
npm run lint
npm pack            # prepack 会自动构建
```

目录：

```text
src/index.ts          # Cordis 入口：inject / Config / apply
src/contract.ts       # Host ↔ Client RPC 类型
src/api/              # 同源路由、命令、校验
src/context/          # 快照生成、注入对账、工具
src/lifecycle/        # 轮次统计、蒸馏、consolidation、retention、调度
src/store/            # 权威状态、写队列、锁、投影
client/src/           # slots、面板、locale、RPC 客户端
scripts/              # 构建脚本（Client handoff）
tests/                # 单元 / 集成 / 客户端测试
```

Client 侧通过 `window.__ModuleLoader__.load({ id, factory })` 的 CJS closure-factory 装载，`react` / `react/jsx-runtime` 由宿主平台表提供，不打第二份 React。

## License

[MIT](LICENSE) © 2026 snaiheihei
