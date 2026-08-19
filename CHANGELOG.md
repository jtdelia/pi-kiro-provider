# Changelog

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
