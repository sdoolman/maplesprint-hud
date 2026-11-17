// MapleSprint Open-Source Local Endpoint Relay
//
// This slim, auditable local daemon bridges your WireGuard split-tunnel
// interface (TCP source ports configurable via --sport-min/--sport-max) to the
// MapleSprint HUD running in your browser.
//
// Design principles:
//   - 100% Open-Source & Auditable: No game packet decoding or proprietary logic lives here.
//   - Loopback-Only API (127.0.0.1:8080): Never exposes ports to the public internet and
//     never triggers Windows Defender Firewall prompts.
//   - Physical NIC Binding: Outbound connections bind directly to your physical Wi-Fi/LAN IP
//     so traffic on a single Windows PC never loops back into the WireGuard tunnel.
package main

import (
	"context"
	"encoding/json"
	"flag"
	"fmt"
	"log"
	"net"
	"net/http"
	"net/url"
	"os"
	"os/signal"
	"strconv"
	"strings"
	"sync"
	"sync/atomic"
	"syscall"
	"time"

	"golang.org/x/net/websocket"
)

const (
	maxPacketBufBytes = 65536
	wsWriteTimeout    = 2 * time.Second
	prevLogSuffix     = ".prev"
)

// TrayMenuConfig holds localizable labels for the Windows taskbar tray context menu.
type TrayMenuConfig struct {
	OpenHUD string
	OpenLog string
	Quit    string
	Tooltip string
}

// RelayConfig holds all configurable operational parameters for the local endpoint relay.
type RelayConfig struct {
	AppName     string
	DisplayName string
	LogFileName string
	PrevLogSfx  string
	IfaceName   string
	ListenUDP   string
	HTTPAddr    string
	OutboundIP  string
	WGSubnet    string
	ClientConf  string
	HUDURL      string
	NoBrowser   bool
	SportMin    int
	SportMax    int
	Routes      RoutesConfig
	Menu        TrayMenuConfig
}

// RoutesConfig parameterizes the HTTP & WebSocket endpoints exposed on the loopback server.
type RoutesConfig struct {
	WebSocket  string
	Status     string
	ClientConf string
	Root       string
}

func DefaultRelayConfig() RelayConfig {
	return RelayConfig{
		AppName:     "MapleSprint",
		DisplayName: "MapleSprint Relay",
		LogFileName: "relay.log",
		PrevLogSfx:  prevLogSuffix,
		IfaceName:   "wg0",
		ListenUDP:   "127.0.0.1:51820",
		HTTPAddr:    "127.0.0.1:8080",
		WGSubnet:    "10.66.66.0/24",
		HUDURL:      "https://sdoolman.github.io/maplesprint-hud/",
		SportMin:    8484,
		SportMax:    8999,
		Routes: RoutesConfig{
			WebSocket:  "/ws",
			Status:     "/status",
			ClientConf: "/MapleSprint.conf",
			Root:       "/",
		},
		Menu: TrayMenuConfig{
			OpenHUD: "Open MapleSprint HUD",
			OpenLog: "Open Relay Log",
			Quit:    "Quit MapleSprint Relay",
			Tooltip: "MapleSprint Relay — Click to open HUD",
		},
	}
}

// EndpointStatus is returned by GET /status for the Setup dashboard in the HUD.
type EndpointStatus struct {
	OK             bool   `json:"ok"`
	Service        string `json:"service"`
	Mode           string `json:"mode"`
	ListenAddr     string `json:"listen_addr"`
	WGPort         int    `json:"wg_port"`
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
	return stripCaptureHeader(buf[:n]), arphrdNone, nil
}

func (u *UDPPacketSource) Close() error {
	return u.conn.Close()
}

var tunnelIfacePrefixes = []string{"wg", "tun", "tap", "utun"}

func isTunnelInterface(name string) bool {
	lower := strings.ToLower(name)
	for _, p := range tunnelIfacePrefixes {
		if strings.HasPrefix(lower, p) {
			return true
		}
	}
	return false
}

// DetectPhysicalOutboundIP finds the primary non-loopback, non-tunnel LAN IPv4 address
// outside the configured WireGuard subnet CIDR so outbound sockets bypass the tunnel.
func DetectPhysicalOutboundIP(wgSubnetCIDR string) string {
	var wgNet *net.IPNet
	if wgSubnetCIDR != "" {
		_, wgNet, _ = net.ParseCIDR(wgSubnetCIDR)
	}
	ifaces, err := net.Interfaces()
	if err != nil {
		return ""
	}
	for _, iface := range ifaces {
		if (iface.Flags&net.FlagUp) == 0 || (iface.Flags&net.FlagLoopback) != 0 || isTunnelInterface(iface.Name) {
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
			if wgNet != nil && wgNet.Contains(ip4) {
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

func parsePortFromAddr(addr string) int {
	_, portStr, err := net.SplitHostPort(addr)
	if err != nil {
		return 0
	}
	p, err := strconv.Atoi(portStr)
	if err != nil || p < 0 || p > 65535 {
		return 0
	}
	return p
}

// RelayHub broadcasts raw TCP chunks over WebSockets to connected HUD clients.
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
		_ = ws.SetWriteDeadline(time.Now().Add(wsWriteTimeout))
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

// withCORS attaches CORS and Chrome Private Network Access (PNA) headers.
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
	buf := make([]byte, maxPacketBufBytes)
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

// EndpointServer exposes the configured loopback HTTP & WebSocket API.
type EndpointServer struct {
	mode           string
	listenTarget   string
	wgPort         int
	outboundIP     string
	clientConfPath string
	clientConfBody string
	hudURL         string
	sportMin       int
	sportMax       int
	routes         RoutesConfig
	hub            *RelayHub
}

func (s *EndpointServer) Handler() http.Handler {
	mux := http.NewServeMux()
	wsServer := websocket.Server{
		Handshake: func(_ *websocket.Config, _ *http.Request) error { return nil },
		Handler:   s.hub.ServeWS,
	}
	mux.Handle(s.routes.WebSocket, wsServer)
	mux.HandleFunc(s.routes.Status, withCORS(s.handleStatus))
	mux.HandleFunc(s.routes.ClientConf, withCORS(s.handleClientConf))
	mux.HandleFunc(s.routes.Root, withCORS(s.handleRootRedirect))
	return mux
}

func (s *EndpointServer) handleStatus(w http.ResponseWriter, _ *http.Request) {
	confOK := s.clientConfBody != ""
	if !confOK && s.clientConfPath != "" {
		if info, err := os.Stat(s.clientConfPath); err == nil && info.Mode().IsRegular() {
			confOK = true
		}
	}
	w.Header().Set("Content-Type", "application/json; charset=utf-8")
	_ = json.NewEncoder(w).Encode(EndpointStatus{
		OK:             true,
		Service:        "maplesprint-endpoint",
		Mode:           s.mode,
		ListenAddr:     s.listenTarget,
		WGPort:         s.wgPort,
		OutboundIP:     s.outboundIP,
		PortRange:      fmt.Sprintf("%d-%d", s.sportMin, s.sportMax),
		PacketsRelayed: s.hub.packetsRelayed.Load(),
		LastPacketTs:   s.hub.lastPacketTs.Load(),
		ConnectedHUDs:  s.hub.ClientCount(),
		ConfAvailable:  confOK,
	})
}

func (s *EndpointServer) handleClientConf(w http.ResponseWriter, _ *http.Request) {
	var data []byte
	if s.clientConfBody != "" {
		data = []byte(s.clientConfBody)
	} else if s.clientConfPath != "" {
		var err error
		data, err = os.ReadFile(s.clientConfPath)
		if err != nil {
			log.Printf("unable to read WireGuard config: %v", err)
			http.Error(w, "WireGuard config unavailable", http.StatusNotFound)
			return
		}
	} else {
		http.Error(w, "No WireGuard config file configured", http.StatusNotFound)
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
		if err := srv.ListenAndServe(); err != nil && err != http.ErrServerClosed {
			log.Printf("http server error: %v", err)
		}
	}()
}

func parseFlags() RelayConfig {
	cfg := DefaultRelayConfig()
	flag.StringVar(&cfg.IfaceName, "iface", cfg.IfaceName, "WireGuard interface to capture (Linux)")
	flag.StringVar(&cfg.ListenUDP, "listen-udp", cfg.ListenUDP, "Localhost UDP address for unprivileged packet relay")
	flag.StringVar(&cfg.HTTPAddr, "http", cfg.HTTPAddr, "Localhost API & WebSocket address for the GitHub Pages HUD")
	flag.StringVar(&cfg.OutboundIP, "outbound-ip", "", "Physical LAN IPv4 for outbound NIC binding (auto-detected if empty)")
	flag.StringVar(&cfg.WGSubnet, "wg-subnet", cfg.WGSubnet, "WireGuard subnet CIDR excluded during physical NIC detection")
	flag.StringVar(&cfg.ClientConf, "client-conf", "", "Optional path to MapleSprint.conf for 1-click download from the HUD")
	flag.StringVar(&cfg.HUDURL, "hud-url", cfg.HUDURL, "GitHub Pages HUD URL")
	flag.BoolVar(&cfg.NoBrowser, "no-browser", false, "Do not automatically open the HUD in your browser on startup")
	flag.IntVar(&cfg.SportMin, "sport-min", cfg.SportMin, "Minimum TCP source port")
	flag.IntVar(&cfg.SportMax, "sport-max", cfg.SportMax, "Maximum TCP source port")
	flag.Parse()
	return cfg
}

func main() {
	cfg := parseFlags()
	logPath, logDir, closeLog := setupLogging(cfg)
	defer closeLog()

	sportMin, sportMax, err := validatePortRange(cfg.SportMin, cfg.SportMax)
	if err != nil {
		log.Fatal(err)
	}
	if _, err := validateHTTPURL(cfg.HUDURL); err != nil {
		log.Fatalf("invalid --hud-url: %v", err)
	}

	physIP := cfg.OutboundIP
	if physIP == "" {
		physIP = DetectPhysicalOutboundIP(cfg.WGSubnet)
	}

	ctx, stop := signal.NotifyContext(context.Background(), syscall.SIGINT, syscall.SIGTERM)
	defer stop()

	hub := NewRelayHub()
	var (
		mode           string
		target         string
		wgPort         int
		clientConfBody string
	)

	if cfg.ListenUDP != "" {
		wgEndpoint, err := StartWGRelayEndpoint(ctx, cfg, physIP, hub, sportMin, sportMax)
		if err != nil {
			log.Fatal(err)
		}
		defer wgEndpoint.Close()
		mode = "wireguard-netstack"
		target = cfg.ListenUDP
		wgPort = wgEndpoint.wgPort
		clientConfBody = wgEndpoint.ClientConf()
	} else {
		source, err := OpenRawSocketSource(cfg.IfaceName, ethPAll)
		if err != nil {
			log.Fatal(err)
		}
		defer source.Close()
		mode = "interface"
		target = cfg.IfaceName
		fwd := &Forwarder{source: source, hub: hub, sportMin: sportMin, sportMax: sportMax}
		go func() {
			if err := fwd.Run(ctx); err != nil && ctx.Err() == nil {
				log.Printf("forwarder stopped: %v", err)
				stop()
			}
		}()
	}

	log.Printf("maplesprint-endpoint started: mode=%s listen=%s outbound_ip=%s ports=%d-%d", mode, target, physIP, sportMin, sportMax)

	startAPIServer(ctx, cfg.HTTPAddr, &EndpointServer{
		mode:           mode,
		listenTarget:   target,
		wgPort:         wgPort,
		outboundIP:     physIP,
		clientConfPath: cfg.ClientConf,
		clientConfBody: clientConfBody,
		hudURL:         cfg.HUDURL,
		sportMin:       sportMin,
		sportMax:       sportMax,
		routes:         cfg.Routes,
		hub:            hub,
	})

	if !cfg.NoBrowser {
		openBrowser(cfg.HUDURL)
	}

	runTray(ctx, stop, cfg, logPath, logDir)
}
