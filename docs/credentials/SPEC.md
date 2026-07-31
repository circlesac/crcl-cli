# Circles credential-provider contract v2

This document is the normative v2 credential contract for Circles clients. The
language-neutral executable cases in [`v1/`](./v1/) remain the compatibility
baseline, and the cases in [`v2/`](./v2/) define the current-profile extension.
A
client sends the resolved value as `Authorization: Bearer <value>` and must not
put a credential in command-line arguments, logs, diagnostics, metadata, or
errors.

## Provider interface

Providers are asynchronous:

```ts
interface CirclesCredentialProvider {
  resolve(): Promise<CirclesCredential>
}

interface CirclesCredential {
  value: string
  kind: "jwt" | "api_key"
  expiresAt?: Date
  source:
    | { type: "explicit" }
    | { type: "environment" }
    | { type: "profile"; profile: string }
}
```

The equivalent Go method is context-aware:

```go
Resolve(context.Context) (Credential, error)
```

The official shared providers additionally expose asynchronous current-profile
management: `getSelectedProfileName()`, `getCurrentProfile()`, and
`setCurrentProfile(profile)`. Go exposes the equivalent context-aware
`SelectedProfileName`, `CurrentProfile`, and `SetCurrentProfile` methods.

The official implementations are:

- Node/Bun: [`@circlesac/credentials`](https://www.npmjs.com/package/@circlesac/credentials)
  ([source](https://github.com/circlesac/api/tree/main/packages/credentials))
- Go: [`github.com/circlesac/credentials-go`](https://github.com/circlesac/credentials-go),
  imported with package name `credentials`

`value` is the only secret field. `source`, `kind`, `expiresAt`, profile names,
file paths, and endpoint/default-context settings are non-secret diagnostics.
A syntactically valid three-segment JWT is `jwt`; every other valid opaque
Bearer value is `api_key`. For a JWT, `expiresAt` is derived from a numeric
`exp` claim when present. Classification does not verify the JWT signature;
the receiving Circles service remains responsible for authentication.

## Resolution order

A provider evaluates exactly this order and stops at the first applicable
source:

1. An in-memory credential or provider explicitly supplied by the caller.
2. A named profile explicitly supplied by the caller.
3. `CIRCLES_AUTH_TOKEN`, then the compatibility alias `CRCL_AUTH_TOKEN`.
4. A profile named by `CIRCLES_PROFILE`, then the compatibility alias
   `CRCL_PROFILE`.
5. The profile named by the shared `current_profile` setting.
6. The legacy `default` profile.

Canonical variables win when both canonical and compatibility names are set.
An explicitly selected or environment-selected profile is terminal: if that
profile is absent or invalid, resolution fails instead of silently falling
through to another identity. An empty selected variable is invalid. Explicit
profile selection outranks an environment token; otherwise an environment
token outranks an environment-selected profile.

Environment credentials are read in memory and are never persisted. Circles
clients must not accept credential values as command-line arguments.

An existing `current_profile` selection is terminal: a missing or invalid
target fails instead of silently changing identity. When the setting is absent,
clients fall back to the legacy `default` profile. Explicit and environment
selection continue to outrank the shared current profile.

## Shared files and profile grammar

The platform-independent defaults are:

- config: `~/.crcl/config`
- credentials: `~/.crcl/credentials`

`CIRCLES_CONFIG_FILE` and `CIRCLES_SHARED_CREDENTIALS_FILE` replace those paths
independently. `~` means the operating-system home directory, not the XDG
configuration directory.

Both files are UTF-8 INI files with named sections. Profile names contain only
ASCII letters, digits, `.`, `_`, `-`, `+`, `@`, and `:`. `__circles__` is a
reserved config metadata section and cannot be selected as a credential
profile.

```ini
# ~/.crcl/config: no secrets
[__circles__]
current_profile = prod:yg@melten.ai

[default]
api_url = https://api.circles.ac
auth_url = https://auth.circles.ac
org = example

[prod:yg@melten.ai]
api_url = https://api.circles.ac
auth_url = https://auth.circles.ac
org = melten

# ~/.crcl/credentials: secrets only
[default]
access_token = eyJ...
refresh_token = ...

[automation]
api_key = ...
```

`current_profile` contains only a profile name. Writers persist it in the
config file with the same lock and atomic replacement used for credential
updates. Setting it requires an existing target profile. Deleting the selected
profile clears the pointer; deleting another profile leaves it unchanged.

`config` may contain `api_url`, `auth_url`, and `org`. These are endpoint and
default-context settings, not authorization claims. A client may use endpoint
overrides for a development profile, but must derive the authenticated owner
and organization from the credential and server authorization checks; request
parameters never replace that authenticated identity.

`credentials` may contain either `api_key`, or `access_token` with an optional
`refresh_token`. A refresh-only OAuth profile is also accepted so an access
token can be recovered. A profile containing `api_key` together with either
OAuth field is ambiguous and must fail.

Where POSIX permissions are supported, writers create/chmod every containing
directory to `0700` and the credentials file to `0600`. Writes use a temporary
file in the destination directory followed by an atomic rename. The reference
implementation also writes the config file as `0600` because it can identify
local profiles even though it contains no secrets.

## Interactive profile provisioning

After OAuth succeeds, an interactive client obtains the authenticated email
from the Circles user endpoint, trims it, and ASCII-lowercases it. Unless the
caller explicitly supplied a profile name through an API, CLI option, or
profile environment variable, the profile name combines the Circles OAuth
environment with that verified email: `prod:<email>` for
`https://auth.circles.ac` and `dev:<email>` for
`https://auth-dev.circles.ac`. The client persists the exact `api_url` and
`auth_url`, even for production, then persists the profile and marks it
current. It never copies access or refresh tokens into `default` merely to
preserve implicit selection.

Automatic naming is available only when both endpoints are a matching official
production or development pair. A custom or mixed endpoint pair requires an
explicit profile name. This keeps the authenticated OAuth server visible and
prevents the same email on production and development from overwriting itself.

Logging in again with the same environment and email updates that profile.
Changing either the environment or email creates or updates another profile
and makes it current.
Explicit profile names remain supported for development endpoints and backward
compatibility. An email inferred only from an unverified local token is not
sufficient for automatic naming.

## Refresh and concurrent writers

Before returning a profile JWT, a provider refreshes it when its numeric `exp`
claim is expired. It sends a form-encoded refresh request directly to
`<auth_url>/token` with `grant_type=refresh_token`, `client_id=circles-api`, and
the stored refresh token. `auth_url` defaults to `https://auth.circles.ac`.
The `crcl` executable is not involved.

The provider serializes refreshes with a cross-process lock beside the
credentials file. After acquiring the lock it rereads the profile. If another
process already rotated the refresh token, the waiter uses the newer stored
pair and never writes its older pair. A successful response persists both the
access token and the returned (or still-current) refresh token in one atomic
credentials-file replacement. Network errors, non-success responses, invalid
responses, missing refresh tokens, lock timeouts, and failed persistence are
reported with stable error codes and never include token values.

## Legacy migration

On first access, the provider imports profiles from
`$XDG_CONFIG_HOME/crcl/config` and `$XDG_CONFIG_HOME/crcl/credentials`, falling
back to `~/.config/crcl/` when `XDG_CONFIG_HOME` is unset. The older
`config.json` account format in the same directory is also recognized for
`crcl` compatibility.

Migration is per profile and idempotent. If either canonical file already has
a section for a profile, that canonical profile wins and no legacy fields for
that profile are copied. Otherwise its non-secret fields go to `config` and
its secrets go to `credentials`. Multiple profiles are migrated in one pass.
The reference implementation records processed profile names in a non-secret
`credentials.migrated` marker so an explicit logout/delete is not undone by a
later process. Legacy files are retained unchanged for rollback; automatic
migration never deletes them.

## Stable errors

Clients branch on `CirclesCredentialError.code`, never on message text:

| Code | Meaning |
| --- | --- |
| `CREDENTIAL_NOT_FOUND` | No credential exists at the selected source. |
| `INVALID_CREDENTIAL` | A value, profile name, file, or token response is invalid. |
| `AMBIGUOUS_CREDENTIAL` | A profile contains both OAuth and API-key forms. |
| `REFRESH_FAILED` | An expired/rejected credential could not be refreshed. |
| `PROFILE_CONFLICT` | Duplicate profile/key data makes the selected profile non-deterministic. |
| `CREDENTIAL_STORAGE_FAILED` | Secure read, lock, permission, or atomic persistence failed. |

Errors may identify the source category or profile name, but must not contain
credential values, refresh responses, request bodies, or authorization
headers. When no source resolves, clients should tell the user to set
`CIRCLES_AUTH_TOKEN` or provision a profile (for example with `crcl login`).
