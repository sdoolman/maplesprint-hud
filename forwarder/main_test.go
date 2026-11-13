package main

import (
	"encoding/base64"
	"encoding/binary"
	"net/http"
	"net/http/httptest"
	"testing"
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

func TestParseTCPPayloadL3AndL2(t *testing.T) {
	rawIP := buildIPv4TCPPacket([4]byte{198, 51, 100, 1}, [4]byte{192, 0, 2, 2}, 443, 51000, 0x11223344, []byte("hello"))

	c, ok := parseTCPPayload(rawIP, arphrdNone)
	if !ok {
		t.Fatal("expected L3 packet to parse")
	}
	if c.Flow != "198.51.100.1:443->192.0.2.2:51000" || c.Seq != 0x11223344 || c.Sport != 443 {
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

	// Empty-payload ACK should be ignored
	ack := buildIPv4TCPPacket([4]byte{198, 51, 100, 1}, [4]byte{192, 0, 2, 2}, 443, 51000, 1, nil)
	if _, ok := parseTCPPayload(ack, arphrdNone); ok {
		t.Fatal("expected empty TCP ACK to be ignored")
	}
}

func TestResolveCaptureRange(t *testing.T) {
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path != "/config" || r.Header.Get("X-Ingest-Key") != "secret-key" {
			http.Error(w, "Unauthorized", http.StatusUnauthorized)
			return
		}
		w.Header().Set("Content-Type", "application/json")
		_, _ = w.Write([]byte(`{"sport_min":4000,"sport_max":4099}`))
	}))
	defer srv.Close()

	// Default (no key) -> generic 0-65535
	min, max := resolveCaptureRange(srv.URL, "", false, -1, -1)
	if min != 0 || max != 65535 {
		t.Fatalf("expected generic 0-65535, got %d-%d", min, max)
	}

	// Authenticated (valid key) -> fetched 4000-4099
	min, max = resolveCaptureRange(srv.URL, "secret-key", false, -1, -1)
	if min != 4000 || max != 4099 {
		t.Fatalf("expected authenticated 4000-4099, got %d-%d", min, max)
	}

	// --generic overrides key
	min, max = resolveCaptureRange(srv.URL, "secret-key", true, -1, -1)
	if min != 0 || max != 65535 {
		t.Fatalf("expected --generic 0-65535, got %d-%d", min, max)
	}

	// Explicit flags override everything
	min, max = resolveCaptureRange(srv.URL, "secret-key", false, 9000, 9010)
	if min != 9000 || max != 9010 {
		t.Fatalf("expected explicit 9000-9010, got %d-%d", min, max)
	}
}
