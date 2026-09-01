import pytest

from app.sources.noaa_tsunami_bulletins import normalize


RSS = b'''<?xml version="1.0"?><rss version="2.0"><channel><item>
<title>Tsunami Warning - Example Region</title>
<link>https://www.tsunami.gov/example</link>
<guid>example-1</guid>
<pubDate>Tue, 01 Sep 2026 10:00:00 GMT</pubDate>
<description><![CDATA[<b>Tsunami Warning</b> for the example region.]]></description>
</item></channel></rss>'''


def test_tsunami_rss_normalization_is_inert_and_severity_aware():
    event = normalize(RSS, "acq-tsunami")[0]
    assert event.source_record_id == "example-1"
    assert event.category == "tsunami"
    assert event.severity == "extreme"
    assert "<b>" not in (event.summary or "")
    assert event.evidence[0].acquisition_id == "acq-tsunami"


def test_tsunami_rss_rejects_dtd_and_entities():
    with pytest.raises(ValueError):
        normalize(b'<!DOCTYPE rss [<!ENTITY x "bad">]><rss><channel/></rss>', "acq")
