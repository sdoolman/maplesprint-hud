//go:build !linux

package main

import "fmt"

// RawSocketSource stub for non-Linux platforms (Windows/macOS use UDPPacketSource on 127.0.0.1:51820).
type RawSocketSource struct{}

func OpenRawSocketSource(ifaceName string) (*RawSocketSource, error) {
	return nil, fmt.Errorf("interface capture (%s) is only supported on Linux; use --listen-udp 127.0.0.1:51820 on Windows/macOS", ifaceName)
}

func (s *RawSocketSource) ReadPacket(buf []byte) ([]byte, uint16, error) {
	return nil, 0, fmt.Errorf("not supported")
}

func (s *RawSocketSource) Close() error {
	return nil
}
