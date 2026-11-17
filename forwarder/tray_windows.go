//go:build windows

package main

import (
	"context"
	"log"
	"os"
	"os/exec"
	"path/filepath"
	"runtime"
	"syscall"
	"unsafe"
)

var (
	user32               = syscall.NewLazyDLL("user32.dll")
	shell32              = syscall.NewLazyDLL("shell32.dll")
	kernel32             = syscall.NewLazyDLL("kernel32.dll")
	procRegisterClassExW = user32.NewProc("RegisterClassExW")
	procCreateWindowExW  = user32.NewProc("CreateWindowExW")
	procDefWindowProcW   = user32.NewProc("DefWindowProcW")
	procDestroyWindow    = user32.NewProc("DestroyWindow")
	procGetMessageW      = user32.NewProc("GetMessageW")
	procTranslateMessage = user32.NewProc("TranslateMessage")
	procDispatchMessageW = user32.NewProc("DispatchMessageW")
	procPostQuitMessage  = user32.NewProc("PostQuitMessage")
	procPostMessageW     = user32.NewProc("PostMessageW")
	procCreatePopupMenu  = user32.NewProc("CreatePopupMenu")
	procAppendMenuW      = user32.NewProc("AppendMenuW")
	procTrackPopupMenu   = user32.NewProc("TrackPopupMenu")
	procDestroyMenu      = user32.NewProc("DestroyMenu")
	procSetForegroundWin = user32.NewProc("SetForegroundWindow")
	procGetCursorPos     = user32.NewProc("GetCursorPos")
	procCreateIcon       = user32.NewProc("CreateIcon")
	procDestroyIcon      = user32.NewProc("DestroyIcon")
	procShellNotifyIconW = shell32.NewProc("Shell_NotifyIconW")
	procGetModuleHandleW = kernel32.NewProc("GetModuleHandleW")
)

const (
	wmDestroy     = 0x0002
	wmClose       = 0x0010
	wmCommand     = 0x0111
	wmUser        = 0x0400
	wmTrayIcon    = wmUser + 1
	wmLButtonUp   = 0x0202
	wmLButtonDbl  = 0x0203
	wmRButtonUp   = 0x0205
	nimAdd        = 0x00000000
	nimDelete     = 0x00000002
	nifMessage    = 0x00000001
	nifIcon       = 0x00000002
	nifTip        = 0x00000004
	mfString      = 0x00000000
	mfSeparator   = 0x00000800
	tpmRightAlign = 0x0008
	tpmBottomAlgn = 0x0020
	cmdOpenHUD    = 1001
	cmdOpenLog    = 1002
	cmdQuit       = 1003
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

type point struct {
	x, y int32
}

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

func openBrowser(targetURL string) {
	if targetURL == "" {
		return
	}
	_ = exec.Command("rundll32.exe", "url.dll,FileProtocolHandler", targetURL).Start()
}

func openLogFile(path string) {
	if path == "" {
		return
	}
	_ = exec.Command("notepad.exe", path).Start()
}

func setupLogging() (string, func()) {
	baseDir, err := os.UserCacheDir()
	if err != nil || baseDir == "" {
		baseDir = os.TempDir()
	}
	logDir := filepath.Join(baseDir, "MapleSprint")
	if err := os.MkdirAll(logDir, 0o755); err != nil {
		return "", func() {}
	}
	logPath := filepath.Join(logDir, "relay.log")
	f, err := os.OpenFile(logPath, os.O_CREATE|os.O_WRONLY|os.O_TRUNC, 0o644)
	if err != nil {
		return "", func() {}
	}
	log.SetOutput(f)
	return logPath, func() { _ = f.Close() }
}

// createMapleIcon builds a 16x16 orange maple-leaf RGBA tray icon in memory.
func createMapleIcon(hInst uintptr) uintptr {
	// 16x16 1bpp AND mask (all 0 = opaque where XOR alpha is set)
	var andMask [32]byte
	// 16x16 32bpp BGRA pixels
	var pixels [16 * 16 * 4]byte
	// Simple crisp orange rounded-badge with gold center leaf silhouette
	for y := 0; y < 16; y++ {
		for x := 0; x < 16; x++ {
			idx := (y*16 + x) * 4
			dx := x - 7
			dy := y - 7
			if dx*dx+dy*dy > 58 {
				andMask[y*2+x/8] |= 1 << (7 - uint(x%8))
				continue
			}
			// Inner golden maple diamond
			if (dx >= -3 && dx <= 3 && dy >= -3 && dy <= 3 && (absInt(dx)+absInt(dy) <= 4)) || (dx == 0 && dy >= 4 && dy <= 5) {
				pixels[idx+0] = 0x24 // B
				pixels[idx+1] = 0xbf // G
				pixels[idx+2] = 0xfb // R (Gold)
				pixels[idx+3] = 0xff
			} else {
				pixels[idx+0] = 0x1a // B
				pixels[idx+1] = 0x84 // G
				pixels[idx+2] = 0xff // R (Maple Orange)
				pixels[idx+3] = 0xff
			}
		}
	}
	hIcon, _, _ := procCreateIcon.Call(
		hInst,
		16,
		16,
		1,
		32,
		uintptr(unsafe.Pointer(&andMask[0])),
		uintptr(unsafe.Pointer(&pixels[0])),
	)
	return hIcon
}

func absInt(v int) int {
	if v < 0 {
		return -v
	}
	return v
}

func runTray(ctx context.Context, cancel context.CancelFunc, hudURL, logPath string) {
	runtime.LockOSThread()
	defer runtime.UnlockOSThread()

	hInst, _, _ := procGetModuleHandleW.Call(0)
	className, _ := syscall.UTF16PtrFromString("MapleSprintTrayWnd")
	hIcon := createMapleIcon(hInst)
	if hIcon != 0 {
		defer procDestroyIcon.Call(hIcon)
	}

	var hwnd uintptr
	wndProc := syscall.NewCallback(func(h uintptr, msg uint32, wParam, lParam uintptr) uintptr {
		switch msg {
		case wmTrayIcon:
			switch lParam {
			case wmLButtonUp, wmLButtonDbl:
				openBrowser(hudURL)
			case wmRButtonUp:
				hMenu, _, _ := procCreatePopupMenu.Call()
				if hMenu != 0 {
					sOpen, _ := syscall.UTF16PtrFromString("Open MapleSprint HUD")
					sLog, _ := syscall.UTF16PtrFromString("Open Relay Log")
					sQuit, _ := syscall.UTF16PtrFromString("Quit MapleSprint Relay")
					_, _, _ = procAppendMenuW.Call(hMenu, mfString, cmdOpenHUD, uintptr(unsafe.Pointer(sOpen)))
					if logPath != "" {
						_, _, _ = procAppendMenuW.Call(hMenu, mfString, cmdOpenLog, uintptr(unsafe.Pointer(sLog)))
					}
					_, _, _ = procAppendMenuW.Call(hMenu, mfSeparator, 0, 0)
					_, _, _ = procAppendMenuW.Call(hMenu, mfString, cmdQuit, uintptr(unsafe.Pointer(sQuit)))

					var pt point
					_, _, _ = procGetCursorPos.Call(uintptr(unsafe.Pointer(&pt)))
					_, _, _ = procSetForegroundWin.Call(h)
					_, _, _ = procTrackPopupMenu.Call(hMenu, tpmRightAlign|tpmBottomAlgn, uintptr(pt.x), uintptr(pt.y), 0, h, 0)
					_, _, _ = procDestroyMenu.Call(hMenu)
				}
			}
			return 0
		case wmCommand:
			switch wParam & 0xffff {
			case cmdOpenHUD:
				openBrowser(hudURL)
			case cmdOpenLog:
				openLogFile(logPath)
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
		lpszClassName: className,
	}
	_, _, _ = procRegisterClassExW.Call(uintptr(unsafe.Pointer(&wc)))

	title, _ := syscall.UTF16PtrFromString("MapleSprint Relay")
	hwnd, _, _ = procCreateWindowExW.Call(
		0,
		uintptr(unsafe.Pointer(className)),
		uintptr(unsafe.Pointer(title)),
		0,
		0, 0, 0, 0,
		0, 0, hInst, 0,
	)
	if hwnd == 0 {
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
	tip, _ := syscall.UTF16FromString("MapleSprint Relay — Click to open HUD")
	copy(nid.szTip[:], tip)

	_, _, _ = procShellNotifyIconW.Call(nimAdd, uintptr(unsafe.Pointer(&nid)))
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
