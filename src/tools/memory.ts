import { createTool } from "@cline/sdk";
import { repoDb } from "./db";

export const memoryTool = createTool<{ action: "save" | "get" | "getAll"; repoId: number; key?: string; value?: string }, { success: boolean; message?: string; key?: string; value?: string | null; memories?: Record<string, string>; error?: string }>({
  name: "memory_tool",
  description: "Save and retrieve persistent memory for a repository. Use this to store context across agent sessions.",
  inputSchema: {
    type: "object",
    properties: {
      action: { type: "string", enum: ["save", "get", "getAll"] },
      repoId: { type: "number" },
      key: { type: "string" },
      value: { type: "string" },
    },
    required: ["action", "repoId"],
  },
  execute: async ({ action, repoId, key, value }) => {
    try {
      switch (action) {
        case "save": {
          if (key === undefined || value === undefined) {
            return { success: false, error: "key and value are required for save action" };
          }
          repoDb.setMemory(repoId, key, value);
          return { success: true, message: `Saved memory: ${key}` };
        }
        case "get": {
          if (key === undefined) {
            return { success: false, error: "key is required for get action" };
          }
          const result = repoDb.getMemory(repoId, key);
          return { success: true, key, value: result ?? null };
        }
        case "getAll": {
          const result = repoDb.getAllMemory(repoId);
          return { success: true, memories: result };
        }
        default:
          return { success: false, error: `Unknown action: ${action}` };
      }
    } catch (err: any) {
      return { success: false, error: err.message || String(err) };
    }
  },
});

export const saveMemory = createTool<{ repoId: number; key: string; value: string }, { success: boolean; key?: string; error?: string }>({
  name: "save_memory",
  description: "Save a memory value for a repository",
  inputSchema: {
    type: "object",
    properties: {
      repoId: { type: "number" },
      key: { type: "string" },
      value: { type: "string" },
    },
    required: ["repoId", "key", "value"],
  },
  execute: async ({ repoId, key, value }) => {
    try {
      repoDb.setMemory(repoId, key, value);
      return { success: true, key };
    } catch (err: any) {
      return { success: false, error: err.message || String(err) };
    }
  },
});

export const getMemory = createTool<{ repoId: number; key: string }, { success: boolean; key?: string; value?: string | null; error?: string }>({
  name: "get_memory",
  description: "Get a memory value for a repository",
  inputSchema: {
    type: "object",
    properties: {
      repoId: { type: "number" },
      key: { type: "string" },
    },
    required: ["repoId", "key"],
  },
  execute: async ({ repoId, key }) => {
    try {
      const value = repoDb.getMemory(repoId, key);
      return { success: true, key, value: value ?? null };
    } catch (err: any) {
      return { success: false, error: err.message || String(err) };
    }
  },
});

export const getAllMemory = createTool<{ repoId: number }, { success: boolean; memories?: Record<string, string>; error?: string }>({
  name: "get_all_memory",
  description: "Get all memory for a repository",
  inputSchema: {
    type: "object",
    properties: {
      repoId: { type: "number" },
    },
    required: ["repoId"],
  },
  execute: async ({ repoId }) => {
    try {
      const memories = repoDb.getAllMemory(repoId);
      return { success: true, memories };
    } catch (err: any) {
      return { success: false, error: err.message || String(err) };
    }
  },
});
