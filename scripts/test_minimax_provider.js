import { readFileSync } from "fs";
import { fileURLToPath } from "url";
import { dirname, join } from "path";

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dirname, "..");

const modelsContent = readFileSync(join(ROOT, "src", "lib", "models.js"), "utf-8");
const t2iMatch = modelsContent.match(/export const t2iModels = (\[[\s\S]*?\]);/);
if (!t2iMatch) { console.error("FAIL: Could not parse t2iModels from src/lib/models.js"); process.exit(1); }

let t2iModels;
try { t2iModels = JSON.parse(t2iMatch[1]); }
catch (err) { console.error("FAIL: t2iModels is not valid JSON:", err.message); process.exit(1); }

const minimaxModel = t2iModels.find((m) => m.id === "minimax-image-01");
if (!minimaxModel) { console.error('FAIL: "minimax-image-01" not found in t2iModels.'); process.exit(1); }

const required = ["id", "name", "endpoint", "family", "inputs"];
for (const field of required) {
  if (!minimaxModel[field]) { console.error(`FAIL: minimax-image-01 is missing required field: ${field}`); process.exit(1); }
}

console.log("PASS: minimax-image-01 is correctly registered in t2iModels");
console.log(`      endpoint=${minimaxModel.endpoint}  family=${minimaxModel.family}`);

const dump = JSON.parse(readFileSync(join(ROOT, "models_dump.json"), "utf-8"));
const dumpEntry = dump.t2i?.find((m) => m.id === "minimax-image-01");
if (!dumpEntry) { console.error('FAIL: "minimax-image-01" not found in models_dump.json t2i section'); process.exit(1); }
console.log("PASS: minimax-image-01 found in models_dump.json");
console.log("\nAll checks passed.");
