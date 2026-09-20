# Vendored anti-slop Oxlint plugin

Source repository and exact upstream commit: **unknown**. The installer bundle
does not record an upstream repository or revision. This copy was installed
from the local `install-anti-slop` skill asset snapshot at `assets/anti-slop`.

The recoverable asset snapshot has SHA-256 digest
`2cf66fa1be860828766b671ac50f7cadea0b5bff27359c1b27693586b4cb95aa` over the
sorted per-file `shasum -a 256` output, and contains 38 files. The nested
`vendor/eslint-stylistic` rule has its own provenance in that directory's
`UPSTREAM.md`.

Installed paths:

- `index.ts`
- `rules/`
- `shared/`
- `effect/` (kept as an opt-in asset; not registered because this package has
  no direct `effect` dependency)
- `vendor/eslint-stylistic/`

Intentional local configuration:

- Only the generic plugin is registered in `.oxlintrc.json`.
- The vendored plugin directory is ignored by Oxlint so its implementation is
  not linted as application source.
- `oxlint` and `@oxlint/plugins` are pinned to the same development version in
  `package.json` and `package-lock.json`.

If this plugin is updated, identify the actual source revision first, compare
the copied files with that revision, and update this record without replacing
the nested license or provenance.
