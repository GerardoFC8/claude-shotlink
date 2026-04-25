# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.0.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

_None yet._

## [0.3.2] — 2026-04-25

### Fixed

- **Server port now inherits from `tunnelLocalPort` config when no `--port` CLI flag is given**:
  The setup-tunnel wizard saves `tunnelLocalPort` to config, and `start` was
  correctly passing it to the cloudflared spawn (`--url http://127.0.0.1:<port>`),
  but NOT to the local HTTP server — which fell back to an OS-assigned random port.
  Result: cloudflared proxied to the configured port, but the relay was listening
  on a different port → every request returned 502 Bad Gateway from Cloudflare.
  Same port-resolution asymmetry class as the JD R2 fix in v0.3.0, but on the
  server side instead of the tunnel side.

  Workaround for v0.3.0/v0.3.1 users: pass `--port <n>` explicitly to `start`.
  v0.3.2 makes that automatic.

## [0.3.1] — 2026-04-25

### Fixed

Two bugs in v0.3.0 that broke the entire named-mode flow because of a wrong
assumption about cloudflared's credentials JSON shape. Discovered by the
maintainer while testing v0.3.0 against a real Cloudflare tunnel (`shots.gfcode.dev`).

- **`handleStart` credentials JSON validation accepts real cloudflared shape**:
  v0.3.0 required `TunnelID` AND `TunnelName` in the credentials JSON, but
  cloudflared 2024.12.x writes only `{ AccountTag, TunnelSecret, TunnelID, Endpoint }` —
  there is no `TunnelName` field. Every real install was rejected with a misleading
  "missing required fields (TunnelID and TunnelName)" error. v0.3.1 only requires
  `TunnelID`, which IS present.

- **`setup-tunnel` idempotency uses `cloudflared tunnel list`**:
  v0.3.0 detected "tunnel already exists" but couldn't find the local credentials,
  because it scanned `~/.cloudflared/*.json` for a `TunnelName` field that doesn't
  exist. v0.3.1 spawns `cloudflared tunnel list --output json` to map name → UUID,
  then verifies `<UUID>.json` exists in cloudflared home. Both unit tests and the
  integration smoke test now use the REAL cloudflared shape (no `TunnelName`).

Same bug class as the v0.2.2 `--no-autoupdate` arg-position fix: unit tests
asserted what we coded, not what cloudflared actually produces.

## [0.3.0] — 2026-04-25

### Added

- **`setup-tunnel` wizard command**: One-command setup for named tunnels. Runs `cloudflared tunnel create`, routes DNS, and writes config — no manual file edits needed.
  - Flags: `--name`, `--hostname` (required), `--port` (default 7331), `--skip-dns`
  - Handles idempotency: re-running with the same name reuses the existing tunnel
  - Partial-success recovery: if DNS routing fails, config is still written and you can route manually later

- **Credentials-file spawn variant** (CA-3): When a named tunnel is set up via `setup-tunnel`, `claude-shotlink start` uses `--credentials-file` + `--url` args, bypassing `~/.cloudflared/config.yml` entirely. This simplifies multi-machine setups and avoids manual ingress config.

- **Sentinel-based hook deduplication** (CA-4): The hook installation now uses a stable substring sentinel (`claude-shotlink/dist/hook.js`) instead of full absolute paths. Running `install-hook` after moving your install (dev → npm-global, or vice versa) automatically replaces the old entry with one canonical entry. No orphaned hooks.

- **Imperative screenshot phrasing** (CA-5): The hook now tells Claude: "You MUST include these exact URL(s) verbatim in your response to the user so they can view the screenshot(s):" instead of just "Screenshots:". This makes Claude more likely to quote the URLs as-is rather than paraphrasing.

- **Integration smoke test** (CA-6): New env-gated test suite (`src/tunnel.integration.test.ts`) that invokes the real bundled `cloudflared` binary to verify spawn args are accepted. Opt-in via `pnpm test:integration` or `CLAUDE_SHOTLINK_INTEGRATION=1 pnpm test`. Catches regressions like the v0.2.1 `--no-autoupdate` placement bug.

- **Test script for contributors**: `pnpm test:integration` runs integration tests locally; part of the release checklist to verify cloudflared binary compatibility.

### Changed

- **README restructure**: Replaced the 5-step manual tunnel setup guide with a single `setup-tunnel` flow. Manual setup (advanced) is now a subsection for users with externally-managed tunnels.

- **Config schema extension** (CA-2): Added optional fields `tunnelCredentialsFile?: string` (path to cloudflared credentials JSON) and `tunnelLocalPort?: number` (the port the tunnel proxies to). v0.2 configs remain valid — these fields are optional and backward-compatible.

- **Hook install robustness**: The hook is now smart about detecting and consolidating duplicate entries across different install paths. On first v0.3 `install-hook` after upgrading from v0.2, any duplicate entries (from v0.2 full-path sentinels) are automatically removed.

- **Start command port resolution** (CA-3.2): When `tunnelCredentialsFile` is set, `start` reads `tunnelLocalPort` from config as the default port. An explicit `--port` CLI flag overrides it and prints a warning if the two differ (helps catch misconfiguration).

### Fixed (caught pre-release by judgment-day adversarial review)

- **Distinct error messages for credentials file failures** (JD R2): `start` now distinguishes read-error (EACCES, EISDIR), invalid JSON, and missing required fields with separate, actionable messages. Previously a permission error wrongly said "missing TunnelID or TunnelName".
- **Co-constraint validation for `tunnelCredentialsFile` + `tunnelLocalPort`** (JD R1): `validateConfigShape` now rejects half-set state when `tunnelMode: 'named'`. Both fields must be present together or both absent. Hand-edited configs with only one of the two are caught at load time.
- **Port resolution asymmetry fixed** (JD R1): `--port` CLI flag now ALWAYS overrides config `tunnelLocalPort` when present, regardless of `tunnelCredentialsFile` presence. Previously `--port` was silently ignored when named-mode config had no credentials file.
- **`setup-tunnel` verifies fallback credentials path exists** (JD R1): When `cloudflared tunnel create --output json` doesn't include `credentials_file`, the fallback `~/.cloudflared/<uuid>.json` is now checked with `existsSync` before returning success. Previously a custom cloudflared config could leave the credentials elsewhere and `start` would fail later with a cryptic error.
- **Credentials JSON shape validated before spawn** (JD R1): `start` now reads + parses the credentials file and asserts `TunnelID` and `TunnelName` are present strings before invoking cloudflared. Previously a bogus path that existed but had wrong content produced a confusing cloudflared spawn error.
- **Dedicated `creds-not-found` reason discriminant** (JD R2): `setup-tunnel` returns a specific reason when the post-parse credentials file lookup fails, instead of misclassifying as `parse-failed`. Recovery hint now includes the exact re-run command.
- **No regression on v0.2 named-mode users**: Existing v0.2 configs (with `tunnelMode: 'named'` but no `tunnelCredentialsFile`) continue to work unchanged. The relay still spawns `cloudflared tunnel run <name>` and reads `~/.cloudflared/config.yml` as before. No breaking changes.

### Backward Compatibility

**v0.2 → v0.3 upgrade is safe:**
- v0.2 named-tunnel users: your `~/.cloudflared/config.yml` continues to work; `claude-shotlink start` spawns the legacy args and behavior is unchanged.
- v0.2 hook users: `install-hook` automatically deduplicates any entries from older installs.
- v0.2 quick-mode users: no impact; quick tunnels work exactly as before.
- All v0.2 configs validate without changes — the new `tunnelCredentialsFile` and `tunnelLocalPort` fields are entirely optional.

### Migration Path

**To take advantage of v0.3 named-tunnel setup:**
1. Run `cloudflared tunnel login` (one-time browser auth).
2. Run `claude-shotlink setup-tunnel --name <name> --hostname <your.domain>`.
3. Run `claude-shotlink start` — tunnel comes up with your permanent hostname.

**If you prefer the v0.2 manual flow:**
- Continue using `configure-tunnel --mode named` to write config, then manage `~/.cloudflared/config.yml` yourself. Both paths work.

---

## [0.2.2] — 2026-04-25

### Fixed

- **`--no-autoupdate` flag position in named-mode spawn args**: cloudflared 2024.12.x parses `--no-autoupdate` as a TUNNEL command option (not a `run` subcommand option). v0.2.0 and v0.2.1 spawned `cloudflared tunnel run --no-autoupdate <name>` (wrong order), causing cloudflared to print "Incorrect Usage" to stdout and exit 0 — which the relay reported as "cloudflared exited (code 0) before ready". Fixed by moving `--no-autoupdate` BEFORE `run`.

---

## [0.2.1] — 2026-04-25

### Added

- **`--version` / `-v` / `version` flag**: CLI now reports the package version. Previously `--version` was rejected as an unknown command.

---

## [0.2.0] — 2026-04-25

### Added

- **Named Cloudflare tunnel mode** (Feature A): `configure-tunnel` subcommand and `--tunnel-name` / `--tunnel-hostname` flags. Persistent URLs across restarts when paired with a Cloudflare account + domain.
- **Edge healthcheck + auto-reconnect** (Feature B): polls `{publicUrl}/health` and triggers a quick-tunnel reconnect after 3 consecutive failures. Named mode warns only (hostname is stable).
- **Hook detection widening** (Feature C): tokenizer for `--filename`, `--output`, `-o`, `--path`, `--screenshot` flags in Bash commands. Widened directory whitelist (`.playwright-cli`, `tmp`, `temp`, `playwright-*`, `*-playwright`). New `ABSOLUTE_TMP_RE` for `/tmp/` and `/var/tmp/` Write events.
- **README documentation** (Feature D): named-tunnel setup guide, known limitations, Error 1033 troubleshooting.
- Initial pre-v0.2 features (carry-over from v0.1.x): quick-tunnel relay with hook auto-installation, screenshot auto-upload to temporary public URLs via Cloudflare, `PostToolUse` hook integration with Claude Code, security (local 127.0.0.1 bind, API key gate, file-type validation, rate limiting).

---

[Unreleased]: https://github.com/gerardofc/claude-shotlink/compare/v0.3.0...HEAD
[0.3.0]: https://github.com/gerardofc/claude-shotlink/compare/v0.2.2...v0.3.0
[0.2.2]: https://github.com/gerardofc/claude-shotlink/compare/v0.2.1...v0.2.2
[0.2.1]: https://github.com/gerardofc/claude-shotlink/compare/v0.2.0...v0.2.1
[0.2.0]: https://github.com/gerardofc/claude-shotlink/releases/tag/v0.2.0
