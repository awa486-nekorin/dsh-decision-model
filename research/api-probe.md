# OpenRouter JEV 决策 alpha 接口 · 黑盒探测报告

- 探测时间：2026-10-27（Asia/Shanghai），客户端实测
- 端点：`POST https://openrouter.ai/api/alpha/decisions`
- 模型：`perplexity/pplx-decider-v1.2`
- 方式：纯黑盒（不依赖官方文档），共发出 80+ 次真实请求（约 50 次成功、25+ 次构造错误），全部请求/响应均在本机实测，本文数字均来自实际抓取
- 鉴权 key 已打码为 `sk-or-v1-****`，账号 user_id 打码为 `user_3KPG…hw9C`
- 本文中标注「实测」的结论有样本支撑；标注「未验证」的是没测到/测不出来的

---

## 1. 端点、鉴权与传输

| 项 | 结论 | 证据 |
|---|---|---|
| Method / URL | `POST https://openrouter.ai/api/alpha/decisions` | 实测 |
| 鉴权 | `Authorization: Bearer sk-or-v1-****`（必须） | 缺 header → 401；错 key → 401 |
| 缺失鉴权 | `401 {"error":{"message":"No cookie auth credentials found","code":401}}`（说明该端点还支持浏览器 cookie 鉴权，插件用 Bearer 即可） | 实测 |
| 错误 key | `401 {"error":{"message":"User not found.","code":401}}` | 实测 |
| 请求 Content-Type | `application/json`；实测发 `text/plain` 带合法 JSON body 也能成功（服务端不校验 Content-Type） | 实测 |
| 响应 Content-Type | `application/json`，**没有 charset 参数** | 实测 |
| HTTP-Referer / X-Title | 可选，实测对结果无影响 | 实测 |
| 流式 | 不支持（无 `stream` 语义，一次性 JSON 返回） | 实测 |
| 限流响应头 | 未观察到 `x-ratelimit-*`；429 未触发/未验证 | 未验证 |
| 其余响应头 | `X-Generation-Id`（= body 里的 `id`，实测完全一致）、`X-Provider-Name`（= body 里的 `provider`）、`Server-Timing`（边缘 `cfWorker` 约 537ms）、Cloudflare `Set-Cookie __cf_bm` | 实测 |

> **编码坑（必须处理）**：响应 `Content-Type: application/json` 不带 charset，.NET Framework / Windows PowerShell 的 `Invoke-WebRequest` 会按 ISO-8859-1 解码，中文 legend 会变成 `å¾å·®` 这样的乱码。必须**按原始字节 UTF-8 解码**（Node/浏览器 `fetch().json()`、Python `json.loads` 默认就是 UTF-8，无此问题）。探测过程中踩过一次，已确认服务端返回的是正确 UTF-8。

---

## 2. 请求契约

### 2.1 顶层字段

| 字段 | 类型 | 必有 | 含义 / 取值域 | 实测备注 |
|---|---|---|---|---|
| `model` | string | 是 | 决策模型 | 只接受 `perplexity/pplx-decider-v1.2`；带日期后缀的 `perplexity/pplx-decider-v1.2-20261016` 也接受（实测同一结果）。其他模型（`openai/gpt-4o`、`perplexity/pplx-decider-v9.9`）→ 400 "Model X does not exist" |
| `state` | string \| object \| array | 是 | 决策上下文（会被序列化进 prompt） | **三种形态全部 200 实测**：string / object / array。空字符串 `""` 也 200。数字/null → 400。20KB 字符串 → 200 |
| `questions` | object (record) | 是 | `{ 问题id: 问题对象 }` | 空 `{}` → 400 "At least one question is required"；数组/字符串 → 400 "expected record" |
| 其他顶层字段 | — | 否 | `max_tokens`/`temperature`/`top_p`/`seed`/`response_format` 等 | **接受但无可见影响**（同 body 加这批参数，返回逐位相同）。是否被内部使用无法区分（该接口完全确定性），按「忽略」处理，不要依赖 |

`state` 三种形态实测结果（同一条 noul 指令）：

| state 形态 | HTTP | input_tokens | noul |
|---|---|---|---|
| `"User is considering buying a used car in October 2026. Budget 20k USD."` | 200 | 107 | 0.7191933777188326 |
| `{"user":"alice","task":"buy used car","budget_usd":20000,"month":"2026-10"}` | 200 | 123 | 0.7226306337447537 |
| `["user: alice","task: buy used car","budget: 20000 USD"]` | 200 | 108 | 0.5908403017282415 |

> 注意：object/array 不是「结构化字段」，只是被序列化进同一段文本，token 数会略多（+1~+16），语义上和等价字符串没有本质差别。插件建议**统一传 string**（自己序列化），行为最可控、成本最低。

### 2.2 question 对象

| 字段 | 类型 | 必有 | 取值域 | 备注 |
|---|---|---|---|---|
| `type` | string | 是 | `noul` \| `choice` \| `score`（schema 里还有第 4 个 `box`） | 非法值 → 400，错误体里会列出合法选项 `noul/choice/score/box` |
| `instructions` | string \| object \| array | **是（所有类型都必填）** | 自由文本；也接受 record/array（会被序列化） | 缺 → 400。noul 时为空字符串 `""` **且**无 criteria → 上游 400 "Noul question must have criteria or instructions"；noul 有 criteria 时 `""` 可接受。choice/score 传空字符串的行为未验证 |
| `criteria` | 视 type 而定 | 见下 | 见下 | 未知字段（如 `foo`、`weight`）静默忽略 |

#### type = `noul`（是/否命题）
- 响应只有一个数：`noul`（P(命题为真)），见 §3。
- `criteria` **可选**，若给必须是 record 且**同时含 `true` 和 `false` 两个键**，每个值可为 string/record/array：
  ```json
  "criteria": { "true": "用户 3 个月内会买二手车", "false": "用户 3 个月内不会买二手车" }
  ```
  只给 `true` → 400（错误体 path `[... "criteria","false"]`）。给 criteria 会轻微改变概率（同 state 下 0.98436 → 0.99476，实测），可理解为给命题双方补定义。

#### type = `choice`（多选一）
- `criteria` **必填**，record：`{ 选项名: string|record|array|null }`
  - 选项名原样作为返回 keys（实测 `A/B/C`、`buy_now/wait/skip`、`opt1..opt255`、含空格/中文/点号的 key 都原样返回）
  - **选项数 1..255**（0 个 → 400 "Each decision needs between 1 and 255 options"；256 个 → 同一条 400，实测边界确认）
  - 值允许 `null`（表示不给该选项描述），且该选项**仍是候选、仍可能被选中**（实测一条 3 选项里唯一 `null` 的 C 拿到 p=0.58 并被选中）→ 建议插件不要用 null 表达「不参与」，要给它显式描述

#### type = `score`（有序等级）
- `criteria` **必填**，**array of string**（1..255 项），顺序即等级从低到高；数组元素也可以是 record/array（实测接受，会被序列化），但**数字元素 → 400**（`expected string, received number`，逐下标报错）。
- legend 回显 criteria 原文（中文正常回显），键是 `"0".."n-1"` 字符串。**已知示例里的 `legend:{"0":"?","1":"?","2":"?"}` 是打码/匿名化，不是接口行为。**

#### type = `box`
- schema 合法但 **Perplexity 不支持**，直接 400：
  `{"error":{"message":"Perplexity does not accept box questions; question \"q1\" is a box","code":400}}`
- 插件应在本地直接拒绝 `box`。

---

## 3. 响应契约（HTTP 200）

### 3.1 顶层

| 字段 | 类型 | 必有 | 含义 / 取值域 |
|---|---|---|---|
| `model` | string | **总是有** | 解析后的**带日期后缀**版本，实测恒为 `perplexity/pplx-decider-v1.2-20261016`。插件不要拿它和请求的 model 做字符串相等判断 |
| `provider` | string | **总是有** | 实测恒为 `Perplexity` |
| `id` | string | **总是有** | `gen-dec-<epoch秒>-<22位随机>`，与响应头 `X-Generation-Id` 完全一致 |
| `usage` | object | **总是有** | `{input_tokens:int, output_tokens:int, cost:float}`；`output_tokens` = 问题数（1 题→1，3 题→3）；`cost` 单位 USD |
| `answers` | object | **总是有** | 键 = 请求 `questions` 的键，**原样返回、顺序与请求一致**（含空格/中文/`a.b[0]` 这类 key 都实测通过）；每个值按 type 有下面三种形状 |

> `answers` 的键顺序、`probabilities` 的键顺序都**不保证**与输入一致（实测 choice 的 probabilities 出现过 `C,B,A` 顺序）→ 插件必须按 key 取值，不能依赖顺序。

### 3.2 `answers[id]` 三种形状

| type | 字段 | 类型 | 必有 | 含义 |
|---|---|---|---|---|
| noul | `type` | `"noul"` | 是 | 判别器 |
| | `noul` | number | 是 | **P(instructions 描述的命题为真)**，实测落在 (0.0008, 0.9988) 开区间；无 probabilities/confidence 字段 |
| choice | `type` | `"choice"` | 是 | |
| | `choice` | string | 是 | 被选中的选项名，**实测恒等于 `argmax(probabilities)`** |
| | `probabilities` | `{选项名: number}` | 是 | 与请求 criteria 的键一一对应，**和恒为 1**（实测 2/3/4/255 选项均 sum=1） |
| | `confidence` | number | 是 | 见 §3.3，取值 [0,1] |
| score | `type` | `"score"` | 是 | |
| | `score` | number | 是 | **等级下标的期望值** `Σ i·p_i`，取值域 `[0, n-1]` |
| | `legend` | `{"0".."n-1": string}` | 是 | criteria 原样回显（中文正常） |
| | `probabilities` | `{"0".."n-1": number}` | 是 | 各级概率，**和恒为 1** |
| | `confidence` | number | 是 | 见 §3.3，取值 [0,1] |

### 3.3 数值关系（全部由实测反推，精度到浮点末位）

- **`score = Σ i · probabilities[i]`**：2 级 / 3 级 / 4 级 / 5 级各样本全部精确吻合。
  - 例：3 级 `p={0.005721,0.046780,0.947498}` → `0.046780 + 2×0.947498 = 1.941777`（= 返回的 score）
  - 所以 score 的取值域随级别数变化：2 级 [0,1]、3 级 [0,2]、4 级 [0,3]、5 级 [0,4]
- **choice.confidence = (max(p) − 1/n) / (1 − 1/n)**，n=1 时返回 1（0/0 特判）
  - 实测：3 选项 `max=0.579584` → `(0.579584−0.333333)/0.666667 = 0.369376`（= 返回 0.369376）；4 选项、255 选项同样精确吻合
  - 即「比均匀分布高出的部分」的归一化值，∈[0,1]
- **score.confidence = |score − (n−1)/2| / ((n−1)/2)**，n=1 时返回 1
  - 实测：3 级 score=1.941777 → `|1.941777−1|/1 = 0.941777`；4 级 score=0.571979 → `|0.571979−1.5|/1.5 = 0.618681`；5 级 score=3.574928 → `|3.574928−2|/2 = 0.787464`
  - **注意是绝对值**：乐观和悲观同样是高 confidence，方向必须看 score 本身，不能只看 confidence
- **单级（n=1）退化**：score 返回 `score=0, probabilities={"0":1}, confidence=1`；choice 返回 `choice=该唯一项, probabilities={该项:1}, confidence=1`
- **确定性**：同一 body 重复 6 次，`noul` 值逐位相同（`0.9843622093637677` ×6），cost 也相同。**响应可按 (model,state,questions) 哈希缓存**（省钱且字节级稳定）。

---

## 4. 各 type 的语义解释与归一化建议

### 4.1 noul → P(true)
- 语义：`noul` 就是「instructions 所描述命题为真」的校准概率，不是「分数」。证据：
  - 同一 state，正表述 "Should the user buy…?" → 0.98436；反表述 "Should the user NOT buy…?" → 0.02738；"Will the user regret…?" → 0.0598（语义翻转即概率翻转）
  - 客观真值题：「晴天 → 太阳在照射」0.99882；「凌晨 3 点 → 太阳在照射」0.00263
  - 同一 state 不同措辞：0.98436 / 0.99524 / 0.99757（同向表述间差异 <2%，但**否定/反向措辞会导致意义完全不同的数**）→ 插件必须把「命题方向」写死在 instructions 里
- 归一化：`pTrue = answers[id].noul`；`decision = pTrue >= 0.5 ? "yes" : "no"`；建议另给 `pFalse = 1 - pTrue`、`odds = pTrue/(1-pTrue)`、强/弱判定阈值 0.7 / 0.3。

### 4.2 choice → 概率最高的选项
- 语义：对 criteria 选项集的校准概率分布；`choice` = argmax。
- 归一化：以 `probabilities` 重算 argmax 并**校验**它与 `choice` 一致（实测永远一致，但重算成本低、可防御上游变化）；输出 `chosen`、按概率降序的 `ranking`、`margin = p1 − p2`、`confidence`（已归一化）。
- 坑：`null` 描述的选项没有语义，模型可能随机选中（实测 C:null 被选中 p=0.58）；选项描述越具体，分布越有区分度。

### 4.3 score → 期望等级下标
- 语义：等级概率分布的期望下标 `Σ i·p_i`，域 `[0, n−1]`。
- 归一化：`normalized = score / (n−1)`（n=1 时取 0）∈[0,1]；`nearestLabel = legend[round(score)]`（.5 边界就近取整，建议 `Math.round` 并在文档里固定）；`confidence` 只表示「离中性有多远」，方向靠 `normalized` 判断。
- 建议阈值（插件层，可按业务调）：`normalized >= 0.67` 判「强正面」、`<= 0.33` 判「强负面」、其余「中性/不确定」；也可直接用最大概率级别的 p 值。
- 级别数不要用 1（退化无意义）；2 级 score 与 noul 很接近（score=0.973 时等价于 pTrue≈0.973），如果只要「是/否」用 noul 更直接、更省 token。

---

## 5. 错误码 / 错误体对照表

错误体有 **两种格式**，插件要都兼容：

- **A 型（网关注入，带 `user_id`）**：
  `{"error":{"message":"<字符串>","code":<int>},"user_id":"user_3KPG…hw9C"}`
  `message` 可能是**普通文本**（如 `"JSON parsing failed"`）、**JSON 数组的字符串**（zod 校验错误，要 `JSON.parse` 才能拿到 path）、或**上游错误被包成字符串**（`"HTTP 400: {...}"`）。
- **B 型（无 `user_id`）**：
  `{"error":{"message":"Model xxx does not exist","code":400}}`

| # | 场景 | HTTP | 错误体（关键部分） |
|---|---|---|---|
| 1 | 缺 / 错 API key | 401 | `No cookie auth credentials found` / `User not found.` |
| 2 | body 为空字节 / 非 JSON 文本 | 400 | `JSON parsing failed` |
| 3 | `model` 缺失或非 string | 400 | zod：`path:["model"] expected string, received undefined` |
| 4 | `model` 不存在 | 400 | `Model <name> does not exist`（B 型，无 user_id） |
| 5 | `state` 缺失 / 类型错（如 `123`） | 400 | zod union：`path:["state"]`，三候选 string/record/array |
| 6 | `questions` 缺失 / 非对象 / 空 `{}` | 400 | 缺失、数组：`expected record`；空对象：`custom "At least one question is required"` |
| 7 | question 值不是对象（如 `"q1":"..."`） | 400 | `path:["questions","q1"] expected object, received string` |
| 8 | `instructions` 缺失 | 400 | zod union：`path:["questions","q1","instructions"]`，候选 string/record/array |
| 9 | `type` 非法（如 `bogus`） | 400 | `invalid_union`，`"options":["noul","choice","score","box"]`，`"Invalid discriminator value…"` |
| 10 | noul：`instructions:""` 且无 criteria | 400 | A 型包装：`HTTP 400: {"error":{"message":"Noul question must have criteria or instructions",...}}` |
| 11 | noul：criteria 缺 `false` 键 | 400 | zod：`path:["questions","q1","criteria","false"]` |
| 12 | choice：缺 criteria | 400 | zod：`path:["questions","q1","criteria"] expected record, received undefined` |
| 13 | choice：criteria `{}` / 256 个选项 | 400 | A 型包装：`Each decision needs between 1 and 255 options` |
| 14 | score：缺 criteria / 传 object / 元素是数字 | 400 | `expected array` / `expected array, received object` / `path:[...,"criteria",0] expected string, received number` |
| 15 | type=box | 400 | `Perplexity does not accept box questions; question "q1" is a box`（B 型） |
| 16 | `state` 20KB 字符串 | **200** | 正常返回（input_tokens=4886，cost=$0.00009772，700ms） |

> 语义：除 #16 外，所有校验都是**整单原子失败**——一个 question 不合法则整个请求 400，不会部分成功。

---

## 6. 延迟与成本

### 6.1 延迟（客户端 → OpenRouter 边缘，含 TLS 复用，单位 ms）

| 场景 | 样本 | 均值 | 范围 |
|---|---|---|---|
| 正常调用（单题 noul，~118 input tokens） | 6 次同 body | **573.7** | 562–595 |
| 正常调用（各类型混合，全部成功样本） | ~40 次 | ~610 | 548–745 |
| 慢样本（5 级 score / 网络抖动） | 2 次 | — | **1451 / 2086** |
| 20KB state 单题 | 1 次 | 700 | — |
| 255 选项 choice | 1 次 | 730 | — |
| 本地校验类错误 | 多数 | ~30 | 18–130 |
| 需要打到上游才报的错（空 instructions / 选项数越界） | — | ~450–580 | — |

结论：**正常一次决策约 0.55–0.75 秒，偶发 1–2 秒**；插件超时建议 ≥ 15s，重试 1 次即可。

### 6.2 成本（USD，服务端 `usage.cost`）

计费关系实测为：**`cost = input_tokens × 2.0e-8`**（即 $0.02 / 1M input tokens），13 个样本精确吻合；`output_tokens` 在观测范围内未产生费用。

| 场景 | input_tokens | output_tokens | cost |
|---|---|---|---|
| 单题 noul（小 state） | 118 | 1 | $0.00000236 |
| 单题 noul（空 state） | 82 | 1 | $0.00000164 |
| 3 题混合（noul+choice+score） | 191 | 3 | $0.00000382 |
| 255 选项 choice | 3427 | 1 | $0.00006854 |
| 20KB state 单题 | 4886 | 1 | $0.00009772 |

单次调用成本在 $1.6e-6 ~ $3e-6 量级，可忽略但**不是零**；本次全部探测总花费约 $0.0004 量级。

---

## 7. 可直接抄进实现/测试的最小样例

### 7.1 最小请求（单题 noul）
```http
POST /api/alpha/decisions HTTP/1.1
Host: openrouter.ai
Authorization: Bearer sk-or-v1-****
Content-Type: application/json

{"model":"perplexity/pplx-decider-v1.2","state":"User is considering buying a used car in October 2026. Budget 20k USD.","questions":{"q1":{"type":"noul","instructions":"Should I buy a used car this month?"}}}
```
响应（实测原文，HTTP 200）：
```json
{"model":"perplexity/pplx-decider-v1.2-20261016","answers":{"q1":{"type":"noul","noul":0.7191933777188326}},"usage":{"input_tokens":107,"output_tokens":1,"cost":0.00000214},"id":"gen-dec-1793094579-rlNX1i6LVleFZla8cjns","provider":"Perplexity"}
```

### 7.2 choice（criteria 含 null 选项）
请求：
```json
{"model":"perplexity/pplx-decider-v1.2","state":"Alice is 34, received a 30% raise, has 50k USD savings, stable job, needs a car for a new commute. She is deciding what to do about a car.","questions":{"q1":{"type":"choice","instructions":"Which option should the user choose?","criteria":{"A":"Buy the used car now","B":"Wait 6 months and save more","C":null}}}}
```
响应（实测原文）：
```json
{"model":"perplexity/pplx-decider-v1.2-20261016","answers":{"q1":{"type":"choice","choice":"C","probabilities":{"C":0.5795837114947127,"B":0.033838073128969456,"A":0.38657821537631787},"confidence":0.369375567242069}},"usage":{"input_tokens":140,"output_tokens":1,"cost":0.0000028},"id":"gen-dec-1793094603-MnBbc5qvEhnqRdMoWqQ3","provider":"Perplexity"}
```

### 7.3 score（中文 3 级）
请求：
```json
{"model":"perplexity/pplx-decider-v1.2","state":"Alice is 34, received a 30% raise, has 50k USD savings, stable job, needs a car for a new commute. She is deciding whether to buy a used car now.","questions":{"q1":{"type":"score","instructions":"Rate how good an idea it is for the user to buy a used car now.","criteria":["很差","一般","很好"]}}}
```
响应（实测原文）：
```json
{"model":"perplexity/pplx-decider-v1.2-20261016","answers":{"q1":{"type":"score","score":1.9417769325123995,"legend":{"0":"很差","1":"一般","2":"很好"},"probabilities":{"0":0.005721378820008856,"1":0.046780309847582795,"2":0.9474983113324084},"confidence":0.9417769325123995}},"usage":{"input_tokens":140,"output_tokens":1,"cost":0.0000028},"id":"gen-dec-1793094620-E1pSDEh9KMGRuJO6OVQN","provider":"Perplexity"}
```

### 7.4 一次多题（keys 原样、顺序无关）
请求（3 题，key 故意乱序）：
```json
{"model":"perplexity/pplx-decider-v1.2","state":"Bob was laid off, has 2k savings and 15k debt. He is deciding whether to buy a used car now.","questions":{"z":{"type":"noul","instructions":"Should the user buy a used car now?"},"a":{"type":"choice","instructions":"What should the user do?","criteria":{"A":"Buy now","B":"Wait","C":"Do not buy"}},"m":{"type":"score","instructions":"Rate how good an idea it is for the user to buy a used car now.","criteria":["bad","ok","good"]}}}
```
响应（实测原文）：
```json
{"model":"perplexity/pplx-decider-v1.2-20261016","answers":{"z":{"type":"noul","noul":0.07115641662170441},"a":{"type":"choice","choice":"C","probabilities":{"C":0.7141431414612048,"B":0.26497386629844044,"A":0.020882992240354687},"confidence":0.5712147121918072},"m":{"type":"score","score":0.1565819822813489,"legend":{"0":"bad","1":"ok","2":"good"},"probabilities":{"0":0.8718058165649978,"1":0.09980638458865539,"2":0.02838779884634676},"confidence":0.8434180177186511}},"usage":{"input_tokens":191,"output_tokens":3,"cost":0.00000382},"id":"gen-dec-1793094659-VhHptPVcO95EcSr4yt0i","provider":"Perplexity"}
```

### 7.5 错误样例（两种格式都留一份）
```json
// 401 缺鉴权
{"error":{"message":"No cookie auth credentials found","code":401}}
// 400 非 JSON body（A 型，带 user_id）
{"error":{"message":"JSON parsing failed","code":400},"user_id":"user_3KPGRMs2k8TDqIJ1Wp3WUs6hw9C"}
// 400 模型不存在（B 型，无 user_id）
{"error":{"message":"Model openai/gpt-4o does not exist","code":400}}
// 400 choice 缺 criteria（A 型，message 是 JSON 数组字符串）
{"error":{"message":"[\n  {\n    \"expected\": \"record\",\n    \"code\": \"invalid_type\",\n    \"path\": [\"questions\",\"q1\",\"criteria\"],\n    \"message\": \"Invalid input: expected record, received undefined\"\n  }\n]","code":400},"user_id":"user_3KPGRMs2k8TDqIJ1Wp3WUs6hw9C"}
// 400 上游错误被包装（A 型）
{"error":{"message":"HTTP 400: {\"error\":{\"message\":\"Each decision needs between 1 and 255 options\",\"type\":\"invalid_request\",\"code\":\"400\"}}","code":400}}
```

---

## 8. 推荐的插件内部 `normalizeDecisionResponse()` 输出结构

目标：把三种异构 answers 归一成统一形状，下游（展示/阈值/决策）不再关心原始 type 差异。建议（JSON，TypeScript 类型见括号）：

```json
{
  "ok": true,
  "request": {
    "model": "perplexity/pplx-decider-v1.2",
    "questionIds": ["q1", "q2", "q3"],
    "latencyMs": 574
  },
  "response": {
    "id": "gen-dec-1793094659-VhHptPVcO95EcSr4yt0i",
    "model": "perplexity/pplx-decider-v1.2-20261016",
    "provider": "Perplexity",
    "usage": { "inputTokens": 191, "outputTokens": 3, "costUsd": 0.00000382 }
  },
  "answers": {
    "q1": {
      "id": "q1",
      "type": "noul",
      "pTrue": 0.07115641662170441,
      "pFalse": 0.9288435833782956,
      "decision": "no",
      "label": null,
      "confidence": null,
      "probabilities": null,
      "expectedIndex": null,
      "normalizedScore": null,
      "ranking": null
    },
    "q2": {
      "id": "q2",
      "type": "choice",
      "chosen": "C",
      "label": "Do not buy",
      "confidence": 0.5712147121918072,
      "probabilities": { "C": 0.7141431414612048, "B": 0.26497386629844044, "A": 0.020882992240354687 },
      "ranking": [
        { "key": "C", "p": 0.7141431414612048, "label": "Do not buy" },
        { "key": "B", "p": 0.26497386629844044, "label": "Wait" },
        { "key": "A", "p": 0.020882992240354687, "label": "Buy now" }
      ],
      "margin": 0.44916927516276434,
      "pTrue": null,
      "expectedIndex": null,
      "normalizedScore": null
    },
    "q3": {
      "id": "q3",
      "type": "score",
      "expectedIndex": 0.1565819822813489,
      "normalizedScore": 0.07829099114067445,
      "label": "bad",
      "leaning": "negative",
      "confidence": 0.8434180177186511,
      "levels": 3,
      "legend": { "0": "bad", "1": "ok", "2": "good" },
      "probabilities": { "0": 0.8718058165649978, "1": 0.09980638458865539, "2": 0.02838779884634676 },
      "pTrue": null,
      "chosen": null,
      "ranking": null
    }
  }
}
```

实现要点（按优先级）：

1. **失败也走同一结构**：`{ok:false, error:{httpStatus, code, message, rawMessage}}`，其中 `rawMessage` 原样保留；若 `message` 能被 `JSON.parse` 成数组（zod），额外给出 `issues:[{path, message, code}]`。
2. `choice`：`chosen` 用 `argmax(probabilities)`，与响应 `choice` 不一致时记 warning 并以 `choice` 为准（实测从不冲突）；`margin = p1 − p2`。
3. `score`：`normalizedScore = levels>1 ? expectedIndex/(levels-1) : 0`；`label = legend[Math.round(expectedIndex)]`；`leaning` 由 `normalizedScore` 判（<=0.33 negative，>=0.67 positive，其余 neutral）。**不要用 `confidence` 判方向**（它是绝对值）。
4. `noul`：`pTrue = noul`，`decision = pTrue >= 0.5`，`confidence = null`（上游不提供）。
5. 统一保留 `usage`、`id`、`provider`、`latencyMs` 便于日志与成本统计；`model` 记录上游返回值（带日期后缀），别改写。
6. 缓存：对 `hash(model, JSON.stringify(state), JSON.stringify(questions))` 做命中缓存（响应完全确定，成本按次计费，缓存直接省钱）；建议 TTL ≥ 7 天。
7. 请求侧校验（在本地就拦住，省一次 400 往返）：`model` 只允许该模型；`state` 必须有；`questions` 非空对象；每题 `instructions` 必有且非空（noul 若 empty 则必须有 `criteria.true/false`）；choice 的 criteria 1..255 且建议不要 null 值；score 的 criteria 1..255 且全为 string；拒绝 `box`。

---

## 9. 坑清单 & 未验证项

**坑**
1. 响应无 charset → 中文 legend 会被 .NET/PowerShell 按 Latin-1 解成乱码；一律按 UTF-8 解码。
2. `legend:{"0":"?"}` 是任务给的已知样本被打码了，实际会回显 criteria 原文。
3. `confidence` 在 choice 和 score 里是**两种不同定义**（前者对均匀分布的超出量，后者对中点的偏离绝对值），别混用；noul 没有 confidence。
4. `score` 的数值域随级别数变化（0..n-1），直接当 0..1 用会错。
5. `null` 描述的 choice 选项仍可能被选中，且没有任何语义。
6. 上游可能把错误包装成 `"HTTP 400: {...}"` 字符串，`message` 也可能是 JSON 数组字符串——解析错误体要做二次解析。
7. 顶层 `temperature`/`max_tokens` 等接受但无效果，别依赖它们控制输出。
8. 一次多题是**单次计费、单次调用**（output_tokens=题数），比 N 次单题更省延迟；批量场景优先合并。
9. 完全确定性：同输入同输出（6/6 逐位相同）——写测试可以直接断言固定数值，但要注意后续模型可能升级（`model` 的日期后缀变了就可能变），测试断言建议用范围/单调性而非硬编码浮点。

**未验证**
- 429 限流阈值与重试建议（未触发）
- `state` 大于 20KB 的硬上限（20KB 实测 OK，再大未测）
- `questions` 数量上限（实测 3 题 OK，更多未测）
- choice/score 的 `instructions` 传空字符串的行为（未测；noul 已测）
- 并发请求下的稳定性/串行化（未测）
- `box` 类型在任何模型下是否能工作（Perplexity 明确拒绝）
- 中文 criteria 是否被模型**语义正确**理解：只验证了 legend 回显正确；不过中文 3 级 score 在正/负 state 下分别给出 1.94/0.08 的方向性，间接说明模型读得懂，但未做系统性验证。
