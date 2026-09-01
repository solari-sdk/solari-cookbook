from __future__ import annotations

from datetime import datetime
from typing import Any, Literal

from fastapi import APIRouter, HTTPException, Query
from pydantic import BaseModel, Field, HttpUrl

from app.observables import ObservableRecord, link_observable, list_observables, make_observable, observable_links, save_observable
from app.recon import (
    asn_network_lookup,
    certificate_transparency,
    dns_lookup,
    email_domain_security,
    http_header_fingerprint,
    rdap_lookup,
    redirect_chain,
    reverse_dns,
    tls_certificate_metadata,
    web_archive_history,
)

router = APIRouter(prefix="/api/v1", tags=["recon"])


class ObservableInput(BaseModel):
    type: Literal["domain", "ip", "url", "email", "username", "phone", "hash", "other"]
    value: str = Field(min_length=1, max_length=4000)
    first_seen: datetime | None = None
    last_seen: datetime | None = None
    confidence: float = Field(default=1.0, ge=0.0, le=1.0)
    properties: dict[str, Any] = Field(default_factory=dict)


class ObservableLinkInput(BaseModel):
    object_type: str = Field(min_length=1, max_length=40)
    object_id: str = Field(min_length=1, max_length=256)
    relation: str = Field(default="observed_in", min_length=1, max_length=120)


def _error(exc: Exception) -> HTTPException:
    if isinstance(exc, KeyError): return HTTPException(404, str(exc).strip("'"))
    if isinstance(exc, ValueError): return HTTPException(400, str(exc))
    return HTTPException(502, type(exc).__name__)


@router.get("/observables")
def observables(type: str | None = None, q: str | None = Query(None, max_length=200), limit: int = Query(500, ge=1, le=1000)) -> list[dict[str, object]]:
    return list_observables(observable_type=type, query=q, limit=limit)


@router.post("/observables")
def add_observable(body: ObservableInput) -> dict[str, object]:
    try:
        record = make_observable(body.type, body.value, first_seen=body.first_seen, last_seen=body.last_seen, confidence=body.confidence, properties=body.properties)
        return save_observable(record)
    except Exception as exc:
        raise _error(exc) from exc


@router.get("/observables/{observable_id}/links")
def get_observable_links(observable_id: str) -> list[dict[str, object]]: return observable_links(observable_id)


@router.post("/observables/{observable_id}/links")
def add_observable_link(observable_id: str, body: ObservableLinkInput) -> dict[str, object]:
    try: return link_observable(observable_id, body.object_type, body.object_id, relation=body.relation)
    except Exception as exc: raise _error(exc) from exc


@router.get("/recon/dns/{hostname}")
def dns(hostname: str, record_type: Literal["A", "AAAA"] = "A") -> dict[str, object]: return dns_lookup(hostname, record_type=record_type)


@router.get("/recon/reverse-dns/{ip_value}")
def ptr(ip_value: str) -> dict[str, object]:
    try: return reverse_dns(ip_value)
    except Exception as exc: raise _error(exc) from exc


@router.get("/recon/rdap")
def rdap(value: str = Query(..., max_length=1000), kind: Literal["domain", "ip"] = "domain") -> dict[str, object]:
    try: return rdap_lookup(value, kind=kind)
    except Exception as exc: raise _error(exc) from exc


@router.get("/recon/certificate-transparency/{domain}")
def ct(domain: str, limit: int = Query(200, ge=1, le=1000)) -> dict[str, object]:
    try: return certificate_transparency(domain, limit=limit)
    except Exception as exc: raise _error(exc) from exc


@router.get("/recon/tls/{hostname}")
def tls(hostname: str, port: int = Query(443, ge=1, le=65535)) -> dict[str, object]:
    try: return tls_certificate_metadata(hostname, port=port)
    except Exception as exc: raise _error(exc) from exc


@router.get("/recon/http-headers")
def http_headers(url: HttpUrl) -> dict[str, object]:
    try: return http_header_fingerprint(str(url))
    except Exception as exc: raise _error(exc) from exc


@router.get("/recon/email-domain-security/{domain}")
def mail_security(domain: str) -> dict[str, object]:
    try: return email_domain_security(domain)
    except Exception as exc: raise _error(exc) from exc


@router.get("/recon/asn-network/{ip_value}")
def asn(ip_value: str) -> dict[str, object]:
    try: return asn_network_lookup(ip_value)
    except Exception as exc: raise _error(exc) from exc


@router.get("/recon/redirect-chain")
def redirects(url: HttpUrl, max_redirects: int = Query(10, ge=0, le=30)) -> dict[str, object]:
    try: return redirect_chain(str(url), max_redirects=max_redirects)
    except Exception as exc: raise _error(exc) from exc


@router.get("/recon/web-archive")
def archive(url: HttpUrl, limit: int = Query(50, ge=1, le=500)) -> dict[str, object]:
    try: return web_archive_history(str(url), limit=limit)
    except Exception as exc: raise _error(exc) from exc
