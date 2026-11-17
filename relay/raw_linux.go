//go:build linux

package main

import (
	"errors"
	"fmt"
	"net"
	"syscall"
)

// RawSocketSource reads link-layer packets from a configured network interface (e.g. wg0).
type RawSocketSource struct {
	fd int
}

func OpenRawSocketSource(ifaceName string, linkProto uint16) (*RawSocketSource, error) {
	if ifaceName == "" {
		return nil, errors.New("interface name must not be empty")
	}
	iface, err := net.InterfaceByName(ifaceName)
	if err != nil {
		return nil, fmt.Errorf("interface %s: %w", ifaceName, err)
	}
	proto := int(htons(linkProto))
	fd, err := syscall.Socket(syscall.AF_PACKET, syscall.SOCK_RAW, proto)
	if err != nil {
		return nil, fmt.Errorf("AF_PACKET socket: %w", err)
	}
	sll := &syscall.SockaddrLinklayer{
		Protocol: uint16(proto),
		Ifindex:  iface.Index,
	}
	if err := syscall.Bind(fd, sll); err != nil {
		_ = syscall.Close(fd)
		return nil, fmt.Errorf("bind %s: %w", ifaceName, err)
	}
	return &RawSocketSource{fd: fd}, nil
}

func (s *RawSocketSource) ReadPacket(buf []byte) ([]byte, uint16, error) {
	for {
		n, sa, err := syscall.Recvfrom(s.fd, buf, 0)
		if err != nil {
			if errors.Is(err, syscall.EINTR) {
				continue
			}
			return nil, 0, err
		}
		var hatype uint16 = arphrdNone
		if sll, ok := sa.(*syscall.SockaddrLinklayer); ok {
			hatype = sll.Hatype
		}
		return buf[:n], hatype, nil
	}
}

func (s *RawSocketSource) Close() error {
	return syscall.Close(s.fd)
}
