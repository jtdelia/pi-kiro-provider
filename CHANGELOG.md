# Changelog

## [Unreleased]

### Fixed

- Send image turns over the Kiro CLI request contract, including `envState`, CLI origin, and the `reasoningContent` round trip needed for tool-call turns.
- Map `process.platform` to a Kiro-accepted `envState.operatingSystem` (`linux`, `macos`, `windows`) and omit the field for unrecognized platforms. macOS previously sent `darwin`, which the runtime rejected with HTTP 400 `REQUEST_BODY_INVALID`.
- Discover `profileArn` via `ListAvailableProfiles` when a CLI-mode request needs one and none is configured, caching it per access token. Identity Center logins do not return a profile ARN, which failed with HTTP 400 `profileArn is required for this request.`
- Treat HTTP 400 as a missing-`profileArn` signal so the actionable configuration message is surfaced instead of an opaque validation error.
- Quote optional scope arguments in `swap-pi-kiro-provider.sh` so it runs under `set -u` with no scope flags.

## [0.1.3] - 2026-08-18

### Fixed

- Preserve base64 image data in Kiro request payloads instead of serializing decoded bytes as typed-array objects.
- Forward images returned by tools alongside their text results.
- Normalize supported image formats and preserve current-turn image attachments while removing historical images.

## [0.1.2] - 2026-08-01

### Fixed

- Route AWS Builder ID token refresh through the regional AWS OIDC endpoint instead of the Kiro desktop refresh endpoint.
- Include the registered client credentials and OAuth refresh grant in Builder ID refresh requests.
- Add regression coverage for the Builder ID refresh request contract.

## [0.1.1]

- Added Kiro provider support for pi, including OAuth login, model discovery, streaming, tool calls, token usage persistence, and request sizing safeguards.

## [0.1.0]

- Initial release.
