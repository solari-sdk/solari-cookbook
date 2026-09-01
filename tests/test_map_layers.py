from app.map_layers import MapLayer, MapLayerRegistry


def test_map_layer_attribution_and_offline_policy_are_explicit():
    registry=MapLayerRegistry([
        MapLayer("baseline","Built-in baseline","Project-generated grid",offline_permitted=True),
        MapLayer("remote","Remote public layer","Example attribution",license_url="https://example.test/license",offline_permitted=False),
    ])
    visible=registry.visible_attribution(["remote","baseline","remote"])
    assert [item["id"] for item in visible] == ["remote","baseline"]
    assert visible[0]["attribution"] == "Example attribution"
    assert [item.id for item in registry.offline_candidates()] == ["baseline"]
