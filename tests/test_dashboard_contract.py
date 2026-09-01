from pathlib import Path


def test_server_dashboard_wires_graph_health_attribution_statistics_and_debug_surfaces():
    root = Path(__file__).parents[1]
    html = (root / "app" / "static" / "index.html").read_text(encoding="utf-8")
    script = (root / "app" / "static" / "app.js").read_text(encoding="utf-8")
    advanced = (root / "app" / "static" / "advanced.js").read_text(encoding="utf-8")
    for identifier in (
        "graphCanvas", "sourceHealth", "executions", "aggregateStats", "sourceAttribution", "evidence",
        "confidenceFilter", "entitySearchResults", "provenanceChain", "jobTimeline",
    ):
        assert f'id="{identifier}"' in html
    assert "/api/v1/entities?limit=500" in script
    assert "/api/v1/relationships?limit=1000" in script
    assert "selectGraphForEvent" in script
    assert "/api/v1/source-health" in script
    assert "/api/v1/acquisitions?limit=20" in script
    assert "/api/v1/entities?${params}" in advanced
    assert "/api/v1/jobs?limit=40" in advanced
    assert "attempt_durations_ms" in advanced
    assert "failure_class" in advanced
    assert "content_sha256" in advanced
    assert "MutationObserver" in advanced
