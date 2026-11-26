# devin-receipt-demo

Scenario repo for the Garnet session receipt Devin plugin (garnet-labs/garnet-runtime-review-mcp, `plugins/devin/garnet-session-receipt`).

- `main`: an honest `npm install` + `npm test` (scenario A).
- `packages/receipt-canary`: a synthetic dependency whose postinstall reaches `example.com` and reads files under `~/.ssh` (scenario B). It sends nothing and holds no secret; it exists to be recorded.

After `main` advances, push to the PR branch to get a replacement Garnet runtime comparison.
