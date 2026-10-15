"""
evidence/sandbox_escape_demo.py — Contrast #2: cross-session isolation.

Correction from an earlier version of this file: testing whether code can
write to /etc/passwd INSIDE its own disposable sandbox is not a meaningful
security test — that's your own throwaway VM, root actions on it are
expected and not a vulnerability. The real isolation claim Solari makes is
that sandboxes don't leak into each other or the host, not that root is
restricted within your own ephemeral machine. Don't reintroduce that test.

Real tests here:
  1. Network egress check — factual, not a vulnerability either way, just
     worth knowing before running untrusted agent code.
  2. Cross-session isolation — write a secret in sandbox A, destroy it,
     spin up a FRESH sandbox B, confirm it can't see A's data. This is the
     actual meaningful proof of per-session isolation.
"""

import asyncio
import os
from dataclasses import dataclass

USE_REAL_SOLARI = bool(os.environ.get("SOLARI_API_KEY"))

if USE_REAL_SOLARI:
    from solari_sandbox import SandboxClient  # pip install solari-sandbox


@dataclass
class CheckResult:
    name: str
    detail: str
    passed: bool  # meaning varies per check — read `detail`, don't just trust this


async def check_network_egress(sandboxes) -> CheckResult:
    sbx = await sandboxes.create(template="base")
    try:
        await sbx.connect()
        code = "import urllib.request; urllib.request.urlopen('http://example.com', timeout=5); print('REACHED')"
        await sbx.files.write("/tmp/net_check.py", code)
        res = await sbx.commands.run("python3", args=["/tmp/net_check.py"])
        reached = "REACHED" in (res.stdout or "")
        return CheckResult(
            "network_egress",
            f"Outbound network {'IS' if reached else 'is NOT'} allowed by default "
            f"(exit_code={res.exitCode}, stdout={res.stdout!r}, stderr={res.stderr!r})",
            passed=reached,
        )
    finally:
        await sbx.kill()


async def check_cross_session_isolation(sandboxes) -> CheckResult:
    secret_path = "/tmp/secret_from_session_a.txt"
    secret_value = "TOP-SECRET-12345"

    sbx_a = await sandboxes.create(template="base")
    try:
        await sbx_a.connect()
        await sbx_a.files.write(secret_path, secret_value)
        confirm = await sbx_a.files.read_text(secret_path)
        assert confirm.strip() == secret_value, "sandbox A couldn't even read its own write"
    finally:
        await sbx_a.kill()

    sbx_b = await sandboxes.create(template="base")
    try:
        await sbx_b.connect()
        code = (
            f"import os\n"
            f"p = {secret_path!r}\n"
            f"print('EXISTS' if os.path.exists(p) else 'ABSENT')"
        )
        await sbx_b.files.write("/tmp/isolation_check.py", code)
        res = await sbx_b.commands.run("python3", args=["/tmp/isolation_check.py"])
        leaked = "EXISTS" in (res.stdout or "")
        return CheckResult(
            "cross_session_isolation",
            f"Fresh sandbox B {'CAN' if leaked else 'cannot'} see sandbox A's file "
            f"(stdout={res.stdout!r}) — isolation {'FAILED' if leaked else 'held'}",
            passed=not leaked,
        )
    finally:
        await sbx_b.kill()


async def run_checks() -> list[CheckResult]:
    if not USE_REAL_SOLARI:
        return [CheckResult("stub", "SOLARI_API_KEY not set — nothing real to check", passed=False)]

    sandboxes = SandboxClient(
        api_key=os.environ["SOLARI_API_KEY"],
        base_url="https://api.getsolari.com",
    )
    return [
        await check_network_egress(sandboxes),
        await check_cross_session_isolation(sandboxes),
    ]


if __name__ == "__main__":
    print("Sandbox isolation checks\n")
    for r in asyncio.run(run_checks()):
        print(f"[{r.name}]")
        print(f"    {r.detail}\n")