# Accessibility Review — Node Identity Workbench

无障碍审阅工作台。对问题做「忽略」等审阅标记后，页面可能发生兄弟节点插入、节点移动、
文本改写、重复组件渲染、节点删除或跨 iframe 重排。系统用**稳定属性 + 结构指纹 + 邻域
信息**建立跨快照的节点身份，并在新快照中做带置信度的有界匹配：只有唯一且高置信的
一对一匹配才自动迁移审阅结果；低置信 / 一对多 / 候选空间被截断 / 帧未对齐时进入
**待确认**状态，由用户显式确认后保存映射。

## 运行

```bash
npm install
npm run dev      # tsx server (4174) + vite (4173, /api 代理)
npm test         # vitest，匹配器六场景 + API 端到端 + 复杂度上界
npm run build    # tsc --noEmit + vite build
```

## 核心问题：下标路径不是身份

旧实现前后端都用「子节点下标路径」指向问题节点。路径在重排后**仍然存在却指向了另一个
节点**（在第 3 个链接前插入新链接后，路径仍解析成功，但已是错误元素）。本实现中路径
只用于展示（`SnapNode.path` / `NodeView.pathText`），**从不参与身份判定**。

## 身份信号（`src/shared/identity.ts`）

每个节点计算三层身份信号：

1. **稳定属性** `id`、`data-testid`、`data-qa`、`data-node-id`、`name`、`for`、
   单一目标的 `aria-labelledby/describedby/owns/controls` 等显式锚点（过滤
   `css-*` / `:r1:` 等运行时生成 id）。
2. **结构指纹** 标签、隐式/显式 role、可访问名称（aria-label / alt / placeholder /
   自身文本）、规范化文本、非稳定属性签名、直接子节点多重集签名、子树 Merkle
   `structHash`（localSig + 子节点 hash）、子树规模。
3. **邻域信息** 父节点对、最多 3 个前驱兄弟（见匹配器松弛轮）。

iframe 内容**不**进入宿主节点的 Merkle hash；帧用「内容派生、位置无关」的 id
（如 `top/name_settings-frame`）单独对齐，并按 owner 帧 BFS 递归构建。

## 匹配（`src/shared/matcher.ts`）

- 桶索引：稳定键哈希表 + 精确文本哈希表 + 粗桶（tag/role/直接子数/深度/子树规模
  量级带）。**绝不做所有节点两两比较**。
- 每个旧节点只对至多 `CANDIDATE_CAP = 12` 个候选打分；超大同质（孪生）桶取
  确定性小样本并标记候选截断。
- 打分：内在属性轮（稳定键/role/tag/名称/文本/属性/子节点/结构）+ 最多 3 轮邻域
  松弛（父节点匹配 +0.10、父标签 +0.03、前驱兄弟命中 +0.08）。
- 裁决：贪心全局一对一分配；自动迁移要求 **唯一归属 + 总分 ≥ 阈值 + 与次优有间隔
  （或有强文本锚点分离）+ 候选空间未被截断（除非有稳定键）**。
- 否则进入 `pending_ambiguous` / `pending_low_confidence` /
  `pending_candidate_truncated` / `pending_frame_unresolved`；最佳分低于删除线为
  `deleted`。待确认/删除**都不会**自动迁移审阅结果。

**复杂度上界**：打分边数 `scoredEdges ≤ 12 · N`，在 `ReconcileStats` 中返回并断言；
索引与内存均为 O(N)。9000 节点、批量前插的基准对账约 0.5 秒完成（见
`test/matcher.test.ts`）。

## 审阅结果与显式映射（`src/server/store.ts`）

- 忽略一个问题 = 创建 finding，并写入一条快照内自确认 `MappingRow`（身份锚点）。
- 新快照对账时：自动匹配 → 追加 `decision: 'auto'` 映射并把 finding 迁移为
  `carried`；其余 → `pending`，携带候选与置信度，绝不猜测。
- 前端展示旧节点 vs 候选新节点的差异（`src/shared/diff.ts`：属性增删 + 带界 LCS
  文本差异），用户选择候选后 `POST /decide` 写入 `decision: 'confirmed'` 显式映射；
  选择「已删除」写入 `decision: 'rejected'`（newNode 为 null），finding 置 dropped。
- `POST /prune` 删除旧快照树，但 **`MappingRow` 永不清理**：其中的旧/新 `NodeView`
  是去规范化的，构成快照清理后仍保留的身份审计轨迹（`GET /api/audits/:id/mappings`）。

## 覆盖场景

| 场景 | 期望行为 |
| --- | --- |
| 兄弟插入 | 下标路径移位，稳定键+邻域自动跟随 |
| 节点移动 | 离开原父节点，靠稳定键/名称+结构自动匹配；无稳定键且不唯一则待确认 |
| 文本变化 | 字符 bigram + 词序 LCS 混合相似度，配合文本锚点间隔区分孪生项 |
| 重复组件 | 完全相同的孪生卡片 → 一对多，强制待确认 |
| 节点删除 | 无候选 → 待确认/删除线，不静默丢弃，用户显式拒绝才 dropped |
| 跨 iframe | 内容派生帧 id + owner 节点对齐；帧无法对齐时整帧 pending_frame_unresolved |

## 前端

- `src/client/scanner.ts`：从真实 DOM（含同源 iframe 递归）捕获 RawNode；跨域 frame
  只记录 owner、不臆造内容。
- `src/client/demo.ts`：六种重排变换；预览在沙箱 iframe 内，对账输入来自对预览 DOM
  的实际重扫（而非直接信任变换结果）。
- 主面板：问题忽略、待确认映射的候选选择 + 差异视图 + 确认/拒绝、复杂度统计、
  映射审计时间线。

## API

- `POST /api/audits/:id/snapshots` 建立基线快照
- `POST /api/audits/:id/findings` 创建忽略标记
- `POST /api/audits/:id/reconcile` 提交新 DOM 树并对账（返回匹配、统计、状态）
- `POST /api/audits/:id/decide` 显式确认候选 / 拒绝（删除）
- `POST /api/audits/:id/prune` 清理旧快照树（保留映射审计）
- `GET  /api/audits/:id/mappings` 映射审计日志
