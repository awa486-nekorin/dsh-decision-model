# DSH Host 插件契约（写 `decision` 插件所需的精确 API）

- 取证时间：2026-10-27，本机 DSH 桌面版 `0.2.1-rc.3`（`resources/runtime/primary-runtime/runtime.json` 的 `desktopVersion`）
- 目标产物：`D:\whale\decision-model`（无构建、无依赖、纯 ESM 的 Host-only bundle）
- 原则：**每条结论都给「结论 + 证据路径 + 可复制代码」**；没测到的明确写「未验证」。
- 证据分三类：
  - `asar:` = `C:\Users\Administrator\AppData\Local\Programs\DeepSeek Harness\resources\app.asar\dsh\...`（**只能用 read 工具读**，shell/glob/grep/rg/node 全部读不了，见 §0.2）
  - `pkg:` = npm 上同版本包的类型声明（`https://unpkg.com/@deepseek-ai/<pkg>@0.2.1-rc.3/...`）。asar 里只保留 `lib/*.js`（**没有 .d.ts**），类型以 unpkg 同版本 .d.ts 为准，行为以 asar 里的 js 为准，两者已互相核对。
  - `profile:` = `C:\Users\Administrator\.dsh\profiles\desktop\node_modules\...`（真实已安装插件，可直接 grep）
- 运行时版本：Node **24.21.0**（`resources/runtime/versions.json`；`runtime.json` 同值），pnpm 11.28.5，Python 3.12.14。

> 一句话结论（够用版）：`ctx.tools.register(原始 ToolDefinition 字面量)` + `ctx.on('tools/pre-execute', async (exec, next) => …)` + `ctx.systemPrompt.section({ name, order, text, interpolate:false })` + `export const Config = z.object({…})`（schemastery/Standard Schema）就能做出全部功能；**不需要** `defineTool`，但**需要**知道 pre-execute 不能改写参数、post-execute 要 `await next()` 再叠加。最坑的三点见 §10。

---

## 0. 取证方法与两个环境坑

### 0.1 `cordis_inspect_query` 在本机会话不可用（它自己的 input 传不进去）

| 调用 | 结果 |
|---|---|
| `platform=host, provider=Service, method=listService`（不带 input） | ✅ 返回完整 service 目录（已用，见 §1 的 `tools`/`systemPrompt` 签名） |
| 同上 + `input: {"service":"tools"}` | ❌ `rejected input: "input" must be an object` |
| `provider=Event, method=listEvents` + `input: {"event":"tools/pre-execute"}` | ❌ 同上 |
| `provider=Tool, method=listTools` + `input: {}` | ❌ 同上 |

结论：本次会话里 `input` 参数被当成字符串传给了 provider，任何带 input 的 query 都失败；不带 input 的目录查询可用。**精确类型改从 .d.ts / 实际 JS 取证**（本文全部采用此法）。换会话/升级后建议重试一次（这是工具链问题，不是 provider 问题）。

### 0.2 asar 只能用 read 工具读，但可以整包导出后 grep

`app.asar` 是一个**文件**（182 MB），不是目录：

- `read` 工具可以读内部路径（例：`asar:\node_modules\@deepseek-ai\dsh-tools\lib\index.js`）✅
- `glob` / `grep`(rg) / `Select-String` / `node` / `pnpm` 一律失败（rg: `os error 3`，因为它是按目录去打开的）❌

要 grep 就先按 asar 头把文件导到临时目录（我在 `C:\Users\Administrator\AppData\Local\Temp\dsh-asar.mjs` 用过，脚本见附录 A）。asar 布局：

```
u32@0  = 4                      // 长度字段自身的 pickle 大小
u32@4  = headerPickleSize       // 内容区 = 8 + 这个值
u32@8  = headerPickleSize - 4
u32@12 = jsonLen                // JSON 字节数
JSON 从 16 开始；文件内容偏移 = 8 + headerPickleSize + entry.offset
```

另：`resources\app.asar.unpacked\dsh\node_modules\@deepseek-ai\` 只有 3 个含二进制的包（libreoffice-kit 等），**核心包不在里面**。

### 0.3 关键先验：profile 插件**不能** `import '@deepseek-ai/dsh-tools'`

`profile:\package.json` 的 `dependencies` 里只有 `@deepseek-ai/{cosmokit,dsh-brand,dsh-sdk-protocol,dsh-subagent-claude-code,dsh-subagent-codex,dsh-tool-subagent,schemastery}`（`Get-ChildItem` 实测），**没有 `dsh-tools`**：桌面版 profile 是 `autoInstallPeers: false`，optional peer 不装。

- `schemastery` ✅ 在 profile 顶层，bare import 可用（但别指望永远在，见 §6）。
- `dsh-tools` ❌ 解析不到 → `import { defineTool } from '@deepseek-ai/dsh-tools'` 在 profile 插件里会抛。

`@local/pawbot` 为此专门写了兜底：`profile:\@local\pawbot\lib\hostdeps.js`（扫 `%APPDATA%\npm`、`$DSH_HOME/profiles/*/node_modules`、自身 node_modules 找 `@deepseek-ai/<pkg>` 的入口文件再 `import(fileURL)`，**拿不到就退化为本地等价实现**）。它的注释直接写明：

> `@deepseek-ai/dsh-tools` 与 `@deepseek-ai/schemastery` 在本插件是 optional peer，桌面版 profile `autoInstallPeers: false` 不会装 ⇒ bare import 常失败。

**对我们的建议：不 import `dsh-tools`。** 直接向 `ctx.tools.register()` 传原始 `ToolDefinition` 字面量（§2.2 路径 A），注册时只校验 `output` 形状，不需要 `defineTool`。代价是**没有自动参数校验**（见 §2.3）。

---

## 1. Service 签名（目录里拿到的原始签名）

证据：`cordis_inspect_query(host/Service/listService)` 返回的 catalog（无 input 可用），以及
`pkg:@deepseek-ai/dsh-tools@0.2.1-rc.3/lib/types/index.d.ts`、`pkg:@deepseek-ai/dsh-system-prompt@.../index.d.ts`。

```ts
// ctx.tools  —— ToolRuntime
presentAs(mode: 'native' | 'ptc'): () => void
register(definition: ToolDefinition): () => void        // 返回精确 disposer
restrict(filter: ToolRestriction): () => void           // 只能在 agent.ctx 上调
guard(guard: ToolGuard): () => void                     // 同步、单调 deny，只能拒不能放
get(name: string, scope?: ScopeKey): ToolDefinition | undefined
schemas(scope?: ScopeKey): ToolSchema[]
executionMode(exec: ToolExecutionInput): ToolExecutionMode
execute(exec: ToolExecutionInput): Promise<ToolExecutionResult>

// ctx.systemPrompt —— SystemPrompt
section(section: PromptSection): () => void
getSectionOrder(name: PromptSectionOrderName): number
getContextOrder(name: PromptContextOrderName): number
context(context: PromptContext): () => void
tools(provider): () => void
variable(name, provider): () => void
suppressRuntimeContext(): () => void
assemble(context?: AssembleContext): Promise<PromptAssembly>
refreshContext(assembly, context?): PromptAssembly
```

`inject` 需要哪些 service：**注册工具 → `tools`；注入提示词 → `systemPrompt`**。gating 只需要 `tools`（事件挂在 `ctx.on` 上，不需要额外 service）。若要 `ask` 真正弹窗，还需要宿主组合里有 `approval` service（它是 `ctx.get('approval')` 机会式取用，见 §3.3）。所以：

```js
export const inject = ['tools', 'systemPrompt']
```

证据（真实插件同款）：`profile:\dsh-soul-memory\index.js:51` → `const inject = ['systemPrompt', 'tools']`；`profile:\@local\pawbot\index.js:55` → `export const inject = ['tools', 'webServer']`。

---

## 2. 契约 1：`ctx.tools.register()` 完整可工作写法

### 2.1 类型（逐字）

`pkg:@deepseek-ai/dsh-tools/lib/types/index.d.ts`：

```ts
interface ToolOutputDefinition {
  readonly schema: JsonSchemaNode;                              // 输出契约（enforced subset）
  render(args: unknown, value: JsonValue): ContentBlock[];       // 唯一「回到模型」的投影
  presentationMeta?(args: unknown, value: JsonValue): JsonValue; // 可选的展示元数据（不发给模型）
}

interface ToolDefinition extends ToolSchema {           // ToolSchema = { name, description, parameters, deferLoading? }
  readonly output: ToolOutputDefinition;                // 必填
  execute(args: unknown, exec: ToolRunContext): Promise<unknown>;  // 只返回 canonical JSON value
  projectContent?(exec, result): ContentBlock[] | undefined;      // 在 post-execute 之前装内容
  finalizeContent?(exec, result): ContentBlock[] | undefined;     // 最后一道内容变换（post-execute 之后）
  timeoutMs?: number;              // 只是声明，注册表不执行（要靠 dsh-tool-call-timeout-policy）
  isConcurrencySafe?(args): boolean;
  presentCall?(args): ToolCallView | undefined;
  presentResult?(args, result: ToolResult): ToolResultView | undefined;
}
```

`execute` 的 `exec` 是 `ToolRunContext extends ToolExecution`：

```ts
interface ToolExecutionInput {
  readonly callId: ToolCallId;
  readonly rootCallId?: ToolCallId;
  readonly name: string;
  readonly schema?: ToolSchema;
  readonly arguments: unknown;      // 已 materialize 成 lossless JSON 并 deep-frozen
  readonly agent?: Agent;           // ← 拿 agent/session 的唯一入口
  readonly parent?: ToolExecutionToken;
  readonly signal: AbortSignal;     // 必须观察/转发
}
interface ToolExecution extends ToolExecutionInput { readonly rootCallId: ToolCallId; readonly token: ToolExecutionToken }
interface ToolRunContext extends ToolExecution {
  deferContext(context: UserMessage): void;   // 把一条 user-role context 推迟到本次 tool/result 之后
  concludeTurn(): void;                       // 标记本轮结束
}
```

**`execute` 返回什么**：只返回 `output.schema` 声明的那个 JSON value。`ContentBlock[]` **不是** execute 产出的，而是注册表在校验 value 之后调用 `output.render(exec.arguments, value)` 得到的——`render` 的返回值就是模型看到的内容（`ContentBlock[]`，必须可 lossless 序列化，会被 snapshot）。value 只存在于执行期，**不进 session 日志**（`ToolExecutionSuccess.value` 的 JSDoc：*deliberately omitted from durable events*）。

证据（行为）：`asar:\node_modules\@deepseek-ai\dsh-tools\lib\index.js` 的 `createSuccessResult()`：

```js
const detached = snapshotToolValue(tool.name, candidate);
const violations = validateJsonSchemaValue(tool.output.schema, detached, "value");
if (violations.length > 0) throw new ToolOutputError(tool.name, violations);
const value = deepFreeze(detached);
let rendered = tool.output.render(exec.arguments, value);   // ← 模型看到的内容
```

### 2.2 路径 A（推荐给本项目）：原始字面量注册，零依赖

`asar:\node_modules\@deepseek-ai\dsh-tools\lib\index.js` 的 `register()` 只校验三件事：

```js
const name = definition.name;
const output = definition.output;
if (output === void 0 || typeof output !== "object" || typeof output.render !== "function" ||
    (output.presentationMeta !== void 0 && typeof output.presentationMeta !== "function"))
  throw new TypeError(`tool "${name}" must declare output { schema, render, presentationMeta? }`);
assertSupportedJsonSchema(output.schema);
if (timeoutMs !== void 0 && (!Number.isFinite(timeoutMs) || timeoutMs <= 0)) throw new TypeError(...)
if (name === "run_code") throw new Error(`tool name "run_code" is reserved ...`);
```

所以下面这段可以直接跑（`parameters` 就是**原生 JSON Schema**，`output.schema` 也是）：

```js
/* D:\whale\decision-model\index.js 片段：零依赖注册 */
const DECISION_OUTPUT = {
  type: 'object',
  properties: {
    probability: { type: 'number' },
    verdict: { type: 'string', enum: ['yes', 'no', 'uncertain'] },
    rationale: { type: 'string' },
    model: { type: 'string' },
  },
  required: ['verdict'],
  additionalProperties: true,   // 建议 true：多返回字段不会把成功变成 ToolOutputError
}

function decisionToolDefinition(config, state) {
  return {
    name: 'decision',
    description:
      '向外部决策模型（JEV）要一个概率化判断。适合：方案取舍、风险评级、委派前的清晰度判断。' +
      '返回 probability(0~1) / verdict / rationale。模型不可用时返回 { ok:false, error } 并让你自行判断。',
    parameters: {
      type: 'object',
      properties: {
        state: {
          type: 'object',
          properties: { summary: { type: 'string' }, facts: { type: 'array', items: { type: 'string' } } },
          additionalProperties: true,
          description: '当前上下文：目标、约束、已知事实、候选方案。',
        },
        questions: {
          type: 'object',
          additionalProperties: true,
          description: '问题表：{ 问题id: { type: "noul"|"choice"|"score", instructions, criteria? } }',
        },
      },
      required: ['questions'],
      additionalProperties: false,
    },
    output: {
      schema: DECISION_OUTPUT,
      render(args, value) {
        // ← 这段就是模型看到的东西；不要返回函数/undefined/循环引用
        const p = typeof value.probability === 'number' ? `p=${value.probability.toFixed(3)}` : 'p=?'
        return [{
          type: 'text',
          text: `[decision] ${value.verdict} (${p})\n${value.rationale ?? ''}`.trim(),
        }]
      },
    },
    async execute(args, exec) {
      // exec.signal / exec.agent 见 §2.4
      const result = await state.decider.ask(args, exec.signal)
      if (!result.ok) {
        // 失败也必须返回「符合 output.schema 的 JSON」——直接 throw 会变成 Error: <message> 给模型
        return { verdict: 'uncertain', rationale: `decider unavailable: ${result.error}`, model: config.model }
      }
      return result.value
    },
  }
}

// 在 apply() 里：
ctx.tools.register(decisionToolDefinition(config, state))
```

`parameters` 用 JSON Schema 而不是 `defineTool` 的 DSL，**只有这一处差别**；注册表本身不校验 `parameters`（`register()` 只对 `output.schema` 跑 `assertSupportedJsonSchema`）。

### 2.3 路径 B：`defineTool`（有类型、有参数校验，但要能解析到 `dsh-tools`）

`pkg:@deepseek-ai/dsh-tools/lib/types/schema.d.ts`：

```ts
declare function defineTool<const S extends ParameterSchemaSpec, const O extends ValueSchemaSpec>(
  options: DefineToolOptions<S, O>): ToolDefinition;

interface DefineToolOptions<S, O> {
  name: string
  description: string
  parameters: S                     // ← 扁平「每属性一个 spec」，不是 JSON Schema
  output: { schema: O; render(args, value): ContentBlock[]; presentationMeta?(args, value): JsonValue }
  deferLoading?: true
  timeoutMs?: number
  isConcurrencySafe?(args): boolean
  execute(args, exec: ToolRunContext): Promise<InferValue<O>>
  projectContent?/finalizeContent?/presentCall?/presentResult?
}
```

差别（实测自 `asar:\node_modules\@deepseek-ai\dsh-tools\lib\types\schema.js:315-320`）：`defineTool` 会在 wrapper 里先校验参数再调你的 `execute`：

```js
async execute(args, exec) {
  const violations = validate(args);
  if (violations.length > 0) throw new ToolArgsError(violations);
  return userExecute(args, exec);
}
```

参数 DSL（`pkg:.../schema.d.ts`）：`{ 参数名: { type:'string'|'number'|'integer'|'boolean'|'null'|'array'|'object'|'json', required?: true, description?, enum?, const?, items?, properties?, additionalProperties? } }`，另外 `oneOf`。注意 **`type:'object'` 必须显式写 `additionalProperties: boolean`**，否则编译报错。

真实可跑的参考（`@local/pawbot` 用自写 fallback 包装成同一形状）：

```js
// profile:\@local\pawbot\index.js:538-553
const textOutput = {
  schema: { type: 'object', properties: {}, additionalProperties: true },
  render: (_args, value) => [
    { type: 'text', text: typeof value === 'string' ? value : JSON.stringify(value, null, 2) },
  ],
}
const tool = (spec) => ctx.tools.register(defineTool({ ...spec, output: textOutput, async execute(args, exec) { return safe(await spec.execute(args, exec)) } }))

tool({ name: 'pawbot_status', description: '…', parameters: {}, async execute() { … return { ok: true, … } } })
tool({ name: 'pawbot_logs', description: '…', parameters: { lines: { type: 'integer', description: '要回传的行数…' } }, async execute(args) { … } })
```

### 2.4 `output.schema` 只能用「受支持子集」

`asar:\node_modules\@deepseek-ai\dsh-tools\lib\types\json-schema.js:209` 的报错原文给出了白名单：

```
<path>.<key> is not a supported keyword
(subset: type/oneOf/properties/required/additionalProperties/items/enum/const + annotations)
```

→ **不能用** `format` / `pattern` / `minimum` / `maxLength` / `$ref` / `definitions` / `allOf` / `anyOf`。`type` 不许是数组（`type arrays are not supported`）。`oneOf` 分支旁边也不能再写 `properties`（`is not supported beside oneOf`）。违反 = `JsonSchemaError: unsupported JSON schema: …`，**插件 apply 直接抛**。

### 2.5 清理：`register()` 的 disposer 属于「调用它的那个 ctx」

- `register()` 返回**精确的 Cordis effect disposer**（d.ts 原文）。cordis 的 service 是 traceable 的：`this.ctx` 会替换成**取用方**的 ctx（`asar:\node_modules\@deepseek-ai\cordis\lib\index.js:87-88` `createTraceable(ctx, value, tracker)`，`dsh-tools` 的 `EventsService`/`ToolRuntime` 都 `defineProperty(this, symbols.tracker, { property: 'ctx' })`）。因此在 `apply(ctx)` 里调 `ctx.tools.register(...)`，注册跟着这个插件 fiber 一起卸载。
- 更稳的写法（soul-memory 同款）：包在 `ctx.effect` 里显式收：

```js
ctx.effect(() => {
  const disposers = [ctx.tools.register(def)]
  return () => { for (const d of disposers) { try { d() } catch { /* 已卸载 */ } } }
}, 'decision-model.tools()')
```
证据：`profile:\dsh-soul-memory\index.js:194-220`。

### 2.6 例子：带 `exec.agent` 的完整真实工具

`profile:\@local\pawbot\index.js:627-643` 里 `fetch` 直接在工具体里用（**证明 Host 插件可以直接 fetch**）：

```js
const res = await fetch(url, { headers, signal: AbortSignal.timeout(timeout) })
const json = await res.json()
```

---

## 3. 契约 2：`tools/pre-execute`（waterfall gate）

### 3.1 事件签名（逐字）

`pkg:@deepseek-ai/dsh-tools/lib/types/index.d.ts`：

```ts
'tools/pre-execute'(
  this: Scoped<ToolRuntime>,
  exec: ToolExecution,
  next: () => Promise<PreToolDecision>
): Promise<PreToolDecision>;
```

> 允许、拒绝、取消或询问后再派发。`next()` 等于 allow；`cancel` 走规范的「派发前取消」结果；**缺少 approval 支持时 `ask` 退化为 deny**。异步 gate 必须观察 `exec.signal`；注册表在它们 settle 后会重新检查取消，但**永远不会放弃等它们的 promise**。

`exec` 的字段：`callId / rootCallId / name / arguments / agent? / parent? / schema? / signal / token`（同 §2.1 的 `ToolExecution`，**没有** `deferContext`）。

### 3.2 `PreToolDecision` 完整联合（逐字，只有 4 种）

```ts
type PreToolDecision =
  | { kind: 'allow' }
  | { kind: 'deny';   reason: string; info?: ToolErrorInfo }
  | { kind: 'cancel' }
  | { kind: 'ask';    reason?: string; displayReason?: { readonly en: string; readonly [locale: string]: string } };
```

`ToolErrorInfo = { name: string; code: string; reason?: string }`。

**注意**：`allow` 没有「附加文本」字段，`deny` 只有 `reason`（会被拼成模型看到的 `Error: <reason>`）。**不能改写 `exec.arguments`**——这是设计上的限制，d.ts/README 原话：

> **`tools/pre-execute` deliberately cannot rewrite `exec.arguments`** — logged and rendered args would desync from what ran.

### 3.3 `allow/deny/cancel/ask` 的真实落地（读注册表实现）

`asar:\node_modules\@deepseek-ai\dsh-tools\lib\index.js` 的 `prepareExecution`：

```js
const gate = await this.ctx.waterfall(carrier, "tools/pre-execute", exec, () => Promise.resolve({ kind: "allow" }));
const askResolution = gate.kind === "ask" ? await this.serviceAsk(exec, gate) : { decision: gate, approvalCancelled: false };
…
if (decision.kind === "cancel") return … toolAbortedBeforeDispatchResult()   // ABORTED_BEFORE_DISPATCH，不算 deny
const denialReason = decision.kind === "allow" ? this.guardReason(exec) : decision.reason;  // ← guard 只在 allow 时跑
const denialInfo  = decision.kind === "deny" ? decision.info : void 0;
if (denialReason !== void 0) return … { content: [{ type: "text", text: `Error: ${denialReason}` }], isError: true, error: { message, info } }
```

- `deny` → 模型看到 **`Error: <reason>`**，`isError: true`，`info` 只进日志投影、不进模型内容。
- `cancel` → 规范化的「派发前取消」，**不会**给模型一句人话理由。
- `allow` → 还会再跑 `ctx.tools.guard()` 链（同步、只能拒）。
- listener 抛错 → 整个 `prepareExecution` 的 catch 把它变成 `toolErrorResult(error)`（`isError`），**不会**静默放行。所以「决策 API 挂了」要自己 catch 并显式决定 allow 还是 deny。

### 3.4 直接照抄的真实范例（`dsh-experimental-auto-review`）

`asar:\node_modules\@deepseek-ai\dsh-experimental-auto-review\lib\index.js`（官方 auto 审批插件，就是「拦截 → await 外部判定 → allow/deny/ask」）：

```js
ctx.effect(function* () {
  yield ctx.on("tools/pre-execute", async (exec, next) => {
    const agent = exec.agent;
    if (agent === void 0 || (exec.parent === void 0 && exec.name === RUN_CODE_NAME)) return next();
    if (permissionPresets.current(agent.session) !== AUTO_PRESET) return next();
    if (!accepting || lifecycle.signal.aborted) return { kind: "cancel" };
    …
    const review = await classifyRisk(ctx, agent, exec, AbortSignal.any([exec.signal, lifecycle.signal]))
      .then((decision) => ({ ok: true, decision }), (error) => ({ ok: false, error }));
    if (!review.ok) return failed(exec, review.error);              // deny + 具体错误
    const { decision } = review;
    if (decision.decision === "deny" && ctx.approval.overrideOf(agent.session) === "never")
      return denied(exec, decision.reason);                        // deny
    const downstream = await next();                               // 先让下游决定
    if (decision.decision === "allow" || downstream.kind !== "allow") return downstream;
    return askUser(exec, decision.reason);                         // ask（把下游的 allow 升级成人工确认）
  });
});
```

它的 deny / ask 构造（同文件），可直接改成我们的文案：

```js
function denied(exec, reason) {
  return {
    kind: "deny",
    reason: `Decision model rejected tool "${exec.name}"; its body was not executed`,
    info: { name: "DECISION_DENIED", code: "DECISION_DENIED", ...(reason === undefined ? {} : { reason }) },
  }
}
function askUser(exec, reason) {
  return {
    kind: "ask",
    reason: reason ?? `Decision model rejected tool "${exec.name}"`,
    displayReason: { en: `Approve this call? ${reason ?? ""}`, zh: `要放行这次调用吗？${reason ?? ""}` },
  }
}
```

### 3.5 给我们插件的最小实现（可直接抄）

```js
/* 门控集合：用户说的调度类工具 */
const DEFAULT_GATED = ['subagent', 'subagent_fork', 'subagent_codex', 'subagent_claude_code',
                       'spawn_teammate', 'ralph', 'workflow']

function installGate(ctx, config, state) {
  const gated = new Set(config.gatedTools?.length ? config.gatedTools : DEFAULT_GATED)
  ctx.on('tools/pre-execute', async (exec, next) => {
    if (!gated.has(exec.name)) return next()          // 不是调度类 → 原样放行（必须 return next()）
    if (exec.parent !== undefined) return next()      // PTC 子派发，别重复门控（可选）

    const agent = exec.agent
    const sessionId = agent?.session?.id              // 证据：dsh-tools lib/index.js:1531 用 exec.agent.session.id
    const args = exec.arguments ?? {}                 // frozen；不要改（改了会与日志/展示不一致）
    const signal = AbortSignal.any([exec.signal, AbortSignal.timeout(config.timeoutMs)])

    let judged
    try {
      judged = await state.decider.judge({
        tool: exec.name,
        sessionId,
        // 只取有意义的字段，别把整个 args 塞进去（可能含大段 prompt）
        summary: typeof args.prompt === 'string' ? args.prompt
               : typeof args.description === 'string' ? args.description
               : JSON.stringify(args).slice(0, 2000),
      }, signal)
    } catch (error) {
      // 决策不可用时的策略：enforce=拒；advisory=放行（默认）
      if (config.mode === 'enforce') {
        return { kind: 'deny', reason: `决策模型不可用，已按 enforce 策略拦截 ${exec.name}：${String(error?.message ?? error)}` }
      }
      return next()
    }

    if (judged.action === 'allow') return next()
    if (judged.action === 'ask') {
      return { kind: 'ask', reason: judged.reason, displayReason: { en: judged.reason, zh: judged.reason } }
    }
    // deny：reason 就是模型看到的 Error: 文案 → 把建议写进去
    return { kind: 'deny', reason: judged.reason, info: { name: 'DecisionDenied', code: 'DECISION_DENIED' } }
  })
}
```

要点：
- 所有分支**要么 `return next()`，要么返回一个 decision**；返回 `undefined` 会让下游拿到 `undefined` 并炸（waterfall 不兜底）。`next()` 本身返回的就是下游 decision，直接透传最安全。
- 别忘 `exec.signal`：外部 HTTP 必须能取消；注册表会等你 settle，不会替你 kill。
- `ask` 依赖 `approval` service；没有它时注册表把 `ask` 当作 deny（`serviceAsk` 注释：*a deployment that composes no ApprovalService keeps the historical degrade to deny*）。

---

## 4. 契约 3：`tools/post-execute`（能否追加内容：能）

### 4.1 签名与类型（逐字）

```ts
'tools/post-execute'(
  this: Scoped<ToolRuntime>,
  exec: ToolExecution,
  result: Readonly<ToolExecutionResult>,
  next: () => Promise<PostToolDecision>
): Promise<PostToolDecision>;

type PostToolDecision =
  | { kind: 'accept'; content?: ContentBlock[]; value?: never; additionalContexts?: UserMessage[] }
  | { kind: 'accept'; value: JsonValue;          content?: never; additionalContexts?: UserMessage[] }
  | { kind: 'block';  feedback: ContentBlock[];  additionalContexts?: UserMessage[] };
```

`ToolExecutionResult = ToolExecutionSuccess | ToolExecutionFailure`：

```ts
{ isError: false; value: JsonValue; content: ContentBlock[]; meta?; additionalContexts?: UserMessage[]; concludesTurn?: true }
{ isError: true;  error: { message, info? }; content: ContentBlock[]; meta?; additionalContexts?: UserMessage[] }
```

### 4.2 实现细节（决定「怎么追加才安全」）

`asar:\node_modules\@deepseek-ai\dsh-tools\lib\index.js` 的 `postExecute`：

```js
const decision = await this.ctx.waterfall(scopeTarget(this, exec.agent), "tools/post-execute", exec, result, () => Promise.resolve({ kind: "accept" }));
const decisionContexts = decision.additionalContexts ?? [];
if (decision.kind === "block") { …isError: true, content: decision.feedback, error: {message: failureMessageFromContent(feedback)} }
if (Object.hasOwn(decision, "content") && Object.hasOwn(decision, "value")) throw new TypeError("… cannot replace both value and content");
const additionalContexts = [...(result.additionalContexts ?? []), ...decisionContexts];   // ← 原 result 的 context 自动保留
if (Object.hasOwn(decision, "value")) { if (result.isError) throw new TypeError("… cannot replace the value of a failed result"); … }
return { ...result, ...(decision.content !== undefined ? { content: decision.content } : {}), ...(additionalContexts.length ? { additionalContexts } : {}) };
```

结论：
- `accept` + `content` → **替换** content（不是追加），`value` / `meta` / `isError` 保留。**要追加就自己拼**。
- `accept` + `value` → 用你的新 value **重新跑 `output.render`**，得到全新 content；失败结果不能换 value；`value` 与 `content` 同时出现 → `TypeError`。
- `block` → 把成功**变成** `isError: true`，content = `feedback`。**对子代理结果用 block 等于丢弃结果**，别用。
- 原 `additionalContexts` 会自动保留（`[...result.additionalContexts, ...decisionContexts]`）。
- 抛错的 listener → 整个 `execute` 外层 catch 把结果变 `isError`（会毁掉子代理结果）。**listener 里必须 try/catch**。

### 4.3 安全写法（保留原结果 + 不吞掉下游决策）

```js
ctx.on('tools/post-execute', async (exec, result, next) => {
  const downstream = await next()                       // ① 先让下游（别的插件）决定，别抢
  if (!gated.has(exec.name)) return downstream
  if (downstream.kind !== 'accept') return downstream   // ② 下游要 block 就尊重它
  if ('value' in downstream && downstream.value !== undefined) return downstream  // ③ 下游换了 value，别混
  if (result.isError) return downstream                 // ④ 失败结果不改
  if (alreadyAnnotated(result)) return downstream        // ⑤ 幂等（见下）

  let advice
  try {
    advice = await state.decider.evaluate(exec, result, AbortSignal.timeout(config.postTimeoutMs))
  } catch {
    return downstream                                   // ⑥ 绝不因为决策失败而毁掉子代理结果
  }
  if (!advice) return downstream

  const base = downstream.content ?? result.content      // ⑦ 原 content（可能是下游替换过的）
  return {
    kind: 'accept',
    content: [...base, { type: 'text', text: `\n\n[决策复核] ${advice}` }],
    ...(downstream.additionalContexts ? { additionalContexts: downstream.additionalContexts } : {}),
  }
})
```

`alreadyAnnotated` 建议用 `result.meta` 或 content 里最后一个 block 的固定前缀判断；`post-execute` 对**每一次**调用都跑，重复评估既费钱又会让模型看到两段建议。

### 4.4 「把建议文本带给模型」的三条路对比

| 手段 | 模型看到什么 | 时机 | 证据 |
|---|---|---|---|
| pre-execute `deny.reason` | `Error: <reason>` | 调用**不发生** | `dsh-tools` `prepareExecution` |
| post-execute `accept.content` 追加 | 工具结果末尾多一段 text | 调用**已完成** | `postExecute` |
| post-execute/pre 之外的 `additionalContexts` | 一条独立 user-role context，排在 tool/result 之后 | 下一次请求 | `postExecute` 合并 + `dsh-agent-loop` `acceptContext(result.additionalContexts)` |

`additionalContexts` 的元素是 `UserMessage`，用 `createUserMessage` 造（`pkg:@deepseek-ai/dsh-llm/lib/types/message.d.ts`）：

```js
import { createUserMessage } from '@deepseek-ai/dsh-llm'   // 注意：同样是 optional peer，可能解析不到
const context = createUserMessage({ content: [{ type: 'text', text: '[决策建议] …' }], source: { kind: 'ptc-mode' } })
```

>`source.kind` 的类型是可扩展 `MessageSourceMap`，DSH 内部用 `'ptc-mode'` / `'tool-registry'` / `'tool'` / `'model'` / `'system-prompt'`。**自定义 kind 是否被日志/投影接受未验证**，保守做法是走 `accept.content` 追加，别碰 `additionalContexts`。

---

## 5. 契约 4：`ctx.systemPrompt.section()` 与 `PromptSection`

### 5.1 类型（逐字，`pkg:@deepseek-ai/dsh-system-prompt/lib/types/index.d.ts`）

```ts
interface PromptSection {
  readonly name: string;                                        // 同层唯一，重复注册抛错
  readonly order: number;                                       // 升序拼接；同值按 name 的 code-unit 序
  readonly text: string | ((context: AssembleContext) => string); // ← 是 text，不是 content，也没有 title
  readonly interpolate?: boolean;                                // 默认 true（会做 {{变量}} 替换）
  readonly complete?: boolean;                                   // true = 整个 system prompt 只留我（多于一个生效会装配失败）
}
```

> ⚠️ **没有 `title` 字段，也没有 `content` 字段**。真实插件用法印证：`profile:\dsh-soul-memory\index.js:169-181` 用 `{ name, order, text: () => … }`。

`order` 常量（`getSectionOrder(name)` / `getContextOrder(name)` 可查，同文件 `SECTION_ORDERS`）：

```
HARNESS_IDENTITY -1000 | DEPLOYMENT_PERSONA_PREFIX 0 | PLAN_POLICY 500 | TEAM_POLICY 600 | PTC_ONLY 800
FILE_REFERENCE 900 | TOOL_BASH 1000 | TOOL_PWSH 1010 | TOOL_READ 1100 | TOOL_WRITE 1200 | TOOL_EDIT 1300
TOOL_GLOB 1400 | TOOL_GREP 1500 | TOOL_JOBS 1600 | TOOL_PTY 1700 | TOOL_WEB_SEARCH 2000 | TOOL_WEB_FETCH 2100
TOOL_LSP 2200 | TOOL_SESSION_QUERY 2300 | TOOL_GOAL 2400 | TOOL_WORKFLOW 2600 | TOOL_RALPH 2700
TOOL_SUBAGENT 2800 | TOOL_REPORT 2900 | TOOL_COMPUTER_USE 3000 | MCP_SERVERS 3100 | TOOLS_SDK 5000
DELIVERABLE_FILE_REFERENCES 9000 | STRUCTURED_OUTPUT 9900 | HARNESS_SOURCE 10000 | WEB_SURFACE 10100
DEPLOYMENT_PERSONA_SUFFIX 10200
```

**推荐**：工具使用说明放 `3150`（MCP 之后、`TOOLS_SDK` 之前），这样它排在自己的工具描述之后、SDK 之前；不要用 `0`/负数（会和身份/人设段抢位）。

### 5.2 注册示例（可直接抄）

```js
function installSection(ctx, config) {
  const TEXT = [
    '## 决策工具 decision',
    '在下列情况先用 `decision` 要一个概率化判断，再行动：',
    '- 调用 subagent / spawn_teammate / ralph / workflow 这类调度前，任务边界或拆分方式还不确定；',
    '- 几个方案各有优劣、需要按概率取舍而不是凭直觉；',
    '- 需要给方案、风险或完成度打一个等级分。',
    '把返回的 probability / 等级 / 置信度当作参考信号；置信度低时结合你自己的判断，不要卡住。',
    '模型不可用时它会返回 ok:false，按你的判断继续执行。',
  ].join('\n')

  ctx.systemPrompt.section({
    name: 'plugin:decision-model',
    order: 3150,
    text: () => TEXT,
    interpolate: false,     // ★ 重要：见 5.4
  })
}
```

### 5.3 会不会进子代理 / teammate 的提示词？——**会**

- `section()` 注册在**调用它的那个 ctx 的作用域**里；`assemble()` 是「global 层 + 作用域链」合成，且 **scoped section 只能 shadow 同名 global section**，不会移除别的 global section（d.ts：*Assemble global and scoped providers… Scoped sections and variables shadow globals*）。
- 子代理/teammate 是同一 Host 树里的独立 Agent，各自装配，`dsh-agent-loop` 每个 agent 都是 `this.loopCtx.systemPrompt.assemble(assembleContextFor(this, signal))`（`asar:\node_modules\@deepseek-ai\dsh-agent-loop\lib\index.js` 的 `preStep`），用的就是**同一个** `SystemPrompt` service。
- 子代理的「子组合」只做**增量**：`asar:\node_modules\@deepseek-ai\dsh-subagent\lib\index.js:383-395` 的 `applyChildOverrides()` 只 add `systemPrompt.context({name:'subagent:delegation'})`、可选 persona section、可选 `childCtx.tools.restrict(composition.toolFilter)`，**没有任何移除 global section 的代码**。

风险点（务必知道）：
1. 某个 agent preset 注册了 `complete: true` 的 section → **整个 prompt 只剩那一段**，我们的 section 会消失。`@local/pawbot` 的 `brainCompletePersona` 就是干这个的（`profile:\@local\pawbot\index.js:86-87`：*true＝模型只看到 PawBot 的 system，不掺 DSH 编码 agent 提示词*）。
2. `interpolate` 默认 true：文本里出现 `{{未知变量}}` → `renderPrompt` **抛错**（strict 引用），整次装配失败。

### 5.4 插值坑（很容易炸整个 prompt）

`pkg:.../dsh-system-prompt` 的 `renderPrompt` 文档：

> 严格 `{{variable}}` 引用；**其他 section 里 malformed / unknown / undefined 的引用会 throw**；孤立的 `{{` 后面没有 `}}` 才算字面散文。

我们的使用说明很可能要写 JSON 示例（`{"questions": {...}}`），一旦出现 `{{` 就有风险 → **`interpolate: false`**，或改成单花括号。同理，如果以后要把 `{{…}}` 暴露给用户配置，也要固定 false。

### 5.5 与 `context()` 的区别

`ctx.systemPrompt.context({ name, order, text, required? })` 是**动态运行时上下文**，会被物化成一条 durable 的 user-role 快照（每次装配/准入刷新），适合「当前工作目录、沙箱策略」这类事实；`section()` 才是进 system prompt 的稳定说明。我们要的是 `section()`。
证据：`PromptContext` 的 JSDoc *Dynamic model context materialized as a durable user-role snapshot*。

---

## 6. 契约 5：`export const Config`

### 6.1 结论：必须是 **Standard Schema**（实际都用 `@deepseek-ai/schemastery` 的 `z`）

`asar:\node_modules\@deepseek-ai\cordis\lib\index.js` 的 `resolveConfig`：

```js
function resolveConfig(runtime, config) {
  if (!runtime.Config) return config;
  const result = runtime.Config["~standard"].validate(config);
  if ("then" in result) throw new TypeError("Async config validation is not supported");
  if (result.issues) throw new ValidationError(result.issues);
  else return result.value;
}
```

→ **不能直接写 JSON Schema**（普通对象没有 `~standard`，会 `TypeError: Cannot read properties of undefined`）。可用：
- `@deepseek-ai/schemastery`（本机所有真实插件都用它）
- 任何 Standard Schema（zod v4 等）
- 手写 `{ '~standard': { version, vendor, validate(v) { … } } }`（代码上可行，但**未运行时验证**；且 `Config` inspect 投影到 JSON Schema 可能拿不到，设置面板会缺 schema）

### 6.2 真实例子（字段 + 元数据齐全）

`profile:\dsh-soul-memory\src\config.js`：

```js
import z from '@deepseek-ai/schemastery';
export const Config = z.object({
  root: z.string().default(DEFAULTS.root),
  persona: z.string().default(DEFAULTS.persona),
  autoInit: z.boolean().default(DEFAULTS.autoInit),
  toolNameRead: z.string().default(DEFAULTS.toolNameRead),
  toolNameUpdate: z.string().default(DEFAULTS.toolNameUpdate),
  maxFileBytes: z.number().default(DEFAULTS.maxFileBytes),
  // …
})
```

`profile:\@local\pawbot\index.js:63-122`（元数据用法最全，注意 `.role('secret')` 与 `.extra('volatile', true)`、以及拿不到 z 时**返回 undefined 降级**）：

```js
export const Config = (() => {
  if (!z) return undefined
  try {
    return z.object({
      brainModel: z.string().default(''),
      brainTimeoutMs: z.natural().default(180000),
      webuiToken: z.string().default('').role('secret').extra('volatile', true),
      autostart: z.boolean().default(true).extra('volatile', true),
    })
  } catch { return undefined }
})()
```

- `.default(x)` → 面板/加载器填默认值
- `.role('secret')` → `pawbot_config_get` 之类会遮罩（我们的 `apiKey` 应该用）
- `.extra('volatile', true)` → 改动即生效、不必重启（我们的 `endpoint/model/timeoutMs/mode` 都可标 volatile）
- `export const Config = undefined` 是**合法降级**：`resolveConfig` 里 `if (!runtime.Config) return config`，任何 config 都原样进来。

### 6.3 我们的 Config（建议形状）

```js
import z from '@deepseek-ai/schemastery'   // optional：拿不到就 Config = undefined
export const Config = (() => {
  try {
    return z.object({
      endpoint: z.string().default('https://openrouter.ai/api/alpha/decisions').extra('volatile', true),
      model: z.string().default('perplexity/pplx-decider-v1.2').extra('volatile', true),
      apiKey: z.string().default('').role('secret'),
      timeoutMs: z.natural().default(8000).extra('volatile', true),
      mode: z.union([z.const('advisory'), z.const('enforce')]).default('advisory').extra('volatile', true),
      gatedTools: z.array(z.string()).default([]),
      threshold: z.number().default(0.5),
      postAdvice: z.boolean().default(true),
    })
  } catch { return undefined }
})()
```

`z.union([z.const('a'), z.const('b')])` 的写法**未在本机真实插件里验证**（soul-memory 全是标量）。保守替代：`z.string().default('advisory')` 再在 `apply` 里归一化 + 打日志。

### 6.4 校验失败会怎样

`profile:\dsh-soul-memory\src\config.js:1-12` 的注释就是官方口径：

> The Cordis loader validates a row's `config:` block against the `Config` export of the row it names, **and rejects the row with `invalid config: $.<field> …` when validation fails**.

即：**该行不激活**（抛 `ValidationError` → 该 entry failed），同一个 profile 里别的行继续跑；模型这边表现为「插件没生效」，不是整个 Harness 起不来。UI 上具体怎么显示（插件管理器里红条？）**未验证**。

---

## 7. 契约 6：Host-only bundle 的 `package.json` + `cordis.patch.yml`

### 7.1 最小可用（官方 skill 原文，`asar:\node_modules\@deepseek-ai\dsh-agent-preset\skills\cordis-plugin-development\references\host-plugin.md`）

```json
{
  "name": "@local/my-plugin",
  "version": "1.0.0",
  "private": true,
  "type": "module",
  "exports": { ".": "./index.js" },
  "dsh": { "bundle": { "patch": "./cordis.patch.yml" } }
}
```

```yaml
- insert:
    - id: my-plugin
      name: '@local/my-plugin'
      config: {}
```

> 「A Host-only bundle needs **no dependencies, install scripts, or build tool**」。

### 7.2 带展示元数据/多入口的真实样例（`@local/pawbot`，本机已装）

`profile:\@local\pawbot\package.json`（关键字段，复制时按需删）：

```json
{
  "name": "@local/pawbot",
  "version": "1.0.0",
  "private": true,
  "type": "module",
  "description": "把 PawBot（QQ 机器人）包成 DSH 受管服务：起停、状态、日志；并内含「大肥鱼看 B 站」插件",
  "exports": {
    ".": "./index.js",
    "./client": "./client.js",
    "./bili-watch": "./bili-watch/index.js",
    "./bili-watch/locale/*.json": "./bili-watch/locale/*.json",
    "./bili-watch/icon": "./bili-watch/icon.svg",
    "./locale/*.json": "./locale/*.json",
    "./icon": "./icon.svg",
    "./package.json": "./package.json"
  },
  "files": ["index.js", "client.js", "cordis.patch.yml", "lib", "app", "bili-watch",
            "locale/en.json", "locale/zh.json", "icon.svg", "README.md", "DEPLOY.md"],
  "engines": { "dsh": ">=0.1.7-rc.1", "node": ">=22" },
  "peerDependencies": { "@deepseek-ai/dsh-tools": "*", "@deepseek-ai/schemastery": "*" },
  "peerDependenciesMeta": {
    "@deepseek-ai/dsh-tools": { "optional": true },
    "@deepseek-ai/schemastery": { "optional": true }
  },
  "dsh": { "bundle": { "patch": "./cordis.patch.yml" }, "client": { "platform": "web", "inject": ["…"] } }
}
```

`profile:\@local\pawbot\cordis.patch.yml`：

```yaml
- insert:
    - id: pawbot
      name: '@local/pawbot'
      config: {}
    - id: pawbot-bili-watch
      name: '@local/pawbot/bili-watch'      # subpath export 也能作为独立行挂载
      config: {}
```

`profile:\dsh-soul-memory\cordis.patch.yml` 展示了**覆盖/禁用已有行**（同名 `id` 覆盖整行 config；对不存在的 id 是 no-op）：

```yaml
- id: soul-md
  disabled: true

- insert:
    - id: soul-memory
      name: 'dsh-soul-memory'
```

### 7.3 给 `D:\whale\decision-model` 的建议清单

- `exports` 至少：`"."`、`"./locale/*.json"`、`"./icon"`、`"./package.json"`（插件管理器/设置页读 title/description/icon 时**不激活插件**，直接读这些导出）。`locale/en.json` + `locale/zh.json` 里写 `{"meta":{"title":"…","description":"…"}}`。
- `files`：把 `index.js`、`lib`、`cordis.patch.yml`、`locale/*.json`、`icon.svg` 全列上；**本地目录安装是链接，`files` 不生效**（skill 原文：*Local directory installation links the checkout instead, so check the files directly; `files` does not filter a linked directory*）。
- `engines.dsh`：写一个**能满足当前版本**的范围（当前 `0.2.1-rc.3`），否则 `install_bundle` 会被 engines 检查挡下（plugin_manager 文档：*Unmet DSH version requirements (engines.dsh, else DSH peer dependencies) block installation and activation*）。
- `peerDependencies` 若要声明，用 `"*"` + `peerDependenciesMeta.optional: true`（pawbot 的已验证组合）。**不要**写 `@deepseek-ai/dsh-tools: "^0.2.1"` 这种——profile 里没装它，可能被判定不满足。
- 图标：SVG/PNG/JPEG/WebP ≤ 256 KiB，必须在包内，不能是绝对路径/URL/指向包外的符号链接。

---

## 8. 契约 7：工具对哪些 agent 可见 + 命名限制

### 8.1 可见性：全局注册 → **所有 agent 都看得见**（含子代理、teammate）

- `ToolRuntime` 类注释：*Scoped registrations shadow globals; one visibility resolver feeds presentation, lookup, and dispatch.*
- `view()` 注释：可见集合 = 「**继承**来的 surface（global 层 + 作用域链上每一层祖先）→ 应用 restriction → 再叠加本层注册」。→ 在 host ctx 上 `register()` 就是 global 层，每个 agent 作用域都继承。
- 子代理：`asar:...\dsh-subagent\lib\index.js:394` 只在 `composition.toolFilter` 存在时调 `childCtx.tools.restrict(composition.toolFilter)`，并且 `restrict()` **只作用于继承来的 global 工具**、不会隐藏该子作用域自己注册的工具（`restrict()` 的 JSDoc + `view()` 注释明说这个豁免）。
- teammate：`spawn_teammate` 走 `ctx.agentTeams.spawnTeammate`，成员是同一 Host 进程里的另一个 Agent（`agentTeams.listMembers` 返回 `TeamMemberView`），因此共享同一份全局 registry。
- 会被藏掉的三种情况：
  1. 某个 agent 作用域上有人调了 `ctx.tools.restrict({deny:['decision']})` 或 preset 的 `toolFilter`；
  2. agent preset 用 `ToolRestriction.allow` 白名单；
  3. `mode: 'ptc'` 时模型**只能**直接调 `run_code`，别的工具名直调会被判 `UNKNOWN_TOOL`（nested sub-dispatch 例外）。
- 反向确认工具：`cordis_inspect_query(host/Tool/listTools)` 返回「本 agent 当前可调用的全部 schema，含 scoped 与动态注册」（本会话因 §0.1 的 input bug 暂时调不通，可用 `cordis_inspect_list` + 无 input 的 provider 再试）。

### 8.2 命名限制：**硬约束只有两条**

| 限制 | 证据 | 后果 |
|---|---|---|
| 名字 `run_code` 保留给 PTC 传输，不能注册/遮蔽 | `dsh-tools/lib/index.js` `register()`：`if (name === "run_code") throw …` | 抛错，插件不激活 |
| 同一层重名 → 失败 | soul-memory patch 注释留下过真实报错：`tool "soul_read" is already registered in this scope` | 第二个注册抛错 |

**没有**字符集/长度校验：`register()` 只做 §2.2 的三项校验，`ToolSchema` 也没有 name 正则（`dsh-tools/lib/types/json-schema.js` 只管 schema）。但**模型侧 provider 可能更严**：OpenAI 兼容端点的 function name 通常要求 `^[a-zA-Z0-9_-]{1,64}$`。**本机是否真的校验、超限会报什么，未验证**。安全做法：`[a-z0-9_]`、≤ 64 字符、全小写（本项目用 `decision` 完全没问题）。

命名风格参考（本机真实工具）：`pawbot_status` / `subagent_claude_code` / `bili_watch` / `web_search` —— 都是 `snake_case`。

---

## 9. 契约 8：插件里能用全局 `fetch` / `setTimeout` 吗？网络会被沙箱挡吗？

| 问题 | 结论 | 证据 |
|---|---|---|
| 全局 `fetch` | ✅ 能用，且是**生产验证过**的 | `profile:\@local\pawbot\index.js:636`：`await fetch(url, { headers, signal: AbortSignal.timeout(timeout) })`，这个插件的 `pawbot_health` 工具就是靠它工作的 |
| `AbortSignal.timeout` / `AbortSignal.any` | ✅ | 同上；`dsh-experimental-auto-review` 用 `AbortSignal.any([exec.signal, lifecycle.signal])` |
| `setTimeout` / `setInterval` | ✅（Node 全局） | pawbot `await new Promise((r) => setTimeout(r, 500))`（`index.js:521`）；另 cordis 还提供可自动清理的 `ctx.timeout()/ctx.interval()/ctx.debounce()`（`Service timer`，catalog 里有） |
| `process` / `node:*` / 子进程 | ✅ 无限制 | pawbot 直接 `spawn('py', ['run.py'])`、`createPawbotProxy` 起 HTTP 代理 |
| 运行环境 | DSH Host 进程内（Electron 主/工具进程自己的 Node），**不是浏览器、不是 worker、不是沙箱** | 进程表里 Host 是 `DeepSeek Harness.exe`（本机实测同时有 9 个该进程：主进程 + 渲染/工具进程）；`resources/runtime/versions.json` / `primary-runtime/runtime.json` 声明托管 Node `24.21.0`、pnpm `11.28.5` |
| 网络沙箱 | **没有**针对插件代码的网络限制。`dsh-sandbox-*` 是给 bash/pwsh/fs 等**工具**用的执行策略（`SandboxExecutionPolicy` 只在 fs/subprocess 服务签名里出现） | `ctx.subprocess.spawn` 有 sandbox 语义；`ctx.tools` 执行管线里 `sandboxPolicy` 只出现在 `fs.writeText/editText` 与 bash/pwsh 工具。**没有**任何代码把沙箱套在插件模块上 |
| 反例/边界 | 沙箱**不**保护插件。插件里 `node:fs` 能读写任意路径（pawbot 就写了 `app/data`） | 同上看 pawbot |

> 结论：`decision` 插件可以放心用 `fetch(endpoint, { signal })`。要自己设超时：`AbortSignal.any([exec.signal, AbortSignal.timeout(config.timeoutMs)])`——**两个都要**，`exec.signal` 负责用户取消，`timeout` 负责成本上限。

---

## 10. 契约 9：`plugin_manager install_bundle` 对「本地目录」到底做了什么

### 10.1 行为链（从代码反推）

1. `install_bundle({ target: "D:\\whale\\decision-model" })` → `parseInstallSpec(spec)`（`asar:\node_modules\@deepseek-ai\dsh-plugin-manager\lib\types\install-spec.js:58-87`）：绝对路径 → `{ kind: 'path', spec, path }`；**相对路径直接拒绝**（`a local path must be absolute`）。
2. 预检 manifest：`namedSpecManifest()` 读 `<path>/package.json`（`lib\index.js:402-407`）判断 `engines` / peer 是否满足。
3. 实际安装就是 pnpm：`lib\index.js:2033-2038`
   ```js
   run = await this.runPnpm(["add", spec, ...(saveExact ? ["--save-exact"] : []), ...registryArguments(registry)], …)
   ```
   → 目录 spec 在 pnpm 里落成 **`file:` + 符号链接**（不是 copy）。
4. `reconcile(before, dir, anchor, options)`（`lib\index.js:322-351`）：
   - 读新装包 manifest，**要求 `dsh.bundle.patch`**；没有就只当普通依赖并警告 `declares no dsh.bundle — installed as a plain dependency, not a profile layer`；
   - `loadOverlayPatches(...)` 加载它的 patch；
   - 把包名 push 进 profile 的 `dsh.profile.bundles`，`saveManifest()` 原子写 `profile\package.json`。
5. 新装 bundle 可以走 HMR 直接生效（官方 skill：*Installing a new bundle can activate through HMR; replacing an installed package requires restart*）。**是否有 HMR 生效取决于 `patchReload`**：`profile:\package.json` 里是 `"patchReload": "live"`。

### 10.2 落盘结果长什么样（本机实物）

`profile:\package.json`：

```json
{
  "dependencies": {
    "@local/pawbot": "link:D:/WorkBuddy/pawbot-dsh",
    "dsh-soul-memory": "file:D:/大肥鱼的活动空间/dsh-soul-memory",
    "@deepseek-ai/dsh-subagent-codex": "0.2.1-rc.3"
  },
  "dsh": { "profile": { "bundles": [
      "@deepseek-ai/dsh-base",
      "@local/pawbot",
      "dsh-soul-memory",
      "…"
  ], "patchReload": "live" } }
}
```

→ 两种写法都真实存在（`link:` 与 `file:`）；`install_bundle` 用 `pnpm add <abs path>` 时通常记录 `file:`，`node_modules\<name>` 是指向源目录的链接。**改源目录的 `index.js` 立即生效，但已加载的模块实例需要 reload/重启才换**（skill：*replacing an installed package requires restart to load a fresh JavaScript module generation*）。

### 10.3 注意

- profile 里有一个名字为 `[object Object]` 的空目录（`profile:\[object Object]`）：历史上有人把对象当 path 传给某个安装入口的产物。**install 的 target 只传一个绝对路径字符串**，不要传对象/相对路径。
- `install_bundle` 需要 `danger-full-access` 或审批；本会话审批被禁用，**我只能读不能装**。
- patch 里的 `config:` 是**整块覆盖**：`- id: decision-model` 再给 `config:` 会替换掉整行 config，不是深合并（skill：*a matching override replaces the complete `config`*）。

---

## 11. 最坑的地方（按踩坑概率排序）

1. **pre-execute 不能改写参数。** 想「先问决策模型再把 prompt 改好一点」是做不到的：`exec.arguments` 已经 frozen 且已进日志/展示。要么 `deny` + 把建议写进 `reason`（模型看到 `Error: 建议…`，然后自己重试），要么放行后在 `post-execute` 补建议。官方把这个当已知限制写在 README 的 Known Limitations 里。
2. **`@deepseek-ai/dsh-tools` 在 profile 里 import 不到。** 桌面版 `autoInstallPeers: false`；`@local/pawbot` 专门写了 `lib/hostdeps.js` 去宿主树里找，找不到还做了 `localDefineTool` 兜底。→ 本项目**直接传原始 ToolDefinition 字面量**，别 import。
3. **`output.schema` 只支持一个很小的 JSON Schema 子集**（`type/oneOf/properties/required/additionalProperties/items/enum/const` + 注释）。写了 `format`/`pattern`/`minimum` → `JsonSchemaError`，插件 apply 直接抛，整行不激活。
4. **`PromptSection` 的字段叫 `text`，不是 `content`，也没有 `title`**；`interpolate` 默认 `true`，写 `{{…}}` 可能让整次 prompt 装配抛错 → 固定 `interpolate: false`。
5. **post-execute 里不 `await next()` 就吞掉下游插件的决定**；抛异常会把子代理的成功结果变成 `isError`。必须「先 next、再判断、再叠加、全程 try/catch」。
6. **`ask` 没有 approval service 时静默降级成 deny**（`serviceAsk` 注释），在 headless/无人值守场景会表现为「莫名其妙被拒」。
7. **`mode: 'ptc'` 下场**：模型只能直接调 `run_code`，我们的 `decision` 直调会 `UNKNOWN_TOOL`。如果用户 profile 哪天开了 PTC，这是最诡异的「工具明明注册了却调不到」。
8. **`complete: true` section 会吃掉整个 prompt**（pawbot 的 `brainCompletePersona` 就是），我们的 section 会消失。
9. **Config 校验失败是「这一行不激活」**，报错是 `invalid config: $.<field>`，不会挡住 Harness 启动——但也不会有人告诉你，只有插件列表里那一行红。
10. **`cordis_inspect_query` 的 `input` 在本会话坏了**（§0.1），别浪费时间重试，直接读 .d.ts / js。

## 12. 需要在装好后运行时验证的项

| # | 待验证 | 怎么验 |
|---|---|---|
| 1 | 全局 `section` 是否真的出现在**子代理**的 system prompt 里 | 跑一次 `subagent`，看子会话的 system 消息（session log / inspector）是否含我们的段落 |
| 2 | 自定义 `additionalContexts.source.kind` 是否被 session 接受 | 用一个假 kind 跑一次，看是否报错 / 能否回放 |
| 3 | 工具名长度/字符集的 provider 侧硬限制 | 注册一个 64+ 字符或带 `/` 的名字，看模型请求是否 400 |
| 4 | Config 校验失败在 UI 的具体呈现 | 故意写错一个字段，看插件面板 |
| 5 | `install_bundle` 在无网络时对本地目录是否仍能装（pnpm lockfile 解析可能联网） | 断网安装一次 |
| 6 | `engines.dsh` 的判定口径（`>=0.2.1-rc.3` 是否接受 rc 版本比较） | 装一次看 warnings |
| 7 | `z.union([z.const(...)])` 在 schemastery 3.18 下的行为 | 面板/加载器试一次 |

---

## 附录 A：asar 导出脚本（可复现取证）

```js
// node dsh-asar.mjs list  '/dsh/node_modules/@deepseek-ai/dsh-tools/'
// node dsh-asar.mjs cat   '/dsh/node_modules/@deepseek-ai/dsh-tools/lib/index.js'
// node dsh-asar.mjs extract '/dsh/node_modules/@deepseek-ai/dsh-tools' <destDir>
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs'
import { dirname, join } from 'node:path'

const ASAR = 'C:\\Users\\Administrator\\AppData\\Local\\Programs\\DeepSeek Harness\\resources\\app.asar'
const buf = readFileSync(ASAR)
const headerPickleSize = buf.readUInt32LE(4)
const jsonLen = buf.readUInt32LE(12)
const header = JSON.parse(buf.toString('utf8', 16, 16 + jsonLen))
const contentBase = 8 + headerPickleSize
const files = []
const walk = (node, prefix) => {
  for (const [name, e] of Object.entries(node.files ?? {})) {
    const p = `${prefix}/${name}`
    if (e.files) walk(e, p); else files.push({ path: p, size: e.size, offset: Number(e.offset) })
  }
}
walk(header, '')
const [cmd, target, destDir] = process.argv.slice(2)
const readAt = (f) => buf.subarray(contentBase + f.offset, contentBase + f.offset + f.size)
if (cmd === 'list') for (const f of files) if (!target || f.path.includes(target)) console.log(`${f.size}\t${f.path}`)
else if (cmd === 'cat') { const f = files.find((x) => x.path === target); if (!f) process.exit(2); process.stdout.write(readAt(f)) }
else if (cmd === 'extract') for (const f of files.filter((x) => x.path.startsWith(target))) {
  const dest = join(destDir, f.path.replace(/^\/dsh\/node_modules\//, 'nm/'))
  mkdirSync(dirname(dest), { recursive: true })
  writeFileSync(dest, readAt(f))
}
```

## 附录 B：建议的插件骨架（把本文契约拼起来）

```js
// D:\whale\decision-model\index.js
const name = 'decision-model'
export const inject = ['tools', 'systemPrompt']

let z = null
try { z = (await import('@deepseek-ai/schemastery')).default } catch { z = null }
export const Config = z ? z.object({ /* §6.3 */ }) : undefined   // 拿不到 z 就降级（无 Config）

export function apply(ctx, config) {
  const cfg = normalize({ ...DEFAULTS, ...(config ?? {}) })
  const state = createState(ctx, cfg)          // decider + 缓存 + 单飞

  ctx.effect(() => {
    const disposers = [ctx.tools.register(decisionToolDefinition(cfg, state))]
    return () => { for (const d of disposers) try { d() } catch {} }
  }, 'decision-model.tool()')

  ctx.systemPrompt.section({ name: 'plugin:decision-model', order: 3150, text: () => USAGE_TEXT, interpolate: false })
  installGate(ctx, cfg, state)                 // ctx.on('tools/pre-execute', …)   §3.5
  if (cfg.postAdvice) installPostAdvice(ctx, cfg, state)   // ctx.on('tools/post-execute', …) §4.3

  ctx.logger?.info?.(`[decision-model] tool + section + gate ready (mode=${cfg.mode})`)
}
```
