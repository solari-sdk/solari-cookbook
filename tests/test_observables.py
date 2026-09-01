from datetime import datetime, timezone

import pytest

from app.observables import (
    canonicalize_observable,
    link_observable,
    list_observables,
    make_observable,
    observable_links,
    save_observable,
)


def test_observable_canonicalization():
    assert canonicalize_observable("domain", "Example.ORG.") == "example.org"
    assert canonicalize_observable("ip", "2001:0db8::1") == "2001:db8::1"
    assert canonicalize_observable("url", "HTTPS://Example.ORG:443/path?q=1#fragment") == "https://example.org/path?q=1"
    assert canonicalize_observable("email", "User@Example.ORG") == "User@example.org"
    assert canonicalize_observable("username", "CaseSensitive") == "casesensitive"
    with pytest.raises(ValueError):
        canonicalize_observable("email", "not-an-email")


def test_observable_persistence_and_links(tmp_path):
    db = tmp_path / "observables.sqlite3"
    now = datetime.now(timezone.utc)
    record = make_observable("domain", "Example.ORG", first_seen=now, last_seen=now, properties={"public": True})
    stored = save_observable(record, path=db)
    assert stored["canonical_value"] == "example.org"
    assert list_observables(observable_type="domain", query="example", path=db)[0]["properties"] == {"public": True}
    link = link_observable(record.id, "event", "event-1", path=db)
    assert link["relation"] == "observed_in"
    assert observable_links(record.id, path=db)[0]["object_id"] == "event-1"
