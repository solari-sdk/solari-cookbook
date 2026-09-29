"""Independent post-run check on the model's `finish` claim.

Mirrors qa-agent's is_solved() / code-agent's verify_service(): re-checks
the outcome with our own code, called from main.py AFTER the run, not
anything the model's transcript can influence. The channel (desktop.exec)
is the same one the model itself uses via the `shell` tool, but the call
here is ours - the model never sees or controls this specific check.
"""

from __future__ import annotations


async def verify_file(toolkit, path: str, expected_content: str) -> dict:
    if not path:
        return {"checked": False}

    result = await toolkit.shell("cat", [path])
    if result.startswith("ERROR:"):
        return {"checked": True, "exists": False, "error": result}

    # toolkit.shell() returns "exit=..\nstdout:\n<stdout>\nstderr:\n<stderr>",
    # truncated to 4000 chars - pull the stdout section back out.
    stdout = ""
    if "stdout:\n" in result:
        stdout = result.split("stdout:\n", 1)[1].split("\nstderr:\n", 1)[0]

    matches = (stdout.strip() == expected_content.strip()) if expected_content else None
    return {
        "checked": True,
        "exists": "exit=0" in result.splitlines()[0] if result else False,
        "content": stdout,
        "matches_expected": matches,
    }
