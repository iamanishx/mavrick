import { createDiscordAdapter, DiscordAdapter } from "@chat-adapter/discord";

export function createDiscordAdapterConfig(): DiscordAdapter {
  const applicationId = process.env.DISCORD_APPLICATION_ID;
  const botToken = process.env.DISCORD_BOT_TOKEN;

  if (!applicationId) {
    throw new Error("DISCORD_APPLICATION_ID environment variable is required but not set");
  }

  if (!botToken) {
    throw new Error("DISCORD_BOT_TOKEN environment variable is required but not set");
  }

  return createDiscordAdapter({
    applicationId,
    botToken,
  });
}
