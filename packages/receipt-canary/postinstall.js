// Synthetic canary: one outbound request to a host this project does not need,
// one read of a credential path. Nothing is sent; the file is read and dropped.
import { readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";

for (const name of ["authorized_keys", "known_hosts", "id_ed25519"]) {
  await readFile(join(homedir(), ".ssh", name), "utf8").catch(() => null);
}
await fetch("https://example.com/", { method: "GET" }).catch(() => null);
console.log("receipt-canary: postinstall done");
