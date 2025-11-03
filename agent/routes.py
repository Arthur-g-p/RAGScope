# Agent module for LLM streaming chat + dataset_query tool (single endpoint)
# Single-user, no persistence. Keeps current run in memory when provided with each call.

import asyncio
import json
import logging
import os
import uuid
from typing import Any, Dict, Iterable, Optional, List
import httpx

from fastapi import APIRouter, HTTPException, Request
from fastapi.responses import StreamingResponse
from pydantic import BaseModel, Field
from litellm import acompletion

# Simple tab->prompt mapping
from .prompt_map import build_prompt_for_tab

logger = logging.getLogger(__name__)

router = APIRouter()

@router.get("/health")
async def health_get():
    model = os.getenv("LLM_NAME") or ""
    return {"ok": True, "model": model, "has_run": CURRENT_RUN is not None}

# In-memory current run (single-user)
CURRENT_RUN: Optional[Dict[str, Any]] = None

# - Request models -
class ToolFunction(BaseModel):
    name: str
    arguments: str

class ToolCall(BaseModel):
    id: Optional[str] = None
    type: Optional[str] = "function"
    function: ToolFunction

class ChatMessage(BaseModel):
    role: str  # 'user' | 'assistant' | 'tool'
    content: Optional[str] = None  # assistant tool_call may have null; tool content is a JSON string
    tool_calls: Optional[List[ToolCall]] = None  # assistant-only
    name: Optional[str] = None  # tool-only
    tool_call_id: Optional[str] = None  # tool-only

class SourceSpec(BaseModel):
    collection: str
    run_file: str
    derived: Optional[bool] = Field(default=True)

class ChatRequest(BaseModel):
    messages: List[ChatMessage]
    active_tab: Optional[str] = Field(default=None, description="overview | metrics | inspector | chunks")
    view_context: Optional[Dict[str, Any]] = None
    source: Optional[SourceSpec] = Field(default=None, description="Optional file reference: {collection, run_file, derived}")

# Tool args
class ToolCallArgs(BaseModel):
    expr: str
    limit: Optional[int] = Field(default=50, ge=1, le=200)
    char_limit: Optional[int] = Field(default=None, ge=1, description="Optional max characters per string in result; omit to disable char truncation.")

# OpenAI format tools schema for dataset_query
TOOLS = [
    {
        "type": "function",
        "function": {
            "name": "dataset_query",
            "description": (
                "Evaluate ONE pure Python expression over the current run (read-only).\n"
                "Variables: data (enhanced run), questions (data['results'] list).\n"
                "Allowed builtins: len,sum,min,max,sorted,any,all,set,list,dict,tuple,enumerate,range,type,isinstance,str,int,float.\n"
                "Rules: SINGLE expression only; no assignments, no semicolons, no newlines. Use dict/list literals and comprehensions.\n"
                "Examples: [q['query_id'] for q in questions][:5] | {'n': len(questions)} | [ {'query_id': q.get('query_id')} for q in questions ]\n"
                "Keep results small; use 'limit' and 'char_limit'."
            ),
            "parameters": {
                "type": "object",
                "properties": {
                    "expr": {"type": "string", "description": "Python expression returning JSON-serializable value."},
                    "limit": {"type": "integer", "minimum": 1, "maximum": 200},
                    "char_limit": {"type": "integer", "minimum": 1, "description": "Optional max characters per string in result; omit to disable char truncation."}
                },
                "required": ["expr"],
                "additionalProperties": False
            }
        }
    }
]


ALLOWED_BUILTINS = {
    "len": len,
    "sum": sum,
    "min": min,
    "max": max,
    "sorted": sorted,
    "any": any,
    "all": all,
    "set": set,
    "list": list,
    "dict": dict,
    "tuple": tuple,
    "enumerate": enumerate,
    "range": range,
    "type": type,
    "isinstance": isinstance,
    "str": str,
    "int": int,
    "float": float,
}

async def _eval_expr(expr: str, ctx: Dict[str, Any], timeout_ms: int = 400) -> Any:
    loop = asyncio.get_event_loop()

    def runner():
        code = compile(expr, "<expr>", "eval")
        return eval(code, {"__builtins__": ALLOWED_BUILTINS}, ctx)

    return await asyncio.wait_for(loop.run_in_executor(None, runner), timeout_ms / 1000)


def _normalize_questions(run: Dict[str, Any]) -> List[Dict[str, Any]]:
    if not run:
        return []
    results = run.get("results", [])
    if isinstance(results, dict) and "results" in results:
        results = results.get("results", [])
    if not isinstance(results, list):
        return []
    return results


def _truncate_strings(value: Any, char_limit: Optional[int]) -> (Any, bool):
    if char_limit is None:
        return value, False
    truncated_any = False
    if isinstance(value, str):
        if len(value) > char_limit:
            return value[:char_limit], True
        return value, False
    if isinstance(value, list):
        new_list = []
        for item in value:
            new_item, t = _truncate_strings(item, char_limit)
            truncated_any = truncated_any or t
            new_list.append(new_item)
        return new_list, truncated_any
    if isinstance(value, tuple):
        new_items = []
        for item in value:
            new_item, t = _truncate_strings(item, char_limit)
            truncated_any = truncated_any or t
            new_items.append(new_item)
        return tuple(new_items), truncated_any
    if isinstance(value, dict):
        new_dict = {}
        for k, v in value.items():
            new_v, t = _truncate_strings(v, char_limit)
            truncated_any = truncated_any or t
            new_dict[k] = new_v
        return new_dict, truncated_any
    return value, False

def _prevalidate_expr(expr: str) -> Optional[str]:
    # Disallow obvious non-expression forms: assignments, semicolons, newlines
    if ';' in expr:
        return "Only a single expression is allowed. Do not use semicolons."
    if '\n' in expr:
        return "Only a single expression is allowed. Do not use newlines."
    # crude check for assignment '=' not part of comparisons
    if '=' in expr and '==' not in expr and '>=' not in expr and '<=' not in expr and '!=' not in expr:
        return "Only a single expression is allowed. Do not use assignments (e.g., no q=...)."
    return None

async def _run_dataset_query(expr: str, limit: Optional[int], char_limit: Optional[int]) -> Dict[str, Any]:
    if CURRENT_RUN is None:
        raise HTTPException(status_code=400, detail="No run loaded. Include run_data in the request once after loading a run.")
    questions = _normalize_questions(CURRENT_RUN)
    ctx = {"data": CURRENT_RUN, "questions": questions}

    value = await _eval_expr(expr, ctx, timeout_ms=400)

    list_truncated = False
    if isinstance(value, list) and limit is not None and len(value) > limit:
        value = value[:limit]
        list_truncated = True

    # Optional char-level truncation
    value, char_truncated = _truncate_strings(value, char_limit)

    # Ensure JSON serializable
    try:
        json.dumps(value)
    except TypeError:
        if isinstance(value, (set, tuple)):
            value = list(value)
        else:
            value = str(value)

    return {"result": value, "truncated": list_truncated, "char_truncated": char_truncated}


async def _fetch_run_via_loader(src: SourceSpec, timeout_sec: float) -> Dict[str, Any]:
    """Fetch run via existing backend loader endpoint, honoring derived flag."""
    url = f"http://127.0.0.1:8000/collections/{src.collection}/runs/{src.run_file}"
    if src.derived:
        url += "?derived=true"
    logger.info(f"Agent: fetching run via loader {url}")
    async with httpx.AsyncClient(timeout=timeout_sec) as client:
        resp = await client.get(url)
        resp.raise_for_status()
        return resp.json()

@router.post("/chat/stream")
async def chat_stream(body: ChatRequest):
    global CURRENT_RUN

    # Load env 
    model = os.getenv("LLM_NAME")
    if not model:
        logger.error(f"LLM_NAME is not set in environment")
        raise HTTPException(status_code=500, detail="LLM_NAME is not set in environment")
    api_base = os.getenv("LLM_PROVIDER_API_BASE", os.getenv("LLM_API_BASE", "https://api.openai.com/v1"))
    api_key = os.getenv("LLM_PROVIDER_API_KEY", os.getenv("LLM_API_KEY"))
    timeout_sec = float(os.getenv("LLM_TIMEOUT_SEC", "100"))

    logger.info(
        f"chat request: tab={body.active_tab} "
        f"msgs={len(body.messages) if body.messages else 0} view_keys={sorted(body.view_context.keys()) if body.view_context else []}"
    )

    if not api_key:
        raise HTTPException(status_code=400, detail="Missing LLM_PROVIDER_API_KEY in environment")


    if body.source is not None:
        src = body.source
        try:
            CURRENT_RUN = await _fetch_run_via_loader(src, timeout_sec)
            logger.info(f"Agent: loaded run from loader (derived={src.derived})")
        except Exception as e:
            logger.error(f"[Agent: failed to load run from loader: {e}")
            raise HTTPException(status_code=502, detail="Failed to fetch run from loader")

    # Build messages array
    sys_prompt = build_prompt_for_tab(body.active_tab, body.view_context)
    logger.info(f"[=== SYSTEM PROMPT ===\n{sys_prompt}")
    messages: List[Dict[str, Any]] = [{"role": "system", "content": sys_prompt}]
    last_user = None
    for m in body.messages:
        if m.role == "assistant" and m.tool_calls:
            # Assistant tool_call message (content may be null)
            tool_calls_payload = []
            for tc in (m.tool_calls or []):
                tool_calls_payload.append({
                    "id": tc.id or "call_1",
                    "type": tc.type or "function",
                    "function": {"name": tc.function.name, "arguments": tc.function.arguments}
                })
            messages.append({"role": "assistant", "content": None, "tool_calls": tool_calls_payload})
        elif m.role == "tool":
            # Tool result message (content should be JSON string)
            messages.append({
                "role": "tool",
                "name": m.name,
                "tool_call_id": m.tool_call_id,
                "content": m.content or ""
            })
        elif m.role in ("user", "assistant"):
            messages.append({"role": m.role, "content": m.content or ""})
            if m.role == "user":
                last_user = m.content or ""
    if last_user:
        logger.info(f"[ === USER INPUT ===\n{last_user}")

    # Iterative tool-use loop: allow the model to call the tool up to 7 times before final answer
    MAX_STEPS = 7

    async def sse_generator() -> Iterable[bytes]:
        # === TOOL LOOP ===
        tool_steps = 0
        tool_used = False
        tool_call_id: Optional[str] = None
        extra_grace_used = False
        while tool_steps < (MAX_STEPS + (1 if extra_grace_used else 0)):
            # Non-stream call with tools enabled
            try:
                resp = await acompletion(
                    model=model,
                    api_base=api_base,
                    api_key=api_key,
                    timeout=timeout_sec,
                    messages=messages,
                    tools=TOOLS,
                    tool_choice="auto",
                    stream=False,
                )
            except Exception as e:
                err = f"LLM call failed during tool loop: {e}"
                logger.error(f"[[TOOL-LOOP-ERROR] {err}")
                yield f"data: {json.dumps({"error": err})}\n\n".encode("utf-8")
                return

            msg = resp.choices[0].message
            tool_calls = getattr(msg, "tool_calls", None)
            if not tool_calls:
                logger.info(f"[tool loop: no tool call (will stream final)")
                break

            call = tool_calls[0]
            fn = getattr(call, "function", None)
            name = getattr(fn, "name", None) if fn else None
            args_raw = getattr(fn, "arguments", "{}") if fn else "{}"
            tool_call_id = getattr(call, "id", None)
            logger.info(f"[tool loop: assistant requested tool name={name} args={json.dumps(args_raw, indent=4)}")

            if name != "dataset_query":
                logger.info(f"[ tool loop: unknown tool '{name}', stopping tool loop")
                break

            # Parse args
            try:
                args = json.loads(args_raw)
                tool_args = ToolCallArgs(**args)
            except Exception as e:
                err = f"Invalid tool arguments: {e}"
                logger.error(f"[ [TOOL-ARGS-ERROR] {err}")
                yield f"data: {json.dumps({"error": err})}\n\n".encode("utf-8")
                return

            # Append assistant tool_call message
            assistant_tool_msg = {
                "role": "assistant",
                "content": None,
                "tool_calls": [
                    {
                        "id": tool_call_id or f"call_{tool_steps+1}",
                        "type": "function",
                        "function": {
                            "name": name,
                            "arguments": json.dumps(args)
                        }
                    }
                ]
            }
            messages.append(assistant_tool_msg)
            # Stream tool_call to client for persistence
            yield f"event: tool_call\ndata: {json.dumps(assistant_tool_msg, ensure_ascii=False)}\n\n".encode("utf-8")

            # Execute dataset_query (with prevalidation)
            bad = _prevalidate_expr(tool_args.expr)
            if bad:
                err_msg = {"error": bad, "hint": "Write ONE expression: no assignments/semicolons/newlines."}
                logger.error(f"[ === TOOL ERROR (step {tool_steps+1}) ===\n{bad}")
                tool_msg_err = {"role": "tool", "name": "dataset_query", "content": json.dumps(err_msg, ensure_ascii=False)}
                if tool_call_id:
                    tool_msg_err["tool_call_id"] = tool_call_id
                messages.append(tool_msg_err)
                yield f"event: tool_result\ndata: {json.dumps(tool_msg_err, ensure_ascii=False)}\n\n".encode("utf-8")
                if not extra_grace_used:
                    extra_grace_used = True
                tool_steps += 1
                continue
            try:
                logger.info(f"[ === TOOL INPUT (step {tool_steps+1}) ===\nexpr={tool_args.expr}\nlimit={tool_args.limit}\nchar_limit={tool_args.char_limit}")
                tool_result = await _run_dataset_query(tool_args.expr, tool_args.limit, tool_args.char_limit)
                logger.info(f"[ === TOOL OUTPUT (step {tool_steps+1}) ===\n{json.dumps(tool_result, ensure_ascii=False)}")
            except Exception as e:
                # Create an error tool result instead of failing the whole request
                err_msg = {"error": str(e), "hint": "Ensure a single expression; avoid assignments/semicolons/newlines."}
                logger.error(f"[ === TOOL ERROR (step {tool_steps+1}) ===\n{str(e)}")
                tool_msg_err = {"role": "tool", "name": "dataset_query", "content": json.dumps(err_msg, ensure_ascii=False)}
                if tool_call_id:
                    tool_msg_err["tool_call_id"] = tool_call_id
                messages.append(tool_msg_err)
                yield f"event: tool_result\ndata: {json.dumps(tool_msg_err, ensure_ascii=False)}\n\n".encode("utf-8")
                if not extra_grace_used:
                    extra_grace_used = True
                tool_steps += 1
                continue

            # Append tool result message
            tool_msg = {
                "role": "tool",
                "name": "dataset_query",
                "content": json.dumps(tool_result, ensure_ascii=False),
            }
            if tool_call_id:
                tool_msg["tool_call_id"] = tool_call_id
            messages.append(tool_msg)
            # Stream tool_result to client
            yield f"event: tool_result\ndata: {json.dumps(tool_msg, ensure_ascii=False)}\n\n".encode("utf-8")

            tool_used = True
            tool_steps += 1

        # FINAL STREAM 
        try:
            logger.info(f"[ final: streaming answer (tool_choice=none)")
            # tool_choice="none" explicitly disables new tool calls during final answer
            stream = await acompletion(
                model=model,
                api_base=api_base,
                api_key=api_key,
                timeout=timeout_sec,
                messages=messages,
                tools=TOOLS,
                tool_choice="none",
                stream=True,
            )
        except Exception as e:
            logger.error(f"[ [FINAL-STREAM-ERROR] {e}")
            yield f"data: {json.dumps({"error": "Final LLM call failed"})}\n\n".encode("utf-8")
            return

        final_text_parts: List[str] = []
        try:
            async for chunk in stream:
                delta = chunk.choices[0].delta
                text = getattr(delta, "content", None)
                if text:
                    final_text_parts.append(text)
                    yield f"data: {json.dumps({"content": text})}\n\n".encode("utf-8")
        except Exception as e:
            logger.error(f"[ [STREAM-EMIT-ERROR] {e}")
        finally:
            final_text = "".join(final_text_parts)
            logger.info(f"[ === FINAL ANSWER ===\n{final_text}")
            yield b"event: done\ndata: {}\n\n"

    return StreamingResponse(sse_generator(), media_type="text/event-stream")

