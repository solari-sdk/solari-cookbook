"""Reads OWASP Juice Shop's own challenge/scoreboard state via its public
`/api/Challenges` REST endpoint - the same endpoint the in-app scoreboard UI
itself calls, unauthenticated by design. Lets Sentinel be pointed at a
specific, objectively-checkable goal ("solve challenge X") instead of
open-ended "find any bug", and lets a solved claim be checked against the
app's own state instead of trusting the model's self-report.

Field names verified against the real juice-shop source (models/challenge.ts,
server.ts) rather than assumed: id, name, category, description, difficulty,
solved, disabledEnv are real columns on the Challenge model; the list
endpoint excludes no fields and requires no auth.

Caveat: this is a SHARED public demo instance. Another concurrent user could
solve the same challenge in parallel, so a flipped `solved` flag corroborates
a run's own proof - it does not by itself prove *this run* caused it.
"""

from __future__ import annotations

import json
import urllib.request


def _fetch(target_url: str) -> list[dict]:
    url = f"{target_url.rstrip('/')}/api/Challenges/"
    req = urllib.request.Request(url, headers={"User-Agent": "Mozilla/5.0"})
    with urllib.request.urlopen(req, timeout=15) as resp:
        body = json.loads(resp.read())
    return body["data"]


def pick_challenge(
    target_url: str, max_difficulty: int = 2, category: str | None = None
) -> dict | None:
    """Return the lowest-difficulty unsolved, non-disabled challenge (optionally
    restricted to `category`), or None if nothing matches - e.g. everything at
    this difficulty was already solved by other concurrent users."""
    challenges = _fetch(target_url)
    candidates = [
        c
        for c in challenges
        if not c["solved"]
        and c["difficulty"] <= max_difficulty
        and not c.get("disabledEnv")
        and (category is None or c["category"] == category)
    ]
    if not candidates:
        return None
    candidates.sort(key=lambda c: c["difficulty"])
    return candidates[0]


def is_solved(target_url: str, challenge_id: int) -> bool:
    """Ground truth for whether a challenge is solved, read fresh from the
    app itself - independent of anything the model claims in `finish()`."""
    for c in _fetch(target_url):
        if c["id"] == challenge_id:
            return bool(c["solved"])
    return False
