#!/usr/bin/env python3
"""Official X (Twitter) OAuth 2.0 user login — PKCE, localhost callback.

This is not Grok and not a password prompt. You create an app at
developer.x.com, then this script opens the X consent screen in *your*
browser and stores a user token on this machine only.

  export X_CLIENT_ID=...
  export X_CLIENT_SECRET=...          # confidential apps (typical)
  export X_REDIRECT_URI=http://127.0.0.1:8787/callback
  python3 xauth.py login
  python3 xauth.py me
  python3 xauth.py post --text "hello"
  python3 xauth.py post --file ../../examples/release-watch-py/SOCIAL.md
  python3 xauth.py logout

Tokens: ~/.config/x-user/tokens.json (mode 0600). Never commit that file.
"""

from __future__ import annotations

import argparse
import base64
import hashlib
import hmac
import http.server
import json
import os
import re
import secrets
import sys
import threading
import time
import urllib.error
import urllib.parse
import urllib.request
import webbrowser
from pathlib import Path

AUTHORIZE_URL = "https://x.com/i/oauth2/authorize"
TOKEN_URL = "https://api.twitter.com/2/oauth2/token"
API = "https://api.twitter.com/2"
DEFAULT_REDIRECT = "http://127.0.0.1:8787/callback"
DEFAULT_SCOPES = (
    "tweet.read tweet.write users.read offline.access"
)
TOKEN_PATH = Path.home() / ".config" / "x-user" / "tokens.json"


def _b64url(raw: bytes) -> str:
    return base64.urlsafe_b64encode(raw).decode("ascii").rstrip("=")


def _pkce() -> tuple[str, str]:
    verifier = _b64url(secrets.token_bytes(32))
    challenge = _b64url(hashlib.sha256(verifier.encode("ascii")).digest())
    return verifier, challenge


def _basic_auth(client_id: str, client_secret: str) -> str:
    raw = f"{client_id}:{client_secret}".encode("utf-8")
    return "Basic " + base64.b64encode(raw).decode("ascii")


def _form(url: str, data: dict[str, str], headers: dict[str, str] | None = None) -> dict:
    body = urllib.parse.urlencode(data).encode("utf-8")
    req = urllib.request.Request(url, data=body, method="POST")
    req.add_header("Content-Type", "application/x-www-form-urlencoded")
    for k, v in (headers or {}).items():
        req.add_header(k, v)
    try:
        with urllib.request.urlopen(req, timeout=30) as res:
            return json.loads(res.read().decode("utf-8"))
    except urllib.error.HTTPError as exc:
        detail = exc.read().decode("utf-8", errors="replace")
        raise SystemExit(f"X token HTTP {exc.code}: {detail}") from exc


def _pct(value: str) -> str:
    return urllib.parse.quote(str(value), safe="")


def _oauth1_header(
    method: str,
    url: str,
    consumer_key: str,
    consumer_secret: str,
    token: str,
    token_secret: str,
) -> str:
    params = {
        "oauth_consumer_key": consumer_key,
        "oauth_nonce": secrets.token_hex(16),
        "oauth_signature_method": "HMAC-SHA1",
        "oauth_timestamp": str(int(time.time())),
        "oauth_token": token,
        "oauth_version": "1.0",
    }
    encoded = "&".join(f"{_pct(k)}={_pct(v)}" for k, v in sorted(params.items()))
    base = "&".join([method.upper(), _pct(url), _pct(encoded)])
    key = f"{_pct(consumer_secret)}&{_pct(token_secret)}"
    digest = hmac.new(key.encode("utf-8"), base.encode("utf-8"), hashlib.sha1).digest()
    params["oauth_signature"] = base64.b64encode(digest).decode("ascii")
    return "OAuth " + ", ".join(
        f'{_pct(k)}="{_pct(v)}"' for k, v in sorted(params.items())
    )


def _request(
    method: str,
    path: str,
    authorization: str,
    payload: dict | None = None,
) -> dict:
    data = None if payload is None else json.dumps(payload).encode("utf-8")
    req = urllib.request.Request(API + path, data=data, method=method)
    req.add_header("Authorization", authorization)
    if payload is not None:
        req.add_header("Content-Type", "application/json")
    try:
        with urllib.request.urlopen(req, timeout=30) as res:
            raw = res.read().decode("utf-8")
            return json.loads(raw) if raw else {}
    except urllib.error.HTTPError as exc:
        detail = exc.read().decode("utf-8", errors="replace")
        raise SystemExit(f"X API HTTP {exc.code}: {detail}") from exc


def _api(
    method: str,
    path: str,
    access_token: str,
    payload: dict | None = None,
) -> dict:
    return _request(method, path, f"Bearer {access_token}", payload)


def _api_oauth1(doc: dict, method: str, path: str, payload: dict | None = None) -> dict:
    url = API + path
    header = _oauth1_header(
        method,
        url,
        doc["consumer_key"],
        doc["consumer_secret"],
        doc["access_token"],
        doc["access_token_secret"],
    )
    return _request(method, path, header, payload)


def _env(name: str) -> str:
    value = os.environ.get(name, "").strip().strip("'\"")
    if not value:
        raise SystemExit(f"Set {name} in this Terminal (from X Keys and tokens).")
    return value


def authed_api(method: str, path: str, payload: dict | None = None) -> dict:
    doc = load_tokens()
    if doc.get("kind") == "oauth1":
        return _api_oauth1(doc, method, path, payload)
    doc = refresh_if_needed(doc)
    return _api(method, path, doc["access_token"], payload)


def load_tokens() -> dict:
    if not TOKEN_PATH.is_file():
        raise SystemExit(f"Not logged in. Run: python3 xauth.py login\n({TOKEN_PATH})")
    return json.loads(TOKEN_PATH.read_text(encoding="utf-8"))


def save_tokens(doc: dict) -> None:
    TOKEN_PATH.parent.mkdir(parents=True, exist_ok=True)
    TOKEN_PATH.write_text(json.dumps(doc, indent=2) + "\n", encoding="utf-8")
    TOKEN_PATH.chmod(0o600)


def client_id() -> str:
    value = os.environ.get("X_CLIENT_ID", "").strip().strip("'\"")
    if not value:
        raise SystemExit("Set X_CLIENT_ID from your X developer app (OAuth 2.0 Client ID).")
    # X Client IDs are often like "xxxx:yyyy" (colon). Reject only non-ASCII junk.
    if not re.fullmatch(r"[A-Za-z0-9_.:/=+-]+", value):
        raise SystemExit(
            "X_CLIENT_ID has invalid characters (not a normal OAuth 2.0 Client ID).\n"
            "Copy OAuth 2.0 Client ID only — not the Bearer token."
        )
    return value


def redirect_uri() -> str:
    return os.environ.get("X_REDIRECT_URI", DEFAULT_REDIRECT).strip()


def client_secret() -> str:
    value = os.environ.get("X_CLIENT_SECRET", "").strip().strip("'\"")
    if not value:
        raise SystemExit(
            "Set X_CLIENT_SECRET in this same Terminal.\n"
            "X app type Web App is a confidential client: the token request\n"
            "must send HTTP Basic (client_id:client_secret).\n"
            "Use OAuth 2.0 Client Secret — not the Consumer Secret or Bearer token."
        )
    return value


def token_headers() -> dict[str, str]:
    return {"Authorization": _basic_auth(client_id(), client_secret())}


def refresh_if_needed(doc: dict) -> dict:
    exp = float(doc.get("expires_at", 0))
    if exp - time.time() > 60:
        return doc
    refresh = doc.get("refresh_token")
    if not refresh:
        raise SystemExit("Access token expired and no refresh_token. Run login again.")
    data = {
        "grant_type": "refresh_token",
        "refresh_token": refresh,
        "client_id": client_id(),
    }
    got = _form(TOKEN_URL, data, token_headers())
    doc = {
        **doc,
        "access_token": got["access_token"],
        "refresh_token": got.get("refresh_token", refresh),
        "expires_at": time.time() + int(got.get("expires_in", 7200)),
        "scope": got.get("scope", doc.get("scope")),
    }
    save_tokens(doc)
    return doc


class _Callback(http.server.BaseHTTPRequestHandler):
    code: str | None = None
    err: str | None = None

    def do_GET(self) -> None:  # noqa: N802
        parsed = urllib.parse.urlparse(self.path)
        qs = urllib.parse.parse_qs(parsed.query)
        if parsed.path != urllib.parse.urlparse(redirect_uri()).path:
            self.send_error(404)
            return
        if qs.get("error"):
            type(self).err = qs.get("error_description", qs["error"])[0]
        else:
            type(self).code = (qs.get("code") or [None])[0]
        self.send_response(200)
        self.send_header("Content-Type", "text/html; charset=utf-8")
        self.end_headers()
        self.wfile.write(
            b"<html><body><p>X login finished. You can close this tab.</p></body></html>"
        )

    def log_message(self, fmt: str, *args: object) -> None:
        return


def cmd_login(args: argparse.Namespace) -> int:
    verifier, challenge = _pkce()
    state = secrets.token_urlsafe(24)
    scopes = args.scopes or os.environ.get("X_SCOPES", DEFAULT_SCOPES)
    query = urllib.parse.urlencode(
        {
            "response_type": "code",
            "client_id": client_id(),
            "redirect_uri": redirect_uri(),
            "scope": scopes,
            "state": state,
            "code_challenge": challenge,
            "code_challenge_method": "S256",
        }
    )
    url = f"{AUTHORIZE_URL}?{query}"
    parsed = urllib.parse.urlparse(redirect_uri())
    host = parsed.hostname or "127.0.0.1"
    port = parsed.port or (443 if parsed.scheme == "https" else 80)

    server = http.server.HTTPServer((host, port), _Callback)
    thread = threading.Thread(target=server.serve_forever, daemon=True)
    thread.start()
    # Fail early so a missing secret is not discovered after the browser hop.
    _ = token_headers()
    print("Using confidential client (Authorization: Basic).")
    print("Open this URL if the browser does not launch:\n")
    print(url)
    print()
    webbrowser.open(url)

    for _ in range(300):
        if _Callback.code or _Callback.err:
            break
        time.sleep(0.2)
    server.shutdown()

    if _Callback.err:
        raise SystemExit(f"X denied login: {_Callback.err}")
    if not _Callback.code:
        raise SystemExit("Timed out waiting for the X redirect. Check X_REDIRECT_URI matches the app.")

    data = {
        "grant_type": "authorization_code",
        "code": _Callback.code,
        "redirect_uri": redirect_uri(),
        "client_id": client_id(),
        "code_verifier": verifier,
    }
    got = _form(TOKEN_URL, data, token_headers())
    save_tokens(
        {
            "access_token": got["access_token"],
            "refresh_token": got.get("refresh_token"),
            "expires_at": time.time() + int(got.get("expires_in", 7200)),
            "scope": got.get("scope", scopes),
            "token_type": got.get("token_type", "bearer"),
        }
    )
    print(f"Saved user token to {TOKEN_PATH}")
    return cmd_me(args)


def cmd_login_v1(_args: argparse.Namespace) -> int:
    """Store OAuth 1.0a user tokens from the X console (no browser)."""
    save_tokens(
        {
            "kind": "oauth1",
            "consumer_key": _env("X_API_KEY"),
            "consumer_secret": _env("X_API_SECRET"),
            "access_token": _env("X_ACCESS_TOKEN"),
            "access_token_secret": _env("X_ACCESS_TOKEN_SECRET"),
        }
    )
    print(f"Saved OAuth 1.0a user tokens to {TOKEN_PATH}")
    return cmd_me(_args)


def cmd_me(_args: argparse.Namespace) -> int:
    doc = load_tokens()
    me = authed_api("GET", "/users/me")
    data = me.get("data") or {}
    print(f"@{data.get('username', '?')}  id={data.get('id', '?')}  {data.get('name', '')}")
    print("auth:", doc.get("kind", "oauth2"))
    if doc.get("scope"):
        print("scopes:", doc["scope"])
    return 0


def cmd_status(_args: argparse.Namespace) -> int:
    if not TOKEN_PATH.is_file():
        print("logged_out")
        return 1
    doc = json.loads(TOKEN_PATH.read_text(encoding="utf-8"))
    print(f"token_file={TOKEN_PATH}")
    print(f"kind={doc.get('kind', 'oauth2')}")
    if doc.get("kind") == "oauth1":
        print("oauth1=yes")
        return 0
    left = int(float(doc.get("expires_at", 0)) - time.time())
    print(f"expires_in_s={left}")
    print(f"has_refresh={bool(doc.get('refresh_token'))}")
    print(f"scope={doc.get('scope')}")
    return 0


def cmd_post(args: argparse.Namespace) -> int:
    if args.file:
        text = Path(args.file).read_text(encoding="utf-8").strip()
    else:
        text = (args.text or "").strip()
    if not text:
        raise SystemExit("Provide --text or --file")
    if len(text) > 280:
        print(f"Note: {len(text)} chars. X may reject or require Premium for long posts.", file=sys.stderr)
    res = authed_api("POST", "/tweets", {"text": text})
    tweet = res.get("data") or {}
    print(f"posted id={tweet.get('id')}  https://x.com/i/web/status/{tweet.get('id')}")
    return 0


def cmd_logout(_args: argparse.Namespace) -> int:
    if TOKEN_PATH.is_file():
        TOKEN_PATH.unlink()
    print("logged_out")
    return 0


def main() -> int:
    p = argparse.ArgumentParser(description="X OAuth 2.0 user auth (official API)")
    sub = p.add_subparsers(dest="cmd", required=True)

    login = sub.add_parser("login", help="Browser PKCE login (OAuth 2.0)")
    login.add_argument("--scopes", default=None, help="Override X_SCOPES / defaults")
    login.set_defaults(func=cmd_login)

    sub.add_parser(
        "login-v1",
        help="Save OAuth 1.0a tokens from the X console (no browser)",
    ).set_defaults(func=cmd_login_v1)

    sub.add_parser("me", help="GET /2/users/me").set_defaults(func=cmd_me)
    sub.add_parser("status", help="Token file status").set_defaults(func=cmd_status)
    sub.add_parser("logout", help="Delete local tokens").set_defaults(func=cmd_logout)

    post = sub.add_parser("post", help="POST /2/tweets as the logged-in user")
    post.add_argument("--text", default="")
    post.add_argument("--file", default="")
    post.set_defaults(func=cmd_post)

    args = p.parse_args()
    return args.func(args)


if __name__ == "__main__":
    try:
        raise SystemExit(main())
    except KeyboardInterrupt:
        raise SystemExit(130)
