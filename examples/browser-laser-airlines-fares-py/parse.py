"""Static HTML extraction for Laser Airlines flight results."""

from __future__ import annotations

import re
from datetime import datetime, timedelta
from decimal import Decimal, InvalidOperation

from bs4 import BeautifulSoup

BOOKING_URL = "https://booking.laserairlines.com/flightresults/"


class NoFlightsError(RuntimeError):
    """The results page reports no available flights or fares."""


class ResultsPageChangedError(RuntimeError):
    """The results page no longer matches the expected static HTML contract."""


class ResultsPageUnavailableError(RuntimeError):
    """The upstream results page did not render a recognizable final state."""


def _price(text: str) -> Decimal | None:
    match = re.search(r"\d+(?:[.,]\d+)?", text)
    if not match:
        return None
    try:
        return Decimal(match.group().replace(",", "."))
    except InvalidOperation:
        return None


def _fare_class(text: str) -> str:
    return re.sub(r"[^A-Z0-9]+", "-", text.upper()).strip("-")


def _has_text(soup: BeautifulSoup, pattern: str) -> bool:
    expression = re.compile(pattern, re.IGNORECASE)
    return any(expression.search(text) for text in soup.stripped_strings)


def parse_results_html(
    html: str, origin: str, destination: str, departure_date: str
) -> list[dict]:
    """Return one normalized record per available fare family."""
    soup = BeautifulSoup(html, "html.parser")
    cards = soup.select(".flightComponent")

    if not cards:
        if _has_text(
            soup,
            r"no\s+(?:hay\s+)?(?:vuelos?|flights?).*(?:disponibles?|available)",
        ):
            raise NoFlightsError(
                f"No flights available for {origin} -> {destination} "
                f"on {departure_date}."
            )
        if _has_text(
            soup,
            r"session[_-]error|page access error|too many requests",
        ):
            raise ResultsPageUnavailableError(
                "Laser returned an upstream session or access-error page."
            )
        result_fragments = soup.select(
            ".flightComponent__fare, .flightComponent__airports, "
            "[data-bs-target^='#flight'], [data-target^='#flight']"
        )
        if result_fragments:
            raise ResultsPageChangedError(
                "Laser result fragments were found, but the .flightComponent "
                "container selector no longer matched."
            )
        raise ResultsPageUnavailableError(
            "Laser reached the results URL, but the page did not finish rendering "
            "flight cards or a no-flights message."
        )

    requested_route = (origin.upper(), destination.upper())
    travel_day = datetime.strptime(departure_date, "%Y-%m-%d")
    fares: list[dict] = []
    matching_cards = 0

    for card in cards:
        airport_nodes = card.select(".flightComponent__airports")
        codes = [
            node.get_text(strip=True)
            for airport in airport_nodes
            if (node := airport.select_one(".flightComponent__airportsCode"))
        ]
        if len(codes) < 2 or (codes[0], codes[-1]) != requested_route:
            continue
        matching_cards += 1

        departure_node = airport_nodes[0].select_one(".flightComponent__time")
        arrival_node = airport_nodes[-1].select_one(".flightComponent__time")
        flight_node = card.select_one(".flightDetailsTimeline__code")
        target_node = card.select_one(
            "[data-bs-target^='#flight'], [data-target^='#flight']"
        )
        flight_source = flight_node.get_text(strip=True) if flight_node else ""
        if not flight_source and target_node:
            flight_source = target_node.get("data-bs-target") or target_node.get(
                "data-target", ""
            )
        flight_digits = re.search(r"\d+", flight_source)

        if not departure_node or not arrival_node or not flight_digits:
            continue
        try:
            departure_time = datetime.strptime(
                departure_node.get_text(strip=True), "%H:%M"
            )
            arrival_time = datetime.strptime(arrival_node.get_text(strip=True), "%H:%M")
        except ValueError:
            continue

        departure = travel_day.replace(
            hour=departure_time.hour, minute=departure_time.minute
        )
        arrival = travel_day.replace(hour=arrival_time.hour, minute=arrival_time.minute)
        if arrival <= departure:
            arrival += timedelta(days=1)

        for fare in card.select(".flightComponent__fare"):
            if "--soldout" in (fare.get("class") or []):
                continue
            price_node = fare.select_one(".flightComponent__cardPriceValue")
            label_node = fare.select_one(".flightComponent__fareLabel")
            price = _price(price_node.get_text(" ", strip=True) if price_node else "")
            if price is None or price <= 0 or not label_node:
                continue
            fares.append(
                {
                    "airline": "Laser Airlines",
                    "flight_number": f"QL-{flight_digits.group()}",
                    "departure_airport": requested_route[0],
                    "arrival_airport": requested_route[1],
                    "departure_datetime": departure.isoformat(),
                    "arrival_datetime": arrival.isoformat(),
                    "fare_class": _fare_class(label_node.get_text(" ", strip=True)),
                    "price_usd": float(price),
                    "booking_url": BOOKING_URL,
                }
            )

    if matching_cards and not fares:
        raise ResultsPageChangedError(
            "Laser flight cards were found, but their fare selectors no longer matched."
        )
    if not fares:
        raise NoFlightsError(
            f"No available fares for {origin} -> {destination} on {departure_date}."
        )
    return fares
