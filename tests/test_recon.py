import pytest

import app.recon as recon


def test_public_target_validation_blocks_private(monkeypatch):
    monkeypatch.setattr(recon.socket, "getaddrinfo", lambda *args, **kwargs: [(2, 1, 6, "", ("127.0.0.1", 443))])
    with pytest.raises(ValueError, match="public addresses"):
        recon.validate_public_https_url("https://example.invalid/")
    with pytest.raises(ValueError, match="HTTPS"):
        recon.validate_public_https_url("http://example.invalid/")


def test_dns_and_reverse_dns(monkeypatch):
    monkeypatch.setattr(recon.socket, "getaddrinfo", lambda *args, **kwargs: [(2, 1, 6, "", ("93.184.216.34", 0))])
    result = recon.dns_lookup("Example.ORG")
    assert result["addresses"] == ["93.184.216.34"]
    monkeypatch.setattr(recon.socket, "gethostbyaddr", lambda value: ("example.org", ["alias.example.org"], [value]))
    reverse = recon.reverse_dns("93.184.216.34")
    assert reverse["hostname"] == "example.org"


def test_rdap_ct_email_security_asn_and_archive_parsing(monkeypatch):
    def fake_json(url, **kwargs):
        if "rdap.org" in url:
            return {"handle": "EXAMPLE", "name": "Example Network", "status": ["active"], "entities": [], "events": [], "nameservers": [], "links": []}
        if "crt.sh" in url:
            return [{"id": 1, "name_value": "example.org", "issuer_name": "CA", "serial_number": "1"}]
        if "dns.google" in url and "_dmarc" in url:
            return {"Answer": [{"type": 16, "data": '"v=DMARC1; p=reject"'}]}
        if "dns.google" in url:
            return {"Answer": [{"type": 16, "data": '"v=spf1 -all"'}]}
        if "stat.ripe.net" in url:
            return {"data": {"prefix": "93.184.216.0/24", "asns": [15133], "holder": "EXAMPLE", "announced": True}}
        if "web.archive.org" in url:
            return [["timestamp", "original", "statuscode", "digest"], ["20260101000000", "https://example.org/", "200", "ABC"]]
        raise AssertionError(url)

    monkeypatch.setattr(recon, "_json_get", fake_json)
    monkeypatch.setattr(recon, "validate_public_https_url", lambda url: url)

    rdap = recon.rdap_lookup("example.org")
    assert rdap["handle"] == "EXAMPLE"
    assert recon.certificate_transparency("example.org")["entries"][0]["id"] == 1
    security = recon.email_domain_security("example.org")
    assert security["spf_present"] and security["dmarc_present"]
    asn = recon.asn_network_lookup("93.184.216.34")
    assert asn["asns"] == [15133]
    archive = recon.web_archive_history("https://example.org/")
    assert archive["captures"][0]["digest"] == "ABC"
