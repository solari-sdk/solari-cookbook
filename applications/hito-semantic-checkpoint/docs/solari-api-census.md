# Public Solari API census

Inspected 2026-09-10. Installed and locked: `@solarisdk/sandbox@0.1.3`, `@solarisdk/core@0.1.3`. R2 pins the current official Browser package at `@solarisdk/browser@0.1.4`, with its exact `patchright-core@1.62.2` dependency. Sandbox/Core remain 0.1.3; Desktop is already exported by Sandbox/Core and requires no additional package. Public API presence is not entitlement, backend availability, or live qualification.

Local evidence paths below are relative to `node_modules/`. S = `@solarisdk/sandbox/dist/sandbox-client.d.ts`; H = `@solarisdk/core/dist/handle.d.ts`; T = `@solarisdk/core/dist/types.d.ts`; D = `@solarisdk/core/dist/desktop.d.ts`; V = `@solarisdk/core/dist/volume-client.d.ts`; I = `@solarisdk/core/dist/template-client.d.ts` and `image.d.ts`.

| Solari primitive | Public API status | Package/API | Evidence | Limitation |
| --- | --- | --- | --- | --- |
| Sandbox creation | SUPPORTED_PUBLIC_API | SandboxClient.create | S | Subject to capacity and quota |
| Commands | SUPPORTED_PUBLIC_API | Sandbox.commands.run/start | H | Exit status is command evidence, not policy authority |
| Files and transport | SUPPORTED_PUBLIC_API | files.read/write/upload/download; uploadUrl/downloadUrl | H | Selected paths only in this application; signed URLs are capabilities |
| Lifecycle/status/kill | SUPPORTED_PUBLIC_API | get, kill; handle.pause/resume/kill/close | S,H | close only disconnects; kill needs confirmation |
| Snapshot capture | SUPPORTED_PUBLIC_API | snapshot; list/get/deleteSnapshot | S,H | Machine persistence, not evidence currentness |
| Snapshot restore | SUPPORTED_PUBLIC_API | create({fromSnapshot}); revert | T,H | In-place revert preserves worker identity; fresh create must be distinguished |
| Volume | SUPPORTED_PUBLIC_API | client.volumes.create/get/list/delete; create({volumes}); volumes.mount | S,V,T,H | Public API supported. Installed warning retained as historical SDK evidence; exact live backend and durability UNVERIFIED |
| Template/image | SUPPORTED_PUBLIC_API | TemplateClient; Image; template; promoteSnapshot | I,S,T | Recipe/template identity does not prove current project state |
| Desktop | SUPPORTED_PUBLIC_API | SandboxClient.createDesktop; Desktop.screenshot | S,D | Exported by installed sandbox package; GUI runtime untested here |
| Browser | SUPPORTED_PUBLIC_API | Separate @solarisdk/browser: Solari.launch, BrowserSession.newPage/close | Official Browser reference below | Official package 0.1.4 installed and pinned; integrated launch/inline-page/release adapter statically qualified; live backend UNVERIFIED |
| Preview URL | SUPPORTED_PUBLIC_API | previewUrl(port) | H | Public access and returned token must be treated carefully; not used here |
| Environment | SUPPORTED_PUBLIC_API | env(vars), create env options | H,T | Credential injection is not a secret vault or guaranteed redaction |
| Metadata/labels | SUPPORTED_PUBLIC_API | metadata and list filters | S,T | Caller-supplied labels are not attestation |
| Concurrency | SUPPORTED_BUT_LIMITED | Independent asynchronous create calls; ConcurrencyLimitError | S, exported errors | No inferred account quota; prototype deliberately sequences workers |
| Sandbox identity | SUPPORTED_PUBLIC_API | handle.id; SandboxView | H,T | Controller correlation, not cryptographic subject identity |
| Events/hooks | SUPPORTED_BUT_LIMITED | files.watch, commands.start/onData; SessionHooks | H,T | No public durable lifecycle webhook subscription found in inspected clients; SessionHooks are SDK wiring |
| Fresh-machine persistence | SUPPORTED_BUT_LIMITED | fromSnapshot, volume attachment, application file transport | T,H | Must reobserve even when bytes survive |
| Other: code contexts, metrics | SUPPORTED_PUBLIC_API | runCode/createCodeContext; metrics | H | Kernel state and usage metrics do not establish semantic authority |

Official references: [Sandbox API](https://docs.getsolari.com/sdk/typescript/sandboxes), [Desktop API](https://docs.getsolari.com/sdk/typescript/vms), [Browser API](https://docs.getsolari.com/sdk/typescript/browser), [Volumes](https://docs.getsolari.com/volumes), [SDK package overview](https://docs.getsolari.com/sdk/typescript), [official cookbook](https://github.com/solari-sdk/solari-cookbook).

The Browser docs distinguish `BrowserSession.close()` (release and wait) from client `Solari.close()` (local connection cleanup). Browser relaunch retries can create additional sessions. A future harness must disable relaunch retries and bound transport attempts. None were called during this pass.

API truth checks: production Desktop/cache adapters use `Pick` of installed SDK types. The contextual adapter uses the existing SDK-compatible Compute interface. Tests inspect installed runtime exports and member declarations without creating remote clients or resources. Browser `content()` is a Playwright page method, not an invented Solari-native method. R2 adds an integrated owner that launches through Solari.launch with retries disabled, uses newPage/setContent, and requires BrowserSession.close release confirmation. Browser platform availability and application installation are separate facts.
