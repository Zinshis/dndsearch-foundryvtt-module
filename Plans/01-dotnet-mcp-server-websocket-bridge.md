# .NET MCP Server and WebSocket Bridge Implementation Guide

## Goal

Build the server half of D&D Search as one ASP.NET Core application. It exposes a standard MCP Streamable HTTP endpoint to AI hosts and a separate authenticated WebSocket bridge to one active Foundry GM client per world.

This is the target architecture from the first implementation. There is no polling phase and no use of MCP elicitation or sampling as a command channel.

```text
AI host -- MCP Streamable HTTP --> /mcp
                                      |
                                      v
                             MCP tool implementation
                                      |
                                      v
Foundry GM <-- authenticated WS --> /bridge/ws
Foundry GM <-- artifact download -- /bridge/artifacts/{artifactId}
```

## Existing scaffold

The repository contains:

```text
McpServer/
  DndSearch.McpServer.slnx
  src/
    DndSearch.McpServer/
      DndSearch.McpServer.csproj
      Program.cs
```

The project targets .NET 10 and references `ModelContextProtocol.AspNetCore` 1.4.1. `Program.cs` already maps a stateless MCP endpoint at `/mcp` and a health endpoint at `/health`.

Use these commands from the repository root:

```powershell
dotnet restore McpServer/DndSearch.McpServer.slnx
dotnet build McpServer/DndSearch.McpServer.slnx
dotnet run --project McpServer/src/DndSearch.McpServer
```

Do not change to the MCP 2.0 prerelease as part of bridge implementation. Treat that as a separate dependency upgrade after 2.0 is stable and its protocol compatibility has been tested.

## Fixed design decisions

1. MCP and the Foundry bridge are separate transports in the same ASP.NET Core host.
2. MCP is stateless. Bridge connection and pending-command state belong to application services, not MCP sessions.
3. A world has at most one active executor connection. The executor must be an authenticated GM client.
4. Commands are versioned, correlated by a cryptographically random ID, cancellable, timed out, and idempotent.
5. Commands contain an artifact ID, never an arbitrary image URL.
6. Image bytes travel through an authenticated HTTP artifact endpoint, not through MCP JSON or WebSocket frames.
7. The bridge validates both authentication and authorization; knowing a world ID is never sufficient.
8. The initial deployment may keep connection state in memory. Horizontal scaling requires shared connection routing and is out of scope until a second server instance is introduced.

## Bridge protocol version 1

Serialize messages as UTF-8 JSON with camel-case property names. Reject unknown protocol versions and message types. Limit incoming messages to 64 KiB.

### Foundry registration

Sent immediately after the WebSocket opens:

```json
{
  "protocolVersion": 1,
  "type": "register",
  "worldId": "my-world",
  "foundryVersion": "13.350",
  "moduleVersion": "1.1.0",
  "userId": "foundry-user-id"
}
```

Server response:

```json
{
  "protocolVersion": 1,
  "type": "registered",
  "connectionId": "01J...",
  "heartbeatSeconds": 20
}
```

### Server command

```json
{
  "protocolVersion": 1,
  "type": "command",
  "id": "01J...",
  "method": "document.attachImage",
  "deadlineUtc": "2026-07-26T18:30:00Z",
  "parameters": {
    "documentUuid": "Actor.abc123",
    "target": "portrait",
    "artifactId": "01J...",
    "fileName": "elven-ranger.webp",
    "contentType": "image/webp",
    "byteLength": 894231,
    "sha256": "lowercase-hex-sha256"
  }
}
```

Allowed targets in version 1 are `portrait`, `prototypeToken`, `token`, `journalPage`, and `journalNewPage`.

### Foundry result

Success:

```json
{
  "protocolVersion": 1,
  "type": "result",
  "id": "01J...",
  "ok": true,
  "data": {
    "documentUuid": "Actor.abc123",
    "foundryPath": "storage/dndsearch-mcp-module/generated/elven-ranger.webp"
  }
}
```

Failure:

```json
{
  "protocolVersion": 1,
  "type": "result",
  "id": "01J...",
  "ok": false,
  "error": {
    "code": "DOCUMENT_PERMISSION_DENIED",
    "message": "The executor cannot update Actor.abc123."
  }
}
```

Do not return stack traces, access tokens, filesystem paths, or image-generation credentials in bridge or MCP errors.

## Target source layout

Create small, focused files under `McpServer/src/DndSearch.McpServer`:

```text
Bridge/
  BridgeEndpoint.cs
  BridgeMessageSerializer.cs
  BridgeOptions.cs
  FoundryConnection.cs
  FoundryConnectionRegistry.cs
  FoundryCommandDispatcher.cs
  Models/
    BridgeCommand.cs
    BridgeError.cs
    BridgeRegistration.cs
    BridgeResult.cs
Artifacts/
  GeneratedArtifact.cs
  IArtifactStore.cs
  FileArtifactStore.cs
  ArtifactEndpoint.cs
Authentication/
  BridgeIdentity.cs
  BridgeTicketService.cs
  PairingEndpoint.cs
Imaging/
  IImageGenerator.cs
  ImageGenerationResult.cs
  PlaceholderImageGenerator.cs
Tools/
  FoundryImageTools.cs
```

`PlaceholderImageGenerator` should make development possible without committing to an AI image provider. It may copy a configured local fixture into the artifact store. Provider selection and credentials stay behind `IImageGenerator`.

## Step 1: Add configuration and validation

Add these sections to `appsettings.json`, with development overrides in `appsettings.Development.json`:

```json
{
  "AllowedHosts": "localhost;127.0.0.1;[::1]",
  "Bridge": {
    "AllowedOrigins": ["https://localhost:30000"],
    "CommandTimeoutSeconds": 120,
    "HeartbeatSeconds": 20,
    "MaximumMessageBytes": 65536,
    "MaximumArtifactBytes": 20971520,
    "ArtifactLifetimeMinutes": 10,
    "ArtifactDirectory": "App_Data/artifacts"
  }
}
```

Create `BridgeOptions` and validate it during startup with `ValidateDataAnnotations()` and `ValidateOnStart()`. Fail startup for an empty allowed-origin list outside development, a writable artifact directory outside the application-owned data directory, or invalid limits.

Never commit secrets to either appsettings file. Supply image-provider credentials and signing keys through environment variables or the deployment secret store.

Acceptance criteria:

- Invalid bridge configuration prevents startup with a useful error.
- Production configuration cannot use an unrestricted origin or host wildcard.

## Step 2: Implement pairing and short-lived tickets

Native browser WebSockets cannot set an arbitrary `Authorization` header. Use a two-stage flow:

1. An administrator creates a one-time pairing code on the server for a specific world.
2. The GM submits the code to `POST /bridge/pair` over HTTPS.
3. The server consumes the code and returns a revocable client credential associated with the world and Foundry user.
4. Before each WebSocket connection, the module sends that credential to `POST /bridge/tickets`.
5. The server returns a random, single-use ticket lasting at most 60 seconds.
6. The module connects to `/bridge/ws?ticket=...`.
7. The endpoint atomically consumes the ticket before accepting registration.

Hash stored pairing codes and client credentials. Store only hashes plus identity, expiry, creation time, last-used time, and revocation state. Never write ticket query strings to application logs; configure request logging to redact the query.

For the first local implementation, an in-memory store is acceptable only when clearly marked as development-only. Before remote deployment, persist pairings and revocations in a database or protected local store.

Acceptance criteria:

- A ticket cannot be reused.
- An expired or revoked credential cannot obtain a ticket.
- A ticket for world A cannot register for world B.
- An unlisted `Origin` receives HTTP 403 before WebSocket upgrade.

## Step 3: Implement connection registration

`FoundryConnectionRegistry` owns a thread-safe mapping from world ID to `FoundryConnection`. A connection contains:

- Connection ID and authenticated bridge identity.
- WebSocket instance.
- A per-connection send lock because only one send operation may run at a time.
- Connected-at and last-heartbeat timestamps.
- A cancellation token cancelled when the socket closes.

Replacement policy:

- Registering the same identity again replaces its older socket.
- A different identity cannot silently replace an active executor; reject it with a stable error unless an administrative takeover token was issued.
- Removing an old socket must use its connection ID so it cannot accidentally remove a newer replacement.

The endpoint must run one receive loop, assemble fragmented frames, reject binary frames, handle normal close frames, and dispose the socket in `finally`. Process completed messages without allowing concurrent access to the receive API.

Implement protocol-level `ping` and `pong` messages. Close connections that miss two heartbeat intervals.

Acceptance criteria:

- Reconnect replaces only the authenticated connection it belongs to.
- Disconnect removes the correct registry entry and fails its pending commands.
- Oversized, binary, malformed, or unknown messages close with an appropriate WebSocket close status.

## Step 4: Implement command dispatch and correlation

`FoundryCommandDispatcher` should expose:

```csharp
Task<BridgeResult> InvokeAsync(
    string worldId,
    BridgeCommand command,
    TimeSpan timeout,
    CancellationToken cancellationToken);
```

Internally:

1. Validate the command before registering it.
2. Look up the active connection.
3. Add a `TaskCompletionSource<BridgeResult>` to a concurrent pending map keyed by command ID.
4. Send the command through the connection send lock.
5. Await the result with linked caller, timeout, and connection cancellation tokens.
6. Remove the pending entry in `finally`.
7. Complete pending requests when the receive loop gets a matching result.

Use `TaskCreationOptions.RunContinuationsAsynchronously`. Reject duplicate IDs. Ignore and audit late results after a timeout. Do not automatically replay an in-flight mutation after reconnect; return `COMMAND_OUTCOME_UNKNOWN` unless the Foundry client proves it has already completed that command ID.

Maintain a bounded completed-command cache per world. It allows the Foundry client to return its previous result if the exact same command is deliberately retried.

Acceptance criteria:

- Concurrent tool calls receive their own results.
- Caller cancellation and server timeout both remove pending state.
- A disconnect immediately fails all commands assigned to that connection.
- Duplicate command IDs never cause duplicate mutations.

## Step 5: Implement artifact storage and download

`IArtifactStore` must support create, open-for-read, consume, and delete operations. Each `GeneratedArtifact` contains:

- Random artifact ID unrelated to its file name.
- Sanitized display file name.
- Content type, byte length, and SHA-256.
- Owning world ID.
- Created and expiry timestamps.
- Consumption state.

The initial `FileArtifactStore` may write beneath `App_Data/artifacts`, with random server-side filenames. Never derive a disk path from client input. Write to a temporary file, validate size and hash, then atomically publish it.

Map `GET /bridge/artifacts/{artifactId}`. Require the paired credential, verify world ownership, set `Cache-Control: no-store`, and stream the file. Do not expose the server-side path. Delete expired artifacts in a hosted cleanup service. Keep an artifact briefly after a download so a transient Foundry upload failure can be retried; cap its total lifetime.

Allowed initial formats should be explicit, for example PNG, JPEG, and WebP. Validate both declared MIME type and file signature.

Acceptance criteria:

- A credential from another world receives 404, not identity-revealing 403 details.
- Expired artifacts cannot be downloaded.
- File names cannot traverse directories.
- Over-limit or invalid image data is rejected before command dispatch.

## Step 6: Add the MCP image tool

Create `Tools/FoundryImageTools.cs` as an instance tool with constructor-injected dependencies. Mark its class with `[McpServerToolType]` and its method with `[McpServerTool]`.

The first tool should be `generate_and_attach_image` with these model-visible inputs:

- `worldId`
- `documentUuid`
- `target`
- `prompt`
- Optional safe generation choices such as aspect ratio

Do not expose transport details, artifact paths, update dictionaries, Foundry credentials, arbitrary URLs, or arbitrary document fields to the model.

Tool flow:

1. Validate identifiers, target, prompt length, and requested image options.
2. Confirm an executor is connected before paying for image generation.
3. Generate the image through `IImageGenerator`.
4. Validate and store it through `IArtifactStore`.
5. Dispatch `document.attachImage` and await the bridge result.
6. Return structured MCP output containing document UUID, Foundry path, and status.
7. Delete or expire the artifact according to the outcome.

Return stable, actionable errors such as `WORLD_OFFLINE`, `IMAGE_GENERATION_FAILED`, `COMMAND_TIMED_OUT`, and the sanitized Foundry bridge error.

Acceptance criteria:

- The tool appears in MCP `tools/list`.
- No image bytes or credentials appear in MCP JSON.
- Cancelling the MCP request cancels generation and command waiting.
- A disconnected world is detected before image generation begins.

## Step 7: Wire the ASP.NET Core pipeline

Extend `Program.cs` in this order:

1. Bind and validate options.
2. Register authentication, artifact, imaging, registry, dispatcher, and cleanup services.
3. Register MCP with stateless HTTP and tool discovery.
4. Enable forwarded headers only when a trusted reverse proxy is configured.
5. Add request limits, redacted structured logging, exception handling, HTTPS redirection in remote deployments, and rate limiting.
6. Map `/health`, `/mcp`, pairing/ticket endpoints, artifact download, and `/bridge/ws`.

Do not apply permissive global CORS. MCP browser clients need a narrow MCP CORS policy. The Foundry pairing, ticket, and artifact endpoints need a separate policy listing the exact Foundry origins. WebSocket origin validation must still occur in the endpoint.

## Step 8: Automated and manual verification

Add a test project when implementation begins:

```powershell
dotnet new xunit -n DndSearch.McpServer.Tests -o McpServer/tests/DndSearch.McpServer.Tests
dotnet sln McpServer/DndSearch.McpServer.slnx add McpServer/tests/DndSearch.McpServer.Tests
dotnet add McpServer/tests/DndSearch.McpServer.Tests reference McpServer/src/DndSearch.McpServer
```

Cover:

- Contract serialization and validation.
- Pairing consumption, credential revocation, and ticket expiry/replay.
- Connection replacement and disconnect races.
- Concurrent dispatch, cancellation, timeout, duplicate, and late-result behavior.
- Artifact authorization, expiry, signature validation, limits, and traversal attempts.
- MCP tool validation and error mapping.
- A WebApplicationFactory integration test that opens a WebSocket, invokes a tool, receives a command, responds, and observes the tool result.

Final verification commands:

```powershell
dotnet format McpServer/DndSearch.McpServer.slnx --verify-no-changes
dotnet test McpServer/DndSearch.McpServer.slnx
dotnet build McpServer/DndSearch.McpServer.slnx --configuration Release
```

## Server definition of done

- An MCP client can discover and call `generate_and_attach_image` over `/mcp`.
- An authenticated GM module can pair, obtain a single-use ticket, and connect over WSS.
- The MCP tool waits for the correctly correlated Foundry result.
- Images are downloaded through an authenticated, expiring artifact endpoint.
- Disconnects, timeouts, cancellation, duplicate IDs, and malformed frames are tested.
- Secrets and arbitrary URLs never cross into model-controlled tool arguments.
- Logs identify request, command, world, and connection IDs without exposing tokens or private image data.
