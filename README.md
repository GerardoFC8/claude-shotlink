# @gerardofc/claude-shotlink

Auto-upload Claude Code screenshots to a temporary public URL so you can review them from any device when using Remote Control.

> **Status**: v0.3 — macOS / Linux / WSL2.

## Why

When you control Claude Code remotely (phone, tablet, another machine) and ask it to run Playwright tests, the screenshots land locally on the machine running Claude. You cannot see them until you return to that machine.

`claude-shotlink` runs a tiny local relay server + a free Cloudflare tunnel, and installs a `PostToolUse` hook that auto-uploads generated screenshots. Claude gets back a public URL via `additionalContext` and shares it in the conversation, so you can open it from anywhere — no accounts, no domains required.

---

## Install

Recommended — global install keeps the binary on your `$PATH`:

```bash
npm i -g @gerardofc/claude-shotlink@latest
```

Or run without installing (always pulls the latest published version):

```bash
npx @gerardofc/claude-shotlink@latest start
```

If you already have an older version installed globally, the command above upgrades it in place.

> **See [CHANGELOG.md](./CHANGELOG.md) for release history.**

## Quickstart

```bash
claude-shotlink start
```

On first run this will:

1. Download the pinned `cloudflared` binary to `~/.claude-shotlink/bin/` (sha256-verified).
2. Generate a random API key and store it in `~/.claude-shotlink/config.json`.
3. Start the relay server on `127.0.0.1:<random-port>`.
4. Launch a Cloudflare tunnel and print the public URL.
5. Install the `PostToolUse` hook into `~/.claude/settings.json` automatically.

**Example output:**

```
claude-shotlink running
  local:   http://127.0.0.1:49312
  tunnel:  https://broken-moon-clouds.trycloudflare.com
  key:     sk_4af1b2...
```

Now open Claude Code, ask it to run your Playwright tests, and the screenshots appear in the conversation as clickable public links. No configuration needed.

---

## The hook

The `PostToolUse` hook fires automatically after every `Write` and `Bash` tool call. It:

- Detects screenshots in `test-results/`, `screenshots/`, `.playwright/`, and `playwright-report/` directories.
- Deduplicates via sha256 so the same file is never uploaded twice within 24 hours.
- Uploads over the loopback interface to the local relay (never directly to the internet).
- Injects a `Screenshots:` section into Claude's context so Claude can see and share the URLs.

The hook always exits `0` — it will never disrupt Claude Code, even if the relay is unreachable.

In v0.3, the hook's message to Claude was updated to be more imperative: "You MUST include these exact URL(s) verbatim in your response to the user so they can view the screenshot(s)." This helps Claude understand that the URLs are fresh and must be quoted as-is, not paraphrased.

### Auto-install on start

`claude-shotlink start` calls `install-hook` automatically on first run.

### Manual install / uninstall

```bash
# Install
claude-shotlink install-hook

# Uninstall (removes our entry from settings.json)
claude-shotlink uninstall-hook

# Restore the most recent backup of settings.json
claude-shotlink uninstall-hook --restore
```

Backups are written to `~/.claude/settings.json.backup-<ISO8601>` before every mutation.

> In v0.3, `install-hook` is smart about duplicates — if you move your install (e.g. from dev checkout to npm-global), running `install-hook` again replaces the old entry and keeps only the new one. No manual cleanup needed.

---

## All CLI commands

| Command | Flags | Description |
|---------|-------|-------------|
| `start` | `--port <n>` `--ttl <s>` | Start relay + tunnel. Auto-installs the hook on first run. |
| `stop` | — | Gracefully stop the running relay (SIGTERM → SIGKILL fallback). |
| `status` | — | Show PID, port, tunnel URL, and `/health` probe result. |
| `setup-tunnel` | `--name <n>` `--hostname <fqdn>` `--port <n>` `--skip-dns` | Create and configure a named tunnel in one command. |
| `configure-tunnel` | `--mode <quick\|named>` `--name <n>` `--hostname <fqdn>` | Manually configure tunnel settings (advanced). |
| `install-hook` | — | Install the `PostToolUse` hook into `~/.claude/settings.json`. Idempotent. |
| `uninstall-hook` | `--restore` | Remove our hook entry. `--restore` restores the latest backup verbatim. |
| `rotate-key` | — | Generate a new API key. Restart the relay to apply it. |
| `logs` | `--tail` | Print the JSONL log. `--tail` streams in real time. |

**Flags for `start`:**

- `--port <n>` — listen on a specific port instead of an OS-assigned one.
- `--ttl <seconds>` — automatically shut down after this many seconds.

> `--no-hook` (skip hook install) and `--log` (opt-in JSONL upload logging) are planned for a future release.

---

## Persistent URLs with named tunnel

By default, `claude-shotlink` uses a Cloudflare **quick tunnel** — a free, anonymous tunnel that requires no account. The downside is that the public URL changes every time the relay restarts or auto-reconnects after a Cloudflare edge failure.

If you need a **stable, permanent hostname** (so Claude Code conversation context, bookmarks, and webhooks keep working across restarts), you can opt into a named tunnel backed by your own Cloudflare account.

### Quick setup with `setup-tunnel`

**Prerequisites:**
1. Cloudflare account (free at [dash.cloudflare.com](https://dash.cloudflare.com))
2. Domain with DNS managed by Cloudflare
3. One-time authentication:
   ```bash
   cloudflared tunnel login
   ```
   This opens a browser to link your Cloudflare account to the local `cloudflared` binary.

**Create a named tunnel in one command:**

```bash
claude-shotlink setup-tunnel --name myname --hostname shots.example.com
```

This wizard:
- Creates the named tunnel in your Cloudflare account
- Routes the hostname to the tunnel (DNS CNAME)
- Saves the tunnel credentials and config locally
- Guides you through any setup issues

**Then start the relay:**

```bash
claude-shotlink start
```

No manual file edits needed. The public URL is your permanent hostname (`https://shots.example.com`), stable across restarts.

**Flags for `setup-tunnel`:**
- `--name <name>` — tunnel name (required, e.g. `myname`)
- `--hostname <fqdn>` — public hostname (required, e.g. `shots.example.com`)
- `--port <n>` — local relay port (default 7331)
- `--skip-dns` — skip automatic DNS routing (do it manually later)

#### What if DNS routing fails?

If the zone is not on your Cloudflare account, `setup-tunnel` will print the manual command:

```bash
cloudflared tunnel route dns myname shots.example.com
```

The config is still written and `start` will work — just run the DNS command when you're ready.

---

### Manual setup (advanced)

If you prefer to use `configure-tunnel` directly (for externally-managed tunnels or IaC):

```bash
# Create the tunnel manually
cloudflared tunnel create myname

# Route DNS manually
cloudflared tunnel route dns myname shots.example.com

# Configure the relay
claude-shotlink configure-tunnel --mode named --name myname --hostname shots.example.com

# Start
claude-shotlink start
```

This approach persists the named-tunnel settings without the wizard. Use it when your tunnel is managed elsewhere (e.g. Terraform, shared org account).

---

### Revert to quick mode

```bash
claude-shotlink configure-tunnel --mode quick
claude-shotlink start
```

---

## Known limitations

- **Quick tunnel URLs change on reconnect.** The default quick-tunnel mode issues a new random URL every time the relay restarts and every time the Cloudflare edge drops the connection and the relay auto-reconnects. Anything that pinned the previous URL — Claude Code conversation context, bookmarks, or external services — will break and need the new URL.

- **Named tunnels require a Cloudflare account and a domain.** You must have a Cloudflare account and at least one domain whose DNS is managed by Cloudflare. Named tunnels are not available to users without these prerequisites. See the [Persistent URLs with named tunnel](#persistent-urls-with-named-tunnel) section for the full setup.

---

## Troubleshooting

**Error 1033 — Cloudflare edge cannot reach origin**

Cloudflare returns HTTP Error 1033 when its edge cannot reach the local relay through the tunnel.

- **In quick mode:** the quick-tunnel registration drifted or went stale. Starting in v0.2, the relay detects 3 consecutive `/health` failures and automatically reconnects, issuing a new tunnel URL. Your old URL is dead; the new URL appears in the relay output. Update anything that referenced the previous URL.

- **In named mode (v0.3 with `setup-tunnel`):** The wizard configures the port automatically, so this error is unlikely. If it happens, verify with `claude-shotlink status` that the relay port matches what the tunnel expects, and re-run `setup-tunnel` with the correct `--port` if needed.

- **In named mode (v0.2 or manual `configure-tunnel`):** Cloudflare can reach the tunnel but not the relay's HTTP port. The most likely cause is an ingress port mismatch — the tunnel's ingress config in `~/.cloudflared/config.yml` points at a different port than the one the relay is listening on. Check that your ingress is set to `http://127.0.0.1:<port>` matching the relay's actual port (`claude-shotlink status`).

- **Permanent fix:** Use `claude-shotlink setup-tunnel` for automatic port configuration. See [Persistent URLs with named tunnel](#persistent-urls-with-named-tunnel).

---

**Relay not running / `status` shows unreachable**

The relay may have crashed or been killed. Run `claude-shotlink stop` to clean up the stale PID file, then `claude-shotlink start` again.

**Stale PID file**

If you see `Stale PID file removed` on stderr, the previous relay process died without cleaning up. This is harmless — `claude-shotlink start` will remove the stale file and start fresh.

**Tunnel won't come up**

`cloudflared` requires outbound HTTPS to Cloudflare. Check your firewall. You can verify manually:

```bash
~/.claude-shotlink/bin/cloudflared tunnel --url http://127.0.0.1:<port> --no-autoupdate
```

If `cloudflared` is already cached but seems broken, delete it and let `claude-shotlink` re-download:

```bash
rm -rf ~/.claude-shotlink/bin/
claude-shotlink start
```

**How to uninstall the hook and restore settings.json**

```bash
# Option 1: remove our entry
claude-shotlink uninstall-hook

# Option 2: restore the most recent backup verbatim
claude-shotlink uninstall-hook --restore

# Option 3: manual — backups are at ~/.claude/settings.json.backup-*
cp ~/.claude/settings.json.backup-<latest> ~/.claude/settings.json
```

**Screenshots not appearing in Claude's response**

- Verify the hook is installed: `claude-shotlink status` (check the hook section) or look at `~/.claude/settings.json`.
- Verify the relay is running: `claude-shotlink status`.
- The relay must be running BEFORE Claude runs the Playwright tests — the hook uploads to `http://127.0.0.1:<port>/upload` at invocation time.

---

## Security notes

- **127.0.0.1 bind** — the relay never listens on a public interface. Only the local `cloudflared` process, running as the same user, can reach it.
- **API key gate** — every upload requires a valid `X-Api-Key` header matching `~/.claude-shotlink/config.json`. The key is only printed to your terminal, never logged.
- **Magic-number validation** — uploaded bytes are validated against PNG / JPEG / WebP magic numbers. Unknown types are rejected with 415.
- **File size cap** — uploads > 5 MB are rejected with 413.
- **Rate limiting** — 60 uploads/hour and 500 GETs/hour per key.
- **No telemetry** — no analytics, no crash reporting, no version-check pings. The only outbound connections are to `github.com` (one-time cloudflared download) and to Cloudflare's tunnel infrastructure.

---

## Requirements

- Node.js >= 20
- macOS, Linux, or WSL2 (Windows native not supported)

---

## Contributing

### Running tests

```bash
# Unit tests (default, fast)
pnpm test

# Integration tests (requires real cloudflared binary)
pnpm test:integration
```

The integration test suite is opt-in (`CLAUDE_SHOTLINK_INTEGRATION=1`) to keep the default test run fast. It invokes the real cloudflared binary to verify that the spawn args are accepted by the binary itself — catching regressions like the v0.2.1 `--no-autoupdate` placement bug.

Run integration tests locally before publishing a release.

---

## License

MIT © Gerardo Franco
