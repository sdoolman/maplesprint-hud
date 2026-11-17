//go:build !windows

package main

import "context"

func openBrowser(_ string) {}

func setupLogging() (string, func()) {
	return "", func() {}
}

func runTray(ctx context.Context, _ context.CancelFunc, _ string, _ string) {
	<-ctx.Done()
}
