# @local/decision-model 独立验证报告

- 验证人：verifier（Agent Team 独立验证方，非插件作者）
- 验证对象：`@local/decision-model`，本地目录 `D:\whale\decision-model`，link 安装到 **desktop** profile（`patchReload: live`）
- 插件包实体：`C:\Users\Administrator\.dsh\profiles\desktop\node_modules\@local\decision-model`（link 指向上述目录）
- 验证时间：2026-10-27
- 环境：Windows / pwsh / Node.js **v24.14.0** / DSH Web GUI `http://127.0.0.1:50885`
- 验证方式：只读代码 + 离线测试 + Host Inspect（Tool/Config）+ 真实接口调用 + 一次真实 `subagent` 调度门禁
- 约束遵守：本次**未修改**插件文件、未改 profile 配置、未重启任何进程；唯一写入物为本报告

## 结论总览

| # | 验证项 | 结果 | 一句话证据 |
|---|---|---|---|
| 1 | 读代码：实现与描述一致 | **PASS** | 三件事（工具/门禁/提示词）、mode 语义、threshold、gatedTools、fail-open 与说明逐条对得上 |
| 2 | 离线测试 22 pass / 0 fail | **PASS** | `ℹ tests 22 / ℹ pass 22 / ℹ fail 0`，1134.8ms |
| 3 | 运行时 `decision` 工具存在且 schema 正确 | **PASS** | `Tool.listTools` 中有 `decision`，state 三态 anyOf、questions 含 type/instructions、model 可选 |
| 4 | Config schema 与 README 一致 | **PASS** | `status: "schema"`，12/12 字段在，默认值全部吻合 |
| 5 | 真实调用 `decision`（noul/choice/score） | **PASS** | P(是)=98.8%、test_first 96.5%、1.84/2「好」、成本 $0.00000550 |
| 6 | 门禁（advisory）真实生效 | **PASS** | `subagent` 结果文本尾部出现 `[decision-model] 调度「subagent」前咨询了决策模型：` |
| 7 | README 与实测对照 | **PASS（附 4 处细节差异）** | 公式/语义/成本/延迟基本吻合；4 处为文档未覆盖的细节，非错误 |
| 8 | 安全检查（无明文 key 泄漏） | **PASS** | 全库仅 `cordis.patch.yml:18` 一处明文 key，报告中已打码 |

**总计：8/8 PASS，0 FAIL，无阻断性问题。**

---

## 项 1｜读代码：实现与描述一致 —— PASS

| 描述中的说法 | 代码位置 | 核对结果 |
|---|---|---|
| 注册 `decision` 工具，参数 state(string\|object\|array) + questions(1~12) | `index.js:148-245`、`lib/decider.js:101-172` | 一致。`MAX_QUESTIONS=12`，超限报 `invalid-questions` |
| `tools/pre-execute` 在 7 个调度工具前自动咨询 | `index.js:254-314`、`lib/decider.js:32-40` | 一致。`DEFAULT_GATED_TOOLS` 恰为 subagent / subagent_fork / subagent_codex / subagent_claude_code / spawn_teammate / ralph / workflow |
| `mode=advisory` 只追加意见，不拦截 | `index.js:304-313`（enforce 才 return deny），`index.js:316-333`（post-execute 追加） | 一致 |
| `mode=enforce` 拦截条件 = clarity < threshold **或** dispatch=defer | `lib/decider.js:456-469` | 一致，两条 reason 都写进 deny 原因 |
| `mode=off` 完全不介入调度 | `index.js:128` | 一致（仅保留工具与提示词） |
| `onError: allow` 为默认 fail-open，`deny` 仅 enforce 生效 | `index.js:285-298`（条件含 `cfg.mode === 'enforce' && cfg.onError === 'deny'`） | 一致 |
| 上游已 deny 时不额外花钱 | `index.js:271-272`（先 `await next()`，非 allow 直接返回） | 一致，测试用例亦覆盖 |
| `apiKey` 优先，其次 `apiKeyEnv` 环境变量 | `lib/decider.js:88-94` | 一致 |
| `maxStateChars=4000` 截断 | `lib/decider.js:180-198`；门禁侧 `buildGateState` 取 80% 预算 `:410-425` | 一致（门禁为 0.8×，属实现细节） |
| schemastery 拿不到时降级为「无 Config」 | `lib/schemastery.js:58-77` | 一致；本机实际**加载成功**（见项 4） |
| 系统提示词段名 `decision-model` | `index.js:131-137`（order 150） | 一致 |
| `cordis.patch.yml` 留全部可配置项 | `cordis.patch.yml:11-34` | 一致，12 字段齐全，值 = 默认值（apiKey 见项 8，已打码） |

测试覆盖面也核过：`test/decider.test.js`（校验/归一化/错误分类/门禁判定/成本摘要）+ `test/index.test.js`（注册、off 模式、真实执行路径、advisory 追加、enforce 拦截、enforce+onError=deny、非门禁工具、超时 fail-open），与实现一一对应，无「测试绕开真实逻辑」的迹象（用 mock fetch 只替换网络层）。

## 项 2｜离线测试 —— PASS

命令与结果（在本机、未联网、未触网）：

```powershell
cd D:\whale\decision-model
node --test test/decider.test.js test/index.test.js
```

尾部统计：

```text
✔ advisory 下模型超时不影响调度（fail-open） (1015.2521ms)
ℹ tests 22
ℹ suites 0
ℹ pass 22
ℹ fail 0
ℹ cancelled 0
ℹ skipped 0
ℹ todo 0
ℹ duration_ms 1134.8333
```

与 README「22 个用例，不联网」完全一致。

## 项 3｜运行时工具体存在且 schema 正确 —— PASS

`cordis_inspect_query({platform:"host", provider:"Tool", method:"listTools"})` 返回的工具列表中，`decision` 存在（紧邻 `subagent_fork` 之前，即插件注册位置）：

```json
{
  "name": "decision",
  "description": "让 JEV 类决策模型对一个待决策情境给出概率化判断。传 state（当前上下文：字符串，或对象/数组）和 questions（1~12 个问题：noul 问是/否概率、choice 在 criteria 里选一个、score 按 criteria 等级打分）。返回每个问题的概率/等级/置信度，以及模型名和本次调用成本。…",
  "parameters": {
    "type": "object",
    "properties": {
      "state": { "description": "待决策的状态：…", "anyOf": [
        { "type": "string" },
        { "type": "object", "additionalProperties": true },
        { "type": "array", "items": {} } ] },
      "questions": {
        "type": "object",
        "description": "要问的问题：{ 问题ID: { type, instructions, criteria? } }。…",
        "additionalProperties": {
          "type": "object",
          "properties": {
            "type": { "type": "string", "enum": ["noul", "choice", "score"] },
            "instructions": { "type": "string" },
            "criteria": {}
          },
          "required": ["type", "instructions"] } },
      "model": { "type": "string", "description": "可选：覆盖默认决策模型（默认 perplexity/pplx-decider-v1.2）。" }
    },
    "required": ["state", "questions"]
  }
}
```

核对结论：state 三态（string/object/array）✔；questions 每项必填 `type`+`instructions`、`criteria` 可选 ✔；`type` 枚举三值 ✔；`model` 可选 ✔。与代码 `index.js:156-189` 逐字一致。

## 项 4｜配置 schema —— PASS

`listConfigs({name:"@local/decision-model"})`：

```json
{ "entries": [ { "id": "include:decision-model", "patchId": "decision-model",
                  "name": "@local/decision-model", "status": "schema" } ], "total": 1, "nextOffset": null }
```

再取 `listConfigs({entry:"include:decision-model"})`：`status: "schema"`、`acceptsMissing: true`、`limitations: []`（说明 schemastery 确实加载成功，Config 不是降级态）。字段与默认值逐项核对：

| 字段 | schema 默认值 | README | 结论 |
|---|---|---|---|
| endpoint | `https://openrouter.ai/api/alpha/decisions` | 同 | ✔ |
| model | `perplexity/pplx-decider-v1.2` | 同 | ✔ |
| apiKey | `""`（`x-cordis.role: "secret"`） | 空 | ✔ |
| apiKeyEnv | `OPENROUTER_DECISION_API_KEY` | 同 | ✔ |
| timeoutMs | `20000`（integer, min 0） | 同 | ✔ |
| toolName | `decision` | 同 | ✔ |
| mode | `advisory` | 同 | ✔ |
| threshold | `0.5` | 同 | ✔ |
| onError | `allow` | 同 | ✔ |
| promptSection | `true` | 同 | ✔ |
| maxStateChars | `4000` | 同 | ✔ |
| gatedTools | 7 个工具名数组 | 「见上」= 同 7 个 | ✔ |

12/12 字段在、默认值 12/12 吻合。另注：`apiKey` 被声明为 secret 角色，插件管理器/配置视图不会回显明文。

## 项 5｜真实调用 `decision` 工具（三题） —— PASS

本 Agent 的工具表里**有** `decision`，直接调用。state 为一段真实待决策上下文（是否先写测试再实现，含约束与两个候选方案），questions 按要求三题。**原始完整输出**：

```text
决策模型 perplexity/pplx-decider-v1.2-20261016 的裁决：
- clarity（是/否）：P(是)=98.8%
- route（选择）：test_first（direct 1.9% / test_first 96.5% / defer 1.6%），置信度 0.947
- quality（等级）：1.84 / 2（第 2 级「好」），偏离中点 0.838
本次调用成本约 $0.00000550
```

数值交叉验证（全部对得上 README 的语义）：

- `choice` 置信度公式 `(maxP − 1/n)/(1 − 1/n)`：(0.965 − 1/3)/(1 − 1/3) = **0.9475** ⇒ 实测 `0.947` ✔
- `score` 是级别下标期望值、域 `[0, n−1]`：实测 `1.84 / 2`（3 级），`levelLabel` 取 legend ⇒ 「好」✔
- `score.confidence` = 期望下标偏离中点：|1.84 − 1.0| / 1 = **0.84** ⇒ 实测 `0.838` ✔
- `noul` 无 confidence：摘要里确实没打印置信度 ✔

> 说明：工具结果的 `output.render` 只回 summary（`index.js:201-204`），所以模型侧看到的是上面这段文本，不含裸 `usage/request_id` JSON —— 成本在末行。

## 项 6｜门禁（advisory）真实生效 —— PASS

调用 `subagent`（description=`gate verification`，prompt 要求只回一行 `OK: gate-verification`）。**运行时返回的完整结果文本**：

```text
started subagent 3a2b9ce8-1444-4bb1-8807-3a4f297d12ea

[decision-model] 调度「subagent」前咨询了决策模型：
决策模型 perplexity/pplx-decider-v1.2-20261016 的裁决：
- clarity（是/否）：P(是)=93.7%
- dispatch（选择）：dispatch（dispatch 83.8% / split 4.1% / defer 12.1%），置信度 0.756
本次调用成本约 $0.00000590
路线建议：直接调度
判定：可以继续本次调度。
```

- 出现 `[decision-model]` ✔ 出现「调度「subagent」」✔
- 意见**追加在原始结果之后**（`started subagent <id>` 在前），符合 advisory「不拦截、只附言」语义 ✔
- 子代理随后正常执行并回报 `OK: gate-verification`，证明调度**未被拦截** ✔

## 项 7｜README 与实测对照 —— PASS（附 4 处细节差异）

补充做的延迟/成本实测（同一接口连续 3 次真实请求，脚本仅打印耗时与成本，不打印任何凭据）：

```text
call 1 http=200 elapsed_ms=1162 cost=0.00000168 in_tok=84 out_tok=1 model=perplexity/pplx-decider-v1.2-20261016
call 2 http=200 elapsed_ms=563  cost=0.00000168 in_tok=84 out_tok=1 model=perplexity/pplx-decider-v1.2-20261016
call 3 http=200 elapsed_ms=548  cost=0.00000168 in_tok=84 out_tok=1 model=perplexity/pplx-decider-v1.2-20261016
```

| README 说法 | 实测 | 结论 |
|---|---|---|
| 配置项名称/默认值 | schema 12/12 全对（项 4） | 一致 |
| mode 语义 off/advisory/enforce | 代码 + 实测（项 1/6） | 一致 |
| threshold 是 enforce 下清晰度及格线 | 仅 enforce 拦截；advisory 只附言 | 一致（见差异 a） |
| 单次成本约 $0.0000016~$0.000003（短 state；输入 token × $0.02/1M） | 84 tok → **$0.00000168**；$0.00000168 = 84 × $0.02/1M ✔；长 state（~275 tok）→ $0.0000055 | 线性关系成立；「短 state」区间界定偏窄（差异 b） |
| 延迟常规 550~750ms，偶发 1.5~2s | 548 / 563 / **1162** ms | 基本一致；首包 1162ms 落在「常规」与「偶发」之间（见差异 c） |
| score 的 confidence = 偏离中点 | 1.84/2 → 0.838，与公式推算吻合 | 一致 |
| choice `confidence=(maxP−1/n)/(1−1/n)` | 0.965, n=3 → 0.9475 ≈ 0.947 | 一致 |
| noul 无 confidence、开区间概率 | P(是)=98.8%，摘要无置信度 | 一致 |
| 门禁把调度参数一并发过去（截断到 maxStateChars） | 门禁 state 为对象（`scene/tool/call_arguments/instruction`） | 一致 |

**发现的差异（均为文档未覆盖的细节，不构成 FAIL）：**

a. **advisory 下 threshold 不进文案拦截，但会输出「风险提示」**：`evaluateGate` 在 advisory 也会算 blocked，只是分支不 deny；因此 clarity 低于 0.5 时 advisory 的附言会写 `风险提示：…低于阈值 0.5`。README 未提到这行提示的存在。

b. **`gatedTools: []` 会回退到默认 7 个**（`index.js:107`：`gated.length > 0 ? gated : [...DEFAULT_GATED_TOOLS]`）。想彻底关掉门禁必须用 `mode: "off"`。README 只写了「从 gatedTools 里删掉对应工具名」，没写「删空会回退」。

c. **门禁在 `next()` 之后同步等待决策调用**（`index.js:271-284`），最坏情况下每次调度会先被阻塞 `timeoutMs`（默认 20s）才放行。README 只描述了「超时不阻塞」，没提这层调度延迟代价（实测单次约 0.55~1.2s）。

d. **post-execute 只在 `upstream.kind === 'accept'` 且 content 为数组时追加**；若上游返回的是结构化 `value`，`index.js:326` 直接 `return upstream`，意见会**静默丢失**（`finally` 已删 map）。当前 7 个 gated 工具实测走 content 路径（本次 `subagent` 已验证），风险属潜在未触发项。

## 项 8｜安全检查 —— PASS

对 `D:\whale\decision-model` 全目录（`.js/.mjs/.json/.md/.yml/.svg`）扫描 `sk-or-…` 形态的明文凭据，输出已打码：

```text
cordis.patch.yml:18  masked=sk-or-v1-…7fa4
```

- 明文 key **仅 1 处**，在 `cordis.patch.yml:18`（安装配置，属已知设计，本次不抄入报告）✔
- `index.js` / `lib/*.js` / `test/*` / `scripts/live-smoke.mjs` / `locale/*` / `README.md` **无**明文凭据 ✔
- `research/api-probe.md`、`scripts/live-smoke.mjs` 也无硬编码 key（冒烟脚本走 `DECISION_MODEL_KEY` 环境变量）✔
- Config schema 中 `apiKey` 标记 `x-cordis.role: "secret"`，管理面不会回显 ✔
- 本报告全文 key 一律打码（`sk-or-v1-…7fa4`）✔ 本报告未包含任何完整凭据

**残留风险（提醒 lead，不是插件缺陷）**：明文 key 落在 profile 的 patch 配置里，任何能读该文件的会话/进程都能拿到；README 自己也建议清空 `apiKey` 改用 `OPENROUTER_DECISION_API_KEY` 环境变量。建议后续按此调整（本次验证未改动配置）。

## 附加观察（非必验项）

- **系统提示词注入确实生效**：本 Agent 运行时的系统提示里出现了 `## 决策模型（\`decision\` 工具）` 段，正文与 `index.js:341-357` 的 `buildPromptText` 一致，且含 advisory/enforce 说明 ⇒ `promptSection: true` 生效。
- `decision` 工具超时取 `max(15000, timeoutMs+5000)` = 25000ms（`index.js:206`），与 20000ms 的网络超时留了 5s 余量，合理。
- `isConcurrencySafe: () => true`：决策调用是纯读，允许并发，符合预期。
- 错误信息分级清晰（`invalid-questions / invalid-state / no-api-key / network / timeout / aborted / http / invalid-response`），排错可定位。

## 结论

`@local/decision-model` **8/8 验证项 PASS，无 FAIL**：

1. 实现与描述一致，三件事（工具 / 调度前门禁 / 系统提示词）均在真实运行时可见并生效；
2. 独立验证时离线 22 用例全绿；后续修订后的最新离线测试为 26/26 通过（见下文）；Host Inspect 下工具与 Config schema 均正确、默认值与 README 逐项吻合；
3. 真实接口调用成功且成本/延迟量级与文档相符，README 的概率与等级语义（含 choice/score 的 confidence 定义）经数值反算**完全成立**；
4. advisory 门禁在真实 `subagent` 调度上端到端生效（意见追加、不拦截、子代理正常执行）；
5. 无明文凭据泄漏进代码/报告。

建议（不阻断验收）：把 patch 里的明文 `apiKey` 换成环境变量（需确保 DSH 进程已继承该变量）。

## 后续修订（2026-10-27）

独立验证后，Lead 针对差异补了以下实现与文档修订；这些变更不属于上述原始 8 项验证快照：

- 新增 `gateTimeoutMs`（默认 10000ms），门禁超时与 `decision` 工具的 `timeoutMs` 分离，降低调度最长等待时间。
- `gatedTools` 省略时使用默认 7 个；显式 `[]` 现在表示不门禁任何工具。`mode: "off"` 仍会完全跳过门禁。
- `post-execute` 遇到下游结构化 `value` 时保留原结果并记录 warning，不再静默丢弃意见。
- advisory 低清晰度/暂缓建议会显示风险提示但不拦截；README 已补充该行为与配置说明。
- 更新提示词段为 `order: 3150`、`interpolate: false`，避免模板插值导致提示词装配失败。
- 新增测试覆盖空/默认 gatedTools、advisory 风险提示、value 结果日志、独立 gateTimeoutMs 与序列化 state 字符上限；最新结果：26 tests / 26 pass / 0 fail（Node 24）。
- HMR 后 `Config.listConfigs` 仍返回 `status: "schema"`，新字段 `gateTimeoutMs` 已出现在 live schema，默认值 10000；`decision` 工具简短真实调用成功。

## 设置页与凭据迁移（2026-10-27，后续修订）

本轮把 API Key 从 `cordis.patch.yml` 迁到 DSH 凭据库，并新增 Web 设置页。Host Client 模块图在启动时缓存“该包无 client 声明”的结果，普通 enable/disable 不会刷新；刷新页面或重启会重新扫描。为了即时验证，本轮用临时诊断 bundle 刷新缓存并完成了页面侧真实请求；诊断 bundle 已移除，未进入仓库。

| 项目 | 结果 | 证据 / 限制 |
|---|---|---|
| 明文 key 从仓库文件移除 | **PASS** | `cordis.patch.yml` 的 `apiKey` 已置空；全目录扫描 `sk-or-v1-…` 无命中 |
| 凭据库迁移 | **PASS** | `%USERPROFILE%\.dsh\.credentials.yaml` 中存在 `OPENROUTER_DECISION_API_KEY` 引用；`cordis.patch.yml` 无 key 后真实 `decision` 调用成功，证明解析走凭据库 |
| 未认证访问边界 | **PASS** | 未带浏览器凭据请求 `/api/decision-model/status` 返回 **401** |
| 离线安全测试 | **PASS** | `35 tests / 35 pass / 0 fail`；`test/settings.test.js` 覆盖不返回密钥、错误脱敏、限流、路由注册、凭据优先级、旧配置迁移；`test/client.test.js` 验证 slot 注册与对象注入形状 |
| Client 设置页实际注册 | **PASS** | boot graph 出现 `@local/decision-model`（`immediately: true`）；`settings.plugins.tab` 出现 `id: "decision-model"`、`order: 30`、`active: true` |
| Desktop / Web 共享入口 | **PASS** | 同一 Client 半同时注册 `settings.section`（`id: "decision-model"`、`order: 45`、`active: true`）；Desktop App 与 Web GUI 使用同一 web client，因此两端都能从设置主侧栏直接打开 |
| 已认证状态接口 | **PASS** | 从当前页面发起 `GET /api/decision-model/status` 返回 **200**：`configured: true, source: "stored", writable: true, ref: "OPENROUTER_DECISION_API_KEY"`，无 key 字段 |
| 真实“测试连接”按钮 | **PASS** | 同一页面发起 `POST /api/decision-model/test` 返回 **200**：`ok: true`、模型 `perplexity/pplx-decider-v1.2-20261016`、延迟 2670ms、成本 $0.00000192；响应无 key、无上游 body |
| 视觉渲染截图 | **未直接验证** | 当前环境没有浏览器控制能力；已确认 Client 半加载无崩溃、slot 注册 active，且真实页面请求链路可用。剩余仅为点开标签页的视觉确认 |

**安全说明**：本地凭据文件仅当前 OS 用户可读，但 Agent 工具进程与用户同 UID，因此凭据库不能隔离 Agent 进程；它解决的是“明文不进 Git / 不进配置回显 / 不跨 wire 回传”，不是恶意同用户进程隔离。
