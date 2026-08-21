import { execFileSync } from "node:child_process";
import { buildServer, startMetricsRetention } from "./server";

const port = Number(process.env.PORT ?? 4000);

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * Apply pending Prisma migrations on boot when PRISMA_MIGRATE_DEPLOY_ON_BOOT is
 * set. Retries to tolerate the database not being ready yet at startup.
 *
 * PREFERRED in production: run migrations as a one-shot pre-deploy step, NOT in
 * the app boot path, so they execute exactly once per release rather than once
 * per replica/restart. railway.toml wires this via `preDeployCommand`. Leave
 * PRISMA_MIGRATE_DEPLOY_ON_BOOT unset there. The on-boot path remains for local
 * Docker/CI convenience (Prisma takes an advisory lock, so even if it does run
 * concurrently it is serialized rather than corrupting state).
 */
async function maybeMigrate() {
  if (!process.env.PRISMA_MIGRATE_DEPLOY_ON_BOOT) return;
  const schema = process.env.PRISMA_SCHEMA_PATH ?? "./prisma/schema.prisma";
  const attempts = Number(process.env.MIGRATE_MAX_ATTEMPTS ?? 12);
  const delayMs = Number(process.env.MIGRATE_RETRY_DELAY_MS ?? 2000);
  for (let attempt = 1; attempt <= attempts; attempt++) {
    try {
      // eslint-disable-next-line no-console
      console.log(
        `[control-plane] prisma migrate deploy (attempt ${attempt}/${attempts}, schema=${schema})...`,
      );
      execFileSync("npx", ["prisma", "migrate", "deploy", "--schema", schema], {
        stdio: "inherit",
      });
      // eslint-disable-next-line no-console
      console.log("[control-plane] migrations applied");
      return;
    } catch (err) {
      if (attempt === attempts) throw err;
      // eslint-disable-next-line no-console
      console.warn(
        `[control-plane] migrate attempt ${attempt} failed, retrying in ${delayMs}ms...`,
      );
      await sleep(delayMs);
    }
  }
}

async function main() {
  await maybeMigrate();
  const fastify = await buildServer();
  startMetricsRetention();
  const address = await fastify.listen({ port, host: "0.0.0.0" });
  fastify.log.info(`control-plane listening on ${address}`);
}

main().catch((err) => {
  // eslint-disable-next-line no-console
  console.error(err);
  process.exit(1);
});
