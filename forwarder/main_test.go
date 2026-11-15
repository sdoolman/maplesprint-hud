package main

import (
	"encoding/base64"
	"encoding/binary"
	"net"
	"testing"
	"time"
)

func buildIPv4TCPPacket(srcIP, dstIP [4]byte, sport, dport uint16, seq uint32, payload []byte) []byte {
	totalLen := 20 + 20 + len(payload)
	pkt := make([]byte, totalLen)
	pkt[0] = 0x45 // IPv4, IHL=5
	binary.BigEndian.PutUint16(pkt[2:4], uint16(totalLen))
	pkt[9] = 6 // TCP
	copy(pkt[12:16], srcIP[:])
	copy(pkt[16:20], dstIP[:])

	tcp := pkt[20:]
	binary.BigEndian.PutUint16(tcp[0:2], sport)
	binary.BigEndian.PutUint16(tcp[2:4], dport)
	binary.BigEndian.PutUint32(tcp[4:8], seq)
	tcp[12] = 0x50 // data offset = 5 (20 bytes)
	copy(tcp[20:], payload)
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

	// L2 Ethernet frame wrapping IPv4 (EtherType 0x0800)
	eth := make([]byte, 14+len(rawIP))
	binary.BigEndian.PutUint16(eth[12:14], 0x0800)
	copy(eth[14:], rawIP)
	c2, ok := parseTCPPayload(eth, arphrdEther)
	if !ok || c2.Sport != 443 {
		t.Fatalf("expected L2 Ethernet packet to parse, got ok=%v chunk=%+v", ok, c2)
	}

	// PPP frame wrapping IPv4 (0xff 0x03 0x00 0x21)
	ppp := make([]byte, 4+len(rawIP))
	ppp[0] = 0xff
	ppp[1] = 0x03
	binary.BigEndian.PutUint16(ppp[2:4], 0x0021)
	copy(ppp[4:], rawIP)
	c3, ok := parseTCPPayload(ppp, arphrdPPP)
	if !ok || c3.Flow != c.Flow || c3.Seq != c.Seq || c3.Data != c.Data {
		t.Fatalf("expected PPP packet to parse, got ok=%v chunk=%+v", ok, c3)
	}

	// Empty-payload ACK should be ignored
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

func TestPhysicalNICDialerBinding(t *testing.T) {
	d := NewPhysicalNICDialer("192.168.1.50", 5*time.Second)
	tcpAddr, ok := d.LocalAddr.(*net.TCPAddr)
	if !ok || tcpAddr.IP.String() != "192.168.1.50" {
		t.Fatalf("expected LocalAddr bound to 192.168.1.50, got %+v", d.LocalAddr)
	}
}

func TestValidatePortRange(t *testing.T) {
	min, max, err := validatePortRange(8484, 8999)
	if err != nil || min != 8484 || max != 8999 {
		t.Fatalf("expected valid 8484-8999, got %d-%d (err=%v)", min, max, err)
	}
	if _, _, err := validatePortRange(9000, 8000); err == nil {
		t.Fatal("expected error for inverted port range")
	}
}
