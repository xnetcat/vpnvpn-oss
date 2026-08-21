## @vpnvpn/db – Shared Prisma Client & Schema

This package owns the shared Prisma schema and generated client used by the web app, control-plane and metrics services.

### Local database configuration

Prisma needs a `DATABASE_URL` when you run CLI commands such as `prisma migrate dev`
or `prisma studio`. For the local Docker stack in `local/compose.yaml` the default
Postgres URL is:

```bash
postgresql://postgres:password@localhost:5432/vpnvpn
```

### Running local migrations

From the monorepo root:

```bash
cd packages/db

# Generate client
bun run build

# Apply dev migrations against the local Postgres from local/compose.yaml
bun run migrate:dev
```

This will:

- Create or update migration files under `prisma/migrations/`
- Apply them to your local Postgres

### Applying migrations in CI / Docker

In non-interactive environments (Docker/CI), use Prisma's deploy command with the
appropriate `DATABASE_URL`:

```bash
npx prisma migrate deploy --schema prisma/schema.prisma
```


