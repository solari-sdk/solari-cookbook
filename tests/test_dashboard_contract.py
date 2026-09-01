from pathlib import Path


def test_server_dashboard_wires_graph_health_search_diagnostics_and_analyst_navigation():
    root = Path(__file__).parents[1]
    html = (root / "app" / "static" / "index.html").read_text(encoding="utf-8")
    script = (root / "app" / "static" / "app.js").read_text(encoding="utf-8")
    advanced = (root / "app" / "static" / "advanced.js").read_text(encoding="utf-8")
    for identifier in (
        "graphCanvas", "sourceHealth", "executions", "aggregateStats", "sourceAttribution", "evidence",
        "confidenceFilter", "entitySearchResults", "provenanceChain", "jobTimeline", "workspacePreset",
        "commandOpen", "commandPalette", "commandQuery", "commandResults", "severityFilter",
        "playbackRange", "playbackLabel", "playbackPlay", "playbackReset",
    ):
        assert f'id="{identifier}"' in html
    assert "/api/v1/entities?limit=500" in script
    assert "/api/v1/relationships?limit=1000" in script
    assert "selectGraphForEvent" in script
    assert "window.selectGraphEntity=selectGraphEntity" in script
    assert "playbackSubset" in script
    assert "playHistory" in script
    assert "contextmenu" in script
    assert "pivotToEvent" in script
    assert "precisionHalo" in script
    assert "Coordinate precision:" in script
    assert "no numeric uncertainty radius is asserted" in script
    assert "stampFreshness" in script
    assert "freshness-badge" in script
    assert "/api/v1/source-health" in script
    assert "/api/v1/acquisitions?limit=20" in script
    assert "/api/v1/entities?${params}" in advanced
    assert "/api/v1/events?${params}" in advanced
    assert "/api/v1/jobs?limit=40" in advanced
    assert "attempt_durations_ms" in advanced
    assert "failure_class" in advanced
    assert "content_sha256" in advanced
    assert "MutationObserver" in advanced
    assert "ctrlKey" in advanced and "metaKey" in advanced
    assert "setWorkspacePreset" in advanced
    assert "showModal" in advanced
