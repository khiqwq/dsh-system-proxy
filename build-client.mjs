import { copyFile, mkdir } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = dirname(fileURLToPath(import.meta.url));
const output = resolve(root, "lib/client.js");
await mkdir(dirname(output), { recursive: true });
await copyFile(resolve(root, "client.js"), output);
console.log("built lib/client.js");
