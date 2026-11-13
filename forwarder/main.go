package main

import (
	"bufio"
	"crypto/rand"
	"crypto/sha1"
	"crypto/tls"
	"encoding/base64"
	"encoding/binary"
	"encoding/json"
	"errors"
	"flag"
	"fmt"
	"io"
	"log"
	"net"
	"net/http"
	"net/url"
	"os"
	"strings"
	"syscall"
	"time"
)

const (
	ethPAll       = 0x0003
	arphrdEther   = 1
	arphrdNone    = 0xfffe
	maxBatchItems = 32
	flushInterval = 20 * time.Millisecond
)

type captureConfig struct {
	SportMin int `json:"sport_min"`
	SportMax int `json:"sport_max"`
}

type chunk struct {
	Flow  string `json:"flow"`
	Seq   uint32 `json:"seq"`
	Sport uint16 `json:"sport"`
	Data  string `json:"data"`
}

type batchPayload struct {
	Chunks []chunk `json:"chunks"`
}

func htons(v uint16) uint16 {
	return (v<<8)&0xff00 | (v>>8)&0x00ff
}

// resolveCaptureRange picks port bounds from flags or GET /config when a key is set,
// defaulting to generic (0-65535) when unauthenticated or in --generic mode.
func resolveCaptureRange(workerURL, ingestKey string, generic bool, flagMin, flagMax int) (int, int) {
	if flagMin >= 0 && flagMax >= flagMin {
		return flagMin, flagMax
	}
	if !generic && ingestKey != "" {
		cfgURL := strings.TrimRight(workerURL, "/") + "/config"
		req, err := http.NewRequest(http.MethodGet, cfgURL, nil)
		if err == nil {
			req.Header.Set("X-Ingest-Key", ingestKey)
			client := &http.Client{Timeout: 5 * time.Second}
			resp, err := client.Do(req)
			if err == nil {
				defer resp.Body.Close()
				if resp.StatusCode == http.StatusOK {
					var cfg captureConfig
					if json.NewDecoder(resp.Body).Decode(&cfg) == nil && cfg.SportMax >= cfg.SportMin {
						return cfg.SportMin, cfg.SportMax
					}
				} else {
					log.Printf("config endpoint returned %d; falling back to generic TCP", resp.StatusCode)
				}
			} else {
				log.Printf("config fetch failed (%v); falling back to generic TCP", err)
			}
		}
	}
	return 0, 65535
}

// parseTCPPayload extracts flow, seq, source port, and TCP payload from a raw L2 or L3 IPv4 packet.
func parseTCPPayload(pkt []byte, hatype uint16) (chunk, bool) {
	offset := 0
	if hatype == arphrdEther {
		if len(pkt) < 14 {
			return chunk{}, false
		}
		ethType := binary.BigEndian.Uint16(pkt[12:14])
		if ethType != 0x0800 {
			return chunk{}, false
		}
		offset = 14
	} else if hatype != arphrdNone && len(pkt) > 0 && (pkt[0]>>4) != 4 {
		// Unknown link type and not IPv4 at offset 0
		return chunk{}, false
	}

	ip := pkt[offset:]
	if len(ip) < 20 || (ip[0]>>4) != 4 {
		return chunk{}, false
	}
	ihl := int(ip[0]&0x0f) * 4
	totalLen := int(binary.BigEndian.Uint16(ip[2:4]))
	if ihl < 20 || len(ip) < ihl || ip[9] != 6 { // proto 6 = TCP
		return chunk{}, false
	}
	if totalLen > 0 && totalLen < len(ip) {
		ip = ip[:totalLen]
	}

	tcp := ip[ihl:]
	if len(tcp) < 20 {
		return chunk{}, false
	}
	doff := int((tcp[12]>>4)&0x0f) * 4
	if doff < 20 || len(tcp) < doff {
		return chunk{}, false
	}
	payload := tcp[doff:]
	if len(payload) == 0 {
		return chunk{}, false
	}

	sport := binary.BigEndian.Uint16(tcp[0:2])
	dport := binary.BigEndian.Uint16(tcp[2:4])
	seq := binary.BigEndian.Uint32(tcp[4:8])
	srcIP := net.IP(ip[12:16]).String()
	dstIP := net.IP(ip[16:20]).String()

	return chunk{
		Flow:  fmt.Sprintf("%s:%d->%s:%d", srcIP, sport, dstIP, dport),
		Seq:   seq,
		Sport: sport,
		Data:  base64.StdEncoding.EncodeToString(payload),
	}, true
}

type simpleWS struct {
	conn net.Conn
}

func dialWS(rawURL string, headers map[string]string) (*simpleWS, error) {
	u, err := url.Parse(rawURL)
	if err != nil {
		return nil, err
	}
	useTLS := u.Scheme == "wss"
	host := u.Hostname()
	port := u.Port()
	if port == "" {
		if useTLS {
			port = "443"
		} else {
			port = "80"
		}
	}
	addr := net.JoinHostPort(host, port)

	var conn net.Conn
	if useTLS {
		conn, err = tls.DialWithDialer(&net.Dialer{Timeout: 10 * time.Second}, "tcp", addr, &tls.Config{ServerName: host})
	} else {
		conn, err = net.DialTimeout("tcp", addr, 10*time.Second)
	}
	if err != nil {
		return nil, err
	}

	keyBytes := make([]byte, 16)
	if _, err := rand.Read(keyBytes); err != nil {
		conn.Close()
		return nil, err
	}
	wsKey := base64.StdEncoding.EncodeToString(keyBytes)

	path := u.EscapedPath()
	if path == "" {
		path = "/"
	}
	if u.RawQuery != "" {
		path += "?" + u.RawQuery
	}

	var req strings.Builder
	fmt.Fprintf(&req, "GET %s HTTP/1.1\r\n", path)
	fmt.Fprintf(&req, "Host: %s\r\n", u.Host)
	req.WriteString("Upgrade: websocket\r\n")
	req.WriteString("Connection: Upgrade\r\n")
	fmt.Fprintf(&req, "Sec-WebSocket-Key: %s\r\n", wsKey)
	req.WriteString("Sec-WebSocket-Version: 13\r\n")
	for k, v := range headers {
		fmt.Fprintf(&req, "%s: %s\r\n", k, v)
	}
	req.WriteString("\r\n")

	if _, err := conn.Write([]byte(req.String())); err != nil {
		conn.Close()
		return nil, err
	}

	br := bufio.NewReader(conn)
	statusLine, err := br.ReadString('\n')
	if err != nil || !strings.Contains(statusLine, "101") {
		conn.Close()
		return nil, fmt.Errorf("websocket upgrade failed: %q (%v)", strings.TrimSpace(statusLine), err)
	}

	expectedAccept := computeWSAccept(wsKey)
	gotAccept := ""
	for {
		line, err := br.ReadString('\n')
		if err != nil {
			conn.Close()
			return nil, err
		}
		line = strings.TrimRight(line, "\r\n")
		if line == "" {
			break
		}
		if k, v, ok := strings.Cut(line, ":"); ok && strings.EqualFold(strings.TrimSpace(k), "Sec-WebSocket-Accept") {
			gotAccept = strings.TrimSpace(v)
		}
	}
	if gotAccept != expectedAccept {
		conn.Close()
		return nil, errors.New("invalid Sec-WebSocket-Accept header")
	}

	return &simpleWS{conn: conn}, nil
}

func computeWSAccept(key string) string {
	h := sha1.New()
	io.WriteString(h, key+"258EAFA5-E914-47DA-95CA-C5AB0DC85B11")
	return base64.StdEncoding.EncodeToString(h.Sum(nil))
}

func (ws *simpleWS) SendText(data []byte) error {
	mask := make([]byte, 4)
	if _, err := rand.Read(mask); err != nil {
		return err
	}
	n := len(data)
	header := make([]byte, 0, 14)
	header = append(header, 0x81) // FIN + text frame
	switch {
	case n < 126:
		header = append(header, 0x80|byte(n))
	case n < 65536:
		header = append(header, 0x80|126, byte(n>>8), byte(n))
	default:
		header = append(header, 0x80|127,
			byte(n>>56), byte(n>>48), byte(n>>40), byte(n>>32),
			byte(n>>24), byte(n>>16), byte(n>>8), byte(n))
	}
	header = append(header, mask...)

	frame := make([]byte, len(header)+n)
	copy(frame, header)
	masked := frame[len(header):]
	for i := 0; i < n; i++ {
		masked[i] = data[i] ^ mask[i&3]
	}

	_ = ws.conn.SetWriteDeadline(time.Now().Add(5 * time.Second))
	_, err := ws.conn.Write(frame)
	return err
}

func (ws *simpleWS) Close() {
	_ = ws.conn.Close()
}

func openRawSocket(ifaceName string) (int, error) {
	iface, err := net.InterfaceByName(ifaceName)
	if err != nil {
		return -1, fmt.Errorf("interface %s: %w", ifaceName, err)
	}
	fd, err := syscall.Socket(syscall.AF_PACKET, syscall.SOCK_RAW, int(htons(ethPAll)))
	if err != nil {
		return -1, fmt.Errorf("AF_PACKET socket (run as root or CAP_NET_RAW): %w", err)
	}
	sll := &syscall.SockaddrLinklayer{
		Protocol: htons(ethPAll),
		Ifindex:  iface.Index,
	}
	if err := syscall.Bind(fd, sll); err != nil {
		syscall.Close(fd)
		return -1, fmt.Errorf("bind %s: %w", ifaceName, err)
	}
	return fd, nil
}

func main() {
	workerURL := flag.String("worker", "", "Worker base URL (e.g. https://maple-hub.example.workers.dev)")
	roomID := flag.String("room", "default", "Room ID")
	ifaceName := flag.String("iface", "wg0", "Network interface to capture")
	ingestKey := flag.String("key", os.Getenv("INGEST_KEY"), "Optional ingest key (or INGEST_KEY env)")
	generic := flag.Bool("generic", false, "Force generic TCP forwarding (0-65535) without fetching /config")
	sportMinFlag := flag.Int("sport-min", -1, "Explicit minimum source port override")
	sportMaxFlag := flag.Int("sport-max", -1, "Explicit maximum source port override")
	flag.Parse()

	if *workerURL == "" {
		log.Fatal("--worker is required")
	}

	sportMin, sportMax := resolveCaptureRange(*workerURL, *ingestKey, *generic, *sportMinFlag, *sportMaxFlag)
	mode := "generic"
	if sportMin > 0 || sportMax < 65535 {
		mode = "filtered"
	}
	log.Printf("mode=%s iface=%s sport_range=%d-%d room=%s", mode, *ifaceName, sportMin, sportMax, *roomID)

	fd, err := openRawSocket(*ifaceName)
	if err != nil {
		log.Fatal(err)
	}
	defer syscall.Close(fd)

	chChunks := make(chan chunk, 512)
	go func() {
		buf := make([]byte, 65536)
		for {
			n, sa, err := syscall.Recvfrom(fd, buf, 0)
			if err != nil {
				if errors.Is(err, syscall.EINTR) {
					continue
				}
				log.Fatalf("recvfrom error: %v", err)
			}
			var hatype uint16 = arphrdNone
			if sll, ok := sa.(*syscall.SockaddrLinklayer); ok {
				hatype = sll.Hatype
			}
			c, ok := parseTCPPayload(buf[:n], hatype)
			if !ok {
				continue
			}
			if int(c.Sport) < sportMin || int(c.Sport) > sportMax {
				continue
			}
			select {
			case chChunks <- c:
			default:
				// Drop on extreme backpressure rather than stalling packet capture
			}
		}
	}()

	wsURL := strings.Replace(strings.TrimRight(*workerURL, "/"), "http", "ws", 1) +
		"/room/" + url.PathEscape(*roomID) + "?role=ingest"
	headers := map[string]string{}
	if *ingestKey != "" {
		headers["X-Ingest-Key"] = *ingestKey
	}

	for {
		ws, err := dialWS(wsURL, headers)
		if err != nil {
			log.Printf("ws connect failed: %v; retrying in 2s", err)
			time.Sleep(2 * time.Second)
			continue
		}
		log.Printf("connected to %s", wsURL)

		ticker := time.NewTicker(flushInterval)
		batch := make([]chunk, 0, maxBatchItems)
		flush := func() error {
			if len(batch) == 0 {
				return nil
			}
			payload, err := json.Marshal(batchPayload{Chunks: batch})
			batch = batch[:0]
			if err != nil {
				return err
			}
			return ws.SendText(payload)
		}

		var sendErr error
		for sendErr == nil {
			select {
			case c := <-chChunks:
				batch = append(batch, c)
				if len(batch) >= maxBatchItems {
					sendErr = flush()
				}
			case <-ticker.C:
				sendErr = flush()
			}
		}
		ticker.Stop()
		ws.Close()
		log.Printf("ws disconnected (%v); reconnecting in 2s", sendErr)
		time.Sleep(2 * time.Second)
	}
}
