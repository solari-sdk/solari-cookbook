from __future__ import annotations

import ipaddress
import json
import socket
import ssl
from dataclasses import dataclass
from typing import Any
from urllib.parse import quote, urlencode, urlparse
from urllib.request import HTTPRedirectHandler, Request, build_opener, urlopen

MAX_RESPONSE_BYTES = 2 * 1024 * 1024
USER_AGENT = "solari-osint-operations-center/0.8"


def _public_addresses(hostname: str, port: int) -> list[str]:
    try:
        addresses = sorted({item[4][0] for item in socket.getaddrinfo(hostname, port, type=socket.SOCK_STREAM)})
    except socket.gaierror as exc:
        raise ValueError("hostname could not be resolved") from exc
    if not addresses:
        raise ValueError("hostname resolved to no addresses")
    for address in addresses:
        ip = ipaddress.ip_address(address)
        if ip.is_private or ip.is_loopback or ip.is_link_local or ip.is_multicast or ip.is_reserved or ip.is_unspecified:
            raise ValueError("target must resolve only to public addresses")
    return addresses


def validate_public_https_url(url: str) -> str:
    parsed = urlparse(url)
    if parsed.scheme != "https" or not parsed.hostname:
        raise ValueError("target must be an HTTPS URL with a hostname")
    if parsed.username or parsed.password:
        raise ValueError("embedded URL credentials are not allowed")
    _public_addresses(parsed.hostname, parsed.port or 443)
    return url


def _json_get(url: str, *, timeout_seconds: int = 15, validate_target: bool = True) -> Any:
    if validate_target:
        validate_public_https_url(url)
    request = Request(url, headers={"Accept": "application/json", "User-Agent": USER_AGENT})
    with urlopen(request, timeout=timeout_seconds) as response:  # nosec B310 - HTTPS URL validated when requested
        data = response.read(MAX_RESPONSE_BYTES + 1)
        status = getattr(response, "status", 200)
        content_type = response.headers.get("Content-Type", "")
    if len(data) > MAX_RESPONSE_BYTES:
        raise ValueError("public enrichment response exceeds 2 MiB safety limit")
    if status >= 400:
        raise RuntimeError(f"HTTP {status}")
    if "json" not in content_type.lower() and data[:1] not in {b"{", b"["}:
        raise ValueError("public enrichment response is not JSON")
    return json.loads(data)


def dns_lookup(hostname: str, *, record_type: str = "A") -> dict[str, object]:
    host = hostname.strip().rstrip(".").lower().encode("idna").decode("ascii")
    if record_type not in {"A", "AAAA"}:
        raise ValueError("record_type must be A or AAAA")
    family = socket.AF_INET if record_type == "A" else socket.AF_INET6
    try:
        results = socket.getaddrinfo(host, None, family=family, type=socket.SOCK_STREAM)
    except socket.gaierror as exc:
        return {"hostname": host, "record_type": record_type, "addresses": [], "error": str(exc)}
    addresses = sorted({item[4][0] for item in results})
    return {"hostname": host, "record_type": record_type, "addresses": addresses, "error": None}


def reverse_dns(ip_value: str) -> dict[str, object]:
    canonical = str(ipaddress.ip_address(ip_value.strip()))
    try:
        hostname, aliases, addresses = socket.gethostbyaddr(canonical)
        return {"ip": canonical, "hostname": hostname.rstrip("."), "aliases": sorted(alias.rstrip(".") for alias in aliases), "addresses": sorted(addresses), "error": None}
    except (socket.herror, socket.gaierror) as exc:
        return {"ip": canonical, "hostname": None, "aliases": [], "addresses": [], "error": str(exc)}


def rdap_lookup(value: str, *, kind: str = "domain", timeout_seconds: int = 15) -> dict[str, object]:
    if kind == "domain":
        target = value.strip().rstrip(".").lower().encode("idna").decode("ascii")
        if "." not in target:
            raise ValueError("domain RDAP lookup requires a domain name")
        url = f"https://rdap.org/domain/{quote(target, safe='.-')}"
    elif kind == "ip":
        target = str(ipaddress.ip_address(value.strip()))
        url = f"https://rdap.org/ip/{quote(target, safe=':')}"
    else:
        raise ValueError("RDAP kind must be domain or ip")
    payload = _json_get(url, timeout_seconds=timeout_seconds)
    return {
        "kind": kind,
        "query": target,
        "handle": payload.get("handle"),
        "name": payload.get("name"),
        "status": payload.get("status", []),
        "entities": payload.get("entities", []),
        "events": payload.get("events", []),
        "nameservers": payload.get("nameservers", []),
        "links": payload.get("links", []),
        "raw": payload,
        "source": url,
    }


def certificate_transparency(domain: str, *, timeout_seconds: int = 15, limit: int = 200) -> dict[str, object]:
    target = domain.strip().rstrip(".").lower().encode("idna").decode("ascii")
    if "." not in target:
        raise ValueError("certificate transparency lookup requires a domain")
    url = f"https://crt.sh/?{urlencode({'q': f'%.{target}', 'output': 'json'})}"
    payload = _json_get(url, timeout_seconds=timeout_seconds)
    if not isinstance(payload, list):
        raise ValueError("certificate transparency response must be a list")
    entries=[]
    seen=set()
    for item in payload:
        if not isinstance(item, dict):
            continue
        key=(item.get("id"), item.get("serial_number"), item.get("name_value"))
        if key in seen:
            continue
        seen.add(key)
        entries.append({
            "id": item.get("id"),
            "issuer_name": item.get("issuer_name"),
            "common_name": item.get("common_name"),
            "name_value": item.get("name_value"),
            "not_before": item.get("not_before"),
            "not_after": item.get("not_after"),
            "entry_timestamp": item.get("entry_timestamp"),
            "serial_number": item.get("serial_number"),
        })
        if len(entries) >= limit:
            break
    return {"domain": target, "entries": entries, "truncated": len(payload) > len(entries), "source": url}


def tls_certificate_metadata(hostname: str, *, port: int = 443, timeout_seconds: int = 10) -> dict[str, object]:
    host = hostname.strip().rstrip(".").lower().encode("idna").decode("ascii")
    if not 1 <= port <= 65535:
        raise ValueError("invalid TLS port")
    addresses = _public_addresses(host, port)
    context = ssl.create_default_context()
    with socket.create_connection((host, port), timeout=timeout_seconds) as raw_socket:
        with context.wrap_socket(raw_socket, server_hostname=host) as tls_socket:
            certificate = tls_socket.getpeercert()
            cipher = tls_socket.cipher()
            version = tls_socket.version()
    subject = {key: value for group in certificate.get("subject", []) for key, value in group}
    issuer = {key: value for group in certificate.get("issuer", []) for key, value in group}
    san = [value for kind, value in certificate.get("subjectAltName", []) if kind == "DNS"]
    return {
        "hostname": host,
        "port": port,
        "resolved_addresses": addresses,
        "tls_version": version,
        "cipher": cipher[0] if cipher else None,
        "subject": subject,
        "issuer": issuer,
        "subject_alt_names": sorted(set(san)),
        "not_before": certificate.get("notBefore"),
        "not_after": certificate.get("notAfter"),
        "serial_number": certificate.get("serialNumber"),
    }


def http_header_fingerprint(url: str, *, timeout_seconds: int = 10) -> dict[str, object]:
    target = validate_public_https_url(url)
    request = Request(target, method="HEAD", headers={"User-Agent": USER_AGENT, "Accept": "*/*"})
    with urlopen(request, timeout=timeout_seconds) as response:  # nosec B310 - public HTTPS target validated
        final_url = response.geturl()
        validate_public_https_url(final_url)
        headers = {key.lower(): value for key, value in response.headers.items()}
        status = getattr(response, "status", 200)
    selected = {key: headers.get(key) for key in ("server", "via", "x-powered-by", "content-type", "strict-transport-security", "content-security-policy") if headers.get(key) is not None}
    return {"requested_url": target, "final_url": final_url, "status": status, "headers": selected, "header_names": sorted(headers)}


def _dns_over_https_txt(name: str, *, timeout_seconds: int = 10) -> list[str]:
    target = name.strip().rstrip(".").lower().encode("idna").decode("ascii")
    url = "https://dns.google/resolve?" + urlencode({"name": target, "type": "TXT"})
    payload = _json_get(url, timeout_seconds=timeout_seconds)
    answers = payload.get("Answer", []) if isinstance(payload, dict) else []
    records=[]
    for answer in answers:
        if isinstance(answer, dict) and answer.get("type") == 16 and isinstance(answer.get("data"), str):
            records.append(answer["data"].strip('"').replace('" "', ""))
    return records


def email_domain_security(domain: str, *, timeout_seconds: int = 10) -> dict[str, object]:
    target = domain.strip().rstrip(".").lower().encode("idna").decode("ascii")
    spf = [record for record in _dns_over_https_txt(target, timeout_seconds=timeout_seconds) if record.lower().startswith("v=spf1")]
    dmarc = [record for record in _dns_over_https_txt(f"_dmarc.{target}", timeout_seconds=timeout_seconds) if record.lower().startswith("v=dmarc1")]
    return {"domain": target, "spf": spf, "dmarc": dmarc, "spf_present": bool(spf), "dmarc_present": bool(dmarc), "source": "Google Public DNS JSON API"}


def asn_network_lookup(resource: str, *, timeout_seconds: int = 15) -> dict[str, object]:
    canonical = str(ipaddress.ip_address(resource.strip()))
    url = "https://stat.ripe.net/data/prefix-overview/data.json?" + urlencode({"resource": canonical})
    payload = _json_get(url, timeout_seconds=timeout_seconds)
    data = payload.get("data", {}) if isinstance(payload, dict) else {}
    return {
        "resource": canonical,
        "prefix": data.get("prefix"),
        "asns": data.get("asns", []),
        "holder": data.get("holder"),
        "announced": data.get("announced"),
        "source": url,
    }


@dataclass
class _RedirectRecorder(HTTPRedirectHandler):
    chain: list[dict[str, object]]

    def redirect_request(self, req, fp, code, msg, headers, newurl):
        validate_public_https_url(newurl)
        self.chain.append({"status": code, "from": req.full_url, "to": newurl})
        return super().redirect_request(req, fp, code, msg, headers, newurl)


def redirect_chain(url: str, *, timeout_seconds: int = 10, max_redirects: int = 10) -> dict[str, object]:
    target = validate_public_https_url(url)
    chain: list[dict[str, object]] = []
    handler = _RedirectRecorder(chain)
    opener = build_opener(handler)
    request = Request(target, method="HEAD", headers={"User-Agent": USER_AGENT})
    with opener.open(request, timeout=timeout_seconds) as response:
        final_url = response.geturl()
        status = getattr(response, "status", 200)
    if len(chain) > max_redirects:
        raise ValueError("redirect chain exceeds configured limit")
    validate_public_https_url(final_url)
    return {"requested_url": target, "redirects": chain, "final_url": final_url, "final_status": status}


def web_archive_history(url: str, *, timeout_seconds: int = 15, limit: int = 50) -> dict[str, object]:
    target = validate_public_https_url(url)
    query = urlencode({"url": target, "output": "json", "fl": "timestamp,original,statuscode,digest", "filter": "statuscode:200", "limit": str(limit), "collapse": "digest"})
    endpoint = f"https://web.archive.org/cdx/search/cdx?{query}"
    payload = _json_get(endpoint, timeout_seconds=timeout_seconds)
    rows=[]
    if isinstance(payload, list) and payload:
        header=payload[0]
        if isinstance(header, list):
            for values in payload[1:]:
                if isinstance(values, list) and len(values) == len(header):
                    rows.append(dict(zip(header, values)))
    return {"url": target, "captures": rows, "source": endpoint}
