# Solari execution plane

The server-mode execution plane provides bounded, opt-in integration points for Solari Browser, Sandbox, and Desktop while keeping the default application usable without provider credentials.

## Safety gate

Live execution endpoints are disabled unless both `SOLARI_LIVE_API_ENABLED=true` and `SOLARI_API_KEY` are present. The API key is read from process environment only and is never returned by an endpoint, written to execution summaries, or embedded in artifacts.

Browser and Desktop targets must be credential-free HTTPS URLs. Literal local/private/non-routable addresses and localhost-style names are rejected. These controls reduce accidental internal-target use; they are not presented as a complete enterprise SSRF boundary because DNS rebinding/resolution policy belongs at the deployment/network layer.

## Browser

`POST /api/v1/solari/browser/capture` performs a bounded Browser session with stage-aware failure classification, retries, timeout bounds, and cleanup. The capture retains rendered HTML and a full-page screenshot as content-addressed artifacts. When `recording=true`, the Browser session starts with provider recording enabled and the client polls the replay endpoint only after the browser has been closed. Provider replay upload lag or replay retrieval failure does not rewrite a successful page capture as a failure.

Browser execution history is persisted separately from source events and includes safe timing/session metadata plus artifact hashes. The dashboard links retained HTML, screenshot, and replay artifacts through the artifact preview/retrieval API.

## Sandbox

`POST /api/v1/solari/sandbox/geospatial` accepts only bounded latitude/longitude point lists and runs the project's deterministic geospatial enrichment program. It does not expose an arbitrary-code HTTP endpoint. stdout, stderr, result/error state, duration, and operation metadata are serialized into a content-addressed JSON transcript and linked to the persisted execution record.

Existing plugin and parser facilities remain separately bounded and are documented in the workflow/plugin guides. Provider-backed live Sandbox execution still requires an evaluator/user-owned Solari key.

## Desktop

`POST /api/v1/solari/desktop/capture` implements one deliberately narrow screen-driven public workflow: create/connect a Desktop session, wait for bounded readiness, open a local editor, exercise explicit mouse click and keyboard typing using only the public hostname, launch Chrome to the supplied HTTPS public URL without shell expansion, take a screenshot, close the session, and destroy the remote desktop.

The screenshot is retained as a content-addressed artifact and a normalized `desktop_capture` event is created so Desktop observations use the same event/evidence model as other acquisitions. The event explicitly states that visual content is retained for analyst review and is not automatically asserted as fact.

## Execution history and artifacts

`GET /api/v1/solari/executions` and `GET /api/v1/solari/executions/{id}` expose safe execution history for all three Solari products. Stored execution records contain kind, status, timestamps, target where applicable, provider session identifier, bounded diagnostic summary, artifact hashes, and sanitized failure information.

The server dashboard's **Solari execution artifacts** panel renders Browser/Sandbox/Desktop history and links retained artifacts through `/api/v1/artifacts/{sha256}/preview`. The implementation never embeds artifact bodies into execution metadata.

## Verification boundary

Unit/API tests use deterministic fake provider clients to verify lifecycle ordering, cleanup calls, replay handling, artifact retention/linking, execution persistence, public-target validation, and Desktop click/type/launch behavior. CI verifies those contracts without requiring secrets.

These tests establish implementation behavior but are not a substitute for a live provider run. TODO items explicitly requiring live Browser, Sandbox, Desktop, replay upload, or remote resource-leak verification remain open until a real `SOLARI_API_KEY` execution provides that evidence.
