import { runOllama } from "../src/llm/ollama.ts";

async function main() {
  const result = await runOllama({
    prompt: "Reply with one short sentence about the color of the sky.",
    model: "llama3.2:3b",
  });

  console.log("text:", JSON.stringify(result.text));
  console.log("model:", result.model);
  console.log(
    "tokens:",
    JSON.stringify({ in: result.promptTokens, out: result.completionTokens }),
  );
  console.log("latency_ms:", result.latencyMs);

  if (result.text.trim().length === 0) {
    console.error("FAIL: empty response");
    process.exit(1);
  }
  console.log("PASS");
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
