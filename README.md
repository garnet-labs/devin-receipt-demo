# devin-receipt-demo

Scenario repo for the Garnet session receipt Devin plugin (garnet-labs/garnet-runtime-review-mcp, `plugins/devin/garnet-session-receipt`).

- `main`: an honest `npm install` + `npm test` (scenario A).
- `packages/receipt-canary`: a synthetic dependency whose postinstall reaches `example.com` and reads `~/.ssh/known_hosts` (scenario B). It sends nothing and holds no secret; it exists to be recorded.
