"""Thin async wrapper around Solari's sandbox client — the only Solari
product this project uses (see code-agent/README.md for why: this is
deliberately the sandbox-only submission, split out from qa-agent's
browser+sandbox one).

Call patterns copied from the cookbook's own sandbox-code-interpreter-py
and sandbox-port-preview-ts examples to avoid guessing at lifecycle rules:
sandbox needs kill() not close(), commands.run(background=True) returns
immediately instead of blocking on a long-lived server process.
"""

from __future__ import annotations

from solari_sandbox import SandboxClient

BASE_URL = "https://api.getsolari.com"


class SandboxToolkit:
    def __init__(self, api_key: str):
        self.api_key = api_key
        self._client: SandboxClient | None = None
        self._sandbox = None
        self._code_ctx = None

    async def _ensure_sandbox(self) -> None:
        if self._sandbox is not None:
            return
        self._client = SandboxClient(api_key=self.api_key, base_url=BASE_URL)
        await self._client.__aenter__()
        # Longer idle window than qa-agent's sandbox: a self-debug loop can
        # take several write/run/read-error round trips.
        self._sandbox = await self._client.create(template="base", timeout_ms=10 * 60_000)
        await self._sandbox.connect()
        self._code_ctx = await self._sandbox.create_code_context("python")

    # Every method below returns a plain string (success or "ERROR: ...")
    # rather than raising - these are tool-call results the model reacts to,
    # not exceptions that should crash the whole run. Same shape qa-agent
    # uses for browser_open/sandbox_exec.

    async def write_file(self, path: str, content: str) -> str:
        await self._ensure_sandbox()
        try:
            await self._sandbox.files.write(path, content)
            return f"wrote {len(content)} bytes to {path}"
        except Exception as e:
            return f"ERROR: {e}"

    async def run_command(
        self, cmd: str, args: list[str] | None = None, background: bool = False
    ) -> str:
        await self._ensure_sandbox()
        try:
            result = await self._sandbox.commands.run(
                cmd, args=args or [], timeout_ms=60_000, background=background
            )
            if background:
                return f"started {cmd} {' '.join(args or [])} in background"
            out = f"exit={result.exitCode}\nstdout:\n{result.stdout}\nstderr:\n{result.stderr}"
            return out[:4000]
        except Exception as e:
            return f"ERROR: {e}"

    async def run_code(self, code: str) -> str:
        await self._ensure_sandbox()
        try:
            result = await self._sandbox.run_code(code, context_id=self._code_ctx)
            if result.error:
                return f"ERROR: {result.error}"
            out = []
            for item in result.results:
                label = getattr(item, "type", "result")
                text = getattr(item, "text", None)
                if text:
                    out.append(f"[{label}] {text}")
            return "\n".join(out) or "(no output)"
        except Exception as e:
            return f"ERROR: {e}"

    async def expose_port(self, port: int) -> str:
        await self._ensure_sandbox()
        try:
            info = await self._sandbox.preview_url(port)
            url = info.get("url") if isinstance(info, dict) else getattr(info, "url", None)
            if not url:
                return f"ERROR: preview_url returned no url ({info!r})"
            return f"public url: {url}"
        except Exception as e:
            return f"ERROR: {e}"

    async def close(self) -> None:
        if self._sandbox:
            await self._sandbox.kill()
        if self._client:
            await self._client.__aexit__(None, None, None)
