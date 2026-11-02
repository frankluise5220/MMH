/**
 * Behavioural checks for the AI failure classifier.
 *
 * The classifier is the only thing standing between a provider error body and
 * the user, so its mapping is pinned here rather than left to manual testing.
 *
 * Run: npx tsx scripts/verify-ai-failure-classification.ts
 */
import { aiFailurePayload, classifyAiFailure, type AiFailureCode } from "../src/lib/ai/errors";

type Case = {
  name: string;
  input: Parameters<typeof classifyAiFailure>[0];
  expect: AiFailureCode;
};

const cases: Case[] = [
  { name: "expired key", input: { status: 401, body: '{"error":{"message":"Incorrect API key provided"}}' }, expect: "AI_AUTH_FAILED" },
  { name: "forbidden key", input: { status: 403 }, expect: "AI_AUTH_FAILED" },
  { name: "quota", input: { status: 402, body: "insufficient_quota" }, expect: "AI_QUOTA_EXCEEDED" },
  { name: "rate limited", input: { status: 429 }, expect: "AI_RATE_LIMITED" },
  { name: "model missing by status", input: { status: 404 }, expect: "AI_MODEL_NOT_FOUND" },
  { name: "model missing in body", input: { status: 400, body: "The model `foo` does not exist" }, expect: "AI_MODEL_NOT_FOUND" },
  { name: "bad request", input: { status: 400, body: "invalid messages" }, expect: "AI_BAD_REQUEST" },
  { name: "upstream 5xx", input: { status: 503 }, expect: "AI_SERVER_ERROR" },
  { name: "timeout", input: { timedOut: true }, expect: "AI_TIMEOUT" },
  { name: "connection refused", input: { error: new TypeError("fetch failed") }, expect: "AI_UNREACHABLE" },
  { name: "sdk error carries status", input: { error: Object.assign(new Error("Unauthorized"), { statusCode: 401 }) }, expect: "AI_AUTH_FAILED" },
  { name: "unknown", input: { error: new Error("something odd") }, expect: "AI_UNKNOWN" },
];

const failures: string[] = [];

for (const testCase of cases) {
  const actual = classifyAiFailure(testCase.input).code;
  if (actual !== testCase.expect) {
    failures.push(`${testCase.name}: expected ${testCase.expect}, got ${actual}`);
  }
}

// The browser payload must never carry the provider body: it can echo part of
// the API key back inside the message.
const leaked = aiFailurePayload(
  classifyAiFailure({ status: 401, body: '{"error":{"message":"Incorrect API key provided: sk-secret***"}}' }),
);
if (JSON.stringify(leaked).includes("sk-secret")) {
  failures.push("payload leaks the provider body");
}
if (JSON.stringify(leaked).includes("detail")) {
  failures.push("payload carries the `detail` field");
}
if (!leaked.messageKey) {
  failures.push("payload is missing a messageKey");
}

if (failures.length > 0) {
  console.error(`Found ${failures.length} AI failure classification issue(s):\n`);
  for (const failure of failures) console.error(`- ${failure}`);
  process.exit(1);
}

console.log(`OK: ${cases.length} AI failure cases classified, payload carries no provider body.`);
