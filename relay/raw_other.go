//go:build !linux

package main

import "fmt"

// RawSocketSource stub for non-Linux platforms (Windows/macOS use UDPPacketSource).
type RawSocketSource struct{}

func OpenRawSocketSource(ifaceName string, _ uint16) (*RawSocketSource, error) {
	return nil, fmt.Errorf("interface capture (%s) is only supported on Linux; use --listen-udp on Windows/macOS", ifaceName)
}

func (s *RawSocketSource) ReadPacket(_ []byte) ([]byte, uint16, error) {
	return nil, 0, fmt.Errorf("interface capture not supported on this OS")
}

func (s *RawSocketSource) Close() error {
	return nil
}
