# JEV 决策模型桥（`@local/decision-model`）

把 OpenRouter 的 **Alpha Decisions** 接口（`perplexity/pplx-decider-v1.2`）接进 DeepSeek Harness：
DSH 在调度子代理时，可以直接（或自动）调用类 JEV 的决策模型，拿回概率化的裁决。

这是一个 **Host + Client bundle**：Host 半负责工具、门禁与网络请求，Client 半在 Web 设置页提供 API Key 管理与连通性检测。没有构建步骤、没有第三方依赖。

---

## 它贡献的三样东西

1. **`decision` 工具** —— 模型可以传 `state` + `questions`，直接向决策模型提问。
   支持三种问题类型：`noul`（是/否概率）、`choice`（多选一）、`score`（按等级打分）。
2. **调度前自动裁决** —— 在 `tools/pre-execute` 里，对调度类工具真正执行前问一次决策模型：
   - `advisory`（默认）：不拦截，把裁决意见追加到调度结果之后，模型能看到；
   - `enforce`：任务清晰度低于阈值、或模型建议 `defer` 时，直接拒绝本次调度并说明原因。
3. **一段系统提示词** —— 告诉模型什么时候该先问决策模型、怎么对待它的概率/等级/置信度。

触发自动裁决的工具（可配置 `gatedTools`）：`subagent`、`subagent_fork`、`subagent_codex`、
`subagent_claude_code`、`spawn_teammate`、`ralph`、`workflow`。

---

## 安装

仓库地址：<https://github.com/awa486-nekorin/dsh-decision-model>

```powershell
git clone https://github.com/awa486-nekorin/dsh-decision-model.git D:\whale\decision-model
```

插件目录即仓库根目录。已安装到 desktop profile；重装或换机时：

```text
plugin_manager({ action: "install_bundle", target: "D:\\whale\\decision-model" })
```

安装成功后验证（不需要重启）：

```text
cordis_inspect_query({ platform: "host", provider: "Tool", method: "listTools" })
```

`decision` 应出现在工具列表里。profile 的 `patchReload: live` 会让配置改动即时生效。修改 **Host 半**（`index.js` / `lib/`）后需要重启 DSH 才会重新加载模块；修改 **Client 半**（`client.js`）后刷新一次 Web 页面。

---

## 设置页（API Key 与连通性检测）

打开 **设置 → 插件 → 决策模型 API**：

- **API Key** 输入框只用于写入，保存成功后立即清空；页面从不读取、回显或记录密钥明文。
- 密钥写入 DSH 的凭据存储（`OPENROUTER_DECISION_API_KEY`），不再写进 `cordis.patch.yml`。
- **测试连接** 可测试尚未保存的草稿 key，也可测试已保存的 key；请求由 Host 发出，响应只返回模型名、耗时与成本，绝不返回 key 或上游响应体。
- **清除已保存密钥** 只删除托管密钥，不修改环境变量或 `.env`；清除前会要求确认。
- 凭据由环境变量提供时，页面会标记为只读并禁用写入按钮。

安全边界：

| 项目 | 做法 |
| --- | --- |
| 密钥存储 | `ctx.credentials`（本地凭据文件，权限仅当前 OS 用户；Host 与 Agent 同用户，故不能隔离 Agent 进程） |
| 浏览器读取密钥 | 不允许。`credentials.describe` 只返回 `configured/source/writable`；自定义状态接口也只返回这些字段 |
| 连通性检测 | 仅 `POST /api/decision-model/test`，由 Host 执行；该路由受 DSH 连接层鉴权，未认证请求返回 401 |
| 请求体边界 | 最大 8 KiB，只接受 `{ apiKey }`；key 最长 4096 字符并校验格式 |
| 频率限制 | 3 秒内最多一次检测，防误触与重复请求 |
| 错误返回 | 映射为固定错误码（`invalid-key` / `timeout` / `network` 等），不包含上游 body、请求头或异常原文 |
| 日志 | 不记录 key；只记录迁移成功/不可用与门禁判定等元信息 |

`apiKey` 配置字段仍保留为**兼容回退**（首次升级时会把旧明文 key 迁移进凭据库），新部署请保持为空。

---

## 配置

全部配置在 `cordis.patch.yml` 的 `config:` 块里（改完保存即热加载；直接改 `apiKey` 配置不用重启）。

| 字段 | 默认值 | 说明 |
| --- | --- | --- |
| `endpoint` | `https://openrouter.ai/api/alpha/decisions` | 决策接口地址 |
| `model` | `perplexity/pplx-decider-v1.2` | 决策模型 |
| `apiKey` | 空 | **已弃用**：仅作旧配置迁移回退；正常请用设置页写入凭据库 |
| `apiKeyEnv` | `OPENROUTER_DECISION_API_KEY` | 凭据库引用名 / 环境变量名；凭据库优先于环境变量 |
| `timeoutMs` | `20000` | `decision` 工具单次请求超时；超时返回错误 |
| `gateTimeoutMs` | `10000` | 自动门禁等待上限；超时按 `onError` 处理，默认 fail-open |
| `toolName` | `decision` | 工具名 |
| `mode` | `advisory` | `off` / `advisory` / `enforce` |
| `threshold` | `0.5` | `enforce` 下「任务清晰度」noul 概率的及格线 |
| `onError` | `allow` | 决策模型不可用时：`allow`（放行）或 `deny`（拒绝，仅 enforce 生效） |
| `promptSection` | `true` | 是否注入系统提示词段 |
| `maxStateChars` | `4000` | 发给决策模型的序列化 state 字符上限，超出截断；门禁会优先截短调用参数并给判断说明留空间 |
| `gatedTools` | 见上 | 触发自动裁决的工具名列表；省略时用默认 7 个，显式 `[]` 表示不门禁任何工具 |

安全建议：不要在任何提交进 Git 的文件里写 key。使用设置页保存到凭据库，或在启动 DSH 前设置环境变量 `OPENROUTER_DECISION_API_KEY`；修改系统环境变量后要重启 DSH。

---

## `decision` 工具

参数：

```jsonc
{
  "state": "待决策内容（字符串 / 对象 / 数组）",
  "questions": {
    "clarity": { "type": "noul", "instructions": "任务是否足够清晰？" },
    "route": {
      "type": "choice",
      "instructions": "应该怎么推进？",
      "criteria": { "direct": "直接做", "split": "先拆分", "defer": "暂缓" }
    },
    "quality": {
      "type": "score",
      "instructions": "当前方案的质量等级？",
      "criteria": ["很差", "一般", "很好"]
    }
  },
  "model": "可选：临时覆盖模型"
}
```

返回（已归一化）：

```jsonc
{
  "ok": true,
  "model": "perplexity/pplx-decider-v1.2-20261016",
  "provider": "Perplexity",
  "request_id": "gen-dec-...",
  "usage": { "input_tokens": 256, "output_tokens": 3, "cost": 0.00000512 },
  "answers": {
    "clarity": { "type": "noul", "probability": 0.506, "confidence": null },
    "route": { "type": "choice", "choice": "direct", "probabilities": { "direct": 0.601, "split": 0.239, "defer": 0.16 }, "confidence": 0.401 },
    "quality": { "type": "score", "score": 1.0, "scale": 2, "levelIndex": 1, "levelLabel": "一般", "probabilities": { "0": 0.33, "1": 0.34, "2": 0.33 }, "confidence": 0.347 }
  },
  "summary": "决策模型 ... 的裁决：\n- clarity（是/否）：P(是)=50.6%\n..."
}
```

要点（实测，2026-10，80+ 次真实请求）：

- `noul` 的 `noul` 就是 **P(命题为真)**，开区间约 (0.001, 0.999)，没有 `confidence`/`probabilities`。
- `choice` 的 `choice` 是概率最高的选项名，`probabilities` 是各选项概率（和恒为 1），`confidence = (maxP − 1/n) / (1 − 1/n)`。
- `score` 的 `score` 是**级别下标的期望值** `Σ i·p_i`，域 `[0, n−1]`（3 级时是 0~2，别当 0~1 用）；
  `legend` 会回显 `criteria` 原文，`levelLabel` 由它推出；`confidence` 是**期望下标偏离中点的绝对值**，
  只表示「立场有多极端」，方向只能看 `score` 本身。
- 同一输入完全确定性（6 次重复逐位一致），所以重复的调度判断可以放心用缓存/复用。
- 单次调用成本约 `$0.0000016 ~ $0.000003`（短 state；输入 token × $0.02/1M）；门禁会把本次调度参数一起发过去
  （截断到 `maxStateChars`），带长 prompt 时实测一次约 `$0.000029`。延迟常规 550~750ms，偶发 1.5~2s。
- 接口 schema 里还有第 4 种 `type: "box"`，Perplexity 会直接 400，本插件只开放 `noul` / `choice` / `score`。
- 对 `choice`，confidence 低表示概率接近均匀；对 `score`，confidence 低表示期望分数靠近中点；`noul` 没有 confidence，要直接看 P(true)。

---

## 自动裁决的行为

```
subagent / spawn_teammate / workflow ...
        │
        ▼
tools/pre-execute          ← 其他插件先跑（next()），全部 allow 才轮到本插件
        │  state   = 工具名 + 本次调用参数（参数优先截短，整个序列化 state 最终不超过 maxStateChars）
        │  questions = clarity(noul) + dispatch(choice: dispatch/split/defer)
        ▼
OpenRouter decisions
        │
        ├─ advisory：记录意见 → 工具照常执行 → tools/post-execute 把意见追加到结果文本
        └─ enforce ：clarity < threshold 或 dispatch == "defer" → {kind:"deny", reason}
```

- 上游插件如果已经 `deny`，本插件只调用 `next()`，不额外花钱。
- `mode: "off"` 时完全不介入调度（只保留工具与提示词）；`gatedTools: []` 只关闭自动门禁，不影响 `decision` 工具。
- `advisory` 永不拦截；若清晰度低于 `threshold` 或模型建议 `defer`，会在追加意见里显示「风险提示」。
- 自动门禁最多等待 `gateTimeoutMs`（默认 10 秒），与 `decision` 工具的 `timeoutMs` 分开配置。
- `onError: "allow"` 是默认的 fail-open：API 超时/报错不阻塞正常调度；`enforce + onError: "deny"` 才会在 API 不可用时拒绝。
- 如果其它 `post-execute` 插件把结果改成结构化 `value`（而不是 `content`），当前结果类型无法同时保留 value 并追加意见；本插件会保留 value，并写 warn 日志。
- 裁决意见示例（追加在被调度工具结果之后）：

```text
[decision-model] 调度「subagent」前咨询了决策模型：
决策模型 perplexity/pplx-decider-v1.2-20261016 的裁决：
- clarity（是/否）：P(是)=91.0%
- dispatch（选择）：dispatch（dispatch 80.0% / split 15.0% / defer 5.0%），置信度 0.400
路线建议：直接调度
判定：可以继续本次调度。
```

---

## 验证

离线测试（35 个用例，不联网）：

```powershell
cd D:\whale\decision-model
node --test test/decider.test.js test/index.test.js test/settings.test.js test/client.test.js
# 期望 tests 35 / pass 35 / fail 0
```

其中 `settings.test.js` 覆盖：密钥不随状态返回、连通性检测不带 key 材料、临时草稿 key 不落盘、上游错误脱敏、频率限制、路由鉴权注册、凭据优先级与旧配置迁移。`client.test.js` 验证 Client 半注册到 `settings.plugins.tab` 且注入形状正确。

真实接口冒烟（不打印 key）：

```powershell
$env:DECISION_MODEL_KEY = '<你的 key>'
# 或使用运行时默认变量名：$env:OPENROUTER_DECISION_API_KEY
node scripts/live-smoke.mjs
```

装好之后的运行期验证：

1. `cordis_inspect_query` → `Tool.listTools` 里出现 `decision`；
2. 直接调用一次 `decision` 工具（见上）；
3. 打开 Web 设置 → 插件 → 决策模型 API，确认状态显示「已配置」，并点一次「测试连接」；
4. 触发一次 `subagent` / `spawn_teammate`，检查结果文本尾部是否带 `[decision-model]` 意见；
5. 想看拦截效果：把 `mode` 改成 `enforce`，故意给一个信息不足的调度任务。

本次实际验证结果（2026-10-27，desktop profile）：

- `settings.plugins.tab` 中 `decision-model` tab 已注册且 active；
- 已认证 `GET /api/decision-model/status` → 200，`configured: true, source: "stored", writable: true`；
- 已认证 `POST /api/decision-model/test` → 200，模型 `perplexity/pplx-decider-v1.2-20261016`，延迟 2670ms，成本 `$0.00000192`，响应不含 key；
- 未认证访问同一路由 → 401。

## 排错

- **工具没出现**：看 DSH 日志里 `[decision-model]` 行；若 `Config` 校验失败，行会被 loader 拒绝并报 `invalid config: $.<field>`。
- **`no-api-key`**：设置页尚未保存 key，且凭据库/`apiKeyEnv`/`apiKey` 都没有值。
- **`timeout`**：`decision` 工具请求调大 `timeoutMs`；自动门禁调大 `gateTimeoutMs`。advisory 模式超时会按 `onError` 处理，默认自动放行。
- **被反复拦截**（enforce）：调低 `threshold` 或改回 `advisory`；拦截原因会写在工具错误里。
- **不想让某类调度触发**：从 `gatedTools` 里删掉对应工具名。

## 文件结构

```
decision-model/
├── index.js              # Cordis Host 插件：工具 / 调度前裁决 / 系统提示词 / Config / 设置接口
├── client.js             # Web Client 半：设置页（key 管理 + 连通性检测）
├── lib/decider.js        # 决策 API 客户端 + 归一化（无 Cordis 依赖，可离线测试）
├── lib/settings.js       # 凭据解析、旧 key 迁移、Host 鉴权路由与安全限流
├── lib/schemastery.js    # 从宿主树加载 schemastery（拿不到就降级为无 Config）
├── cordis.patch.yml      # 安装行与全部配置（不含明文 key）
├── locale/{en,zh}.json   # 插件管理器里的标题与描述
├── icon.svg              # 插件图标
├── test/                 # 离线单元 + 集成 + Client 注册 + 安全测试
├── scripts/live-smoke.mjs  # 真实接口冒烟
├── research/               # API 黑盒探测与 Host 契约取证
└── verify/report.md        # 独立端到端验证报告
```
