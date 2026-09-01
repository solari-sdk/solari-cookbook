# Optional multi-user architecture and RBAC design

Single-user local/static operation remains the default. Multi-user capability is an optional server-mode extension and must not make the no-hosting workflow dependent on accounts or a central service.

## Trust boundary

A shared deployment would place authentication, authorization, durable collaboration state, and audit logging in the FastAPI/server boundary. Browser clients must not enforce authorization by themselves. All writes and protected reads are re-authorized server-side.

## Proposed roles

- **viewer** — read cases/events/entities/evidence explicitly shared with the user; no mutation.
- **analyst** — viewer permissions plus create/update assigned cases, notes, annotations, saved views, and reviewed derived relationships.
- **reviewer** — analyst permissions plus approve/reject derived conclusions and relationship/correlation decisions.
- **administrator** — manage users/roles, source configuration, retention policy, and operational settings; no implicit bypass of evidence/provenance requirements.

Roles are intentionally coarse. Per-case membership/assignment is a second authorization dimension so an analyst role does not automatically grant every case.

## Data model additions if implemented

- users and external identity references;
- case memberships/assignments with role or capability grants;
- immutable analyst-action audit records containing actor, timestamp, action, target type/ID, correlation ID, and before/after hashes where appropriate;
- review decisions on derived conclusions/relationships;
- shareable saved-view records that contain query/layout state but never API keys, cookies, source credentials, or browser session material;
- handoff notes and work-queue state scoped to cases.

## Authentication

Do not implement a bespoke password store for the showcase merely to check a box. A real shared deployment should use a maintained identity provider or well-supported authentication library, secure cookies/tokens, CSRF protections where applicable, MFA support appropriate to the deployment, and explicit session revocation.

## Static-mode interoperability

Portable cases remain the transfer boundary. Importing a portable case into a shared deployment creates/reviews server-side records under the importing user's identity; bundle metadata never grants server permissions. Export strips authentication/session state.

## Current decision

The architecture and role model are defined, but multi-user authentication/RBAC are not implemented. This avoids presenting an unauthenticated demo endpoint as a production collaboration system while keeping a clear implementation path.
