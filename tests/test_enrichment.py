from app.enrichment import EnrichmentStep, run_enrichment_pipeline


def test_enrichment_fans_out_and_reports_conflicting_values():
    result = run_enrichment_pipeline(
        {"id": "item-1"},
        [
            EnrichmentStep("alpha", lambda record: {"country": "US", "score": 0.7}),
            EnrichmentStep("beta", lambda record: {"category": "public", "score": 0.8}),
        ],
        max_workers=2,
    )
    assert result["status"] == "success"
    assert result["enriched"]["country"] == "US"
    assert result["enriched"]["category"] == "public"
    assert [step["step_id"] for step in result["conflicts"]["score"]] == ["alpha", "beta"]
    assert [step["step_id"] for step in result["steps"]] == ["alpha", "beta"]


def test_enrichment_preserves_partial_failure_state():
    def fail(record):
        raise RuntimeError("source unavailable")

    result = run_enrichment_pipeline({"id": "item-1"}, [EnrichmentStep("bad", fail), EnrichmentStep("ok", lambda record: {"value": 1})])
    assert result["status"] == "partial"
    failed = next(step for step in result["steps"] if step["step_id"] == "bad")
    assert failed["error_type"] == "RuntimeError"
    assert result["enriched"] == {"value": 1}
