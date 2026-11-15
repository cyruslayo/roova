import { writeFile } from "node:fs/promises";
// Run from a machine with internet access. Fail if World Labs changes the spec location.
const url = "https://docs.worldlabs.ai/api/reference/openapi.yaml";
const response = await fetch(url, { signal: AbortSignal.timeout(20_000) });
if (!response.ok) throw new Error(`Could not fetch ${url}: ${response.status}`);
const content = await response.text();
if (!content.includes("openapi:") || !content.includes("WorldsGenerateRequest")) {
  throw new Error("Downloaded content does not look like the World Labs OpenAPI specification");
}
await writeFile("openapi.yaml", content, "utf8");
console.log("Saved openapi.yaml. Review changes before regenerating client types.");
