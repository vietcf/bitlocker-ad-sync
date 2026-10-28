**English** | [Tiếng Việt](README_vn.md)

# BitLocker Recovery Key Management System

The system synchronizes BitLocker recovery keys from Active Directory (AD) into a database of its own. Branch IT staff
see only the keys of computers in their own branch. Every key reveal needs a reason and is written to an
append-only log that cannot be edited or deleted.

| Folder | Contents |
| --- | --- |
| `server/` | Node.js application (Express, plain JavaScript): web pages (EJS), JSON API, ingest API for the worker, background jobs |
| `worker/` | .NET sync worker (Windows Service): reads AD over LDAP(S) and pushes the data to the ingest API |
| `worker-go/` | Go sync worker (Linux, systemd): same function and protocol as the .NET one. Choose **one** of the two |
| `docker-compose.yml`, `docker-compose.prod.yml` | Dev (dev secrets, with `--watch`) and production (configuration in `server/.env`, DB creation passwords in `server/db.env`, DB in Docker optional with `--profile db`) |

Contents:

1. [Architecture summary](#1-architecture-summary)
2. [Dev installation](#2-dev-installation)
3. [Production installation](#3-production-installation) (docker-compose or not; DB in Docker or external)
4. [Install the sync worker on Windows](#4-install-the-sync-worker-on-windows) (.NET version) **or**
   [4B. Install the sync worker on Linux](#4b-install-the-sync-worker-on-linux-go-version) (Go version)
5. [First configuration in the application](#5-first-configuration-in-the-application)
6. [Daily operations](#6-daily-operations)
7. [Troubleshooting](#7-troubleshooting)
8. [Reference: environment variables, API, code structure](#8-reference)

---

## 1. Architecture summary

```
 Active Directory ──LDAP(S)──> Sync worker (.NET on Windows, or Go on Linux)
                                   │ HTTPS 8443 + API key (from allowed IPs)
                                   ▼
 Browser ──HTTPS 443──> nginx (one certificate) ──> Node.js server ──> PostgreSQL 17
                              ├─ 443  -> server:3000  web + /api (users)
                              └─ 8443 -> server:8443  /api/ingest (worker only)
```

- **Worker:** reads data from AD over LDAP and sends it to the server through the API.
- **Server:** users come in through the web; all processing and all activity is done by the server.
- **Data:** nothing is deleted, only added.

---

## 2. Dev installation

Try it on a personal machine with Docker. Data and secrets are dev values, not for production (section 3).

### 2.1. Requirements

Docker Desktop (Windows/macOS) or Docker Engine + Compose v2.24 or later (Linux). Node.js 24 is needed only to run the tests outside Docker; .NET SDK 10 only to run the worker.

### 2.2. Start

```bash
cd bitlocker-management
docker compose up --build --watch
```

One command is enough, and only Docker is needed. The first time, compose creates a self-signed certificate in `cert/` by itself (the `certs` service).

Compose builds `db` (PostgreSQL 17, with the databases `blk` and `blk_test`; the first time it creates the two accounts `blk_owner` and `app_node`), `migrate` (runs the migrations and exits), `server` (the app, no port exposed outside; `--watch` updates it automatically when you edit `server/src`, `public`, `openapi`) and `nginx` (HTTPS for the web on 443 and ingest on 8443, port 80 redirects to HTTPS).

- https://localhost: web and `/api`. https://localhost/api/docs: Swagger of the user API (sign in on the web first).
- https://localhost:8443/api/ingest: ingest API for the worker. https://localhost:8443/docs: Swagger of ingest (needs the API key).
- `localhost:5432`: PostgreSQL, dev account `postgres` / `dev_postgres_pw`.

The browser says "not secure" because the certificate is self-signed, until you trust `cert/ca.crt` (section 3.5 explains how to use a real certificate). If a port is taken, change it: `HTTPS_PORT=8444 HTTP_PORT=8080 DB_PORT=15432 docker compose up -d`. By default nginx listens on all addresses (other machines can connect); to allow this machine only: `BIND_ADDR=127.0.0.1`. The dev PostgreSQL is always open on `127.0.0.1` only.

### 2.3. First sign-in

When the DB has no user yet, the app creates the local account **`admin` / `admin`** (Admin HQ) and forces a password change at the very first sign-in (at least 12 characters by default). Forgotten password or locked account:

```bash
docker compose exec server node src/cli/users.js reset-password admin
docker compose exec server node src/cli/users.js unlock admin
docker compose exec server node src/cli/users.js disable-2fa admin   # lost two-step; all commands are in section 6.9
```

### 2.4. Configuration and common commands

There is no need to create a `.env` file: every dev value is already in `docker-compose.yml`. Common commands:

```bash
docker compose exec server node src/db/seed-dev.js   # fake data: 3 branches, ~20 computers
docker compose run --rm migrate                      # apply new migrations
docker compose logs -f server                        # follow the log
docker compose down                                  # stop (the database lives in the data/ folder and stays)
# wipe the database: docker compose down, then delete the data/ folder
```

Only when you need to try real LDAP or change other settings: `cp server/.env.example server/.env`, edit it, then `docker compose up -d --force-recreate server`.

### 2.5. Run the tests

```bash
docker compose up -d db
cd server && npm install
npm test            # everything; npm run test:unit (no DB needed); npm run test:int (DB blk_test)
cd ../worker && dotnet test
```

---

## 3. Production installation

### 3.1. Choose a way to install

Choose **one** of the three ways, then follow its steps in order (each way is complete on its own, no need to read the others).

| Way | The app runs with | Database | Use when |
| --- | --- | --- | --- |
| **A** | Docker Compose | **External** PostgreSQL 17 (a separate machine) | Recommended for production |
| **B** | Docker Compose | PostgreSQL **in Docker** on the same machine | Small machines, trials, a backup of the `data/` folder already exists |
| **C** | Node.js + systemd (no Docker) | External PostgreSQL 17 | Docker cannot be used |

Ports to open: **443** for users, **8443** only for the worker machine's IP. An internal DNS name pointing at the server is needed (for example `blk.corp.local`).

### 3.2. Way A: Docker Compose + external PostgreSQL

**Preparation:** a Linux server with Docker (`docker compose`) and `git` installed; a PostgreSQL 17 machine that this server can reach.

**Step 1. Get the source code**

```bash
git clone git@github.com:vietcf/bitlocker-ad-sync.git blk && cd blk
```

**Step 2. Create the database.** Sign in to PostgreSQL as a superuser and run this (replace the two passwords with strong passwords of your own, and note them down to type them when you run the script in Step 3):

```sql
CREATE ROLE blk_owner LOGIN NOSUPERUSER NOCREATEROLE NOBYPASSRLS PASSWORD '<owner-password>';
CREATE ROLE app_node  LOGIN NOSUPERUSER NOCREATEROLE NOBYPASSRLS PASSWORD '<app-password>';
CREATE DATABASE blk OWNER blk_owner;
\c blk
ALTER SCHEMA public OWNER TO blk_owner;
REVOKE ALL ON SCHEMA public FROM PUBLIC;
GRANT USAGE ON SCHEMA public TO app_node;
```

`blk_owner` is used only to create tables during upgrades. `app_node` is the only account the app uses while running, and it is always limited by branch. Do not give `app_node` superuser rights.

**Step 3. Install**

```bash
bash tools/install.sh --db external
```

The script asks a few questions (the PostgreSQL server, the `app_node` and `blk_owner` passwords from Step 2, the worker machine IP, the AD server, the time zone), then creates `server/.env`, the secret keys and a temporary self-signed certificate, and starts everything. Running it again is always safe (existing keys are kept).

**Step 4. Check.** The script prints `OK` when it runs. Open `https://<server name>/`, sign in with `admin` / `admin` and change the password right away.

**Step 5. Next.** The keys have been generated for you in `server/.env`.

- Get `INGEST_API_KEY` to paste into the worker configuration: `grep ^INGEST_API_KEY= server/.env`.
- Keep a copy of `SECRET_KEY` in the password vault (`grep ^SECRET_KEY= server/.env`); if it is lost, the mail, backup and two-step passwords must be entered again.

Then install the worker (section 4 or 4B) and configure the application (section 5).

**Options** (full list: `bash tools/install.sh --help`):
- Real certificate: put `server.crt` and `server.key` in `cert/` before running (section 3.5).
- Self-signed certificate: type the exact access name when the script asks; the worker must trust `cert/ca.crt` (`Ingest.CaFile`).
- Other ports: `--https-port 8444 --ingest-port 9443 --http-port 8080` (defaults 443, 8443, 80).
- Backup: use the read-only account `blk_backup` (SQL in section 6.8) and run the script with `BLK_BACKUP_PASSWORD=...`; if left empty, `blk_owner` is used for now.
- Without typing anything: `BLK_APP_PASSWORD=... BLK_OWNER_PASSWORD=... bash tools/install.sh --db external --db-host db.corp.local --worker-ips 10.0.5.21 --yes --up`.

### 3.3. Way B: Docker Compose + PostgreSQL in Docker

**Preparation:** a Linux server with Docker (`docker compose`) and `git` installed. No separate PostgreSQL is needed: Compose starts a PostgreSQL 17 container itself and keeps the data in the `data/postgres` folder inside the install folder (no volume).

**Step 1. Get the source code**

```bash
git clone git@github.com:vietcf/bitlocker-ad-sync.git blk && cd blk
```

**Step 2. Install**

```bash
bash tools/install.sh --db docker
```

The script asks for the worker machine IP, the AD server (may be left empty) and the time zone, then does everything: database passwords generated in `server/db.env`, `server/.env`, secret keys, a temporary self-signed certificate, start-up.

**Running it again:** if there is no `data/postgres` yet (no database), the script **stops the project's old containers** (if any; it does not touch other projects), then **deletes the old configuration** (`server/.env`, `server/db.env`, `.env`, `nginx/redirect.conf`) and creates everything anew. If `data/postgres` exists, the script **warns and exits** without touching the configuration or the running database. To reinstall from scratch: `docker compose -f docker-compose.prod.yml --profile db down && rm -rf data` (**the database is lost**), then run it again. To update to a new version and keep the configuration: add `--update` (section 3.7). From now on every `docker compose` command of this way needs `--profile db` added.

**Step 3. Check.** The script prints `OK` when it runs. Open `https://<server name>/`, sign in with `admin` / `admin` and change the password right away.

**Step 4. Next.** The keys have been generated for you in `server/.env`.

- Get `INGEST_API_KEY` to paste into the worker configuration: `grep ^INGEST_API_KEY= server/.env`.
- Keep a copy of `SECRET_KEY` (`grep ^SECRET_KEY= server/.env`) and `server/db.env` in the password vault.

Then install the worker (section 4 or 4B) and configure the application (section 5).

**Options** (full list: `bash tools/install.sh --help`): a real certificate (`server.crt`, `server.key` into `cert/` before running, section 3.5); a self-signed certificate (type the exact access name, the worker trusts `cert/ca.crt` through `Ingest.CaFile`); other ports (`--https-port 8444 --ingest-port 9443 --http-port 8080`); without typing anything (`bash tools/install.sh --db docker --worker-ips 10.0.5.21 --yes --up`).

### 3.4. Way C: No Docker (Node.js + systemd + nginx)

**Preparation:** a Linux server with root access; a PostgreSQL 17 machine that this server can reach; install **Node.js 24**, **nginx** and `git`. For the database backup to work, also install `pg_dump` version 17 (package `postgresql-client-17`).

**Step 1. Get the source code and install the libraries**

```bash
sudo git clone git@github.com:vietcf/bitlocker-ad-sync.git /opt/blk
cd /opt/blk/server && sudo npm ci --omit=dev
```

**Step 2. Create the database:** do exactly as in Step 2 of way A (the same SQL, run as a superuser on the external PostgreSQL).

**Step 3. Create `server/.env` and the secret keys**

```bash
cd /opt/blk && sudo cp server/.env.example server/.env && sudo chmod 600 server/.env
set_env() { if sudo grep -q "^$2=" "$1"; then sudo sed -i "s|^$2=.*|$2=$3|" "$1"; else echo "$2=$3" | sudo tee -a "$1" >/dev/null; fi; }
for k in SESSION_SECRET SECRET_KEY INGEST_API_KEY; do set_env server/.env $k $(openssl rand -hex 32); done
```

**Step 4. Fill in `server/.env`.** `server/.env.example` already has many lines with values meant for a dev machine (for example `NODE_ENV=development`, `USER_HOST=127.0.0.1`). So **do not paste more lines at the end of the file** (they would duplicate): the function `set_env <file> <KEY> <value>` below **changes the value if the line exists and adds a new line if it does not**. Just paste the whole block into the terminal. It differs from way A in that the app listens only on `127.0.0.1` (nginx in front, on the same machine) and the ingest port is 8444 (to leave port 8443 to nginx). Edit the values under "change to match your environment", then paste the whole block:

```bash
E=server/.env
# --- way C (keep as is) ---
set_env $E NODE_ENV production
set_env $E USER_HOST 127.0.0.1
set_env $E USER_PORT 3000
set_env $E INGEST_HOST 127.0.0.1
set_env $E INGEST_PORT 8444
set_env $E TRUST_PROXY 1
set_env $E INGEST_TRUST_PROXY 1
set_env $E COOKIE_SECURE true
set_env $E APP_TZ Asia/Ho_Chi_Minh
set_env $E BACKUP_DIR /opt/blk/backups
set_env $E BACKUP_DATABASE_URL "postgres://blk_owner:OWNER_PASSWORD@db.corp.local:5432/blk?sslmode=require"   # database backup; better switch to the read-only account blk_backup (section 6.8)
# --- change to match your environment ---
set_env $E INGEST_ALLOWED_IPS 10.0.5.21
set_env $E DATABASE_URL "postgres://app_node:APP_PASSWORD@db.corp.local:5432/blk"
set_env $E MIGRATION_DATABASE_URL "postgres://blk_owner:OWNER_PASSWORD@db.corp.local:5432/blk"
set_env $E DB_SSL true
set_env $E LDAP_SERVERS dc01.corp.local,dc02.corp.local
set_env $E LDAP_PROTOCOL ldap
set_env $E LDAP_DOMAIN corp.local
set_env $E LDAP_BASE_DN "DC=corp,DC=local"
set_env $E LOCAL_LOGIN_ENABLED true
```

**Step 5. Create the tables (migration)**

```bash
cd /opt/blk/server && sudo npm run migrate
```

**Step 6. Run the app with systemd.** Create `/etc/systemd/system/blk.service`:

```ini
[Unit]
Description=BitLocker Key Management
After=network-online.target

[Service]
WorkingDirectory=/opt/blk/server
# Path of node: check with which node
ExecStart=/usr/bin/node --env-file=.env src/index.js
Restart=always
User=blk
Group=blk

[Install]
WantedBy=multi-user.target
```

```bash
sudo useradd --system --home /opt/blk --shell /usr/sbin/nologin blk
sudo mkdir -p /opt/blk/backups && sudo chown -R blk:blk /opt/blk/backups /opt/blk/server/.env
sudo systemctl daemon-reload && sudo systemctl enable --now blk
```

**Step 7. HTTPS certificate and nginx.** Put `server.crt` (with the intermediate CA chain) and `server.key` in `/etc/nginx/cert/`. If there is no real certificate yet, create a temporary one with `bash /opt/blk/cert/generate-self-signed.sh blk.corp.local 10.0.5.10`, then copy the two files `server.crt` and `server.key` from `/opt/blk/cert/` to `/etc/nginx/cert/`. Use the project's sample configuration and change the two app addresses:

```bash
sudo mkdir -p /etc/nginx/cert
sudo cp /opt/blk/nginx/nginx.conf /etc/nginx/nginx.conf
sudo sed -i 's/server server:3000;/server 127.0.0.1:3000;/; s/server server:8443;/server 127.0.0.1:8444;/; s|access_log /dev/stdout main;|access_log /var/log/nginx/blk-access.log main;|; s|error_log  /dev/stderr warn;|error_log /var/log/nginx/blk-error.log warn;|' /etc/nginx/nginx.conf
sudo nginx -t && sudo systemctl enable --now nginx && sudo systemctl reload nginx
```

**Step 8. Check**

```bash
curl -k https://localhost/healthz
```

It must return HTTP 200 with `"dbOk": true`. Then open `https://<server name>/` and sign in with `admin` / `admin` (**change the password right away**). App log: `journalctl -u blk -f`.

**Step 9. Next:** install the sync worker (section 4 for Windows or 4B for Linux) and configure the application (section 5). This way updates versions by hand (`git pull`, `npm ci --omit=dev`, `npm run migrate`, `systemctl restart blk`); it is the least supported way, so prefer way A.

### 3.5. Real HTTPS certificate

nginx uses one certificate for both the web (443) and ingest (8443). Replace the two files in `cert/`:

- `server.crt`: the certificate (PEM). With an intermediate CA, join them: `cat cert.crt intermediate.crt > server.crt`.
- `server.key`: the private key, matching the certificate.

Then reload nginx (no interruption):

```bash
docker compose -f docker-compose.prod.yml exec nginx nginx -s reload   # way A, B
sudo systemctl reload nginx                                            # way C (files in /etc/nginx/cert/)
```

Worker: `Ingest.BaseUrl` uses exactly the name in the certificate (not an IP); a worker machine that does not trust the CA sets `Ingest.CaFile`. Renewal: replace the two files again and reload nginx. The error `key values mismatch` means the key does not match the certificate.

### 3.6. Updating the version

**Renaming or moving the install folder:** keep the `.env` file (it has the `COMPOSE_PROJECT_NAME` line, written by `install.sh`). The database lives in `data/postgres` inside the install folder, so moving the whole folder (including `data/`) takes the data along; that line keeps the Compose project name so the containers are not renamed.

Back up the database first (in the application: Admin > Backup). With Docker Compose **migrations run by themselves**: the new version is built, creates the new tables, and only then starts; if a migration fails the server does not come up and the old version stays as it was. Migrations only add, old files are never edited. Do this in the project folder:

```bash
git pull
# Way A (external DB):
docker compose -f docker-compose.prod.yml up -d --build
# Way B (DB in Docker):
docker compose -f docker-compose.prod.yml --profile db up -d --build
```

Every version has notes in `CHANGELOG.md`; its **Upgrade notes** section says whether `.env` must be edited.

**Versions.** Following [Semantic Versioning](https://semver.org/) (`MAJOR.MINOR.PATCH`), recorded in [CHANGELOG.md](CHANGELOG.md) and shown in the page footer. Releasing (maintainers):

```bash
# 1. edit "version" in server/package.json (and package-lock.json), update CHANGELOG.md; run all the tests
# 2. commit, add a tag (a trial version uses the suffix -rc.1) and push
git commit -am "release: 1.0.0" && git tag -a v1.0.0 -m "1.0.0" && git push origin main v1.0.0
```


### 3.7. Installing on a server without internet (LAN)

Build the images on a machine with internet, pack them into one file, copy it to the server and load it into Docker. The server needs only Docker (with `docker compose`), no `git`, no source code and no internet. Both machines must have the same CPU architecture (both amd64 or both arm64).

**On the machine with internet** (needs Docker and `git`):

1. Get the source code and (if you want a specific version) choose a tag:

   ```bash
   git clone git@github.com:vietcf/bitlocker-ad-sync.git blk && cd blk
   git checkout v2.0.2        # the version tag to install; drop this line to take the latest
   ```

2. Pack:

   ```bash
   bash tools/build-offline.sh           # includes the PostgreSQL image (way B: DB in Docker)
   bash tools/build-offline.sh --no-db   # without it (way A: external DB, smaller)
   ```

   The script builds the app image, downloads the nginx image (and PostgreSQL), then creates `dist/offline/blk-offline-<version>.tar.gz` (about 240 MB) with a `.sha256` file. The package holds the images, `docker-compose.prod.yml`, `nginx/nginx.conf`, the `.env` samples, the loading script `load.sh`, the README files and `INSTALL.txt`.

3. Copy `blk-offline-<version>.tar.gz` to the server (USB, `scp`...). Copy the `.sha256` file too, to check it: `sha256sum -c blk-offline-<version>.tar.gz.sha256`.

**On the LAN server:**

4. Extract and load the images (the script checks the SHA-256 of the files in the package):

   ```bash
   tar xzf blk-offline-2.0.2.tar.gz && cd blk-offline-2.0.2
   bash load.sh
   ```

5. Install (the script asks a few questions, creates `server/.env` with the right values, offers to create a temporary self-signed certificate if there is none, then starts with `--no-build` so Compose does not try to build or download anything from the network):

   ```bash
   bash install.sh --db external     # way A: external PostgreSQL (the database created as in Step 2 of section 3.2)
   bash install.sh --db docker       # way B: PostgreSQL in Docker
   ```

   To use a real certificate, put `server.crt` and `server.key` in `cert/` before running. Other options: `bash install.sh --help`.

6. Check: the script prints `OK` when `healthz` returns `"dbOk": true`; or `curl -k https://localhost/healthz`.

**Updating to a new version** (server without internet). Extract **over the running folder itself**, do not create a new folder: the database lives in `data/postgres` inside the running folder, a new folder would get an empty DB and its ports would clash with the old containers.

1. On the machine with internet: take the new tag (`git fetch --tags && git checkout vX.Y.Z`), run `bash tools/build-offline.sh` (add `--no-db` if the DB is outside Docker), copy `blk-offline-X.Y.Z.tar.gz` to the server. Rebuild the package for every version, because the package carries the images and the new `install.sh`.
2. On the server: **back up the database first** (Admin > Backup > run now).
3. Go to the running folder (where `server/.env` is) and extract over it. The package holds only sample files (`.env.example`...), it does not overwrite your `server/.env`, `server/db.env`, `cert/server.*` (but `docker-compose.prod.yml` and `nginx/*.conf` are replaced by the new ones: save a copy first if you edited them by hand). Then load the images:

   ```bash
   cd /path/to/the-running-folder
   tar xzf /where/it/is/blk-offline-X.Y.Z.tar.gz --strip-components=1
   bash load.sh
   ```

4. Run the installer again with `--update`: it keeps the existing keys and only adds missing lines (for example `BACKUP_DATABASE_URL`), then starts with the images just loaded (no build). Without `--update`, if `data/postgres` exists, the script only warns and exits:

   ```bash
   bash install.sh --db docker --update --up     # DB outside Docker: --db external --up
   ```

5. Check: `docker compose -f docker-compose.prod.yml --profile db ps` (`db`, `server`, `nginx` are `Up (healthy)`, `migrate` is `Exited (0)`) and the server log shows the right version (`docker compose -f docker-compose.prod.yml logs --tail=20 server`). Migrations run automatically when `migrate` runs.

6. **Update the worker** (after the server): on the build machine run `cd worker-go && make package VERSION=X.Y.Z`, copy `worker-go/dist/blk-sync-X.Y.Z-linux-amd64.tar.gz` to the worker machine, then:

   ```bash
   mkdir /tmp/blk-sync && tar -C /tmp/blk-sync -xzf /tmp/blk-sync-X.Y.Z-linux-amd64.tar.gz
   cd /tmp/blk-sync && sudo ./install.sh --update
   ```

   .NET worker on Windows: section 4.7. Details: section 4B.9.
7. If the new version reads more data from AD (for example the last AD sign-in, from server 2.7.0 and worker 1.2.0): go to **Admin > AD sync** and click **Full sync** (or wait for 01:00) to fill the data for every computer.

Do not delete the `data/` folder: it is the whole database.

**Rolling back to the old version:** the old version's image is still in Docker if you have not removed it. Run `BLK_VERSION=2.0.1 docker compose -f docker-compose.prod.yml up -d --no-build` (change `2.0.1` to the old tag). Note that the new version's migrations have already run and are not undone, so roll back only if the old version works with the new schema, or restore the database from the backup made before the upgrade.

---

## 4. Install the sync worker on Windows

There are two workers that do the same job. Install only **one**:

- **Windows (.NET)**: this section. Supports gMSA, and Kerberos encrypts the session by itself on port 389.
- **Linux (Go)**: section [4B](#4b-install-the-sync-worker-on-linux-go-version). One executable file, systemd.
  Plain LDAP by default (389, not encrypted); encryption (LDAPS) needs a DC with a certificate.

### 4.1. Grant AD permissions to the worker account

Use a gMSA if you can. This account must be able to read computer objects (by default anyone in the domain can)
and the confidential attribute `msFVE-RecoveryPassword`, **only in the computer OUs**. Do not grant Domain
Admin.

```powershell
# Create the gMSA (once, on a machine with RSAT AD)
New-ADServiceAccount gmsa-blk -DNSHostName gmsa-blk.corp.local `
  -PrincipalsAllowedToRetrieveManagedPassword 'BLK-SYNC-01$'

# Grant permission to read the objects and the attribute that holds the key (do it for each computer OU)
dsacls "OU=Computers,DC=corp,DC=local" /I:S /G "CORP\gmsa-blk$:RP;;msFVE-RecoveryInformation"
dsacls "OU=Computers,DC=corp,DC=local" /I:S /G "CORP\gmsa-blk$:CA;msFVE-RecoveryPassword;msFVE-RecoveryInformation"

# On the worker server
Install-ADServiceAccount gmsa-blk
```

Without a gMSA, create an ordinary domain account used only by the worker, for example `CORP\svc-blk`,
then run the two `dsacls` commands above with `CORP\svc-blk` in place of `CORP\gmsa-blk$`. Do not use a
personal account or an admin account. How to run the service with this account: section 4.6.

### 4.2. Build and copy to the worker server

On a machine with the .NET SDK 10:

```powershell
cd worker
dotnet publish src/BitlockerSync.Worker -c Release -o .\publish
```

Copy the `publish` folder (with the `scripts` folder) to the worker machine, for example to `C:\BitlockerSync`.

### 4.3. Storing secrets

Write them straight into `appsettings.json`: `Ingest:ApiKey` (the server's `INGEST_API_KEY`) and `Ldap:Password` if you use a user + password instead of a gMSA. `install-service.ps1` locks the permissions of this file (only Administrators, SYSTEM and the service account can read it).

### 4.4. Edit `C:\BitlockerSync\appsettings.json`

```jsonc
{
  "Ldap": {
    "Source": "Ldap",
    "Servers": [ "dc01.corp.local", "dc02.corp.local" ],   // the first DC is the main one, the others are backups
    "Protocol": "Ldaps",          // Ldaps (636, recommended) | StartTls (389 + TLS) | Ldap (389)
    "Auth": "Negotiate",          // Negotiate: use the account the service runs as (gMSA) or Username/Password
                                  // Basic: simple bind with Username/Password
    "Username": "",               // leave empty with a gMSA; for example "CORP\\svc-blk"
    "Password": "",               // the password if there is a Username
    "BaseDn": "DC=corp,DC=local",
    "SearchBases": [],            // empty = the whole BaseDn; or the list of OUs you are allowed to read (see below)
    "ExcludeOperatingSystems": [],  // optional: skip computers by operating system, for example ["Windows Server*"] (see below)
    "PageSize": 1000,
    "TimeoutSeconds": 60,
    "AllowInsecure": false
  },
  "Ingest": {
    "BaseUrl": "https://blk.corp.local:8443/api/ingest",
    "ApiKey": "INGEST_API_KEY",          // the server's INGEST_API_KEY value (the only way to authenticate)
    "CaFile": "",                        // root CA in PEM format if Windows does not trust the server certificate
    "BatchSize": 500,
    "RetryForMinutes": 60
  },
  "Schedule": {
    "DeltaEveryMinutes": 15,      // delta sync: reads only the changed objects
    "FullAt": "01:00",            // full sync every night
    "HeartbeatEveryMinutes": 5,
    "WorkerId": ""                // empty = the machine name
  }
}
```

**Reading several OUs (`SearchBases`).** When the worker account may read only a few OUs, list them (the OUs must be inside `BaseDn`; an OU that duplicates, or is a child of, an OU already listed is skipped):

```jsonc
"SearchBases": [ "OU=Computers,OU=HN,DC=corp,DC=local", "OU=Computers,OU=HCM,DC=corp,DC=local" ]
```

**Skipping Servers (optional, `ExcludeOperatingSystems`).** By default the worker reads every computer object in scope, Windows Server included. To follow only workstations when Servers sit in the same OU, list the operating-system patterns to skip (`*` is a wildcard, not case sensitive):

```jsonc
"ExcludeOperatingSystems": [ "Windows Server*" ]
```

A computer that matches a pattern is skipped together with its key; a computer that has no operating-system attribute in AD is still read. Empty (the default) reads everything. A simpler way is to put only the workstation OUs in `SearchBases`. Note when turning this on in a running system: Servers synced earlier will be treated as "No longer in the monitored scope" in the next full run (their data and keys are kept), and if there are many computers that run may be held for approval: go to Admin > AD sync to accept. This option does not apply to the `JsonFile` source (used only in development).

- Each run reads the OUs one by one and sends them to the server as one run.
- If one OU cannot be read (it does not exist, or permission is missing) the **whole run stops** with `ldap_search_base_failed` and the OU name in the log, it is not skipped, because skipping would make the full run treat every computer in that OU as "out of scope".
- A computer outside every OU in the list is not seen by the worker and, after the full run, is marked "No longer in the monitored scope"; add the OU and the computer comes back by itself.

Table for choosing the LDAP connection:

| Protocol | Auth | Use when |
| --- | --- | --- |
| `Ldaps` | `Negotiate` | **Recommended for production**: use a gMSA and a TLS-encrypted channel |
| `Ldaps` / `StartTls` | `Basic` | User + password over a TLS channel |
| `Ldap` | `Negotiate` | Lab, when the DC has no certificate yet. Kerberos signing + sealing encrypts the session |
| `Ldap` | `Basic` | Sends the password and keys in clear text. The worker refuses to run unless `AllowInsecure: true` (lab use only) |

### 4.5. Check before installing the service

```powershell
.\BitlockerSync.Worker.exe check
```

The command connects to the DC, reads RootDSE, then tries to read a few computers and keys in **each OU** of `SearchBases` and prints `OK` / `FAIL` with the reason (exit code 4 when there is a `FAIL`). It also reports the LDAPS certificate expiry and warns about keys whose password cannot be read (missing permission, see 4.1). It runs as the account you are signed in with, so the permissions may differ from the service account (gMSA); it does not call the server (check the server connection with `run-once`).

Try a full run (no service needed):

```powershell
.\BitlockerSync.Worker.exe run-once full
```

### 4.6. Install the Windows Service

Choose one of the three ways to read AD, edit `appsettings.json` to match, then run `scripts\install-service.ps1` (already in the worker package) in PowerShell as Administrator.

| Way | Service runs as | `Ldap:Auth` | `Ldap:Username` / `Ldap:Password` | Where the password lives |
| --- | --- | --- | --- | --- |
| **A. gMSA** (recommended) | `CORP\gmsa-blk$` | `Negotiate` | empty | AD manages and rotates it |
| **B. Domain account runs the service** | `CORP\svc-blk` | `Negotiate` | empty | Windows stores it when the service is installed |
| **C. User + password in the config file** | `NT SERVICE\BitlockerSync` (virtual account) | `Negotiate` or `Basic` | `CORP\svc-blk` / password | `appsettings.json` (file permissions locked) |

**Way A (gMSA)** and **way B (domain account)**:

```powershell
C:\BitlockerSync\scripts\install-service.ps1 -Account 'CORP\gmsa-blk$' -InstallDir C:\BitlockerSync   # A
C:\BitlockerSync\scripts\install-service.ps1 -Account 'CORP\svc-blk'   -InstallDir C:\BitlockerSync   # B (the script asks for the password)
Start-Service BitlockerSync
```

Notes for way B:

- The account needs the **Log on as a service** right. If `Start-Service` fails with error 1069, grant it in `secpol.msc` > User Rights Assignment (if a GPO manages this right, add it in the GPO, because adding it on the machine is overwritten by the GPO).
- When the `svc-blk` password is changed in AD, run the script again (or `services.msc` > BitlockerSync > Log On) and restart the service; if forgotten, the watchdog alerts "Sync worker is not sending heartbeats".
- Set a long random password and remove interactive sign-in rights (Deny log on locally / through Remote Desktop).

**Way C (user + password in `appsettings.json`)**: the service runs as a virtual account and needs no password; the worker binds to LDAP with the user and password in the file. It is also the only way when the worker machine is **not joined to the domain**.

1. Edit `appsettings.json`:

   ```jsonc
   "Ldap": {
     "Protocol": "Ldaps",
     "Auth": "Negotiate",            // or "Basic" (simple bind, requires Ldaps or StartTls)
     "Username": "CORP\\svc-blk",    // or "svc-blk@corp.local"; in JSON it must be written \\
     "Password": "AD_PASSWORD",
     ...
   }
   ```

2. Install the service: `C:\BitlockerSync\scripts\install-service.ps1 -Account 'NT SERVICE\BitlockerSync' -InstallDir C:\BitlockerSync`, then `Start-Service BitlockerSync`.

- The password is in `appsettings.json`, so the script locks this file's permissions (only Administrators, SYSTEM and the service account). Do not copy the file where others can read it.
- To change the `svc-blk` password in AD: edit `Ldap:Password`, `Restart-Service BitlockerSync`.
- A machine not joined to the domain: use `Ldaps`, set `Ldap:Servers` to DC names that resolve, and import the CA that issued the DC's LDAPS certificate into `LocalMachine\Trusted Root Certification Authorities`.

**After installing (all three ways)**

- The script grants the service account write access to `C:\ProgramData\BitlockerSync`, then runs `check` as the Administrator account you are using; with way A or B the service's AD read permissions may differ from the `check` result. Look at the log after the first full run: if some keys cannot be read, check the permissions in section 4.1.
- To change the way (for example B to A): run the script again with the new `-Account`; the script updates the existing service.
- Logs are in Event Viewer > Windows Logs > Application, source `BitlockerSync` (they never contain keys).
- Schedule: heartbeat every 5 minutes, delta every 15 minutes, full at 01:00 and right at the first start. Admin HQ can also click request sync in Admin > AD sync; the worker runs it at the next heartbeat.

### 4.7. Updating the worker to a new version

Update the **server first, the worker after** (a new server accepts data from an old worker; the opposite is not guaranteed).

1. Build on a machine with the .NET SDK 10 and copy `publish-1.1` to the worker machine (for example `D:\drop\BitlockerSync-1.1`):

   ```powershell
   cd worker
   dotnet publish src/BitlockerSync.Worker -c Release -o .\publish-1.1
   Copy-Item .\scripts .\publish-1.1\scripts -Recurse
   ```

2. On the worker machine, PowerShell as Administrator (better to use the new version's script):

   ```powershell
   D:\drop\BitlockerSync-1.1\scripts\update-worker.ps1 -Source D:\drop\BitlockerSync-1.1 -InstallDir C:\BitlockerSync
   ```

   The script: backs up `C:\BitlockerSync` to `.bak-<date-time>`; stops the service (a run in progress is closed with status `cancelled`, no alert, and the next run reads the missing part again); copies the new version over **except `appsettings.json`** (keeping the configuration, secrets and permissions; the new sample is saved as `appsettings.new.json`); runs `check` (on failure it **leaves the service stopped** so you can fix it or go back); starts the service again. The sync state (`state.json`) is unchanged so delta continues from the old mark; there is no need to run `install-service.ps1` again.

3. Check: compare `appsettings.new.json` with `appsettings.json`, copy by hand any new settings you want, then `Restart-Service BitlockerSync` (missing settings use their defaults); the next sync run reports `success` (Event Viewer, source `BitlockerSync`) and Admin > AD sync shows a new heartbeat (click request sync to check at once). If the new version reads more AD attributes, old data is filled in only at the next **full** run (01:00) unless you click request full sync.

**Go back to the old version** if there is an error:

```powershell
Stop-Service BitlockerSync
Rename-Item C:\BitlockerSync C:\BitlockerSync.failed
Rename-Item C:\BitlockerSync.bak-20261013-0930 C:\BitlockerSync    # the exact backup folder name
Start-Service BitlockerSync
```

Delete old `.bak-*` folders once things are stable (they hold an `appsettings.json` with secrets).

---

## 4B. Install the sync worker on Linux (Go version)

This guide is independent of section 4 (the .NET worker). More details in [worker-go/README.md](worker-go/README.md),
all configuration keys in [worker-go/docs/configuration.md](worker-go/docs/configuration.md).

### 4B.1. Requirements

| Item | Requirement |
| --- | --- |
| Worker server | 64-bit Linux with systemd, amd64 or arm64: Ubuntu 22.04+, Debian 12+, RHEL/Rocky 9+, and also **CentOS/RHEL 7** (systemd 219, the install script uses its own unit file). **No libraries or Go to install**: the binary is static |
| Network | To the DC: 636 (LDAPS) or 389 (StartTls / Ldap). To the server: the ingest port (default 8443) |
| Build machine | Go 1.26+, needed only on the build machine. Build on any machine (Windows, Linux including CentOS 7.6) and copy the package to the worker server |
| AD | An ordinary service account (the Go version cannot use a gMSA) |

### 4B.2. Choose how to connect to AD

| `Ldap.Protocol` | Port | Encryption | Condition |
| --- | --- | --- | --- |
| `Ldap` (**default**) | 389 | **None**: the account password and every recovery key travel in clear text | Nothing needed on AD; use only on a trusted network (below) |
| `Ldaps` | 636 | Yes | The DC has a TLS certificate, the Linux machine trusts its CA |
| `StartTls` | 389 | Yes | Same as above |

The default works right away with nothing changed on AD, but writes an "unencrypted" warning to the log on every connection. To encrypt, issue a certificate to the DC (AD CS template *Domain Controller Authentication*, the DC name in the SAN) and change `Protocol` to `Ldaps`. Check whether the DC already has a certificate: `openssl s_client -connect dc01.corp.local:636 </dev/null` (printing a certificate is fine; being disconnected at once means none). With `Ldaps`/`StartTls` use the DC **name**, not an IP.

**Unencrypted LDAP (the default) only on a trusted network:**

```jsonc
"Ldap": {
  "Servers": [ "dc01.corp.local", "dc02.corp.local" ],
  "Protocol": "Ldap",
  "Username": "svc-blk@corp.local",
  "Password": "AD_PASSWORD",
  "BaseDn": "DC=corp,DC=local"
}
```

The password and recovery keys travel in clear text on the worker - DC segment, so all of the following are needed:

- The worker is in the same VLAN/segment as the DCs (or a management VLAN), not across the user network, Wi-Fi or a WAN.
- The firewall opens only 389 to the DCs in `Ldap.Servers`.
- No port mirroring/IDS that stores payloads on this segment (if there is one, treat it as a system that holds keys).
- The AD reading account has minimum rights, no interactive sign-in, a periodically changed password; alert when it signs in from another machine (event 4624 on the DC).

The connection to the server (ingest) is still over **HTTPS** with an API key. If the DC later requires LDAP signing, the DC refuses simple bind on 389: the worker reports `ldap_bind_failed` (LDAP 8) and the alert shows in Admin > AD sync; then issue a certificate to the DC and change `Protocol` to `Ldaps` (a configuration change only).

### 4B.3. Create the AD reading account

Create an ordinary domain account, for example `CORP\svc-blk`, with a long password. Grant the right to read keys **only in the computer
OUs** (run on a machine with RSAT AD, for each OU):

```powershell
dsacls "OU=Computers,DC=corp,DC=local" /I:S /G "CORP\svc-blk:RP;;msFVE-RecoveryInformation"
dsacls "OU=Computers,DC=corp,DC=local" /I:S /G "CORP\svc-blk:CA;msFVE-RecoveryPassword;msFVE-RecoveryInformation"
```

Do not use a personal or admin account. Block interactive sign-in for this account.

### 4B.4. Build the install package

The binary is **static** (`CGO_ENABLED=0`): it does not depend on system libraries or the glibc version, so build once and copy to the worker server and it runs at once, even on an old machine such as CentOS 7 (tested on CentOS 7.9, glibc 2.17). The worker server needs no Go and no internet. Only the **build machine** needs Go 1.26+.

On the build machine (Linux, including CentOS 7.6 with Go installed; or Windows):

```bash
cd worker-go
go test ./...
make package VERSION=1.3.0
```

Result: `worker-go/dist/blk-sync-1.3.0-linux-amd64.tar.gz`. The package contains:
- the `blk-sync` binary (static build);
- `install.sh`, `blk-sync.service` (new systemd) and `blk-sync-legacy.service` (old systemd such as CentOS 7);
- `config.example.json`, `README.md`.

For an ARM target server use `make linux-arm64`. Without `make` (Windows): run directly `CGO_ENABLED=0 GOOS=linux GOARCH=amd64 go build -trimpath -ldflags "-s -w -X main.version=1.1.1" -o dist/blk-sync ./cmd/blk-sync`, then copy the binary together with the `deploy/` folder and `config.example.json` (see section 4 of [worker-go/README.md](worker-go/README.md)).

### 4B.5. Install on the server

```bash
scp worker-go/dist/blk-sync-1.3.0-linux-amd64.tar.gz admin@sync01:/tmp/
ssh admin@sync01
mkdir /tmp/blk-sync && tar -C /tmp/blk-sync -xzf /tmp/blk-sync-1.3.0-linux-amd64.tar.gz
cd /tmp/blk-sync && sudo ./install.sh
```

The script creates the system user `blk-sync` and installs the files. It detects systemd by itself: from v250 it uses `blk-sync.service`; older (CentOS/RHEL 7 is v219) it uses `blk-sync-legacy.service` and creates `/var/lib/blk-sync` ahead of time. Both take their secrets from `config.json` (section 4B.7).

| File | Contents |
| --- | --- |
| `/opt/blk-sync/blk-sync` | Binary |
| `/etc/blk-sync/config.json` | Configuration (copied from `config.example.json` if missing) |
| `/etc/systemd/system/blk-sync.service` | systemd unit with hardening (the new or the old-systemd version, depending on the machine) |
| `/var/lib/blk-sync/state.json` | State; systemd creates the folder when it runs |

The service is not enabled yet.

### 4B.6. Edit the configuration

```bash
sudo nano /etc/blk-sync/config.json
```

The keys to edit:

```jsonc
"Ldap": {
  "Servers": [ "dc01.corp.local", "dc02.corp.local" ],
  "Protocol": "Ldap",                     // default (389, unencrypted); Ldaps/StartTls when the DC has a certificate
  "Username": "svc-blk@corp.local",
  "Password": "AD_PASSWORD",              // written directly, section 4B.7
  "BaseDn": "DC=corp,DC=local",
  "SearchBases": [],                      // or the list of OUs the account may read
  "ExcludeOperatingSystems": [],          // optional: skip computers by operating system, for example ["Windows Server*"]
  "CaFile": ""                            // PEM file of the CA, if the machine does not trust the DC's CA
},
"Ingest": {
  "BaseUrl": "https://blk.corp.local:8443/api/ingest",
  "ApiKey": "INGEST_API_KEY"              // written directly, taken from server/.env
}
```

**Authentication with the server: HTTPS + API key** (`INGEST_API_KEY` in `server/.env`), and (optionally) the server accepts only from the worker
machine's IP: add that IP to `INGEST_ALLOWED_IPS`. **Empty = any IP** (HTTPS and the API key are still required). If the worker machine does not trust the CA of the server certificate, set
`Ingest.CaFile` (section 3.5).

**Worker installed on the same machine as Docker (the app server), when IP filtering is on.** If `INGEST_ALLOWED_IPS` is empty, skip this. A connection from the host to port 8443 goes through the Docker bridge, so the server sees the source IP as the **gateway of the Docker network** (usually `172.18.0.1`), not the machine's IP. The server log shows `ingest: address not allowed` and the worker gets 403. Get the gateway with `docker network inspect <folder-name>_default --format '{{(index .IPAM.Config 0).Gateway}}'` and add it to `INGEST_ALLOWED_IPS`: `bash install.sh --db ... --worker-ips <gateway> --up`. A worker on another machine uses that machine's real IP.

### 4B.7. Storing secrets

Write them straight into `/etc/blk-sync/config.json`: `Ldap.Password` (the password of the AD reading account) and `Ingest.ApiKey` (the server's `INGEST_API_KEY`). The file is installed with mode `0640` (owner `root`, group `blk-sync`), readable only by the service. Test: `sudo -u blk-sync /opt/blk-sync/blk-sync --config /etc/blk-sync/config.json check`.

### 4B.8. Check, then enable the service

Run `check` as the service user:

```bash
sudo -u blk-sync /opt/blk-sync/blk-sync --config /etc/blk-sync/config.json check
```

A good result prints `LDAP OK: ...` and one `OK` line per OU. Exit codes:
- `3`: cannot connect or cannot bind (wrong password, the DC has no certificate...);
- `4`: some OU cannot be read.

A key "without a readable password" means missing permission, see 4B.3.

```bash
sudo systemctl enable --now blk-sync
```

```bash
journalctl -u blk-sync -f
```

The first run is a full run. The worker shows in Admin > AD sync with a version ending in `-go`.

**Already running the .NET worker and want to switch to the Go one:** stop and disable the Windows service first
(`Stop-Service BitlockerSync; Set-Service BitlockerSync -StartupType Disabled`). Two workers running at the same time
compete to open a sync run (409 `run_in_progress`; the run of a crashed worker is released by itself after 30 minutes of silence).

### 4B.9. Updating and uninstalling

Update: build the new package (`make package VERSION=1.3.0`), copy it to the server, extract it, then:

```bash
sudo ./install.sh --update
```

The script does, in order:
1. runs `check` with the new version; on failure it stops and changes nothing;
2. stops the service (the worker closes the running run with `cancelled`);
3. replaces the binary, keeping the old one as `blk-sync.previous`;
4. restarts; if the service does not come up it goes back to the old version by itself.

Uninstall:

```bash
sudo systemctl disable --now blk-sync
sudo rm -rf /opt/blk-sync /etc/blk-sync /var/lib/blk-sync /etc/systemd/system/blk-sync.service
sudo systemctl daemon-reload && sudo userdel blk-sync
```

---

## 5. First configuration in the application

1. Sign in with `admin` / `admin` and change the password.
2. **Branches & OUs** (Admin): create the branches and enter the computer OUs, for example `OU=Computers,OU=HN,DC=corp,DC=local`. An OU belongs to one branch; saving assigns the computers by OU at once. A computer outside every OU is **N/A**, visible only to Admin HQ. Deleting a branch: its computers go to N/A, keys and the log are kept, and it cannot be undone.
3. **Users** (Admin): an **AD** account (enter the sAMAccountName, sign in with the Windows password; if it is not created in the app it cannot sign in) or a **local** account (use only for a spare admin). For an AD account, if the full name and email are left empty they are taken from AD, and values you typed are not overwritten; with no email the user receives no mail. A user who already has log lines can only be disabled, not deleted.

   | Role | Rights |
   | --- | --- |
   | `it` | Find computers, reveal the keys of the assigned branches |
   | `lead` | Like `it`, plus the log and reports of the branch |
   | `admin` | Admin HQ: every branch (N/A included) and the whole Admin menu |
   | `auditor` | View the log and reports of the assigned branches, cannot reveal keys |

   Only Admin HQ sees every branch; other roles are assigned **per branch** (two layers of filtering: the query and Row-Level Security). Admin HQ stands alone; in each branch one person has one role.
4. Check sync (Admin > AD sync), set up mail (Admin > Mail server, **Send a test**; Notifications), and Features / Retention (who may export with keys, off by default; how long data is kept).

---

## 6. Daily operations

### 6.0. Delta and full sync

The **monitored scope** is the OUs in the worker's `Ldap.SearchBases`. A computer **"No longer in the monitored scope"** is one the full run no longer sees (deleted from AD or moved outside `SearchBases`). Data and keys are always kept; if the computer shows up again it returns to normal by itself.

The worker runs **delta** every 15 minutes (changed objects only) and **full** every night (`FullAt`, default 01:00).

| Change in AD | Delta | Full |
| --- | --- | --- |
| New computer, rename, move between OUs in scope, new key | Sees it | Sees it |
| Computer deleted, or moved outside `SearchBases` | Does not see it | Sees it (marked "No longer in the monitored scope") |

When an update is needed at once, Admin HQ clicks **Full** in Admin > AD sync > Sync status (the worker does it at the next heartbeat, at most 5 minutes). The **Recent sync runs** table (paged; the number of rows is set in Admin > Features > Display) has a **Computers** column (`+` new, `−` left the scope) and a **Keys** column (`+` new). Click the run ID to see details.

### 6.1. Held sync runs (quarantine)

When a run reports success but the numbers look unusual, the server holds the changes, raises an alert and waits for Admin HQ to decide. By default it holds when: a full run sees fewer than 95% of the computers / keys in the DB; one branch drops by more than 20% **and** more than 10 computers; a full run misses more than 5% of the computers; a key is read but its password is empty (from 1 key). The thresholds and the On/Off switch of each check are in **Admin > AD sync > Sync alerts**.

Handle it in Sync status: click **View details and decide**, then **Accept** (the change is real, for example you just deleted many old computers in bulk) or **Reject** (the data is wrong: a faulty DC, lost permissions; the next full run reads again from the start). New keys in a held run are still saved.

### 6.2. Alerts

The watchdog runs every 5 minutes and sends **one** mail per type when the problem starts, reminds at most once a day, and stops when the problem is gone:

- **Worker offline:** no heartbeat for longer than the threshold (the worker died, the machine is off, no network, wrong API key / IP / certificate).
- **AD sync problem:** the worker runs but AD or the sync has a problem. It covers *system problems* (they end by themselves once fixed) and *data alerts* (a new computer with no key, a rising share of computers without a key, an overdue full sync, a DC certificate about to expire).

Data alerts have two buttons: **Handled** (the cause is fixed: it closes at once, is watched again after 24 hours, and if still true a new alert opens) and **Snooze 1/7/30 days** (the alert stays but is silent). Each alert type and each check has an **On/Off** switch in Sync alerts; when switched off, a real problem is not reported either.

Alert mails come in 4 groups; switch them on/off and choose recipients in Admin > Notifications: Agent stopped working; AD connection and sync problems; Key revealed out of hours and data security; Backup failed.

### 6.3. Sending mail

- Mail is written to the `mail_outbox` table and a job sends it every minute. A temporary error is retried after 1, 5, 15, 60, 240 minutes and then marked failed so Admin HQ can resend it (Admin > Email log). If no mail server is set up yet, mail stays in **Pending**.
- The SMTP password is encrypted with a key derived from `SECRET_KEY` and is never shown again. If the mail server is switched off in Admin, `SMTP_URL` in `.env` is used (if present).
- **New computers / new keys:** after each sync run every recipient gets one combined email within their own scope (except the very first full run). Recovery passwords are **never sent by email**.
- Only active users with an email receive mail.

### 6.4. Finding computers, AD sign-in and exporting data

**Last AD sign-in:** the worker reads `lastLogonTimestamp` (AD updates it slowly, up to ~14 days off). The label is **Recently active** (default within 3 months, changeable in Sync alerts), **Not recently active** or **No data yet**; it only means "no sign-in seen", not that the computer is broken. The filter has a threshold (within / over 1, 3, 6, 9, 12, 24 months) and a **Computers with no data** box (Exclude / Include / Only these). It needs worker 1.2.0 or later and one full run.

Two export buttons, both export the whole list according to the filter and the exporter's branch scope:

| Button | Contents | Who uses it | Log |
| --- | --- | --- | --- |
| **Export CSV** | Computer information, key count. **No keys** | IT, Lead, Admin HQ | `export_computers` |
| **Export with keys** | Every key with its **recovery password** | Per Features: off (default) / Admin HQ only / IT and Admin HQ | one `reveal` per key + `export_keys`; Admin HQ gets an alert |

Exporting with keys requires a reason. **Save the file in a safe place and delete it as soon as you finish.**

### 6.5. Extra computer information and how to search

**Computer serial** and **User email** are entered by people (sync does not overwrite them), edited on the computer detail page (`PUT /api/computers/:id/info`). In the Find computer box: **Key ID** from the first 4 characters; **computer name, serial, email** from any 3 characters (ignoring `-`, `_`, `.` and spaces); **computer GUID** paste the whole GUID.

### 6.6. Mail templates

The content of every email and Teams message is in `server/templates/mail-templates.yaml` (the top of the file has an explanation table). Edit only `subject` / `body`, keep the template names and indentation, and use only variables listed in `variables`. Saving is enough, no restart; if the file is broken the app keeps the last good copy. Test with **Send a test** in Admin > Mail server. Production Docker: mount the file from outside (`-v /etc/blk/mail-templates.yaml:/app/config/mail-templates.yaml:ro` and `MAIL_TEMPLATES_FILE=/app/config/mail-templates.yaml`) so that updating the app does not overwrite it.

### 6.7. Retention

Admin > Retention. The `data-retention` job runs daily (03:00) or when you click **Clean up now**:

| Data | Default |
| --- | --- |
| Access log | Kept forever (optional, from 1 day) |
| Sync history (runs, figures, closed alerts) | 180 days (minimum 30); the latest successful run is always kept |
| Sent / failed emails | 90 days (1–3650) |

Computers, keys and users are never deleted. The access log is append-only: only the oldest continuous part from the start can be removed through `purge_access_log()`, which is itself logged (`log_purge`). Keep a copy of the log in the log collection system (section 6.15) before turning on a retention limit.

### 6.8. Backup and restore

Admin > **Backup** (Admin HQ) creates `.zip` files on a daily schedule or when you click **Back up now**. Two kinds:

| Kind | File | Use when |
| --- | --- | --- |
| Computers and keys | `bitlocker-keys-*.zip` (`computers.csv`, `recovery_keys.csv` with the **recovery passwords**, ...) | Look up a key when the system or the DB is not running |
| Database | `bitlocker-db-*.zip` (`pg_dump` of the whole DB) | Restore the whole system |

- **AES-256 encryption** (on by default, keep it): open with 7-Zip or WinRAR. If off, anyone who has the file can read every key.
- **Password** (≥ 16 characters): stored encrypted, never shown again, not written into the file; **keep it in the password vault**, if lost the files cannot be opened. If you change the password, old files still use the old password.
- The time follows `APP_TZ` (default 01:30, run late if the app was off), the 14 newest of each kind are kept. Files are in `BACKUP_DIR` (Docker: `./backups`) **on the same server**: a job must copy them elsewhere every day.
- If installed with `tools/install.sh`, the database backup is already ready (`BACKUP_DATABASE_URL`, the read-only account `blk_backup`). If installed by hand, create `blk_backup` with `BYPASSRLS` and `SELECT` on the `public` schema, and set `BACKUP_DATABASE_URL` and `BACKUP_DIR` in `server/.env` (outside Docker `pg_dump` 17 is needed). Then open the Backup page: set a password, switch it on, click **Back up now** to test. **Test restoring regularly.**

  Create `blk_backup` (for a manual install):

  ```sql
  CREATE ROLE blk_backup LOGIN NOSUPERUSER NOCREATEROLE BYPASSRLS PASSWORD '<backup-password>';
  \c blk
  GRANT USAGE ON SCHEMA public TO blk_backup;
  GRANT SELECT ON ALL TABLES IN SCHEMA public TO blk_backup;
  GRANT SELECT ON ALL SEQUENCES IN SCHEMA public TO blk_backup;
  ALTER DEFAULT PRIVILEGES FOR ROLE blk_owner IN SCHEMA public GRANT SELECT ON TABLES TO blk_backup;
  ALTER DEFAULT PRIVILEGES FOR ROLE blk_owner IN SCHEMA public GRANT SELECT ON SEQUENCES TO blk_backup;
  ```

**Looking up a key when the system is not running.** Extract `bitlocker-keys-*.zip` with 7-Zip into a folder only you can read, open `recovery_keys.csv` in Excel, filter `key_id_first8` by the 8 characters shown on the BitLocker screen, and read `recovery_password`. When done, **delete** the extracted files.

**Restoring the database.** You need the DB `blk` and the two accounts `blk_owner`, `app_node` (section 3.2 or 3.3). Copy `bitlocker-db-....zip` into `./backups`, then:

```bash
docker compose run --rm --no-deps server node src/cli/restore.js backups/bitlocker-db-20261018-013000.zip
```

The command asks for the file password (or the variable `RESTORE_ZIP_PASSWORD`), checks, loads the data and runs the migrations. If the DB already has data it refuses unless you add `--force`. Other options: `--reset-2fa` (switch off two-step for every user), `--reset-admin` (a new one-time password for the root admin). When done, start the app, sign in and run one full run.

**After restoring.** Passwords stored encrypted in the DB (SMTP, backup, two-step) can only be read on a machine with the same `SECRET_KEY`. On a new machine the command clears the values it cannot read and tells you; go to Admin and enter the mail server password and the backup password again; users with two-step scan the QR code again at their next sign-in.

Keep **separately** from the backup file: `SECRET_KEY`, `server/.env`, the backup password, `cert/` and the worker configuration.

### 6.9. Managing users from the command line

Run on the app server, no web needed: use it when the web is broken, a password is forgotten, a two-step phone is lost or an account is locked. It applies to every account, the root admin included. Each command writes an `admin_change` log line (actor `cli`).

```bash
docker compose exec server node src/cli/users.js list
docker compose exec server node src/cli/users.js create nguyenvana "Nguyen Van A" email=nguyenvana@corp.local it:HN
docker compose exec server node src/cli/users.js create-local backup.admin "Backup admin" email=it-hq@corp.local admin
docker compose exec server node src/cli/users.js reset-password <user>   # local accounts only; a one-time password, must be changed at sign-in
docker compose exec server node src/cli/users.js unlock <user>           # locked after wrong passwords
docker compose exec server node src/cli/users.js reset-2fa <user>        # lost phone: scan a new QR at the next sign-in
docker compose exec server node src/cli/users.js disable-2fa <user>      # switch two-step off completely (turn it on again in Admin > Users)
docker compose exec server node src/cli/users.js enable <user>           # re-enable a disabled account (disable: turn off)
docker compose exec server node src/cli/users.js email <user> <email>
```

AD accounts: the password is managed by AD, `reset-password` does not apply.

### 6.10. Tracing a sync in the log

Every sync run has a **number** `runId` and a **display code** `runRef` in the form `YYYYMMDD-NNNN`. Every change made by sync is written to the application log (JSON, English, `"component":"sync"`, with `runId`): run opened / finished / failed, new computer, rename or branch change, leaving / returning to the scope, new key, anomaly, run held. Trace by `runId`, `name`, `objectGuid` or `keyId`:

```bash
docker compose logs server | grep '"component":"sync"' | grep '"runId":812'
```

**Where the log is:** the app writes to **stdout**, and the runtime keeps and rotates it. Docker: `docker compose logs server` (compose already configures rotation; the default `json-file` without rotation would fill the disk); systemd: `journalctl -u blk`; writing to a file: logrotate `copytruncate`. To keep it for long, forward it to a log collection system (section 6.15).

### 6.11. The Reports page

For Lead, Admin HQ and Auditor, within the viewer's branch scope. Choose the period (default 30 days, at most 366, or everything), the branch and the AD sign-in filter. The computer and key counts are the **current** numbers; new computers, new keys, computers leaving the scope and key reveals are counted **in the period**. New computers / keys are counted by **recorded date** (default) or **AD creation date**, chosen in the "New computers / keys by" box.

**Export Excel** (`.xlsx`, by the chosen period, branch and filter): overview, by branch, key reveals by branch, who revealed keys, computers without a key, computers that left the scope. The file **never contains recovery keys**; each export writes `export_report`.

**Daily report by email** (Admin > Notifications, off by default): one email a day to Admin HQ and the extra addresses (default 07:30, with yesterday's or today's figures). It has the Worker and AD sync status, sync runs, open alerts, total computers and keys with the change, new computers and keys, and the **% of computers that have a recovery key** (a 10-day chart, change in percentage points). The computer and key counts include only recently active computers (`computer.recent_months`, default 3 months; computers with no sign-in data yet are still counted). Edit the wording in the `daily_report` template (section 6.6); there is a **Send the report now** test button.

### 6.12. Computer and key identity, common situations

A computer is identified by `objectGUID` (it does not change on rename or OU move); a key by its Key ID (`msFVE-RecoveryGuid`) and it belongs to the computer the worker sent it with. **Computers and keys are never deleted**: a computer that leaves the scope only changes status; its keys show the label "Computer out of scope".

| Situation | What the system does |
| --- | --- |
| Computer renamed / moved to another OU | Same GUID so still one computer: name, DN and branch are updated; keys, serial and email are kept |
| Computer deleted from AD, then joined again with the same name | AD makes a new GUID so it is a new computer; the old one becomes "out of scope", its old keys are kept |
| Admin "Reset account" | Still the old object: the new key is added to the same computer |
| New key for the same drive | The new key is **In use**, the old key is **Superseded** (still kept) |
| Unjoin then join again, pushing the old key again | The key moves to the new computer and the history is written. Same name: moved at once; different name: the duplicate Key ID is recorded for now, the next full run moves it and closes it by itself |
| Same Key ID under 2 computers that are both still in scope (image clone) | The key stays with the computer that holds it, a duplicate Key ID is recorded, and 1 mail is sent after the full run. Handle it in Admin > AD sync: **Assign to the newer computer** (moves the key to the computer created later; not possible if the passwords differ or a creation date is missing) or **Share between both** (the key stays as it is, both computers show a note). Either closes the alert, and later full runs do not report it again |
| Same Key ID, **different password** | Not moved, not overwritten; handled like a duplicate Key ID |

Deleting **many** computers at once makes the full run see a sharp drop, so it is **held** for approval (section 6.1): this is a safety mechanism, not an error.

### 6.13. Revealing keys and copying

The reveal page hides itself after 60 seconds; **Copy key** copies the key with its dashes (needs HTTPS or localhost). Every reveal is logged.

### 6.14. Account security: two-step, lockout, passwords, sessions, root admin

- **Two-step verification** (TOTP): switched on per person in Admin > Users. Lost phone: Admin HQ clicks **Reset two-step verification** (or CLI `reset-2fa`). Changing `SECRET_KEY` makes everyone set it up again. Accounts used by scripts should have two-step off.
- **Lockout after wrong sign-ins** (Admin > Security): by default 5 wrong tries lock the account for 15 minutes; unlock in Users or with CLI `unlock`.
- **Internal passwords:** at least 12 characters, not containing the username. AD accounts follow the AD policy.
- **Session:** signs out by itself after 15 minutes of inactivity, at most 8 hours; adjust in Security.
- **Language (English / Tiếng Việt):** the interface is English by default. Each person switches with the **EN | VI** button at the top (saved on the account, kept at the next sign-in); Admin HQ can preset the language when creating or editing a user. Emails (alerts, new computers / keys, the daily report) and Excel files follow the **recipient's** language; addresses tied to no user (extra addresses, `NOTIFY_TO`) get English. If one event has recipients in two languages, two emails are sent, one per language. The application log and the API are always in English. Edit the English email wording in the `en:` block of each template in `server/templates/mail-templates.yaml` (section 6.6).
- **Root admin** (`admin`, label Superadmin): other admins cannot change it, and it cannot remove its own rights or lock itself. If the web is broken or the password is lost: use the CLI (section 6.9).

### 6.15. Logging to stdout for a log collection system (SIEM...)

Besides the application log, the app writes each event to stdout as **one JSON line**, filter by `log_type`: `audit` (access log), `mail` (email status change), `sync_run` (sync run), `alert` (alert). No line contains a recovery password. Writing is asynchronous and lossy: when the queue is full new lines are dropped and one `event_gap` line is written; use the `id` of the log line to remove duplicates.

### 6.16. Job schedules

Edit them on the job's own page; they apply within a minute, no restart. Times follow `APP_TZ`.

| Job | Default | Edit in |
| --- | --- | --- |
| Send pending mail | every 1 minute | Admin > Mail server |
| Watchdog | every 5 minutes | Admin > AD sync > Sync alerts |
| Clean up expired data | 03:00 | Admin > Retention |
| Daily email report | 07:30 (off) | Admin > Notifications |
| Backup | 01:30 (off) | Admin > Backup |

The worker's AD read times (delta 15 minutes, full 01:00, heartbeat 5 minutes) are in the worker configuration (`Schedule.*`, section 4).

## 7. Troubleshooting

| Symptom | Common cause | What to do |
| --- | --- | --- |
| The app does not start, the log says `Invalid configuration` | A variable in `.env` is missing or wrong | Read the variable name in the log, fix `.env` (section 3 lists every variable to change) |
| `/healthz` returns 503 | Cannot connect to the DB | Check `DATABASE_URL`, the firewall, `DB_SSL` |
| Sign-in says the account is locked (Admin too) | Too many wrong passwords (Admin > Security) | Wait for the lock to end, or another Admin unlocks it; if no Admin is left, `docker compose exec server node src/cli/users.js unlock <name>` (section 6.14) |
| AD sign-in says it cannot connect to the AD server | Wrong `LDAP_SERVERS` / `LDAP_PROTOCOL`, port 389 or 636 blocked, or the app does not trust the DC's CA | Try `openssl s_client -connect dc01.corp.local:636`, set `LDAP_CA_FILE` |
| An AD account "does not match" | The AD account was deleted and created again | Admin clicks "Unlink AD" for that user |
| Worker gets 401 | Wrong API key | Make `INGEST_API_KEY` match `Ingest:ApiKey` |
| Worker gets 403 | `INGEST_ALLOWED_IPS` has a value and the worker IP is not in it | The server log says `ingest: address not allowed` with the IP it saw; add the IP and restart the server |
| Worker cannot connect over HTTPS (certificate error) | The worker machine does not trust the CA, or `BaseUrl` uses an IP / a name that is not in the certificate | Section 3.5: set `Ingest.CaFile`, use the right name |
| Keys with no password (`keysEmptyPassword` > 0) | The worker account lacks the right to read `msFVE-RecoveryPassword` | Grant the rights as in section 4.1, run `check` |
| Go worker: `ldap_tls_failed`, connection reset on 636 | The DC has no TLS certificate | Issue a certificate to the DC, or use `Protocol: Ldap` (the default, section 4B.2) |
| Go worker: `x509: certificate signed by unknown authority` | The Linux machine does not trust the DC's CA | Set `Ldap.CaFile` or install the CA in the system store |
| Sync runs keep getting held | The thresholds do not fit reality, or the DB still has trial data | See the reason on the Admin > AD sync tab, accept or reject |
| A computer shows "No longer in the monitored scope" | The computer was deleted from AD, or is outside the worker's `SearchBases` | Check AD and `SearchBases`. When the computer appears in AD again the label goes away by itself |
| Sync run fails with `ldap_search_base_failed` | An OU in `SearchBases` does not exist, was renamed/moved, or the worker account cannot read it | The worker log gives the OU name. Run `check` to see which OU is `FAIL`, fix `SearchBases` or grant the right (section 4.1) |
| The Overview page says data may be stale | The worker is stopped, failing, or a sync run is held | See Admin > AD sync and the worker log; thresholds are in Admin > AD sync > Sync alerts |
| Forgot password, lost two-step phone, broken web | | CLI on the server: `reset-password`, `reset-2fa`, `disable-2fa`, `unlock` (section 6.9) |
| Backup fails or is "Backing up" forever | `pg_dump` error, disk full, wrong `BACKUP_DATABASE_URL` | See "Last run" in Admin > Backup and the server log (section 6.8) |
| Email is not received | The mail server is not switched on, wrong SMTP, or the recipient has no email | Admin > Mail server > **Send a test** to see the error; Admin > Email log shows the status and error of each mail; check the user's email in Admin > Users |
| The app does not start, the log mentions `mail-templates.yaml` | The email template file is broken or a template is missing | Fix it as the message says (the missing template name), or take the original template file from the repo again (section 6.6) |
| `/api/docs` returns 401 | Not signed in on the web | Sign in on the web first, then open `/api/docs` again |

---

## 8. Reference

### 8.1. Server environment variables

| Variable | Default | Meaning |
| --- | --- | --- |
| `NODE_ENV` | `development` | `production` turns on the security checks at start-up |
| `USER_HOST`, `USER_PORT` | `127.0.0.1`, `3000` | Web + `/api` port |
| `TRUST_PROXY` | `loopback` | Proxies trusted for the user IP: `1` = one layer (nginx, recommended), or an IP/range |
| `INGEST_HOST`, `INGEST_PORT` | `0.0.0.0`, `8443` | Ingest API port |
| `INGEST_TRUST_PROXY` | | HTTPS is at a proxy in front of the ingest API: `1` = trust nginx, the worker IP is taken from `X-Forwarded-For` |
| `INGEST_TLS_CERT`, `INGEST_TLS_KEY` | | Only without nginx: the app holds the ingest API's HTTPS certificate itself |
| `COOKIE_SECURE` | on in production | Cookies are sent only over HTTPS |
| `INGEST_API_KEY` | | The worker's API key (32 characters or more), sent in the header `Authorization: Bearer` |
| `INGEST_ALLOWED_IPS` | | IPs allowed to call the ingest API, separated by commas. Empty = any IP (HTTPS and the API key are still required) |
| `DATABASE_URL` | | Connection as `app_node` |
| `MIGRATION_DATABASE_URL` | | Connection as `blk_owner` (used for migrations only) |
| `DB_SSL`, `DB_POOL_MAX` | `false`, `10` | When the pool has no free connection for 15 seconds it reports an error; a statement running over 120 seconds is cancelled |
| `LDAP_SERVERS` | empty (AD sign-in off) | List of DCs as `host` or `host:port`, tried in turn |
| `LDAP_PROTOCOL` | `ldap` | `ldap` (389, unencrypted: the user's AD password travels in clear text, the app logs a warning at start-up; a DC with "LDAP signing: Require" refuses it), `starttls` (389 + TLS), `ldaps` (636 + TLS) |
| `LDAP_DOMAIN`, `LDAP_BASE_DN` | | Required when `LDAP_SERVERS` is set |
| `LDAP_CA_FILE`, `LDAP_TIMEOUT_MS` | , `8000` | |
| `LOCAL_LOGIN_ENABLED` | `true` | Allow sign-in with local accounts |
| `SESSION_SECRET` | | 32 characters or more |
| `SESSION_IDLE_MINUTES`, `SESSION_MAX_HOURS` | `15`, `8` | Idle time and maximum length of a session (defaults; Admin HQ can change them in Admin > Security) |
| `SECRET_KEY` | | 64 hex characters (the old name `LOG_HMAC_KEY` is still accepted) |
| `BACKUP_DIR` | `backups` | Folder where backup files are written (section 6.8) |
| `BACKUP_DATABASE_URL` | | The read-only account `blk_backup` for `pg_dump`; if empty the database is not backed up |
| `PG_DUMP_PATH` | `pg_dump` | Path to `pg_dump` version 17 (when running outside Docker) |
| `SMTP_URL`, `NOTIFY_FROM`, `NOTIFY_TO`, `TEAMS_WEBHOOK_URL` | | Fallback SMTP when no mail server is set up in Admin; addresses that always receive alerts; Teams webhook |
| `MAIL_TEMPLATES_FILE` | `server/templates/mail-templates.yaml` | The email template file (section 6.6) |
| `JOBS_ENABLED`, `APP_TZ` | `true`, `Asia/Ho_Chi_Minh` | Background jobs and the time zone |
| `LOG_LEVEL` | `info` | |

### 8.2. API for users

The list of endpoints, parameters and rights is in **Swagger**: `https://<server>/api/docs` (open after signing in on the web). Errors come back as `{ "error": "<code>", "message": "<English>" }`.

**Calling the API from a script** (same sign-in as the web, no separate API key):

1. The API accepts only **local** accounts (an AD account calling the API gets 403 `api_requires_local`).
2. `POST /api/auth/login` `{ "username", "password" }` → the cookie `blk.sid` and `csrfToken` (with two-step, also `POST /api/auth/2fa`, section 6.14).
3. Call the API with the cookie; POST/PUT/DELETE also need `X-CSRF-Token: <csrfToken>` and `Content-Type: application/json`. It must be called over HTTPS; when the session expires, sign in again.

```bash
BASE=https://blk.corp.local
CSRF=$(curl -s -c cookies.txt -H 'Content-Type: application/json' \
  -d "{\"username\":\"svc-report\",\"password\":\"$BLK_PASSWORD\"}" "$BASE/api/auth/login" | jq -r .csrfToken)
curl -s -b cookies.txt "$BASE/api/computers?q=HN-LT" | jq '.rows[] | {name, branch_code}'
curl -s -b cookies.txt -o report.xlsx "$BASE/api/reports/summary?from=2026-10-01&to=2026-10-31&format=xlsx"
curl -s -b cookies.txt -X POST -H "X-CSRF-Token: $CSRF" "$BASE/api/auth/logout"
```

Self-signed certificate: add `--cacert cert/ca.crt` to `curl` (PowerShell 7: `-SkipCertificateCheck`).

### 8.3. Ingest API (for the worker)

An API **only for the sync worker**, on its own port (`INGEST_PORT`, default 8443), with no sign-in session and no endpoint that returns keys. Specification: `server/openapi/ingest.openapi.yaml` (Swagger: `https://localhost:8443/docs`, needs the API key). Endpoints under `/api/ingest`: `GET /sync-runs/last`, `POST /sync-runs`, `POST /computers`, `POST /keys`, `POST /sync-runs/:id/complete`, `POST /heartbeat`.

**Authentication: three layers, all required in production**

| Layer | Configuration | Error when wrong |
| --- | --- | --- |
| HTTPS | nginx port 8443 (section 3.5) | TLS error; `http://` to 8443 gets 400 |
| Allowed IP | `INGEST_ALLOWED_IPS` (nginx writes the IP into `X-Forwarded-For`, the client cannot fake it) | 403 `forbidden` |
| API key | `INGEST_API_KEY`, header `Authorization: Bearer <key>` | 401 `bad_api_key` |

A trial call on the worker machine (from an allowed IP):

```bash
INGEST=https://blk.corp.local:8443/api/ingest
curl -s -H "Authorization: Bearer $INGEST_API_KEY" "$INGEST/sync-runs/last"      # add --cacert if the machine does not trust the CA
```

Be careful when sending data by hand: a **full** run treats every computer not sent as "No longer in the monitored scope" (do not try a full run with incomplete data on a real system); only one run can be open at a time (409 `run_in_progress`), so stop the real worker first; each batch can be sent again (idempotent); do not log or store recovery passwords on the caller's side.

### 8.4. Code structure (`server/src`)

`app.js` (the user app), `services.js` (creates every service once, shared by web, API, ingest, jobs and CLI), `api/`, `web/`, `ingest/` (the API for the worker, its own port), `jobs/` (jobs and the watchdog), `http/` (errors, zod, CSRF), `db/` (pool, migrations, `withScope` for RLS), `domain/` (roles, rights). Each feature lives in `modules/<name>/`: `*.repo.js` (SQL only), `*.service.js` (business logic, authorization, logging), `*.api.js`, `*.web.js`. Besides `src/`: `db/migrations/`, `openapi/`, `templates/mail-templates.yaml`, `public/`, `test/` (vitest). Interface texts: `src/i18n/` (Vietnamese source text is the key, English in `src/i18n/en/`).

Rules: routes stay thin, every permission check and log write lives in the service (web and API do not drift apart); key values are read only in `keys.repo.js` (`readRecoveryPassword`, `keysForExport`) inside a transaction that writes the log; request/response bodies are not logged, and the logger masks every string that looks like a recovery key. Worker: see `worker/README.md`.
