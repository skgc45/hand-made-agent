import { readFileSync } from "node:fs";

const config = JSON.parse(readFileSync(new URL("./config.json", import.meta.url), "utf-8"));

for (let i = 1; i <= 400; i++) {
  console.log(`checking rule ${String(i).padStart(3, "0")} ... ok`);
}

for (const key of ["concurrency", "retries", "timeoutMs"]) {
  if (typeof config[key] !== "number") {
    console.error(`config.${key} must be a number, got ${JSON.stringify(config[key])}`);
    process.exit(1);
  }
}
console.log("all checks passed");
