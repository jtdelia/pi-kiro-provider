# Plan: make Kiro request sizing reliable and overflow-aware

## Goal

Prevent oversized Kiro requests before transport, preserve the highest-value context when reduction is necessary, and expose confirmed service-side overflows as `context_length_exceeded` so Pi can use its normal compaction/retry path.

This plan is based on the AWS/Amazon Q patterns investigated in `docs/kiro-provider-limits-research.md`: account for all request inputs, apply bounded tool output, compact before losing history where the host supports it, and do not retry an unchanged oversized request. The upstream `pi-provider-kiro` behavior is also relevant: it treats HTTP 413 and specific HTTP 400 size signals as context overflow, while deliberately not treating generic malformed-request errors as overflow.

## Current gaps

- `extensions/kiro/request.ts` uses `JSON.stringify(value).length`, a UTF-16 code-unit count, for the 500k history and 650k payload checks. The actual fetch body is UTF-8 JSON.
- `fitKiroPayloadToSize` measures a partial payload before `profileArn` is added. `options.onPayload` in `extensions/kiro/index.ts` can also replace the already-fitted payload.
- Per-tool-result truncation exists, but multiple results can still dominate a request because there is no aggregate tool-result allocation.
- The fitter only removes history once the payload is too large. If current content, tool schemas, images, or callback changes are too large by themselves, it can still send an oversized request.
- HTTP 413 and known Kiro size validation responses are currently returned as generic HTTP errors, so Pi cannot recognize them as a context overflow.
- The adapter silently prunes history. It has no host-level history-summary/compaction integration.

## Scope and decisions

### In scope for this change

1. Make the serialized **final UTF-8 request body** the single transport-size measurement.
2. Keep a conservative, explicit client-side body guardrail until Kiro publishes a service-side byte limit; use the existing 650,000 value as a starting maximum, but reinterpret it as bytes and rename it accordingly.
3. Add a deterministic reduction order: old history first, then current-turn auxiliary context, while preserving the current user prompt whenever possible.
4. Add an aggregate current-turn tool-result budget in addition to the existing per-result limit.
5. Fail closed with a `context_length_exceeded` error when the final body cannot fit without dropping protected content.
6. Normalize only confirmed service size errors: HTTP 413, HTTP 400 containing `CONTENT_LENGTH_EXCEEDS_THRESHOLD`, and HTTP 400 containing `Input is too long`.
7. Add diagnostics for final byte size and every applied reduction.

### Explicit non-goals for this change

- Do not send multiple requests to chunk one user turn.
- Do not automatically retry after a size error; a retry without changed context will fail again. Pi owns compaction/retry policy.
- Do not classify generic HTTP 400, `REQUEST_BODY_INVALID`, or `Improperly formed request.` as overflow.
- Do not add a tokenizer dependency or claim an undocumented Kiro token/byte ceiling.
- Do not implement model-generated history summarization inside this provider. That requires a host-approved compaction workflow and is planned as follow-up work.

## Implementation steps

### 1. Create a canonical serializer and byte budget API

**Files:** `extensions/kiro/request.ts`, `extensions/kiro/types.ts`

1. Add a single helper that serializes a `KiroRequestPayload` once and returns both the body and its UTF-8 size:
   ```ts
   type KiroSerializedPayload = {
     body: string;
     utf8Bytes: number;
   };

   function serializeKiroPayload(payload: KiroRequestPayload): KiroSerializedPayload {
     const body = JSON.stringify(payload);
     return { body, utf8Bytes: Buffer.byteLength(body, "utf8") };
   }
   ```
   `Buffer.byteLength` is appropriate because this extension runs in Node and `fetch` sends the JSON string as UTF-8.
2. Rename `KIRO_MAX_PAYLOAD_SERIALIZED_CHARS` to `KIRO_MAX_REQUEST_BODY_BYTES`. Retain `650_000` initially, documenting it as a conservative client guardrail rather than a verified service contract.
3. Replace internal `JSON.stringify(...).length` checks that decide request fit with `serializeKiroPayload(...).utf8Bytes`.
4. Keep character-oriented limits only where they describe text truncation behavior (`truncateMiddle` / per-result text caps). Name them `*_CHARS` so units remain unambiguous.
5. Expand `KiroRequestDiagnostics` with at least:
   - `finalPayloadUtf8Bytes`
   - `maxRequestBodyBytes`
   - `aggregateToolResultTruncationCount` or an equivalent count of aggregate reductions
   - `removedHistoricalImageCount`
   - `requestFitsBudget`

**Acceptance criteria**

- A payload containing non-ASCII text reports a larger UTF-8 byte size than its JavaScript `.length` where applicable.
- All request-fit decisions use UTF-8 bytes, not serialized-string length.
- Existing diagnostics remain available or are migrated without leaving stale `finalPayloadChars` semantics behind.

### 2. Fit the complete payload, not a provisional conversation state

**Files:** `extensions/kiro/request.ts`, `extensions/kiro/index.ts`

1. Refactor `fitKiroPayloadToSize` to accept/build the complete `KiroRequestPayload`, including `profileArn`, rather than an intermediate object containing only `conversationState`.
2. Return the fitted payload (or a typed fit result) with its serialized body/byte count, so request construction does not independently serialize a different object.
3. Change `buildKiroTransportRequest` to serialize once through the canonical helper and use that returned `body` as `RequestInit.body`.
4. Because `onPayload` executes after adapter fitting, add a final transport-boundary check after the callback:
   - serialize the callback result;
   - if it exceeds `KIRO_MAX_REQUEST_BODY_BYTES`, throw a local error containing `context_length_exceeded` and the measured byte count;
   - do not attempt provider-side mutation of callback-owned payload data.
5. Return transport diagnostics (or expose a helper) so `index.ts` can log the final byte count after `onPayload`, rather than only the pre-hook adapter measurement.

**Acceptance criteria**

- An extremely long `profileArn` is included in final size enforcement.
- An `onPayload` callback that makes a request oversized fails before `fetch` is called.
- The exact string sent by `fetch` is the string measured by the byte guard.
- A payload at or below the byte cap is sent unchanged.

### 3. Replace history-only fitting with ordered, structure-safe reduction

**Files:** `extensions/kiro/request.ts`, `extensions/kiro/types.ts`

Implement a pure `fitKiroPayloadToSize` pipeline that rebuilds and remeasures the complete payload after every reduction. Apply reductions in this order:

1. **Remove historical images.** Strip `images` from `history[*].userInputMessage`, retaining only current-turn images. Record the count. This mirrors the upstream provider behavior and removes data the model has already processed.
2. **Prune complete oldest history exchanges.** Preserve message validity and tool-use/tool-result pairing using the existing `sanitizeKiroHistory` rules. Drop the oldest valid unit rather than leaving an orphaned assistant/tool-result entry. Continue to retain the latest valid context until removal is necessary.
3. **Apply an aggregate budget to current-turn tool results.** Keep the existing per-result middle truncation, then allocate a new total budget across current-turn tool result text in request order. Once the remaining aggregate budget is exhausted, truncate the next result with the existing marker and make later results marker-only/empty according to the Kiro schema’s validity requirements. Retain each result’s `toolUseId` and status so tool-call alignment remains valid.
4. **Reduce lowest-priority current auxiliary context.** If the body is still too large, remove or reduce optional tool definitions before touching user-authored current text. Preserve placeholder definitions required by retained history tool uses.
5. **Fail closed.** If the full payload still exceeds the byte cap after all permitted reductions, throw a local error containing `context_length_exceeded`; include safe diagnostics (measured bytes, cap, and reduction counts), but never include request contents or credentials.

Keep the existing current user-message middle truncation only as an explicit last-resort behavior if product requirements require request survivability. If retained, document it as lower priority than the user’s latest instructions and add a diagnostic flag. Otherwise, fail closed rather than silently truncating the user’s current prompt.

Do not alter tool-call/result sequencing merely to save bytes. Run `sanitizeKiroHistory` after each history reduction and verify the final history begins at a valid user turn.

**Acceptance criteria**

- Historical images are not present in the final payload; current-turn images remain present.
- Oversized history is reduced before current tool results, tool schemas, or current user text.
- Aggregate tool-result handling keeps valid tool-use IDs, statuses, and required pairing.
- A payload made too large only by protected current content or a current image fails locally with `context_length_exceeded` and never calls `fetch`.
- The final fitted payload is structurally valid and is at or below the byte guardrail whenever adaptation succeeds.

### 4. Make client-side budgets model-aware without conflating them with wire limits

**Files:** `extensions/kiro/types.ts`, `extensions/kiro/index.ts`, `extensions/kiro/request.ts`, model-related tests as needed

1. Pass the selected Pi model’s `contextWindow` from `index.ts` into `KiroRequestAdapterInput` as an optional value.
2. Add a small, documented calculator for the **history/context character allocation**, separate from the request-body byte cap. Base it on the upstream calibration only if it is compatible with this provider’s behavior:
   ```ts
   historyCharacterBudget = floor(contextWindow / 200_000 * 850_000)
   ```
   Use a safe fallback when no `contextWindow` is known.
3. Do not automatically increase the final request-byte guardrail along with model context. The service’s accepted wire-body maximum is undocumented and must remain independently enforced.
4. Keep the calculation isolated behind a helper so telemetry or official service documentation can change the calibration later without rewriting fitting logic.

**Acceptance criteria**

- A model with a larger context window receives a larger *candidate history* allocation, but the final UTF-8 request still cannot exceed the byte cap.
- Missing/invalid context-window metadata uses a documented fallback.
- Tests demonstrate that model context scaling and request-body enforcement are separate concerns.

### 5. Normalize confirmed Kiro overflow responses

**Files:** `extensions/kiro/request.ts`, `extensions/kiro/index.ts`, `test/errors-and-config.test.ts` (or a focused new test file)

1. Add an exported pure classifier, for example:
   ```ts
   function isKiroContextLengthExceededError(input: {
     status: number;
     bodyText: string;
   }): boolean
   ```
2. Return `true` only for:
   - HTTP 413;
   - HTTP 400 whose response body includes `CONTENT_LENGTH_EXCEEDS_THRESHOLD` (case-insensitive);
   - HTTP 400 whose response body includes `Input is too long` (case-insensitive).
3. Update `buildKiroHttpErrorMessage` so classified responses begin with `context_length_exceeded:` and then retain sanitized HTTP status/detail. Preserve the generic existing message for all other responses.
4. Continue running the existing missing-`profileArn` classifier before the size classifier so enterprise configuration errors remain actionable.
5. Do not add an adapter-managed retry. Pi can recognize the overflow marker and decide whether it can compact/retry safely.

**Acceptance criteria**

- 413 produces an error containing `context_length_exceeded`.
- 400 + `CONTENT_LENGTH_EXCEEDS_THRESHOLD` produces the marker.
- 400 + `Input is too long` produces the marker.
- 400 + `REQUEST_BODY_INVALID`, `Improperly formed request.`, and unrelated errors remain generic Kiro HTTP errors.
- Secret redaction remains applied to every error path.

### 6. Improve observability without logging request content

**Files:** `extensions/kiro/types.ts`, `extensions/kiro/index.ts`, `extensions/kiro/request.ts`, `test/logging.test.ts` as needed

1. Update `request_budget_applied` logging to include byte-oriented diagnostics and reduction counters.
2. Log a dedicated `request_budget_exceeded` event before throwing a local fit/transport overflow. Include only numeric measurements, model ID, conversation ID, and reduction categories.
3. On classified server overflow, log status and byte diagnostics if available; do not log response/request bodies beyond the existing sanitized user-facing error mechanism.
4. Ensure diagnostics calculated after `onPayload` identify that the callback result was measured, without recording callback payload content.

**Acceptance criteria**

- Successful reduced requests log final byte size and reductions.
- Local and server-side overflow logs contain no access tokens, refresh tokens, request body text, or tool output.
- Existing redaction tests continue to pass.

## Test plan

### Request-adapter tests (`test/request-adapter.test.ts`)

Add coverage for:

- UTF-8 accounting with emoji/CJK text, proving byte measurement rather than `.length` is used.
- The final byte guard including `profileArn`.
- Historical-image removal while retaining current images.
- Ordered reduction: old history before current tool results; current tool results before optional tool definitions; protected current content results in a local overflow when it alone cannot fit.
- Aggregate tool-result budget across several individually-valid results.
- Valid tool-use/tool-result pairing after history pruning and aggregate tool reduction.
- Optional model context-window history allocation, including fallback behavior.
- Final payload byte size at or under the guardrail for every successful adaptation.

### Stream/transport tests

Add or extend a focused stream/transport test file to cover:

- `onPayload` creating an oversized final payload: no fetch call and an emitted error containing `context_length_exceeded`.
- `buildKiroTransportRequest` sending the canonical serialized body whose `Buffer.byteLength` matches its recorded measurement.
- HTTP 413, HTTP 400 `CONTENT_LENGTH_EXCEEDS_THRESHOLD`, and HTTP 400 `Input is too long` surfacing the overflow marker.
- Generic 400 malformed requests not surfacing the overflow marker.
- Existing profile-ARN error precedence and secret redaction.

### Regression suite

Run:

```sh
npm test -- --runInBand
npm run typecheck
npm run lint
```

If Vitest does not support `--runInBand` in this project, run `npm test` instead. The implementation is complete only when all relevant tests, type checking, and linting pass.

## Rollout and follow-up

1. Land the final-byte guard, ordered reduction, overflow normalization, and diagnostics together so client behavior and observability agree.
2. Treat `650_000` bytes as a conservative client safety value. Use sanitized telemetry from real requests to determine whether it needs adjustment; do not infer a Kiro server limit from client constants.
3. In a separate host-level design, add proactive history compaction:
   - trigger before the model-context allocation is exhausted;
   - ask the model for a structured summary of decisions, constraints, unresolved work, and tool outcomes;
   - replace raw old history only after summary success;
   - require an explicit Pi/user policy decision for automatic versus confirmed compaction.
4. Revisit token calibration when Kiro exposes authoritative per-model input limits or a compatible tokenizer. Keep wire-byte safety enforcement even if token-aware budgeting is added.

## Definition of done

- Every outbound Kiro POST body is measured as final serialized UTF-8 JSON after all hooks.
- A successful request is at or below the configured byte guardrail; an unfit one fails locally with `context_length_exceeded`.
- Reduction is deterministic, preserves message/tool structure, and reports what it removed or truncated.
- Confirmed Kiro size responses are distinguishable from malformed or unrelated HTTP 400 responses.
- No automatic retry, no silent request splitting, and no secret-bearing diagnostics are introduced.
- New targeted tests plus the full typecheck/lint/test suite pass.
