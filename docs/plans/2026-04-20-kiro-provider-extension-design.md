# Kiro provider extension for pi

## Goal

Build a pi extension that lets a user log in with Kiro credentials through `pi /login` and use the models Kiro/Q exposes. The extension should follow the Kiro/Q browser-based device login flow, support AWS Builder ID and IAM Identity Center, discover models dynamically when possible, and fall back to a bundled model catalog when discovery fails.

This is a pi-native v1. It does not import tokens or account state from `kiro-cli`.

## Scope

### In scope

- A pi package with a custom provider named `kiro`
- `pi /login` support through pi's provider OAuth hooks
- Guided auth flow for:
  - AWS Builder ID
  - IAM Identity Center
- Browser-based device authorization flow
- Refresh-token support
- Dynamic model discovery after login and on startup when credentials exist
- Fallback model catalog when discovery fails
- Custom request and streaming adapter for Kiro/Q APIs
- Basic support for tool calling
- Clear errors for unsupported or misconfigured enterprise cases, including missing `profileArn`

### Out of scope for v1

- Importing or syncing auth data from the local `kiro-cli` SQLite database
- Multi-account rotation
- Usage/quota tracking and account selection strategies
- Automatic `profileArn` discovery from `kiro-cli`
- Full parity with the OpenCode plugin's local storage and recovery features

## Why this shape

Pi already supports custom providers, custom OAuth login flows, and custom streaming adapters through extensions. That makes a pi-native extension the right abstraction. The hard part is not the login prompt itself. The hard part is adapting pi's conversation and tool-call model to Kiro/Q's `generateAssistantResponse` request and stream format.

The OpenCode plugin proves the login and request path are feasible. It also shows which pieces are worth carrying into pi:

- AWS device authorization flow for Builder ID and Identity Center
- custom request transformation to Kiro/Q conversation state
- custom streaming transformation back into assistant text, thinking, and tool calls
- token refresh with stored provider-specific metadata

The OpenCode plugin also includes features we should defer in v1, especially `kiro-cli` SQLite sync and account rotation.

## Architecture

The extension should be structured as a small pi package with one primary extension entry point and a few focused modules.

### Proposed package layout

```text
package.json
extensions/
  kiro/
    index.ts
    auth.ts
    refresh.ts
    models.ts
    request.ts
    stream.ts
    types.ts
    fallback-models.ts
README.md
```

### Module responsibilities

- `extensions/kiro/index.ts`
  - registers the `kiro` provider
  - wires together auth, model discovery, refresh, and streaming
- `extensions/kiro/auth.ts`
  - login wizard inputs
  - AWS OIDC client registration
  - device authorization flow
  - browser URL handling for Builder ID and Identity Center
- `extensions/kiro/refresh.ts`
  - token refresh logic for Builder ID and Identity Center
- `extensions/kiro/models.ts`
  - live model discovery
  - fallback list management
  - merge and normalization rules
- `extensions/kiro/request.ts`
  - converts pi context into Kiro/Q request payloads
- `extensions/kiro/stream.ts`
  - converts Kiro/Q stream events back into pi assistant events
- `extensions/kiro/types.ts`
  - shared auth and model types
- `extensions/kiro/fallback-models.ts`
  - bundled known-good model definitions

## Provider registration

The extension should register a provider named `kiro` using `pi.registerProvider("kiro", ...)`.

The provider should include:

- `oauth` for `pi /login`
- a custom API identifier such as `kiro-api`
- a custom `streamSimple` implementation
- a model list populated from either:
  - live discovery, or
  - fallback models

This keeps the UX aligned with native pi behavior:

- the provider appears in `/login`
- the provider's models appear in `/model`
- the user can switch between `kiro/*` models like any other provider

## Auth flow

### User flow

When the user runs `pi /login` and selects `Kiro`, the extension should guide them through these choices:

1. Choose auth mode:
   - AWS Builder ID
   - IAM Identity Center
2. If the user chooses Builder ID:
   - prompt for SSO/OIDC region, default `us-east-1`
3. If the user chooses IAM Identity Center:
   - prompt for Start URL
   - prompt for SSO/OIDC region, default `us-east-1`

After that, the extension should:

1. register an AWS OIDC client
2. request a device code
3. open the browser with `callbacks.onAuth(...)`
4. poll for the token
5. persist the token and provider metadata in pi auth storage

### Browser URL behavior

For Builder ID, use the verification URL returned by AWS.

For IAM Identity Center, prefer the org-specific portal device URL shape:

- `https://<org>.awsapps.com/start/#/device?user_code=...`

This matches the OpenCode plugin's behavior and keeps the login experience closer to native Kiro/Q login.

### Stored credential shape

The OAuth credential payload should store more than the standard token trio. The extension needs these fields for refresh and request routing:

```ts
interface KiroOAuthCredentials {
  refresh: string
  access: string
  expires: number
  authMode: "builder-id" | "identity-center"
  region: string
  oidcRegion: string
  startUrl?: string
  clientId: string
  clientSecret: string
  profileArn?: string
}
```

Notes:

- `region` is the service region used for requests
- `oidcRegion` is the region used for AWS OIDC device auth and refresh
- `profileArn` is optional in storage but may be required for some enterprise setups

## Token refresh

The extension should implement `oauth.refreshToken(credentials)` using the stored metadata.

Expected behavior:

- Builder ID refresh uses the Kiro desktop auth endpoint flow
- Identity Center refresh uses `https://oidc.{region}.amazonaws.com/token`
- the extension refreshes before expiry with a small safety buffer
- the refreshed credential object preserves `authMode`, `region`, `oidcRegion`, `startUrl`, `clientId`, `clientSecret`, and `profileArn`

If refresh fails in a way that suggests expired or invalid credentials, the error message should tell the user to run `/login` again.

## Model lifecycle

### Design goal

Model support must handle churn. Kiro/Q model availability changes over time, so the extension should not rely on a fully static model catalog.

### Strategy

Use a two-layer approach:

1. **Live discovery first**
   - after successful login
   - on extension startup when stored credentials exist
2. **Fallback catalog second**
   - bundled set of known-good models used when discovery fails

### Discovery behavior

The extension should try to fetch the current model list from the authenticated Kiro/Q service. If a discovery endpoint is not stable or direct enumeration is awkward, the extension may need a dedicated discovery adapter based on the same APIs Kiro uses internally.

The normalization layer should convert raw discovered models into pi model definitions:

- `id`
- `name`
- `reasoning`
- `input`
- `contextWindow`
- `maxTokens`
- `cost`
- optional compatibility overrides

### Fallback behavior

If discovery fails, the extension should still register `kiro` with a bundled model list. That list should be easy to update in one file.

The fallback list should include as many currently known Kiro/Q models as practical, not just Claude models, because the user explicitly wants broad exposure to whatever Kiro can use.

### Runtime behavior

Model discovery should not determine whether login succeeds. Auth success and model discovery are separate concerns.

- login succeeds if auth succeeds
- model discovery failure results in fallback registration, not login failure

## Request pipeline

Kiro/Q does not expose a normal OpenAI- or Anthropic-compatible chat API for this use case. The extension should therefore implement a custom `streamSimple` adapter rather than pretend Kiro is an OpenAI-compatible provider.

### High-level flow

1. pi assembles the current system prompt, messages, tools, and reasoning level
2. the extension converts that context into Kiro/Q `conversationState`
3. the extension sends the request to the regional Kiro/Q endpoint
4. the extension reads the event stream
5. the extension emits pi assistant events back to the runtime

### Request adapter responsibilities

The request adapter in `request.ts` should:

- merge or normalize system prompt handling for Kiro/Q
- normalize replayed pi messages before request building
- skip errored or aborted assistant turns during replay
- preserve tool-call and tool-result adjacency across history reconstruction
- aggregate consecutive tool results into a single Kiro follow-up user-input message
- synthesize missing tool results for orphaned tool calls when replay requires it
- apply conservative request-size budgeting before transport
- convert pi messages into Kiro/Q history entries
- translate tool definitions into the Kiro/Q tool schema
- encode images only if the Kiro/Q request path clearly supports them
- map pi thinking level into Kiro/Q thinking configuration
- include `profileArn` when present
- route requests to the correct regional endpoint

The code should stay isolated and explicit. This layer is the most likely to break when Kiro/Q changes.

## Thinking model

Do not create separate public `-thinking` models inside pi unless Kiro/Q forces it. Prefer mapping pi thinking levels to Kiro/Q thinking parameters.

That gives the user a more native pi experience:

- `/model` selects the base model
- pi's thinking controls continue to work
- no need to duplicate each model into visible thinking and non-thinking variants

If Kiro/Q only exposes separate model IDs for thinking internally, the adapter can still hide that detail behind model normalization.

## Streaming adapter

The streaming adapter in `stream.ts` should read Kiro/Q events and emit pi assistant events in the standard order.

### Required event support

- assistant start
- text block start, delta, end
- thinking block start, delta, end when available
- tool call start, delta, end
- final stop reason
- usage metadata when derivable

### Adapter goals

- preserve normal text streaming behavior first
- support tool calling in v1
- support images only when request and response handling are clear
- degrade cleanly when a capability cannot be represented faithfully

The OpenCode plugin's SDK stream transformer is a useful reference for:

- reconstructing text and thinking blocks
- detecting tool calls
- estimating or deriving usage
- mapping stream end state into a chat completion style model

## `profileArn` handling

Some IAM Identity Center environments appear to require `profileArn` for Q Developer or CodeWhisperer APIs.

For v1, the extension should not try to auto-discover it from `kiro-cli`. Instead:

- allow `profileArn` to be configured manually through extension config or environment variable
- store it in credentials once known
- when an enterprise login fails in a way that strongly suggests missing `profileArn`, raise a direct error message

Example error guidance:

- this IAM Identity Center account appears to require `profileArn`
- set it in extension config and run `/login` again

This keeps v1 simple while still supporting enterprise users who know their required profile data.

## Error handling

The extension should fail clearly and in layers.

### Auth errors

- invalid Start URL
- invalid region
- failed client registration
- failed device authorization
- login timed out
- user denied authorization
- token exchange failed

Each error should say what failed and what the user should do next.

### Refresh errors

- invalid refresh token
- missing stored OIDC client credentials
- network failure
- expired org configuration

When refresh cannot recover, instruct the user to run `/login` again.

### Model discovery errors

- discovery endpoint unavailable
- unauthorized discovery call
- malformed discovery response

These should not block provider use. The extension should log the issue, notify the user if helpful, and fall back to bundled models.

### Request and streaming errors

- unsupported model ID
- malformed Kiro/Q response
- missing required enterprise `profileArn`
- tool-call translation mismatch
- abort/cancel handling

When possible, return errors that preserve enough detail for debugging without overwhelming the user.

## Testing strategy

### Unit tests

Add focused tests for:

- Builder ID auth URL generation
- Identity Center device URL generation from Start URL
- token refresh request generation
- model normalization and merge logic
- fallback model behavior when discovery fails
- thinking-level mapping
- request conversion from pi messages to Kiro/Q conversation state
- stream event conversion back into pi assistant events

### Integration tests

Cover these cases:

1. login with Builder ID
2. login with Identity Center
3. refresh token after stored login
4. discover models after login
5. fall back to bundled models when discovery fails
6. send a simple prompt
7. run at least one tool-calling prompt
8. switch models with `/model`
9. resume a session after restarting pi
10. abort an in-flight request cleanly

### Manual QA checklist

- `pi /login` shows Kiro provider
- Builder ID flow opens browser and completes
- Identity Center flow prompts in the right order:
  - auth mode
  - Start URL only when needed
  - region
- discovered models appear in `/model`
- fallback catalog appears if discovery fails
- clear error appears for missing `profileArn` in enterprise setups

## Delivery plan

### Phase 1: scaffold provider extension

- create package structure
- register provider `kiro`
- wire fallback models only
- add placeholder custom API and stream adapter stubs

### Phase 2: auth and refresh

- implement Builder ID flow
- implement Identity Center flow
- persist provider-specific credentials
- implement refresh-token support
- verify `/login` end to end

### Phase 3: live model discovery

- add discovery client
- normalize discovered models
- merge with fallback catalog
- refresh provider models after login and on startup

### Phase 4: request adapter

- convert pi context into Kiro/Q request payloads
- normalize replayed history before request construction
- map tools and thinking
- send authenticated requests to regional endpoints

### Phase 5: streaming adapter

- transform Kiro/Q events into pi assistant stream events
- support text and thinking
- support tool calls
- handle abort and error cases

### Phase 6: hardening

- improve error messages
- document configuration, especially `profileArn`
- add tests and manual QA notes
- package for installation via `pi install`

## Open questions to resolve during implementation

1. What is the most reliable live model discovery path for Kiro/Q in practice?
2. Can all currently exposed Kiro/Q models be normalized cleanly into pi's model schema?
3. Does Kiro/Q expose enough metadata to distinguish reasoning support and image support for every discovered model?
4. Which enterprise environments require `profileArn`, and can we detect that need reliably from response codes?
5. Are there response-stream edge cases where Kiro/Q interleaves thinking and tool calls differently than pi expects?

## Implementation addendum — 2026-04-21

A later refactor tightened the request adapter after real multi-tool sessions produced `HTTP 400 {"message":"Improperly formed request."}` from `generateAssistantResponse`.

The root issue was not initial auth or the first user turn. It was the shape of follow-up requests after several tool calls. The early adapter serialized each tool result as its own Kiro user message and inserted synthetic continuation assistant messages between them. That was easy to build but too fragile for Kiro's `conversationState` requirements.

The refactor changed the adapter to follow pi's provider conventions more closely:

- normalize replayed messages before request construction
- skip errored or aborted assistant turns
- synthesize missing tool results for orphaned tool calls
- aggregate consecutive tool results into one Kiro current message
- align current tool results with tool uses already present in history

A follow-up hardening pass addressed Kiro request-body limits after real sessions began failing with `CONTENT_LENGTH_EXCEEDS_THRESHOLD`. That pass added:

- conservative truncation for oversized tool-result text
- replay-history pruning by serialized size
- final payload fitting before transport

This does not guarantee that every future Kiro API change will be handled automatically. It does remove the known malformed-history path and adds a safety valve for long tool-heavy sessions such as repeated `bash` calls during project investigation.

## Recommended first implementation target

Build a thin but real end-to-end vertical slice:

- `kiro` provider shows up in `/login`
- Builder ID login succeeds
- one fallback model works
- one discovered model path works
- one simple prompt streams back into pi

Then expand to full dynamic discovery and broader model coverage.

## Expected result

After this extension is complete, a pi user should be able to:

1. run `pi`
2. open `/login`
3. select `Kiro`
4. choose Builder ID or IAM Identity Center
5. complete the browser login flow
6. open `/model`
7. select from the Kiro/Q models currently available
8. use those models in pi like any other provider
