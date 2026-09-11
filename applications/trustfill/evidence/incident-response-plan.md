# Meridian Systems — Security Incident Response Plan

**Document owner:** VP Engineering & Security
**Classification:** Internal — approved for disclosure under NDA
**Version:** 3.1 · Last reviewed: January 2026

---

## 1. Scope

This plan describes how Meridian Systems detects, classifies, contains, and
communicates security incidents affecting the Meridian platform or customer data.
It is distinct from, though invoked alongside, the operational incident process
used for availability-only events.

An *incident* is any event that compromises, or is reasonably suspected to
compromise, the confidentiality, integrity, or availability of customer data or
of the systems that process it. A *personal data breach* is an incident meeting
the definition set out in Article 4(12) of the GDPR.

## 2. Roles

The **Incident Commander** owns the response for its duration and is drawn from a
rotating on-call roster of senior engineers. The Incident Commander has authority
to take any containment action they judge necessary, including taking the service
offline, without seeking prior approval.

The **Security Lead** — ordinarily the VP of Engineering & Security or their
delegate — assesses whether the incident constitutes a personal data breach and
owns the regulatory assessment.

The **Communications Lead** owns all outbound communication to customers,
regulators, and the public, and is the only person authorized to send it. During
business hours this role sits with the Head of Customer Success; outside them it
falls to the Incident Commander until handed over.

## 3. Severity classification

**Sev-1** — confirmed or strongly suspected unauthorized access to customer data,
or a full platform outage. Paged immediately, twenty-four hours a day. Executive
team notified within thirty minutes.

**Sev-2** — degradation affecting multiple customers, or a security control
failure with no evidence of exploitation. Paged during extended hours; response
begins within one hour.

**Sev-3** — single-customer impact or an internally discovered weakness with no
customer exposure. Handled on the next business day.

Severity is assigned by the Incident Commander at declaration and is revised as
understanding improves. Severity is never downgraded solely because an incident
is taking a long time to resolve.

## 4. Response lifecycle

**Detect.** Incidents reach us through automated alerting, the internal reporting
channel available to every employee, our published security contact address, or a
customer report. Any employee may declare an incident; nobody is required to seek
permission first, and declaring an incident that turns out to be benign is treated
as a good outcome rather than a false alarm to be discouraged.

**Triage and contain.** The Incident Commander establishes a dedicated channel and
a running timeline. Containment takes precedence over evidence preservation only
where continued exposure would be materially worse than the loss of forensic
detail; that judgment sits with the Incident Commander and is recorded.

**Eradicate and recover.** Root cause is identified and removed, affected
credentials are rotated, and service is restored from known-good state. Where a
regional failure is implicated, recovery follows the failover procedure described
in section 6.

**Review.** Every Sev-1 and Sev-2 incident receives a written post-incident review
within ten business days. Reviews are blameless, are circulated internally in
full, and produce tracked remediation items with named owners. Customers materially
affected by an incident may request the review under NDA.

## 5. Notification

Where an incident is determined to constitute a personal data breach affecting
customer data, Meridian notifies affected customers **without undue delay, and in
any event within 72 hours** of the determination. Notification is issued by the
Communications Lead and includes what is known at the time of writing: the nature
of the incident, the categories and approximate volume of data involved, the
likely consequences, the measures taken or proposed, and a named contact for
follow-up.

Meridian will not delay an initial notification in order to complete its
investigation. Where facts are still emerging, the initial notification says so
explicitly and is followed by updates as the picture becomes clearer.

Where Meridian acts as a processor, notification is made to the customer as
controller, and the customer retains responsibility for any onward notification
to data subjects or supervisory authorities. Regulatory notification obligations
falling on Meridian as a controller are assessed separately by the Security Lead.

Contractual notification commitments negotiated with individual customers may
differ from the standard set out above. Any such commitment must be reviewed and
approved by the Security Lead and by Legal before it is agreed, and once agreed is
recorded in the customer's contract record so that the response process can honor
it.

## 6. Regional failover and recovery objectives

The platform is deployed across multiple availability zones within each of its
serving regions. Loss of a single availability zone is handled automatically by
the load balancing and orchestration layer and is not expected to be
customer-visible.

Loss of an entire region is a Sev-1 event and triggers manual failover to the
secondary region. **The regional failover procedure targets a recovery time
objective of 4 hours** and a recovery point objective of 15 minutes. The procedure
is documented in the operations runbook and is rehearsed as part of the annual
business continuity exercise.

## 7. Evidence handling

Incident timelines, logs, and artifacts are preserved in a restricted-access
repository for a minimum of two years following closure. Access is limited to the
security team and to Legal, and is itself logged.
