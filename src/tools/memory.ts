import { tool } from "ai";
import { z } from "zod";
import { repoDb } from "./db";

export const memoryTool = tool({
  description: "Save and retrieve persistent memory for a repository. Use this to store context across agent sessions.",
  inputSchema: z.object({
    action: z.enum(["save", "get", "getAll"]).describe("The memory action to perform"),
    repoId: z.number().describe("The repository ID"),
    key: z.string().optional().describe("The memory key (required for save and get)"),
    value: z.string().optional().describe("The memory value (required for save)"),
  }),
  execute: async ({ action, repoId, key, value }) => {
    switch (action) {
      case "save": {
        if (key === undefined || value === undefined) {
          throw new Error("key and value are required for save action");
        }
        repoDb.setMemory(repoId, key, value);
        return { success: true, message: `Saved memory: ${key}` };
      }
      case "get": {
        if (key === undefined) {
          throw new Error("key is required for get action");
        }
        const result = repoDb.getMemory(repoId, key);
        return { key, value: result ?? null };
      }
      case "getAll": {
        const result = repoDb.getAllMemory(repoId);
        return { memories: result };
      }
      default:
        throw new Error(`Unknown action: ${action}`);
    }
  },
});

export const saveMemory = tool({
  description: "Save a memory value for a repository",
  inputSchema: z.object({
    repoId: z.number(),
    key: z.string(),
    value: z.string(),
  }),
  execute: async ({ repoId, key, value }) => {
    repoDb.setMemory(repoId, key, value);
    return { success: true, key };
  },
});

export const getMemory = tool({
  description: "Get a memory value for a repository",
  inputSchema: z.object({
    repoId: z.number(),
    key: z.string(),
  }),
  execute: async ({ repoId, key }) => {
    const value = repoDb.getMemory(repoId, key);
    return { key, value: value ?? null };
  },
});

export const getAllMemory = tool({
  description: "Get all memory for a repository",
  inputSchema: z.object({
    repoId: z.number(),
  }),
  execute: async ({ repoId }) => {
    const memories = repoDb.getAllMemory(repoId);
    return { memories };
  },
});
