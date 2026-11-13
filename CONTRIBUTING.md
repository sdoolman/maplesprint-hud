# Contributing to MapleSprint HUD

Contributions to the HUD (`index.html`, `app.js`, `style.css`), Go forwarder (`forwarder/`), client preflight (`client/`), and deploy scripts (`deploy/`) are welcome!

## Before Opening a PR
1. Run the local checks:
   ```bash
   cd forwarder && go vet ./... && go test -v ./...
   node --check app.js
   ```
2. Never commit real IPs, WireGuard keys, `client/config.json`, or `INGEST_KEY` values.
3. Keep `forwarder/` dependency-free (Go stdlib only).
