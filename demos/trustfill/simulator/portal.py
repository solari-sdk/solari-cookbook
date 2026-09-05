"""Northwind Corp vendor portal — the customer's side of a security review.

Stdlib only: the Solari base sandbox has Python, and `pip install` inside a
demo VM is a failure mode waiting to happen.

Serves a login page, the questionnaire, and a draft-save endpoint. Every
interactive element carries a data-testid so the browser automation targets
semantics rather than layout — see scope §5, deterministic automation.

Synthetic throughout. The credentials below are fake and safe to commit.
"""

import json
import os
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from urllib.parse import parse_qs

ROOT = os.path.dirname(os.path.abspath(__file__))
EMAIL = "vendor@meridian.example"
PASSWORD = "trustfill-demo"
COOKIE = "northwind_session=ok"

with open(os.path.join(ROOT, "questionnaire.json"), encoding="utf-8") as fh:
    QUESTIONS = json.load(fh)["questions"]

DRAFT_PATH = os.path.join(ROOT, "draft.json")

CSS = """
*{box-sizing:border-box}
body{margin:0;font:15px/1.55 -apple-system,Segoe UI,Roboto,sans-serif;color:#1f2933;background:#eef1f5}
header{background:#12324f;color:#fff;padding:14px 28px;display:flex;align-items:center;gap:14px}
header b{font-size:17px;letter-spacing:.3px}
header span{opacity:.75;font-size:13px}
main{max-width:900px;margin:28px auto;padding:0 20px}
.card{background:#fff;border:1px solid #d4dae2;border-radius:4px;padding:26px;margin-bottom:18px}
h1{font-size:20px;margin:0 0 4px}
.sub{color:#5b6b7c;font-size:13px;margin-bottom:22px}
label{display:block;font-weight:600;font-size:14px;margin-bottom:7px}
input[type=email],input[type=password]{width:100%;padding:9px 11px;border:1px solid #b9c2cd;border-radius:3px;font-size:14px}
textarea{width:100%;min-height:74px;padding:9px 11px;border:1px solid #b9c2cd;border-radius:3px;font:14px/1.5 inherit;resize:vertical}
button{background:#12324f;color:#fff;border:0;padding:10px 22px;border-radius:3px;font-size:14px;font-weight:600;cursor:pointer}
.q{border-bottom:1px solid #e6eaef;padding:18px 0}
.q:last-child{border-bottom:0}
.qid{color:#7b8794;font-size:12px;font-weight:600;letter-spacing:.4px}
.qt{font-weight:600;margin:3px 0 9px}
.bar{position:sticky;bottom:0;background:#fff;border-top:1px solid #d4dae2;padding:14px 0;display:flex;justify-content:space-between;align-items:center}
.note{color:#5b6b7c;font-size:13px}
.err{color:#a3242b;font-size:13px;margin-top:10px}
"""


def page(title, body):
    return f"""<!doctype html><html><head><meta charset="utf-8"><title>{title}</title><style>{CSS}</style></head>
<body><header><b>NORTHWIND</b><span>Vendor Risk Management</span></header><main>{body}</main></body></html>"""


LOGIN = page(
    "Sign in — Northwind Vendor Portal",
    """<div class="card" style="max-width:420px;margin:60px auto">
  <h1>Vendor sign in</h1>
  <div class="sub">Northwind Corp — Third-Party Risk</div>
  <form method="post" action="/login">
    <label for="email">Work email</label>
    <input id="email" name="email" type="email" data-testid="login-email" autocomplete="username">
    <div style="height:14px"></div>
    <label for="password">Password</label>
    <input id="password" name="password" type="password" data-testid="login-password" autocomplete="current-password">
    <div style="height:18px"></div>
    <button type="submit" data-testid="login-submit">Sign in</button>
  </form>
  <div class="note" style="margin-top:18px">Authorized vendor contacts only.</div>
</div>""",
)


def questionnaire_page(saved):
    rows = []
    for q in QUESTIONS:
        val = saved.get(q["id"], "")
        rows.append(
            f"""<div class="q">
  <div class="qid">{q['id']}</div>
  <div class="qt">{q['text']}</div>
  <textarea name="{q['id']}" data-testid="answer-{q['id']}" placeholder="">{val}</textarea>
</div>"""
        )
    return page(
        "Vendor Security Review — Northwind",
        f"""<div class="card">
  <h1>Vendor Security Review</h1>
  <div class="sub">Meridian Systems, Inc. &middot; {len(QUESTIONS)} questions &middot; Draft — not submitted</div>
  <form method="post" action="/draft" data-testid="questionnaire-form">
    {''.join(rows)}
    <div class="bar">
      <span class="note" data-testid="draft-status">Draft saves are visible to Northwind reviewers only after submission.</span>
      <button type="submit" data-testid="save-draft">Save draft</button>
    </div>
  </form>
</div>""",
    )


class Handler(BaseHTTPRequestHandler):
    def log_message(self, *args):
        pass  # quiet: the sandbox console is for our own output

    def _send(self, code, body, headers=()):
        raw = body.encode("utf-8")
        self.send_response(code)
        self.send_header("Content-Type", "text/html; charset=utf-8")
        self.send_header("Content-Length", str(len(raw)))
        for k, v in headers:
            self.send_header(k, v)
        self.end_headers()
        self.wfile.write(raw)

    def _authed(self):
        return COOKIE in (self.headers.get("Cookie") or "")

    def _saved(self):
        try:
            with open(DRAFT_PATH, encoding="utf-8") as fh:
                return json.load(fh)
        except (OSError, ValueError):
            return {}

    def do_GET(self):
        if self.path.startswith("/health"):
            self._send(200, "ok")
        elif self.path.startswith("/login"):
            self._send(200, LOGIN)
        elif self.path.startswith("/questionnaire"):
            if not self._authed():
                self.send_response(302)
                self.send_header("Location", "/login")
                self.end_headers()
                return
            self._send(200, questionnaire_page(self._saved()))
        elif self.path.startswith("/api/draft"):
            body = json.dumps(self._saved(), indent=2)
            raw = body.encode("utf-8")
            self.send_response(200)
            self.send_header("Content-Type", "application/json")
            self.send_header("Content-Length", str(len(raw)))
            self.end_headers()
            self.wfile.write(raw)
        else:
            self.send_response(302)
            self.send_header("Location", "/questionnaire" if self._authed() else "/login")
            self.end_headers()

    def do_POST(self):
        length = int(self.headers.get("Content-Length") or 0)
        form = parse_qs(self.rfile.read(length).decode("utf-8"))

        if self.path.startswith("/login"):
            email = (form.get("email") or [""])[0]
            password = (form.get("password") or [""])[0]
            if email == EMAIL and password == PASSWORD:
                self.send_response(302)
                # Max-Age rather than a session cookie, because real portals issue
                # persistent sessions. NOTE: this was NOT what broke profile restore —
                # that was newPage() vs newContext({storageState}); see src/browser.ts.
                # Kept for realism, not as a fix.
                self.send_header("Set-Cookie", f"{COOKIE}; Path=/; Max-Age=86400")
                self.send_header("Location", "/questionnaire")
                self.end_headers()
            else:
                self._send(401, LOGIN.replace("</form>", '</form><div class="err">Incorrect email or password.</div>'))
            return

        if self.path.startswith("/draft"):
            if not self._authed():
                self._send(403, page("Forbidden", "<div class='card'>Not signed in.</div>"))
                return
            answers = {q["id"]: (form.get(q["id"]) or [""])[0] for q in QUESTIONS}
            with open(DRAFT_PATH, "w", encoding="utf-8") as fh:
                json.dump(answers, fh, indent=2)
            filled = sum(1 for v in answers.values() if v.strip())
            self._send(
                200,
                questionnaire_page(answers).replace(
                    'data-testid="draft-status">Draft saves are visible to Northwind reviewers only after submission.',
                    f'data-testid="draft-status">Draft saved &middot; {filled} of {len(QUESTIONS)} answered',
                ),
            )
            return

        self._send(404, page("Not found", "<div class='card'>Not found.</div>"))


if __name__ == "__main__":
    port = int(os.environ.get("PORT", "3000"))
    ThreadingHTTPServer(("0.0.0.0", port), Handler).serve_forever()
