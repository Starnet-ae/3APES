# 3apes MVP — Rust API + SQLite + React frontend

This is a **working-source MVP scaffold based on the earlier 3apes React prototype**, NOT a byte-for-byte modification of the user's Mac repository. The real Mac backend source (`routes.rs`, `db.rs`, `phala.rs`, etc.) was not supplied. Do not overwrite it without reviewing differences. This starter preserves the prior interface style and replaces mock chat responses and fake balances with API calls.

## 1. Architecture

```
Browser -> https://3apes.ai (Cloudflare Pages: frontend/)
        -> https://api.3apes.ai (Phala CVM: backend/ Docker image)
            -> SQLite /data/3apes.db (persistent named Docker volume)
            -> configured external OpenAI-compatible LLM endpoint over HTTPS
```

SQLite is local to the backend. At startup SQLx opens/creates `/data/3apes.db`, applies `backend/migrations/0001_init.sql`, and reopens the same volume on restarts. There is no PostgreSQL and no standalone database service.

**Security:** neither the frontend nor backend currently implements **remote attestation verification**. It must not show a "Verified TEE" trust claim. TLS to a provider alone is not enough to verify its TEE. This scaffold has no payments, credit accounting, price verification, dedicated secret manager, backups, or billing. Browser login tokens are stored in `sessionStorage` for ease of testing; replace with a more robust production session design before broad public rollout. Enable public registration only intentionally.

## 2. File layout

```
3apes-mvp/
├── backend/
│   ├── src/main.rs            # Actual Rust Axum API
│   ├── migrations/0001_init.sql
│   ├── Cargo.toml
│   ├── Dockerfile             # Linux AMD64 container
│   └── .env.example
├── frontend/
│   ├── src/App.tsx             # Actual React frontend
│   ├── src/api.ts              # Auth, chat, API-key, SSE fetch wrapper
│   ├── src/styles.css         # Adapted from previous 3apes UI
│   ├── package.json
│   └── .env.example
├── deploy/
│   ├── compose.local.yaml     # Local Docker test
│   ├── compose.yaml           # Phala deployment, pinned GHCR image
│   └── phala.env.example
└── .github/workflows/router-image.yml
```

## 3. Run on your Mac (without Docker)

Requires a recent Rust toolchain, Node 22+, npm.

Terminal A:

```bash
cd backend
cp .env.example .env
# Edit .env with your provider's actual URL and model ID.
# .env is intentionally NOT loaded automatically; export environment variables:
set -a; source .env; set +a
cargo run
```

First run creates `backend/data/3apes.db` and tables. Confirm at `http://127.0.0.1:8080/healthz`.

Terminal B:

```bash
cd frontend
cp .env.example .env.local
npm install
npm run dev
```

Open http://localhost:5173 and register a demo user (only while `SIGNUP_ENABLED=true`). After creating accounts, turn registration off on the public TEE.

**Provider configuration:** The backend posts JSON to `${LLM_BASE_URL}/chat/completions` using an OpenAI-compatible streaming format. Set `LLM_BASE_URL` to the API prefix, often ending in `/v1`. Set `LLM_API_KEY` only on the backend. Put actual provider model IDs in `MODEL_SMALL_ID`, `MODEL_MEDIUM_ID`, and/or `MODEL_LARGE_ID`. The frontend sees only the configured IDs. If no models are configured, it intentionally refuses prompts rather than returning a fake reply.

## 4. Local Docker validation

Configure `deploy/.env` from `deploy/phala.env.example` but change `PUBLIC_ORIGIN=http://localhost:5173` and `SIGNUP_ENABLED=true`.

```bash
docker compose --env-file deploy/.env -f deploy/compose.local.yaml up --build -d
curl http://localhost:8080/healthz
docker compose --env-file deploy/.env -f deploy/compose.local.yaml logs -f
```

Test a chat, restart `router`, and confirm the SQLite database persists. For example:

```bash
docker compose --env-file deploy/.env -f deploy/compose.local.yaml restart router
```

The named local volume is `3apes_sqlite_data_local`. **Never run `docker compose down -v` if you need to keep the data.** Make a proper online SQLite backup before deleting any CVM, Docker volume, or before risky schema migrations.

## 5. GitHub and GHCR

Create a **private** GitHub repository and commit the code, migrations, Dockerfile and workflow (but not `.env` or database files).

```bash
# From this 3apes-mvp root:
git init
git add .
git status --short  # inspect for secrets / DB files
git commit -m '3apes MVP backend and frontend'
git branch -M main
git remote add origin https://github.com/OWNER/REPO.git
git push -u origin main
```

The `.github/workflows/router-image.yml` workflow builds a linux/amd64 Docker image on pushes affecting `backend/` and publishes:

```
ghcr.io/owner/repo:sha-FULL_COMMIT_SHA
```

Use the workflow's successful image tag (or ideally pinned image digest) in `deploy/compose.yaml`. For private packages, configure Phala's private GHCR registry credentials with **read:packages** access. The Docker build doesn't clone GitHub at runtime: it downloads the **prebuilt image from GHCR**. GitHub Actions does the compiling.

For reproducibility, run `cargo generate-lockfile` and commit `backend/Cargo.lock` from your Mac; then add `COPY Cargo.lock ./` after `COPY Cargo.toml ./` in Dockerfile and change build to `cargo build --release --locked`.

## 6. Phala deploy

1. Sign in at https://cloud.phala.com.
2. Deploy a CVM using the **Docker Compose / Advanced** editor.
3. Choose **2 vCPU / 4 GB RAM / 20 GB** for a light demo; increase if load requires.
4. Copy `deploy/compose.yaml`, updating `ghcr.io/OWNER/REPO:sha-...`.
5. Enter model credentials and configuration as **Phala encrypted environment secrets**, not source code. Configure private-image pull credentials if needed.
6. Publish port `8080` via the supported Phala HTTPS ingress; test `GET /healthz` through the temporary Phala HTTPS endpoint.
7. Deploy an update to the **same CVM/volume** and verify chats persist. This is persistence, not backup.
8. Configure `api.3apes.ai` using Phala's supported custom-domain / attested ingress setup. Avoid an additional TLS-terminating proxy if you promise plaintext is visible only to the TEE. Implement and verify actual TDX report/measurement validation before making confidentiality claims.
9. After creating demo users, set `SIGNUP_ENABLED=false` for controlled access. Restrict credentials and access to logs.

## 7. Cloudflare Pages deployment

1. In Cloudflare Dashboard → **Workers & Pages** → **Create application** → **Pages** → **Connect to Git**.
2. Select the same GitHub repository.
3. Set **Root directory = `frontend`** (this is a monorepo).
4. Set **Build command = `npm run build`**, **Output = `dist`**, branch = `main`.
5. Set `VITE_API_BASE_URL=https://api.3apes.ai` in Pages build environment variables.
6. Deploy and test at the automatically assigned `*.pages.dev` hostname.
7. Add **Custom domain `3apes.ai`** to the Pages project; follow Cloudflare DNS instructions, retaining existing MX/TXT records if applicable.
8. The backend's `PUBLIC_ORIGIN` must match **exactly** `https://3apes.ai` to allow browser requests.

Cloudflare deploys the frontend whenever `main` changes. GitHub Actions separately builds an API image when `backend/` changes. Phala is manually updated to that pinned image: **not automatic** in this MVP. Browser loads compiled React files from Cloudflare, then makes HTTPS requests to Phala. The frontend contains no provider secrets.

## 8. API endpoints / what is implemented

- `GET /healthz` — readiness (public)
- `POST /api/auth/register` — optional signup, Argon2id password hashes
- `POST /api/auth/login` — 12-hour bearer session
- `GET /api/auth/me` and `POST /api/auth/logout`
- `GET /api/models` — configured model tiers (does NOT claim attested)
- `GET /api/chats`, `POST /api/chats`
- `GET /api/chats/{chat_id}`, `DELETE /api/chats/{chat_id}`
- `POST /api/chats/{chat_id}/messages` — upstream streaming SSE; persists user and completed assistant messages
- `GET /api/keys`, `POST /api/keys`, `DELETE /api/keys/{key_id}` — hashed API secrets; shown only at creation

### Known MVP constraints

- Single SQLite DB instance; app should not be horizontally scaled across independent CVMs using this file.
- Auto routing uses a transparent **prompt-length heuristic**, not a trained classifier.
- Chat streaming supports **OpenAI-compatible SSE** (`choices[0].delta.content`, `[DONE]`) only.
- An interrupted SSE can leave a user message saved without a completed assistant message.
- There is no credit ledger, billing, payments, TEE verifier, inference receipt verifier, request quota enforcement, login throttling, database backup service, or audit log. These need implementation before a production public launch.
- TLS/authentication ≠ TDX attestation. A backend deployed on Phala is not automatically verified in a user's browser.
- If you want to preserve all behavior from your current Mac version (`generation.rs`, provider/Phala integrations, exact frontend screens), provide the real source and merge these deployment pieces rather than substituting this simplified backend.

## Official documentation

- Phala Docker Compose: https://docs.phala.com/phala-cloud/cvm/create-with-docker-compose
- Phala private images: https://docs.phala.com/phala-cloud/cvm/create-with-private-docker-image
- Cloudflare Pages Git integration: https://developers.cloudflare.com/pages/get-started/git-integration/
- Cloudflare Pages monorepos: https://developers.cloudflare.com/pages/configuration/monorepos/
