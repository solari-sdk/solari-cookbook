# Meridian Systems — Information Security Policy

**Document owner:** VP Engineering & Security
**Classification:** Internal — approved for disclosure under NDA
**Version:** 4.2 · Last reviewed: March 2026 · Review cadence: annual

---

## 1. Purpose and scope

This policy governs the protection of information assets belonging to Meridian
Systems, Inc. ("Meridian") and to the customers of the Meridian data pipeline
observability platform. It applies to all employees, contractors, and interns,
and to all systems that process, store, or transmit customer data.

Meridian is a Delaware corporation headquartered in Austin, Texas, with
approximately eighty employees. The platform is delivered exclusively as a
multi-tenant cloud service; we do not offer on-premises deployment.

## 2. Governance

Overall accountability for information security rests with the VP of Engineering
& Security, who reports directly to the Chief Executive Officer and holds the
designated security officer role for the organization. Security matters are
reviewed by the executive team monthly and reported to the board of directors
each quarter.

This policy is reviewed and re-approved annually, or sooner where a material
change to the platform, the regulatory environment, or the threat landscape
warrants it. The most recent review concluded in March 2026.

## 3. Personnel security

All candidates who receive an offer of employment are subject to a background
screening conducted by a third-party provider prior to their start date. The
screening covers criminal history and verification of prior employment and
education, and is performed to the extent permitted by applicable law in the
candidate's jurisdiction. Contractors with access to production systems are
screened on equivalent terms.

Every employee completes security awareness training during onboarding, within
their first two weeks, and again at twelve-month intervals for as long as they
remain with the company. Engineers whose work touches the production environment
complete an additional secure development module on the same annual cycle.
Completion is tracked, and managers are notified when a team member's training
lapses.

Upon termination, access is revoked as part of the offboarding workflow. People
Operations initiates the workflow on the employee's last working day; identity
provider access is disabled immediately, which cascades to all federated
applications, and hardware is collected and wiped. The workflow requires
confirmation from both the employee's manager and the security team before it is
marked complete.

## 4. Access control

Access to production systems follows the principle of least privilege. Standing
access is granted by role rather than to individuals, and requests for privileged
access require approval from the system owner.

Multi-factor authentication is required for all employee access to production
infrastructure and to the internal administrative console, without exception.
Authentication to internal systems is federated through our identity provider,
which enforces MFA at the point of sign-in; there is no path to production that
bypasses it.

User access rights are reviewed on a quarterly basis. The review is performed by
the system owner in conjunction with the security team, and any access that is no
longer justified by the individual's role is removed as part of the review.

Customers administering their own Meridian tenant may enforce SAML 2.0
single sign-on against their own identity provider, and enterprise-tier customers
may additionally require SCIM-based provisioning. Where a customer does not
federate, Meridian-managed passwords must be at least twelve characters, are
checked against a breached-credential corpus at the point they are set, and may
not be reused across the customer's last five passwords. Meridian does not impose
mandatory rotation intervals on customer passwords, consistent with current NIST
guidance.

## 5. Cryptography

Customer data stored in our production databases, object storage, and backup
media is encrypted using AES-256. Data in transit between customers and the
platform, and between internal services, is protected with TLS 1.2 or higher;
connections negotiating anything older are rejected at the load balancer.

Encryption keys are managed through AWS Key Management Service. Key material is
generated and stored within KMS and is not exportable. Customer-data encryption
keys are rotated annually under an automatic rotation schedule, and key usage is
logged to the audit trail described in section 7.

## 6. Vulnerability and patch management

Automated vulnerability scanning runs continuously against our container images
and our deployed infrastructure, and dependency scanning runs on every pull
request as part of the continuous integration pipeline. Findings are triaged by
the security team and assigned a severity in line with CVSS.

Vulnerabilities rated critical are remediated within seven calendar days of
triage. High-severity findings are remediated within thirty days, medium within
ninety, and low findings are addressed on a best-effort basis during regular
maintenance. Where a critical finding cannot be remediated inside the window, an
exception must be approved by the VP of Engineering & Security and recorded with
a compensating control and a target date.

Independent penetration testing of the platform is commissioned from an external
security firm, and the resulting report is made available to customers under NDA
on request. Remediation of findings from these engagements follows the same
severity-based timelines set out above.

## 7. Logging and monitoring

Administrative and security-relevant events — authentication attempts,
privilege changes, configuration changes, and access to customer data by Meridian
personnel — are written to a centralized, append-only audit log. Audit logs are
retained for thirteen months. Application and infrastructure telemetry not
classified as security-relevant is retained for ninety days.

## 8. Change management

Changes to production follow a documented workflow. All changes are made through
version-controlled infrastructure-as-code or application code, require review and
approval by at least one engineer other than the author, and must pass the
automated test and security-scanning suite before merge. Deployments are
automated; direct modification of production infrastructure outside this pipeline
is prohibited and is alerted on. Emergency changes may be applied ahead of review
but require retrospective approval within one business day.

## 9. Third-party and subprocessor management

Meridian engages a limited number of subprocessors, principally for cloud
infrastructure, transactional email, error aggregation, and customer support
tooling. A current list is maintained on our public trust page and customers may
subscribe to notifications of changes.

Before engagement, every subprocessor with access to customer data is assessed by
the security team. The assessment reviews the vendor's own third-party audit
reports where available, its security documentation, its data handling and
sub-processing arrangements, and its contractual commitments. Vendors handling
customer data are reassessed annually thereafter, and all such vendors are bound
by a data processing agreement incorporating the appropriate transfer mechanism.

## 10. Business continuity

Meridian maintains a business continuity plan covering loss of key personnel,
loss of a cloud region, and loss of a critical subprocessor. The plan is owned by
the VP of Engineering & Security and is exercised annually through a tabletop
review, the outcome of which is documented and fed back into the plan.

Backups of customer data are taken continuously and encrypted at rest using the
same AES-256 standard applied to primary storage. Restoration is tested quarterly
by performing a full restore into an isolated environment and validating data
integrity against the source. Backups are retained for thirty-five days.

## 11. Policy exceptions

Any exception to this policy requires written approval from the VP of Engineering
& Security, must record a compensating control and an expiry date, and is
reviewed at the point of expiry.
