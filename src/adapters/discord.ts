import { createDiscordAdapter, DiscordAdapter } from "@chat-adapter/discord";

export function createDiscordAdapterConfig(): DiscordAdapter {
  return createDiscordAdapter({
    applicationId: process.env.DISCORD_APPLICATION_ID!,
    botToken: process.env.DISCORD_BOT_TOKEN!,
  });
}
