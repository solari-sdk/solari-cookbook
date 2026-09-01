from __future__ import annotations

from dataclasses import asdict, dataclass
from typing import Iterable


@dataclass(frozen=True, slots=True)
class MapLayer:
    id: str
    name: str
    attribution: str
    license_url: str | None = None
    source_url: str | None = None
    offline_permitted: bool = False

    def __post_init__(self):
        if not self.id.strip() or not self.name.strip() or not self.attribution.strip():
            raise ValueError("map layer id, name and attribution are required")

    def to_dict(self) -> dict[str, object]:
        return asdict(self)


class MapLayerRegistry:
    def __init__(self, layers: Iterable[MapLayer] = ()) -> None:
        self._layers: dict[str, MapLayer] = {}
        for layer in layers:
            self.register(layer)

    def register(self, layer: MapLayer) -> None:
        if layer.id in self._layers:
            raise ValueError(f"map layer already registered: {layer.id}")
        self._layers[layer.id] = layer

    def get(self, layer_id: str) -> MapLayer:
        try:
            return self._layers[layer_id]
        except KeyError as exc:
            raise KeyError("unknown map layer") from exc

    def visible_attribution(self, layer_ids: Iterable[str]) -> list[dict[str, object]]:
        return [self.get(layer_id).to_dict() for layer_id in dict.fromkeys(layer_ids)]

    def offline_candidates(self) -> list[MapLayer]:
        return sorted((layer for layer in self._layers.values() if layer.offline_permitted), key=lambda item: item.id)
