# Kiro request/input size limits

Research snapshot: upstream `mikeyobrien/pi-provider-kiro` at [`c329e3d`](https://github.com/mikeyobrien/pi-provider-kiro/commit/c329e3d25cada71d331a71709931de82436ef855) (`2026-07-30`). Local paths refer to this repository.

## Upstream findings

| Area | Evidence | Finding / confidence |
|---|---|---|
| History budget | [`src/history.ts#L5-L7`](https://github.com/mikeyobrien/pi-provider-kiro/blob/c329e3d25cada71d331a71709931de82436ef855/src/history.ts#L5-L7) | `HISTORY_LIMIT = 850000`, calibrated for `HISTORY_LIMIT_CONTEXT_WINDOW = 200000` tokens. **High**: explicit constants. |
| Model scaling | [`src/stream.ts#L311-L312`](https://github.com/mikeyobrien/pi-provider-kiro/blob/c329e3d25cada71d331a71709931de82436ef855/src/stream.ts#L311-L312) | Effective history limit is `floor(model.contextWindow / 200000 * 850000)`. A 1M-token model therefore gets 4,250,000 serialized-history characters by this formula. **High**. |
| Enforcement | [`src/history.ts#L78-L86`](https://github.com/mikeyobrien/pi-provider-kiro/blob/c329e3d25cada71d331a71709931de82436ef855/src/history.ts#L78-L86), [`af00ba5`](https://github.com/mikeyobrien/pi-provider-kiro/commit/af00ba5dd19ed9ca3995e863c5cd84425ea8953e) | Upstream serializes history with `JSON.stringify(history).length` and fails closed with `context_length_exceeded`; it no longer silently drops old history. The fail-closed change replaced an older truncating loop. **High**. |
| History image handling | [`src/history.ts#L9-L17`](https://github.com/mikeyobrien/pi-provider-kiro/blob/c329e3d25cada71d331a71709931de82436ef855/src/history.ts#L9-L17) | Images are removed from historical user messages before sizing/sending because they are considered already processed and can cause 413s. Current-turn images are retained. **High** for behavior; the 413 relationship is the upstream comment’s explanation, not an independently documented service limit. |
| Tool-result limit | [`src/transform.ts#L47-L68`](https://github.com/mikeyobrien/pi-provider-kiro/blob/c329e3d25cada71d331a71709931de82436ef855/src/transform.ts#L47-L68), [`src/transform.ts#L177-L205`](https://github.com/mikeyobrien/pi-provider-kiro/blob/c329e3d25cada71d331a71709931de82436ef855/src/transform.ts#L177-L205) | Each tool-result text is middle-truncated at `TOOL_RESULT_LIMIT = 250000`. This is a per-result text limit, not a whole-request limit; multiple results and metadata can exceed the history budget. **High**. |
| Truncation semantics | [`src/transform.ts#L64-L68`](https://github.com/mikeyobrien/pi-provider-kiro/blob/c329e3d25cada71d331a71709931de82436ef855/src/transform.ts#L64-L68) | Uses JavaScript `string.length`/`substring`; keeps both ends and inserts `\n... [TRUNCATED] ...\n`. **High**. |
| Current message | [`src/stream.ts#L398-L425`](https://github.com/mikeyobrien/pi-provider-kiro/blob/c329e3d25cada71d331a71709931de82436ef855/src/stream.ts#L398-L425) | No general maximum for current text is defined. Empty current content is replaced with `Please proceed with the task.`. Tool results in the current turn use the same 250,000-per-result limit. **High**. |
| Explicit response/request limits | [`src/retry.ts#L38-L53`](https://github.com/mikeyobrien/pi-provider-kiro/blob/c329e3d25cada71d331a71709931de82436ef855/src/retry.ts#L38-L53) | Size-related response markers are HTTP 413, HTTP 400 with `CONTENT_LENGTH_EXCEEDS_THRESHOLD`, or HTTP 400 containing `Input is too long`. **High**. No upstream source evidence found for a numeric service-side byte limit. |
| Error handling | [`src/stream.ts#L540-L550`](https://github.com/mikeyobrien/pi-provider-kiro/blob/c329e3d25cada71d331a71709931de82436ef855/src/stream.ts#L540-L550), [`354b60b`](https://github.com/mikeyobrien/pi-provider-kiro/commit/354b60b23851700f1e946be61043f8f2171164bd) | Matching size errors are surfaced as `context_length_exceeded`, allowing the host to compact/retry. `Improperly formed request.` / `REQUEST_BODY_INVALID` is deliberately *not* treated as a size error because it also occurs for malformed requests of non-size causes. **High**. |
| Token/byte assumptions | [`src/history.ts#L79-L83`](https://github.com/mikeyobrien/pi-provider-kiro/blob/c329e3d25cada71d331a71709931de82436ef855/src/history.ts#L79-L83), [`scripts/test-1m-context.ts`](https://github.com/mikeyobrien/pi-provider-kiro/blob/c329e3d25cada71d331a71709931de82436ef855/scripts/test-1m-context.ts) | Limits are measured as JavaScript serialized-string length, while the calibration is described in model tokens. The diagnostic script only estimates tokens as `chars / 4`; it is not a service contract. No byte-counting or tokenizer-based request fitter was found. **High**. |

Other upstream bounds found in the inspected source—timeouts, retry counts, and output/token accounting—are operational limits, not request-input size limits. The 1M diagnostic uses a 200,000-character test payload estimate and model context metadata, but does not establish a maximum accepted request size.

## Comparison with this repository

Local [`extensions/kiro/request.ts`](../extensions/kiro/request.ts) is more defensive and more lossy before transport:

- Constants at lines 48–53: tool-result text `100,000` chars; current-message text `120,000` chars; serialized history `500,000` chars; serialized pre-`profileArn` payload `650,000` chars.
- `truncateMiddle` at lines 113–125 uses JavaScript `text.length` and preserves both ends. Tool results are truncated at lines 128–130 and again when current-message budgets are applied at lines 632–653.
- `pruneKiroHistoryToSize` at lines 611–630 repeatedly removes the oldest entries while serialized history exceeds 500,000. It preserves structural tool-call/result pairs through `sanitizeKiroHistory`, but can stop above the limit when only two entries remain.
- `fitKiroPayloadToSize` at lines 849–888 first prunes history, then removes additional oldest history while `JSON.stringify(payload).length > 650000`. The final payload returned later at lines 983–993 adds `profileArn`, so the 650,000 check is not literally a bound on the exact transmitted body. `onPayload` at `extensions/kiro/index.ts#L260-L265` can also replace the prepared payload after fitting.
- Images are converted at lines 89–105, but there is no explicit image count/byte budget. Consequently, a large current-turn image or image representation can dominate the final body even if the text/history checks pass.
- The transport serializes the body at `extensions/kiro/request.ts#L1036-L1051`. HTTP errors are currently formatted generically by `buildKiroHttpErrorMessage` at lines 1055–1058; there is no local equivalent of upstream’s `CONTENT_LENGTH_EXCEEDS_THRESHOLD` classification, `context_length_exceeded` normalization, or automatic compaction/retry in this adapter.

## Practical implications

1. **The upstream 850,000 number is not a whole-request byte limit.** It is a local serialized-history character budget calibrated against a 200k-token model. The current upstream implementation fails closed when that history budget is exceeded; it does not prove that Kiro accepts an 850,000-byte request.
2. **The local adapter is substantially more conservative for text** (500k history / 650k partial payload, 100k tool results / 120k current text), but it can still exceed a service byte limit because JavaScript string length is UTF-16 code units and excludes neither UTF-8 expansion nor all JSON/base64/object overhead in the same way as the wire body.
3. **The local adapter may hide genuine overflow from the host.** It drops old history and truncates current text/tool results instead of surfacing `context_length_exceeded`. That is intentional for request survivability but loses context; diagnostics report the truncations/pruned-message count.
4. **Error handling is a material gap.** If Kiro returns HTTP 400 with `CONTENT_LENGTH_EXCEEDS_THRESHOLD` or HTTP 413, the local adapter currently exposes the raw generic HTTP error. It does not give the host a recognized overflow signal. Conversely, adding a broad `Improperly formed request` match would be unsafe, matching upstream’s warning in commit `354b60b`.
5. **Do not infer a numeric byte/token service ceiling from these constants.** The inspected upstream source provides explicit client-side character budgets and error markers, but no authoritative server-side byte limit. Measuring the exact serialized UTF-8 body and recording responses would be required to establish one.

## Evidence gaps / residual risks

- GitHub source and history were inspected, but no public AWS/Kiro API schema specifying a maximum request byte count was found in the upstream repository.
- `JSON.stringify(...).length` is a UTF-16 code-unit count, not `Buffer.byteLength(JSON.stringify(...), "utf8")`; non-ASCII content can therefore consume more wire bytes than the local counters imply.
- The local 650,000 check is performed before `profileArn` is added and before an optional `onPayload` rewrite. It is a fitter budget, not a hard transport-body assertion.
- Image wire-size behavior is not normalized between upstream and local adapters, so text-budget comparisons should not be applied to image-heavy requests without measuring the final body.

Confidence: **high** for claims tied directly to source constants/control flow and cited commits; **medium** for practical service implications; **low/unknown** for any undocumented server-side byte ceiling.

## Image payload comparison (direct repository inspection)

The two requested public repositories were cloned into temporary directories and inspected directly, rather than inferred from this checkout:

- [`mikeyobrien/pi-provider-kiro`](https://github.com/mikeyobrien/pi-provider-kiro), `main` at [`a1b4f44`](https://github.com/mikeyobrien/pi-provider-kiro/commit/a1b4f44d9ba0306e5f07d7fec3a3acf6048de980).
- [`simonsmh/pi-provider-kiro`](https://github.com/simonsmh/pi-provider-kiro/tree/dev-0.9.0), `dev-0.9.0` at [`e4a1203`](https://github.com/simonsmh/pi-provider-kiro/commit/e4a120339e528397516b1a645c4ad7afbd2c2ad5).

Both implementations agree on the important Kiro wire shape:

```ts
interface KiroImage {
  format: string;
  source: { bytes: string };
}
```

Their `convertImagesToKiro` implementations derive `format` from `mimeType` and pass Pi's base64 `data` directly as `source.bytes`; they do not convert it to a `Uint8Array`. Both also collect image blocks from `toolResult` messages and attach the converted images to the surrounding Kiro `userInputMessage.images`. Historical images are stripped before history sizing/sending, while current-turn images are retained. The first repository has explicit regression coverage for conversion, image-only prompts, historical-image stripping, and multi-turn image requests; the second has the corresponding conversion and history/current-image coverage.

This differs materially from the local adapter:

- [`extensions/kiro/types.ts`](../extensions/kiro/types.ts) defines `source.bytes` as `Uint8Array`.
- [`extensions/kiro/request.ts`](../extensions/kiro/request.ts) decodes base64 with `Buffer.from(data, "base64")` before assigning it to `source.bytes`.
- `convertToolResultMessageToKiroToolResult` currently throws `Kiro tool result image attachments are not supported yet.` instead of forwarding those images on the user-input carrier.

That difference is not cosmetic. `JSON.stringify` does not serialize a `Uint8Array` as the base64 string used by the two inspected providers; it serializes a typed-array object representation. If the Kiro endpoint expects the provider convention shown above, the current representation is a likely wire-compatibility defect even for ordinary user images. The tool-result path is an explicit unsupported feature in this checkout, while both comparison repositories implement it.

### Kiro documentation cross-check

The public Kiro CLI documentation at [`kiro.dev/docs/cli/chat/images/`](https://kiro.dev/docs/cli/chat/images/) says that images can be supplied by dragging them into the terminal, by using `read` with Image mode, or by pasting with `/paste`. It documents JPEG/JPG, PNG, GIF, and WebP; a limit of under 10 MB per image; and up to 10 images in a request. These are user-facing CLI limits, not a published `generateAssistantResponse` JSON schema or a guarantee that every model/provider path accepts every format. The page also recommends high-resolution images with clear text and specific instructions.

### Recommendation for the local adapter

When image support is implemented or corrected, align the local request model with the inspected providers first:

1. Change `KiroRequestImage.source.bytes` to the wire-compatible base64 string representation and remove the decode step from the request adapter.
2. Preserve user-message images on the current request and remove them only from historical entries, as the current tests already intend.
3. Collect tool-result image blocks separately from tool-result text, place them on the same Kiro user-input carrier as `images`, and keep the tool-result text/status/ID unchanged.
4. Add focused tests for base64 preservation, exact MIME-derived format, current-vs-historical image behavior, image-only prompts, and tool-result images. Also assert the serialized JSON shape (`source.bytes` is a string), not only the in-memory TypeScript object.
5. Keep image byte/count enforcement separate from the existing text/history fitter. The Kiro docs' 10 MB/10-image limits should be treated as documented CLI guidance; the adapter should measure the final serialized UTF-8 payload and report any local guardrail explicitly.

No runtime files were changed during this research pass. The only repository mutation is this documentation update.
