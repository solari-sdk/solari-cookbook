import pytest
from defusedxml.common import EntitiesForbidden

from app.sources import faa_nas_status

FIXTURE = b"""<?xml version='1.0' encoding='UTF-8'?>
<AIRPORT_STATUS_INFORMATION>
  <Update_Time>Tue Sep 01 16:15:00 2026 GMT</Update_Time>
  <Dtd_File>https://www.faa.gov/AirportStatus.dtd</Dtd_File>
  <Delay_type>
    <Name>Ground Delay Programs</Name>
    <Ground_Delay_List>
      <Ground_Delay>
        <ARPT>SFO</ARPT>
        <Reason>runway construction</Reason>
        <Avg>38 minutes</Avg>
        <Max>1 hour and 30 minutes</Max>
      </Ground_Delay>
    </Ground_Delay_List>
  </Delay_type>
  <Delay_type>
    <Name>Airport Closures</Name>
    <Airport_Closure_List>
      <Airport>
        <ARPT>ABC</ARPT>
        <Reason>public fixture closure wording</Reason>
        <Start>Sep 01 at 16:00 UTC.</Start>
        <Reopen>Sep 01 at 17:00 UTC.</Reopen>
      </Airport>
    </Airport_Closure_List>
  </Delay_type>
</AIRPORT_STATUS_INFORMATION>
"""


def test_faa_nas_status_normalizes_observed_operational_events():
    events = faa_nas_status.normalize(FIXTURE, "acq-fixture")
    assert len(events) == 2
    delay, closure = events
    assert delay.source_id == "faa-nas-airport-status"
    assert delay.category == "airport-operational-status"
    assert delay.title == "Ground Delay Programs — SFO"
    assert delay.properties["average_delay"] == "38 minutes"
    assert delay.observed_at.isoformat() == "2026-09-01T16:15:00+00:00"
    assert delay.evidence[0].kind.value == "observed"
    assert closure.title == "Airport Closures — ABC"
    assert closure.properties["reopen"] == "Sep 01 at 17:00 UTC."
    assert closure.location is None


def test_faa_nas_status_ids_are_deterministic():
    first = faa_nas_status.normalize(FIXTURE, "acq-one")
    second = faa_nas_status.normalize(FIXTURE, "acq-two")
    assert [event.id for event in first] == [event.id for event in second]


def test_faa_nas_status_rejects_entity_expansion():
    malicious = b"""<!DOCTYPE x [<!ENTITY boom 'expanded'>]><AIRPORT_STATUS_INFORMATION><Update_Time>Tue Sep 01 16:15:00 2026 GMT</Update_Time><Delay_type><Name>&boom;</Name></Delay_type></AIRPORT_STATUS_INFORMATION>"""
    with pytest.raises(EntitiesForbidden):
        faa_nas_status.normalize(malicious, "acq-malicious")
