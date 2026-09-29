"""LLM Provider abstraction for Fault Line real AI-agent integration."""

from __future__ import annotations

import json
import os
import time
from typing import Any

import httpx


class LLMProvider:
    """Pluggable provider for Gemini/OpenAI REST API tool-calling LLMs."""

    def __init__(
        self,
        api_key: str | None = None,
        model_name: str | None = None,
        mock_responses: list[dict[str, Any]] | None = None,
    ):
        self.api_key = (
            api_key
            or os.environ.get("LLM_API_KEY")
            or os.environ.get("GEMINI_API_KEY")
            or os.environ.get("OPENAI_API_KEY")
        )
        self.model_name = (
            model_name
            or os.environ.get("LLM_MODEL")
            or "gemini-2.5-flash"
        )
        self.mock_responses = mock_responses
        self._mock_index = 0

    def has_credentials(self) -> bool:
        """Returns True if live LLM credentials or mock responses are configured."""
        return bool(self.api_key or self.mock_responses)

    def generate_plan(
        self,
        system_prompt: str,
        tools_schema: list[dict[str, Any]],
        workload_spec: list[dict[str, Any]],
    ) -> dict[str, Any]:
        """Invokes LLM once to generate an execution plan for the CRM workload."""
        started = time.perf_counter()

        # 1. Use mock responses if provided (offline testing path)
        if self.mock_responses is not None:
            latency_ms = (time.perf_counter() - started) * 1000
            plan = self.mock_responses
            return {
                "plan": plan,
                "prompt_tokens": 150,
                "completion_tokens": 200,
                "total_tokens": 350,
                "token_status": "ESTIMATED",
                "latency_ms": latency_ms,
                "model": f"{self.model_name} (mock)",
                "llm_calls_count": 1,
            }

        # 2. Verify API key presence
        if not self.api_key:
            raise RuntimeError(
                "LLM API Key missing. Please set LLM_API_KEY or GEMINI_API_KEY in environment to run the Real LLM Agent."
            )

        # 3. Live LLM API invocation
        if "openai" in self.model_name.lower() or os.environ.get("OPENAI_API_KEY"):
            return self._call_openai_api_plan(
                system_prompt, tools_schema, workload_spec, started
            )
        else:
            return self._call_gemini_api_plan(
                system_prompt, tools_schema, workload_spec, started
            )

    def _call_gemini_api_plan(
        self,
        system_prompt: str,
        tools_schema: list[dict[str, Any]],
        workload_spec: list[dict[str, Any]],
        started_time: float,
    ) -> dict[str, Any]:
        url = f"https://generativelanguage.googleapis.com/v1beta/models/{self.model_name}:generateContent?key={self.api_key}"

        prompt = (
            f"Generate a CRM action plan for the following workload steps:\n"
            f"{json.dumps(workload_spec, indent=2)}\n\n"
            f"Allowed CRM tools: {[t['name'] for t in tools_schema]}\n\n"
            "Return a JSON array of tool call objects in order. Each object must have format:\n"
            "{\"action\": \"<tool_name>\", \"args\": {<parameters>}}"
        )

        payload = {
            "systemInstruction": {"parts": [{"text": system_prompt}]},
            "contents": [{"role": "user", "parts": [{"text": prompt}]}],
            "generationConfig": {
                "responseMimeType": "application/json"
            },
        }

        with httpx.Client(timeout=30.0) as client:
            res = client.post(url, json=payload)
            res.raise_for_status()
            data = res.json()

        latency_ms = (time.perf_counter() - started_time) * 1000

        candidates = data.get("candidates", [])
        if candidates and "content" in candidates[0]:
            parts = candidates[0]["content"].get("parts", [])
            for part in parts:
                if "text" in part:
                    raw_text = part["text"]
                    try:
                        plan = json.loads(raw_text)
                        if isinstance(plan, dict) and "plan" in plan:
                            plan = plan["plan"]
                        if not isinstance(plan, list):
                            raise ValueError(f"Expected JSON array plan, got: {type(plan)}")
                    except Exception as err:
                        raise RuntimeError(f"Gemini API returned unparseable plan JSON: {err}") from err

                    usage = data.get("usageMetadata", {})
                    prompt_tokens = usage.get("promptTokenCount", 0)
                    completion_tokens = usage.get("candidatesTokenCount", 0)
                    total_tokens = usage.get("totalTokenCount", prompt_tokens + completion_tokens)

                    return {
                        "plan": plan,
                        "prompt_tokens": prompt_tokens,
                        "completion_tokens": completion_tokens,
                        "total_tokens": total_tokens,
                        "token_status": "MEASURED" if total_tokens > 0 else "ESTIMATED",
                        "latency_ms": latency_ms,
                        "model": self.model_name,
                        "llm_calls_count": 1,
                    }

        raise RuntimeError(f"Gemini API did not return a valid plan: {json.dumps(data)}")

    def _call_openai_api_plan(
        self,
        system_prompt: str,
        tools_schema: list[dict[str, Any]],
        workload_spec: list[dict[str, Any]],
        started_time: float,
    ) -> dict[str, Any]:
        url = "https://api.openai.com/v1/chat/completions"
        headers = {
            "Authorization": f"Bearer {self.api_key}",
            "Content-Type": "application/json",
        }

        prompt = (
            f"Generate a CRM action plan for the following workload steps:\n"
            f"{json.dumps(workload_spec, indent=2)}\n\n"
            f"Allowed CRM tools: {[t['name'] for t in tools_schema]}\n\n"
            "Return a JSON array of tool call objects in order: [{\"action\": \"...\", \"args\": {...}}]"
        )

        messages = [
            {"role": "system", "content": system_prompt},
            {"role": "user", "content": prompt},
        ]

        payload = {
            "model": self.model_name,
            "messages": messages,
            "response_format": {"type": "json_object"},
        }

        with httpx.Client(timeout=30.0) as client:
            res = client.post(url, headers=headers, json=payload)
            res.raise_for_status()
            data = res.json()

        latency_ms = (time.perf_counter() - started_time) * 1000

        content = data["choices"][0]["message"]["content"]
        parsed = json.loads(content)
        plan = parsed if isinstance(parsed, list) else parsed.get("plan", parsed.get("actions", []))

        usage = data.get("usage", {})
        prompt_tokens = usage.get("prompt_tokens", 0)
        completion_tokens = usage.get("completion_tokens", 0)
        total_tokens = usage.get("total_tokens", prompt_tokens + completion_tokens)

        return {
            "plan": plan,
            "prompt_tokens": prompt_tokens,
            "completion_tokens": completion_tokens,
            "total_tokens": total_tokens,
            "token_status": "MEASURED" if total_tokens > 0 else "ESTIMATED",
            "latency_ms": latency_ms,
            "model": self.model_name,
            "llm_calls_count": 1,
        }

    def generate_tool_call(
        self,
        system_prompt: str,
        tools_schema: list[dict[str, Any]],
        conversation_history: list[dict[str, Any]],
        step_idx: int,
    ) -> dict[str, Any]:
        """Invokes LLM to select a tool call and parameters based on context."""
        started = time.perf_counter()

        # 1. Use mock response if provided (offline testing path)
        if self.mock_responses is not None:
            if self._mock_index < len(self.mock_responses):
                resp = self.mock_responses[self._mock_index]
                self._mock_index += 1
            else:
                resp = self.mock_responses[-1]

            latency_ms = (time.perf_counter() - started) * 1000
            return {
                "action": resp.get("action", "get_lead"),
                "args": resp.get("args", {}),
                "prompt_tokens": resp.get("prompt_tokens", 120),
                "completion_tokens": resp.get("completion_tokens", 35),
                "total_tokens": resp.get("total_tokens", 155),
                "token_status": "MEASURED",
                "latency_ms": latency_ms,
                "model": f"{self.model_name} (mock)",
            }

        # 2. Verify API key presence
        if not self.api_key:
            raise RuntimeError(
                "LLM API Key missing. Please set LLM_API_KEY or GEMINI_API_KEY in environment to run the Real LLM Agent."
            )

        # 3. Live LLM API invocation
        if "openai" in self.model_name.lower() or os.environ.get("OPENAI_API_KEY"):
            return self._call_openai_api(
                system_prompt, tools_schema, conversation_history, started
            )
        else:
            return self._call_gemini_api(
                system_prompt, tools_schema, conversation_history, started
            )

    def _call_gemini_api(
        self,
        system_prompt: str,
        tools_schema: list[dict[str, Any]],
        conversation_history: list[dict[str, Any]],
        started_time: float,
    ) -> dict[str, Any]:
        url = f"https://generativelanguage.googleapis.com/v1beta/models/{self.model_name}:generateContent?key={self.api_key}"

        # Convert tool schemas into Gemini FunctionDeclaration format
        gemini_functions = []
        for t in tools_schema:
            gemini_functions.append(
                {
                    "name": t["name"],
                    "description": t.get("description", ""),
                    "parameters": t.get("parameters", {"type": "OBJECT", "properties": {}}),
                }
            )

        contents = []
        for turn in conversation_history[-6:]:
            role = "user" if turn.get("role") == "user" else "model"
            contents.append({"role": role, "parts": [{"text": str(turn.get("content", ""))}]})

        if not contents:
            contents.append({"role": "user", "parts": [{"text": "Execute the next CRM workload step."}]})

        allowed_names = [f["name"] for f in gemini_functions]

        payload = {
            "systemInstruction": {"parts": [{"text": system_prompt}]},
            "contents": contents,
            "tools": [{"functionDeclarations": gemini_functions}],
            "toolConfig": {
                "functionCallingConfig": {
                    "mode": "ANY",
                    "allowedFunctionNames": allowed_names,
                }
            },
        }

        with httpx.Client(timeout=30.0) as client:
            res = client.post(url, json=payload)
            res.raise_for_status()
            data = res.json()

        latency_ms = (time.perf_counter() - started_time) * 1000

        # Extract function call from Gemini response
        candidates = data.get("candidates", [])
        if candidates and "content" in candidates[0]:
            parts = candidates[0]["content"].get("parts", [])
            for part in parts:
                if "functionCall" in part:
                    fc = part["functionCall"]
                    action_name = fc.get("name")
                    args = fc.get("args", {})
                    usage = data.get("usageMetadata", {})
                    prompt_tokens = usage.get("promptTokenCount", 0)
                    completion_tokens = usage.get("candidatesTokenCount", 0)
                    total_tokens = usage.get("totalTokenCount", prompt_tokens + completion_tokens)

                    return {
                        "action": action_name,
                        "args": args,
                        "prompt_tokens": prompt_tokens,
                        "completion_tokens": completion_tokens,
                        "total_tokens": total_tokens,
                        "token_status": "MEASURED" if total_tokens > 0 else "ESTIMATED",
                        "latency_ms": latency_ms,
                        "model": self.model_name,
                    }

        raise RuntimeError(f"Gemini API did not return a valid function call: {json.dumps(data)}")

    def _call_openai_api(
        self,
        system_prompt: str,
        tools_schema: list[dict[str, Any]],
        conversation_history: list[dict[str, Any]],
        started_time: float,
    ) -> dict[str, Any]:
        url = "https://api.openai.com/v1/chat/completions"
        headers = {
            "Authorization": f"Bearer {self.api_key}",
            "Content-Type": "application/json",
        }

        openai_tools = [
            {
                "type": "function",
                "function": {
                    "name": t["name"],
                    "description": t.get("description", ""),
                    "parameters": t.get("parameters", {}),
                },
            }
            for t in tools_schema
        ]

        messages = [{"role": "system", "content": system_prompt}]
        for turn in conversation_history[-6:]:
            messages.append({"role": turn.get("role", "user"), "content": str(turn.get("content", ""))})

        payload = {
            "model": self.model_name,
            "messages": messages,
            "tools": openai_tools,
            "tool_choice": "required",
        }

        with httpx.Client(timeout=30.0) as client:
            res = client.post(url, headers=headers, json=payload)
            res.raise_for_status()
            data = res.json()

        latency_ms = (time.perf_counter() - started_time) * 1000

        choice = data["choices"][0]["message"]
        tool_call = choice["tool_calls"][0]["function"]
        action_name = tool_call["name"]
        args = json.loads(tool_call["arguments"])

        usage = data.get("usage", {})
        prompt_tokens = usage.get("prompt_tokens", 0)
        completion_tokens = usage.get("completion_tokens", 0)
        total_tokens = usage.get("total_tokens", prompt_tokens + completion_tokens)

        return {
            "action": action_name,
            "args": args,
            "prompt_tokens": prompt_tokens,
            "completion_tokens": completion_tokens,
            "total_tokens": total_tokens,
            "token_status": "MEASURED" if total_tokens > 0 else "ESTIMATED",
            "latency_ms": latency_ms,
            "model": self.model_name,
        }
