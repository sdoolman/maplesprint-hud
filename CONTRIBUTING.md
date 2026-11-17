# Contributing to MapleSprint HUD

Contributions to the modular HUD (`web/`) and Go relay (`relay/`) are welcome!

## Before Opening a PR
1. Run local checks:
   ```bash
   cd relay && go vet ./... && go test -v ./...
   cd .. && node --test tests/verify.mjs
   ```
2. Never commit real IPs, WireGuard keys, or private `INGEST_KEY` values.
3. Keep `relay/` lightweight (minimal auditable dependencies only: `golang.org/x/net`).
