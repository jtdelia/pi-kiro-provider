# pi-kiro-provider

A Kiro provider extension for [pi](https://github.com/badlogic/pi-mono).

It adds a `kiro` provider to pi, integrates with `/login`, supports AWS Builder ID and IAM Identity Center, refreshes tokens, discovers models when it can, and falls back to a bundled model catalog when discovery is unavailable.

> This is an unofficial community extension. It is not affiliated with or endorsed by AWS or the Kiro team.

## Features

- Adds a `kiro` provider to pi
- Works with `pi /login`
- Supports two auth flows:
  - AWS Builder ID
  - IAM Identity Center
- Refreshes stored credentials automatically
- Discovers live models when credentials are available
- Falls back to bundled models when discovery fails
- Streams text responses through a custom pi provider adapter
- Supports tool calls
- Supports manual `profileArn` configuration for enterprise IAM Identity Center setups

## Install

Install directly from GitHub with pi:

```bash
pi install git:github.com/jtdelia/pi-kiro-provider
```

You can also try it for one session without installing it permanently:

```bash
pi -e git:github.com/jtdelia/pi-kiro-provider
```

## Quick start

1. Install the package.
2. Start pi.
3. Run `/login`.
4. Select `Kiro`.
5. Choose one of these auth modes:
   - `Builder ID`
   - `IAM Identity Center`
6. Complete the browser-based AWS device flow.
7. Open `/model` and select a `kiro/*` model.

pi stores the Kiro OAuth credentials in `~/.pi/agent/auth.json`.

## Authentication

### Builder ID

Use Builder ID if you sign in with AWS Builder ID instead of an organization-specific IAM Identity Center portal.

Flow:

1. Run `/login`.
2. Select `Kiro`.
3. Choose `Builder ID`.
4. Enter the AWS region for sign-in. If you are unsure, start with `us-east-1`.
5. pi opens the AWS verification URL.
6. Complete sign-in in the browser.

### IAM Identity Center

Use IAM Identity Center if your organization gives you an AWS Start URL such as:

```text
https://your-company.awsapps.com/start
```

Flow:

1. Run `/login`.
2. Select `Kiro`.
3. Choose `IAM Identity Center`.
4. Enter your Start URL.
5. Enter the AWS region for sign-in.
6. pi opens your organization's AWS device page.
7. Complete sign-in in the browser.

## Enterprise `profileArn` setup

Some IAM Identity Center environments need a `profileArn` for Q Developer or CodeWhisperer-backed requests.

This extension supports two manual configuration paths.

### Option 1: environment variable

```bash
export KIRO_PROFILE_ARN='arn:aws:codewhisperer:us-east-1:123456789012:profile/QDevProfile-us-east-1'
```

### Option 2: pi config file

Create `~/.pi/agent/kiro.json`:

```json
{
  "profileArn": "arn:aws:codewhisperer:us-east-1:123456789012:profile/QDevProfile-us-east-1"
}
```

Notes:

- If both are set before login, `KIRO_PROFILE_ARN` wins.
- The resolved `profileArn` is stored with the Kiro OAuth credential after a successful login.
- v1 does not auto-discover `profileArn` from `kiro-cli`.

## Model discovery and fallback behavior

The provider uses a two-layer model strategy:

1. Try live discovery with your authenticated Kiro credentials.
2. Fall back to a bundled catalog if discovery fails.

That means:

- login does not depend on model discovery succeeding
- provider registration still works when discovery fails
- the extension remains usable when the live catalog is unavailable

The bundled catalog currently includes validated fallback entries across several model families, including Claude, MiniMax, GLM, and Qwen.

## Troubleshooting

### "No stored Kiro credentials found"

Run `/login` again and complete the Kiro sign-in flow.

### Missing `profileArn`

If an IAM Identity Center account requires `profileArn`, requests may fail with errors such as:

- `403 AccessDeniedException`
- `not authorized`
- messages that mention Q Developer, CodeWhisperer, or `profileArn`

Fix:

1. Set `KIRO_PROFILE_ARN`, or add `profileArn` to `~/.pi/agent/kiro.json`.
2. Run `/login` again.
3. Retry the request.

### Model discovery fails

The extension falls back automatically to bundled models. You should still be able to use the provider.

## Local development

Clone the repo and install dependencies:

```bash
git clone https://github.com/jtdelia/pi-kiro-provider.git
cd pi-kiro-provider
npm install
```

Run the checks:

```bash
npm run typecheck
npm run test
npm run lint
```

Load the local extension in pi:

```bash
pi -e .
```

pi reads the `pi` manifest from `package.json` and loads `./extensions/kiro.ts`.

## Repository layout

```text
extensions/
  kiro.ts
  kiro/
    auth.ts
    fallback-models.ts
    index.ts
    models.ts
    refresh.ts
    request.ts
    stream.ts
    types.ts
test/
```

## Test status

Current coverage includes:

- provider registration
- Builder ID and IAM Identity Center login flows
- token refresh helpers
- model discovery and fallback behavior
- request adaptation
- text streaming and thinking events
- tool-call handling
- enterprise config and error paths
