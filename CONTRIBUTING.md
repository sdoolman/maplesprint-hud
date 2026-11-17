# Contributing to MapleSprint HUD

Contributions to the modular HUD (`index.html`, `js/`, `style.css`, `pip.css`), Go relay (`forwarder/`), and Linux deploy scripts (`deploy/`) are welcome!

## Before Opening a PR
1. Run local checks:
   ```bash
   cd forwarder && go vet ./... && go test -v ./...
   cd .. && node --test verify.mjs
   ```
2. Never commit real IPs, WireGuard keys, or private `INGEST_KEY` values.
3. Keep `forwarder/` lightweight (minimal auditable dependencies only: `golang.org/x/net`).
