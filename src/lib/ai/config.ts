import { createOpenAI } from "@ai-sdk/openai";

export const localProvider = createOpenAI({
  apiKey: process.env.LOCAL_AI_API_KEY || "sk-no-key-required",
  baseURL: process.env.LOCAL_AI_BASE_URL || "http://localhost:1234/v1",
});

export const defaultModel = process.env.LOCAL_AI_MODEL_NAME || "hermes";
