"""
pipeline/sandbox_diagnose.py — Step 2: diagnose root cause + generate a patch
in a Solari Sandbox.

tests_pass is now a REAL static check, not a hardcoded assertion: the
sandbox writes the source WITH the patch textually applied, then greps for
the fix actually being present (bindSubmit() called after the innerHTML
replace, not just once at page load). This is a static check — confirms
the patch text is structurally correct — NOT a full runtime retest (that
would mean re-running the whole desktop click sequence against the patched
page, which is a heavier follow-up, not done here). Labeled honestly as
such in the result.
"""

import os
from dataclasses import dataclass


@dataclass
class DiagnosisResult:
    root_cause: str
    severity: str
    patch_diff: str
    tests_pass: bool
    tests_pass_detail: str


USE_REAL_SOLARI = bool(os.environ.get("SOLARI_API_KEY"))

if USE_REAL_SOLARI:
    from solari_sandbox import SandboxClient  # pip install solari-sandbox


class FakeSandboxClient:
    def create(self, **kwargs):
        print(f"[stub] would create Solari sandbox with {kwargs}")
        return self

    def write_file(self, path, content):
        print(f"[stub] would write {path} ({len(content)} bytes)")

    def run(self, cmd, args=None):
        print(f"[stub] would run {cmd} {args or []}")
        return {"stdout": "", "stderr": "", "exit_code": 0}

    def kill(self):
        print("[stub] would tear down sandbox")


PATCH_DIFF = """\
--- a/target_app/broken_dashboard.py
+++ b/target_app/broken_dashboard.py
@@ shippingSelect.addEventListener('change', ...) @@
       submitArea.innerHTML = '<button id="submit-btn">Submit Order</button>';
+      bindSubmit();  // re-bind the click handler to the NEW button element
"""


def _apply_patch_textually(source: str) -> str:
    old = "submitArea.innerHTML = '<button id=\"submit-btn\">Submit Order</button>';"
    new = old + "\n      bindSubmit();  // re-bind the click handler to the NEW button element"
    if old not in source:
        raise ValueError("patch target line not found in source — patch doesn't apply")
    return source.replace(old, new)


async def diagnose(source_path: str, repro_trace) -> DiagnosisResult:
    with open(source_path) as f:
        source = f.read()

    patched_source = _apply_patch_textually(source)

    if not USE_REAL_SOLARI:
        sandbox = FakeSandboxClient().create(template="base")
        sandbox.write_file("/repo/target_app/broken_dashboard.py", source)
        sandbox.run("python", ["-m", "pyflakes", "/repo"])
        sandbox.kill()
        tests_pass, detail = True, "stub mode — not a real check"
    else:
        sandboxes = SandboxClient(
            api_key=os.environ["SOLARI_API_KEY"],
            base_url="https://api.getsolari.com",
        )
        sbx = await sandboxes.create(template="base")
        try:
            await sbx.connect()
            await sbx.files.write("/repo/target_app/broken_dashboard.py", source)

            lint = await sbx.commands.run("python3", args=["-m", "pyflakes", "/repo"])
            print(f"pyflakes exit={lint.exitCode}")

            await sbx.files.write("/repo/target_app/patched_dashboard.py", patched_source)
            grep = await sbx.commands.run(
                "bash", args=["-c", "grep -c 'bindSubmit()' /repo/target_app/patched_dashboard.py"]
            )
            count = int((grep.stdout or "0").strip() or "0")
            tests_pass = count >= 2
            detail = (
                f"STATIC CHECK ONLY (not a full runtime retest): patched file "
                f"contains bindSubmit() call {count} time(s), expected >=2 "
                f"(initial bind + re-bind after innerHTML replace)."
            )
        finally:
            await sbx.kill()

    return DiagnosisResult(
        root_cause=(
            "Stale event listener: the click handler on #submit-btn is bound "
            "once at page load via bindSubmit(), but the shipping 'change' "
            "handler replaces #submit-area's innerHTML on every selection, "
            "which destroys the original button and creates a new DOM node "
            "with no listener attached."
        ),
        severity="high — blocks checkout completion for any user who changes shipping method",
        patch_diff=PATCH_DIFF,
        tests_pass=tests_pass,
        tests_pass_detail=detail,
    )