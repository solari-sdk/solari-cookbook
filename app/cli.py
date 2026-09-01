from __future__ import annotations

import argparse
import json
import os
import sys
from pathlib import Path

from app.main import SOURCES, VERSION
from app.storage import DB_PATH, connect, list_events, source_health


def doctor() -> int:
    checks: dict[str, object] = {
        "python": sys.version.split()[0],
        "version": VERSION,
        "static_dashboard": (Path(__file__).parent / "static" / "index.html").is_file(),
        "static_no_hosting_console": (Path(__file__).resolve().parents[1] / "static-console" / "index.html").is_file(),
        "solari_api_key_configured": bool(os.getenv("SOLARI_API_KEY")),
        "database_path": str(DB_PATH),
        "database_writable": False,
    }
    try:
        with connect() as db:
            checks["database_writable"] = db.execute("SELECT 1").fetchone()[0] == 1
    except Exception as exc:
        checks["database_error"] = type(exc).__name__
    required = [checks["static_dashboard"], checks["static_no_hosting_console"], checks["database_writable"]]
    print(json.dumps(checks, indent=2, sort_keys=True))
    return 0 if all(required) else 1


def validate_config() -> int:
    configuration = {
        "SOLARI_API_KEY": "configured" if os.getenv("SOLARI_API_KEY") else "optional/missing (live Solari calls unavailable)",
        "database_parent_exists": DB_PATH.parent.exists() or DB_PATH.parent.parent.exists(),
        "registered_sources": len(SOURCES),
    }
    print(json.dumps(configuration, indent=2, sort_keys=True))
    return 0


def main() -> int:
    parser = argparse.ArgumentParser(prog="solari-ops", description="Local CLI for the public Solari OSINT Operations Center")
    sub = parser.add_subparsers(dest="command", required=True)
    sub.add_parser("doctor", help="Run local diagnostics without exposing secrets")
    sub.add_parser("config-check", help="Validate safe configuration state")
    sub.add_parser("sources", help="List registered public sources")
    events = sub.add_parser("events", help="List persisted normalized events")
    events.add_argument("--limit", type=int, default=20)
    sub.add_parser("source-health", help="Show persisted source health")
    args = parser.parse_args()
    if args.command == "doctor": return doctor()
    if args.command == "config-check": return validate_config()
    if args.command == "sources":
        print(json.dumps([item.model_dump(mode="json") for item in SOURCES.values()], indent=2, default=str)); return 0
    if args.command == "events":
        if args.limit < 1 or args.limit > 1000: parser.error("--limit must be between 1 and 1000")
        print(json.dumps(list_events(args.limit), indent=2, default=str)); return 0
    if args.command == "source-health": print(json.dumps(source_health(), indent=2, default=str)); return 0
    return 2


if __name__ == "__main__":
    raise SystemExit(main())
