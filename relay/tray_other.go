//go:build !windows

package main

import (
	"context"
	"fmt"
	"net/url"
	"os"
	"path/filepath"
	"strings"
)

func validateHTTPURL(raw string) (string, error) {
	u, err := url.Parse(strings.TrimSpace(raw))
	if err != nil {
		return "", err
	}
	if (u.Scheme != "http" && u.Scheme != "https") || u.Host == "" {
		return "", fmt.Errorf("unsafe URL scheme or missing host: %q", raw)
	}
	return u.String(), nil
}

func validateLogPath(logPath, expectedDir string) (string, error) {
	if logPath == "" || expectedDir == "" {
		return "", fmt.Errorf("empty log path")
	}
	cleanDir := filepath.Clean(expectedDir)
	cleanPath := filepath.Clean(logPath)
	rel, err := filepath.Rel(cleanDir, cleanPath)
	if err != nil || rel == ".." || strings.HasPrefix(rel, ".."+string(filepath.Separator)) {
		return "", fmt.Errorf("log path %q escapes directory %q", cleanPath, cleanDir)
	}
	if !strings.EqualFold(filepath.Ext(cleanPath), ".log") {
		return "", fmt.Errorf("unexpected log extension: %q", cleanPath)
	}
	info, err := os.Stat(cleanPath)
	if err != nil || !info.Mode().IsRegular() {
		return "", fmt.Errorf("log file is not a regular file")
	}
	return cleanPath, nil
}

func openBrowser(_ string) {}

func setupLogging(_ RelayConfig) (string, string, func()) {
	return "", "", func() {}
}

func runTray(ctx context.Context, _ context.CancelFunc, _ RelayConfig, _, _ string) {
	<-ctx.Done()
}
