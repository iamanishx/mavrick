import { Chat } from "chat";
import { createDiscordAdapterConfig } from "./adapters/discord";
import { createMemoryState } from "@chat-adapter/state-memory";
import { handleNewTask } from "./index";

const bot = new Chat({
  userName: "axeai",
  adapters: {
    discord: createDiscordAdapterConfig(),
  },
  state: createMemoryState(),
});

bot.onNewMention(async (thread, message) => {
  await thread.subscribe();
  await handleNewTask(thread, message.text);
});

bot.onSubscribedMessage(async (thread, message) => {
  await handleNewTask(thread, message.text);
});

export const discordWebhooks = bot.webhooks.discord;
