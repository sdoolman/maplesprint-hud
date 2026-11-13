<div align="center">

# ⚡ MapleSprint HUD

**Real-time EXP/hr, kills, HP/MP, and loot on your phone or second screen**  
*Zero drivers · Zero OCR · Safe single-IP tunnel · Fail-closed launch*

[![Live HUD](https://img.shields.io/badge/Live_HUD-Open_App-2ea44f?style=for-the-badge&logo=githubpages&logoColor=white)](https://sdoolman.github.io/maplesprint-hud/)
[![CI & Releases](https://img.shields.io/github/actions/workflow/status/sdoolman/maplesprint-hud/ci.yml?style=for-the-badge&label=Build)](https://github.com/sdoolman/maplesprint-hud/actions)
[![Latest Release](https://img.shields.io/github/v/release/sdoolman/maplesprint-hud?style=for-the-badge&color=blue)](https://github.com/sdoolman/maplesprint-hud/releases)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg?style=for-the-badge)](LICENSE)

</div>

---

## ✨ How It Works

Your game traffic stays clean on a single IP through WireGuard, while a lightweight forwarder mirrors a copy to the telemetry server — which streams live stats straight to your phone:

```text
  🎮 Gaming PC ──(WireGuard)──▶ 🌐 Endpoint ──▶ 🍁 Game Servers
        │                            │
   (preflight.ps1)              (mirrors copy)
        │                            ▼
        └──────────────▶ ☁️ Telemetry Hub (Blackbox)
                                     │
                                     ▼
                              📱 Phone / Browser HUD
```

- **Nothing touches the game:** No memory reading, no screen capture, no kernel drivers on your PC.
- **Fail-closed launcher:** Won't launch the game unless your tunnel and live feed are both 100% ready.

---

## 🚀 Quick Start (3 Minutes)

### 1️⃣ Start the Endpoint (Cloud VM, Raspberry Pi, or WSL2)
Download the latest `wg-forwarder` binary from [**Releases**](https://github.com/sdoolman/maplesprint-hud/releases) (or let the script build it) and run:

```bash
./deploy/start_endpoint.sh https://<your-hub-url> my-room wg0
```

<details>
<summary>🔧 First-time WireGuard endpoint setup? Click here</summary>

1. Generate keys on your endpoint:
   ```bash
   wg genkey | tee endpoint.key | wg pubkey > endpoint.pub
   wg genkey | tee client.key   | wg pubkey > client.pub
   ```
2. Copy [`deploy/wg0.conf.example`](deploy/wg0.conf.example) to `/etc/wireguard/wg0.conf`, paste `<ENDPOINT_PRIVATE_KEY>` and `<CLIENT_PUBLIC_KEY>`, and start it:
   ```bash
   sudo wg-quick up wg0
   ```
3. Make sure **UDP port `51820`** is allowed in your firewall / router.

</details>

---

### 2️⃣ Connect WireGuard & Verify Ready (Windows)
1. Import your WireGuard `.conf` in [**WireGuard for Windows**](https://www.wireguard.com/install/) and click **Activate**.
2. Copy [`client/config.example.json`](client/config.example.json) → `client/config.json` and fill in `worker_url`, `room_id`, and `gateway_ip`.
3. Run the read-only preflight check, then launch your game normally:
   ```powershell
   .\client\preflight.ps1
   ```
   > **Clean exit:** `preflight.ps1` only checks that your tunnel and forwarder are live, then exits immediately — nothing stays running in the background and no script launches the game.

<details>
<summary>📄 Example Windows WireGuard client config</summary>

```ini
[Interface]
PrivateKey = <CLIENT_PRIVATE_KEY>
Address = <CLIENT_WG_IP>/32
DNS = 1.1.1.1

[Peer]
PublicKey = <ENDPOINT_PUBLIC_KEY>
Endpoint = <ENDPOINT_IP>:<WG_PORT>
AllowedIPs = 0.0.0.0/0
PersistentKeepalive = 25
```

</details>

---

### 3️⃣ Open Your Live HUD
Open [**sdoolman.github.io/maplesprint-hud**](https://sdoolman.github.io/maplesprint-hud/) on your phone or second monitor, enter your **Hub URL** + your chosen **Room ID**, and hit **Connect**!
*(Each room allows one active forwarder at a time — returning after a 5-minute idle timeout automatically resets the room.)*

---

## 🛠️ Troubleshooting & Options

<details>
<summary>❓ Common fixes & CLI flags</summary>

| Problem | Quick Fix |
|---|---|
| **WG gateway unreachable** | Make sure WireGuard is **Activated** on Windows and UDP `51820` is open on the endpoint |
| **Forwarder offline (`ingester: false`)** | Check that `./deploy/start_endpoint.sh` is running with the same `room_id` |
| **No internet through tunnel** | Check that your endpoint's outbound NIC name in `wg0.conf` (e.g. `eth0` vs `ens3`) matches `ip route get 1.1.1.1` |

**Forwarder flags (`wg-forwarder`):**
- `--worker` *(required)*: Hub URL (`https://...`)
- `--room` *(default `default`)*: Room ID
- `--iface` *(default `wg0`)*: Interface to mirror
- `--key` *(optional)*: Access key (or `INGEST_KEY` env var)

</details>

---

## 🤝 Contributing & License

Pull requests for HUD improvements, endpoint scripts, or forwarder fixes are welcome — see [`CONTRIBUTING.md`](CONTRIBUTING.md).  
Licensed under the [MIT License](LICENSE).
