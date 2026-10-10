// Run only against an isolated database. Secrets stay in the child environment.
const inspected = await Bun.$`docker inspect midday-local-api-1`.json();
const env = Object.fromEntries(
  inspected[0].Config.Env.map((entry: string) => {
    const i = entry.indexOf("=");
    return [entry.slice(0, i), entry.slice(i + 1)];
  }),
);
const database = new URL(env.DATABASE_PRIMARY_URL);
database.pathname = "/midday_slack_audit_20261010";
env.DATABASE_PRIMARY_URL = database.href;
for (const key of Object.keys(env)) {
  if (key.startsWith("DATABASE_") && /^postgres(?:ql)?:/.test(env[key]))
    env[key] = database.href;
  if (
    /^(SLACK_|DISCORD_|TELEGRAM_|COMPOSIO_|SENDGRID_|RESEND_|SENDBLUE_|WHATSAPP_)/.test(
      key,
    )
  )
    delete env[key];
}
env.SLACK_AUDIT_TEST = "true";
env.OPENAI_ENABLE_WEB_SEARCH = "false";
env.REDIS_URL = "redis://127.0.0.1:1";
const root = new URL("..", import.meta.url).pathname.replace(/\/$/, "");
const command = Bun.argv.slice(2);
const args = [
  "docker",
  "run",
  "--rm",
  "--network",
  "supabase_network_midday-mod",
  ...Object.keys(env).flatMap((key) => ["--env", key]),
  "-v",
  `${root}/apps/api/src:/app/apps/api/src:ro`,
  "-v",
  `${root}/packages/db/src:/app/packages/db/src:ro`,
  "-v",
  `${root}/packages/bot/src:/app/packages/bot/src:ro`,
  "-w",
  "/app/apps/api",
  "--entrypoint",
  "bun",
  "midday-local-api",
  ...(command.length
    ? command
    : ["test", "src/chat/transaction-flow.integration.test.ts"]),
];
const child = Bun.spawn(args, {
  env: { ...process.env, ...env },
  stdout: "inherit",
  stderr: "inherit",
});
process.exit(await child.exited);
