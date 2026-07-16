# Vaultbridge

**End-to-end encrypted Obsidian sync over your own CouchDB — with a real conflict diff view, file history, and cross-device passphrase rotation.**

Vaultbridge keeps an Obsidian vault in sync across desktop and mobile through a CouchDB you control. Your notes are encrypted on the device before they ever leave it; the server only ever sees ciphertext. It builds on the proven PouchDB ↔ CouchDB replication protocol, so mobile support and conflict handling come from a battle-tested foundation rather than a custom sync engine.

> **No telemetry, no accounts, no third-party servers.** Vaultbridge talks only to the CouchDB endpoint you configure. It loads no remote code and phones no home.

---

## Features

- **End-to-end encryption.** Content, file paths, and metadata are encrypted with AES-256-GCM. Keys are derived from your passphrase with PBKDF2-HMAC-SHA256 (≥210,000 iterations) and HKDF. File paths are stored as opaque HMACs, and file bodies are split into content-addressed, encrypted chunks — the server sees only ciphertext, opaque ids, and rough structure (how many docs/chunks, roughly how big).
- **One-string setup.** A single `vbridge1:…` setup string carries the server connection and encryption parameters. Generate it once, scan the QR code or paste the string on each device, done. The passphrase can be embedded in the string or kept separate and entered per device.
- **Conflict diff view.** When two devices edit the same note, Vaultbridge shows a two-column diff and lets you adopt changes hunk-by-hunk or take a whole side — no silent "last write wins", no lost edits.
- **File history.** Browse previous revisions of a note (as far back as your CouchDB retains them), diff any revision against the current version, and restore one as a new, non-destructive revision.
- **Non-Obsidian file control.** Sync hidden/dotfiles that Obsidian ignores — e.g. `.claude/` folders and other tool config. Because these files raise no Obsidian events, Vaultbridge scans for them periodically. Concurrent edits to a hidden file are preserved in a sidecar `*.vaultbridge-konflikt` file rather than being overwritten.
- **Plugin sync & update.** Mirror community plugins across devices — plugin code, their enabled state (`community-plugins.json`), and their settings (`data.json`) — with settings conflicts routed through the same diff view. A reload button applies plugin updates without restarting Obsidian. (Vaultbridge's own settings always stay local, so each device keeps its own identity.)
- **Passphrase rotation.** Change your encryption passphrase across all devices. A variable key ring keeps old keys as decryption fallbacks so your file history stays readable, and an epoch marker lets other devices adopt the new key automatically from their unchanged passphrase — no re-setup.
- **Mobile.** Works on iOS/iPadOS and Android (`isDesktopOnly: false`).

---

## Requirements

- Obsidian **1.4.0** or newer (desktop or mobile).
- A **CouchDB** endpoint you can reach over HTTPS, with CORS enabled. See [`docs/server-setup.md`](docs/server-setup.md) — this covers a one-line Docker CouchDB, the required CORS configuration, and a hosted free-tier option (IBM Cloudant).

CORS misconfiguration is the single most common onboarding problem. Vaultbridge's connection self-test checks for it explicitly and tells you what to fix.

---

## Installation

### From the Obsidian community plugin list

Not yet submitted — this is planned. Until then, use manual installation.

### Manual installation

1. Download `main.js`, `manifest.json`, and `styles.css` from the [latest release](https://github.com/DonnervS/vaultbridge/releases).
2. Copy them into `<your-vault>/.obsidian/plugins/vaultbridge/`.
3. Reload Obsidian and enable **Vaultbridge** under Settings → Community plugins.

### Via BRAT

You can also install directly from this repository with the [BRAT](https://github.com/TfTHacker/obsidian42-brat) plugin by adding `DonnervS/vaultbridge`.

---

## Getting started

1. **Set up a CouchDB** following [`docs/server-setup.md`](docs/server-setup.md).
2. **Generate a setup string.** In Vaultbridge's settings, use the generator (server URL, database, credentials, encryption passphrase). It produces a `vbridge1:…` string and a QR code. Treat this string like a password — it contains your server credentials (and, if embedded, your passphrase).
3. **Add your devices.** On each other device, paste the string or scan the QR code. If you chose the "separate passphrase" mode, enter the passphrase on each device.
4. **Connect.** Vaultbridge runs an initial replication and then keeps syncing live. The status bar shows sync state and a badge when conflicts need your attention.

For a quick manual setup string during local testing, `npm run make-setup` prints one from prompts or environment variables.

---

## Usage

- **Resolving conflicts.** When the status-bar badge appears, open the conflict panel to see the two-column diff. Adopt individual changes or take a whole side, then confirm — the losing revision is cleaned up so CouchDB converges.
- **Viewing history.** Run the command **"Vaultbridge: Datei-Verlauf anzeigen"** (Show file history) for the active note to browse revisions, diff against the current version, and restore one.
- **Rotating the passphrase.** Use the passphrase-change command. All current files are re-encrypted with the new key; other devices adopt it automatically the next time they sync. Your history remains readable throughout.

---

## Building from source

```bash
npm install
npm test        # runs the full test suite
npm run build   # type-check + esbuild production bundle + bundle guard
```

The build produces `main.js` in the repository root. `main.js` is not committed — releases are built in CI (see below).

## Releasing (for maintainers)

Releases are automated. Bump the version in `manifest.json` (and `package.json`), update `versions.json`, then push a matching tag:

```bash
git tag 1.0.1
git push origin 1.0.1
```

The release workflow ([`.github/workflows/release.yml`](.github/workflows/release.yml)) verifies the tag matches `manifest.json`, runs the tests and build, and publishes a GitHub release with `main.js`, `manifest.json`, and `styles.css` attached. The tag must equal the manifest version exactly, with no leading `v` (an Obsidian requirement).

---

## Security model

- The CouchDB server is treated as **untrusted**. It stores only ciphertext, HMAC ids, and coarse structural metadata (document/chunk counts and sizes). Content, paths, and note metadata are encrypted end-to-end.
- Vaultbridge loads no remote code and contacts no endpoints other than the CouchDB you configure — no analytics, no crash reporting, no accounts.
- Your passphrase is never sent to the server. Anyone with the setup string can reach your server; anyone with the passphrase can decrypt your notes — protect both accordingly.

## License

[MIT](LICENSE) © 2026 Markus Wenzel
