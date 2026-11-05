//! An unpackaged Win32 app cannot receive Snipping Tool's MSIX redirect result.
//! Use a private, short-lived region selector; never read or replace the clipboard.
use std::{ffi::c_void, mem::size_of, ptr::null_mut};
use windows::{core::{w, PCWSTR}, Win32::{
    Foundation::{HINSTANCE, HWND, LPARAM, LRESULT, POINT, RECT, WPARAM},
    Graphics::Gdi::*,
    System::LibraryLoader::GetModuleHandleW,
    UI::{HiDpi::*, Input::KeyboardAndMouse::{ReleaseCapture, SetCapture}, WindowsAndMessaging::*},
}};

const FAILED: &str = "screenshot_failed";
struct Dpi(DPI_AWARENESS_CONTEXT);
impl Drop for Dpi { fn drop(&mut self) { unsafe { SetThreadDpiAwarenessContext(self.0); } } }
struct Screen(HDC);
impl Drop for Screen { fn drop(&mut self) { unsafe { ReleaseDC(None, self.0); } } }
struct Bitmap { dc: HDC, bitmap: HBITMAP, previous: HGDIOBJ, pixels: *mut u8, len: usize }
impl Bitmap {
    unsafe fn new(screen: HDC, width: i32, height: i32) -> Result<Self, String> {
        let dc = CreateCompatibleDC(Some(screen));
        if dc.is_invalid() { return Err(FAILED.into()); }
        let info = BITMAPINFO { bmiHeader: BITMAPINFOHEADER {
            biSize: size_of::<BITMAPINFOHEADER>() as u32, biWidth: width, biHeight: -height,
            biPlanes: 1, biBitCount: 32, biCompression: BI_RGB.0, ..Default::default()
        }, ..Default::default() };
        let mut pixels: *mut c_void = null_mut();
        let bitmap = match CreateDIBSection(Some(screen), &info, DIB_RGB_COLORS, &mut pixels, None, 0) {
            Ok(bitmap) => bitmap,
            Err(_) => { let _ = DeleteDC(dc); return Err(FAILED.into()); }
        };
        let previous = SelectObject(dc, bitmap.into());
        if previous.is_invalid() || pixels.is_null() {
            let _ = DeleteObject(bitmap.into()); let _ = DeleteDC(dc); return Err(FAILED.into());
        }
        Ok(Self { dc, bitmap, previous, pixels: pixels.cast(), len: width as usize * height as usize * 4 })
    }
}
impl Drop for Bitmap {
    fn drop(&mut self) { unsafe {
        SelectObject(self.dc, self.previous); let _ = DeleteObject(self.bitmap.into()); let _ = DeleteDC(self.dc);
    } }
}
struct Class { name: Vec<u16>, instance: HINSTANCE }
impl Drop for Class { fn drop(&mut self) { unsafe { let _ = UnregisterClassW(PCWSTR(self.name.as_ptr()), Some(self.instance)); } } }
struct Overlay(HWND);
impl Drop for Overlay { fn drop(&mut self) { unsafe { let _ = DestroyWindow(self.0); } } }
struct Selection {
    original: Bitmap, dimmed: Bitmap,
    x: i32, y: i32, width: i32, height: i32,
    start: Option<(i32, i32)>, current: (i32, i32), selected: Option<RECT>,
    done: bool, activated: bool, hint: Vec<u16>,
}
impl Selection {
    unsafe fn cursor(&self) -> (i32, i32) {
        let mut point = POINT::default();
        if GetCursorPos(&mut point).is_err() { return self.current; }
        ((point.x - self.x).clamp(0, self.width), (point.y - self.y).clamp(0, self.height))
    }
    fn rect(&self) -> Option<RECT> {
        let start = self.start?;
        let [left, top, right, bottom] = super::selection_rect(start, self.current, self.width, self.height)?;
        Some(RECT { left, top, right, bottom })
    }
}

unsafe extern "system" fn window_proc(hwnd: HWND, message: u32, wparam: WPARAM, lparam: LPARAM) -> LRESULT {
    if message == WM_NCCREATE {
        let create = &*(lparam.0 as *const CREATESTRUCTW);
        SetWindowLongPtrW(hwnd, GWLP_USERDATA, create.lpCreateParams as isize);
    }
    let pointer = GetWindowLongPtrW(hwnd, GWLP_USERDATA) as *mut Selection;
    if pointer.is_null() { return DefWindowProcW(hwnd, message, wparam, lparam); }
    let state = &mut *pointer;
    match message {
        WM_PAINT => {
            let mut paint = PAINTSTRUCT::default();
            let dc = BeginPaint(hwnd, &mut paint);
            let _ = BitBlt(dc, 0, 0, state.width, state.height, Some(state.dimmed.dc), 0, 0, SRCCOPY);
            if let Some(rect) = state.rect() {
                let _ = BitBlt(dc, rect.left, rect.top, rect.right - rect.left, rect.bottom - rect.top,
                    Some(state.original.dc), rect.left, rect.top, SRCCOPY);
                FrameRect(dc, &rect, HBRUSH(GetStockObject(WHITE_BRUSH).0));
            }
            // Primary monitor origin is (0,0), even when the virtual origin is negative.
            let mut label = RECT { left: 24 - state.x, top: 24 - state.y, right: 640 - state.x, bottom: 64 - state.y };
            let font = SelectObject(dc, GetStockObject(DEFAULT_GUI_FONT));
            SetBkColor(dc, windows::Win32::Foundation::COLORREF(0x202020));
            SetTextColor(dc, windows::Win32::Foundation::COLORREF(0xffffff));
            DrawTextW(dc, &mut state.hint, &mut label, DT_LEFT | DT_SINGLELINE | DT_NOPREFIX);
            SelectObject(dc, font);
            let _ = EndPaint(hwnd, &paint);
            return LRESULT(0);
        }
        WM_ERASEBKGND => return LRESULT(1),
        WM_LBUTTONDOWN => {
            state.current = state.cursor(); state.start = Some(state.current); SetCapture(hwnd);
        }
        WM_MOUSEMOVE if state.start.is_some() => {
            state.current = state.cursor(); let _ = InvalidateRect(Some(hwnd), None, false);
        }
        WM_LBUTTONUP if state.start.is_some() => {
            state.current = state.cursor(); state.selected = state.rect(); state.done = true;
            let _ = ReleaseCapture();
        }
        WM_KEYDOWN if wparam.0 == 0x1b => state.done = true,
        WM_RBUTTONDOWN | WM_CLOSE | WM_TIMER | WM_DISPLAYCHANGE | WM_DPICHANGED => state.done = true,
        WM_ACTIVATE => {
            if wparam.0 & 0xffff == WA_INACTIVE as usize { if state.activated { state.done = true; } }
            else { state.activated = true; }
        }
        WM_CAPTURECHANGED if state.start.is_some() && !state.done => state.done = true,
        _ => {}
    }
    DefWindowProcW(hwnd, message, wparam, lparam)
}

pub fn capture(english: bool) -> Result<Option<Vec<u8>>, String> {
    // The selector owns a separate message loop. No GDI handle crosses threads.
    unsafe {
        let previous_dpi = SetThreadDpiAwarenessContext(DPI_AWARENESS_CONTEXT_PER_MONITOR_AWARE_V2);
        if previous_dpi.0.is_null() { return Err(FAILED.into()); }
        let _dpi = Dpi(previous_dpi);
        let x = GetSystemMetrics(SM_XVIRTUALSCREEN); let y = GetSystemMetrics(SM_YVIRTUALSCREEN);
        let width = GetSystemMetrics(SM_CXVIRTUALSCREEN); let height = GetSystemMetrics(SM_CYVIRTUALSCREEN);
        if width <= 0 || height <= 0 || width as u64 * height as u64 > super::MAX_PIXELS { return Err("screenshot_too_large".into()); }
        let screen = Screen(GetDC(None));
        if screen.0.is_invalid() { return Err(FAILED.into()); }
        let original = Bitmap::new(screen.0, width, height)?;
        BitBlt(original.dc, 0, 0, width, height, Some(screen.0), x, y, SRCCOPY | CAPTUREBLT).map_err(|_| FAILED)?;
        let _ = GdiFlush();
        let dimmed = Bitmap::new(screen.0, width, height)?;
        let source = std::slice::from_raw_parts(original.pixels, original.len);
        let dest = std::slice::from_raw_parts_mut(dimmed.pixels, dimmed.len);
        for (target, pixel) in dest.chunks_exact_mut(4).zip(source.chunks_exact(4)) {
            for i in 0..3 { target[i] = pixel[i] / 2; } target[3] = 255;
        }
        let hint = if english { "Drag to capture  ·  Esc to cancel" } else { "拖动框选截屏  ·  Esc 取消" }.encode_utf16().collect();
        let mut state = Box::new(Selection { original, dimmed, x, y, width, height, hint,
            start: None, current: (0, 0), selected: None, done: false, activated: false });
        let class = Class {
            name: format!("TaroBotCapture{}\0", uuid::Uuid::new_v4().simple()).encode_utf16().collect(),
            instance: GetModuleHandleW(None).map_err(|_| FAILED)?.into(),
        };
        let definition = WNDCLASSW { lpfnWndProc: Some(window_proc), hInstance: class.instance,
            lpszClassName: PCWSTR(class.name.as_ptr()), hCursor: LoadCursorW(None, IDC_CROSS).map_err(|_| FAILED)?, ..Default::default() };
        if RegisterClassW(&definition) == 0 { return Err(FAILED.into()); }
        let overlay = Overlay(CreateWindowExW(WS_EX_TOPMOST | WS_EX_TOOLWINDOW, PCWSTR(class.name.as_ptr()), w!("TaroBot Screenshot"),
            WS_POPUP, x, y, width, height, None, None, Some(class.instance), Some((&mut *state as *mut Selection).cast())).map_err(|_| FAILED)?);
        if SetTimer(Some(overlay.0), 1, 120_000, None) == 0 { return Err(FAILED.into()); }
        let _ = ShowWindow(overlay.0, SW_SHOW);
        let _ = SetForegroundWindow(overlay.0);
        if GetForegroundWindow() != overlay.0 { return Err(FAILED.into()); }
        let _ = UpdateWindow(overlay.0);
        let mut message = MSG::default();
        while !state.done {
            let result = GetMessageW(&mut message, None, 0, 0).0;
            if result == -1 { return Err(FAILED.into()); }
            if result == 0 { return Ok(None); }
            let _ = TranslateMessage(&message); DispatchMessageW(&message);
        }
        let _ = ReleaseCapture();
        let _ = KillTimer(Some(overlay.0), 1);
        drop(overlay);
        let Some(rect) = state.selected else { return Ok(None); };
        let output_width = (rect.right - rect.left) as usize;
        let output_height = (rect.bottom - rect.top) as usize;
        let mut rgb = Vec::with_capacity(output_width * output_height * 3);
        let pixels = std::slice::from_raw_parts(state.original.pixels, state.original.len);
        for row in rect.top..rect.bottom {
            let offset = (row as usize * width as usize + rect.left as usize) * 4;
            for pixel in pixels[offset..offset + output_width * 4].chunks_exact(4) { rgb.extend_from_slice(&[pixel[2], pixel[1], pixel[0]]); }
        }
        let mut bytes = Vec::new();
        {
            let mut encoder = png::Encoder::new(&mut bytes, output_width as u32, output_height as u32);
            encoder.set_color(png::ColorType::Rgb); encoder.set_depth(png::BitDepth::Eight);
            let mut writer = encoder.write_header().map_err(|_| FAILED)?;
            writer.write_image_data(&rgb).map_err(|_| FAILED)?;
            writer.finish().map_err(|_| FAILED)?;
        }
        Ok(Some(bytes))
    }
}
