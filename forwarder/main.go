// MapleSprint Open-Source Local Endpoint Relay
//
// This slim, auditable local daemon bridges your WireGuard split-tunnel
// interface (158.115.192.0/19, TCP source ports 8484-8999) to the MapleSprint
// HUD running in your browser (https://sdoolman.github.io/maplesprint-hud/).
//
// Design principles:
//   - 100% Open-Source & Auditable: No game packet decoding or proprietary logic lives here.
//   - Loopback-Only API (127.0.0.1:8080): Never exposes ports to the public internet and
//     never triggers Windows Defender Firewall prompts.
//   - Physical NIC Binding: Outbound connections bind directly to your physical Wi-Fi/LAN IP
//     so traffic on a single Windows PC never loops back into the WireGuard tunnel.
//   - Browser-Only UI: The GitHub Pages HUD serves as both the endpoint status dashboard
//     and the live telemetry overlay (decoded in-browser via codec.mjs).
package main

import (
	"context"
	"encoding/base64"
	"encoding/binary"
	"encoding/json"
	"errors"
	"flag"
	"fmt"
	"log"
	"net"
	"net/http"
	"net/url"
	"os"
	"os/signal"
	"sync"
	"sync/atomic"
	"syscall"
	"time"

	"golang.org/x/net/websocket"
)

const (
	defaultHUDURL          = "https://sdoolman.github.io/maplesprint-hud/"
	ethPAll                = 0x0003
	etherHeaderLen         = 14
	etherTypeIPv4          = 0x0800
	pppHeaderLen           = 4
	pppCompactHeaderLen    = 2
	pppProtoIPv4           = 0x0021
	arphrdEther            = 1
	arphrdPPP              = 512
	arphrdNone             = 0xfffe
	pcapGlobalAndPacketLen = 40 // 24-byte pcap file header + 16-byte packet header
	pcapMagicLE            = 0xa1b2c3d4
	nullLoopbackHdrLen     = 16
)

// RawChunk is the read-only TCP segment envelope streamed to the browser HUD.
type RawChunk struct {
	Type  string `json:"type"`
	Flow  string `json:"flow"`
	Seq   uint32 `json:"seq"`
	Sport uint16 `json:"sport"`
	Data  string `json:"data"`
}

// EndpointStatus is returned by GET /status for the Setup dashboard in the HUD.
type EndpointStatus struct {
	OK             bool   `json:"ok"`
	Service        string `json:"service"`
	Mode           string `json:"mode"`
	ListenAddr     string `json:"listen_addr"`
	OutboundIP     string `json:"outbound_ip"`
	PortRange      string `json:"port_range"`
	PacketsRelayed uint64 `json:"packets_relayed"`
	LastPacketTs   int64  `json:"last_packet_ts"`
	ConnectedHUDs  int    `json:"connected_huds"`
	ConfAvailable  bool   `json:"conf_available"`
}

// PacketSource abstracts packet capture from a WireGuard interface or local UDP socket.
type PacketSource interface {
	ReadPacket(buf []byte) ([]byte, uint16, error)
	Close() error
}

// UDPPacketSource receives raw IPv4 packets over a localhost UDP socket (zero admin privileges required).
type UDPPacketSource struct {
	conn *net.UDPConn
}

func OpenUDPPacketSource(listenAddr string) (*UDPPacketSource, error) {
	addr, err := net.ResolveUDPAddr("udp", listenAddr)
	if err != nil {
		return nil, err
	}
	conn, err := net.ListenUDP("udp", addr)
	if err != nil {
		return nil, err
	}
	return &UDPPacketSource{conn: conn}, nil
}

func (u *UDPPacketSource) ReadPacket(buf []byte) ([]byte, uint16, error) {
	n, _, err := u.conn.ReadFromUDP(buf)
	if err != nil {
		return nil, 0, err
	}
	raw := buf[:n]
	if len(raw) > pcapGlobalAndPacketLen && binary.LittleEndian.Uint32(raw[0:4]) == pcapMagicLE {
		raw = raw[pcapGlobalAndPacketLen:]
	} else if len(raw) > 20 && (raw[0]>>4) != 4 && (raw[nullLoopbackHdrLen]>>4) == 4 {
		raw = raw[nullLoopbackHdrLen:]
	}
	return raw, arphrdNone, nil
}

func (u *UDPPacketSource) Close() error {
	return u.conn.Close()
}

func htons(v uint16) uint16 {
	return (v<<8)&0xff00 | (v>>8)&0x00ff
}

// DetectPhysicalOutboundIP finds the primary non-loopback, non-tunnel LAN IPv4 address
// so outbound connections bypass the local WireGuard tunnel without routing loops.
func DetectPhysicalOutboundIP() string {
	ifaces, err := net.Interfaces()
	if err != nil {
		return ""
	}
	for _, iface := range ifaces {
		if (iface.Flags&net.FlagUp) == 0 || (iface.Flags&net.FlagLoopback) != 0 {
			continue
		}
		addrs, err := iface.Addrs()
		if err != nil {
			continue
		}
		for _, a := range addrs {
			ipNet, ok := a.(*net.IPNet)
			if !ok {
				continue
			}
			ip4 := ipNet.IP.To4()
			if ip4 == nil || ip4.IsLoopback() {
				continue
			}
			// Skip the 10.66.66.0/24 WireGuard tunnel subnet
			if ip4[0] == 10 && ip4[1] == 66 && ip4[2] == 66 {
				continue
			}
			return ip4.String()
		}
	}
	return ""
}

// NewPhysicalNICDialer returns a net.Dialer bound explicitly to the physical LAN IP
// so outbound sockets exit through the physical router rather than re-entering WireGuard.
func NewPhysicalNICDialer(outboundIP string, timeout time.Duration) *net.Dialer {
	d := &net.Dialer{Timeout: timeout}
	if ip := net.ParseIP(outboundIP); ip != nil {
		d.LocalAddr = &net.TCPAddr{IP: ip, Port: 0}
	}
	return d
}

func validatePortRange(flagMin, flagMax int) (int, int, error) {
	if flagMin < 0 || flagMax > 65535 || flagMax < flagMin {
		return 0, 0, fmt.Errorf("invalid port range %d-%d (must satisfy 0 <= min <= max <= 65535)", flagMin, flagMax)
	}
	return flagMin, flagMax, nil
}

// stripLinkHeader strips L2/PPP framing and validates the leading IPv4 header nibble.
func stripLinkHeader(pkt []byte, hatype uint16) ([]byte, bool) {
	offset := 0
	switch hatype {
	case arphrdEther:
		if len(pkt) < etherHeaderLen || binary.BigEndian.Uint16(pkt[12:14]) != etherTypeIPv4 {
			return nil, false
		}
		offset = etherHeaderLen
	case arphrdPPP:
		if len(pkt) >= pppHeaderLen && pkt[0] == 0xff && pkt[1] == 0x03 && binary.BigEndian.Uint16(pkt[2:4]) == pppProtoIPv4 {
			offset = pppHeaderLen
		} else if len(pkt) >= pppCompactHeaderLen && binary.BigEndian.Uint16(pkt[0:2]) == pppProtoIPv4 {
			offset = pppCompactHeaderLen
		} else if len(pkt) > 0 && (pkt[0]>>4) != 4 {
			return nil, false
		}
	default:
		if hatype != arphrdNone && len(pkt) > 0 && (pkt[0]>>4) != 4 {
			return nil, false
		}
	}
	ip := pkt[offset:]
	if len(ip) < 20 || (ip[0]>>4) != 4 {
		return nil, false
	}
	return ip, true
}

// parseTCPPayload extracts the TCP flow tuple, sequence number, source port, and payload
// from an IPv4 packet. It performs zero game-specific inspection.
func parseTCPPayload(pkt []byte, hatype uint16) (RawChunk, bool) {
	ip, ok := stripLinkHeader(pkt, hatype)
	if !ok {
		return RawChunk{}, false
	}
	ihl := int(ip[0]&0x0f) * 4
	totalLen := int(binary.BigEndian.Uint16(ip[2:4]))
	if ihl < 20 || len(ip) < ihl || ip[9] != 6 {
		return RawChunk{}, false
	}
	if totalLen > 0 && totalLen < len(ip) {
		ip = ip[:totalLen]
	}

	tcp := ip[ihl:]
	if len(tcp) < 20 {
		return RawChunk{}, false
	}
	doff := int((tcp[12]>>4)&0x0f) * 4
	if doff < 20 || len(tcp) < doff {
		return RawChunk{}, false
	}
	payload := tcp[doff:]
	if len(payload) == 0 {
		return RawChunk{}, false
	}

	sport := binary.BigEndian.Uint16(tcp[0:2])
	dport := binary.BigEndian.Uint16(tcp[2:4])
	seq := binary.BigEndian.Uint32(tcp[4:8])
	srcIP := net.IP(ip[12:16]).String()
	dstIP := net.IP(ip[16:20]).String()

	return RawChunk{
		Type:  "raw_chunk",
		Flow:  fmt.Sprintf("%s:%d->%s:%d", srcIP, sport, dstIP, dport),
		Seq:   seq,
		Sport: sport,
		Data:  base64.StdEncoding.EncodeToString(payload),
	}, true
}

// RelayHub broadcasts raw TCP chunks over standard WebSockets to the GitHub Pages HUD.
type RelayHub struct {
	mu             sync.Mutex
	clients        map[*websocket.Conn]struct{}
	packetsRelayed atomic.Uint64
	lastPacketTs   atomic.Int64
}

func NewRelayHub() *RelayHub {
	return &RelayHub{clients: make(map[*websocket.Conn]struct{})}
}

func (h *RelayHub) Broadcast(c RawChunk) {
	h.packetsRelayed.Add(1)
	h.lastPacketTs.Store(time.Now().UnixMilli())

	h.mu.Lock()
	defer h.mu.Unlock()
	for ws := range h.clients {
		_ = ws.SetWriteDeadline(time.Now().Add(2 * time.Second))
		if err := websocket.JSON.Send(ws, c); err != nil {
			_ = ws.Close()
			delete(h.clients, ws)
		}
	}
}

func (h *RelayHub) ClientCount() int {
	h.mu.Lock()
	defer h.mu.Unlock()
	return len(h.clients)
}

func (h *RelayHub) ServeWS(ws *websocket.Conn) {
	h.mu.Lock()
	h.clients[ws] = struct{}{}
	h.mu.Unlock()

	defer func() {
		h.mu.Lock()
		delete(h.clients, ws)
		h.mu.Unlock()
		_ = ws.Close()
	}()

	_ = websocket.JSON.Send(ws, map[string]any{
		"type": "endpoint_ready",
		"mode": "raw_relay",
		"ts":   time.Now().UnixMilli(),
	})

	var msg map[string]any
	for {
		if err := websocket.JSON.Receive(ws, &msg); err != nil {
			return
		}
	}
}

// withCORS attaches standard CORS and Chrome Private Network Access (PNA) headers
// so https://sdoolman.github.io/maplesprint-hud/ can query http://127.0.0.1:8080 directly.
func withCORS(next http.HandlerFunc) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Access-Control-Allow-Origin", "*")
		w.Header().Set("Access-Control-Allow-Methods", "GET, POST, OPTIONS")
		w.Header().Set("Access-Control-Allow-Headers", "Content-Type")
		w.Header().Set("Access-Control-Allow-Private-Network", "true")
		if r.Method == http.MethodOptions {
			w.WriteHeader(http.StatusNoContent)
			return
		}
		next(w, r)
	}
}

type Forwarder struct {
	source   PacketSource
	sportMin int
	sportMax int
	hub      *RelayHub
}

func NewForwarder(source PacketSource, sportMin, sportMax int) *Forwarder {
	return &Forwarder{
		source:   source,
		sportMin: sportMin,
		sportMax: sportMax,
		hub:      NewRelayHub(),
	}
}

func (f *Forwarder) Run(ctx context.Context) error {
	go func() {
		<-ctx.Done()
		_ = f.source.Close()
	}()
	buf := make([]byte, 65536)
	for {
		pkt, hatype, err := f.source.ReadPacket(buf)
		if err != nil {
			if ctx.Err() != nil {
				return nil
			}
			return err
		}
		c, ok := parseTCPPayload(pkt, hatype)
		if !ok || int(c.Sport) < f.sportMin || int(c.Sport) > f.sportMax {
			continue
		}
		f.hub.Broadcast(c)
	}
}

// EndpointServer exposes the loopback HTTP & WebSocket API consumed by the GitHub Pages HUD.
type EndpointServer struct {
	mode           string
	listenTarget   string
	outboundIP     string
	clientConfPath string
	hudURL         string
	sportMin       int
	sportMax       int
	hub            *RelayHub
}

func (s *EndpointServer) Handler() http.Handler {
	mux := http.NewServeMux()
	wsServer := websocket.Server{
		Handshake: func(_ *websocket.Config, _ *http.Request) error { return nil },
		Handler:   s.hub.ServeWS,
	}
	mux.Handle("/ws", wsServer)
	mux.Handle("/room/local/ws", wsServer)
	mux.HandleFunc("/status", withCORS(s.handleStatus))
	mux.HandleFunc("/MapleSprint.conf", withCORS(s.handleClientConf))
	mux.HandleFunc("/", withCORS(s.handleRootRedirect))
	return mux
}

func (s *EndpointServer) handleStatus(w http.ResponseWriter, _ *http.Request) {
	confOK := false
	if s.clientConfPath != "" {
		if _, err := os.Stat(s.clientConfPath); err == nil {
			confOK = true
		}
	}
	w.Header().Set("Content-Type", "application/json; charset=utf-8")
	_ = json.NewEncoder(w).Encode(EndpointStatus{
		OK:             true,
		Service:        "maplesprint-endpoint",
		Mode:           s.mode,
		ListenAddr:     s.listenTarget,
		OutboundIP:     s.outboundIP,
		PortRange:      fmt.Sprintf("%d-%d", s.sportMin, s.sportMax),
		PacketsRelayed: s.hub.packetsRelayed.Load(),
		LastPacketTs:   s.hub.lastPacketTs.Load(),
		ConnectedHUDs:  s.hub.ClientCount(),
		ConfAvailable:  confOK,
	})
}

func (s *EndpointServer) handleClientConf(w http.ResponseWriter, _ *http.Request) {
	if s.clientConfPath == "" {
		http.Error(w, "No WireGuard config file configured", http.StatusNotFound)
		return
	}
	data, err := os.ReadFile(s.clientConfPath)
	if err != nil {
		http.Error(w, err.Error(), http.StatusNotFound)
		return
	}
	w.Header().Set("Content-Type", "text/plain; charset=utf-8")
	w.Header().Set("Content-Disposition", `attachment; filename="MapleSprint.conf"`)
	_, _ = w.Write(data)
}

func (s *EndpointServer) handleRootRedirect(w http.ResponseWriter, r *http.Request) {
	localEndpoint := "http://" + r.Host
	target := fmt.Sprintf("%s?endpoint=%s", s.hudURL, url.QueryEscape(localEndpoint))
	http.Redirect(w, r, target, http.StatusFound)
}

func startAPIServer(ctx context.Context, addr string, srvCfg *EndpointServer) {
	if addr == "" {
		return
	}
	srv := &http.Server{Addr: addr, Handler: srvCfg.Handler()}
	go func() {
		<-ctx.Done()
		_ = srv.Close()
	}()
	go func() {
		log.Printf("endpoint API ready on http://%s (UI: %s)", addr, srvCfg.hudURL)
		if err := srv.ListenAndServe(); err != nil && !errors.Is(err, http.ErrServerClosed) {
			log.Printf("http server error: %v", err)
		}
	}()
}

func main() {
	ifaceName := flag.String("iface", "wg0", "WireGuard interface to capture (Linux)")
	listenUDP := flag.String("listen-udp", "127.0.0.1:51820", "Localhost UDP address for unprivileged packet relay")
	httpAddr := flag.String("http", "127.0.0.1:8080", "Localhost API & WebSocket address for the GitHub Pages HUD")
	outboundIP := flag.String("outbound-ip", "", "Physical LAN IPv4 for outbound NIC binding (auto-detected if empty)")
	clientConf := flag.String("client-conf", "", "Optional path to MapleSprint.conf for 1-click download from the HUD")
	hudURL := flag.String("hud-url", defaultHUDURL, "GitHub Pages HUD URL")
	noBrowser := flag.Bool("no-browser", false, "Do not automatically open the HUD in your browser on startup")
	sportMinFlag := flag.Int("sport-min", 8484, "Minimum TCP source port (default 8484)")
	sportMaxFlag := flag.Int("sport-max", 8999, "Maximum TCP source port (default 8999)")
	flag.Parse()

	logPath, closeLog := setupLogging()
	defer closeLog()

	sportMin, sportMax, err := validatePortRange(*sportMinFlag, *sportMaxFlag)
	if err != nil {
		log.Fatal(err)
	}

	physIP := *outboundIP
	if physIP == "" {
		physIP = DetectPhysicalOutboundIP()
	}

	var (
		source PacketSource
		mode   string
		target string
	)
	if *listenUDP != "" {
		mode = "udp-loopback"
		target = *listenUDP
		source, err = OpenUDPPacketSource(*listenUDP)
	} else {
		mode = "interface"
		target = *ifaceName
		source, err = OpenRawSocketSource(*ifaceName)
	}
	if err != nil {
		log.Fatal(err)
	}
	defer source.Close()

	log.Printf("maplesprint-endpoint started: mode=%s listen=%s outbound_ip=%s ports=%d-%d", mode, target, physIP, sportMin, sportMax)

	ctx, stop := signal.NotifyContext(context.Background(), syscall.SIGINT, syscall.SIGTERM)
	defer stop()

	fwd := NewForwarder(source, sportMin, sportMax)
	startAPIServer(ctx, *httpAddr, &EndpointServer{
		mode:           mode,
		listenTarget:   target,
		outboundIP:     physIP,
		clientConfPath: *clientConf,
		hudURL:         *hudURL,
		sportMin:       sportMin,
		sportMax:       sportMax,
		hub:            fwd.hub,
	})

	if !*noBrowser {
		openBrowser(*hudURL)
	}

	go func() {
		if err := fwd.Run(ctx); err != nil && !errors.Is(err, context.Canceled) {
			log.Printf("forwarder stopped: %v", err)
			stop()
		}
	}()

	runTray(ctx, stop, *hudURL, logPath)
}
