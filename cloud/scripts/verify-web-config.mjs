import { readFile, readdir } from "node:fs/promises";
import path from "node:path";
import process from "node:process";
import { loadEnv } from "vite";

const mode = process.argv[2];
if (!mode || !/^[a-z0-9_-]+$/u.test(mode)) {
  throw new Error("Usage: node scripts/verify-web-config.mjs <vite-mode>");
}

const projectRoot = process.cwd();
const env = loadEnv(mode, projectRoot, "");
const required = [
  "VITE_FIREBASE_API_KEY",
  "VITE_FIREBASE_AUTH_DOMAIN",
  "VITE_FIREBASE_PROJECT_ID",
  "VITE_FIREBASE_WEB_APP_ID",
  "VITE_FIREBASE_MESSAGING_SENDER_ID",
];
const missing = required.filter((name) => !env[name]?.trim());
if (missing.length > 0) {
  throw new Error(`Refusing to deploy: ${mode} web configuration is missing ${missing.join(", ")}`);
}
if (!env.VITE_FIREBASE_WEB_APP_ID.includes(":web:")) {
  throw new Error(`Refusing to deploy: ${mode} Firebase app ID is not a Web app ID`);
}

const assetsDirectory = path.join(projectRoot, "dist", "assets");
const javascriptFiles = (await readdir(assetsDirectory)).filter((name) => name.endsWith(".js"));
if (javascriptFiles.length === 0) throw new Error("Refusing to deploy: no built browser JavaScript was found");
const bundles = await Promise.all(javascriptFiles.map((name) => readFile(path.join(assetsDirectory, name), "utf8")));
const compiled = bundles.join("\n");
for (const name of required) {
  if (!compiled.includes(env[name])) {
    throw new Error(`Refusing to deploy: ${name} was not embedded in the ${mode} browser bundle`);
  }
}

console.log(`Verified Firebase Web configuration in the ${mode} browser bundle.`);
