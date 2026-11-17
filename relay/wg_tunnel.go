package main

import (
	"context"
	"errors"
	"fmt"
	"io"
	"log"
	"net"
	"net/netip"
	"os"
	"sync"
	"time"

	"golang.zx2c4.com/wireguard/conn"
	"golang.zx2c4.com/wireguard/device"
	"golang.zx2c4.com/wireguard/tun"
	"gvisor.dev/gvisor/pkg/buffer"
	"gvisor.dev/gvisor/pkg/tcpip"
	"gvisor.dev/gvisor/pkg/tcpip/adapters/gonet"
	"gvisor.dev/gvisor/pkg/tcpip/header"
	"gvisor.dev/gvisor/pkg/tcpip/link/channel"
	"gvisor.dev/gvisor/pkg/tcpip/network/ipv4"
	"gvisor.dev/gvisor/pkg/tcpip/stack"
	"gvisor.dev/gvisor/pkg/tcpip/transport/tcp"
	"gvisor.dev/gvisor/pkg/waiter"
)

const (
	wgTunnelMTU          = 1420
	wgTunnelNICID        = tcpip.NICID(1)
	wgChannelQueueDepth  = 512
	maxInFlightTCPConns  = 512
	tcpOutboundDialGrace = 8 * time.Second
	wgServerAddrStr      = "10.66.66.1"
	wgClientCIDR         = "10.66.66.2/32"
	wgGameAllowedIPs     = "158.115.192.0/19"
)

// StackTUN implements wireguard/tun.Device backed by a userspace gVisor IPv4/TCP stack.
// Outbound packets (server -> client) are optionally tapped so game chunks can be mirrored to the HUD.
type StackTUN struct {
	ctx        context.Context
	cancel     context.CancelFunc
	ipStack    *stack.Stack
	ep         *channel.Endpoint
	events     chan tun.Event
	onOutbound func([]byte)
	closeOnce  sync.Once
}

// NewStackTUN initializes a gVisor IPv4/TCP netstack in promiscuous/spoofing mode for transparent forwarding.
func NewStackTUN(parent context.Context, gatewayIP netip.Addr, onOutbound func([]byte)) (*StackTUN, error) {
	if !gatewayIP.Is4() {
		return nil, fmt.Errorf("gateway IP must be IPv4, got %s", gatewayIP)
	}

	s := stack.New(stack.Options{
		NetworkProtocols:   []stack.NetworkProtocolFactory{ipv4.NewProtocol},
		TransportProtocols: []stack.TransportProtocolFactory{tcp.NewProtocol},
	})

	ep := channel.New(wgChannelQueueDepth, wgTunnelMTU, "")
	if tcpipErr := s.CreateNIC(wgTunnelNICID, ep); tcpipErr != nil {
		return nil, fmt.Errorf("create gvisor NIC: %s", tcpipErr)
	}

	gwBytes := gatewayIP.As4()
	protoAddr := tcpip.ProtocolAddress{
		Protocol: ipv4.ProtocolNumber,
		AddressWithPrefix: tcpip.AddressWithPrefix{
			Address:   tcpip.AddrFrom4(gwBytes),
			PrefixLen: 24,
		},
	}
	if tcpipErr := s.AddProtocolAddress(wgTunnelNICID, protoAddr, stack.AddressProperties{}); tcpipErr != nil {
		return nil, fmt.Errorf("add gateway address: %s", tcpipErr)
	}

	// Required so TCPForwarder accepts SYN packets destined for remote game IPs (158.115.x.x)
	// and responds with the remote server's source IP.
	if tcpipErr := s.SetPromiscuousMode(wgTunnelNICID, true); tcpipErr != nil {
		return nil, fmt.Errorf("enable promiscuous mode: %s", tcpipErr)
	}
	if tcpipErr := s.SetSpoofing(wgTunnelNICID, true); tcpipErr != nil {
		return nil, fmt.Errorf("enable spoofing: %s", tcpipErr)
	}

	s.SetRouteTable([]tcpip.Route{
		{Destination: header.IPv4EmptySubnet, NIC: wgTunnelNICID},
	})

	ctx, cancel := context.WithCancel(parent)
	events := make(chan tun.Event, 4)
	events <- tun.EventUp

	return &StackTUN{
		ctx:        ctx,
		cancel:     cancel,
		ipStack:    s,
		ep:         ep,
		events:     events,
		onOutbound: onOutbound,
	}, nil
}

func (t *StackTUN) Stack() *stack.Stack { return t.ipStack }
func (t *StackTUN) File() *os.File      { return nil }
func (t *StackTUN) MTU() (int, error)   { return wgTunnelMTU, nil }
func (t *StackTUN) Name() (string, error) {
	return "maplesprint-wg0", nil
}
func (t *StackTUN) Events() <-chan tun.Event { return t.events }
func (t *StackTUN) BatchSize() int           { return 1 }

func (t *StackTUN) Read(bufs [][]byte, sizes []int, offset int) (int, error) {
	if len(bufs) == 0 || len(sizes) == 0 {
		return 0, errors.New("empty read buffer")
	}
	for {
		pkt := t.ep.ReadContext(t.ctx)
		if pkt == nil {
			return 0, io.EOF
		}
		view := pkt.ToView()
		raw := view.AsSlice()
		if len(raw) == 0 || offset+len(raw) > len(bufs[0]) {
			view.Release()
			pkt.DecRef()
			continue
		}
		copy(bufs[0][offset:], raw)
		sizes[0] = len(raw)
		if t.onOutbound != nil {
			t.onOutbound(bufs[0][offset : offset+len(raw)])
		}
		view.Release()
		pkt.DecRef()
		return 1, nil
	}
}

func (t *StackTUN) Write(bufs [][]byte, offset int) (int, error) {
	written := 0
	for _, buf := range bufs {
		if offset >= len(buf) {
			continue
		}
		raw := buf[offset:]
		if len(raw) < ipv4MinHdrLen || raw[0]>>4 != 4 {
			continue
		}
		pb := stack.NewPacketBuffer(stack.PacketBufferOptions{
			Payload: buffer.MakeWithData(raw),
		})
		t.ep.InjectInbound(header.IPv4ProtocolNumber, pb)
		pb.DecRef()
		written++
	}
	return written, nil
}

func (t *StackTUN) Close() error {
	t.closeOnce.Do(func() {
		t.cancel()
		t.ep.Close()
		t.ipStack.Close()
		close(t.events)
	})
	return nil
}

// validateForwardDest blocks loopback, private, link-local, multicast, and tunnel-subnet destinations
// to prevent SSRF or WireGuard routing loops.
func validateForwardDest(ip netip.Addr, port uint16, wgSubnet netip.Prefix) error {
	if !ip.Is4() || port == 0 {
		return fmt.Errorf("invalid destination %s:%d", ip, port)
	}
	if ip.IsLoopback() || ip.IsUnspecified() || ip.IsMulticast() || ip.IsLinkLocalUnicast() || ip.IsLinkLocalMulticast() || ip.IsPrivate() {
		return fmt.Errorf("disallowed destination IP %s", ip)
	}
	if wgSubnet.Contains(ip) {
		return fmt.Errorf("destination %s inside WireGuard subnet %s", ip, wgSubnet)
	}
	return nil
}

// attachTCPForwarder routes decrypted TCP streams from the WireGuard client out via dialer.
func attachTCPForwarder(ctx context.Context, ipStack *stack.Stack, dialer *net.Dialer, wgSubnet netip.Prefix) {
	fwd := tcp.NewForwarder(ipStack, 0, maxInFlightTCPConns, func(req *tcp.ForwarderRequest) {
		id := req.ID()
		dstIP, ok := netip.AddrFromSlice(id.LocalAddress.AsSlice())
		if !ok {
			req.Complete(true)
			return
		}
		if err := validateForwardDest(dstIP, id.LocalPort, wgSubnet); err != nil {
			req.Complete(true)
			return
		}

		dstAddr := net.JoinHostPort(dstIP.String(), fmt.Sprintf("%d", id.LocalPort))
		dialCtx, cancelDial := context.WithTimeout(ctx, tcpOutboundDialGrace)
		remoteConn, err := dialer.DialContext(dialCtx, "tcp", dstAddr)
		cancelDial()
		if err != nil {
			req.Complete(true)
			return
		}

		var wq waiter.Queue
		ep, tcpipErr := req.CreateEndpoint(&wq)
		if tcpipErr != nil {
			_ = remoteConn.Close()
			req.Complete(true)
			return
		}
		req.Complete(false)

		tunnelConn := gonet.NewTCPConn(&wq, ep)
		go relayBidirectional(ctx, tunnelConn, remoteConn)
	})
	ipStack.SetTransportProtocolHandler(tcp.ProtocolNumber, fwd.HandlePacket)
}

type closeWriter interface {
	CloseWrite() error
}

// relayBidirectional copies traffic in both directions and cleanly shuts down both connections.
func relayBidirectional(ctx context.Context, a, b net.Conn) {
	defer a.Close()
	defer b.Close()

	done := make(chan struct{})
	go func() {
		select {
		case <-ctx.Done():
			_ = a.Close()
			_ = b.Close()
		case <-done:
		}
	}()

	var wg sync.WaitGroup
	wg.Add(2)
	copyHalf := func(dst, src net.Conn) {
		defer wg.Done()
		_, _ = io.Copy(dst, src)
		if cw, ok := dst.(closeWriter); ok {
			_ = cw.CloseWrite()
		}
	}
	go copyHalf(b, a)
	go copyHalf(a, b)
	wg.Wait()
	close(done)
}

// WGRelayEndpoint terminates WireGuard on localhost UDP, forwards game TCP via the physical NIC,
// and mirrors game server packets to RelayHub.
type WGRelayEndpoint struct {
	dev        *device.Device
	tun        *StackTUN
	clientConf string
	wgPort     int
}

// StartWGRelayEndpoint brings up an in-process WireGuard peer + netstack TCP forwarder.
func StartWGRelayEndpoint(ctx context.Context, cfg RelayConfig, outboundIP string, hub *RelayHub, sportMin, sportMax int) (*WGRelayEndpoint, error) {
	wgPort := parsePortFromAddr(cfg.ListenUDP)
	if wgPort <= 0 {
		return nil, fmt.Errorf("invalid WireGuard listen address %q", cfg.ListenUDP)
	}
	wgSubnet, err := netip.ParsePrefix(cfg.WGSubnet)
	if err != nil {
		return nil, fmt.Errorf("invalid WireGuard subnet %q: %w", cfg.WGSubnet, err)
	}

	serverKeys, err := GenerateWGKeyPair()
	if err != nil {
		return nil, err
	}
	clientKeys, err := GenerateWGKeyPair()
	if err != nil {
		return nil, err
	}

	onOutbound := func(rawIPv4 []byte) {
		c, ok := parseTCPPayload(rawIPv4, arphrdNone)
		if !ok || int(c.Sport) < sportMin || int(c.Sport) > sportMax {
			return
		}
		hub.Broadcast(c)
	}

	stackTUN, err := NewStackTUN(ctx, netip.MustParseAddr(wgServerAddrStr), onOutbound)
	if err != nil {
		return nil, err
	}

	dialer := NewPhysicalNICDialer(outboundIP, tcpOutboundDialGrace)
	attachTCPForwarder(ctx, stackTUN.Stack(), dialer, wgSubnet)

	wgLogger := device.NewLogger(device.LogLevelError, "[wg] ")
	dev := device.NewDevice(stackTUN, conn.NewDefaultBind(), wgLogger)
	uapiConf := BuildUAPIConfig(serverKeys.PrivateHex(), clientKeys.PublicHex(), wgPort, wgClientCIDR)
	if err := dev.IpcSet(uapiConf); err != nil {
		dev.Close()
		_ = stackTUN.Close()
		return nil, fmt.Errorf("configure WireGuard device: %w", err)
	}
	if err := dev.Up(); err != nil {
		dev.Close()
		_ = stackTUN.Close()
		return nil, fmt.Errorf("bring up WireGuard device: %w", err)
	}

	clientConf := BuildClientWireGuardConf(
		clientKeys.PrivateBase64(),
		serverKeys.PublicBase64(),
		wgClientCIDR,
		wgPort,
		wgGameAllowedIPs,
	)
	log.Printf("WireGuard endpoint ready on UDP :%d (server_pub=%s)", wgPort, serverKeys.PublicBase64())

	return &WGRelayEndpoint{
		dev:        dev,
		tun:        stackTUN,
		clientConf: clientConf,
		wgPort:     wgPort,
	}, nil
}

func (w *WGRelayEndpoint) ClientConf() string {
	return w.clientConf
}

func (w *WGRelayEndpoint) Close() {
	if w == nil {
		return
	}
	if w.dev != nil {
		w.dev.Close()
	}
	if w.tun != nil {
		_ = w.tun.Close()
	}
}
