package main

import (
	"context"
	"encoding/base64"
	"encoding/binary"
	"encoding/json"
	"io"
	"net"
	"net/http"
	"net/http/httptest"
	"net/netip"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"golang.zx2c4.com/wireguard/conn"
)

func buildIPv4TCPPacket(srcIP, dstIP [ipv4AddrLen]byte, sport, dport uint16, seq uint32, payload []byte) []byte {
	totalLen := ipv4MinHdrLen + tcpMinHdrLen + len(payload)
	pkt := make([]byte, totalLen)
	pkt[0] = ipv4VerIHLDefault
	binary.BigEndian.PutUint16(pkt[ipv4OffTotalLen:ipv4OffTotalLen+2], uint16(totalLen))
	pkt[ipv4OffProto] = ipProtoTCP
	copy(pkt[ipv4OffSrcIP:ipv4OffSrcIP+ipv4AddrLen], srcIP[:])
	copy(pkt[ipv4OffDstIP:ipv4OffDstIP+ipv4AddrLen], dstIP[:])

	tcp := pkt[ipv4MinHdrLen:]
	binary.BigEndian.PutUint16(tcp[tcpOffSrcPort:tcpOffSrcPort+2], sport)
	binary.BigEndian.PutUint16(tcp[tcpOffDstPort:tcpOffDstPort+2], dport)
	binary.BigEndian.PutUint32(tcp[tcpOffSeq:tcpOffSeq+4], seq)
	tcp[tcpOffDataOffset] = tcpDataOffset5Words
	copy(tcp[tcpMinHdrLen:], payload)
	return pkt
}

func TestParseTCPPayloadL3AndL2AndPPP(t *testing.T) {
	rawIP := buildIPv4TCPPacket([4]byte{198, 51, 100, 1}, [4]byte{192, 0, 2, 2}, 443, 51000, 0x11223344, []byte("hello"))

	c, ok := parseTCPPayload(rawIP, arphrdNone)
	if !ok {
		t.Fatal("expected L3 packet to parse")
	}
	if c.Type != "raw_chunk" || c.Flow != "198.51.100.1:443->192.0.2.2:51000" || c.Seq != 0x11223344 || c.Sport != 443 {
		t.Fatalf("unexpected chunk metadata: %+v", c)
	}
	if got, _ := base64.StdEncoding.DecodeString(c.Data); string(got) != "hello" {
		t.Fatalf("unexpected payload: %q", got)
	}

	// L2 Ethernet frame wrapping IPv4
	eth := make([]byte, etherHeaderLen+len(rawIP))
	binary.BigEndian.PutUint16(eth[etherOffType:etherHeaderLen], etherTypeIPv4)
	copy(eth[etherHeaderLen:], rawIP)
	c2, ok := parseTCPPayload(eth, arphrdEther)
	if !ok || c2.Sport != 443 {
		t.Fatalf("expected L2 Ethernet packet to parse, got ok=%v chunk=%+v", ok, c2)
	}

	// PPP frame wrapping IPv4
	ppp := make([]byte, pppHeaderLen+len(rawIP))
	ppp[0] = pppAddrCtrl0
	ppp[1] = pppAddrCtrl1
	binary.BigEndian.PutUint16(ppp[pppOffProtoFull:pppHeaderLen], pppProtoIPv4)
	copy(ppp[pppHeaderLen:], rawIP)
	c3, ok := parseTCPPayload(ppp, arphrdPPP)
	if !ok || c3.Flow != c.Flow || c3.Seq != c.Seq || c3.Data != c.Data {
		t.Fatalf("expected PPP packet to parse, got ok=%v chunk=%+v", ok, c3)
	}

	// Empty-payload ACK must be ignored
	ack := buildIPv4TCPPacket([4]byte{198, 51, 100, 1}, [4]byte{192, 0, 2, 2}, 443, 51000, 1, nil)
	if _, ok := parseTCPPayload(ack, arphrdNone); ok {
		t.Fatal("expected empty TCP ACK to be ignored")
	}
}

func TestUDPPacketSource(t *testing.T) {
	src, err := OpenUDPPacketSource("127.0.0.1:0")
	if err != nil {
		t.Fatalf("OpenUDPPacketSource failed: %v", err)
	}
	defer src.Close()

	sender, err := net.Dial("udp", src.conn.LocalAddr().String())
	if err != nil {
		t.Fatalf("UDP dial failed: %v", err)
	}
	defer sender.Close()

	rawIP := buildIPv4TCPPacket([4]byte{198, 51, 100, 1}, [4]byte{192, 0, 2, 2}, 8585, 51000, 42, []byte("world"))
	if _, err := sender.Write(rawIP); err != nil {
		t.Fatalf("UDP write failed: %v", err)
	}

	buf := make([]byte, 2048)
	pkt, hatype, err := src.ReadPacket(buf)
	if err != nil {
		t.Fatalf("ReadPacket failed: %v", err)
	}
	c, ok := parseTCPPayload(pkt, hatype)
	if !ok || c.Sport != 8585 {
		t.Fatalf("expected UDP packet to parse, got ok=%v chunk=%+v", ok, c)
	}
}

func TestPhysicalNICDialerAndValidation(t *testing.T) {
	d := NewPhysicalNICDialer("192.168.1.50", 5*time.Second)
	tcpAddr, ok := d.LocalAddr.(*net.TCPAddr)
	if !ok || tcpAddr.IP.String() != "192.168.1.50" {
		t.Fatalf("expected LocalAddr bound to 192.168.1.50, got %+v", d.LocalAddr)
	}

	if _, _, err := validatePortRange(8484, 8999); err != nil {
		t.Fatalf("expected valid port range, got %v", err)
	}
	if _, _, err := validatePortRange(9000, 8000); err == nil {
		t.Fatal("expected error for inverted port range")
	}

	if _, err := validateHTTPURL("https://sdoolman.github.io/maplesprint-hud/"); err != nil {
		t.Fatalf("expected valid https URL, got %v", err)
	}
	for _, bad := range []string{"javascript:alert(1)", "file:///C:/Windows/calc.exe", "ms-msdt:/id", "not a url"} {
		if _, err := validateHTTPURL(bad); err == nil {
			t.Fatalf("expected %q to be rejected by validateHTTPURL", bad)
		}
	}

	tmpDir := t.TempDir()
	goodLog := filepath.Join(tmpDir, "relay.log")
	if err := os.WriteFile(goodLog, []byte("ok\n"), 0o600); err != nil {
		t.Fatal(err)
	}
	if _, err := validateLogPath(goodLog, tmpDir); err != nil {
		t.Fatalf("expected valid log file, got %v", err)
	}
	if _, err := validateLogPath(filepath.Join(tmpDir, "..", "evil.exe"), tmpDir); err == nil {
		t.Fatal("expected path traversal / wrong extension to be rejected")
	}
}

func TestEndpointServerRoutesAndPNA(t *testing.T) {
	cfg := DefaultRelayConfig()
	srv := &EndpointServer{
		mode:         "udp-loopback",
		listenTarget: "127.0.0.1:51821",
		wgPort:       51821,
		outboundIP:   "192.168.1.50",
		hudURL:       cfg.HUDURL,
		sportMin:     cfg.SportMin,
		sportMax:     cfg.SportMax,
		routes:       cfg.Routes,
		hub:          NewRelayHub(),
	}
	h := srv.Handler()

	reqOpt := httptest.NewRequest(http.MethodOptions, cfg.Routes.Status, nil)
	recOpt := httptest.NewRecorder()
	h.ServeHTTP(recOpt, reqOpt)
	if recOpt.Code != http.StatusNoContent {
		t.Fatalf("expected 204 for OPTIONS, got %d", recOpt.Code)
	}
	if recOpt.Header().Get("Access-Control-Allow-Private-Network") != "true" {
		t.Fatal("missing Access-Control-Allow-Private-Network header")
	}

	reqSt := httptest.NewRequest(http.MethodGet, cfg.Routes.Status, nil)
	recSt := httptest.NewRecorder()
	h.ServeHTTP(recSt, reqSt)
	if recSt.Code != http.StatusOK {
		t.Fatalf("expected 200 for /status, got %d", recSt.Code)
	}
	var st EndpointStatus
	if err := json.Unmarshal(recSt.Body.Bytes(), &st); err != nil {
		t.Fatalf("invalid status JSON: %v", err)
	}
	if !st.OK || st.WGPort != 51821 || st.PortRange != "8484-8999" || st.OutboundIP != "192.168.1.50" {
		t.Fatalf("unexpected status payload: %+v", st)
	}

	reqRoot := httptest.NewRequest(http.MethodGet, "http://127.0.0.1:8080/", nil)
	recRoot := httptest.NewRecorder()
	h.ServeHTTP(recRoot, reqRoot)
	if recRoot.Code != http.StatusFound {
		t.Fatalf("expected 302 redirect on /, got %d", recRoot.Code)
	}
	if !strings.Contains(recRoot.Header().Get("Location"), "endpoint=http%3A%2F%2F127.0.0.1%3A8080") {
		t.Fatalf("unexpected redirect target: %s", recRoot.Header().Get("Location"))
	}

	reqConfMissing := httptest.NewRequest(http.MethodGet, cfg.Routes.ClientConf, nil)
	recConfMissing := httptest.NewRecorder()
	h.ServeHTTP(recConfMissing, reqConfMissing)
	if recConfMissing.Code != http.StatusNotFound {
		t.Fatalf("expected 404 for %s when unconfigured, got %d", cfg.Routes.ClientConf, recConfMissing.Code)
	}

	confFile := filepath.Join(t.TempDir(), "MapleSprint.conf")
	const sampleConf = "[Interface]\nAddress = 10.66.66.2/32\n[Peer]\nEndpoint = 127.0.0.1:51821\nAllowedIPs = 158.115.192.0/19\n"
	if err := os.WriteFile(confFile, []byte(sampleConf), 0o600); err != nil {
		t.Fatal(err)
	}
	srv.clientConfPath = confFile
	reqConf := httptest.NewRequest(http.MethodGet, cfg.Routes.ClientConf, nil)
	recConf := httptest.NewRecorder()
	h.ServeHTTP(recConf, reqConf)
	if recConf.Code != http.StatusOK {
		t.Fatalf("expected 200 for %s, got %d", cfg.Routes.ClientConf, recConf.Code)
	}
	if body := recConf.Body.String(); !strings.Contains(body, "Endpoint = 127.0.0.1:51821") || !strings.Contains(body, "AllowedIPs = ") {
		t.Fatalf("unexpected MapleSprint.conf body: %s", body)
	}
}

func TestParseTCPPayloadRejectsMalformedAndNonTCP(t *testing.T) {
	if _, ok := parseTCPPayload([]byte{0x45, 0x00}, arphrdNone); ok {
		t.Fatal("expected truncated IPv4 packet to be rejected")
	}

	// Valid length IPv4 header with UDP protocol (17) instead of TCP (6)
	udpPkt := buildIPv4TCPPacket([4]byte{198, 51, 100, 1}, [4]byte{192, 0, 2, 2}, 443, 51000, 1, []byte("udp"))
	udpPkt[ipv4OffProto] = 17
	if _, ok := parseTCPPayload(udpPkt, arphrdNone); ok {
		t.Fatal("expected non-TCP packet to be rejected")
	}

	// Non-IPv4 ethertype (ARP 0x0806)
	eth := make([]byte, etherHeaderLen+len(udpPkt))
	binary.BigEndian.PutUint16(eth[etherOffType:etherHeaderLen], 0x0806)
	if _, ok := parseTCPPayload(eth, arphrdEther); ok {
		t.Fatal("expected non-IPv4 Ethernet frame to be rejected")
	}
}

func TestWGKeyPairAndConfGeneration(t *testing.T) {
	serverKP, err := GenerateWGKeyPair()
	if err != nil {
		t.Fatalf("GenerateWGKeyPair(server) failed: %v", err)
	}
	clientKP, err := GenerateWGKeyPair()
	if err != nil {
		t.Fatalf("GenerateWGKeyPair(client) failed: %v", err)
	}
	if serverKP.Private[0]&7 != 0 || serverKP.Private[31]&128 != 0 || serverKP.Private[31]&64 == 0 {
		t.Fatal("server private key is not properly Curve25519-clamped")
	}
	if len(serverKP.PublicBase64()) != 44 || len(clientKP.PrivateBase64()) != 44 {
		t.Fatalf("expected 44-char base64 WireGuard keys, got %d / %d", len(serverKP.PublicBase64()), len(clientKP.PrivateBase64()))
	}
	if len(serverKP.PrivateHex()) != 64 || len(clientKP.PublicHex()) != 64 {
		t.Fatalf("expected 64-char hex WireGuard keys, got %d / %d", len(serverKP.PrivateHex()), len(clientKP.PublicHex()))
	}

	conf := BuildClientWireGuardConf(clientKP.PrivateBase64(), serverKP.PublicBase64(), wgClientCIDR, 51820, wgGameAllowedIPs)
	for _, want := range []string{
		"[Interface]",
		"PrivateKey = " + clientKP.PrivateBase64(),
		"Address = " + wgClientCIDR,
		"[Peer]",
		"PublicKey = " + serverKP.PublicBase64(),
		"Endpoint = 127.0.0.1:51820",
		"AllowedIPs = " + wgGameAllowedIPs,
	} {
		if !strings.Contains(conf, want) {
			t.Fatalf("expected client conf to contain %q, got:\n%s", want, conf)
		}
	}

	uapi := BuildUAPIConfig(serverKP.PrivateHex(), clientKP.PublicHex(), 51820, wgClientCIDR)
	if !strings.Contains(uapi, "private_key="+serverKP.PrivateHex()) || !strings.Contains(uapi, "listen_port=51820") {
		t.Fatalf("unexpected UAPI config:\n%s", uapi)
	}
}

func TestValidateForwardDest(t *testing.T) {
	wgSubnet := netip.MustParsePrefix("10.66.66.0/24")
	if err := validateForwardDest(netip.MustParseAddr("158.115.192.10"), 8484, wgSubnet); err != nil {
		t.Fatalf("expected public game IP to be allowed, got: %v", err)
	}
	for _, tc := range []struct {
		ip   string
		port uint16
	}{
		{"127.0.0.1", 8080},
		{"192.168.1.1", 80},
		{"10.66.66.2", 8484},
		{"169.254.169.254", 80},
		{"224.0.0.1", 5353},
		{"158.115.192.10", 0},
	} {
		if err := validateForwardDest(netip.MustParseAddr(tc.ip), tc.port, wgSubnet); err == nil {
			t.Fatalf("expected %s:%d to be rejected", tc.ip, tc.port)
		}
	}
}

func TestEndpointServerServesInMemoryClientConf(t *testing.T) {
	cfg := DefaultRelayConfig()
	srv := &EndpointServer{
		mode:           "wireguard-netstack",
		listenTarget:   "127.0.0.1:51820",
		wgPort:         51820,
		outboundIP:     "192.168.1.167",
		clientConfBody: "[Interface]\nAddress = 10.66.66.2/32\n",
		hudURL:         cfg.HUDURL,
		sportMin:       cfg.SportMin,
		sportMax:       cfg.SportMax,
		routes:         cfg.Routes,
		hub:            NewRelayHub(),
	}
	h := srv.Handler()

	recSt := httptest.NewRecorder()
	h.ServeHTTP(recSt, httptest.NewRequest(http.MethodGet, cfg.Routes.Status, nil))
	var st EndpointStatus
	if err := json.Unmarshal(recSt.Body.Bytes(), &st); err != nil {
		t.Fatalf("invalid status JSON: %v", err)
	}
	if !st.ConfAvailable || st.Mode != "wireguard-netstack" {
		t.Fatalf("expected conf_available=true and wireguard-netstack mode, got %+v", st)
	}

	recConf := httptest.NewRecorder()
	h.ServeHTTP(recConf, httptest.NewRequest(http.MethodGet, cfg.Routes.ClientConf, nil))
	if recConf.Code != http.StatusOK || !strings.Contains(recConf.Body.String(), "10.66.66.2/32") {
		t.Fatalf("expected in-memory MapleSprint.conf 200 OK, got %d: %s", recConf.Code, recConf.Body.String())
	}
}

func TestStackTUNAndBidirectionalRelay(t *testing.T) {
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()

	tunDev, err := NewStackTUN(ctx, netip.MustParseAddr(wgServerAddrStr), nil)
	if err != nil {
		t.Fatalf("NewStackTUN failed: %v", err)
	}
	if mtu, err := tunDev.MTU(); err != nil || mtu != wgTunnelMTU {
		t.Fatalf("unexpected MTU: %d, err=%v", mtu, err)
	}
	if name, err := tunDev.Name(); err != nil || name != "maplesprint-wg0" {
		t.Fatalf("unexpected TUN name: %q, err=%v", name, err)
	}
	// Invalid/truncated packet must be safely ignored without panicking.
	n, err := tunDev.Write([][]byte{{0x60, 0x00}}, 0)
	if err != nil || n != 0 {
		t.Fatalf("expected non-IPv4 packet to be skipped cleanly, got n=%d err=%v", n, err)
	}
	_ = tunDev.Close()
	_ = tunDev.Close() // idempotent close

	// Verify relayBidirectional copies cleanly and closes both sides.
	c1, c2 := net.Pipe()
	c3, c4 := net.Pipe()
	done := make(chan struct{})
	go func() {
		relayBidirectional(ctx, c2, c3)
		close(done)
	}()

	msg := []byte("maplesprint-ping")
	if _, err := c1.Write(msg); err != nil {
		t.Fatal(err)
	}
	buf := make([]byte, len(msg))
	if _, err := io.ReadFull(c4, buf); err != nil {
		t.Fatal(err)
	}
	if string(buf) != string(msg) {
		t.Fatalf("expected %q, got %q", msg, buf)
	}
	_ = c1.Close()
	_ = c4.Close()
	select {
	case <-done:
	case <-time.After(2 * time.Second):
		t.Fatal("relayBidirectional did not exit after peer close")
	}
}

func TestLoopbackBindAndHandshakeParsing(t *testing.T) {
	if _, err := NewLoopbackBind(netip.MustParseAddr("192.168.1.1")); err == nil {
		t.Fatal("expected non-loopback IP to be rejected")
	}
	bind, err := NewLoopbackBind(netip.MustParseAddr("127.0.0.1"))
	if err != nil {
		t.Fatalf("NewLoopbackBind failed: %v", err)
	}
	fns, port, err := bind.Open(0)
	if err != nil {
		t.Fatalf("bind.Open failed: %v", err)
	}
	defer bind.Close()
	if port == 0 || len(fns) != 1 {
		t.Fatalf("unexpected Open result: port=%d fns=%d", port, len(fns))
	}
	localUDP := bind.pc.LocalAddr().(*net.UDPAddr)
	if !localUDP.IP.Equal(net.ParseIP("127.0.0.1")) {
		t.Fatalf("expected socket bound strictly to 127.0.0.1, got %s", localUDP.IP)
	}

	// Verify Send + ReceiveFunc roundtrip on loopback.
	peerConn, err := net.ListenUDP("udp4", &net.UDPAddr{IP: net.ParseIP("127.0.0.1"), Port: 0})
	if err != nil {
		t.Fatal(err)
	}
	defer peerConn.Close()
	ep, err := bind.ParseEndpoint(peerConn.LocalAddr().String())
	if err != nil {
		t.Fatalf("ParseEndpoint failed: %v", err)
	}
	if err := bind.Send([][]byte{[]byte("wg-ping")}, ep); err != nil {
		t.Fatalf("bind.Send failed: %v", err)
	}
	buf := make([]byte, 64)
	_ = peerConn.SetReadDeadline(time.Now().Add(2 * time.Second))
	n, _, err := peerConn.ReadFromUDP(buf)
	if err != nil || string(buf[:n]) != "wg-ping" {
		t.Fatalf("expected wg-ping on peer, got %q err=%v", buf[:n], err)
	}

	if _, err := peerConn.WriteToUDP([]byte("wg-pong"), localUDP); err != nil {
		t.Fatal(err)
	}
	recvBufs := [][]byte{make([]byte, 64)}
	sizes := make([]int, 1)
	eps := make([]conn.Endpoint, 1)
	count, err := fns[0](recvBufs, sizes, eps)
	if err != nil || count != 1 || string(recvBufs[0][:sizes[0]]) != "wg-pong" {
		t.Fatalf("expected wg-pong from ReceiveFunc, got count=%d data=%q err=%v", count, recvBufs[0][:sizes[0]], err)
	}

	// Verify IPC handshake parser & /status wg_handshake field.
	if parseIpcHandshake("last_handshake_time_sec=0\nrx_bytes=0\n") {
		t.Fatal("expected zero handshake timestamp to return false")
	}
	if !parseIpcHandshake("public_key=abc\nlast_handshake_time_sec=1700000123\n") {
		t.Fatal("expected non-zero handshake timestamp to return true")
	}

	cfg := DefaultRelayConfig()
	srv := &EndpointServer{
		mode:       "wireguard-netstack",
		wgPort:     51820,
		routes:     cfg.Routes,
		hub:        NewRelayHub(),
		wgStatusFn: func() bool { return true },
	}
	rec := httptest.NewRecorder()
	srv.Handler().ServeHTTP(rec, httptest.NewRequest(http.MethodGet, cfg.Routes.Status, nil))
	var st EndpointStatus
	if err := json.Unmarshal(rec.Body.Bytes(), &st); err != nil || !st.WGHandshake {
		t.Fatalf("expected wg_handshake=true in /status, got %s (err=%v)", rec.Body.String(), err)
	}
}
