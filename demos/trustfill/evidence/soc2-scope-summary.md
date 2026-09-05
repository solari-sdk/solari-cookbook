# Meridian Systems — SOC 2 Report Summary

**Prepared for:** prospective customers and their security reviewers
**Classification:** Internal — approved for disclosure under NDA
**Version:** 1.3 · Prepared: February 2026

> This summary describes the scope and outcome of Meridian's most recent SOC 2
> examination. It is not a substitute for the report itself. The full report,
> including the auditor's opinion, the description of the system, and the detail
> of tests performed, is available under NDA through your account team.

---

## 1. Report type and period

Meridian Systems holds a **SOC 2 Type II** report. The most recent examination
covered the twelve-month period from **1 October 2024 to 30 September 2025** and
was issued in **December 2025**.

The examination was performed by an independent CPA firm licensed in the United
States and registered with the AICPA. The prior-year examination was a Type II
report covering the twelve months to 30 September 2024; the initial engagement
was a Type I as of 1 October 2023.

Examinations are conducted on an annual cycle, and the next report is expected to
cover the period to 30 September 2026.

## 2. Trust Services Criteria in scope

The examination covered the following Trust Services Criteria:

- **Security** (the common criteria) — in scope
- **Availability** — in scope
- **Confidentiality** — in scope
- **Processing Integrity** — *not* in scope
- **Privacy** — *not* in scope

Customers requiring assurance over Processing Integrity or Privacy should raise
this with their account team during evaluation. We have no committed date for
extending the scope.

## 3. Systems and services covered

The description of the system covers the Meridian data pipeline observability
platform as delivered from the us-east-1 and eu-west-1 regions, including the
ingestion pipeline, the primary datastore and search tier, the web application,
the public API, and the internal administrative console.

Corporate IT systems are in scope only to the extent that they form part of the
control environment — principally the identity provider, the endpoint management
platform, and the source control and continuous integration systems through which
changes reach production.

## 4. Complementary user entity controls

The report identifies controls that the customer, rather than Meridian, is
responsible for operating. In summary, customers are responsible for
provisioning and deprovisioning their own users, for configuring single sign-on
where they elect to use it, for the safekeeping and rotation of API tokens issued
to them, and for the accuracy and lawfulness of the data they send to the
platform.

## 5. Exceptions and their disposition

The most recent examination reported **one exception**.

During the period, the quarterly user access review for one quarter was completed
eleven days after the end of the quarter, outside the window specified by the
control. The auditor determined that the review itself was performed in full, that
no inappropriate access was identified during it, and that the deviation was one
of timeliness rather than of substance.

Management's response committed to automated calendar-driven initiation of the
review with escalation to the VP of Engineering & Security at day five of any
overrun. That remediation was implemented in November 2025 and has operated
without further exception since.

No exceptions were reported in the prior-year examination.

## 6. Related assurance activities

**Penetration testing.** The platform is subject to penetration testing performed
by an independent external security firm. The engagement covers the web
application, the public API, and the supporting cloud infrastructure, and is
conducted as a grey-box assessment with the tester provisioned as a
low-privileged tenant user. Findings are triaged and remediated in line with the
severity timelines set out in the Information Security Policy. An executive
summary of the most recent report is available under NDA on request; the full
technical report is not distributed outside Meridian.

**Vulnerability management.** Continuous automated scanning of infrastructure and
container images, and dependency scanning in the continuous integration pipeline,
operate as described in the Information Security Policy and were within the scope
of the examination.

**Business continuity.** The annual tabletop exercise and the quarterly backup
restoration test were both within scope and operated without exception during the
period.

## 7. Other frameworks

Meridian does not currently hold ISO/IEC 27001 certification, nor a HITRUST
certification, nor a FedRAMP authorization, and has no committed timeline for
pursuing any of them. Where a customer's requirement is for ISO 27001
specifically, we say so during evaluation rather than at contract stage.

Meridian is not a HIPAA covered entity or business associate and does not accept
protected health information onto the platform. This restriction is stated in the
acceptable use terms.
