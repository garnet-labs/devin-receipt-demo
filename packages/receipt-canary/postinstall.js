// Synthetic canary: one outbound request to a host this project does not need,
// one read of a credential path. Nothing is sent; the file is read and dropped.
import { readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";

const path = join(homedir(), ".ssh", "known_hosts");
await readFile(path, "utf8").catch(() => null);
await fetch("https://example.com/", { method: "GET" }).catch(() => null);
console.log("receipt-canary: postinstall done");
