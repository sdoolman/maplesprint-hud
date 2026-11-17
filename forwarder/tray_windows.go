//go:build windows

package main

import (
	"context"
	"errors"
	"fmt"
	"log"
	"net/url"
	"os"
	"path/filepath"
	"runtime"
	"strings"
	"syscall"
	"unsafe"
)

var (
	user32                = syscall.NewLazyDLL("user32.dll")
	shell32               = syscall.NewLazyDLL("shell32.dll")
	kernel32              = syscall.NewLazyDLL("kernel32.dll")
	procRegisterClassExW  = user32.NewProc("RegisterClassExW")
	procCreateWindowExW   = user32.NewProc("CreateWindowExW")
	procDefWindowProcW    = user32.NewProc("DefWindowProcW")
	procDestroyWindow     = user32.NewProc("DestroyWindow")
	procGetMessageW       = user32.NewProc("GetMessageW")
	procTranslateMessage  = user32.NewProc("TranslateMessage")
	procDispatchMessageW  = user32.NewProc("DispatchMessageW")
	procPostQuitMessage   = user32.NewProc("PostQuitMessage")
	procPostMessageW      = user32.NewProc("PostMessageW")
	procCreatePopupMenu   = user32.NewProc("CreatePopupMenu")
	procAppendMenuW       = user32.NewProc("AppendMenuW")
	procTrackPopupMenu    = user32.NewProc("TrackPopupMenu")
	procDestroyMenu       = user32.NewProc("DestroyMenu")
	procSetForegroundWin  = user32.NewProc("SetForegroundWindow")
	procGetCursorPos      = user32.NewProc("GetCursorPos")
	procLoadIconW         = user32.NewProc("LoadIconW")
	procLoadImageW        = user32.NewProc("LoadImageW")
	procGetSystemMetrics  = user32.NewProc("GetSystemMetrics")
	procShellNotifyIconW  = shell32.NewProc("Shell_NotifyIconW")
	procShellExecuteW     = shell32.NewProc("ShellExecuteW")
	procGetModuleHandleW  = kernel32.NewProc("GetModuleHandleW")
	procEnumResourceNames = kernel32.NewProc("EnumResourceNamesW")
)

const (
	wmDestroy        = 0x0002
	wmClose          = 0x0010
	wmCommand        = 0x0111
	wmUser           = 0x0400
	wmTrayIcon       = wmUser + 1
	wmLButtonUp      = 0x0202
	wmLButtonDbl     = 0x0203
	wmRButtonUp      = 0x0205
	nimAdd           = 0x00000000
	nimDelete        = 0x00000002
	nifMessage       = 0x00000001
	nifIcon          = 0x00000002
	nifTip           = 0x00000004
	mfString         = 0x00000000
	mfSeparator      = 0x00000800
	tpmRightAlign    = 0x0008
	tpmBottomAlign   = 0x0020
	imageIcon        = 1
	lrShared         = 0x00008000
	smCxSmIcon       = 49
	smCySmIcon       = 50
	rtGroupIcon      = 14
	idiApplication   = 32512
	swShowNormal     = 1
	defaultIconDim   = 16
	logDirPerm       = os.FileMode(0o755)
	logFilePerm      = os.FileMode(0o644)
	cmdOpenHUD       = 1001
	cmdOpenLog       = 1002
	cmdQuit          = 1003
)

type wndClassExW struct {
	cbSize        uint32
	style         uint32
	lpfnWndProc   uintptr
	cbClsExtra    int32
	cbWndExtra    int32
	hInstance     uintptr
	hIcon         uintptr
	hCursor       uintptr
	hbrBackground uintptr
	lpszMenuName  *uint16
	lpszClassName *uint16
	hIconSm       uintptr
}

type point struct{ x, y int32 }

type msgWin struct {
	hwnd    uintptr
	message uint32
	wParam  uintptr
	lParam  uintptr
	time    uint32
	pt      point
}

type notifyIconDataW struct {
	cbSize           uint32
	hWnd             uintptr
	uID              uint32
	uFlags           uint32
	uCallbackMessage uint32
	hIcon            uintptr
	szTip            [128]uint16
	dwState          uint32
	dwStateMask      uint32
	szInfo           [256]uint16
	uVersion         uint32
	szInfoTitle      [64]uint16
	dwInfoFlags      uint32
	guidItem         [16]byte
	hBalloonIcon     uintptr
}

// validateHTTPURL enforces strict http/https scheme and host presence before shell launch.
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

// validateLogPath ensures target resolves strictly inside the expected log directory as a regular .log file.
func validateLogPath(logPath, expectedDir string) (string, error) {
	if logPath == "" || expectedDir == "" {
		return "", errors.New("empty log path")
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
		return "", errors.New("log file is not a regular file")
	}
	return cleanPath, nil
}

func shellExecute(target string) {
	verb, _ := syscall.UTF16PtrFromString("open")
	file, _ := syscall.UTF16PtrFromString(target)
	_, _, _ = procShellExecuteW.Call(
		0,
		uintptr(unsafe.Pointer(verb)),
		uintptr(unsafe.Pointer(file)),
		0, 0, swShowNormal,
	)
}

func openBrowser(rawURL string) {
	safeURL, err := validateHTTPURL(rawURL)
	if err != nil {
		log.Printf("blocked opening unverified HUD URL: %v", err)
		return
	}
	shellExecute(safeURL)
}

func openLogFile(logPath, expectedDir string) {
	safePath, err := validateLogPath(logPath, expectedDir)
	if err != nil {
		log.Printf("blocked opening log file: %v", err)
		return
	}
	shellExecute(safePath)
}

func setupLogging(cfg RelayConfig) (logPath string, logDir string, closeFn func()) {
	baseDir, err := os.UserCacheDir()
	if err != nil || baseDir == "" {
		baseDir = os.TempDir()
	}
	logDir = filepath.Join(baseDir, cfg.AppName)
	if err := os.MkdirAll(logDir, logDirPerm); err != nil {
		return "", "", func() {}
	}
	logPath = filepath.Join(logDir, cfg.LogFileName)
	prevPath := logPath + cfg.PrevLogSfx
	if info, statErr := os.Stat(logPath); statErr == nil && info.Size() > 0 {
		_ = os.Rename(logPath, prevPath)
	}
	f, err := os.OpenFile(logPath, os.O_CREATE|os.O_WRONLY|os.O_TRUNC, logFilePerm)
	if err != nil {
		return "", "", func() {}
	}
	log.SetOutput(f)
	return logPath, logDir, func() { _ = f.Close() }
}

func trayIconDimensions() (uintptr, uintptr) {
	cx, _, _ := procGetSystemMetrics.Call(smCxSmIcon)
	cy, _, _ := procGetSystemMetrics.Call(smCySmIcon)
	if cx == 0 {
		cx = defaultIconDim
	}
	if cy == 0 {
		cy = defaultIconDim
	}
	return cx, cy
}

// loadAppTrayIcon loads the embedded PE RT_GROUP_ICON resource bundled from
// assets/maplesprint.ico, falling back to stock IDI_APPLICATION when run unbundled.
func loadAppTrayIcon(hInst uintptr) uintptr {
	cx, cy := trayIconDimensions()
	var found uintptr
	enumCb := syscall.NewCallback(func(_ uintptr, _ uintptr, lpszName uintptr, _ uintptr) uintptr {
		if h, _, _ := procLoadImageW.Call(hInst, lpszName, imageIcon, cx, cy, lrShared); h != 0 {
			found = h
			return 0
		}
		return 1
	})
	_, _, _ = procEnumResourceNames.Call(hInst, uintptr(rtGroupIcon), enumCb, 0)
	if found != 0 {
		return found
	}
	stock, _, _ := procLoadIconW.Call(0, uintptr(idiApplication))
	return stock
}

type menuItem struct {
	id    uintptr
	flags uintptr
	label string
}

func showTrayMenu(hwnd uintptr, cfg RelayConfig, hasLog bool) {
	hMenu, _, _ := procCreatePopupMenu.Call()
	if hMenu == 0 {
		return
	}
	defer procDestroyMenu.Call(hMenu)

	items := []menuItem{{cmdOpenHUD, mfString, cfg.Menu.OpenHUD}}
	if hasLog {
		items = append(items, menuItem{cmdOpenLog, mfString, cfg.Menu.OpenLog})
	}
	items = append(items,
		menuItem{0, mfSeparator, ""},
		menuItem{cmdQuit, mfString, cfg.Menu.Quit},
	)

	for _, it := range items {
		var lpText uintptr
		if it.label != "" {
			p, _ := syscall.UTF16PtrFromString(it.label)
			lpText = uintptr(unsafe.Pointer(p))
		}
		_, _, _ = procAppendMenuW.Call(hMenu, it.flags, it.id, lpText)
	}

	var pt point
	_, _, _ = procGetCursorPos.Call(uintptr(unsafe.Pointer(&pt)))
	_, _, _ = procSetForegroundWin.Call(hwnd)
	_, _, _ = procTrackPopupMenu.Call(hMenu, tpmRightAlign|tpmBottomAlign, uintptr(pt.x), uintptr(pt.y), 0, hwnd, 0)
}

func runTray(ctx context.Context, cancel context.CancelFunc, cfg RelayConfig, logPath, logDir string) {
	runtime.LockOSThread()
	defer runtime.UnlockOSThread()

	hInst, _, _ := procGetModuleHandleW.Call(0)
	className, _ := syscall.UTF16PtrFromString(cfg.AppName + "TrayWnd")
	hIcon := loadAppTrayIcon(hInst)

	wndProc := syscall.NewCallback(func(h uintptr, msg uint32, wParam, lParam uintptr) uintptr {
		switch msg {
		case wmTrayIcon:
			switch lParam {
			case wmLButtonUp, wmLButtonDbl:
				openBrowser(cfg.HUDURL)
			case wmRButtonUp:
				showTrayMenu(h, cfg, logPath != "")
			}
			return 0
		case wmCommand:
			switch wParam & 0xffff {
			case cmdOpenHUD:
				openBrowser(cfg.HUDURL)
			case cmdOpenLog:
				openLogFile(logPath, logDir)
			case cmdQuit:
				cancel()
				_, _, _ = procDestroyWindow.Call(h)
			}
			return 0
		case wmClose:
			cancel()
			_, _, _ = procDestroyWindow.Call(h)
			return 0
		case wmDestroy:
			_, _, _ = procPostQuitMessage.Call(0)
			return 0
		}
		ret, _, _ := procDefWindowProcW.Call(h, uintptr(msg), wParam, lParam)
		return ret
	})

	wc := wndClassExW{
		cbSize:        uint32(unsafe.Sizeof(wndClassExW{})),
		lpfnWndProc:   wndProc,
		hInstance:     hInst,
		hIcon:         hIcon,
		lpszClassName: className,
	}
	if atom, _, err := procRegisterClassExW.Call(uintptr(unsafe.Pointer(&wc))); atom == 0 {
		log.Printf("tray window class registration failed: %v", err)
		<-ctx.Done()
		return
	}

	title, _ := syscall.UTF16PtrFromString(cfg.DisplayName)
	hwnd, _, err := procCreateWindowExW.Call(
		0,
		uintptr(unsafe.Pointer(className)),
		uintptr(unsafe.Pointer(title)),
		0, 0, 0, 0, 0, 0, 0, hInst, 0,
	)
	if hwnd == 0 {
		log.Printf("tray window creation failed: %v", err)
		<-ctx.Done()
		return
	}

	var nid notifyIconDataW
	nid.cbSize = uint32(unsafe.Sizeof(nid))
	nid.hWnd = hwnd
	nid.uID = 1
	nid.uFlags = nifMessage | nifIcon | nifTip
	nid.uCallbackMessage = wmTrayIcon
	nid.hIcon = hIcon
	tip, _ := syscall.UTF16FromString(cfg.Menu.Tooltip)
	copy(nid.szTip[:], tip)

	if ok, _, err := procShellNotifyIconW.Call(nimAdd, uintptr(unsafe.Pointer(&nid))); ok == 0 {
		log.Printf("tray icon add failed: %v", err)
	}
	defer func() {
		_, _, _ = procShellNotifyIconW.Call(nimDelete, uintptr(unsafe.Pointer(&nid)))
	}()

	go func() {
		<-ctx.Done()
		_, _, _ = procPostMessageW.Call(hwnd, wmClose, 0, 0)
	}()

	var m msgWin
	for {
		r, _, _ := procGetMessageW.Call(uintptr(unsafe.Pointer(&m)), 0, 0, 0)
		if int32(r) <= 0 {
			break
		}
		_, _, _ = procTranslateMessage.Call(uintptr(unsafe.Pointer(&m)))
		_, _, _ = procDispatchMessageW.Call(uintptr(unsafe.Pointer(&m)))
	}
}
