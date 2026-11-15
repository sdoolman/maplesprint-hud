# MapleSprint HUD (`maplesprint-hud`)

Real-time **MapleStory Classic World** telemetry HUD, **WireGuard + Endpoint Dashboard**, **Level & Class Optimal Map Guide**, and **Per-Map Farming Split Logger**.

---

## Architecture: Open-Source Local Relay + Browser WebAssembly (`codec.wasm`)

MapleSprint separates the local network relay from the packet decoder so the local `.exe` on your gaming PC is **100% open-source, slim, and auditable**, while all MapleStory packet decoding runs inside your browser via **`codec.wasm`**:

```text
┌───────────────────────────────────────────────────────────────────────────┐
│                         GAMING PC (Windows 10/11)                         │
│                                                                           │
│  1. MapleStory.exe ──► Official WireGuard (127.0.0.1:51820)               │
│     • Split-tunnel routes only 158.115.192.0/19 (ports 8484–8999)         │
│                               │                                           │
│                               ▼                                           │
│  2. maplesprint-endpoint.exe (100% Open-Source, Slim Generic TCP Relay)   │
│     • Binds outbound sockets to physical Wi-Fi/LAN IP (zero routing loop) │
│     • Loopback-only API on 127.0.0.1:8080 (zero UAC or Firewall popups)   │
│     • Mirrors raw S->C TCP chunks to ws://127.0.0.1:8080/ws               │
│                               │                                           │
│                               ▼ (0 ms localhost WebSocket)                │
│  3. GitHub Pages HUD (https://sdoolman.github.io/maplesprint-hud/)        │
│     • WireGuard + Endpoint Status Dashboard & 1-click MapleSprint.conf    │
│     • Decodes raw TCP segments locally in browser via codec.wasm          │
│     • Live HUD, Best Maps Guide, Map Splits Log, & PiP Mini Overlay       │
└───────────────────────────────────────────────────────────────────────────┘
```

### Why This Design Is Safe & Clean
- **100% Home Residential IP:** Game traffic exits directly from your physical Wi-Fi/Ethernet NIC (`NewPhysicalNICDialer`) to Nexon — never through a shared cloud or datacenter IP.
- **Game Stability Independent of Browser:** Chrome is never in the critical game forwarding path. Refreshing or closing the HUD tab never interrupts or lags `MapleStory.exe`.
- **Zero Screen Hooks or Memory Injection:** Unlike OCR overlays that hook `MapleStory.exe` windows and trigger antivirus alerts, `maplesprint-endpoint` is a tiny, dependency-light Go socket relay (`golang.org/x/net/websocket`) with zero embedded UI and zero game-specific code.
- **Instant Decoder Updates via GitHub Pages:** Whenever game opcodes update, `codec.wasm` updates directly on GitHub Pages without requiring users to re-download `maplesprint-endpoint.exe`.

---

## Features

1. **WireGuard + Endpoint Dashboard (`⚙ Endpoint`):**
   - Live status indicators for **WireGuard Tunnel (`:51820`)**, **Endpoint Relay (`127.0.0.1:8080`)**, **Outbound Physical NIC IP (No-Loop)**, and **Browser `codec.wasm`**.
   - 1-click **`⬇ MapleSprint.conf`** download directly from the dashboard.
2. **⚡ Live HUD:**
   - **15-Second Idle Auto-Pause (`ACTIVE` / `PAUSED` badge):** Freezes active grind timers when you stop attacking/looting for >15 seconds.
   - **Session & 5-Minute Rolling `EXP / HR`:** Real-time grind rate plus a 5-minute rolling window (`5m: X/h`).
   - **Level Progress `%` & Time-To-Level (`ETA`):** Uses the Classic World Level `1–200` EXP table (`CLASSIC_EXP_TABLE`).
   - **Death EXP Loss Tracking:** Accurately reflects negative EXP deltas upon character death.
   - **Net Loot Value (`Mesos + NPC Item Value`):** Automatically prices dropped items using `items.json` NPC sell values.
   - **⧉ Mini Overlay (Document Picture-in-Picture):** Pops out an always-on-top compact overlay window showing live `EXP / HR`, `5m` rate, `Lv. %`, and `ETA`.
3. **🗺️ Best Maps (Level & Class Hunting Guide):**
   - Ranks every hunting ground in `maps.json` + `monsters.json` for your exact **Character Level (`1–200`)** and **Class/Job** (`Warrior`, `I/L & F/P Magician`, `Cleric / Priest` Holy/Undead bonus, `Bowman`, `Thief`), blended with your own **Recorded `EXP / HR`**.
4. **📜 Map Log (Per-Map Farming Splits):**
   - Automatically logs a split row for every map visited (Active Time, EXP Gained, `EXP / HR`, Kills, Net Mesos, Drops), persisted to `localStorage` with 1-click JSON export.

---

## Verification

```bash
node --check app.js
node --test verify.mjs
```
