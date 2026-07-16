# CouchDB server setup

Vaultbridge syncs against a CouchDB endpoint that **you** control. The server only
ever stores ciphertext, so any CouchDB you can reach over HTTPS works. You have two
practical options:

- **A. Self-hosted CouchDB** via Docker (full control, runs anywhere you can host a container).
- **B. Hosted free tier** via IBM Cloudant (no server to maintain).

Whichever you pick, the one thing that trips almost everyone up is **CORS**. Obsidian
(especially on mobile and in the browser build) will refuse to connect without it.
Vaultbridge's built-in connection self-test checks CORS explicitly and tells you what
is missing.

---

## A. Self-hosted CouchDB with Docker

### 1. Run CouchDB

```bash
docker run -d --name vaultbridge-couch \
  -p 6984:5984 \
  -e COUCHDB_USER=admin \
  -e COUCHDB_PASSWORD=change-me-to-something-strong \
  -v vaultbridge-couch-data:/opt/couchdb/data \
  couchdb:3
```

Or, as a `docker-compose.yml`:

```yaml
services:
  couchdb:
    image: couchdb:3
    restart: unless-stopped
    ports:
      - "6984:5984"
    environment:
      COUCHDB_USER: admin
      COUCHDB_PASSWORD: change-me-to-something-strong
    volumes:
      - vaultbridge-couch-data:/opt/couchdb/data
volumes:
  vaultbridge-couch-data:
```

> **Use HTTPS in production.** CouchDB speaks plain HTTP on `5984`. For any real use,
> put it behind a reverse proxy (Caddy, nginx, Traefik) that terminates TLS, or enable
> CouchDB's native TLS. Obsidian mobile will only talk to `https://` endpoints. The
> examples below assume you reach CouchDB at `https://your-host:6984`.

### 2. Finish the single-node setup

A fresh CouchDB needs its system databases created once:

```bash
curl -X PUT http://admin:change-me@localhost:6984/_users
curl -X PUT http://admin:change-me@localhost:6984/_replicator
```

### 3. Create the vault database

Pick a name (e.g. `vault`) and create it:

```bash
curl -X PUT https://admin:change-me@your-host:6984/vault
```

### 4. Enable CORS (required)

The reliable way is via the config API:

```bash
BASE=https://admin:change-me@your-host:6984
curl -X PUT "$BASE/_node/_local/_config/httpd/enable_cors" -d '"true"'
curl -X PUT "$BASE/_node/_local/_config/cors/origins" -d '"app://obsidian.md,capacitor://localhost,http://localhost"'
curl -X PUT "$BASE/_node/_local/_config/cors/credentials" -d '"true"'
curl -X PUT "$BASE/_node/_local/_config/cors/methods" -d '"GET, PUT, POST, HEAD, DELETE"'
curl -X PUT "$BASE/_node/_local/_config/cors/headers" -d '"accept, authorization, content-type, origin, referer"'
```

The origins above cover Obsidian desktop (`app://obsidian.md`), Obsidian mobile
(`capacitor://localhost`), and the localhost dev build. You can set `cors/origins`
to `"*"` for testing, but list specific origins for production.

### 5. Recommended: raise the revision limit

File history reaches back only as far as CouchDB keeps old revisions. The default
`_revs_limit` is 1000, which is usually fine; if you want deeper history on a
busy vault, raise it per database:

```bash
curl -X PUT https://admin:change-me@your-host:6984/vault/_revs_limit -d '10000'
```

Note that CouchDB compaction still removes the *bodies* of old revisions over time, so
history depth ultimately depends on your server's compaction schedule.

---

## B. Hosted free tier (IBM Cloudant)

If you would rather not run a server:

1. Create a free **IBM Cloudant** instance ("Lite" plan) in the IBM Cloud console.
2. Under **Service credentials**, generate credentials — you get a URL, username, and
   password. Use **"Include legacy credentials"** so you have username/password auth.
3. Create a database (e.g. `vault`) in the Cloudant dashboard.
4. Cloudant serves CORS-enabled HTTPS out of the box; you can also confirm/adjust CORS
   under **Account → CORS** in the dashboard (add `app://obsidian.md` and
   `capacitor://localhost`, or enable all origins for testing).

Cloudant's free tier has throughput and storage limits — fine for a personal vault,
but watch the limits if you sync large binary attachments.

---

## Plug it into Vaultbridge

With the database reachable and CORS enabled, open Vaultbridge's setup generator and
enter:

- **Server URL** — e.g. `https://your-host:6984` (Docker) or your Cloudant URL.
- **Database** — e.g. `vault`.
- **User / password** — your CouchDB/Cloudant credentials.
- **Passphrase** — your encryption passphrase (embedded in the setup string, or kept
  separate and entered per device).

Generate the `vbridge1:…` string, then add it on each device (paste or scan the QR
code). Run the connection self-test — if CORS or credentials are wrong, it will say so.

## Troubleshooting

- **"CORS" / connection blocked** — the most common cause. Re-check step A.4; make sure
  `app://obsidian.md` (desktop) and `capacitor://localhost` (mobile) are in
  `cors/origins` and that `enable_cors` is `true`. Restart is not needed for config-API
  changes.
- **401 Unauthorized** — wrong username/password, or the database doesn't exist yet.
- **Works on desktop but not mobile** — mobile requires a valid HTTPS certificate and
  `capacitor://localhost` in the allowed origins. Self-signed certs are rejected on
  mobile.
