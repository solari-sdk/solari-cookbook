from app.sources import fema_disaster_declarations as fema


def test_fema_declaration_normalization_is_deterministic_and_non_geocoded():
    payload={"DisasterDeclarationsSummaries":[{
        "id":"fixture-1","disasterNumber":9999,"declarationTitle":"Severe Storms","state":"WA","designatedArea":"Example County",
        "declarationDate":"2026-08-31T12:00:00.000Z","incidentBeginDate":"2026-08-30T00:00:00.000Z","incidentType":"Severe Storm",
        "declarationType":"DR","lastRefresh":"2026-09-01T01:00:00.000Z","ihProgramDeclared":True,"paProgramDeclared":False,
    }]}
    event=fema.normalize(payload,"acq-1")[0]
    assert event.source_record_id=="fixture-1"
    assert event.title=="Severe Storms — Example County, WA"
    assert event.location is None
    assert event.properties["disaster_number"]==9999
    assert event.evidence[0].source_path=="DisasterDeclarationsSummaries[0]"
    assert fema.normalize(payload,"acq-1")[0].id==event.id


def test_fema_rejects_unexpected_response_shape():
    try:
        fema.normalize({"unexpected":[]},"acq")
        raise AssertionError("unexpected shape should fail")
    except ValueError:
        pass
