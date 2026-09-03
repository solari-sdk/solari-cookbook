#!/usr/bin/env python3
"""Parse a SaaS pricing-page HTML in a Solari sandbox and emit CSV/JSON.

The input HTML path and CSS-style class selectors are passed via environment
variables so the same parser can be reused across different pricing pages.
"""

import csv
import json
import os
import re
from html.parser import HTMLParser
from typing import Any

VOID_TAGS = {
    "area",
    "base",
    "br",
    "col",
    "embed",
    "hr",
    "img",
    "input",
    "link",
    "meta",
    "param",
    "source",
    "track",
    "wbr",
}


class Tag:
    """Tiny DOM node for local HTML parsing."""

    def __init__(self, name: str | None, attrs: dict[str, str | None]) -> None:
        self.name = name
        self.attrs = {k: (v or "") for k, v in attrs.items()}
        self.classes = set((self.attrs.get("class") or "").split())
        self.children: list[Any] = []

    def find(self, *, name: str | None = None, class_: str | None = None) -> "Tag | None":
        if self._matches(name, class_):
            return self
        for child in self.children:
            if isinstance(child, Tag):
                found = child.find(name=name, class_=class_)
                if found is not None:
                    return found
        return None

    def find_all(self, *, name: str | None = None, class_: str | None = None) -> list["Tag"]:
        results: list[Tag] = []
        if self._matches(name, class_):
            results.append(self)
        for child in self.children:
            if isinstance(child, Tag):
                results.extend(child.find_all(name=name, class_=class_))
        return results

    def _matches(self, name: str | None, class_: str | None) -> bool:
        name_ok = name is None or self.name == name
        class_ok = class_ is None or class_ in self.classes
        return name_ok and class_ok

    def get_text(self, sep: str = " ") -> str:
        parts = []
        for child in self.children:
            if isinstance(child, str):
                parts.append(child)
            elif isinstance(child, Tag) and child.name not in ("script", "style"):
                parts.append(child.get_text(sep))
        text = sep.join(parts)
        text = re.sub(r"\s+", " ", text)
        return text.strip()


class SimpleSoup(HTMLParser):
    """Builds a lightweight tree from raw HTML."""

    def __init__(self) -> None:
        super().__init__()
        self.root = Tag(None, {})
        self._stack: list[Tag] = [self.root]

    def handle_starttag(self, name: str, attrs: list[tuple[str, str | None]]) -> None:
        attrs_map = {k: v for k, v in attrs}
        node = Tag(name, attrs_map)
        self._stack[-1].children.append(node)
        if name not in VOID_TAGS:
            self._stack.append(node)

    def handle_endtag(self, name: str) -> None:
        if len(self._stack) > 1 and self._stack[-1].name == name:
            self._stack.pop()

    def handle_data(self, data: str) -> None:
        if self._stack[-1].name in ("script", "style"):
            return
        self._stack[-1].children.append(data)


def _text(node: Tag | None) -> str:
    if node is None:
        return ""
    return node.get_text()


def parse(html: str, config: dict[str, str]) -> list[dict[str, Any]]:
    soup = SimpleSoup()
    soup.feed(html)
    root = soup.root

    cards = root.find_all(class_=config["card"])
    plans: list[dict[str, Any]] = []

    for card in cards:
        name = _text(card.find(class_=config["name"]))
        price = _text(card.find(class_=config["price"]))
        suffix = _text(card.find(class_=config["suffix"]))
        description = _text(card.find(class_=config["description"]))

        full_price = f"{price} {suffix}".strip()

        features = [
            _text(f)
            for f in card.find_all(class_=config["features"])
        ]
        if not features:
            # Friendly fallback: collect every <li> inside the card.
            features = [_text(li) for li in card.find_all(name="li")]

        if not name:
            continue

        plans.append(
            {
                "plan": name,
                "price": full_price,
                "description": description,
                "features": features,
            }
        )

    return plans


def _load_config() -> dict[str, str]:
    return {
        "card": os.environ.get("CARD_CLASS", "solari-pricing-plan"),
        "name": os.environ.get("NAME_CLASS", "solari-pricing-plan-name"),
        "price": os.environ.get("PRICE_CLASS", "solari-pricing-price-value"),
        "suffix": os.environ.get("SUFFIX_CLASS", "solari-pricing-price-suffix"),
        "description": os.environ.get(
            "DESCRIPTION_CLASS", "solari-pricing-description"
        ),
        "features": os.environ.get("FEATURES_CLASS", "solari-pricing-feature"),
    }


def main() -> None:
    html_path = os.environ.get("PRICING_HTML_PATH", "/tmp/pricing.html")
    csv_path = os.environ.get("PRICING_CSV_PATH", "/tmp/pricing.csv")
    json_path = os.environ.get("PRICING_JSON_PATH", "/tmp/pricing.json")

    with open(html_path, "r", encoding="utf-8") as f:
        html = f.read()

    plans = parse(html, _load_config())

    with open(csv_path, "w", newline="", encoding="utf-8") as f:
        writer = csv.DictWriter(
            f, fieldnames=["plan", "price", "description", "features"]
        )
        writer.writeheader()
        for plan in plans:
            row = dict(plan)
            row["features"] = " | ".join(plan["features"])
            writer.writerow(row)

    with open(json_path, "w", encoding="utf-8") as f:
        json.dump({"plans": plans}, f, indent=2)

    print(f"WROTE {{'csv': '{csv_path}', 'json': '{json_path}', 'plans': {len(plans)}}}")


if __name__ == "__main__":
    main()
