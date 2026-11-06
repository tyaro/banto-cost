# ADR-0020: Keep browser-side image originals, import checks and URL lifetimes in a new optional package, `@banto/image-assets`

> 日本語: [0020-image-assets-package.md](0020-image-assets-package.md)

- Status: Accepted
- Date: 2026-10-21
- Related: Issue #438 / [shared-primitives-upstream-plan.md](../design/shared-primitives-upstream-plan.md) §2.1, §3.7, §5 (PR-12 to 14), D6, D7, D11 /
  [conventions.md](../conventions.en.md) §3, §4, §5, §8, §13, §14 / [template-scope.md](../template-scope.md) §1, §3, §3.1 /
  [ADR-0002](0002-minimal-dependencies.en.md), [ADR-0003](0003-tls-via-reverse-proxy.en.md), [ADR-0018](0018-shared-ui-package.en.md)

## Context

SCADA Designer (temp-scada) has its own way of importing images in the browser and carrying the original
bytes around (`image-assets.ts`: `inspectImage`, `imageHeader`, `sha256`, and `AssetStore` with `put` / `pin` /
`collect` / `importFrom` / `dispose`). Issue #438 proposes moving it back into banto.

Where banto stands (plan §3.7):

- There is no image check on the browser side. The `core/` of `@banto/attachments` only helps the display;
  format detection lives in the server's `banto-attachments` `detect_mime` (magic bytes, conventions §6).
- The only overlap is "the owner revokes the object URL" (conventions §8). Header checks, keeping the
  original, de-duplication by hash and pin / release exist nowhere in banto.
- The temp-scada code hard-codes its limits (8 MiB, 8192 px, 16 million pixels, 256 MiB) and throws
  Japanese messages written into the code.
- `sha256` uses `crypto.subtle.digest`. `crypto.subtle` exists only in a secure context (HTTPS or
  localhost), so it is undefined when banto is served over the LAN (plain HTTP, with TLS terminated at a
  reverse proxy, ADR-0003).

Against the four criteria of template-scope §1, cross-cutting need (1) and irreplaceability (3) were
partial. The owner plans to build a **project-specific SCADA** after the general-purpose one, so a second
consumer that needs the same parts is already decided (D6, 2026-10-21). That covers the partial marks as
"several derived apps need the same part". It carries no factory knowledge (4 = yes).

## Decision

### 1. Create a new optional package, `@banto/image-assets` (`packages/image-assets`)

- Ship it as an **option** (add a row to the template-scope §3 table). Do not wire it into the template
  app (`apps/admin-template`): it is an extension without a bundled demo (template-scope §3.1), like
  `@banto/scan-wedge`.
- `dependencies` / `peerDependencies` stay empty (conventions §4, rule `empty-deps`). Bare imports are
  limited to `svelte`, `svelte/*` and relative paths (conventions §5, rule `package-bare-imports`).
- The work is split into three PRs (plan §5, PR-12 to 14): skeleton (this ADR, the public types, the
  error codes, limit validation), then the import checks and hash, then originals and URL lifetimes.

### 2. The consumer passes the limits (no defaults)

Bytes, edge length, pixel count and allowed formats (import checks) and total size (keeping originals)
are **required arguments** from the caller. SCADA's 8 MiB, 8192 px and so on are not package defaults.
"No limit" is not the default either, so forgetting to pass a limit never means unlimited imports. The
limits themselves are validated and rejected with a throw when invalid.

### 3. No text; return error codes and detail values

The package writes no Japanese (or any display) text. A failure is an `ImageAssetError` with a `code`
and a `detail` (the limit, the actual value and so on); the app picks the display text through its
Paraglide keys (conventions §13). `message` is the same string as the code and is not meant for the screen.

### 4. Hash with `crypto.subtle` when present, otherwise with an in-house SHA-256 (D11)

Both give the same hex value, so de-duplication does not change with how the app is served (HTTPS or
plain HTTP). The in-house implementation is plain TS, in line with conventions §3 (add no dependency,
write it ourselves). It is unit-tested against known test vectors (the NIST examples), and the time it
takes on a large image is measured in the implementing PR (PR-13).

### 5. Keep the request-expiry contract internally (do not import the #436 part)

Imports between packages are forbidden (conventions §4, §5, plan §2.1), so admin-core's
`createRequestOwner` (#436) cannot be used. Like `@banto/forms`, the package holds its own implementation
of the same contract and runs a test over admin-core's contract table
(`packages/admin-core/tests/contracts/request-owner.json`) to confirm the same behaviour (PR-14).

### 6. Scaffold and the external-consumer fixture

- Nothing is wired into the template app, so there is no app-side wiring for scaffold to remove. The
  package itself stays in the tree, as with every other remover (scaffold does not touch it; the reason
  is written in the exclusions of `scripts/scaffold.test.mjs`). Deleting the package would make the docs'
  references to `@banto/image-assets` fail rule `docs-package-refs`.
- While it has no `.svelte.ts`, it is outside `optimizeDeps.exclude` (conventions §14) and the
  external-consumer fixture (rule `external-consumer-fixture`). If PR-14 adds a `.svelte.ts`, that PR adds
  it to both.

## Alternatives considered

| Option                                                     | What                                                                  | Why rejected                                                                                                                                                                                                                                                          |
| ---------------------------------------------------------- | --------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Add to `@banto/attachments` (D6-b)                         | Put browser-side image handling into the existing attachments package | Server attachments and keeping originals in the browser serve different purposes. An app that does not need attachments loses the image parts when it removes attachments (and an app that only needs the image parts gets the attachment parts and the server crate) |
| Put it in banto-industrial (D6-c)                          | The home for domain-specific assets (template-scope §3.1)             | It carries no factory knowledge (criterion 4 = yes); there is no reason to put it in the domain-specific home                                                                                                                                                         |
| Defer (D6-d)                                               | Leave it in temp-scada and slim it down with the #436 part            | A second consumer (the project-specific SCADA) is decided, and two apps would copy the same part                                                                                                                                                                      |
| Limit hashing to a secure context (D11-b)                  | No hash over plain HTTP                                               | De-duplication would behave differently in LAN derived apps, where plain HTTP is the norm                                                                                                                                                                             |
| Let the consumer inject the hash function (D11-c)          | Flexible                                                              | Every app would solve the same problem (no `crypto.subtle`)                                                                                                                                                                                                           |
| Allow imports between packages and use the admin-core part | Avoids duplicating the contract                                       | Changes the conventions §4 invariant and how derived apps take Git dependencies (`path:packages/*`) (plan §2.1, D1)                                                                                                                                                   |

## Consequences

- There is one more `@banto/*` package (the twelfth). Its version stays aligned with the other
  `@banto/*` packages (`check:versions`).
- Criteria 1 and 3 rest on the second consumer. If the project-specific SCADA is dropped and there stays
  only one consumer, reconsider taking it out of the options (back to banto-industrial or temp-scada).
- The in-house SHA-256 is an in-house implementation in the cryptography area, which the conventions §3
  criteria call out. It is used only as a de-duplication key, never for tamper detection or
  authentication (adding such a use means deciding again, including whether to take a dependency).
- The request-expiry contract is implemented in three places: admin-core, forms and image-assets. Tests
  that share the contract table keep them from drifting apart.
