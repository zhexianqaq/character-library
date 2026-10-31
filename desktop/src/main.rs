#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

//! 资料库桌面壳（Windows / WebView2）。
//!
//! 只做三件事：把本机 Node 服务拉起来、用 WebView2 打开 `http://127.0.0.1:<port>`、
//! 让 F5 / Ctrl+R 刷新页面。页面本身还是 `web/` 里那一套，一行 HTML 都不改。
//!
//! 之所以要有壳：浏览器拖拽只给字节、不给路径（File 对象没有 path），
//! 壳能拿到真实路径，后续「拖进来就解压入库、把源包删掉」才有得做。

use std::cell::RefCell;
use std::env;
use std::fs;
use std::io::{Read, Write};
use std::net::{SocketAddr, TcpStream};
use std::path::{Path, PathBuf};
use std::process::{Child, Command, Stdio};
use std::rc::Rc;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};

use tao::dpi::{LogicalSize, PhysicalPosition, PhysicalSize};
use tao::event::{Event, WindowEvent};
use tao::event_loop::{ControlFlow, EventLoopBuilder};
use tao::window::WindowBuilder;

#[cfg(windows)]
use std::os::windows::process::CommandExt;

#[cfg(windows)]
const CREATE_NO_WINDOW: u32 = 0x0800_0000;
const DEFAULT_PORT: u16 = 7788;

/// 注入到每个页面的脚本：浏览器快捷键在 WebView2 里默认不生效，这里自己接一份。
/// 只用捕获阶段拦 F5 / Ctrl+R，不碰 app 自己的键盘逻辑（它监听的是冒泡阶段）。
const SHELL_JS: &str = r#"
(function () {
  if (window.__amsShell) return;
  window.__amsShell = true;
  document.documentElement.setAttribute('data-ams-shell', '1');
  window.addEventListener('keydown', function (e) {
    var isReload = e.key === 'F5' || ((e.ctrlKey || e.metaKey) && !e.altKey && (e.key === 'r' || e.key === 'R'));
    if (!isReload) return;
    e.preventDefault();
    e.stopPropagation();
    location.reload();
  }, true);
  window.addEventListener('load', function () {
    setTimeout(function () {
      try {
        if (window.ipc && window.ipc.postMessage) {
          window.ipc.postMessage(JSON.stringify({
            t: 'ready',
            title: document.title,
            path: location.pathname,
            pages: document.querySelectorAll('.page').length,
            tiles: document.querySelectorAll('.tile').length,
            cards: document.querySelectorAll('.pack-card').length
          }));
        }
      } catch (err) {}
    }, 700);
  });
})();
"#;

/// 单实例判定：命名互斥量 + 把已有窗口叫到前台。
///
/// 不用 `windows-sys` 之类的 crate，只声明这三个函数——加依赖会让 release 构建
/// 变慢，也会把 `Cargo.lock` 撑大，而这里需要的功能就这么点。
#[cfg(windows)]
mod win32 {
    use std::ffi::c_void;
    use std::os::windows::ffi::OsStrExt;
    use std::ptr;
    use std::time::Duration;

    const ERROR_ALREADY_EXISTS: i32 = 183;
    const SW_RESTORE: i32 = 9;

    #[link(name = "kernel32")]
    unsafe extern "system" {
        fn CreateMutexW(attrs: *const c_void, owner: i32, name: *const u16) -> *mut c_void;
    }

    #[link(name = "user32")]
    unsafe extern "system" {
        fn FindWindowW(class: *const u16, title: *const u16) -> *mut c_void;
        fn ShowWindow(hwnd: *mut c_void, cmd: i32) -> i32;
        fn IsIconic(hwnd: *mut c_void) -> i32;
        fn BringWindowToTop(hwnd: *mut c_void) -> i32;
        fn SetForegroundWindow(hwnd: *mut c_void) -> i32;
        fn SendMessageW(hwnd: *mut c_void, msg: u32, wparam: usize, lparam: isize) -> isize;
        fn CreateIconFromResourceEx(
            bits: *const u8,
            size: u32,
            is_icon: i32,
            ver: u32,
            cx: i32,
            cy: i32,
            flags: u32,
        ) -> *mut c_void;
    }

    /// `with_window_icon` 只落到 ICON_SMALL（标题栏对），实测 WM_GETICON 的
    /// ICON_BIG 仍是 0 —— 任务栏分组和 Alt+Tab 会退回去显示默认图标。
    ///
    /// 两个槽分别给最合适的原生尺寸：BIG 用 256、SMALL 用 32（200% 缩放下标题栏
    /// 正好 32）。给同一张 256 会让标题栏自己去缩，边缘反而不如原生 32 锐。
    fn set_one_icon(hwnd: *mut c_void, ico: &[u8], want: u32, slot: usize) {
        let Some((_, _, dib)) = super::ico_pick(ico, want) else {
            return;
        };
        if dib.is_empty() {
            return;
        }
        unsafe {
            let hicon = CreateIconFromResourceEx(
                dib.as_ptr(),
                dib.len() as u32,
                1, // fIcon
                0x0003_0000,
                0,
                0,
                0,
            );
            if hicon.is_null() {
                return;
            }
            const WM_SETICON: u32 = 0x0080;
            SendMessageW(hwnd, WM_SETICON, slot, hicon as isize);
        }
    }

    pub fn apply_icons(hwnd: isize, ico: &[u8]) {
        if hwnd == 0 {
            return;
        }
        let h = hwnd as *mut c_void;
        set_one_icon(h, ico, 256, 1); // ICON_BIG：Alt+Tab、任务栏大图标
        set_one_icon(h, ico, 32, 0); // ICON_SMALL：标题栏
    }

    fn wide(s: &str) -> Vec<u16> {
        std::ffi::OsStr::new(s)
            .encode_wide()
            .chain(std::iter::once(0))
            .collect()
    }

    /// `None` = 已经有实例在跑；`Some(handle)` = 我们是第一个。
    /// handle 故意不关闭：进程退出时内核自动释放，这正是互斥量的生命周期。
    pub fn acquire_mutex() -> Option<*mut c_void> {
        let name = wide(r"Local\ams-character-library-shell");
        let h = unsafe { CreateMutexW(ptr::null(), 0, name.as_ptr()) };
        if h.is_null() {
            // 建不出来（极少见）就别拦着用户启动
            return Some(ptr::null_mut());
        }
        // 必须在 CreateMutexW 之后立刻取，中间不能插别的 API 调用
        let exists = std::io::Error::last_os_error().raw_os_error() == Some(ERROR_ALREADY_EXISTS);
        if exists { None } else { Some(h) }
    }

    /// 找标题为 `title` 的窗口并激活。旧实例可能还在启动（窗口尚未创建），
    /// 所以在 1.5 秒内重试，避免「双击两次出两个窗口」的竞态。
    pub fn activate_window(title: &str) -> bool {
        let t = wide(title);
        for _ in 0..15 {
            let h = unsafe { FindWindowW(ptr::null(), t.as_ptr()) };
            if !h.is_null() {
                unsafe {
                    if IsIconic(h) != 0 {
                        ShowWindow(h, SW_RESTORE);
                    }
                    BringWindowToTop(h);
                    SetForegroundWindow(h);
                }
                return true;
            }
            std::thread::sleep(Duration::from_millis(100));
        }
        false
    }
}

#[cfg(windows)]
static SESSION_PROXY: Mutex<Option<tao::event_loop::EventLoopProxy<UserEvent>>> = Mutex::new(None);
#[cfg(windows)]
static PREV_WNDPROC: std::sync::atomic::AtomicIsize = std::sync::atomic::AtomicIsize::new(0);

/// 关机 / 注销时 Windows 会发 WM_QUERYENDSESSION。挂上关机阻塞原因，
/// 并通知事件循环走和点关闭一样的排空流程，而不是把进程立刻拆掉。
#[cfg(windows)]
fn install_session_hook(hwnd: isize) {
    use std::ffi::c_void;
    unsafe extern "system" {
        fn CallWindowProcW(
            prev: *mut c_void,
            hwnd: *mut c_void,
            msg: u32,
            wparam: usize,
            lparam: isize,
        ) -> isize;
        fn SetWindowLongPtrW(hwnd: *mut c_void, index: i32, new: isize) -> isize;
        fn ShutdownBlockReasonCreate(hwnd: *mut c_void, reason: *const u16) -> i32;
    }
    const GWLP_WNDPROC: i32 = -4;
    const WM_QUERYENDSESSION: u32 = 0x0011;

    unsafe extern "system" fn proc(hwnd: *mut c_void, msg: u32, wparam: usize, lparam: isize) -> isize {
        unsafe {
            if msg == WM_QUERYENDSESSION {
                let reason: Vec<u16> = "资料库正在完成未结束的操作，请稍候"
                    .encode_utf16()
                    .chain(std::iter::once(0))
                    .collect();
                let _ = ShutdownBlockReasonCreate(hwnd, reason.as_ptr());
                if let Ok(guard) = SESSION_PROXY.lock() {
                    if let Some(proxy) = guard.as_ref() {
                        let _ = proxy.send_event(UserEvent::SessionEnd);
                    }
                }
            }
            let prev = PREV_WNDPROC.load(std::sync::atomic::Ordering::SeqCst);
            if prev != 0 {
                CallWindowProcW(prev as *mut c_void, hwnd, msg, wparam, lparam)
            } else {
                1
            }
        }
    }

    unsafe {
        let prev = SetWindowLongPtrW(hwnd as *mut c_void, GWLP_WNDPROC, proc as *const () as isize);
        PREV_WNDPROC.store(prev, std::sync::atomic::Ordering::SeqCst);
    }
}

fn stamp() -> String {
    let now = SystemTime::now().duration_since(UNIX_EPOCH).unwrap_or_default();
    format!("{}.{:03}", now.as_secs(), now.subsec_millis())
}

fn log_dir() -> PathBuf {
    let base = env::var("LOCALAPPDATA")
        .map(PathBuf::from)
        .unwrap_or_else(|_| env::temp_dir());
    let dir = base.join("ams-desktop");
    let _ = fs::create_dir_all(&dir);
    dir
}

fn log(msg: &str) {
    let line = format!("[{}] {}\n", stamp(), msg);
    if let Ok(mut f) = fs::OpenOptions::new()
        .create(true)
        .append(true)
        .open(log_dir().join("shell.log"))
    {
        let _ = f.write_all(line.as_bytes());
    }
}

/// shell.log 只在启动时轮转一次：超过 2 MB 就改名 .1，只留一代。
/// 壳每次运行都往里 append，一次几十行，但不轮转就是永久增长 ——
/// 一年下来翻旧记录要滚半天。
fn rotate_log() {
    let dir = log_dir();
    let path = dir.join("shell.log");
    let Ok(meta) = fs::metadata(&path) else {
        return;
    };
    if meta.len() <= 2 * 1024 * 1024 {
        return;
    }
    let old = dir.join("shell.log.1");
    // Windows 上 rename 到已存在的文件会失败，先删旧的
    let _ = fs::remove_file(&old);
    let _ = fs::rename(&path, &old);
}

/// 窗口几何。`x` / `y` 是外框左上角，`w` / `h` 是客户区内尺寸，单位都是物理像素
/// （tao 的 `outer_position` / `inner_size` 原生就是这样，存成逻辑像素反而要反推 DPI）。
/// `x = -1` 表示「没有记录过位置」，交给系统决定（通常居中）。
#[derive(Clone, Copy)]
struct WindowState {
    x: i32,
    y: i32,
    w: u32,
    h: u32,
    maximized: bool,
}

/// 尺寸上限：比屏幕窄 80、矮 140（标题栏 + 任务栏），保证窗口四边都够得着。
/// 多屏取最大的那块算上限 —— 小屏上开大窗口是用户自己的选择，
/// 这里只拦「比屏幕还大」这一种情况。
fn size_cap(monitors: &[tao::monitor::MonitorHandle]) -> (u32, u32) {
    let w = monitors.iter().map(|m| m.size().width).max().unwrap_or(1920);
    let h = monitors.iter().map(|m| m.size().height).max().unwrap_or(1080);
    (w.saturating_sub(80).max(600), h.saturating_sub(140).max(400))
}

fn state_path() -> PathBuf {
    log_dir().join("window.json")
}

/// 只认整数，够用且不用把 serde 拖进 release 构建。
fn json_int(raw: &str, key: &str) -> Option<i64> {
    let k = format!("\"{key}\"");
    let mut rest = &raw[raw.find(&k)? + k.len()..];
    // 跳过 key 与值之间的 `:` 和空白
    rest = &rest[rest.find(|c: char| c == '-' || c.is_ascii_digit())?..];
    let end = rest
        .find(|c: char| !(c == '-' || c.is_ascii_digit()))
        .unwrap_or(rest.len());
    rest[..end].parse().ok()
}

fn json_bool(raw: &str, key: &str) -> Option<bool> {
    let k = format!("\"{key}\"");
    let rest = &raw[raw.find(&k)? + k.len()..];
    let rest = &rest[rest.find(|c: char| c == 't' || c == 'f')?..];
    Some(rest.starts_with('t'))
}

fn load_state() -> Option<WindowState> {
    let raw = fs::read_to_string(state_path()).ok()?;
    Some(WindowState {
        x: json_int(&raw, "x")? as i32,
        y: json_int(&raw, "y")? as i32,
        // 下限挡住手改坏的值；上限挡住「记住了一个 50000 宽的窗口」
        w: json_int(&raw, "w")?.clamp(400, 20000) as u32,
        h: json_int(&raw, "h")?.clamp(300, 20000) as u32,
        maximized: json_bool(&raw, "max").unwrap_or(false),
    })
}

fn save_state(s: WindowState) {
    let body = format!(
        "{{\"x\":{},\"y\":{},\"w\":{},\"h\":{},\"max\":{}}}\n",
        s.x,
        s.y,
        s.w,
        s.h,
        if s.maximized { "true" } else { "false" }
    );
    let _ = fs::write(state_path(), body);
}

/// 记忆的矩形还落在某块屏幕上吗？拔掉外接显示器 / 改分辨率后，
/// 上次记的坐标可能整块跑到可见区域之外，窗口就成了「点开看不到」。
/// 判定用交集：残留宽度 ≥120、高度 ≥60，保证标题栏抓得住。
fn state_visible(s: &WindowState, monitors: &[tao::monitor::MonitorHandle]) -> bool {
    let (x0, y0) = (s.x, s.y);
    let (x1, y1) = (s.x + s.w as i32, s.y + s.h as i32);
    for m in monitors {
        let mp = m.position();
        let ms = m.size();
        let ix = x1.min(mp.x + ms.width as i32) - x0.max(mp.x);
        let iy = y1.min(mp.y + ms.height as i32) - y0.max(mp.y);
        if ix >= 120 && iy >= 60 {
            return true;
        }
    }
    false
}

/// 工程根目录：从 exe 往上找带 `server/src/index.js` 的那一层。
fn find_app_dir() -> Option<PathBuf> {
    if let Ok(raw) = env::var("AMS_APP_DIR") {
        let p = PathBuf::from(raw);
        if p.join("server").join("src").join("index.js").exists() {
            return Some(p);
        }
    }
    let exe = env::current_exe().ok()?;
    let mut dir = exe.parent()?.to_path_buf();
    for _ in 0..5 {
        if dir.join("server").join("src").join("index.js").exists() {
            return Some(dir);
        }
        if !dir.pop() {
            break;
        }
    }
    None
}

/// 找 node.exe：环境变量 → PATH → 常见安装位置 → WorkBuddy 内置（版本目录排序取最新）。
fn find_node() -> Option<PathBuf> {
    if let Ok(raw) = env::var("AMS_NODE") {
        let p = PathBuf::from(raw);
        if p.exists() {
            return Some(p);
        }
    }
    if let Some(paths) = env::var_os("PATH") {
        for dir in env::split_paths(&paths) {
            let p = dir.join("node.exe");
            if p.exists() {
                return Some(p);
            }
        }
    }
    for fixed in [
        r"C:\Program Files\nodejs\node.exe",
        r"C:\Program Files (x86)\nodejs\node.exe",
    ] {
        let p = PathBuf::from(fixed);
        if p.exists() {
            return Some(p);
        }
    }
    if let Ok(local) = env::var("LOCALAPPDATA") {
        let p = Path::new(&local).join(r"Programs\nodejs\node.exe");
        if p.exists() {
            return Some(p);
        }
    }
    if let Ok(home) = env::var("USERPROFILE") {
        let base = Path::new(&home).join(r".workbuddy\binaries\node\versions");
        if let Ok(rd) = fs::read_dir(&base) {
            let mut dirs: Vec<PathBuf> = rd
                .flatten()
                .map(|e| e.path())
                .filter(|p| p.is_dir())
                .collect();
            dirs.sort();
            for dir in dirs.into_iter().rev() {
                let p = dir.join("node.exe");
                if p.exists() {
                    return Some(p);
                }
            }
        }
    }
    None
}

fn port_open(port: u16) -> bool {
    let addr: SocketAddr = ([127, 0, 0, 1], port).into();
    TcpStream::connect_timeout(&addr, Duration::from_millis(250)).is_ok()
}

/// 读完一个 HTTP/1.1 响应的正文。只用于本机的 shutdown 接口，上限 256KB。
fn read_http_body(stream: &mut TcpStream) -> Option<String> {
    let _ = stream.set_read_timeout(Some(Duration::from_secs(3)));
    let mut buf = Vec::new();
    let mut tmp = [0u8; 4096];
    let header_end = loop {
        if buf.len() > 256 * 1024 {
            return None;
        }
        match stream.read(&mut tmp) {
            Ok(0) => break buf.len(),
            Ok(n) => {
                buf.extend_from_slice(&tmp[..n]);
                if let Some(i) = buf.windows(4).position(|w| w == b"\r\n\r\n") {
                    break i + 4;
                }
            }
            Err(e) if e.kind() == std::io::ErrorKind::WouldBlock || e.kind() == std::io::ErrorKind::TimedOut => {
                break buf.len();
            }
            Err(_) => return None,
        }
    };
    if header_end == 0 || buf.len() < 12 {
        return None;
    }
    let head = String::from_utf8_lossy(&buf[..header_end.min(buf.len())]);
    if !(head.starts_with("HTTP/1.1 200") || head.starts_with("HTTP/1.0 200")) {
        return None;
    }
    let mut content_length = 0usize;
    for line in head.split("\r\n") {
        let lower = line.to_ascii_lowercase();
        if let Some(rest) = lower.strip_prefix("content-length:") {
            content_length = rest.trim().parse().unwrap_or(0);
        }
    }
    let mut body = buf[header_end.min(buf.len())..].to_vec();
    while body.len() < content_length && body.len() < 256 * 1024 {
        match stream.read(&mut tmp) {
            Ok(0) => break,
            Ok(n) => body.extend_from_slice(&tmp[..n]),
            Err(_) => break,
        }
    }
    Some(String::from_utf8_lossy(&body).into_owned())
}

fn http_call(port: u16, method: &str, path: &str) -> Option<String> {
    let addr: SocketAddr = ([127, 0, 0, 1], port).into();
    let mut stream = TcpStream::connect_timeout(&addr, Duration::from_millis(400)).ok()?;
    let _ = stream.set_write_timeout(Some(Duration::from_millis(800)));
    let req = format!(
        "{method} {path} HTTP/1.1\r\nHost: 127.0.0.1:{port}\r\nContent-Length: 0\r\nConnection: close\r\n\r\n"
    );
    stream.write_all(req.as_bytes()).ok()?;
    read_http_body(&mut stream)
}

/// 没有进行中的操作时，响应里的 pending 是空数组。解析失败就当成「还不知道」。
fn pending_is_empty(body: &str) -> bool {
    body.contains("\"pending\":[]") || body.contains("\"pending\": []")
}

/// 轮询等子进程自己退出。后端收到 shutdown 后 120ms 就开始 checkpoint，
/// 通常两百毫秒内就没了 —— 比固定 sleep(900) 快，还不会白等。
/// 超时未退返回 false，调用方再动手 kill。
fn wait_exit(child: &mut Child, max: Duration) -> bool {
    let deadline = Instant::now() + max;
    loop {
        match child.try_wait() {
            Ok(Some(_)) => return true,
            Ok(None) => {}
            Err(_) => return false,
        }
        if Instant::now() >= deadline {
            return false;
        }
        std::thread::sleep(Duration::from_millis(20));
    }
}

/// 光看 TCP 连得上不够：刚杀掉的进程会留下一堆 TIME_WAIT，connect 照样能成功，
/// 结果壳以为「服务在跑」，打开却是一张错误页。这里发一个真请求，拿到 200 才算数。
fn service_ready(port: u16) -> bool {
    let addr: SocketAddr = ([127, 0, 0, 1], port).into();
    let mut stream = match TcpStream::connect_timeout(&addr, Duration::from_millis(400)) {
        Ok(s) => s,
        Err(_) => return false,
    };
    let _ = stream.set_read_timeout(Some(Duration::from_millis(1200)));
    let _ = stream.set_write_timeout(Some(Duration::from_millis(1200)));
    let req = format!(
        "GET /api/overview HTTP/1.1\r\nHost: 127.0.0.1:{port}\r\nConnection: close\r\n\r\n"
    );
    if stream.write_all(req.as_bytes()).is_err() {
        return false;
    }
    let mut buf = [0u8; 256];
    match stream.read(&mut buf) {
        Ok(n) if n > 0 => {
            let head = String::from_utf8_lossy(&buf[..n]);
            head.starts_with("HTTP/1.1 200") || head.starts_with("HTTP/1.0 200")
        }
        _ => false,
    }
}

fn start_server(app: &Path, node: &Path, port: u16) -> std::io::Result<Child> {
    let out = fs::File::create(log_dir().join("server.log"))?;
    let err = out.try_clone()?;
    let mut cmd = Command::new(node);
    cmd.arg(app.join("server").join("src").join("index.js"))
        .current_dir(app.join("server"))
        .env("PORT", port.to_string())
        .stdin(Stdio::null())
        .stdout(Stdio::from(out))
        .stderr(Stdio::from(err));
    #[cfg(windows)]
    cmd.creation_flags(CREATE_NO_WINDOW);
    cmd.spawn()
}

fn error_page(title: &str, detail: &str, port: u16) -> String {
    format!(
        r#"<!doctype html><html lang="zh-CN"><head><meta charset="utf-8"><title>{title}</title>
<style>
html,body{{height:100%;margin:0}}
body{{display:grid;place-items:center;background:#f5f5f5;color:#2c2c2a;
font:14px/1.7 "Microsoft YaHei UI","Microsoft YaHei",system-ui,sans-serif}}
.card{{width:min(560px,86vw);padding:28px 30px;background:#fff;border-radius:16px;
box-shadow:0 12px 32px rgba(0,0,0,.08)}}
h1{{margin:0 0 10px;font-size:16px;font-weight:600}}
p{{margin:6px 0;color:#5f5e5a;font-size:13px}}
code{{font-family:Consolas,monospace;background:#f2f2f2;padding:1px 5px;border-radius:4px;font-size:12px}}
pre{{margin:12px 0 0;padding:10px 12px;background:#f7f7f5;border-radius:8px;
font-size:12px;color:#5f5e5a;white-space:pre-wrap;word-break:break-all}}
button{{margin-top:16px;padding:7px 16px;border:0;border-radius:9px;background:#1d1d1b;
color:#fff;font-size:13px;cursor:pointer}}
</style></head><body><div class="card"><h1>{title}</h1><p>{detail}</p>
<pre>也可以先双击 start.bat 启动服务，再打开本程序（会自动连上已经在跑的那个）。</pre>
<button onclick="location.href='http://127.0.0.1:{port}/'">重试</button>
</div></body></html>"#
    )
}

/// 服务没起来之前先给一张骨架页。以前是白屏硬等最多 30 秒，
/// 用户分不清「在加载」和「卡死了」。
const SKELETON_PAGE: &str = r#"<!doctype html><html lang="zh-CN"><head><meta charset="utf-8">
<title>资料库</title><style>
html,body{height:100%;margin:0}
body{display:grid;place-items:center;background:#f5f5f5;color:#2c2c2a;
font:14px/1.7 "Microsoft YaHei UI","Microsoft YaHei",system-ui,sans-serif}
.box{display:flex;flex-direction:column;align-items:center;gap:16px}
.ring{width:32px;height:32px;border-radius:50%;border:3px solid #e6e4df;
border-top-color:#1d1d1b;animation:spin .85s linear infinite}
@keyframes spin{to{transform:rotate(360deg)}}
h1{margin:0;font-size:15px;font-weight:600}
p{margin:0;color:#8a8880;font-size:12.5px}
.dot::after{content:'';animation:dots 1.2s steps(1,end) infinite}
@keyframes dots{0%{content:''}25%{content:'.'}50%{content:'..'}75%{content:'...'}}
</style></head><body><div class="box">
<div class="ring"></div><h1>正在启动本地服务</h1>
<p>首次启动要等几秒<span class="dot"></span></p></div></body></html>"#;

/// 没有界面可交互时的收尾（启动线程和关窗抢在一起）。
/// 先请服务排空并 checkpoint，安全超时很长，避免 2.5 秒就把 WAL 掐断。
fn stop_server(child: &mut Child, port: u16) {
    let started = Instant::now();
    let graceful = http_call(port, "POST", "/api/shutdown").is_some();
    let limit = if graceful {
        Duration::from_secs(20 * 60)
    } else {
        Duration::from_millis(300)
    };
    if !wait_exit(child, limit) {
        log("stop_server safety timeout, killing");
        let _ = child.kill();
        let _ = child.wait();
    }
    log(&format!(
        "server stopped: {} in {}ms",
        if graceful { "graceful" } else { "forced" },
        started.elapsed().as_millis()
    ));
}

fn js_quote(s: &str) -> String {
    let mut out = String::from('"');
    for c in s.chars() {
        match c {
            '\\' => out.push_str("\\\\"),
            '"' => out.push_str("\\\""),
            '\n' => out.push_str("\\n"),
            '\r' => out.push_str("\\r"),
            '<' => out.push_str("\\u003c"),
            c if (c as u32) < 0x20 => out.push_str(&format!("\\u{:04x}", c as u32)),
            c => out.push(c),
        }
    }
    out.push('"');
    out
}

fn drain_page(initial_json: &str) -> String {
    format!(
        r#"<!doctype html><html lang="zh-CN"><head><meta charset="utf-8"><title>请稍候</title>
<style>
html,body{{height:100%;margin:0}}
body{{display:grid;place-items:center;background:#f5f5f5;color:#2c2c2a;
font:14px/1.7 "Microsoft YaHei UI","Microsoft YaHei",system-ui,sans-serif}}
.card{{width:min(480px,88vw);padding:28px 30px;background:#fff;border-radius:16px}}
h1{{margin:0 0 8px;font-size:16px;font-weight:600}}
p{{margin:0 0 12px;color:#5f5e5a;font-size:13px}}
ul{{margin:0;padding:0;list-style:none;max-height:240px;overflow:auto}}
li{{padding:8px 0;border-top:1px solid rgba(0,0,0,.06);font-size:13px}}
li b{{display:block;font-weight:600}}
li span{{color:#8a8880;font-size:12px}}
button{{margin-top:16px;padding:7px 16px;border:0;border-radius:9px;background:#fff;
color:#9a3b32;font-size:13px;cursor:pointer;box-shadow:inset 0 0 0 1px rgba(154,59,50,.45)}}
.warn{{margin-top:8px;color:#9a3b32;font-size:12px}}
</style></head><body><div class="card">
<h1>正在完成未结束的操作，请稍候…</h1>
<p>窗口会在这些操作写完、数据落盘之后自己关闭。</p>
<ul id="list"></ul>
<button id="force" type="button">强制退出</button>
<p class="warn">强制退出会立刻结束程序，尚未写入磁盘的导入、移动或缩略图记录可能会丢失。</p>
</div>
<script>
function esc(s){{return String(s||'').replace(/[&<>]/g,function(c){{return {{'&':'&amp;','<':'&lt;','>':'&gt;'}}[c];}});}}
function ago(iso){{
  var t = Date.parse(iso);
  if (!t) return '';
  var s = Math.max(0, Math.round((Date.now()-t)/1000));
  return s < 1 ? '刚开始' : '已进行 ' + s + ' 秒';
}}
window.__shutdownUpdate = function(snap){{
  var list = document.getElementById('list');
  var jobs = (snap && snap.pending) || [];
  if (!jobs.length){{
    var msg = snap && snap.checkpointing ? '正在把数据写入磁盘…' : '正在收尾…';
    list.innerHTML = '<li><b>'+msg+'</b></li>';
    return;
  }}
  list.innerHTML = jobs.map(function(j){{
    return '<li><b>'+esc(j.label)+'</b><span>'+esc(ago(j.startedAt))+'</span></li>';
  }}).join('');
}};
window.__shutdownUpdate(JSON.parse({initial}));
document.getElementById('force').onclick = function(){{
  if (!window.confirm('确定要强制退出吗？未完成的操作可能丢失数据。')) return;
  try {{
    if (window.ipc && window.ipc.postMessage) window.ipc.postMessage(JSON.stringify({{t:'force-exit'}}));
  }} catch (e) {{}}
}};
</script></body></html>"#,
        initial = js_quote(initial_json)
    )
}

/// 把 node 子进程交给后台线程去排空。没有子进程（连的是别人起的服务）时返回 true，调用方直接退出壳。
fn start_shell_drain(
    child_slot: &Arc<Mutex<Option<Child>>>,
    closing: &Arc<AtomicBool>,
    awaiting: bool,
    port: u16,
    force: Arc<AtomicBool>,
    proxy: tao::event_loop::EventLoopProxy<UserEvent>,
) -> bool {
    closing.store(true, Ordering::SeqCst);
    let mut taken = child_slot.lock().ok().and_then(|mut g| g.take());
    // 启动线程可能还没把 child 交出来。主线程一旦 Exit，node 会变成孤儿。
    if taken.is_none() && awaiting {
        let deadline = Instant::now() + Duration::from_secs(5);
        while taken.is_none() && Instant::now() < deadline {
            std::thread::sleep(Duration::from_millis(40));
            taken = child_slot.lock().ok().and_then(|mut g| g.take());
        }
        log(&format!(
            "waited for child handoff: {}",
            if taken.is_some() { "ok" } else { "none" }
        ));
    }
    if let Some(child) = taken {
        std::thread::spawn(move || drain_server(child, port, force, proxy));
        false
    } else {
        true
    }
}

/// 关窗口后的后台收尾。有进行中的操作就让界面列出它们；没有就尽快退出。
/// 安全超时 20 分钟，到点才 kill。强制退出由界面上的按钮把 `force` 置上。
fn drain_server(
    mut child: Child,
    port: u16,
    force: Arc<AtomicBool>,
    proxy: tao::event_loop::EventLoopProxy<UserEvent>,
) {
    let started = Instant::now();
    let safety = Duration::from_secs(20 * 60);
    let first = http_call(port, "POST", "/api/shutdown");
    let idle = first.as_deref().map(pending_is_empty).unwrap_or(false);
    log(&format!(
        "drain start: idle={idle} body={}",
        first.as_deref().unwrap_or("").chars().take(180).collect::<String>()
    ));
    if idle {
        let _ = proxy.send_event(UserEvent::QuietDrain);
        if wait_exit(&mut child, Duration::from_secs(3)) {
            log(&format!("drain quiet exit in {}ms", started.elapsed().as_millis()));
            let _ = proxy.send_event(UserEvent::DrainFinished);
            return;
        }
        // checkpoint 比预期久（大 WAL）。把窗口请回来，避免进程藏在后台又不能强制退出。
        let _ = proxy.send_event(UserEvent::ShowDrain(
            r#"{"shuttingDown":true,"checkpointing":true,"pending":[]}"#.to_string(),
        ));
    } else {
        let _ = proxy.send_event(UserEvent::ShowDrain(
            first.unwrap_or_else(|| r#"{"shuttingDown":true,"checkpointing":false,"pending":[]}"#.to_string()),
        ));
    }

    let deadline = Instant::now() + safety;
    loop {
        if force.load(Ordering::SeqCst) {
            log("drain force-exit requested");
            let _ = child.kill();
            let _ = child.wait();
            let _ = proxy.send_event(UserEvent::DrainFinished);
            return;
        }
        match child.try_wait() {
            Ok(Some(_)) => {
                log(&format!("drain exited in {}ms", started.elapsed().as_millis()));
                let _ = proxy.send_event(UserEvent::DrainFinished);
                return;
            }
            Ok(None) => {}
            Err(_) => {
                let _ = proxy.send_event(UserEvent::DrainFinished);
                return;
            }
        }
        if Instant::now() >= deadline {
            log("drain safety timeout (20min), killing");
            let _ = child.kill();
            let _ = child.wait();
            let _ = proxy.send_event(UserEvent::DrainFinished);
            return;
        }
        if let Some(body) = http_call(port, "GET", "/api/shutdown-status") {
            let _ = proxy.send_event(UserEvent::DrainList(body));
        }
        std::thread::sleep(Duration::from_millis(400));
    }
}

/// 后台线程 → UI 线程。
enum UserEvent {
    /// `GET /api/overview` 拿到 200，可以跳转了
    Ready,
    /// spawn 失败 / node 自己退了 / 等满 30 秒
    Failed(&'static str),
    /// 没有进行中的操作：先把窗口藏起来，后台等 checkpoint
    QuietDrain,
    /// 还有操作，或 checkpoint 太久：把等待页摆到前台。参数是状态 JSON。
    ShowDrain(String),
    /// 刷新等待页上的列表
    DrainList(String),
    /// 服务进程已经结束，壳可以退了
    DrainFinished,
    /// Windows 正在关机 / 注销
    SessionEnd,
}

/// 启动前先分类，避免窗口建出来才发现起不来。
enum Preset {
    /// 已经有服务在跑（可能是 start.bat 起的），直接连
    Attach,
    /// 需要自己起：程序目录 + node 路径
    Spawn(PathBuf, PathBuf),
    PortBusy,
    NoApp,
    NoNode,
}

/// 路径要拼进 JS 字符串，反斜杠和引号必须转义（Windows 路径满屏反斜杠）
fn json_escape(s: &str) -> String {
    let mut out = String::with_capacity(s.len() + 8);
    for c in s.chars() {
        match c {
            '\\' => out.push_str("\\\\"),
            '"' => out.push_str("\\\""),
            '\n' => out.push_str("\\n"),
            '\r' => out.push_str("\\r"),
            '\t' => out.push_str("\\t"),
            c if (c as u32) < 0x20 => out.push_str(&format!("\\u{:04x}", c as u32)),
            c => out.push(c),
        }
    }
    out
}

/// 图标字节：`desktop/make-icon.mjs` 从 `assets/icon-source.png` 生成，
/// 16/24/32/48/64/128/256 七张 32bpp BMP，共 364 KB。
const ICON_ICO: &[u8] = include_bytes!("../assets/icon.ico");

/// 取 ICO 里第 `index` 张图，返回 (宽, 高, DIB 切片)。
///
/// 只认「32bpp 未压缩 BMP」这一支 —— 图标是 `desktop/make-icon.mjs` 自己生成的，
/// 格式可控；换成 PNG-compressed 条目这里会返回 None（壳退回默认图标，不 panic）。
/// 手写解析而不引 `image` crate：release 构建不值得为几张图标多等半分钟。
fn ico_image(bytes: &[u8], index: usize) -> Option<(u32, u32, &[u8])> {
    // ICONDIR: reserved(u16=0) type(u16=1) count(u16)
    if bytes.len() < 6 || bytes[0] != 0 || bytes[1] != 0 || bytes[2] != 1 || bytes[3] != 0 {
        return None;
    }
    let count = u16::from_le_bytes([bytes[4], bytes[5]]) as usize;
    if index >= count {
        return None;
    }
    let entry = bytes.get(6 + index * 16..6 + index * 16 + 16)?;
    // 宽高是 u8：256 一律写 0（ICO 规范的约定）
    let w = if entry[0] == 0 { 256 } else { entry[0] as u32 };
    let h = if entry[1] == 0 { 256 } else { entry[1] as u32 };
    let off = u32::from_le_bytes([entry[12], entry[13], entry[14], entry[15]]) as usize;
    let size = u32::from_le_bytes([entry[8], entry[9], entry[10], entry[11]]) as usize;
    // 按 bytesInRes 精确截断：不然后面的条目会一起被当成这张图的数据
    let dib = bytes.get(off..off.checked_add(size)?)?;
    if dib.len() < 40 || w == 0 || h == 0 {
        return None;
    }
    let bit_count = u16::from_le_bytes([dib[14], dib[15]]);
    let compression = u32::from_le_bytes([dib[16], dib[17], dib[18], dib[19]]);
    if bit_count != 32 || compression != 0 {
        return None;
    }
    if dib.len() < 40 + (w as usize) * 4 * h as usize {
        return None;
    }
    Some((w, h, dib))
}

/// 挑一张最接近 `want` 的图。Windows 按 DPI 自己挑尺寸，但 tao 的
/// `Icon::from_rgba` 只收一张 —— 给它 48（标题栏/任务栏都用得上）。
fn ico_pick(bytes: &[u8], want: u32) -> Option<(u32, u32, &[u8])> {
    let count = u16::from_le_bytes([*bytes.get(4)?, *bytes.get(5)?]) as usize;
    let mut best: Option<(u32, u32, &[u8])> = None;
    let mut best_diff = u32::MAX;
    for i in 0..count {
        if let Some((w, h, dib)) = ico_image(bytes, i) {
            let diff = w.abs_diff(want);
            if diff < best_diff {
                best_diff = diff;
                best = Some((w, h, dib));
            }
        }
    }
    best
}

/// DIB（bottom-up BGRA）→ top-down RGBA，`Icon::from_rgba` 要后者。
fn dib_to_rgba(dib: &[u8], w: u32, h: u32) -> Option<Vec<u8>> {
    let row = w as usize * 4;
    let pixels = dib.get(40..)?.get(..row * h as usize)?;
    let mut rgba = vec![0u8; row * h as usize];
    for y in 0..h as usize {
        let src = &pixels[(h as usize - 1 - y) * row..][..row];
        for x in 0..w as usize {
            let o = (y * w as usize + x) * 4;
            rgba[o] = src[x * 4 + 2];
            rgba[o + 1] = src[x * 4 + 1];
            rgba[o + 2] = src[x * 4];
            rgba[o + 3] = src[x * 4 + 3];
        }
    }
    Some(rgba)
}

fn load_icon(bytes: &[u8]) -> Option<tao::window::Icon> {
    let (w, h, dib) = ico_pick(bytes, 48)?;
    let rgba = dib_to_rgba(dib, w, h)?;
    tao::window::Icon::from_rgba(rgba, w, h).ok()
}

fn main() {
    let port: u16 = env::var("AMS_PORT")
        .ok()
        .and_then(|v| v.parse().ok())
        .unwrap_or(DEFAULT_PORT);

    rotate_log();
    log("---- shell start ----");

    // 双击两次只该有一个窗口。抢到互斥量 = 第一个；抢不到就把已有窗口叫到前台再退出。
    // 注意这里不能提前 return 掉服务逻辑的判断：抢不到时连服务都不该碰。
    #[cfg(windows)]
    match win32::acquire_mutex() {
        None => {
            let hit = win32::activate_window("资料库");
            log(&format!("duplicate instance; activate existing window: {hit}"));
            return;
        }
        Some(_guard) => log("single instance: primary"),
    }

    let app = find_app_dir();
    log(&format!("app dir: {:?}", app));

    // 先把「要不要自己起服务」判清楚：都是本地几百毫秒内的检查。
    // 真正起服务挪到后台线程，窗口才能立刻显示骨架页。
    let preset = if service_ready(port) {
        log("service already running, reuse it");
        Preset::Attach
    } else if port_open(port) {
        log(&format!("port {port} is listened by something else"));
        Preset::PortBusy
    } else {
        match (app, find_node()) {
            (Some(dir), Some(node)) => {
                log(&format!("node: {:?}", node));
                Preset::Spawn(dir, node)
            }
            (None, _) => {
                log("app dir not found (server/src/index.js)");
                Preset::NoApp
            }
            (_, None) => {
                log("node.exe not found");
                Preset::NoNode
            }
        }
    };

    let event_loop = EventLoopBuilder::<UserEvent>::with_user_event().build();

    // 位置/大小记忆：先确认上次记的矩形还落在某块屏幕上。外接显示器拔掉、
    // 分辨率改小之后，旧坐标可能整块越界，恢复出来就是「点开什么都没有」。
    let monitors: Vec<_> = event_loop.available_monitors().collect();
    let restored = load_state().filter(|s| s.x != -1 && state_visible(s, &monitors));
    log(&format!(
        "window state: {:?} (monitors: {})",
        restored.map(|s| (s.x, s.y, s.w, s.h, s.maximized)),
        monitors.len()
    ));
    let (cap_w, cap_h) = size_cap(&monitors);
    // 本机是 200% 缩放，1440×900 逻辑 = 2880×1800 物理，正好顶满整块屏 ——
    // 外框一加上就比屏幕还大，右边和下边被切。所以默认值也要过一遍上限。
    let scale = monitors.first().map(|m| m.scale_factor()).unwrap_or(1.0);
    let initial = match restored {
        Some(mut s) => {
            // 换了更小的屏幕：尺寸夹到上限，位置仍用记的那个
            s.w = s.w.min(cap_w);
            s.h = s.h.min(cap_h);
            s
        }
        None => WindowState {
            x: -1,
            y: -1,
            w: ((1440.0 * scale) as u32).min(cap_w),
            h: ((900.0 * scale) as u32).min(cap_h),
            maximized: false,
        },
    };

    let icon = load_icon(ICON_ICO);
    log(&format!(
        "window icon: {}",
        if icon.is_some() { "loaded" } else { "default" }
    ));
    let win_builder = WindowBuilder::new()
        .with_title("资料库")
        .with_window_icon(icon)
        .with_min_inner_size(LogicalSize::new(960.0, 640.0))
        .with_inner_size(PhysicalSize::new(initial.w, initial.h));
    let win_builder = if initial.x != -1 {
        win_builder.with_position(PhysicalPosition::new(initial.x, initial.y))
    } else {
        win_builder
    };
    let window = win_builder.build(&event_loop).expect("window");
    #[cfg(windows)]
    {
        use tao::platform::windows::WindowExtWindows;
        win32::apply_icons(window.hwnd(), ICON_ICO);
        install_session_hook(window.hwnd());
    }
    if initial.maximized {
        window.set_maximized(true);
    }

    // 持续记录「非最大化」的几何：最大化时的 inner_size 是整屏尺寸，
    // 存下来下次还原就成了整屏大小，而不是用户自己拖出来的那个大小。
    let mut last_pos = window
        .outer_position()
        .map(|p| (p.x, p.y))
        .unwrap_or((initial.x, initial.y));
    let mut last_normal = (initial.w, initial.h);

    // WebView2 默认把用户数据（缓存 / cookie）拉在 exe 旁边，叫「资料库.exe.WebView2」，
    // 放在项目根又脏又会被备份脚本拷走 —— 统一挪到 %LOCALAPPDATA%\ams-desktop\webview2
    let profile_dir = log_dir().join("webview2");
    let _ = fs::create_dir_all(&profile_dir);
    let mut web_context = wry::WebContext::new(Some(profile_dir));

    let force_exit = Arc::new(AtomicBool::new(false));
    let force_ipc = force_exit.clone();
    let builder = wry::WebViewBuilder::new_with_web_context(&mut web_context)
        .with_background_color((245, 245, 245, 255))
        .with_initialization_script(SHELL_JS)
        .with_document_title_changed_handler(|title| log(&format!("title: {title}")))
        .with_on_page_load_handler(|event, url| {
            let phase = match event {
                wry::PageLoadEvent::Started => "start",
                wry::PageLoadEvent::Finished => "done",
            };
            log(&format!("load {phase}: {url}"));
        })
        .with_ipc_handler(move |req| {
            let body = req.body();
            log(&format!("page: {body}"));
            if body.contains("force-exit") {
                force_ipc.store(true, Ordering::SeqCst);
            }
        });

    // 拖进窗口的文件：只有壳知道它在磁盘上的真实路径（浏览器拿到的只是字节），
    // 拿到之后交给页面，由页面调 /api/import/paths —— 入库成功才能删掉源文件。
    let webview_slot: Rc<RefCell<Option<wry::WebView>>> = Rc::new(RefCell::new(None));
    let slot_for_drop = webview_slot.clone();
    let builder = builder.with_drag_drop_handler(move |event| {
        if let wry::DragDropEvent::Drop { paths, .. } = event {
            let list = paths
                .iter()
                .map(|p| format!("\"{}\"", json_escape(&p.to_string_lossy())))
                .collect::<Vec<_>>()
                .join(",");
            log(&format!("drop {} path(s)", paths.len()));
            if let Some(w) = slot_for_drop.borrow().as_ref() {
                let _ = w.evaluate_script(&format!(
                    "window.__amsDrop && window.__amsDrop([{list}])"
                ));
            }
            return true;
        }
        false
    });

    // 初始页面：能连就直接连；要自己起就先上骨架页，等后台线程报就绪再跳；
    // 剩下三种是明确的错误，直接给说明页（不必等 30 秒）。
    let target = format!("http://127.0.0.1:{port}");
    let builder = match &preset {
        Preset::Attach => builder.with_url(target.clone()),
        Preset::Spawn(..) => builder.with_html(SKELETON_PAGE),
        Preset::PortBusy => builder.with_html(error_page(
            "端口被别的程序占了",
            &format!(
                "本程序需要一个本地端口跑后端服务，但 <code>{port}</code> 已经有别的程序在监听。关掉它，或者设环境变量 <code>AMS_PORT</code> 换一个端口。"
            ),
            port,
        )),
        Preset::NoApp => builder.with_html(error_page(
            "找不到程序目录",
            "本程序需要和 <code>server</code> 目录放在一起（会从 exe 所在位置向上找 5 层）。",
            port,
        )),
        Preset::NoNode => builder.with_html(error_page(
            "找不到 Node.js",
            "后端服务需要本机的 Node.js 20 以上。已尝试：环境变量 <code>AMS_NODE</code>、<code>PATH</code>、<code>Program Files\\nodejs</code>、WorkBuddy 内置目录。",
            port,
        )),
    };

    // WebView 必须活到事件循环结束，交给 Rc 托管（拖拽回调里也要用）
    let webview = builder
        .build(&window)
        .expect("webview2 runtime is required");
    *webview_slot.borrow_mut() = Some(webview);

    // 自己起的服务：spawn 和「等就绪」都挪到后台线程，结果通过 user event 送回 UI 线程。
    // child 放 Arc<Mutex<>>：主线程关窗要收尸，后台线程要 try_wait 判断是不是早退。
    let child_slot: Arc<Mutex<Option<Child>>> = Arc::new(Mutex::new(None));
    let closing = Arc::new(AtomicBool::new(false));
    let mut awaiting = matches!(&preset, Preset::Spawn(..));

    let proxy = event_loop.create_proxy();
    #[cfg(windows)]
    if let Ok(mut slot) = SESSION_PROXY.lock() {
        *slot = Some(proxy.clone());
    }

    if let Preset::Spawn(dir, node) = preset {
        let slot = child_slot.clone();
        let closing = closing.clone();
        let proxy = proxy.clone();
        std::thread::spawn(move || {
            // 关窗抢在前面就别再拉起服务，否则壳退了、node 还活着
            match slot.lock() {
                Ok(g) if !closing.load(Ordering::SeqCst) => drop(g),
                _ => {
                    log("spawn skipped: shell is closing");
                    return;
                }
            }
            let mut child = match start_server(&dir, &node, port) {
                Ok(c) => c,
                Err(err) => {
                    log(&format!("spawn failed: {err}"));
                    let _ = proxy.send_event(UserEvent::Failed("spawn"));
                    return;
                }
            };
            // 交接点：持锁再判一次。主线程要么已经竖旗（我们收尾），要么接下来
            // 一定能 take 到 child（它收尾）—— 两种都不会留下孤儿 node。
            match slot.lock() {
                Ok(mut g) => {
                    let raced = closing.load(Ordering::SeqCst);
                    *g = Some(child);
                    if raced {
                        log("spawn raced with close; child handed to shell");
                        return;
                    }
                }
                Err(_) => {
                    log("spawn raced with close; stop it here");
                    stop_server(&mut child, port);
                    return;
                }
            }

            let deadline = Instant::now() + Duration::from_secs(30);
            loop {
                if service_ready(port) {
                    log("service ready: true");
                    let _ = proxy.send_event(UserEvent::Ready);
                    return;
                }
                // node 自己退了（端口冲突 / 依赖没装 / 数据库打不开）就别死等 30 秒
                let exited = slot
                    .lock()
                    .ok()
                    .and_then(|mut g| g.as_mut().map(|c| matches!(c.try_wait(), Ok(Some(_)))))
                    .unwrap_or(false);
                if exited {
                    log("service ready: false (node exited)");
                    let _ = proxy.send_event(UserEvent::Failed("exit"));
                    return;
                }
                if Instant::now() >= deadline {
                    log("service ready: false (timeout)");
                    let _ = proxy.send_event(UserEvent::Failed("timeout"));
                    return;
                }
                std::thread::sleep(Duration::from_millis(250));
            }
        });
    }

    let slot_for_events = webview_slot.clone();
    let mut draining = false;
    event_loop.run(move |event, _, control_flow| {
        *control_flow = ControlFlow::Wait;
        match event {
            // 后台线程报结果：就绪就跳转，失败就把骨架页换成说明页。
            // 关窗口之后的排空事件不走 awaiting，窗口还在，用来显示等待页。
            Event::UserEvent(ue) => {
                let held = slot_for_events.borrow();
                let Some(w) = held.as_ref() else {
                    return;
                };
                match ue {
                    UserEvent::Ready | UserEvent::Failed(_) if !awaiting => return,
                    UserEvent::Ready => {
                        awaiting = false;
                        log(&format!("navigate: {target}"));
                        let _ = w.load_url(&target);
                    }
                    UserEvent::Failed(reason) => {
                        awaiting = false;
                        let detail = match reason {
                            "spawn" => "node 进程没能启动。详见 <code>%LOCALAPPDATA%\\ams-desktop\\server.log</code>。".to_string(),
                            "exit" => "node 起来后立刻退出了：端口冲突、依赖没装、数据库打不开都可能，详见 <code>%LOCALAPPDATA%\\ams-desktop\\server.log</code>。".to_string(),
                            _ => format!("等了 30 秒，端口 {port} 还是没有响应。"),
                        };
                        let _ = w.load_html(&error_page("后端没有起来", &detail, port));
                    }
                    UserEvent::QuietDrain => {
                        let _ = window.set_visible(false);
                    }
                    UserEvent::ShowDrain(json) => {
                        let _ = window.set_visible(true);
                        let _ = w.load_html(&drain_page(&json));
                    }
                    UserEvent::DrainList(json) => {
                        let _ = w.evaluate_script(&format!(
                            "window.__shutdownUpdate && window.__shutdownUpdate(JSON.parse({}))",
                            js_quote(&json)
                        ));
                    }
                    UserEvent::DrainFinished => {
                        log("---- shell exit ----");
                        *control_flow = ControlFlow::Exit;
                    }
                    UserEvent::SessionEnd => {
                        log("session end");
                        if draining {
                            return;
                        }
                        draining = true;
                        if start_shell_drain(&child_slot, &closing, awaiting, port, force_exit.clone(), proxy.clone()) {
                            log("---- shell exit (no child) ----");
                            *control_flow = ControlFlow::Exit;
                        }
                    }
                }
            }
            Event::WindowEvent { event, .. } => match event {
                // 拖动 / 缩放时持续记账，关窗那一刻直接用，不用再读窗口
                WindowEvent::Moved(p) => {
                    // 最小化时 Windows 会把窗口挪到 -32000,-32000 并发 Moved。
                    // 记下来下次启动就「跑到屏幕外」（state_visible 能挡住改用默认值，
                    // 但用户记的位置白丢），所以最小化和这种哨兵坐标都要跳过。
                    if !window.is_maximized() && !window.is_minimized() && p.x > -20000 && p.y > -20000
                    {
                        last_pos = (p.x, p.y);
                    }
                }
                WindowEvent::Resized(size) => {
                    if !window.is_maximized() && size.width > 0 && size.height > 0 {
                        last_normal = (size.width, size.height);
                    }
                }
                WindowEvent::CloseRequested => {
                    if draining {
                        return;
                    }
                    let state = WindowState {
                        x: last_pos.0,
                        y: last_pos.1,
                        w: last_normal.0,
                        h: last_normal.1,
                        maximized: window.is_maximized(),
                    };
                    save_state(state);
                    log(&format!(
                        "save window state: ({}, {}, {}, {}) max={}",
                        state.x, state.y, state.w, state.h, state.maximized
                    ));
                    draining = true;
                    // 没有进行中的操作时，drain 线程会马上发 QuietDrain 把窗口藏起来，
                    // 用户感觉是立刻关上的。有操作才留在等待页上。
                    if start_shell_drain(&child_slot, &closing, awaiting, port, force_exit.clone(), proxy.clone()) {
                        log("---- shell exit (no child) ----");
                        *control_flow = ControlFlow::Exit;
                    }
                }
                _ => {}
            },
            _ => {}
        }
    });
}
