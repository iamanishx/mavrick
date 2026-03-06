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
  await handleNewTask(thread, message.text, {
    rootRunId: (message as any).rootRunId ?? (message as any).raw?.rootRunId,
    runId: (message as any).runId ?? (message as any).raw?.runId,
  });
});

bot.onSubscribedMessage(async (thread, message) => {
  await handleNewTask(thread, message.text, {
    rootRunId: (message as any).rootRunId ?? (message as any).raw?.rootRunId,
    runId: (message as any).runId ?? (message as any).raw?.runId,
  });
});

export const discordWebhooks = bot.webhooks.discord;
