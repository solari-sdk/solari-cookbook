import pytest

from app.sources.nhc_tropical_cyclones import normalize


RSS = b'''<?xml version="1.0" encoding="UTF-8"?>
<rss version="2.0"><channel><title>NHC Atlantic</title>
<item><title>Hurricane Example Public Advisory Number 4</title><link>https://www.nhc.noaa.gov/text/MIATCPAT1.shtml</link><guid isPermaLink="false">example-4</guid><pubDate>Tue, 01 Sep 2026 09:00:00 GMT</pubDate><description><![CDATA[<b>Example advisory</b> with public details.]]></description></item>
<item><title>Example Discussion</title><link>https://www.nhc.noaa.gov/text/MIATCDAT1.shtml</link><guid>example-discussion</guid><pubDate>Tue, 01 Sep 2026 08:00:00 GMT</pubDate><description>Forecast discussion</description></item>
</channel></rss>'''


def test_nhc_rss_normalization_is_deterministic_and_inert():
    first = normalize(RSS, "acq-1")
    second = normalize(RSS, "acq-2")
    assert len(first) == 2
    assert first[0].id == second[0].id
    assert first[0].source_id == "nhc-tropical-cyclones"
    assert first[0].category == "tropical-cyclone"
    assert first[0].summary == "Example advisory with public details."
    assert first[0].properties["product_url"].startswith("https://www.nhc.noaa.gov/")
    assert first[0].evidence[0].acquisition_id == "acq-1"


def test_nhc_rss_rejects_dtd_and_invalid_dates():
    with pytest.raises(ValueError, match="DTD/entity"):
        normalize(b'<!DOCTYPE rss [<!ENTITY x "y">]><rss><channel/></rss>', "acq")
    invalid = RSS.replace(b"Tue, 01 Sep 2026 09:00:00 GMT", b"not-a-date", 1)
    with pytest.raises(ValueError, match="pubDate"):
        normalize(invalid, "acq")
