package main

import (
	"errors"
	"fmt"
	"net"
	"net/netip"
	"sync"

	"golang.zx2c4.com/wireguard/conn"
)

type loopbackEndpoint struct {
	dst netip.AddrPort
}

func (e *loopbackEndpoint) ClearSrc()           {}
func (e *loopbackEndpoint) SrcToString() string { return "" }
func (e *loopbackEndpoint) DstToString() string { return e.dst.String() }
func (e *loopbackEndpoint) DstToBytes() []byte  { return e.dst.Addr().AsSlice() }
func (e *loopbackEndpoint) DstIP() netip.Addr   { return e.dst.Addr() }
func (e *loopbackEndpoint) SrcIP() netip.Addr   { return netip.Addr{} }

// LoopbackBind implements wireguard/conn.Bind strictly on a loopback IPv4 address (e.g. 127.0.0.1)
// instead of 0.0.0.0 / [::], preventing Windows Defender Firewall prompts.
type LoopbackBind struct {
	listenIP netip.Addr
	mu       sync.Mutex
	pc       *net.UDPConn
}

// NewLoopbackBind creates a WireGuard UDP bind restricted to the given IPv4 address.
func NewLoopbackBind(ip netip.Addr) (*LoopbackBind, error) {
	if !ip.Is4() || !ip.IsLoopback() {
		return nil, fmt.Errorf("loopback bind requires IPv4 loopback address, got %s", ip)
	}
	return &LoopbackBind{listenIP: ip}, nil
}

func (b *LoopbackBind) Open(port uint16) ([]conn.ReceiveFunc, uint16, error) {
	b.mu.Lock()
	defer b.mu.Unlock()
	if b.pc != nil {
		return nil, 0, conn.ErrBindAlreadyOpen
	}

	laddr := net.UDPAddrFromAddrPort(netip.AddrPortFrom(b.listenIP, port))
	pc, err := net.ListenUDP("udp4", laddr)
	if err != nil {
		return nil, 0, err
	}
	b.pc = pc

	boundPort := uint16(pc.LocalAddr().(*net.UDPAddr).Port)
	recvFn := func(packets [][]byte, sizes []int, eps []conn.Endpoint) (int, error) {
		if len(packets) == 0 || len(sizes) == 0 || len(eps) == 0 {
			return 0, errors.New("empty receive batch")
		}
		n, addrPort, err := pc.ReadFromUDPAddrPort(packets[0])
		if err != nil {
			return 0, err
		}
		sizes[0] = n
		eps[0] = &loopbackEndpoint{dst: addrPort}
		return 1, nil
	}
	return []conn.ReceiveFunc{recvFn}, boundPort, nil
}

func (b *LoopbackBind) Close() error {
	b.mu.Lock()
	pc := b.pc
	b.pc = nil
	b.mu.Unlock()
	if pc == nil {
		return nil
	}
	return pc.Close()
}

func (b *LoopbackBind) SetMark(_ uint32) error { return nil }
func (b *LoopbackBind) BatchSize() int         { return 1 }

func (b *LoopbackBind) ParseEndpoint(s string) (conn.Endpoint, error) {
	ap, err := netip.ParseAddrPort(s)
	if err != nil {
		return nil, err
	}
	return &loopbackEndpoint{dst: ap}, nil
}

func (b *LoopbackBind) Send(bufs [][]byte, ep conn.Endpoint) error {
	lep, ok := ep.(*loopbackEndpoint)
	if !ok {
		return conn.ErrWrongEndpointType
	}
	b.mu.Lock()
	pc := b.pc
	b.mu.Unlock()
	if pc == nil {
		return net.ErrClosed
	}
	for _, buf := range bufs {
		if _, err := pc.WriteToUDPAddrPort(buf, lep.dst); err != nil {
			return err
		}
	}
	return nil
}
