package main

import (
	"encoding/base64"
	"encoding/binary"
	"fmt"
	"net"
)

const (
	ethPAll                 = 0x0003
	etherHeaderLen          = 14
	etherOffType            = 12
	etherTypeIPv4           = 0x0800
	pppAddrCtrl0            = 0xff
	pppAddrCtrl1            = 0x03
	pppHeaderLen            = 4
	pppOffProtoFull         = 2
	pppCompactHeaderLen     = 2
	pppProtoIPv4            = 0x0021
	arphrdEther             = 1
	arphrdPPP               = 512
	arphrdNone              = 0xfffe
	pcapGlobalAndPacketLen  = 40 // 24-byte pcap file header + 16-byte packet record header
	pcapMagicLE             = 0xa1b2c3d4
	pcapMagicLen            = 4
	nullLoopbackHdrLen      = 16
	ipVersionIPv4           = 4
	ipv4MinHdrLen           = 20
	ipv4VerIHLDefault       = 0x45 // IPv4, IHL=5 (20 bytes)
	ipv4IHLMask             = 0x0f
	ipv4WordBytes           = 4
	ipv4OffTotalLen         = 2
	ipv4OffProto            = 9
	ipv4OffSrcIP            = 12
	ipv4OffDstIP            = 16
	ipv4AddrLen             = 4
	ipProtoTCP              = 6
	tcpMinHdrLen            = 20
	tcpDataOffset5Words     = 0x50 // 5 * 4 = 20 bytes
	tcpOffSrcPort           = 0
	tcpOffDstPort           = 2
	tcpOffSeq               = 4
	tcpOffDataOffset        = 12
	tcpDataOffsetShift      = 4
	tcpDataOffsetNibbleMask = 0x0f
	tcpWordBytes            = 4
)

// RawChunk is the read-only TCP segment envelope streamed to the browser HUD.
type RawChunk struct {
	Type  string `json:"type"`
	Flow  string `json:"flow"`
	Seq   uint32 `json:"seq"`
	Sport uint16 `json:"sport"`
	Data  string `json:"data"`
}

func htons(v uint16) uint16 {
	return (v<<8)&0xff00 | (v>>8)&0x00ff
}

func stripCaptureHeader(raw []byte) []byte {
	if len(raw) > pcapGlobalAndPacketLen && binary.LittleEndian.Uint32(raw[:pcapMagicLen]) == pcapMagicLE {
		return raw[pcapGlobalAndPacketLen:]
	}
	if len(raw) > ipv4MinHdrLen && (raw[0]>>4) != ipVersionIPv4 && (raw[nullLoopbackHdrLen]>>4) == ipVersionIPv4 {
		return raw[nullLoopbackHdrLen:]
	}
	return raw
}

// stripLinkHeader strips L2/PPP framing and validates the leading IPv4 header nibble.
func stripLinkHeader(pkt []byte, hatype uint16) ([]byte, bool) {
	offset := 0
	switch hatype {
	case arphrdEther:
		if len(pkt) < etherHeaderLen || binary.BigEndian.Uint16(pkt[etherOffType:etherHeaderLen]) != etherTypeIPv4 {
			return nil, false
		}
		offset = etherHeaderLen
	case arphrdPPP:
		if len(pkt) >= pppHeaderLen &&
			pkt[0] == pppAddrCtrl0 &&
			pkt[1] == pppAddrCtrl1 &&
			binary.BigEndian.Uint16(pkt[pppOffProtoFull:pppHeaderLen]) == pppProtoIPv4 {
			offset = pppHeaderLen
		} else if len(pkt) >= pppCompactHeaderLen &&
			binary.BigEndian.Uint16(pkt[:pppCompactHeaderLen]) == pppProtoIPv4 {
			offset = pppCompactHeaderLen
		} else if len(pkt) > 0 && (pkt[0]>>4) != ipVersionIPv4 {
			return nil, false
		}
	default:
		if hatype != arphrdNone && len(pkt) > 0 && (pkt[0]>>4) != ipVersionIPv4 {
			return nil, false
		}
	}

	ip := pkt[offset:]
	if len(ip) < ipv4MinHdrLen || (ip[0]>>4) != ipVersionIPv4 {
		return nil, false
	}
	return ip, true
}

// parseTCPPayload extracts the TCP flow tuple, sequence number, source port, and payload
// from an IPv4 packet. It performs zero game-specific inspection.
func parseTCPPayload(pkt []byte, hatype uint16) (RawChunk, bool) {
	ip, ok := stripLinkHeader(pkt, hatype)
	if !ok {
		return RawChunk{}, false
	}
	ihl := int(ip[0]&ipv4IHLMask) * ipv4WordBytes
	totalLen := int(binary.BigEndian.Uint16(ip[ipv4OffTotalLen : ipv4OffTotalLen+2]))
	if ihl < ipv4MinHdrLen || len(ip) < ihl || ip[ipv4OffProto] != ipProtoTCP {
		return RawChunk{}, false
	}
	if totalLen > 0 && totalLen < len(ip) {
		ip = ip[:totalLen]
	}

	tcp := ip[ihl:]
	if len(tcp) < tcpMinHdrLen {
		return RawChunk{}, false
	}
	doff := int((tcp[tcpOffDataOffset]>>tcpDataOffsetShift)&tcpDataOffsetNibbleMask) * tcpWordBytes
	if doff < tcpMinHdrLen || len(tcp) < doff {
		return RawChunk{}, false
	}
	payload := tcp[doff:]
	if len(payload) == 0 {
		return RawChunk{}, false
	}

	sport := binary.BigEndian.Uint16(tcp[tcpOffSrcPort : tcpOffSrcPort+2])
	dport := binary.BigEndian.Uint16(tcp[tcpOffDstPort : tcpOffDstPort+2])
	seq := binary.BigEndian.Uint32(tcp[tcpOffSeq : tcpOffSeq+4])
	srcIP := net.IP(ip[ipv4OffSrcIP : ipv4OffSrcIP+ipv4AddrLen]).String()
	dstIP := net.IP(ip[ipv4OffDstIP : ipv4OffDstIP+ipv4AddrLen]).String()

	return RawChunk{
		Type:  "raw_chunk",
		Flow:  fmt.Sprintf("%s:%d->%s:%d", srcIP, sport, dstIP, dport),
		Seq:   seq,
		Sport: sport,
		Data:  base64.StdEncoding.EncodeToString(payload),
	}, true
}
