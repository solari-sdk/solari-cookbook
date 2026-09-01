from app.observables import make_observable
from app.stix import export_stix_bundle, import_stix_bundle


def test_stix_round_trip_for_supported_public_observables():
    records=[
        make_observable("domain","Example.COM"),
        make_observable("ip","192.0.2.1",confidence=0.8),
        make_observable("url","https://example.com/path"),
        make_observable("email","user@example.com"),
        make_observable("hash","a"*64),
        make_observable("username","ExampleUser"),
    ]
    bundle=export_stix_bundle(records)
    assert bundle["type"] == "bundle"
    assert {item["type"] for item in bundle["objects"]} == {"domain-name","ipv4-addr","url","email-addr","file"}
    assert bundle["x_solari_skipped"][0]["type"] == "username"
    imported=import_stix_bundle(bundle)
    assert {record.type for record in imported["records"]} == {"domain","ip","url","email","hash"}
    ip=next(record for record in imported["records"] if record.type=="ip")
    assert ip.confidence == 0.8


def test_stix_import_skips_unsupported_objects_without_guessing():
    result=import_stix_bundle({"type":"bundle","objects":[{"type":"malware","id":"malware--00000000-0000-4000-8000-000000000000","name":"Example"}]})
    assert result["records"] == []
    assert result["skipped"][0]["type"] == "malware"
