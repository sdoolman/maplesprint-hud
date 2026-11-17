<div align="center">

# ⚡ MapleSprint HUD

**Real-time EXP/hr, Level ETA, Best Maps Guide, and Loot on your phone or second screen**  
*Zero drivers · Zero OCR · Safe single-IP tunnel · Open-source local relay · Pluggable codec*

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
                              📱 Browser / Phone HUD ◀──(./codec.mjs or custom ?codec=)
```

- **Nothing touches the game:** No memory reading, no screen capture, no window hooks, and no custom kernel drivers on your PC.
- **100% Open-Source & Slim Relay:** The local endpoint executable only relays raw TCP segments over localhost (`127.0.0.1:8080`) with zero UAC or Windows Firewall popups.
- **Browser-Independent Game Stability:** Closing or refreshing the HUD tab never interrupts or lags your game connection.

---

## 🚀 Quick Start (3 Minutes)

### 1️⃣ Start the Local Endpoint
Download **`maplesprint-endpoint-windows-amd64.zip`** from [**Releases**](https://github.com/sdoolman/maplesprint-hud/releases), extract, and double-click **`maplesprint-endpoint-windows-amd64.exe`**:

- Launches silently in the **Windows System Tray** (bottom-right taskbar icon) with zero console windows.
- Automatically opens [**sdoolman.github.io/maplesprint-hud**](https://sdoolman.github.io/maplesprint-hud/) in your browser (right-click the tray icon for **Open HUD**, **Open Relay Log**, or **Quit**).

---

### 2️⃣ Connect WireGuard (Windows)
1. Open [**sdoolman.github.io/maplesprint-hud**](https://sdoolman.github.io/maplesprint-hud/) and open the **`⚙ Setup`** tab.
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

## 🧩 Open Data & Bring Your Own Codec (BYOC)

You own your local network data. `maplesprint-endpoint` and the HUD are intentionally decoupled from any proprietary packet parser:

- **How the Official HUD Ships `codec.mjs`:** On the hosted GitHub Pages app ([`sdoolman.github.io/maplesprint-hud`](https://sdoolman.github.io/maplesprint-hud/)), the pre-built `codec.mjs` release artifact is pulled automatically during the GitHub Actions Pages deployment (`ci.yml`) so built codec bundles are never tracked in git.
- **Use Your Own Custom Codec (`?codec=`):** Want to experiment with your own packet decoder, support a custom server, or emit custom events? Pass any ES module URL via `?codec=http://127.0.0.1:3000/my-codec.mjs` (or drop a `codec.mjs` file alongside `index.html`).
- **Consume the Local Stream Directly:** Any local script or third-party overlay can connect to `ws://127.0.0.1:8080/ws` to read raw TCP segments (`{ "type": "raw_chunk", "flow", "seq", "sport", "data" }`).

<details>
<summary>🔌 Custom Codec ES Module Interface (<code>MapleDecoder</code>)</summary>

```js
// Example custom codec module (?codec=http://127.0.0.1:3000/my-codec.mjs)
export class MapleDecoder {
  /**
   * @param {string} flow     TCP flow identifier ("srcIP:sport->dstIP:dport")
   * @param {number} seq      TCP sequence number (uint32)
   * @param {Uint8Array} raw  Raw TCP payload bytes
   * @returns {Array<{ type: string, ts: number, [key: string]: any }>}
   */
  feedChunk(flow, seq, raw) {
    return [];
  }

  reset() {}
}
```

</details>

---

## 🛠️ Troubleshooting

| Problem | Quick Fix |
|---|---|
| **Endpoint shows `Offline` in dashboard** | Make sure `maplesprint-endpoint-windows-amd64.exe` is running and the URL is set to `http://127.0.0.1:8080` |
| **WireGuard tunnel shows `Waiting (:51820)`** | Make sure `MapleSprint.conf` is **Activated** in WireGuard for Windows and you are logged into a game channel |
| **Mini overlay doesn't float on top** | Use Chrome or Edge (which support the W3C Document Picture-in-Picture API) |

---

## 🤝 Contributing & License

Pull requests for HUD improvements or Go relay fixes are welcome — see [`CONTRIBUTING.md`](CONTRIBUTING.md).  
Licensed under the [MIT License](LICENSE).
