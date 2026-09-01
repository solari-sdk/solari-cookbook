# API versioning and deprecation policy

The public HTTP contract uses an explicit major version in the path: `/api/v1/...`. The service version is reported separately by `/api/v1/version` and in the FastAPI/OpenAPI document.

## Compatibility rules

Within `v1`, additive fields and new endpoints are allowed. Existing field meanings, required request semantics, and successful response shapes should not change incompatibly without a new major API path. Clients must tolerate additive response fields.

A breaking change requires a new major path such as `/api/v2`. The old major version should remain available for a documented transition window when the project is deployed for external consumers. Because this repository is currently a public showcase rather than an operated external service, no time-based support guarantee is claimed yet.

## Deprecation

When a deployed endpoint is deprecated:

1. document its replacement in the OpenAPI description and repository documentation;
2. keep the old endpoint behavior stable during the announced transition period;
3. add a machine-readable deprecation/sunset header when an actual deployment date exists;
4. add tests covering both the legacy contract and replacement until removal;
5. remove the endpoint only in the next breaking API version or after the documented sunset boundary.

Never invent a sunset date before a real deployment/support commitment exists.
