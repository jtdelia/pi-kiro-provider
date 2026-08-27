# Kiro provider extension implementation tasks

This file breaks the work into atomic tasks for separate agents with fresh context windows.

Every task must be self-contained enough for a new agent to pick up, complete, test, and lint without relying on unstated context.

Primary design reference:

- `docs/plans/2026-04-20-kiro-provider-extension-design.md`

Primary pi references:

- `/opt/homebrew/lib/node_modules/@mariozechner/pi-coding-agent/docs/extensions.md`
- `/opt/homebrew/lib/node_modules/@mariozechner/pi-coding-agent/docs/custom-provider.md`
- `/opt/homebrew/lib/node_modules/@mariozechner/pi-coding-agent/examples/extensions/custom-provider-qwen-cli/index.ts`
- `/opt/homebrew/lib/node_modules/@mariozechner/pi-coding-agent/examples/extensions/custom-provider-gitlab-duo/index.ts`

OpenCode research references:

- `/tmp/opencode-kiro-auth/README.md`
- `/tmp/opencode-kiro-auth/src/kiro/oauth-idc.ts`
- `/tmp/opencode-kiro-auth/src/core/auth/idc-auth-method.ts`
- `/tmp/opencode-kiro-auth/src/plugin/request.ts`
- `/tmp/opencode-kiro-auth/src/plugin/streaming/sdk-stream-transformer.ts`

## Global rules for every task

1. Read the task section completely before coding.
2. Read the design doc before coding.
3. Keep the task atomic. Do not expand scope unless the task explicitly asks for it.
4. If the task adds behavior, add or update tests in the same task.
5. Run lint before finishing the task.
6. If the repository has typed tests, run the smallest useful targeted test command, then run the broader task-level command listed below.
7. Update docs or comments only if the task explicitly calls for it.

## Expected project shape after task 1

```text
package.json
eslint.config.*
tsconfig.json
vitest.config.*
README.md
extensions/
  kiro/
    index.ts
    auth.ts
    refresh.ts
    models.ts
    fallback-models.ts
    request.ts
    stream.ts
    types.ts
test/
```

The extension should register a pi provider named `kiro`.

---

## Task 1 — Scaffold the package, scripts, and test/lint toolchain

### Goal

Create the initial package and repository structure for a pi package that ships a TypeScript extension.

### Why this task exists

All later tasks depend on consistent scripts, module resolution, and a known directory layout. This task establishes the baseline and the mandatory lint/test commands that every later task must use.

### Read first

- `docs/plans/2026-04-20-kiro-provider-extension-design.md`
- `/opt/homebrew/lib/node_modules/@mariozechner/pi-coding-agent/docs/packages.md`
- `/opt/homebrew/lib/node_modules/@mariozechner/pi-coding-agent/docs/extensions.md`

### Deliverables

Create these files if they do not exist:

- `package.json`
- `tsconfig.json`
- `eslint.config.js` or `eslint.config.mjs`
- `vitest.config.ts`
- `README.md`
- `extensions/kiro/index.ts`
- `extensions/kiro/types.ts`
- `test/smoke.test.ts`

### Requirements

1. Configure the repo as a pi package.
2. Add a `pi` manifest in `package.json` that points at `extensions/`.
3. Add scripts for:
   - `lint`
   - `test`
   - `typecheck`
4. Add minimal runtime dependencies and peer dependencies needed for pi extension development.
5. Add dev dependencies for TypeScript, Vitest, and ESLint.
6. Create a trivial extension entry point that exports a default function and compiles.
7. Add one smoke test that validates the project can import the extension entry module.
8. README should explain how to load the extension locally with `pi -e`.

### Constraints

- Do not implement real provider logic yet.
- Keep the extension entry point minimal.
- Prefer simple, boring tooling over clever tooling.

### Suggested commands

- `npm install`
- `npm run typecheck`
- `npm run test`
- `npm run lint`

### Required test coverage

- Smoke test that imports the extension module successfully.
- If practical, assert the default export is a function.

### Done when

- The project installs cleanly.
- `npm run typecheck` passes.
- `npm run test` passes.
- `npm run lint` passes.

---

## Task 2 — Define core types, constants, and fallback model catalog

### Goal

Create the shared types and a maintained fallback model catalog for the `kiro` provider.

### Why this task exists

Later auth, discovery, request, and streaming work all need a shared vocabulary. The fallback model list is also a hard requirement when live model discovery fails.

### Read first

- `docs/plans/2026-04-20-kiro-provider-extension-design.md`
- `/tmp/opencode-kiro-auth/README.md`
- `/tmp/opencode-kiro-auth/src/constants.ts`
- `/opt/homebrew/lib/node_modules/@mariozechner/pi-coding-agent/docs/custom-provider.md`
- `/opt/homebrew/lib/node_modules/@mariozechner/pi-coding-agent/docs/models.md`

### Depends on

- Task 1

### Deliverables

Create or update:

- `extensions/kiro/types.ts`
- `extensions/kiro/fallback-models.ts`
- `extensions/kiro/models.ts`
- `test/types-and-fallback-models.test.ts`

### Requirements

1. Define credential types for stored Kiro OAuth metadata.
2. Define normalized model types used internally by the extension.
3. Define constants for:
   - default OIDC region
   - default service region
   - provider name `kiro`
   - auth mode enum or string union
4. Build a fallback model catalog that includes as many currently known Kiro/Q models as practical.
5. Normalize fallback entries into pi provider model config shape.
6. Add helper functions for:
   - reasoning flag derivation
   - input modalities derivation
   - context window defaults
   - max token defaults
7. Keep all fallback logic pure and testable.

### Constraints

- No network calls.
- No provider registration yet.
- Keep costs at zero if real costs are not available.
- If model capability metadata is uncertain, document the assumption in code comments.

### Required test coverage

- Fallback catalog is non-empty.
- No duplicate model IDs after normalization.
- At least one reasoning-capable model is present if the fallback list includes one.
- The provider-normalization helper returns valid shape for all fallback models.

### Required quality commands

- `npm run typecheck`
- `npm run test -- test/types-and-fallback-models.test.ts`
- `npm run lint`

### Done when

- Shared types exist and compile.
- Fallback models normalize cleanly.
- Tests and lint pass.

---

## Task 3 — Implement pure auth helpers for AWS device flow

### Goal

Implement the pure helper functions used by Kiro login flows, without wiring them into pi yet.

### Why this task exists

The login flow has tricky URL and payload behavior. The risky parts should be isolated and tested before integrating with pi OAuth callbacks.

### Read first

- `docs/plans/2026-04-20-kiro-provider-extension-design.md`
- `/tmp/opencode-kiro-auth/src/kiro/oauth-idc.ts`
- `/tmp/opencode-kiro-auth/src/core/auth/idc-auth-method.ts`

### Depends on

- Task 2

### Deliverables

Create or update:

- `extensions/kiro/auth.ts`
- `test/auth-helpers.test.ts`

### Requirements

Implement pure functions for:

1. region normalization
2. Start URL normalization
3. Builder ID vs Identity Center auth mode handling
4. Identity Center browser device URL construction from Start URL and user code
5. PKCE generation if needed by the chosen auth flow implementation
6. request-body builders for:
   - OIDC client registration
   - device authorization
   - token polling
   - refresh token requests
7. safe parsing helpers for AWS token responses

### Constraints

- Do not implement the full pi OAuth login callback yet.
- Avoid hidden I/O in these helpers.
- Keep browser URL logic deterministic and testable.

### Required test coverage

- Builder ID mode does not require Start URL.
- Identity Center mode requires normalized Start URL.
- Start URL normalization rewrites common portal URLs to `/start` form.
- Identity Center device URL contains the correct `#/device?user_code=...` fragment.
- Region normalization falls back to `us-east-1`.
- Request builders produce the expected payload shape.

### Required quality commands

- `npm run typecheck`
- `npm run test -- test/auth-helpers.test.ts`
- `npm run lint`

### Done when

- Pure auth helpers are implemented.
- The helper tests cover the tricky URL and payload cases.
- Tests and lint pass.

---

## Task 4 — Implement pi OAuth login flow for Builder ID and Identity Center

### Goal

Wire Kiro auth into pi `/login` using the provider OAuth interface.

### Why this task exists

This is the first end-user-visible feature. It must guide the user through the correct auth mode flow and persist enough metadata for future refresh.

### Read first

- `docs/plans/2026-04-20-kiro-provider-extension-design.md`
- `/opt/homebrew/lib/node_modules/@mariozechner/pi-coding-agent/docs/custom-provider.md`
- `/opt/homebrew/lib/node_modules/@mariozechner/pi-coding-agent/examples/extensions/custom-provider-qwen-cli/index.ts`
- `/tmp/opencode-kiro-auth/src/core/auth/idc-auth-method.ts`
- `/tmp/opencode-kiro-auth/src/kiro/oauth-idc.ts`

### Depends on

- Task 3

### Deliverables

Create or update:

- `extensions/kiro/auth.ts`
- `extensions/kiro/index.ts`
- `test/oauth-login.test.ts`

### Requirements

1. Expose an OAuth provider config for `kiro`.
2. The login flow must ask for auth mode first:
   - Builder ID
   - IAM Identity Center
3. If the user chooses Builder ID:
   - prompt for region only
4. If the user chooses Identity Center:
   - prompt for Start URL
   - prompt for region
5. Use `callbacks.onAuth(...)` to open the browser.
6. Poll for token completion.
7. Return an OAuth credential object containing:
   - `access`
   - `refresh`
   - `expires`
   - `authMode`
   - `region`
   - `oidcRegion`
   - optional `startUrl`
   - `clientId`
   - `clientSecret`
   - optional `profileArn`
8. Make the code testable with mocked `fetch` and callback functions.

### Constraints

- Do not implement model discovery in this task.
- Do not implement refresh logic in this task beyond storing what refresh will need.
- Keep login logic separate from provider registration plumbing where possible.

### Required test coverage

- Builder ID flow prompts only for region.
- Identity Center flow prompts for Start URL and region.
- `callbacks.onAuth(...)` receives the expected browser URL.
- Successful token exchange returns the full credential payload.
- Invalid token response surfaces a clear error.

### Required quality commands

- `npm run typecheck`
- `npm run test -- test/oauth-login.test.ts`
- `npm run lint`

### Done when

- The provider exposes a working OAuth config.
- The login flow logic is well-covered by tests.
- Tests and lint pass.

---

## Task 5 — Implement token refresh for stored Kiro credentials

### Goal

Add refresh-token support for both Builder ID and Identity Center credentials.

### Why this task exists

Without refresh, login works once and then degrades. Refresh is a core provider capability, not an enhancement.

### Read first

- `docs/plans/2026-04-20-kiro-provider-extension-design.md`
- `/tmp/opencode-kiro-auth/src/plugin/token.ts`
- `/tmp/opencode-kiro-auth/src/kiro/auth.ts`
- `/opt/homebrew/lib/node_modules/@mariozechner/pi-coding-agent/docs/custom-provider.md`

### Depends on

- Task 4

### Deliverables

Create or update:

- `extensions/kiro/refresh.ts`
- `extensions/kiro/index.ts`
- `test/refresh.test.ts`

### Requirements

1. Implement a refresh function that accepts stored Kiro credentials.
2. Route refresh by `authMode`.
3. Preserve all provider-specific metadata in the returned credential object.
4. Apply a small expiry buffer so tokens refresh before hard expiry.
5. Surface clear errors when:
   - refresh token is invalid
   - required client credentials are missing
   - the network call fails
6. Wire the refresh function into the provider OAuth config.

### Constraints

- Keep refresh logic separate from login logic.
- Do not add silent retries beyond what is necessary for correctness.

### Required test coverage

- Builder ID refresh request is built correctly.
- Identity Center refresh request is built correctly.
- Returned credentials preserve metadata fields.
- Missing `clientId` or `clientSecret` for Identity Center yields a clear error.
- Expiry handling uses a safety buffer.

### Required quality commands

- `npm run typecheck`
- `npm run test -- test/refresh.test.ts`
- `npm run lint`

### Done when

- Refresh is wired into the provider.
- Tests cover both auth modes and the main failure cases.
- Tests and lint pass.

---

## Task 6 — Register the `kiro` provider with fallback models only

### Goal

Create the first usable provider registration path in pi, backed only by fallback models.

### Why this task exists

This task establishes the basic provider contract before live discovery and custom streaming are added.

### Read first

- `docs/plans/2026-04-20-kiro-provider-extension-design.md`
- `/opt/homebrew/lib/node_modules/@mariozechner/pi-coding-agent/docs/custom-provider.md`
- `/opt/homebrew/lib/node_modules/@mariozechner/pi-coding-agent/examples/extensions/custom-provider-qwen-cli/index.ts`

### Depends on

- Task 5

### Deliverables

Create or update:

- `extensions/kiro/index.ts`
- `extensions/kiro/models.ts`
- `test/provider-registration.test.ts`

### Requirements

1. Register provider name `kiro`.
2. Use the fallback model catalog to populate initial provider models.
3. Ensure the provider is defined even before live discovery exists.
4. Expose OAuth login and refresh in the provider config.
5. Leave `streamSimple` as a stub or minimal placeholder for now, but keep the provider shape valid.

### Constraints

- No live model discovery in this task.
- No real inference in this task.
- The test can use a mocked `ExtensionAPI` surface rather than invoking pi itself.

### Required test coverage

- Provider name is `kiro`.
- Registered models equal normalized fallback models.
- OAuth config is present.
- Provider registration does not throw when the extension loads.

### Required quality commands

- `npm run typecheck`
- `npm run test -- test/provider-registration.test.ts`
- `npm run lint`

### Done when

- The extension can register `kiro` successfully.
- Tests and lint pass.

---

## Task 7 — Implement live model discovery and fallback merge behavior

### Goal

Add dynamic model discovery with graceful fallback behavior.

### Why this task exists

The user explicitly wants the extension to surface model changes over time. Static models are not enough.

### Read first

- `docs/plans/2026-04-20-kiro-provider-extension-design.md`
- `/tmp/opencode-kiro-auth/README.md`
- `/tmp/opencode-kiro-auth/src/constants.ts`
- `/opt/homebrew/lib/node_modules/@mariozechner/pi-coding-agent/docs/extensions.md`
- `/opt/homebrew/lib/node_modules/@mariozechner/pi-coding-agent/docs/custom-provider.md`

### Depends on

- Task 6

### Deliverables

Create or update:

- `extensions/kiro/models.ts`
- `extensions/kiro/index.ts`
- `test/model-discovery.test.ts`

### Requirements

1. Implement a discovery function that attempts to fetch current Kiro/Q models with authenticated credentials.
2. Normalize discovered models into pi provider model config.
3. Merge discovery results with the fallback catalog.
4. Prefer live-discovered entries over fallback entries when IDs match.
5. If discovery fails, return fallback models without throwing provider registration away.
6. Update the provider's registered models after login and on extension startup when credentials exist.

### Constraints

- Keep discovery logic isolated from provider registration.
- If there is no stable discovery API yet, design the module so the fetch layer can change later without touching normalization.
- Do not block login success on discovery success.

### Required test coverage

- Successful discovery returns normalized live models.
- Discovery failure falls back cleanly.
- Duplicate IDs prefer live data.
- Provider update path uses merged models.

### Required quality commands

- `npm run typecheck`
- `npm run test -- test/model-discovery.test.ts`
- `npm run lint`

### Done when

- Dynamic discovery exists.
- Fallback behavior is tested.
- Tests and lint pass.

---

## Task 8 — Build the pure request adapter from pi context to Kiro/Q request payloads

### Goal

Implement a pure adapter that converts pi conversation state into Kiro/Q request payloads.

### Why this task exists

The request transformation is one of the most fragile parts of the project. It should be isolated, deterministic, and heavily tested before being used in real streaming calls.

### Read first

- `docs/plans/2026-04-20-kiro-provider-extension-design.md`
- `/tmp/opencode-kiro-auth/src/plugin/request.ts`
- `/opt/homebrew/lib/node_modules/@mariozechner/pi-coding-agent/docs/custom-provider.md`

### Depends on

- Task 7

### Deliverables

Create or update:

- `extensions/kiro/request.ts`
- `extensions/kiro/types.ts`
- `test/request-adapter.test.ts`

### Requirements

Implement pure helpers for:

1. system prompt handling
2. message history conversion
3. user message conversion
4. assistant message conversion
5. tool definition conversion
6. tool result conversion
7. image attachment conversion if supported
8. thinking-level mapping from pi levels to Kiro/Q config
9. endpoint selection based on stored region and optional `profileArn`

Return a structured intermediate result or final request payload that can be passed to the transport layer later.

### Constraints

- No network I/O.
- Keep input and output types explicit.
- If a feature is uncertain, fail clearly instead of guessing.

### Required test coverage

- Simple text conversation converts correctly.
- Tool definitions convert correctly.
- Tool result messages convert correctly.
- Thinking level maps to expected request fields.
- Region and `profileArn` influence the generated request as expected.

### Required quality commands

- `npm run typecheck`
- `npm run test -- test/request-adapter.test.ts`
- `npm run lint`

### Done when

- The request adapter is pure and testable.
- Tests cover normal message, tool, and thinking cases.
- Tests and lint pass.

---

## Task 9 — Build the pure streaming event adapter for text and thinking

### Goal

Implement a pure adapter that converts Kiro/Q stream events into pi assistant stream events for text and thinking.

### Why this task exists

Streaming is the other fragile half of the provider. Start with text and thinking only so the parser and event mapping are easy to verify.

### Read first

- `docs/plans/2026-04-20-kiro-provider-extension-design.md`
- `/tmp/opencode-kiro-auth/src/plugin/streaming/sdk-stream-transformer.ts`
- `/opt/homebrew/lib/node_modules/@mariozechner/pi-coding-agent/docs/custom-provider.md`

### Depends on

- Task 8

### Deliverables

Create or update:

- `extensions/kiro/stream.ts`
- `test/stream-text-thinking.test.ts`

### Requirements

1. Implement an adapter that accepts raw Kiro/Q stream events or chunks.
2. Emit pi-style assistant events for:
   - start
   - text start, delta, end
   - thinking start, delta, end
   - done or error
3. Track stop reason.
4. Track or derive usage when possible.
5. Keep the parser logic pure and testable without live network calls.

### Constraints

- Do not implement tool calls in this task.
- Avoid coupling the parser to the AWS transport client.
- Prefer small composable functions over one large parser.

### Required test coverage

- Plain text stream emits correct event order.
- Thinking stream emits correct event order.
- Mixed text and thinking blocks are reconstructed correctly.
- Error or abort state produces correct terminal event.

### Required quality commands

- `npm run typecheck`
- `npm run test -- test/stream-text-thinking.test.ts`
- `npm run lint`

### Done when

- The text and thinking stream adapter works in isolation.
- Tests and lint pass.

---

## Task 10 — Wire real `streamSimple` transport for end-to-end text inference

### Goal

Connect the provider to the real Kiro/Q transport path for end-to-end text streaming.

### Why this task exists

At this point the project has scaffolding, auth, refresh, models, request conversion, and stream conversion. This task turns those pieces into a working text-only provider path.

### Read first

- `docs/plans/2026-04-20-kiro-provider-extension-design.md`
- `/tmp/opencode-kiro-auth/src/core/request/request-handler.ts`
- `/tmp/opencode-kiro-auth/src/plugin/request.ts`
- `/opt/homebrew/lib/node_modules/@mariozechner/pi-coding-agent/examples/extensions/custom-provider-gitlab-duo/index.ts`

### Depends on

- Task 9

### Deliverables

Create or update:

- `extensions/kiro/index.ts`
- `extensions/kiro/request.ts`
- `extensions/kiro/stream.ts`
- `test/stream-simple-text.test.ts`

### Requirements

1. Implement the provider's `streamSimple` function.
2. Use stored credentials to authenticate requests.
3. Use the request adapter to build payloads.
4. Send requests to the regional Kiro/Q endpoint or SDK client.
5. Use the stream adapter to emit pi events.
6. Support simple text prompts end to end.
7. Respect abort signals.

### Constraints

- Text-only end-to-end support is enough in this task.
- Do not add tool calls yet.
- Prefer the official AWS client if it makes the transport cleaner, but keep the provider's interface stable.

### Required test coverage

- Transport layer can be exercised with mocked network or mocked SDK stream events.
- `streamSimple` emits a complete text response flow.
- Abort signal stops the stream cleanly.
- Authentication headers or auth wiring are correct for the chosen transport layer.

### Required quality commands

- `npm run typecheck`
- `npm run test -- test/stream-simple-text.test.ts`
- `npm run lint`

### Done when

- The provider can stream a text-only response through `streamSimple`.
- Tests and lint pass.

---

## Task 11 — Add tool-call support to request and streaming adapters

### Goal

Add tool-call round-trip support so `kiro` models can participate in pi's tool loop.

### Why this task exists

Pi is a coding agent. Without tool calls, the provider is much less useful.

### Read first

- `docs/plans/2026-04-20-kiro-provider-extension-design.md`
- `/tmp/opencode-kiro-auth/src/plugin/request.ts`
- `/tmp/opencode-kiro-auth/src/plugin/streaming/sdk-stream-transformer.ts`
- `/opt/homebrew/lib/node_modules/@mariozechner/pi-coding-agent/docs/custom-provider.md`

### Depends on

- Task 10

### Deliverables

Create or update:

- `extensions/kiro/request.ts`
- `extensions/kiro/stream.ts`
- `extensions/kiro/index.ts`
- `test/tool-calls.test.ts`

### Requirements

1. Convert pi tool definitions into the Kiro/Q tool schema.
2. Convert tool results back into Kiro/Q follow-up request shape.
3. Normalize replayed message history before request building.
   - skip errored or aborted assistant turns
   - preserve tool-call and tool-result adjacency
   - synthesize missing tool results for orphaned tool calls when replay requires it
4. Aggregate consecutive tool results into one Kiro follow-up user-input message.
5. Apply request-size budgeting before transport.
   - truncate oversized tool-result text conservatively
   - cap serialized replay history size
   - prune oldest replay history until the final payload fits a conservative Kiro body-size budget
6. Parse Kiro/Q tool use events into pi tool-call events.
7. Emit tool call start, delta, and end correctly.
8. Preserve tool call IDs and arguments.
9. Handle malformed partial JSON safely.

### Constraints

- Keep the tool-call parser robust under partial or chunked input.
- Do not silently drop malformed tool calls.
- If a provider edge case is unsupported, fail clearly.

### Required test coverage

- Tool definitions convert correctly.
- A streamed tool call becomes a valid pi tool call.
- Partial tool-call JSON is accumulated correctly.
- Tool result follow-up requests convert correctly.
- Consecutive tool results are aggregated into one Kiro follow-up request.
- Orphaned tool calls are normalized into synthetic tool results before replay.
- Oversized tool results are truncated safely.
- Oversized replay history is pruned until the final payload fits the size budget.

### Required quality commands

- `npm run typecheck`
- `npm run test -- test/tool-calls.test.ts`
- `npm run lint`

### Done when

- Tool-call round trips are supported.
- Multi-tool follow-up turns serialize into valid Kiro `conversationState`.
- Replay normalization handles missing tool results without producing malformed history.
- Tests and lint pass.

### Implementation note — 2026-04-21

The first version of the Kiro request adapter treated each tool result as its own Kiro user message and inserted synthetic continuation assistant messages between them. That shape was too loose for Kiro's `generateAssistantResponse` API and produced `HTTP 400 {"message":"Improperly formed request."}` in multi-tool sessions.

The refactor on `refactor/kiro-request-normalization` changed the adapter to follow pi's provider patterns more closely:

- normalize replayed messages before request building
- skip errored or aborted assistant turns
- synthesize missing tool results for orphaned tool calls
- aggregate consecutive tool results into one Kiro current message
- align current tool results with tool uses already present in history
- keep placeholder tool definitions for tool names seen in history

A second hardening pass addressed Kiro's request-body limit after real sessions started failing with `CONTENT_LENGTH_EXCEEDS_THRESHOLD`. That pass added:

- conservative truncation for oversized tool-result text
- replay-history pruning by serialized size
- final payload fitting so the adapter drops oldest replay history before transport instead of letting Kiro reject the request

Regression coverage was added for multi-tool follow-up turns, orphaned-tool replay, oversized tool results, and oversized replay history.

---

## Task 12 — Enterprise error handling, `profileArn` config, and user-facing docs

### Goal

Harden the extension for real users by improving enterprise error paths and documenting how to use and configure the provider.

### Why this task exists

V1 intentionally omits `kiro-cli` sync. That makes error clarity and setup documentation critical, especially for IAM Identity Center users who may need `profileArn`.

### Read first

- `docs/plans/2026-04-20-kiro-provider-extension-design.md`
- `/tmp/opencode-kiro-auth/README.md`
- `/tmp/opencode-kiro-auth/src/core/auth/idc-auth-method.ts`
- `/opt/homebrew/lib/node_modules/@mariozechner/pi-coding-agent/docs/packages.md`

### Depends on

- Task 11

### Deliverables

Create or update:

- `README.md`
- `extensions/kiro/types.ts`
- `extensions/kiro/auth.ts`
- `extensions/kiro/refresh.ts`
- `extensions/kiro/index.ts`
- `test/errors-and-config.test.ts`

### Requirements

1. Define how `profileArn` can be supplied in v1.
   - environment variable, config file, or both
2. Surface a clear error when enterprise flows appear to require `profileArn` and none is configured.
3. Improve auth and refresh error messages.
4. Document:
   - install and local development
   - `pi -e` usage
   - `/login` flow
   - Builder ID setup
   - Identity Center setup
   - `profileArn` troubleshooting
   - model discovery and fallback behavior
5. Document lint and test commands.

### Constraints

- Do not add `kiro-cli` token import or profile autodiscovery in this task.
- Keep docs direct and practical.

### Required test coverage

- Missing `profileArn` path yields a clear, actionable error.
- Config parsing for `profileArn` works as documented.
- Error messages for auth and refresh failures remain user-readable.

### Required quality commands

- `npm run typecheck`
- `npm run test -- test/errors-and-config.test.ts`
- `npm run lint`

### Done when

- Docs are usable by a new developer.
- Enterprise misconfiguration errors are actionable.
- Tests and lint pass.

---

## Optional follow-up tasks after v1

These are deliberately out of scope for the main plan, but worth tracking.

### Follow-up A — Image support end to end

- add image request conversion
- add tests for image-capable models
- document any limitations

### Follow-up B — Better model discovery heuristics

- improve capability inference for reasoning and image support
- add caching and refresh strategy

### Follow-up C — Session diagnostics and debug logging

- debug flag for raw discovery, request, and response inspection
- redaction of sensitive fields

### Follow-up D — `kiro-cli` profile or token interoperability

- read local Kiro profile data only
- or later import local auth state
- keep that work isolated from v1 auth paths

---

## Final acceptance checklist for the full project

The project is ready when all tasks are complete and these are true:

1. `npm run typecheck` passes
2. `npm run test` passes
3. `npm run lint` passes
4. `pi -e ./extensions/kiro` or equivalent local load path works
5. `pi /login` shows `Kiro`
6. Builder ID login works
7. IAM Identity Center login works
8. Model discovery updates models when available
9. Fallback models remain usable when discovery fails
10. Text inference streams correctly
11. Tool calls work
12. Enterprise users get clear guidance when `profileArn` is required
