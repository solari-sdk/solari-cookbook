from app.pipeline import TransformationRecord


def test_transformation_record_public_dict():
    record = TransformationRecord(engine="solari-sandbox-python", sandbox_id="sandbox-test", duration_ms=12.5, expression="len(data)", input_sha256="abc", output=3, stdout=["3"], stderr=[], error=None)
    data = record.public_dict()
    assert data["engine"] == "solari-sandbox-python"
    assert data["input_sha256"] == "abc"
    assert data["output"] == 3
