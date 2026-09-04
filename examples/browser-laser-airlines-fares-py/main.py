"""Discover Laser Airlines fares through one bounded Solari browser session."""

from __future__ import annotations

import argparse
import asyncio
import json
import os
import re
import sys
from datetime import date

from parse import (
    NoFlightsError,
    ResultsPageChangedError,
    ResultsPageUnavailableError,
    parse_results_html,
)
from solari_browser import Solari
from solari_browser.errors import SolariError

ENTRY_URL = "https://booking.laserairlines.com/booking/widget?carrier=ql"
RESULTS_URL_PATTERN = re.compile(r"/flightresults(?:/|$)")
TIMEOUT_MS = 45_000


class InputError(RuntimeError):
    """A command-line value cannot be used by the booking flow."""


class UpstreamError(RuntimeError):
    """The Solari session or Laser booking application failed."""


def arguments() -> argparse.Namespace:
    parser = argparse.ArgumentParser(
        description="Find fare families for one Laser Airlines route and date."
    )
    parser.add_argument("--origin", required=True, type=str.upper)
    parser.add_argument("--destination", required=True, type=str.upper)
    parser.add_argument("--departure-date", required=True)
    parser.add_argument(
        "--recording",
        action="store_true",
        help="record this Solari session for later debugging",
    )
    return parser.parse_args()


def validate(args: argparse.Namespace) -> None:
    if not re.fullmatch(r"[A-Z]{3}", args.origin):
        raise InputError("--origin must be a three-letter IATA code.")
    if not re.fullmatch(r"[A-Z]{3}", args.destination):
        raise InputError("--destination must be a three-letter IATA code.")
    if args.origin == args.destination:
        raise InputError("Origin and destination must differ.")
    try:
        requested = date.fromisoformat(args.departure_date)
    except ValueError as exc:
        raise InputError("--departure-date must use YYYY-MM-DD.") from exc
    if requested < date.today():
        raise InputError(f"Departure date {args.departure_date} is in the past.")


async def select_airport(page, field_name: str, code: str) -> None:
    field = page.get_by_role(
        "textbox", name=re.compile(field_name, re.IGNORECASE)
    ).first
    dropdown = (
        "#originDropdownContainer"
        if field_name.startswith("origin")
        else "#destinationDropdownContainer"
    )
    await field.fill(code)
    option = (
        page.locator(f"{dropdown} li.sg-results__row")
        .filter(has=page.locator("strong.--code", has_text=code))
        .first
    )
    try:
        await option.wait_for(state="visible", timeout=8_000)
        await option.click()
    except Exception as exc:
        raise InputError(
            f"Airport {code} is unavailable for the selected "
            f"{field_name.split('|', 1)[0]} field."
        ) from exc


async def select_departure_date(page, departure_date: str) -> None:
    requested = date.fromisoformat(departure_date)
    today = date.today()
    month_delta = (requested.year - today.year) * 12 + requested.month - today.month
    title = requested.strftime("%d/%m/%Y")
    await page.locator('input[name="date"]').click(force=True)

    # The cloud browser may be a calendar day ahead in UTC, so inspect the open
    # calendar instead of assuming it opened on the local process's month.
    for _ in range(month_delta + 2):
        cell = page.locator(f'td[title="{title}"]:not(.disabled)').first
        if await cell.count() and await cell.is_visible():
            await cell.click(force=True)
            return
        await page.locator(".mx-btn-icon-right").first.click(force=True)
        await page.wait_for_timeout(100)
    raise InputError(
        f"Departure date {departure_date} is unavailable in Laser's calendar."
    )


async def discover_fares(args: argparse.Namespace, api_key: str) -> list[dict]:
    client = Solari(api_key=api_key, timeout_ms=TIMEOUT_MS)
    browser = await client.launch(
        stealth=True,
        captcha=True,
        recording=args.recording,
        # No proxy is passed: the session uses Solari's default datacenter egress.
    )
    stage = "opening the booking page"
    bad_response_statuses: list[int] = []
    try:
        page = await browser.new_page()
        page.on(
            "response",
            lambda response: (
                bad_response_statuses.append(response.status)
                if response.status >= 400 and len(bad_response_statuses) < 20
                else None
            ),
        )
        stage = "loading the KIU booking configuration"
        async with page.expect_response(
            lambda item: item.url.endswith("/searchflight/api/v1/configs/"),
            timeout=TIMEOUT_MS,
        ) as config_response_info:
            response = await page.goto(
                ENTRY_URL, wait_until="domcontentloaded", timeout=TIMEOUT_MS
            )
        if response and response.status in {401, 403, 429}:
            raise UpstreamError(
                f"Laser blocked or rate-limited the request ({response.status})."
            )
        if response and response.status >= 400:
            raise UpstreamError(f"Laser booking failed to load ({response.status}).")

        config_response = await config_response_info.value
        if config_response.status in {401, 403, 429}:
            raise UpstreamError(
                "Laser blocked or rate-limited the booking configuration "
                f"({config_response.status})."
            )
        if config_response.status >= 400:
            raise UpstreamError(
                f"Laser booking configuration failed ({config_response.status})."
            )

        stage = "selecting one-way travel"
        one_way = page.get_by_role(
            "radio", name=re.compile(r"one.?way|solo.?ida", re.IGNORECASE)
        ).first
        if await one_way.count():
            await one_way.check(force=True)
        stage = "selecting the origin airport"
        await select_airport(page, "origin|origen", args.origin)
        stage = "selecting the destination airport"
        await select_airport(page, "destination|destino", args.destination)
        stage = "selecting the departure date"
        await select_departure_date(page, args.departure_date)
        stage = "submitting the search"
        await page.get_by_role(
            "button", name=re.compile(r"search|buscar", re.IGNORECASE)
        ).first.click()
        stage = "waiting for results navigation"
        await page.wait_for_url(RESULTS_URL_PATTERN, timeout=TIMEOUT_MS)
        if "session-error" in page.url:
            raise UpstreamError("Laser returned a blocked or expired booking session.")
        stage = "waiting for rendered flight results"
        try:
            await page.wait_for_function(
                """() => document.querySelector('.flightComponent') !== null ||
                    [...document.querySelectorAll('body *')].some(element =>
                      element.children.length === 0 &&
                      /no\\s+(hay\\s+)?(vuelos?|flights?).*(disponibles?|available)/i
                        .test(element.textContent || '')
                    )""",
                timeout=30_000,
            )
        except Exception:
            if 429 in bad_response_statuses:
                raise UpstreamError(
                    "Laser/KIU rate-limited the search while loading results (429)."
                )
            if any(status in {401, 403} for status in bad_response_statuses):
                raise UpstreamError(
                    "Laser/KIU blocked the search while loading results."
                )
        stage = "parsing the rendered flight results"
        return parse_results_html(
            await page.content(), args.origin, args.destination, args.departure_date
        )
    except (
        InputError,
        NoFlightsError,
        ResultsPageChangedError,
        ResultsPageUnavailableError,
        SolariError,
        UpstreamError,
    ):
        raise
    except Exception as exc:
        if 429 in bad_response_statuses:
            raise UpstreamError(
                f"Laser/KIU rate-limited the browser while {stage} (429)."
            ) from exc
        if any(status in {401, 403} for status in bad_response_statuses):
            raise UpstreamError(
                f"Laser/KIU blocked the browser while {stage}."
            ) from exc
        raise UpstreamError(
            f"Laser's booking flow timed out or changed while {stage}."
        ) from exc
    finally:
        await browser.close()


async def run() -> int:
    args = arguments()
    try:
        validate(args)
        api_key = os.environ.get("SOLARI_API_KEY")
        if not api_key:
            raise InputError("SOLARI_API_KEY is not set.")
        fares = await discover_fares(args, api_key)
    except (
        InputError,
        NoFlightsError,
        ResultsPageChangedError,
        ResultsPageUnavailableError,
        UpstreamError,
    ) as exc:
        print(f"error: {exc}", file=sys.stderr)
        return 2
    except SolariError as exc:
        session_status = exc.status or "unknown status"
        print(
            "error: Solari could not start or maintain the browser session "
            f"({session_status}).",
            file=sys.stderr,
        )
        return 3
    except Exception as exc:
        print(
            f"error: Laser's booking flow did not complete ({type(exc).__name__}). "
            "The upstream UI may be blocked or may have changed.",
            file=sys.stderr,
        )
        return 3

    print(json.dumps(fares, indent=2))
    return 0


if __name__ == "__main__":
    raise SystemExit(asyncio.run(run()))
