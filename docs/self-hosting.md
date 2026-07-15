# Collaboration service: local and self-hosted deployment

DraftMatter ships one vendor-neutral collaboration service image. It runs the Hocuspocus WebSocket transport and HTTP API, stores accounts and compact Yjs updates in PostgreSQL, and stores immutable snapshots in any S3-compatible object store. The same image runs under Docker Desktop on macOS and Windows, Docker Engine on Linux, Podman, or a conventional container platform.

## Local development stack

The checked-in Compose stack is a development and evaluation environment. It uses PostgreSQL 18.4, Keycloak 26.7.0, and Apache-2.0 SeaweedFS 4.29. PostgreSQL 18 uses the versioned data directory under `/var/lib/postgresql`, Keycloak imports a local realm, and SeaweedFS starts its single-node `mini` S3 service with the `draftmatter` bucket already created.

1. Copy `.env.example` to `.env` and replace every value. The `.env` file is ignored by Git.
2. Start the stack:

   ```sh
   docker compose up --build
   ```

3. Check `http://localhost:1234/health/ready`. Keycloak is available only on loopback at `http://localhost:8080`.
4. Run the web client with `npm run dev`. Its collaboration workspace uses `ws://localhost:1234`, the `draftmatter` Keycloak realm, and the `draftmatter-local` client.

The imported realm contains `alice` / `alice-local-only` and `bob` / `bob-local-only` solely for local evaluation. A direct-grant access token can be requested from:

```text
POST http://localhost:8080/realms/draftmatter/protocol/openid-connect/token
Content-Type: application/x-www-form-urlencoded

client_id=draftmatter-local&grant_type=password&username=alice&password=alice-local-only
```

Paste the returned `access_token` into the collaboration connection panel. Never expose this development realm or its fixture credentials to a network.

Stop containers without deleting data using `docker compose down`. Add `--volumes` only when you explicitly want to erase both PostgreSQL and object-storage state.

## Production configuration

The container starts only after database migrations, a PostgreSQL query, and an object-storage bucket probe succeed. It serves:

- `/health/live` for process liveness;
- `/health/ready` for dependency readiness;
- `/metrics` for aggregate Prometheus counters without workspace, project, user, token, or manuscript labels;
- `/api/...` for bearer-authenticated workspace administration and signed entitlement updates;
- the Hocuspocus WebSocket protocol on the same port.

Use an HTTPS reverse proxy or load balancer with WebSocket support. In production, `DM_OIDC_ISSUER`, `DM_OIDC_JWKS_URI`, and every allowed browser origin must use HTTPS; insecure internal JWKS URLs are accepted only when `NODE_ENV` is not `production`. Keep PostgreSQL and object storage on private networks, use verified database TLS, use encrypted object storage, and inject credentials through a secrets manager rather than an environment file checked into an image.

Required variables and safe development defaults are documented in `.env.example` and validated in `services/collaboration/config.ts`. Important production choices are:

- `DM_DATABASE_TLS=verify-full` with the platform CA available to Node;
- a short-lived OIDC access-token policy and a stable audience dedicated to DraftMatter;
- exact `DM_ALLOWED_ORIGINS`, never `*`;
- a random `DM_WEBHOOK_SECRET` of at least 32 bytes;
- bucket versioning or immutability, server-side encryption, and a separately administered backup destination;
- a reverse-proxy request limit no larger than `DM_MAX_PAYLOAD_BYTES`.

The bundled identity realm and single-node object store are intentionally not a high-availability topology. A managed production deployment should use an operated OIDC provider, replicated PostgreSQL, versioned S3-compatible storage, scheduled backups, alert routing, and restore drills. The service remains vendor-neutral: a billing provider is integrated through the signed entitlement webhook boundary, and no provider SDK or exact pricing is embedded.

Container choices follow the projects’ own current guidance: [Keycloak container deployment](https://www.keycloak.org/server/containers), [PostgreSQL supported versions](https://www.postgresql.org/support/versioning/), and [SeaweedFS S3 Docker quick start](https://github.com/seaweedfs/seaweedfs#quick-start-for-s3-api-on-docker).
