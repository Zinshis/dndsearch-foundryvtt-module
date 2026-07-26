# Foundry VTT WebSocket Client Implementation Guide

## Goal

Implement the Foundry half of the full bridge defined in the server guide. One authorized GM client connects outbound to the .NET server, receives narrowly defined commands, stores generated images through Foundry APIs, updates the requested document, and returns a correlated result.

Complete the server contract in `Plans/01-dotnet-mcp-server-websocket-bridge.md` first or implement both sides together against the same version 1 fixtures.

## Existing module constraints

The Foundry module is under `FoundryVTTModule` and currently targets Foundry 13 types while its manifest declares versions 13 through 14. Before bridge work:

1. Change the TypeScript `MODULE_ID` to `dndsearch-mcp-module`, matching `module.json`.
2. Decide whether version 14 is genuinely supported. Align installed type definitions, runtime testing, and manifest compatibility before claiming verification.
3. Keep all user-facing settings, dialogs, notifications, and errors localizable through `lang/en.json`.
4. Keep source under `src` and regenerate `dist` with `npm run build`.
5. Leave `module.json` `socket` as `false`; the bridge uses its own WebSocket, not Foundry's module socket channel.

The module does not need an MCP TypeScript SDK. It is a WebSocket bridge client, while the .NET application is the MCP server.

## Fixed design decisions

1. Only a GM may pair or execute commands.
2. Exactly one GM browser is the server-recognized executor for a world.
3. Pairing is explicit and revocable; no permanent secret is compiled into the module.
4. The module accepts only bridge protocol version 1 and known command methods.
5. It derives artifact download URLs from the configured server origin and server-issued artifact ID. It never fetches a command-provided arbitrary URL.
6. It verifies image length, content type, and SHA-256 before uploading.
7. It checks document type, target, and owner permission immediately before mutation.
8. It stores generated images through Foundry's `FilePicker.uploadPersistent` API.
9. Destructive or user-visible changes may require GM confirmation according to a setting.
10. Every command receives one terminal result, even when it is declined or fails.

## Target source layout

Create these focused TypeScript modules:

```text
FoundryVTTModule/src/
  constants.ts
  module.ts
  bridge/
    bridge-client.ts
    bridge-contract.ts
    bridge-settings.ts
    bridge-state.ts
    pairing.ts
  commands/
    command-router.ts
    attach-image-command.ts
  foundry/
    document-image-service.ts
    generated-image-storage.ts
  security/
    image-validation.ts
    permission-policy.ts
  ui/
    pairing-dialog.ts
    command-confirmation.ts
```

Avoid a global mutable singleton. Construct a `BridgeClient` during `ready`, retain it in a small module-owned state object, and expose a read-only status API through the module if UI work needs it.

## Step 1: Define constants, settings, and localization

In `constants.ts` define:

```ts
export const MODULE_ID = "dndsearch-mcp-module";
export const BRIDGE_PROTOCOL_VERSION = 1;
export const MAX_IMAGE_BYTES = 20 * 1024 * 1024;
```

Register settings during `init`:

- Server base URL: world-scoped, GM-configurable, default empty.
- Bridge enabled: world-scoped, GM-configurable, default false.
- Confirm each mutation: world-scoped, GM-configurable, default true.
- Reconnect automatically: client-scoped, default true.
- Client credential: client-scoped and hidden from the ordinary settings UI.
- Paired world/server identity metadata: client-scoped and hidden.

Do not store a WebSocket ticket; it is single-use. Do not store credentials in a world setting because world settings are distributed beyond the one executor browser.

Add localized strings for settings, connection states, pairing, confirmation, validation errors, success, offline status, revocation, and version mismatch. Remove the hard-coded ready and active-GM notification strings from `module.ts` or localize them.

Normalize the server URL once:

- Require HTTPS outside an explicit localhost development mode.
- Remove paths, queries, fragments, and trailing slash.
- Convert HTTPS to WSS only when constructing the WebSocket endpoint.
- Reject embedded usernames and passwords.

Acceptance criteria:

- A non-GM cannot configure pairing or start the bridge.
- No bridge connection occurs when the URL is empty or the feature is disabled.
- All visible text comes from `lang/en.json`.

## Step 2: Implement the shared protocol contract

Mirror bridge protocol version 1 from the server guide in `bridge-contract.ts` using discriminated unions. Define register, registered, command, result, ping, pong, and server-error messages.

Do not trust TypeScript casts after `JSON.parse`. Implement runtime type guards that verify:

- The root is a plain object.
- `protocolVersion` equals 1.
- `type`, IDs, method, deadline, and nested values have the correct types.
- Strings and arrays stay below explicit length/count limits.
- `document.attachImage` has only the defined parameter fields.
- Target, content type, byte length, filename, SHA-256, and UUID format are valid.

Unknown optional fields may be ignored only within the same protocol version. Unknown message types or command methods must return a stable unsupported error; a protocol-version mismatch must close the connection and notify the GM.

Keep JSON fixtures shared conceptually with the C# tests. The same success, error, malformed, oversized, and version-mismatch examples should be exercised on both sides.

## Step 3: Implement pairing and ticket acquisition

Pairing UI flow:

1. GM opens the D&D Search connection settings.
2. GM supplies the HTTPS server URL and one-time pairing code.
3. `pairing.ts` sends `POST /bridge/pair` with the code, `game.world.id`, `game.user.id`, Foundry version, and module version.
4. Server returns the revocable client credential and bound identity information.
5. Store the credential in the hidden client-scoped setting and clear the pairing code from memory and form controls.
6. Display the paired server and world identity, never the credential.

Before every WebSocket connection:

1. Send the client credential to `POST /bridge/tickets` using an `Authorization: Bearer` header.
2. Request a ticket for the current world and user.
3. Receive a single-use ticket with its expiry.
4. Immediately connect to `wss://server/bridge/ws?ticket=...`.
5. Discard the ticket regardless of connection outcome.

Provide a Disconnect and Forget Pairing action that calls the server revocation endpoint when reachable, closes the socket, and clears the local credential. Clearing locally must still be possible when the server is offline.

Acceptance criteria:

- The pairing code and connection ticket are never logged or persisted.
- A stored credential is never placed in a WebSocket query string.
- Revocation stops reconnect attempts and clears local state.

## Step 4: Select one executor

Do not let every active GM connect and execute the same mutation.

Use a deterministic local eligibility rule before requesting a ticket. Prefer Foundry's canonical active-GM selection when available for the supported version; otherwise choose the active GM with the lexicographically lowest user ID. Re-evaluate when user activity changes.

The server remains authoritative. It binds one executor identity to the world and rejects an unauthorized takeover. Local selection reduces connection churn but is not the security boundary.

On losing eligibility:

- Stop reconnect timers.
- Close the socket normally.
- Cancel commands that have not begun mutation.
- Let an already-started Foundry document update finish and report its result if the socket remains writable; otherwise retain the result in the bounded completed-command cache for reconciliation after reconnect.

Acceptance criteria:

- With two GM browsers open, only one becomes the registered executor.
- Closing the active GM allows the next eligible GM to connect without duplicating completed work.

## Step 5: Implement the resilient WebSocket client

`BridgeClient` owns these states:

```text
disabled -> unpaired -> disconnected -> ticketing -> connecting
connecting -> registering -> connected
connected -> reconnecting -> ticketing
any state -> stopped
```

Requirements:

- At most one socket and one reconnect timer per client instance.
- Send registration immediately after open; do not accept commands before `registered`.
- Use full-jitter exponential backoff, for example 1 second up to 30 seconds.
- Reset backoff only after a stable registered interval.
- Reply to protocol pings and track the server heartbeat deadline.
- Close and reconnect when two heartbeat intervals pass without server activity.
- Stop on module disable, logout/navigation, loss of executor eligibility, explicit disconnect, or non-retryable authentication failure.
- Treat authentication, revocation, and protocol-version failures as non-retryable until user action.
- Keep one serialized send queue so results cannot interleave or send after closure.

WebSocket events can fire after a newer connection exists. Give each attempt an incrementing generation ID and ignore events from obsolete generations.

Acceptance criteria:

- Repeated enable calls do not create duplicate sockets.
- A stale socket cannot overwrite current connection state.
- Temporary network failure reconnects without user intervention.
- Revoked credentials do not cause an infinite retry loop.

## Step 6: Route and serialize commands

`command-router.ts` should:

1. Validate the envelope and deadline.
2. Check the bounded completed-command cache by command ID.
3. Reject a duplicate currently in progress.
4. Route only `document.attachImage` to its handler.
5. Ensure only one mutation command runs at a time initially.
6. Convert every thrown value into a sanitized stable bridge error.
7. Cache and send the terminal result.

Start with serial execution. Parallel image downloads and document mutations add race conditions when commands target the same document. Introduce keyed concurrency only after there are tests for ordering and conflicts.

Suggested stable client error codes:

- `COMMAND_EXPIRED`
- `COMMAND_UNSUPPORTED`
- `COMMAND_DECLINED`
- `ARTIFACT_DOWNLOAD_FAILED`
- `ARTIFACT_INVALID`
- `DOCUMENT_NOT_FOUND`
- `DOCUMENT_TYPE_UNSUPPORTED`
- `DOCUMENT_PERMISSION_DENIED`
- `FOUNDRY_UPLOAD_FAILED`
- `FOUNDRY_UPDATE_FAILED`
- `INTERNAL_ERROR`

## Step 7: Download and verify generated artifacts

Build the artifact URL locally as `/bridge/artifacts/{encodeURIComponent(artifactId)}` beneath the configured server origin. Authenticate the HTTPS request with the paired client credential.

Before upload:

1. Check the declared byte length against the local maximum.
2. Fetch with `credentials: "omit"`, redirect handling disabled or restricted to the same origin, and an abort signal tied to the command deadline.
3. Require an HTTP success response.
4. Require PNG, JPEG, or WebP content type.
5. Read the response with a hard byte limit; do not trust `Content-Length` alone.
6. Confirm actual length matches the command when supplied.
7. Calculate SHA-256 with `crypto.subtle.digest` and compare in constant-time style.
8. Check the image magic bytes as well as MIME type.
9. Sanitize the filename to a conservative basename and extension.

The server should already enforce these properties, but the Foundry client must independently validate them because it controls the final upload.

Acceptance criteria:

- Redirects to a different origin are rejected.
- Hash, length, signature, type, and size mismatches fail before Foundry upload.
- Abort and deadline cancellation stop an in-progress download.

## Step 8: Store the image through Foundry

Use Foundry 13's persistent module storage API:

```ts
const file = new File([validatedBlob], safeName, {
  type: validatedBlob.type
});

const response = await foundry.applications.apps.FilePicker.uploadPersistent(
  MODULE_ID,
  "generated",
  file,
  {},
  { notify: false }
) as { path?: string };
```

Require a returned path and reject unexpected response shapes. Let Foundry enforce the current user's upload permission. Show localized notifications yourself so bridge operations have consistent text.

Generate collision-resistant file names, for example `<document-id>-<command-id-prefix>.webp`. Do not overwrite an existing path unless the command explicitly describes a safe replacement behavior in a future protocol version.

If upload succeeds but the document update fails, report the uploaded path in server-only diagnostic data and schedule it for later orphan cleanup. Do not delete arbitrary paths automatically.

Acceptance criteria:

- Uploaded files live in the module's persistent `generated` directory.
- Two commands cannot accidentally overwrite each other's files.
- Upload permission errors become `FOUNDRY_UPLOAD_FAILED`.

## Step 9: Apply narrow document mutations

Resolve the target by Foundry UUID at execution time. Never accept a raw document update object from the server.

Before mutation:

- Confirm the current user is still a GM and executor.
- Resolve the UUID and reject null.
- Require owner-level permission.
- Confirm the document type matches the requested target.
- If confirmation is enabled, show document name, type, target, and image preview; never render untrusted HTML from the prompt or server.

Allowed version 1 mutations:

```ts
// Actor portrait
await actor.update({ img: foundryPath });

// Actor prototype token
await actor.update({ "prototypeToken.texture.src": foundryPath });

// Placed TokenDocument
await token.update({ "texture.src": foundryPath });

// Existing image JournalEntryPage
await page.update({ type: "image", src: foundryPath });

// New image page in a JournalEntry
await journal.createEmbeddedDocuments("JournalEntryPage", [{
  name: localizedGeneratedImageName,
  type: "image",
  src: foundryPath
}]);
```

Do not treat a `JournalEntry` as having a general portrait. Use `journalNewPage`, or target an existing `JournalEntryPage` UUID with `journalPage`.

Capture the previous image path before update and include it in local audit information. Do not automatically revert a successful Foundry update merely because the result WebSocket send fails; the completed-command cache must report what actually happened after reconnect.

Acceptance criteria:

- Each target accepts only its matching document type.
- Synthetic or embedded UUIDs work through Foundry UUID resolution where Foundry permits their update.
- Declined confirmation produces `COMMAND_DECLINED` without downloading or uploading.
- A failed result send never causes automatic reapplication.

## Step 10: UI and observability

Provide a compact GM-only status UI showing:

- Disabled, unpaired, connecting, connected, reconnecting, or error.
- Paired server origin and world identity.
- Last successful connection time.
- Current command state without exposing the full private prompt.
- Pair, reconnect, disconnect, and forget-pairing actions.

Use Foundry notifications sparingly: connection established after manual action, non-retryable errors, confirmation prompts, and completed mutations. Ordinary reconnect attempts belong in debug logs.

Prefix logs with the module ID and include safe command/connection IDs. Never log pairing codes, credentials, tickets, authorization headers, image bytes, or full generation prompts by default.

## Step 11: Build and verification

Add unit tests using the project's chosen test runner before implementing complex reconnection behavior. If no runner exists yet, add Vitest as a development dependency and keep tests outside `dist`.

Test:

- All runtime type guards and protocol fixtures.
- URL normalization and same-origin artifact construction.
- Executor selection with zero, one, and multiple active GMs.
- State transitions, stale socket events, backoff, and heartbeat timeout using fake timers and a mock WebSocket.
- Duplicate/in-progress/completed command handling.
- Image type, magic byte, byte limit, length, and hash checks.
- Permission and document-target matrix.
- Confirmation accept and decline paths.
- Upload success followed by update failure.

Build checks:

```powershell
npm --prefix FoundryVTTModule run build
npm --prefix FoundryVTTModule run package
```

Manual end-to-end test matrix:

1. Connect one GM and attach an Actor portrait.
2. Update an Actor prototype token.
3. Update a placed TokenDocument.
4. Create an image page in a JournalEntry.
5. Update an existing image page.
6. Decline confirmation.
7. Disconnect during generation, artifact download, upload, and after successful update but before result delivery.
8. Open two GM clients and verify only one executes.
9. Revoke pairing and verify reconnect stops.
10. Try wrong world, expired ticket, duplicate command, invalid hash, oversized image, unsupported document, and insufficient ownership.
11. Run the supported Foundry 13 and 14 versions separately before retaining both in the manifest.

## Module definition of done

- A GM can securely pair and establish a WSS connection without embedding server secrets.
- One executor processes version 1 commands for the current world.
- The client reconnects safely without duplicating sockets or mutations.
- Artifact downloads are same-origin-derived, authenticated, bounded, and hash-verified.
- Actor portrait, prototype token, placed token, existing journal image page, and new journal image page are supported through narrow handlers.
- Permission checks and optional confirmation occur immediately before mutation.
- Every command produces a cached terminal result suitable for reconnect reconciliation.
- All user-facing text is localized and the Foundry 13/14 compatibility claim is verified by testing.
