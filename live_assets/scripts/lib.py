#!/usr/bin/env python3
"""
lib.py — shared LiveAssets library for asset matching, generation, update, save, reload, and validation

Used by generate.py, feedback.py, rewrite.py, and the plugin runtime.
"""

from __future__ import annotations

import json
import logging
import os
import glob
import re
import time
from concurrent.futures import ThreadPoolExecutor
from urllib.parse import urlparse
import requests as http_requests

log = logging.getLogger("live_assets_lib")

# ───────────────────── Config ─────────────────────

ASSETS_DIR = os.environ.get("ASSETS_DIR", "")
os.makedirs(ASSETS_DIR, exist_ok=True)

OPENCLAW_GATEWAY_URL = os.environ.get("OPENCLAW_GATEWAY_URL", "http://127.0.0.1:18789")
OPENCLAW_GATEWAY_TOKEN = os.environ.get("OPENCLAW_GATEWAY_TOKEN", "")
LIVE_ASSETS_INTERNAL_AGENT_ID = os.environ.get("LIVE_ASSETS_INTERNAL_AGENT_ID", "main").strip() or "main"

LOOPBACK_HOSTS = {"127.0.0.1", "::1", "localhost"}


def _dump_json(value) -> str:
    return json.dumps(value, ensure_ascii=False, indent=2)


def _gateway_uses_direct_connection(url: str) -> bool:
    host = (urlparse(url).hostname or "").strip().lower()
    return host in LOOPBACK_HOSTS


def _gateway_request(method: str, url: str, **kwargs):
    if _gateway_uses_direct_connection(url):
        session_factory = getattr(http_requests, "Session", None)
        if callable(session_factory):
            session = session_factory()
            try:
                session.trust_env = False
                return session.request(method.upper(), url, **kwargs)
            finally:
                close = getattr(session, "close", None)
                if callable(close):
                    close()
        kwargs = {
            **kwargs,
            "proxies": {"http": None, "https": None},
        }
    request_fn = getattr(http_requests, method.lower(), None)
    if callable(request_fn):
        return request_fn(url, **kwargs)
    return http_requests.request(method.upper(), url, **kwargs)


def log_agent_round_input(agent_name: str, round_id: str, messages: list[dict]) -> None:
    log.info("[%s][round %s][input]\n%s", agent_name, round_id, _dump_json(messages))


def log_agent_round_output(agent_name: str, round_id: str, content: str) -> None:
    log.info("[%s][round %s][output]\n%s", agent_name, round_id, content)


def notify_plugin_reload() -> dict:
    """Notify the OpenClaw plugin to reload, then poll until it responds."""
    try:
        resp = _gateway_request("POST", f"{OPENCLAW_GATEWAY_URL}/live-assets/reload", timeout=5)
        result = resp.json()
        log.info("[reload] POST /live-assets/reload → %s", result)
    except Exception as e:
        log.warning("[reload] OpenClaw gateway unreachable: %s", e)
        return {"error": str(e)}

    for i in range(6):
        time.sleep(0.3)
        try:
            check = _gateway_request("GET", f"{OPENCLAW_GATEWAY_URL}/live-assets/assets", timeout=2)
            if check.ok:
                result["confirmed"] = True
                return result
        except Exception:
            pass

    result["confirmed"] = False
    return result


# ───────────────── System Prompts (Dynamic Language) ─────────────────

MATCH_AGENT_PROMPT_ZH = """\
你是 Match Agent。根据用户的首轮发言，生成关键词匹配条件和正反测试场景。

运行时匹配机制：对用户消息做大小写不敏感的子串包含判断。
- any：同一主锚点的可替代表达，任一出现即满足（OR）
- all：与主锚点独立、但必须共同出现的限定条件（AND）
- not：任一词出现即排除

输出 JSON，格式如下：
{
  "assetId": "kebab-case, 如 weekly-report-write",
  "matching": { "any": ["任一命中的短词"], "all": ["须全部含的词"], "not": ["排除词"] },
  "positive_scenarios": ["应该匹配的场景，至少3条"],
  "negative_scenarios": ["不应该匹配的场景（相似但不同的需求），至少3条"],
  "utilityScore": 0-100
}

1. 只从用户发言中提取词汇，不要从助手回复、系统日志、工具调用结果中抄词。
2. 不要包含系统术语，如 Startup、sequence、persona、greet。
3. 先找一个主锚点：能单独代表该场景的词放进 any；彼此不可替换的不同侧面不要并列放进 any。
4. 需要共同出现才成立的独立条件放进 all。宽泛的平台名、产品名、技术名默认优先放 all，不要轻易单独放进 any。
5. not 只排除相邻混淆场景，不做兜底补丁。
6. positive_scenarios 和 negative_scenarios 都从纯用户角度编写，不包含系统术语。positive 必须全部被 matching 命中，negative 必须全部不被命中——请确保场景与 matching 逻辑一致。
7. matching 里的词只能是用户真实会说的词，不能写 contains:、!contains:、| 这类语法。
8. utilityScore (0-100) 评估匹配条件质量：特异性（能否精准区分目标场景与相似场景）和鲁棒性（对同义词、表述变化是否稳定）两者兼顾才能拿高分。

只输出 JSON。"""

MATCH_AGENT_PROMPT_EN = """\
You are a Match Agent. Based on the user's first utterance, generate keyword matching conditions and test scenarios.

Runtime matching mechanism: case-insensitive substring containment on user messages.
- any: interchangeable phrasings of the same primary anchor; any one match triggers (OR)
- all: independent constraints that must co-occur with that primary anchor (AND)
- not: if any keyword appears, the match is rejected

Output JSON in this format:
{
  "assetId": "kebab-case, e.g. weekly-report-write",
  "matching": { "any": ["keywords that trigger"], "all": ["all must be present"], "not": ["exclude keywords"] },
  "positive_scenarios": ["scenarios that should match, at least 3"],
  "negative_scenarios": ["similar but different scenarios, at least 3"],
  "utilityScore": 0-100
}

1. Extract keywords only from the user utterance, not from assistant replies, system logs, or tool results.
2. Do not include system terms such as Startup, sequence, persona, or greet.
3. Find one primary anchor first: only phrases that can represent the scene by themselves belong in any; different facets that are not interchangeable do not.
4. Put independent co-required conditions in all. Broad platform, product, or technology names should usually go to all, not any.
5. Use not only for adjacent confusing scenes, not as a generic patch.
6. positive_scenarios and negative_scenarios are written from the user's perspective only. Positives must all be matched by the matching rules; negatives must all be rejected — ensure consistency between scenarios and matching logic.
7. Matching keywords must be plain user-language words or phrases, never contains:, !contains:, or |.
8. utilityScore (0-100) assesses the matching quality: specificity (how precisely it distinguishes the target from similar scenarios) and robustness (how stable it is against synonyms and phrasing variations). A high score requires both.

Output JSON only."""

CONTROL_AGENT_PROMPT_ZH = """\
你是 Control Agent。给定匹配条件和多轮对话（含用户反馈），生成控制规则。所有规则文本、提示、重写指令都必须用中文。

输出 JSON，格式如下：
{
  "inputControl": [
    { "check": "contains:关键词", "inject": "中文行为指引", "example": {"user": ["..."], "assistant": "..."} }
  ],
  "processControl": [
    { "when": "!done:arxiv_search", "then": "require:arxiv_search", "reason": "先查 arXiv 再汇总" },
    { "then": "forbid:web_search", "reason": "用户禁止 Perplexity 搜索（当前 web_search 使用 Perplexity）" },
    { "then": "require:browser", "reason": "web_search 被禁后改用 browser 获取网页信息" }
  ],
  "outputControl": [{ "check": "!contains:关键词", "rewrite": "中文重写提示" }],
  "tools": [
    { "name": "对话中出现的工具名", "description": "工具中文描述", "parameters": {"type":"object","properties":{}}, "mockResponse": "模拟返回数据" }
  ]
}

processControl 约束规则：
- then 只有两种值：require:工具名（必须先调用该工具）或 forbid:工具名（禁止调用该工具）。
- when 支持原子条件：done:X（X 已成功调用）、!done:X（X 尚未成功，含未调用和已出错两种情况）、error:X（X 已调用且出错，X 是工具名不是错误码）；不写 when 字段则始终生效。注意：X 出错后 !done:X 和 error:X 同时为真，但 X 未调用时只有 !done:X 为真——因此"X 失败后做某事"必须用 error:X，不能用 !done:X（否则 X 被调用前就会触发）。
- when 支持递归组合：{"AND": [条件1, 条件2]}、{"OR": [条件1, 条件2]}、{"NOT": 条件}。
- 区分用户明确禁止和工具自身报错：用户明确说"不要用 X"/"禁止 X"→ 不写 when 字段，立即生效；工具出错但用户未明确禁止 → 用 when:"error:X" 条件性禁止（新对话中可重试）。
- require:X 在 X 完成后自动退激活，无需额外取消；用 when:"!done:X" 搭配 then:"require:X" 表达"X 必须先于其他工具调用"。
- 工具替换模式：当工具 A 失败/被禁且用户改用工具 B 成功时，写 forbid:A + 无条件 require:B。forbid:A 阻止重试，require:B 指明替代方案。require:B 不要用 error:A 作为 when 条件（应无条件或用 !done:B），否则新对话中 A 未出错时 B 不会被要求。
- when 和 then 必须语义一致：如果修改了 then 中的工具名，必须同步检查 when 是否仍然合理。
- reason 要说清楚为什么 forbid/require，包括用户原话和具体原因（如"当前 web_search 使用 Perplexity 作为 provider"）。

其余规则：
- inputControl 可以同时包含无条件规则和有条件规则。后续轮次确认下来的默认 guidance，优先合并进唯一的无条件 inject；只有首句里能直接观察到的触发词或短语，才写成 contains:X / !contains:X 的 check。inject 以用户自身口吻编写（"请帮我…"、"我需要…"、"回复时不要…"），不要用第三人称描述用户（"用户希望…"）。一个 check 只写一个条件，需要多个条件就拆成多条规则。check 留空表示无条件注入（每次匹配到该资产都会注入），无条件规则最多只能有一条；有条件规则（contains:X / !contains:X）数量不限。
- outputControl 只提取明确硬约束。check 描述期望状态：contains:X = 输出必须含 X，!contains:X = 输出不能含 X。冒号后不加空格，一个 check 只写一个条件。
- tools 只能从对话中实际出现的 [工具调用] 和 [工具结果] 中提取——name 与对话一致，parameters 从实际调用参数中归纳，mockResponse 反映实际返回。对话中无工具调用则 tools 留空。processControl 同理，引用的工具名必须来自对话。

只输出 JSON。"""

CONTROL_AGENT_PROMPT_EN = """\
You are a Control Agent. Given matching conditions and multi-turn conversations, generate control rules. All rule texts, prompts, and rewrite instructions must be in English.

Output JSON in this format:
{
  "inputControl": [
    { "check": "contains:keyword", "inject": "English behavior guidance", "example": {"user": ["..."], "assistant": "..."} }
  ],
  "processControl": [
    { "when": "!done:arxiv_search", "then": "require:arxiv_search", "reason": "Must search arXiv before summarizing" },
    { "then": "forbid:web_search", "reason": "User banned Perplexity search (current web_search uses Perplexity)" },
    { "then": "require:browser", "reason": "Use browser instead when web_search is forbidden" }
  ],
  "outputControl": [
    { "check": "!contains:keyword", "rewrite": "English rewrite prompt" }
  ],
  "tools": [
    { "name": "tool_name", "description": "English tool description", "parameters": {"type":"object","properties":{}}, "mockResponse": "mock response data" }
  ]
}

processControl constraint rules:
- then has exactly two forms: require:TOOL (this tool must be called before proceeding) or forbid:TOOL (this tool is blocked).
- when accepts atomic conditions: done:X (X succeeded), !done:X (X not yet succeeded — covers both "not called" and "called but errored"), error:X (X was called and errored — X is a tool name, not an error code); leave out the when field entirely to make the constraint always active. Note: after X errors, both !done:X and error:X are true; but before X is called, only !done:X is true — so "do something after X fails" must use error:X, not !done:X (which fires before X is even attempted).
- when supports recursive composition: {"AND": [cond1, cond2]}, {"OR": [cond1, cond2]}, {"NOT": cond}.
- Distinguish user-explicit bans from tool errors: if the user explicitly said "don't use X" / "stop using X" → leave out the when field (unconditional forbid); if the tool errored but the user didn't explicitly ban it → use when:"error:X" (conditional, can retry in new conversations).
- require:X auto-deactivates once X completes; pair when:"!done:X" with then:"require:X" to enforce call ordering without needing a cancel step.
- Tool replacement pattern: when tool A failed/was banned and the user switched to tool B successfully, write forbid:A + unconditional require:B. forbid:A prevents retry; require:B names the alternative. Do NOT gate require:B behind error:A (use unconditional or !done:B instead), otherwise B won't be required in new conversations where A hasn't errored yet.
- when and then must stay semantically consistent: if you change the tool in then, review whether when still makes sense.
- reason should clearly explain why the tool is forbidden/required, including the user's original words and specific context (e.g. "current web_search uses Perplexity as its provider").

Other rules:
- inputControl may include both unconditional and conditional rules. Default guidance established by later-turn user correction should be merged into the single unconditional inject; only trigger words or short phrases directly observable in the first user message should become contains:X / !contains:X checks. Write inject in the user's own voice ("Please give me…", "I need…", "Don't include…"), never describe the user in third person ("The user wants…"). Each check is atomic (contains:X or !contains:X); split multiple conditions into separate rules. An empty check means unconditional injection (fires every time the asset matches); at most one unconditional rule is allowed; conditional rules (contains:X / !contains:X) have no limit.
- outputControl extracts hard output constraints only: contains:X = output must include X, !contains:X = output must not include X; no space after colon.
- tools must be extracted from actual [tool_call] and [tool_result] entries in the conversation — name must match exactly, parameters must be derived from actual call arguments, mockResponse must reflect actual results. Leave tools empty if no tool calls appear. processControl likewise: only reference tools that appear in the conversation.

Output JSON only."""

UPDATE_GENERATE_PROMPT_ZH = """\
你是 LiveAssets Update Agent。你会收到一份已匹配的资产 JSON 和一段新的完整对话。用新对话中的证据更新这份资产。

输出与当前资产相同结构的 JSON，包含 matching、inputControl、processControl、outputControl、tools、utilityScore。

matching 更新：当前资产已经匹配到了这段对话的开始，matching 基本方向是对的。只在以下情况修改：
- 精细化：当前 matching 太宽泛，会误匹配不相关场景 → 收紧 any 或补充 not
- 扩展覆盖：新对话暴露了当前 matching 未覆盖的合理变体 → 在 any 中补充同义词
如果当前 matching 已够用，原样保留。词只能是用户会说的自然语言词汇（2-4 字），不含 contains: 等语法。不能关联到用户的非首句话语。

控制规则更新：以新对话过程中的用户反馈为主要依据。
- 先抽取后续对话里的用户 guidance，重点关注用户对策略、工具选择、顺序、输出方式的明确纠正。
- 审查现有规则是否仍然成立：
  1. 先删除已被用户纠正否定的规则
  2. 能通过修改解决的，优先修改现有规则
  3. 只有删除和修改都不够时，才新增规则
- 最后统一审查相关字段是否一致：reason 要与最终规则一致，inputControl / processControl / outputControl 中受影响的部分都要同步修改。不要把策略变化只写进 reason 或说明文字而不落实为规则。
- inputControl 只能针对首句话语更新，但可以同时包含无条件规则和有条件规则。后续轮次确认下来的默认 guidance，优先合并进唯一的无条件 inject；只有首句里直接出现的触发词或短语，才写成 contains:X / !contains:X 的 check。inject 以用户口吻编写（"请帮我…""不要…"），不用第三人称。一个 check 只写一个条件（contains:X 或 !contains:X），多个条件拆成多条规则。check 留空表示无条件注入，无条件规则最多一条；有条件规则数量不限。
- processControl 注意新对话的工具调用过程，按上面的 guidance 审查结果补充、删除或修改约束。then 只能是 require:工具名 或 forbid:工具名。用户明确禁止或明确要求某工具 → 不写 when 字段；工具报错 → when:"error:X"（error:X 按工具名匹配，不是错误码）。工具替换模式：如果用户因工具 A 失败而改用工具 B 并成功，应删除 require:A，新增 forbid:A + 无条件 require:B（forbid:A 阻止重试，require:B 指明替代）。require:B 不要用 error:A 作为 when 条件。修改 then 中的工具名时，必须同步检查 when 是否仍然合理（例：then 改为 require:browser 后，when 不应保留 !done:web_search）。
- outputControl 注意首轮与末轮回复差异，提取稳定硬约束。每项必须用字段 rewrite（不是 inject）。一个 check 只写一个条件。
- tools 只从对话中实际出现的工具调用和结果中提取，无工具调用则留空。

控制规则语法（运行时硬编码，不可偏离）：
- input/output 的 check：单个 contains:X 或 !contains:X，冒号后不加空格
- processControl 的 then：require:工具名 或 forbid:工具名，仅此两种
- processControl 的 when：done:X（X 已成功） / !done:X（X 尚未成功，含未调用和已出错） / error:X（X 已调用且出错，X 是工具名不是错误码） / 不写 when 字段则始终生效 / {"AND":[...]}, {"OR":[...]}, {"NOT":...} 递归组合

utilityScore (0-100)：特异性 × 鲁棒性。

只输出 JSON。"""

UPDATE_GENERATE_PROMPT_EN = """\
You are the LiveAssets Update Agent. You receive an already-matched asset JSON and a new full conversation. Update the asset using evidence from the new conversation.

Output a JSON object with the same structure as the current asset: matching, inputControl, processControl, outputControl, tools, utilityScore.

Matching update: The current asset already matched this conversation starting with the user's first turn, so the matching direction is correct. Only modify when:
- Refinement: current matching is too broad, catching unrelated scenarios → tighten any or add not keywords
- Expansion: new conversation reveals reasonable variants not covered → add synonyms to any
If current matching works well, keep it as-is. Keywords must be natural user-language words (2-4 words each), no contains: syntax.

Control rules update: Use user feedback in the new conversation as primary evidence.
- First extract later user guidance, especially explicit corrections about strategy, tool choice, ordering, or output format.
- Audit the current rules against that guidance:
  1. Delete rules contradicted by the user's corrections
  2. If a problem can be resolved by editing an existing rule, modify it instead of adding a new one
  3. Add a new rule only when deletion or modification is insufficient
- Finally audit consistency across affected fields: reason text must match the final rules, and any affected inputControl / processControl / outputControl entries must be revised together. Do not leave a strategy change only in explanation text; encode it in executable rules.
- inputControl: only update for the first turn, but it may include both unconditional and conditional rules. Default guidance established by later-turn user correction should be merged into the single unconditional inject; only trigger words or short phrases directly present in the first message should become contains:X / !contains:X checks. Write inject in user's voice ("Please…", "Don't…"), never third person. Each check is atomic (contains:X or !contains:X); split multiple conditions into separate rules. An empty check means unconditional injection; at most one unconditional rule allowed; conditional rules have no limit.
- processControl: pay attention to tool call flow in the new conversation and update constraints according to the guidance audit above. then is only require:TOOL or forbid:TOOL. User explicitly banned or explicitly required a tool → leave out the when field; tool errored → when:"error:X" (error:X matches by tool name, not error code). Tool replacement pattern: if tool A failed and the user switched to tool B successfully, delete require:A and add forbid:A + unconditional require:B (forbid:A prevents retry, require:B names the replacement). Do NOT gate require:B behind error:A. When changing the tool in then, always check that when still makes sense (e.g., after changing then to require:browser, when must not remain !done:web_search).
- outputControl: focus on difference between first and final reply, extract stable hard constraints. Each item must use the field rewrite (not inject). Each check must stay atomic.
- tools: extract only from actual tool calls and results in the conversation; leave empty if none.

Control rule syntax (hardcoded at runtime, must not deviate):
- input/output check: single contains:X or !contains:X, no space after colon
- processControl then: require:TOOL or forbid:TOOL, these two forms only
- processControl when: done:X (X succeeded) / !done:X (X not yet succeeded — true both before X is called and after X errors) / error:X (X was called and errored — X is a tool name, not an error code) / leave out when entirely to make the constraint always active / {"AND":[...]}, {"OR":[...]}, {"NOT":...} recursive composition

utilityScore (0-100): specificity × robustness.

Output JSON only."""

REUSE_SYSTEM_PROMPT = """\
你是一个 AI 助手。请严格按照下面的行为指引回复用户。

{asset_guidance}

注意：
- 严格遵守输出约束，违反的表达绝对不能出现
- 参考示例的风格和长度，但不要照抄
- 优先满足用户的最新反馈"""

UPDATER_SYSTEM_PROMPT = """\
你是 LiveAssets 更新器。给定当前资产 JSON、完整对话历史（含用户反馈），你需要：
1. 分析用户反馈指出了什么问题
2. 定位资产中哪条规则导致了这个问题
3. 直接修改资产 JSON 来解决问题

返回 JSON（两个顶层字段）：
{
  "reasoning": {
    "problem": "用户反馈的核心问题",
    "root_cause": "资产中具体哪条规则/缺失导致了问题",
    "changes": "你做了哪些修改、为什么"
  },
  "asset": { ... 修改后的完整资产 JSON ... }
}

修改规则：
- 只改必要字段（inputControl / processControl / outputControl / tools）
- assetId、scenarioId、version、updateLog 不要碰，Python 管版本
- 修改要精准，不要大改不相关的规则"""

JUDGE_SYSTEM_PROMPT = """\
你是一个独立的验证官。给定用户反馈和修改后的实际输出，判断：
"这个输出是否解决了用户反馈的所有问题？"

返回 JSON：
{
  "will_satisfy": true/false,
  "reason": "逐条说明每个反馈点是否被解决"
}"""

VALIDATE_JUDGE_SYSTEM_PROMPT = """\
你是一个资产验证官。给定原始对话中用户的反馈（第2轮起的批评/修改要求），
以及资产约束后对第1轮输入的新回复，请判断：
"新回复是否已经规避了这些原始反馈？"

返回 JSON：
{
  "pass": true/false,
  "reason": "逐条说明哪些反馈被规避了，哪些没有"
}"""

REWRITE_OUTPUT_SYSTEM_PROMPT = """\
你是一个输出约束重写器。你会收到：
1. 过滤后的对话历史
2. 当前助手草稿
3. 必须满足的输出约束
4. 当前失败原因

你的任务：
- 只重写“当前助手草稿”
- 保留原意，不要新增对话里没有依据的事实
- 严格满足所有输出约束
- 不要解释修改过程，不要提到约束本身
- 只输出最终回复正文"""


# ──────────────── 匹配 ────────────────

def match_asset(asset: dict, text: str) -> bool:
    m = asset.get("matching", {})
    lower = text.lower()

    any_kws = m.get("any", [])
    if any_kws and not any(k.lower() in lower for k in any_kws):
        return False

    all_kws = m.get("all", [])
    if all_kws and not all(k.lower() in lower for k in all_kws):
        return False

    not_kws = m.get("not", [])
    if not_kws and any(k.lower() in lower for k in not_kws):
        return False

    return True


# ──────────────── 资产 I/O ────────────────

def load_assets() -> list[dict]:
    assets = []
    for f in sorted(glob.glob(os.path.join(ASSETS_DIR, "*.json"))):
        with open(f, encoding="utf-8") as fh:
            assets.append(canonicalize_asset(json.load(fh)))
    return assets


def canonicalize_example(example) -> list | None:
    """Normalize example to messages array, accepting both old {user,assistant} and new [{role,content}] formats."""
    # New format: list of {role, content}
    if isinstance(example, list):
        msgs = [
            {"role": m["role"], "content": m["content"].strip()}
            for m in example
            if isinstance(m, dict) and isinstance(m.get("role"), str)
            and isinstance(m.get("content"), str) and m["content"].strip()
        ]
        return msgs if len(msgs) >= 2 else None
    # Old format: {user: str|list, assistant: str}
    if not isinstance(example, dict):
        return None
    user = example.get("user", "")
    assistant = example.get("assistant", "")
    if not isinstance(assistant, str) or not assistant.strip():
        return None
    msgs = []
    if isinstance(user, list):
        for item in user:
            if isinstance(item, str) and item.strip():
                msgs.append({"role": "user", "content": item.strip()})
    elif isinstance(user, str) and user.strip():
        msgs.append({"role": "user", "content": user.strip()})
    if not msgs:
        return None
    msgs.append({"role": "assistant", "content": assistant.strip()})
    return msgs


def _validate_matching_keywords(matching: dict, context: str) -> None:
    for field in ("any", "all", "not"):
        for index, value in enumerate(matching.get(field, []) or []):
            if not isinstance(value, str):
                continue
            normalized = value.strip()
            if not normalized:
                continue
            if "|" in normalized or normalized.startswith("contains:") or normalized.startswith("!contains:"):
                raise ValueError(
                    f"{context} {field}[{index}] 必须是裸词或短语，不支持 contains:/!contains:/| 语法: {normalized}"
                )


def _validate_atomic_checks(rules: list[dict], section: str, context: str) -> None:
    unconditional_count = 0
    for index, rule in enumerate(rules or []):
        if not isinstance(rule, dict):
            continue
        check = rule.get("check")
        if not isinstance(check, str):
            continue
        normalized = check.strip()
        if not normalized:
            unconditional_count += 1
            if unconditional_count > 1:
                raise ValueError(
                    f"{context} {section} 无条件规则（check 留空）最多只能有一条，当前第 {index} 项是第 {unconditional_count} 条"
                )
            continue
        if "|" in normalized:
            raise ValueError(
                f"{context} {section}[{index}].check 不支持 | 复合语法，请拆成多条规则: {normalized}"
            )
        if not parse_output_check(normalized):
            raise ValueError(
                f"{context} {section}[{index}].check 必须是 contains:关键词 或 !contains:关键词（留空则无条件注入）: {normalized}"
            )


def _validate_rule_text_fields(rules: list[dict], section: str, text_field: str, context: str) -> None:
    if not isinstance(rules, list):
        raise ValueError(f"{context} {section} 必须是数组")
    for index, rule in enumerate(rules):
        if not isinstance(rule, dict):
            raise ValueError(f"{context} {section}[{index}] 必须是对象")
        text = rule.get(text_field)
        if not isinstance(text, str) or not text.strip():
            raise ValueError(
                f"{context} {section}[{index}].{text_field} 必须是非空字符串"
            )


def _validate_tools_contract(tools: list[dict] | None, context: str) -> None:
    if tools is None:
        return
    if not isinstance(tools, list):
        raise ValueError(f"{context} tools 必须是数组")
    for index, tool in enumerate(tools):
        if not isinstance(tool, dict):
            raise ValueError(f"{context} tools[{index}] 必须是对象")
        name = tool.get("name")
        description = tool.get("description")
        mock_response = tool.get("mockResponse")
        parameters = tool.get("parameters", {})
        if not isinstance(name, str) or not name.strip():
            raise ValueError(f"{context} tools[{index}].name 必须是非空字符串")
        if not isinstance(description, str) or not description.strip():
            raise ValueError(f"{context} tools[{index}].description 必须是非空字符串")
        if not isinstance(mock_response, str) or not mock_response.strip():
            raise ValueError(f"{context} tools[{index}].mockResponse 必须是非空字符串")
        if not isinstance(parameters, dict):
            raise ValueError(f"{context} tools[{index}].parameters 必须是对象")


def _is_valid_condition_expr(expr) -> bool:
    if expr in (None, ""):
        return True
    if isinstance(expr, str):
        normalized = expr.strip()
        if not normalized:
            return True
        if normalized == "isError":
            return True
        if normalized.startswith("done:"):
            return bool(normalized[5:].strip())
        if normalized.startswith("!done:"):
            return bool(normalized[6:].strip())
        if normalized.startswith("error:"):
            return bool(normalized[6:].strip())
        return False
    if not isinstance(expr, dict):
        return False
    if set(expr.keys()) != {"AND"} and set(expr.keys()) != {"OR"} and set(expr.keys()) != {"NOT"}:
        return False
    if "AND" in expr or "OR" in expr:
        key = "AND" if "AND" in expr else "OR"
        items = expr.get(key)
        return isinstance(items, list) and all(_is_valid_condition_expr(item) for item in items)
    return _is_valid_condition_expr(expr.get("NOT"))


def _validate_process_constraints(ctrl: list | None, context: str) -> None:
    constraints = ctrl or []
    if not isinstance(constraints, list):
        raise ValueError(f"{context} processControl 必须是数组")
    for index, constraint in enumerate(constraints):
        if not isinstance(constraint, dict):
            raise ValueError(f"{context} processControl[{index}] 必须是对象")
        if not _is_valid_condition_expr(constraint.get("when")):
            raise ValueError(
                f"{context} processControl[{index}].when 只能使用 done:/!done:/error:/isError 或 AND/OR/NOT 组合"
            )
        then = constraint.get("then")
        if not isinstance(then, str):
            raise ValueError(f"{context} processControl[{index}].then 必须是字符串")
        normalized_then = then.strip()
        if normalized_then.startswith("require:"):
            tool_name = normalized_then[8:].strip()
        elif normalized_then.startswith("forbid:"):
            tool_name = normalized_then[7:].strip()
        else:
            raise ValueError(
                f"{context} processControl[{index}].then 必须是 require:工具名 或 forbid:工具名: {normalized_then}"
            )
        if not tool_name:
            raise ValueError(
                f"{context} processControl[{index}].then 缺少工具名: {normalized_then}"
            )


def _validate_asset_contracts(asset: dict, context: str) -> None:
    matching = asset.get("matching")
    if isinstance(matching, dict):
        _validate_matching_keywords(matching, context)
    _validate_atomic_checks(asset.get("inputControl", []), "inputControl", context)
    _validate_rule_text_fields(asset.get("inputControl", []), "inputControl", "inject", context)
    _validate_atomic_checks(asset.get("outputControl", []), "outputControl", context)
    _validate_rule_text_fields(asset.get("outputControl", []), "outputControl", "rewrite", context)
    _validate_process_constraints(asset.get("processControl"), context)
    _validate_tools_contract(asset.get("tools"), context)


def canonicalize_asset(asset: dict, *, validate_contracts: bool = False) -> dict:
    if validate_contracts:
        _validate_asset_contracts(asset, "asset")
    normalized = dict(asset)
    rules = []
    for rule in asset.get("inputControl", []):
        if not isinstance(rule, dict):
            continue
        next_rule = dict(rule)
        example = canonicalize_example(rule.get("example"))
        if example is None:
            next_rule.pop("example", None)
        else:
            next_rule["example"] = example
        rules.append(next_rule)
    if "inputControl" in asset:
        normalized["inputControl"] = rules
    return normalized


def normalize_controls(controls: dict | None) -> dict:
    source = controls if isinstance(controls, dict) else {}
    process = source.get("processControl")
    if not isinstance(process, list):
        # 兼容旧格式 {"constraints": [...]}
        process = (process.get("constraints", []) if isinstance(process, dict) else [])
    return {
        "inputControl": source.get("inputControl", []) if isinstance(source.get("inputControl", []), list) else [],
        "processControl": process,
        "outputControl": source.get("outputControl", []) if isinstance(source.get("outputControl", []), list) else [],
        "tools": [
            t for t in (source.get("tools", []) if isinstance(source.get("tools", []), list) else [])
            if isinstance(t, dict) and isinstance(t.get("mockResponse"), str) and t.get("mockResponse", "").strip()
        ],
    }


def parse_input_checks(chk: str) -> list[tuple[str, str]]:
    checks = []
    for part in str(chk or "").split("|"):
        normalized = part.strip()
        if not normalized:
            continue
        if normalized.startswith("!contains:"):
            keyword = normalized[10:].strip()
            if keyword:
                checks.append(("not_contains", keyword))
            continue
        if normalized.startswith("contains:"):
            keyword = normalized[9:].strip()
            if keyword:
                checks.append(("contains", keyword))
    return checks


def build_input_augmentation_text(rules: list[dict] | None, query: str) -> str:
    variants = build_input_augmentation_variants(rules, query)
    return variants[0] if variants else ""


def _input_augmentation_style(query: str) -> dict[str, str]:
    lang = detect_language(query)
    if lang == "zh":
        return {
            "prompt_join": "；",
            "part_join": "。",
            "example_prefix": "参考对话：",
            "user_label": "用户",
            "assistant_label": "助手",
            "arrow": " → ",
            "trailing_stop": "。",
            "wrap_example": "quoted",
        }
    return {
        "prompt_join": "; ",
        "part_join": ". ",
        "example_prefix": "Example conversation: ",
        "user_label": "User",
        "assistant_label": "Assistant",
        "arrow": " -> ",
        "trailing_stop": ".",
        "wrap_example": "colon",
    }


def _contains_cjk(text: str) -> bool:
    return bool(re.search(r'[\u4e00-\u9fff\u3400-\u4dbf]', text))


def build_input_augmentation_variants(rules: list[dict] | None, query: str) -> list[str]:
    prompts: list[str] = []
    examples: list[list[dict]] = []
    lower = query.lower()
    style = _input_augmentation_style(query)

    for rule in rules or []:
        if not isinstance(rule, dict):
            continue
        check_str = (rule.get("check") or "").strip()
        if not check_str:
            # Empty check → unconditional inject (mirrors TS buildInput)
            inject = rule.get("inject")
            if isinstance(inject, str) and inject.strip():
                prompts.append(inject.strip())
            example = canonicalize_example(rule.get("example"))
            if example:
                examples.append(example)
            continue

        checks = parse_input_checks(check_str)
        if not checks:
            continue
        positives = [keyword for kind, keyword in checks if kind == "contains"]
        negatives = [keyword for kind, keyword in checks if kind == "not_contains"]
        pos_ok = not positives or any(keyword.lower() in lower for keyword in positives)
        neg_ok = all(keyword.lower() not in lower for keyword in negatives)
        if not (pos_ok and neg_ok):
            continue

        inject = rule.get("inject")
        if isinstance(inject, str) and inject.strip():
            prompts.append(inject.strip())
        example = canonicalize_example(rule.get("example"))
        if example:
            examples.append(example)

    if not prompts and not examples:
        return []

    guidance = style["prompt_join"].join(dict.fromkeys(prompts))
    parts = []
    if guidance:
        parts.append(guidance)
    if examples:
        conv = style["arrow"].join(
            (
                (
                    f"{style['user_label']}「{message.get('content', '')}」"
                    if style["wrap_example"] == "quoted"
                    else f"{style['user_label']}: {message.get('content', '')}"
                )
                if message.get("role") == "user"
                else (
                    f"{style['assistant_label']}「{message.get('content', '')}」"
                    if style["wrap_example"] == "quoted"
                    else f"{style['assistant_label']}: {message.get('content', '')}"
                )
            )
            for message in examples[0]
        )
        if conv:
            parts.append(f"{style['example_prefix']}{conv}")
    rendered = style["part_join"].join(parts)
    return [rendered, f"{rendered}{style['trailing_stop']}"] if rendered else []


_PROCESS_CONTROL_LINE_RE = re.compile(
    r"^(?:"
    r"You MUST call \S+ before giving any text response.*\."
    r"|Do NOT call \S+.*\."
    r"|回复前必须先调用工具 \S+.*。"
    r"|禁止调用工具 \S+.*。"
    r")$"
)


def _strip_process_control_lines(text: str) -> str:
    """Remove trailing processControl guidance lines appended by runtime."""
    lines = text.split("\n")
    while lines and _PROCESS_CONTROL_LINE_RE.match(lines[-1].strip()):
        lines.pop()
    return "\n".join(lines).rstrip()


def strip_input_augmentation_from_user_turn(text: str, asset: dict) -> str:
    cleaned = text.strip()
    if "\n\n" not in cleaned:
        return cleaned

    parts = cleaned.split("\n\n")
    for split_index in range(len(parts) - 1, 0, -1):
        prefix = "\n\n".join(parts[:split_index]).strip()
        suffix = "\n\n".join(parts[split_index:]).strip()
        if not prefix or not suffix:
            continue
        augmentations = build_input_augmentation_variants(asset.get("inputControl", []), prefix)
        # Try exact match first, then match after stripping processControl lines
        if suffix in augmentations:
            return prefix
        suffix_no_pc = _strip_process_control_lines(suffix)
        if suffix_no_pc != suffix and suffix_no_pc in augmentations:
            return prefix
    return cleaned


def strip_input_augmentation_from_user_turn_any_asset(text: str, assets: list[dict] | None) -> str:
    cleaned = text.strip()
    for asset in assets or []:
        stripped = strip_input_augmentation_from_user_turn(cleaned, asset)
        if stripped != cleaned and match_asset(asset, stripped):
            return stripped
    return cleaned


def strip_known_input_augmentations(sample: dict, assets: list[dict] | None) -> tuple[dict, int]:
    turns = sample.get("user_turns", [])
    if not isinstance(turns, list):
        return sample, 0

    next_turns = []
    stripped_count = 0
    for turn in turns:
        if not isinstance(turn, str):
            next_turns.append(turn)
            continue
        cleaned = strip_input_augmentation_from_user_turn_any_asset(turn, assets)
        if cleaned != turn.strip():
            stripped_count += 1
        next_turns.append(cleaned)

    if stripped_count == 0:
        return sample, 0

    updated = dict(sample)
    updated["user_turns"] = next_turns
    return updated, stripped_count


def strip_update_input_augmentation(sample: dict, asset: dict) -> tuple[dict, int]:
    turns = sample.get("user_turns", [])
    if not isinstance(turns, list):
        return sample, 0

    next_turns = []
    stripped_count = 0
    for turn in turns:
        if not isinstance(turn, str):
            next_turns.append(turn)
            continue
        cleaned = strip_input_augmentation_from_user_turn(turn, asset)
        if cleaned != turn.strip():
            stripped_count += 1
        next_turns.append(cleaned)

    if stripped_count == 0:
        return sample, 0

    updated = dict(sample)
    updated["user_turns"] = next_turns
    return updated, stripped_count


def build_live_assets_session_key(purpose: str) -> str:
    env_key = f"LIVE_ASSETS_{purpose.upper().replace('-', '_')}_SESSION_KEY"
    configured = os.environ.get(env_key, "").strip()
    if configured:
        return configured
    token = "".join(ch if ch.isalnum() or ch in "-_" else "-" for ch in purpose.strip().lower()).strip("-")
    token = token or "internal"
    return f"agent:{LIVE_ASSETS_INTERNAL_AGENT_ID}:live-assets-{token}"


def openclaw_chat(messages: list[dict], *, purpose: str, response_format: dict | None = None) -> str:
    session_key = build_live_assets_session_key(purpose)
    headers = {
        "Content-Type": "application/json",
        "x-openclaw-agent-id": LIVE_ASSETS_INTERNAL_AGENT_ID,
        "x-openclaw-session-key": session_key,
        "x-openclaw-passthrough": "true",
    }
    if OPENCLAW_GATEWAY_TOKEN:
        headers["Authorization"] = f"Bearer {OPENCLAW_GATEWAY_TOKEN}"
    payload = {
        "model": f"openclaw:{LIVE_ASSETS_INTERNAL_AGENT_ID}",
        "messages": messages,
    }
    if response_format is not None:
        payload["response_format"] = response_format
    log.info("[openclaw_chat] purpose=%s session=%s", purpose, session_key)
    resp = _gateway_request(
        "POST",
        f"{OPENCLAW_GATEWAY_URL}/v1/chat/completions",
        headers=headers,
        json=payload,
        timeout=300,
    )
    if not resp.ok:
        raise ValueError(
            f"OpenClaw chat 调用失败 ({resp.status_code}): {resp.text[:800]}"
        )
    data = resp.json()
    choices = data.get("choices")
    if not isinstance(choices, list) or not choices:
        raise ValueError("OpenClaw chat 返回缺少 choices")
    message = choices[0].get("message", {})
    content = message.get("content", "") if isinstance(message, dict) else ""
    if not isinstance(content, str):
        raise ValueError("OpenClaw chat 返回的 content 不是字符串")
    return content


def openclaw_json_chat(messages: list[dict], *, purpose: str, agent_name: str, round_id: str) -> dict:
    log_agent_round_input(agent_name, round_id, messages)
    raw_output = openclaw_chat(
        messages,
        purpose=purpose,
        response_format={"type": "json_object"},
    )
    log_agent_round_output(agent_name, round_id, raw_output)
    parsed = json.loads(raw_output)
    if not isinstance(parsed, dict):
        raise ValueError(f"{agent_name} 必须返回 JSON 对象")
    return parsed


def save_asset(asset: dict) -> str:
    aid = asset.get("assetId", "unnamed")
    path = os.path.join(ASSETS_DIR, f"{aid}.json")
    clean = canonicalize_asset(
        {k: v for k, v in asset.items() if not k.startswith("_")},
        validate_contracts=True,
    )
    with open(path, "w", encoding="utf-8") as f:
        json.dump(clean, f, ensure_ascii=False, indent=2)
    return path


def find_matching_asset(text: str, assets: list[dict] | None = None) -> dict | None:
    if assets is None:
        assets = load_assets()
    for asset in assets:
        if match_asset(asset, text):
            return asset
    return None


# ──────────────── 生成 ────────────────

def _conversation_render_style(sample: dict) -> dict[str, object]:
    turns = sample.get("user_turns", [])
    probe = "\n".join(turn for turn in turns if isinstance(turn, str))
    if _contains_cjk(probe):
        return {
            "user_turn": lambda index: f"[用户 第{index}轮]",
            "tool_call": "[工具调用]",
            "tool_result": "[工具结果]",
            "assistant_reply": "[助手回复]",
        }
    return {
        "user_turn": lambda index: f"[user turn {index}]",
        "tool_call": "[tool_call]",
        "tool_result": "[tool_result]",
        "assistant_reply": "[assistant_reply]",
    }


def _user_turn_label(style: dict[str, object], index: int) -> str:
    return style["user_turn"](index)  # type: ignore[index,operator]


def format_conversation_simple(sample: dict) -> str:
    """Format conversation for Match Agent: user messages + tool calls only (no assistant content to avoid pollution)."""
    turns = sample.get("user_turns", [])
    outputs = sample.get("assistant_outputs", [])
    lines = []
    outputs_by_turn = _group_outputs_by_turn(outputs)
    style = _conversation_render_style(sample)

    for i, user_msg in enumerate(turns, 1):
        lines.append(f"{_user_turn_label(style, i)}: {user_msg}")
        for out in outputs_by_turn.get(i, []):
            # Only include tool calls, not the full assistant content
            if out.get("tool_calls"):
                tools = ", ".join(t["name"] for t in out["tool_calls"])
                lines.append(f"{style['tool_call']}: {tools}")
    return "\n".join(lines)


def format_conversation(sample: dict) -> str:
    """Format conversation for Control Agent: complete multi-turn dialogue including full assistant responses."""
    turns = sample.get("user_turns", [])
    outputs = sample.get("assistant_outputs", [])
    lines = []
    outputs_by_turn = _group_outputs_by_turn(outputs)
    style = _conversation_render_style(sample)

    for i, user_msg in enumerate(turns, 1):
        lines.append(f"{_user_turn_label(style, i)}: {user_msg}")
        for out in outputs_by_turn.get(i, []):
            # Include tool calls with parameters
            if out.get("tool_calls"):
                for tc in out["tool_calls"]:
                    name = tc.get("name", "")
                    params = tc.get("params", {})
                    if params:
                        params_str = json.dumps(params, ensure_ascii=False)
                        lines.append(f"{style['tool_call']}: {name}({params_str})")
                    else:
                        lines.append(f"{style['tool_call']}: {name}()")
            # Include tool results
            if out.get("tool_results"):
                for tr in out["tool_results"]:
                    name = tr.get("name", "")
                    content = tr.get("content", "")
                    is_error = tr.get("is_error", False)
                    status = " ERROR" if is_error else ""
                    if content:
                        lines.append(f"{style['tool_result']}{name}{status}: {content[:200]}")
                    else:
                        lines.append(f"{style['tool_result']}{name}{status}")
            # Include full assistant content for control rule generation
            if out.get("content"):
                lines.append(f"{style['assistant_reply']}: {out['content']}")
    return "\n".join(lines)


def _group_outputs_by_turn(outputs: list[dict]) -> dict[int, list[dict]]:
    grouped: dict[int, list[dict]] = {}
    for output in outputs:
        after_turn = output.get("after_turn")
        if not isinstance(after_turn, int):
            continue
        grouped.setdefault(after_turn, []).append(output)
    return grouped


def _normalize_tool_calls(message: dict) -> list[dict]:
    raw = message.get("toolCalls")
    if not isinstance(raw, list):
        raw = message.get("tool_calls")
    if not isinstance(raw, list):
        return []
    tool_calls = []
    for item in raw:
        if not isinstance(item, dict):
            continue
        name = str(item.get("name", "")).strip()
        if not name:
            continue
        params = item.get("params", item.get("arguments", item.get("input")))
        entry = {"name": name}
        if params is not None:
            entry["params"] = params
        tool_calls.append(entry)
    return tool_calls


def _normalize_tool_result(message: dict) -> dict | None:
    raw = message.get("toolResult")
    if not isinstance(raw, dict):
        raw = message.get("tool_result")
    if not isinstance(raw, dict):
        return None
    name = str(raw.get("name", "")).strip()
    is_error = bool(raw.get("isError", raw.get("is_error", False)))
    if not name and not is_error:
        return None
    return {"name": name, "is_error": is_error}


def format_message_conversation(conversation: list[dict]) -> str:
    """Format conversation for rewrite/update paths, preserving tool calls and tool results."""
    lines = []
    for message in conversation:
        if not isinstance(message, dict):
            continue
        role = str(message.get("role", "unknown")).strip() or "unknown"
        content = message.get("content")
        text = content.strip() if isinstance(content, str) else ""
        tool_calls = _normalize_tool_calls(message)
        tool_result = _normalize_tool_result(message)

        if role == "assistant":
            if text:
                lines.append(f"[assistant]: {text}")
            for tc in tool_calls:
                params = tc.get("params")
                if params is None or params == {}:
                    lines.append(f"[tool_call]: {tc['name']}()")
                else:
                    lines.append(
                        f"[tool_call]: {tc['name']}({json.dumps(params, ensure_ascii=False)})"
                    )
            continue

        if role == "toolResult":
            name = tool_result["name"] if tool_result else ""
            status = " ERROR" if tool_result and tool_result["is_error"] else ""
            label = name or "unknown"
            if text:
                lines.append(f"[tool_result]{label}{status}: {text[:200]}")
            else:
                lines.append(f"[tool_result]{label}{status}")
            continue

        if text:
            lines.append(f"[{role}]: {text}")
    return "\n".join(lines)


def _is_environment_message(text: str) -> bool:
    """Detect system/environment-injected messages (not genuine user input)."""
    lower = text.lower()
    return (lower.startswith("a new session was started")
            or "execute your session startup sequence" in lower)


def get_opening_user_utterance(sample: dict) -> str:
    """Return the first genuine user utterance, skipping environment messages."""
    turns = sample.get("user_turns", [])
    for turn in turns:
        if not _is_environment_message(turn):
            return turn
    # Fallback: if all turns are environment messages, use the first one
    if not turns:
        raise ValueError("样例没有用户轮次")
    return turns[0]


def detect_language(text: str) -> str:
    """Detect if text should be treated as Chinese or English. Returns 'zh' or 'en'."""
    return 'zh' if _contains_cjk(text) else 'en'


def _format_existing_assets() -> str:
    """Format existing assets' matching info for the Match Agent to avoid conflicts."""
    assets = load_assets()
    if not assets:
        return "(暂无已有资产)"
    lines = []
    for a in assets:
        m = a.get("matching", {})
        lines.append(f"- {a.get('assetId', '?')}: any={m.get('any', [])}, all={m.get('all', [])}, not={m.get('not', [])}")
    return "\n".join(lines)


def generate_matching(conversation: dict, *, old_asset: dict | None = None) -> dict:
    opening = get_opening_user_utterance(conversation)
    lang = detect_language(opening)
    prompt = MATCH_AGENT_PROMPT_ZH if lang == 'zh' else MATCH_AGENT_PROMPT_EN

    if old_asset:
        old_matching = json.dumps(old_asset.get("matching", {}), ensure_ascii=False)
        if lang == 'zh':
            update_prefix = (
                f"你正在更新已有资产 {old_asset.get('assetId')} 的匹配条件。\n"
                f"当前 matching: {old_matching}\n"
                f"请在此基础上根据新的对话改进匹配规则。保持 assetId 不变。\n\n"
            )
        else:
            update_prefix = (
                f"You are updating matching conditions for existing asset {old_asset.get('assetId')}.\n"
                f"Current matching: {old_matching}\n"
                f"Refine the matching rules based on the new conversation. Keep assetId unchanged.\n\n"
            )
        prompt = update_prefix + prompt

    messages = [
        {"role": "system", "content": prompt},
        {"role": "user", "content": opening},
    ]
    result = openclaw_json_chat(
        messages,
        purpose="generate-match",
        agent_name="Match Agent",
        round_id="1",
    )
    _validate_matching_keywords(result.get("matching", {}), "Match Agent")
    log.info("[Match Agent] output: assetId=%s  any=%s  positive=%d  negative=%d",
             result.get("assetId"), result.get("matching", {}).get("any"),
             len(result.get("positive_scenarios", [])), len(result.get("negative_scenarios", [])))
    return result


def validate_matching(matching: dict, positive: list[str], negative: list[str] | None = None, *, exclude_id: str | None = None) -> dict:
    """Validate matching with positive/negative scenarios + check conflicts with existing assets."""
    results = []
    for scenario in positive:
        hit = match_asset({"matching": matching}, scenario)
        results.append({"scenario": scenario, "expected": True, "matched": hit, "ok": hit})

    for scenario in (negative or []):
        hit = match_asset({"matching": matching}, scenario)
        results.append({"scenario": scenario, "expected": False, "matched": hit, "ok": not hit})

    # Conflict detection: positive scenarios should not match existing assets
    existing = load_assets()
    conflicts = []
    seen = set()
    for scenario in positive:
        for asset in existing:
            aid = asset.get("assetId", "?")
            if aid in seen:
                continue
            if exclude_id and aid == exclude_id:
                continue
            if match_asset(asset, scenario):
                conflicts.append({
                    "scenario": scenario,
                    "asset_id": aid,
                    "matching": asset.get("matching", {}),
                })
                seen.add(aid)

    all_passed = all(r["ok"] for r in results) and not conflicts
    return {"all_passed": all_passed, "results": results, "conflicts": conflicts}


def generate_controls(conversation: dict, matching: dict, *, old_asset: dict | None = None) -> dict:
    conv_text = format_conversation(conversation)
    opening = get_opening_user_utterance(conversation)

    # Detect language and choose prompt
    # Note: matching is accepted for API compatibility but NOT fed to Control Agent.
    # Mixing matching keywords into the control prompt causes the model to generate
    # spurious checks based on matching keywords (e.g. contains:arxiv) instead of
    # deriving rules purely from the conversation's correction signals.
    lang = detect_language(opening)
    if lang == 'zh':
        prompt = CONTROL_AGENT_PROMPT_ZH
        if old_asset:
            old_rules = json.dumps({
                "inputControl": old_asset.get("inputControl", []),
                "processControl": old_asset.get("processControl", []),
                "outputControl": old_asset.get("outputControl", []),
                "tools": old_asset.get("tools", []),
            }, ensure_ascii=False, indent=2)
            update_prefix = (
                f"你正在更新已有资产的控制规则。\n当前规则:\n{old_rules}\n"
                f"请在此基础上根据新的对话改进，保留仍有效的规则，修改需要改进的部分。\n\n"
            )
            prompt = update_prefix + prompt
        context = f"对话:\n{conv_text}"
    else:
        prompt = CONTROL_AGENT_PROMPT_EN
        if old_asset:
            old_rules = json.dumps({
                "inputControl": old_asset.get("inputControl", []),
                "processControl": old_asset.get("processControl", []),
                "outputControl": old_asset.get("outputControl", []),
                "tools": old_asset.get("tools", []),
            }, ensure_ascii=False, indent=2)
            update_prefix = (
                f"You are updating existing asset control rules.\nCurrent rules:\n{old_rules}\n"
                f"Refine based on the new conversation. Preserve effective rules, modify what needs improvement.\n\n"
            )
            prompt = update_prefix + prompt
        context = f"Conversation:\n{conv_text}"

    messages = [
        {"role": "system", "content": prompt},
        {"role": "user", "content": context},
    ]

    def _validate_controls(result: dict) -> None:
        _validate_atomic_checks(result.get("inputControl", []), "inputControl", "Control Agent")
        _validate_rule_text_fields(result.get("inputControl", []), "inputControl", "inject", "Control Agent")
        _validate_atomic_checks(result.get("outputControl", []), "outputControl", "Control Agent")
        _validate_rule_text_fields(result.get("outputControl", []), "outputControl", "rewrite", "Control Agent")
        _validate_process_constraints(result.get("processControl"), "Control Agent")
        _validate_tools_contract(result.get("tools"), "Control Agent")

    result = openclaw_json_chat(
        messages,
        purpose="generate-control",
        agent_name="Control Agent",
        round_id="1",
    )
    result = normalize_controls(result)

    for retry_index in range(1):
        try:
            _validate_controls(result)
            break
        except ValueError as exc:
            log.warning("[Control Agent] validation failed (attempt %d): %s", retry_index + 1, exc)
            if lang == 'zh':
                retry_msg = (
                    f"你的输出未通过格式校验:\n{exc}\n"
                    f"请修正后重新输出完整 JSON。注意：每条 check 只能有一个条件（contains:X 或 !contains:X），"
                    f"不能用 | 组合多个关键词，需要多个条件请拆成多条规则。"
                )
            else:
                retry_msg = (
                    f"Your output failed validation:\n{exc}\n"
                    f"Please fix and re-output the complete JSON. Each check must be atomic "
                    f"(contains:X or !contains:X). Do not combine keywords with |; split into separate rules."
                )
            messages.append({"role": "assistant", "content": json.dumps(result, ensure_ascii=False)})
            messages.append({"role": "user", "content": retry_msg})
            result = openclaw_json_chat(
                messages,
                purpose="generate-control-retry",
                agent_name="Control Agent",
                round_id=str(retry_index + 2),
            )
            result = normalize_controls(result)
    else:
        _validate_controls(result)

    log.info("[Control Agent] output: inputControl=%d  processControl=%d  outputControl=%d  tools=%d",
             len(result.get("inputControl", [])),
             len(result.get("processControl", [])),
             len(result.get("outputControl", [])),
             len(result.get("tools", [])))
    return result


def generate_asset(conversation: dict) -> dict:
    # Safety: strip any leftover input augmentation before agents see the conversation
    existing = load_assets()
    conversation, stripped_count = strip_known_input_augmentations(conversation, existing)
    if stripped_count:
        log.info("[generate_asset] stripped %d input augmentation block(s) from user turns", stripped_count)

    # Step 1: Generate initial matching
    opening = get_opening_user_utterance(conversation)
    lang = detect_language(opening)

    match_result = generate_matching(conversation)
    asset_id = match_result.get("assetId", "unnamed")
    matching = match_result.get("matching", {})
    positive = match_result.get("positive_scenarios", match_result.get("test_scenarios", []))
    negative = match_result.get("negative_scenarios", [])
    match_validation = validate_matching(matching, positive, negative)
    log.info("[validate_matching] all_passed=%s  failed=%d  conflicts=%d",
             match_validation["all_passed"],
             sum(1 for r in match_validation["results"] if not r["ok"]),
             len(match_validation.get("conflicts", [])))

    prompt = MATCH_AGENT_PROMPT_ZH if lang == 'zh' else MATCH_AGENT_PROMPT_EN

    # Step 2: Launch controls generation in background (parallel with matching validation/retry)
    with ThreadPoolExecutor(max_workers=1) as executor:
        controls_future = executor.submit(generate_controls, conversation, matching)

        # Step 3: Validate & retry matching (in foreground)
        for retry_index in range(1):
            if match_validation["all_passed"]:
                break
            failed = [r for r in match_validation["results"] if not r["ok"]]
            conflicts = match_validation.get("conflicts", [])
            fail_lines = []
            for r in failed:
                if r["expected"]:
                    fail_lines.append(f"- 应该匹配但未匹配: {r['scenario']}" if lang == 'zh' else f"- Should match but didn't: {r['scenario']}")
                else:
                    fail_lines.append(f"- 不应匹配但误匹配: {r['scenario']}" if lang == 'zh' else f"- Should NOT match but did: {r['scenario']}")
            for c in conflicts:
                if lang == 'zh':
                    fail_lines.append(f"- 与已有资产冲突: \"{c['scenario']}\" 匹配到 {c['asset_id']} (matching: {json.dumps(c['matching'], ensure_ascii=False)})")
                else:
                    fail_lines.append(f"- Conflicts with existing asset: \"{c['scenario']}\" matches {c['asset_id']} (matching: {json.dumps(c['matching'], ensure_ascii=False)})")

            if lang == 'zh':
                retry_msg = (
                    f"匹配验证未通过:\n"
                    + "\n".join(fail_lines)
                    + f"\n当前 matching: {json.dumps(matching, ensure_ascii=False)}"
                    + "\n请调整 matching（any/all/not）解决上述问题。"
                )
            else:
                retry_msg = (
                    f"Matching validation failed:\n"
                    + "\n".join(fail_lines)
                    + f"\nCurrent matching: {json.dumps(matching, ensure_ascii=False)}"
                    + "\nPlease adjust matching (any/all/not) to resolve the above issues."
                )
            retry_round = str(retry_index + 2)
            retry_messages = [
                {"role": "system", "content": prompt},
                {"role": "user", "content": opening},
                {"role": "assistant", "content": json.dumps(match_result, ensure_ascii=False)},
                {"role": "user", "content": retry_msg},
            ]
            match_result = openclaw_json_chat(
                retry_messages,
                purpose="generate-match-retry",
                agent_name="Match Agent",
                round_id=retry_round,
            )
            _validate_matching_keywords(match_result.get("matching", {}), "Match Agent")
            log.info("[Match Agent retry] output: assetId=%s  any=%s", match_result.get("assetId"), match_result.get("matching", {}).get("any"))
            matching = match_result.get("matching", matching)
            positive = match_result.get("positive_scenarios", positive)
            negative = match_result.get("negative_scenarios", negative)
            asset_id = match_result.get("assetId", asset_id)
            match_validation = validate_matching(matching, positive, negative)

        # Step 4: Wait for controls to finish
        controls = controls_future.result()

    asset = canonicalize_asset({
        "assetId": asset_id,
        "matching": matching,
        "inputControl": controls.get("inputControl", []),
        "processControl": controls.get("processControl", []),
        "outputControl": controls.get("outputControl", []),
        "tools": controls.get("tools", []),
        "version": 1,
    }, validate_contracts=True)
    utility = match_result.get("utilityScore")
    if isinstance(utility, (int, float)) and 0 <= utility <= 100:
        asset["utilityScore"] = int(utility)
    asset["_match_validation"] = match_validation
    asset["_positive_scenarios"] = positive
    asset["_negative_scenarios"] = negative
    return asset


def load_asset_by_id(asset_id: str) -> dict:
    path = os.path.join(ASSETS_DIR, f"{asset_id}.json")
    with open(path, encoding="utf-8") as f:
        return json.load(f)


def _normalize_update_generate_result(result: dict, context: str) -> dict:
    if not isinstance(result, dict):
        raise ValueError(f"{context} 必须返回 JSON 对象")

    matching = result.get("matching")
    if not isinstance(matching, dict):
        raise ValueError(f"{context} 缺少 matching 对象")
    _validate_matching_keywords(matching, context)

    controls = normalize_controls(result)
    _validate_atomic_checks(controls.get("inputControl", []), "inputControl", context)
    _validate_rule_text_fields(controls.get("inputControl", []), "inputControl", "inject", context)
    _validate_atomic_checks(controls.get("outputControl", []), "outputControl", context)
    _validate_rule_text_fields(controls.get("outputControl", []), "outputControl", "rewrite", context)
    _validate_process_constraints(controls.get("processControl"), context)
    _validate_tools_contract(controls.get("tools"), context)

    utility = result.get("utilityScore")
    if utility is not None and not isinstance(utility, (int, float)):
        raise ValueError(f"{context} utilityScore 必须是数字")

    return {
        "matching": matching,
        "controls": controls,
        "utilityScore": utility,
    }


def _build_update_generate_system_prompt(lang: str) -> str:
    return UPDATE_GENERATE_PROMPT_ZH if lang == 'zh' else UPDATE_GENERATE_PROMPT_EN


def _build_update_generate_asset_message(old_asset: dict, lang: str) -> str:
    asset_slim = {
        key: value
        for key, value in old_asset.items()
        if key not in ("version", "updateLog", "_match_validation", "_positive_scenarios", "_negative_scenarios")
    }
    asset_label = "当前资产 JSON" if lang == 'zh' else "Current asset JSON"
    return f"{asset_label}:\n{json.dumps(asset_slim, ensure_ascii=False, indent=2)}"


def _build_update_generate_conversation_message(conversation: dict, lang: str) -> str:
    conv_text = format_conversation(conversation)
    opening = get_opening_user_utterance(conversation)
    if lang == 'zh':
        return f"首轮用户发言:\n{opening}\n\n当前 UI 对话:\n{conv_text}"
    return f"First user utterance:\n{opening}\n\nCurrent UI conversation:\n{conv_text}"


def _build_update_generate_retry_message(
    match_validation: dict,
    matching: dict,
    lang: str,
) -> str:
    failed = [item for item in match_validation["results"] if not item["ok"]]
    conflicts = match_validation.get("conflicts", [])
    fail_lines = []
    for item in failed:
        if item["expected"]:
            fail_lines.append(
                f"- 应该匹配但未匹配: {item['scenario']}"
                if lang == 'zh'
                else f"- Should match but did not: {item['scenario']}"
            )
        else:
            fail_lines.append(
                f"- 不应匹配但误匹配: {item['scenario']}"
                if lang == 'zh'
                else f"- Should NOT match but did: {item['scenario']}"
            )
    for conflict in conflicts:
        detail = json.dumps(conflict["matching"], ensure_ascii=False)
        fail_lines.append(
            f"- 与已有资产冲突: \"{conflict['scenario']}\" 命中 {conflict['asset_id']} (matching: {detail})"
            if lang == 'zh'
            else f"- Conflicts with existing asset: \"{conflict['scenario']}\" matches {conflict['asset_id']} (matching: {detail})"
        )

    header = "匹配验证未通过" if lang == 'zh' else "Matching validation failed"
    current = "当前 matching" if lang == 'zh' else "Current matching"
    tail = (
        "请重新生成整份资产，统一修改 matching 和 control，解决上述问题。"
        if lang == 'zh'
        else "Regenerate the full asset and fix matching and controls together to resolve the issues above."
    )
    return (
        f"{header}:\n"
        + "\n".join(fail_lines)
        + f"\n{current}: {json.dumps(matching, ensure_ascii=False)}"
        + f"\n{tail}"
    )


def _build_update_generate_contract_retry_message(error: ValueError, lang: str) -> str:
    detail = str(error)
    if lang == 'zh':
        return (
            f"你的输出未通过格式校验:\n{detail}\n"
            "请修正后重新输出完整 JSON。"
            "inputControl 项必须使用字段 inject, outputControl 项必须使用字段 rewrite。"
            "不要省略必填字段, 不要输出解释文字。"
        )
    return (
        f"Your output failed validation:\n{detail}\n"
        "Please fix it and re-output the complete JSON. "
        "inputControl items must use inject, and outputControl items must use rewrite. "
        "Do not omit required fields and do not output any explanation."
    )


def _call_update_generate_agent(
    conversation: dict,
    old_asset: dict,
    *,
    retry_payload: dict | None = None,
    retry_message: str | None = None,
) -> dict:
    opening = get_opening_user_utterance(conversation)
    lang = detect_language(opening)
    messages = [
        {"role": "system", "content": _build_update_generate_system_prompt(lang)},
        {"role": "user", "content": _build_update_generate_asset_message(old_asset, lang)},
        {"role": "user", "content": _build_update_generate_conversation_message(conversation, lang)},
    ]
    if retry_payload is not None and retry_message:
        messages.append({"role": "assistant", "content": json.dumps(retry_payload, ensure_ascii=False)})
        messages.append({"role": "user", "content": retry_message})

    round_id = "1" if retry_payload is None else "2"
    raw_result = openclaw_json_chat(
        messages,
        purpose="update-generate",
        agent_name="Update Agent",
        round_id=round_id,
    )
    try:
        return _normalize_update_generate_result(raw_result, "Update Agent")
    except ValueError as exc:
        log.warning("[Update Agent] validation failed (round %s): %s", round_id, exc)
        messages.append({"role": "assistant", "content": json.dumps(raw_result, ensure_ascii=False)})
        messages.append({"role": "user", "content": _build_update_generate_contract_retry_message(exc, lang)})
        repaired = openclaw_json_chat(
            messages,
            purpose="update-generate-retry-contract",
            agent_name="Update Agent",
            round_id=f"{round_id}-repair",
        )
        return _normalize_update_generate_result(repaired, "Update Agent")


def update_generate_asset(conversation: dict, old_asset: dict) -> dict:
    """Update an existing asset jointly, using the matched asset as system context."""
    cleaned_conversation, stripped_count = strip_update_input_augmentation(conversation, old_asset)
    if stripped_count:
        log.info("[update_generate_asset] stripped %d input augmentation block(s) from user turns", stripped_count)

    opening = get_opening_user_utterance(cleaned_conversation)
    lang = detect_language(opening)
    old_asset_id = old_asset.get("assetId", "unnamed")
    # Reuse old asset's scenarios for matching validation
    positive = old_asset.get("_positive_scenarios", [])
    negative = old_asset.get("_negative_scenarios", [])

    generated = _call_update_generate_agent(cleaned_conversation, old_asset)
    matching = generated["matching"]
    controls = generated["controls"]
    utility = generated["utilityScore"]

    if positive and negative:
        match_validation = validate_matching(matching, positive, negative, exclude_id=old_asset_id)
        log.info(
            "[update_generate_asset][validate_matching] all_passed=%s  failed=%d  conflicts=%d",
            match_validation["all_passed"],
            sum(1 for item in match_validation["results"] if not item["ok"]),
            len(match_validation.get("conflicts", [])),
        )

        if not match_validation["all_passed"]:
            retry_message = _build_update_generate_retry_message(match_validation, matching, lang)
            generated = _call_update_generate_agent(
                cleaned_conversation,
                old_asset,
                retry_payload=generated,
                retry_message=retry_message,
            )
            matching = generated["matching"]
            controls = generated["controls"]
            utility = generated["utilityScore"]
            match_validation = validate_matching(matching, positive, negative, exclude_id=old_asset_id)
    else:
        match_validation = {"all_passed": True, "results": [], "conflicts": []}
        log.info("[update_generate_asset] no old scenarios available, skipping matching validation")

    old_version = old_asset.get("version", 1)
    old_log = old_asset.get("updateLog", [])
    asset = canonicalize_asset({
        "assetId": old_asset_id,
        "scenarioId": old_asset.get("scenarioId", ""),
        "matching": matching,
        "inputControl": controls.get("inputControl", []),
        "processControl": controls.get("processControl", []),
        "outputControl": controls.get("outputControl", []),
        "tools": controls.get("tools", []),
        "version": old_version + 1,
        "updateLog": old_log + [{
            "from": old_version,
            "to": old_version + 1,
            "reflection": "Re-generated via Save as Asset with new conversation",
            "feedback": "",
            "rule": "Joint Update Agent pipeline with matched asset in system prompt",
        }],
    }, validate_contracts=True)
    if isinstance(utility, (int, float)) and 0 <= utility <= 100:
        asset["utilityScore"] = int(utility)
    asset["_match_validation"] = match_validation
    asset["_positive_scenarios"] = positive
    asset["_negative_scenarios"] = negative
    return asset


# ──────────────── 复用 (via OpenClaw) ────────────────

def parse_output_check(chk: str) -> tuple[str, str] | None:
    normalized = chk.strip()
    if "|" in normalized:
        raise ValueError(f"不支持 | 复合 check 语法，请拆成多条规则: {normalized}")
    if normalized.startswith("!contains:"):
        kw = normalized[10:].strip()
        return ("not_contains", kw) if kw else None
    if normalized.startswith("contains:"):
        kw = normalized[9:].strip()
        return ("contains", kw) if kw else None
    return None


def check_output(output: str, rules: list[dict], *, zh: bool) -> tuple[bool, dict | None, str]:
    for rule in rules:
        parsed = parse_output_check(rule.get("check", ""))
        if not parsed:
            continue
        kind, kw = parsed
        if kind == "contains" and kw not in output:
            return False, rule, (f"缺少: {kw}" if zh else f"Missing required text: {kw}")
        if kind == "not_contains" and kw in output:
            return False, rule, (f"包含了禁止词: {kw}" if zh else f"Contains forbidden text: {kw}")
    return True, None, ""


def build_asset_guidance(asset: dict, query: str = "") -> str:
    parts = []
    lower_query = query.lower()

    ic = asset.get("inputControl", [])
    matched_ic = []
    for rule in ic:
        parsed = parse_output_check(rule.get("check", ""))
        if not parsed:
            continue
        kind, kw = parsed
        if kind == "contains" and kw.lower() in lower_query:
            matched_ic.append(rule)
        elif kind == "not_contains" and kw.lower() not in lower_query:
            matched_ic.append(rule)

    if matched_ic:
        parts.append("## 行为指引")
        for rule in matched_ic:
            if rule.get("inject"):
                parts.append(f"- {rule['inject']}")

    return "\n".join(parts)


def format_output_rules(asset: dict) -> str:
    lines = []
    for rule in asset.get("outputControl", []):
        parsed = parse_output_check(rule.get("check", ""))
        if not parsed:
            continue
        kind, kw = parsed
        if kind == "contains":
            lines.append(f"- 必须包含「{kw}」")
        elif kind == "not_contains":
            lines.append(f"- 禁止包含「{kw}」")
    return "\n".join(lines)


def build_rewrite_user_message(conversation: list[dict], asset: dict, draft: str, reason: str = "") -> str:
    conv_text = format_message_conversation(conversation)
    rules_text = format_output_rules(asset)
    if not rules_text.strip():
        raise ValueError("build_rewrite_user_message 需要非空 outputControl")
    if not draft.strip():
        raise ValueError("build_rewrite_user_message 需要非空 draft")

    return (
        f"对话历史:\n{conv_text or '(空)'}\n\n"
        f"当前助手草稿:\n{draft}\n\n"
        f"输出约束:\n{rules_text}\n\n"
        f"当前失败原因:\n{reason or '(未提供)'}\n\n"
        "请只输出重写后的最终回复。"
    )


def rewrite_output_from_user_message(user_msg: str) -> str:
    output = openclaw_chat(
        [
            {"role": "system", "content": REWRITE_OUTPUT_SYSTEM_PROMPT},
            {"role": "user", "content": user_msg},
        ],
        purpose="rewrite",
    ).strip()
    if not output:
        raise ValueError("rewrite_output 返回空输出")
    return output


def rewrite_output(conversation: list[dict], asset: dict, draft: str, reason: str = "") -> str:
    user_msg = build_rewrite_user_message(conversation, asset, draft, reason)
    return rewrite_output_from_user_message(user_msg)


def reuse_asset_via_openclaw(query: str, asset: dict) -> dict:
    """通过 OpenClaw gateway 复用资产（用于 Update 流程中获取 evidence）"""
    # Update validation cares about the revised first-turn behavior for the
    # opening query, so replay only that query instead of the later dialogue.
    messages = [{"role": "user", "content": query}]

    try:
        output = openclaw_chat(messages, purpose="verify")
    except Exception as e:
        log.error("[reuse] OpenClaw 调用失败: %s", e)
        return {"output": f"[OpenClaw 调用失败] {e}", "via": "openclaw-error"}

    rules = asset.get("outputControl", [])
    ok, failed, reason = check_output(output, rules, zh=_contains_cjk(query))

    return {"output": output, "checks": [{"ok": ok, "reason": reason}], "via": "openclaw"}


# ──────────────── 更新 ────────────────

def update_asset(asset: dict, conversation: list[dict], feedback: str) -> tuple[dict, dict]:
    conv_text = format_message_conversation(conversation)
    asset_slim = {k: v for k, v in asset.items() if k not in ("updateLog", "version", "_match_validation", "_test_scenarios")}

    msg = f"当前资产:\n{json.dumps(asset_slim, ensure_ascii=False, indent=2)}\n\n对话: {conv_text}\n\n反馈: {feedback}"

    result = openclaw_json_chat(
        [
            {"role": "system", "content": UPDATER_SYSTEM_PROMPT},
            {"role": "user", "content": msg},
        ],
        purpose="update-asset",
        agent_name="Updater",
        round_id="1",
    )

    reasoning = result.get("reasoning", {})
    updated = result.get("asset", result)
    if "reasoning" in updated:
        del updated["reasoning"]

    updated["assetId"] = asset.get("assetId", updated.get("assetId", ""))
    updated["scenarioId"] = asset.get("scenarioId", updated.get("scenarioId", ""))

    old_version = asset.get("version", 1)
    old_log = asset.get("updateLog", [])
    updated["version"] = old_version + 1
    updated["updateLog"] = old_log + [{
        "from": old_version,
        "to": old_version + 1,
        "reflection": reasoning.get("problem", ""),
        "feedback": feedback,
        "rule": reasoning.get("changes", ""),
    }]
    _validate_asset_contracts(updated, "Updater")

    return updated, reasoning


def judge_update(feedback: str, evidence: dict | None = None) -> dict:
    if not evidence:
        return {"will_satisfy": False, "reason": "无执行证据，无法验证修改是否解决了反馈。"}

    output_text = evidence.get("output", "") if evidence else "(无执行证据)"
    if evidence.get("via") == "openclaw-error":
        return {"will_satisfy": False, "reason": f"执行证据获取失败: {output_text}"}

    failed_checks = [
        str(check.get("reason") or "outputControl 未通过")
        for check in evidence.get("checks", [])
        if not check.get("ok", False)
    ]
    if failed_checks:
        return {
            "will_satisfy": False,
            "reason": "输出约束未通过: " + "；".join(failed_checks),
        }

    msg = f"用户反馈: {feedback}\n\n修改后资产对同一查询的实际输出:\n{output_text}\n\n请判断这个输出是否解决了用户反馈的问题。"

    return openclaw_json_chat(
        [
            {"role": "system", "content": JUDGE_SYSTEM_PROMPT},
            {"role": "user", "content": msg},
        ],
        purpose="judge-update",
        agent_name="Judge",
        round_id="1",
    )


def process_feedback(asset_id: str, feedback: str, conversation: list[dict] | None = None) -> dict:
    """Updater → Save → Reload → Execute(OpenClaw) → Judge, up to 2 rounds"""
    log.info("[feedback] START asset=%s feedback=%r", asset_id, feedback[:80])

    asset_path = os.path.join(ASSETS_DIR, f"{asset_id}.json")
    if not os.path.exists(asset_path):
        return {"error": f"Asset {asset_id} not found"}

    with open(asset_path, encoding="utf-8") as f:
        asset = json.load(f)

    original_query = ""
    for m in (conversation or []):
        content = m.get("content", "")
        if m.get("role") == "user" and content.startswith("[反馈]"):
            continue
        if not original_query and m.get("role") == "user":
            original_query = content

    conv = list(conversation or [])
    current_asset = asset

    for attempt in range(2):
        log.info("[feedback] attempt %d/2", attempt + 1)

        updated_asset, reasoning = update_asset(current_asset, conv, feedback)
        save_asset(updated_asset)
        notify_plugin_reload()

        evidence = None
        if original_query:
            try:
                evidence = reuse_asset_via_openclaw(original_query, updated_asset)
            except Exception as e:
                log.error("[feedback] Execute failed: %s", e)

        judge_result = judge_update(feedback, evidence)
        satisfied = judge_result.get("will_satisfy", False)
        log.info("[feedback] Judge: will_satisfy=%s", satisfied)

        if satisfied or attempt == 1:
            return {
                "status": "updated",
                "reasoning": reasoning,
                "judge": judge_result,
                "evidence": {
                    "query": original_query,
                    "output": evidence.get("output", "") if evidence else "",
                    "checks": evidence.get("checks", []) if evidence else [],
                    "via": evidence.get("via", "") if evidence else "",
                },
                "asset": updated_asset,
                "attempt": attempt + 1,
            }

        conv = list(conversation or []) + [
            {"role": "system", "content": f"[上轮修改未通过验证] {judge_result.get('reason', '')}"},
        ]
        current_asset = updated_asset

    return {"error": "unreachable"}
