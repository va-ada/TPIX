import { runClaude } from "../src/llm/claude.ts";

async function main() {
  const result = await runClaude({
    prompt: "Respond with exactly the two characters: OK",
    model: "claude-sonnet-4-6",
  });

  console.log("text:", JSON.stringify(result.text));
  console.log("sessionId:", result.sessionId);
  console.log("model:", result.model);
  console.log(
    "tokens:",
    JSON.stringify({ in: result.promptTokens, out: result.completionTokens }),
  );
  console.log("latency_ms:", result.latencyMs);

  const trimmed = result.text.trim();
  if (trimmed !== "OK") {
    console.error(`FAIL: expected "OK", got ${JSON.stringify(trimmed)}`);
    process.exit(1);
  }
  console.log("PASS");
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
