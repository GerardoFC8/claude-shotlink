# @gerardofc/claude-shotlink

Auto-upload Claude Code screenshots to a temporary public URL so you can review them from any device when using Remote Control.

> **Status**: v0.1 — early development, macOS / Linux / WSL2.

## Why

When you control Claude Code remotely (phone, tablet, another machine) and ask it to run Playwright tests, the screenshots land locally on the machine running Claude. You cannot see them until you return to that machine.

`claude-shotlink` runs a tiny local relay server + a free Cloudflare tunnel, and installs a `PostToolUse` hook that auto-uploads generated screenshots. Claude gets back a public URL via `additionalContext` and shares it in the conversation, so you can open it from anywhere — no accounts, no domains required.

---

## Quickstart

```bash
npx @gerardofc/claude-shotlink start
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

---

## All CLI commands

| Command | Flags | Description |
|---------|-------|-------------|
| `start` | `--port <n>` `--ttl <s>` | Start relay + tunnel. Auto-installs the hook on first run. |
| `stop` | — | Gracefully stop the running relay (SIGTERM → SIGKILL fallback). |
| `status` | — | Show PID, port, tunnel URL, and `/health` probe result. |
| `install-hook` | — | Install the `PostToolUse` hook into `~/.claude/settings.json`. Idempotent. |
| `uninstall-hook` | `--restore` | Remove our hook entry. `--restore` restores the latest backup verbatim. |
| `rotate-key` | — | Generate a new API key. Restart the relay to apply it. |
| `logs` | `--tail` | Print the JSONL log. `--tail` streams in real time. |

**Flags for `start`:**

- `--port <n>` — listen on a specific port instead of an OS-assigned one.
- `--ttl <seconds>` — automatically shut down after this many seconds.

> `--no-hook` (skip hook install) and `--log` (opt-in JSONL upload logging) are planned for a post-v0.1 release.

---

## Troubleshooting

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

## License

MIT © Gerardo Franco
