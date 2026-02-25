import { Chat } from "chat";
import { createDiscordAdapterConfig } from "./adapters/discord";
import { createMemoryState } from "@chat-adapter/state-memory";
import "./index";

const bot = new Chat({
  userName: "axeai",
  adapters: {
    discord: createDiscordAdapterConfig(),
  },
  state: createMemoryState(),
});

bot.onNewMention(async (thread, message) => {
  thread.subscribe();
  await thread.post("I've received your request and will start processing it shortly. I'll analyze the repository and generate the appropriate tests.");
});

bot.onSubscribedMessage(async (thread, message) => {
  await thread.post("Thanks for your follow-up message! I'm still processing your initial request.");
});

export const discordWebhooks = bot.webhooks.discord;
