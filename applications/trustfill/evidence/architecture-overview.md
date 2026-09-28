# Meridian Platform — Architecture Overview

**Document owner:** Principal Engineer, Platform
**Classification:** Internal — approved for disclosure under NDA
**Version:** 2.4 · Last reviewed: August 2025

> This document describes the production architecture of the Meridian data
> pipeline observability platform for the benefit of prospective customers and
> their security reviewers. It is maintained by the platform team and is reviewed
> less frequently than the Information Security Policy; where the two disagree on
> an operational commitment, the Information Security Policy and the Security
> Incident Response Plan take precedence.

---

## 1. Service model

Meridian is a multi-tenant software-as-a-service platform. All customers are
served from shared infrastructure; we do not operate single-tenant or
customer-dedicated deployments, and there is no on-premises or private-cloud
distribution of the product.

The platform ingests pipeline telemetry from customer data infrastructure,
stores and indexes it, and serves analysis through a web application and a
public API.

## 2. Hosting and regions

The platform runs entirely on Amazon Web Services. There are two serving regions
in production: **us-east-1** (Northern Virginia) and **eu-west-1** (Ireland). We
do not operate in any other region, and customer data does not transit outside
the region in which the tenant is provisioned except as described in section 6.

Each customer tenant is provisioned into exactly one region at the time of
account creation. Customers on the Business and Enterprise tiers may elect
provisioning into eu-west-1, in which case all customer data — primary storage,
search indices, backups, and derived aggregates — remains within the European
Union for the life of the tenant. Migration of an existing tenant between regions
is possible but is a manual operation coordinated with support; it is not
self-service.

Within each region the platform spans three availability zones. Stateless
services run in all three behind an application load balancer; stateful services
run with a primary in one zone and synchronous replicas in the others.

## 3. Tenant isolation

Tenant separation is **logical rather than physical**. Customer records carry a
tenant identifier, and isolation is enforced at three layers: row-level security
in the primary datastore, a tenancy-scoped data access layer through which all
application queries are required to pass, and per-tenant scoping of object
storage prefixes and search indices.

No customer receives dedicated compute or dedicated storage hardware. Prospective
customers who require physical separation are not a fit for the platform as
currently designed, and we say so during the evaluation rather than late in
procurement.

Cross-tenant access by application code is prevented by the data access layer,
which refuses any query lacking a tenant scope. This constraint is enforced in
code review and by an automated check in the continuous integration pipeline.

## 4. Data protection in the platform

Data at rest — the primary datastore, the search index, object storage, and
backups — is encrypted with AES-256 using keys held in AWS Key Management
Service. Storage-layer encryption is enabled at the volume and bucket level, and
application-layer encryption is applied additionally to a defined set of
sensitive fields.

All external connections terminate TLS at the load balancer, which is configured
to accept TLS 1.2 and TLS 1.3 only. Traffic between internal services within the
VPC is likewise encrypted in transit. The public API and the web application are
served exclusively over HTTPS with HSTS enabled.

## 5. Access paths for Meridian personnel

There is no direct network route from the corporate environment to production.
Engineers reach production through a bastion service that requires
authentication against the corporate identity provider with multi-factor
authentication, and that issues short-lived credentials scoped to the engineer's
role.

Access to customer data by Meridian personnel is possible only through the
internal administrative console, requires an explicit reason to be recorded at
the point of access, and generates an entry in the audit log.

## 6. Subprocessor data flows

Customer telemetry itself does not leave the serving region. Operational metadata
does flow to a small number of subprocessors: error aggregation receives stack
traces and request identifiers, transactional email receives recipient addresses
for platform notifications, and the customer support system receives ticket
content submitted by the customer. Each of these flows is documented on the
public trust page.

## 7. Resilience

Availability-zone failure is handled automatically and is not expected to be
customer-visible; the orchestration layer reschedules workloads onto the
surviving zones and the datastore promotes a synchronous replica.

Loss of an entire serving region requires failover to the secondary region.
Because promotion of the cross-region replica, DNS propagation, and index
rebuilding are involved, **a full region loss carries a recovery time objective
of 12 hours**. Customers should plan on that basis.

Backups are continuous, encrypted, and retained for thirty-five days, with
restoration exercised quarterly into an isolated environment.

## 8. Client-side and integration surface

The web application is a single-page application authenticating against a
first-party session service. Customers may enforce SAML 2.0 single sign-on
against their own identity provider; enterprise customers may additionally
provision users through SCIM.

The public API authenticates with scoped, revocable API tokens issued per tenant.
Tokens carry an optional expiry, are displayed exactly once at creation, and are
stored only as a hash.
