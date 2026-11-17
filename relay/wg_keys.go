package main

import (
	"crypto/rand"
	"encoding/base64"
	"encoding/hex"
	"fmt"
	"strings"

	"golang.org/x/crypto/curve25519"
)

const wgKeyLen = 32

// WGKeyPair holds a clamped Curve25519 WireGuard keypair.
type WGKeyPair struct {
	Private [wgKeyLen]byte
	Public  [wgKeyLen]byte
}

// GenerateWGKeyPair creates a fresh Curve25519 keypair suitable for WireGuard.
func GenerateWGKeyPair() (WGKeyPair, error) {
	var kp WGKeyPair
	if _, err := rand.Read(kp.Private[:]); err != nil {
		return WGKeyPair{}, fmt.Errorf("generate private key: %w", err)
	}
	// Standard Curve25519 scalar clamping required by WireGuard.
	kp.Private[0] &= 248
	kp.Private[31] = (kp.Private[31] & 127) | 64

	pub, err := curve25519.X25519(kp.Private[:], curve25519.Basepoint)
	if err != nil {
		return WGKeyPair{}, fmt.Errorf("derive public key: %w", err)
	}
	copy(kp.Public[:], pub)
	return kp, nil
}

func (kp WGKeyPair) PrivateBase64() string {
	return base64.StdEncoding.EncodeToString(kp.Private[:])
}

func (kp WGKeyPair) PublicBase64() string {
	return base64.StdEncoding.EncodeToString(kp.Public[:])
}

func (kp WGKeyPair) PrivateHex() string {
	return hex.EncodeToString(kp.Private[:])
}

func (kp WGKeyPair) PublicHex() string {
	return hex.EncodeToString(kp.Public[:])
}

// BuildClientWireGuardConf renders a ready-to-import WireGuard client configuration.
func BuildClientWireGuardConf(clientPrivB64, serverPubB64, clientCIDR string, wgPort int, allowedIPs string) string {
	return strings.Join([]string{
		"[Interface]",
		"PrivateKey = " + clientPrivB64,
		"Address = " + clientCIDR,
		"",
		"[Peer]",
		"PublicKey = " + serverPubB64,
		fmt.Sprintf("Endpoint = 127.0.0.1:%d", wgPort),
		"AllowedIPs = " + allowedIPs,
		"PersistentKeepalive = 25",
		"",
	}, "\n")
}

// BuildUAPIConfig formats a WireGuard Userspace API (IpcSet) configuration block.
func BuildUAPIConfig(serverPrivHex, clientPubHex string, wgPort int, clientAllowedIP string) string {
	return strings.Join([]string{
		"private_key=" + serverPrivHex,
		fmt.Sprintf("listen_port=%d", wgPort),
		"replace_peers=true",
		"public_key=" + clientPubHex,
		"allowed_ip=" + clientAllowedIP,
		"",
	}, "\n")
}
