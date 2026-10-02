const DISCORD_BOT_PERMISSIONS = "328565115968";

export function buildDiscordInstallUrl(applicationId?: string | null) {
  const clientId = applicationId?.trim();
  if (!clientId) return null;

  const url = new URL("https://discord.com/oauth2/authorize");
  url.searchParams.set("client_id", clientId);
  url.searchParams.set("permissions", DISCORD_BOT_PERMISSIONS);
  url.searchParams.set("integration_type", "0");
  url.searchParams.set("scope", "bot applications.commands");
  return url.toString();
}
