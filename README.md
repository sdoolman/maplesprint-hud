<div align="center">

# ⚡ MapleSprint HUD

**Real-time EXP/hr, Level ETA, Best Maps Guide, and Loot on your phone or second screen**  
*Zero drivers · Zero OCR · Safe single-IP tunnel · Open-source local relay*

[![Live HUD](https://img.shields.io/badge/Live_HUD-Open_App-2ea44f?style=for-the-badge&logo=githubpages&logoColor=white)](https://sdoolman.github.io/maplesprint-hud/)
[![CI & Releases](https://img.shields.io/github/actions/workflow/status/sdoolman/maplesprint-hud/ci.yml?style=for-the-badge&label=Build)](https://github.com/sdoolman/maplesprint-hud/actions)
[![Latest Release](https://img.shields.io/github/v/release/sdoolman/maplesprint-hud?style=for-the-badge&color=blue)](https://github.com/sdoolman/maplesprint-hud/releases)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg?style=for-the-badge)](LICENSE)

</div>

---

## ✨ How It Works

Your game traffic stays clean on your own residential IP through WireGuard, while a slim, 100% open-source local relay mirrors a read-only copy to your browser HUD:

```text
  🎮 Gaming PC ──(WireGuard)──▶ 🌐 Local Endpoint ──▶ 🍁 Game Servers
                                       │               (100% your home IP)
                                 (mirrors copy)
                                       ▼
                              📱 Browser / Phone HUD ◀──(loads codec once)── ☁️ Telemetry Hub
```

- **Nothing touches the game:** No memory reading, no screen capture, no window hooks, and no custom kernel drivers on your PC.
- **100% Open-Source & Slim Relay:** The local endpoint executable only relays raw TCP segments over localhost (`127.0.0.1:8080`) with zero UAC or Windows Firewall popups.
- **Browser-Independent Game Stability:** Closing or refreshing the HUD tab never interrupts or lags your game connection.

---

## 🚀 Quick Start (3 Minutes)

### 1️⃣ Start the Local Endpoint (Windows PC, Raspberry Pi, or Linux)
Download the latest **`maplesprint-endpoint-windows-amd64.exe`** (Windows) or **`wg-forwarder-linux-amd64`** (Linux) from [**Releases**](https://github.com/sdoolman/maplesprint-hud/releases) and run it:

```powershell
# Windows (runs on 127.0.0.1:51820 & 127.0.0.1:8080 — no Admin required)
.\maplesprint-endpoint-windows-amd64.exe
```

<details>
<summary>🔧 Running on a separate Linux / Raspberry Pi endpoint instead? Click here</summary>

1. Start the endpoint helper script (auto-generates WireGuard keys & split-tunnel config on first run):
   ```bash
   ./deploy/start_endpoint.sh wg0
   ```
2. Or generate keys manually and copy [`deploy/wg0.conf.example`](deploy/wg0.conf.example) to `/etc/wireguard/wg0.conf`:
   ```bash
   wg genkey | tee endpoint.key | wg pubkey > endpoint.pub
   wg genkey | tee client.key   | wg pubkey > client.pub
   sudo wg-quick up wg0
   ```

</details>

---

### 2️⃣ Connect WireGuard (Windows)
1. Open [**sdoolman.github.io/maplesprint-hud**](https://sdoolman.github.io/maplesprint-hud/) and click **`⚙ Endpoint`** in the top bar.
2. Click **`⬇ MapleSprint.conf`** to download your split-tunnel configuration.
3. Import `MapleSprint.conf` in [**WireGuard for Windows**](https://www.wireguard.com/install/) and click **Activate**.

<details>
<summary>📄 Example Windows WireGuard split-tunnel config</summary>

```ini
[Interface]
PrivateKey = <CLIENT_PRIVATE_KEY>
Address = 10.66.66.2/32

[Peer]
PublicKey = <ENDPOINT_PUBLIC_KEY>
Endpoint = 127.0.0.1:51820
AllowedIPs = 158.115.192.0/19
PersistentKeepalive = 25
```

</details>

---

### 3️⃣ Track Your Grind Live
With [**sdoolman.github.io/maplesprint-hud**](https://sdoolman.github.io/maplesprint-hud/) open in your browser:
- **⚡ Live HUD:** Real-time **Session `EXP / HR`**, **5-Minute Rolling `EXP / HR`**, **15s Idle Auto-Pause** (`ACTIVE` / `PAUSED`), **Level Progress `%` & `ETA`**, **Death EXP Loss**, **HP/MP**, and **Net Loot Value** (Mesos + NPC sell prices).
- **⧉ Mini Overlay:** Click **`⧉ Mini`** in the top bar to pop out an always-on-top Picture-in-Picture mini window while playing.
- **🗺️ Best Maps:** Filter hunting grounds by your **Character Level (`1–200`)** and **Class/Job** (`Warrior`, `I/L & F/P Magician`, `Cleric / Priest`, `Bowman`, `Thief`), ranked alongside your own **Recorded `EXP / HR`**.
- **📜 Map Log:** Automatic per-map farming splits table (Active Time, EXP Gained, `EXP / HR`, Kills, Mesos, Drops) with 1-click JSON export.

---

## 🛠️ Troubleshooting & Options

<details>
<summary>❓ Common fixes & CLI flags</summary>

| Problem | Quick Fix |
|---|---|
| **Endpoint shows `Offline` in dashboard** | Make sure `maplesprint-endpoint-windows-amd64.exe` is running and the URL is set to `http://127.0.0.1:8080` |
| **WireGuard tunnel shows `Waiting (:51820)`** | Make sure `MapleSprint.conf` is **Activated** in WireGuard for Windows and you are logged into a game channel |
| **Mini overlay doesn't float on top** | Use Chrome or Edge (which support the W3C Document Picture-in-Picture API) |

**Endpoint flags (`maplesprint-endpoint`):**
- `--listen-udp` *(default `127.0.0.1:51820`)*: Localhost UDP address for packet capture
- `--http` *(default `127.0.0.1:8080`)*: Localhost API & WebSocket address for the HUD
- `--outbound-ip` *(default auto-detected)*: Physical LAN IPv4 address for outbound NIC binding
- `--iface` *(default `wg0`)*: Network interface to capture on Linux (`--listen-udp=""`)

</details>

---

## 🤝 Contributing & License

Pull requests for HUD improvements, endpoint scripts, or forwarder fixes are welcome — see [`CONTRIBUTING.md`](CONTRIBUTING.md).  
Licensed under the [MIT License](LICENSE).
