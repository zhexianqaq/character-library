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
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};

use tao::dpi::{LogicalSize, PhysicalPosition, PhysicalSize};
use tao::event::{Event, WindowEvent};
use tao::event_loop::{ControlFlow, EventLoop};
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

/// 关窗口前先请服务「自己退出」：它会 checkpoint 一次 WAL 再 exit(0)。
/// 直接 TerminateProcess 偶尔会把 SQLite 停在 checkpoint 中间，最近写入的记录就没了。
///
/// 返回 true = 服务答应了退出（收到 200）。它先 res.json 再 checkpoint，所以
/// 「读到响应」不等于「进程已经退了」，后面还要轮询 try_wait。
fn ask_shutdown(port: u16) -> bool {
    let addr: SocketAddr = ([127, 0, 0, 1], port).into();
    let mut stream = match TcpStream::connect_timeout(&addr, Duration::from_millis(300)) {
        Ok(s) => s,
        Err(_) => return false,
    };
    let _ = stream.set_read_timeout(Some(Duration::from_millis(600)));
    let _ = stream.set_write_timeout(Some(Duration::from_millis(300)));
    let req = format!(
        "POST /api/shutdown HTTP/1.1\r\nHost: 127.0.0.1:{port}\r\nContent-Length: 0\r\nConnection: close\r\n\r\n"
    );
    if stream.write_all(req.as_bytes()).is_err() {
        return false;
    }
    let mut buf = [0u8; 128];
    match stream.read(&mut buf) {
        Ok(n) if n > 0 => {
            let head = String::from_utf8_lossy(&buf[..n]);
            head.starts_with("HTTP/1.1 200") || head.starts_with("HTTP/1.0 200")
        }
        _ => false,
    }
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

fn main() {
    let port: u16 = env::var("AMS_PORT")
        .ok()
        .and_then(|v| v.parse().ok())
        .unwrap_or(DEFAULT_PORT);

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

    let mut child: Option<Child> = None;
    let mut ready = service_ready(port);
    let mut port_busy = false;

    if ready {
        log("service already running, reuse it");
    } else {
        port_busy = port_open(port);
        if port_busy {
            log(&format!("port {port} is listened by something else"));
        }
        match (app.as_deref(), find_node()) {
            (Some(dir), Some(node)) => {
                if !port_busy {
                    log(&format!("node: {:?}", node));
                    match start_server(dir, &node, port) {
                        Ok(c) => child = Some(c),
                        Err(err) => log(&format!("spawn failed: {err}")),
                    }
                }
                let deadline = Instant::now() + Duration::from_secs(30);
                while Instant::now() < deadline && !service_ready(port) {
                    std::thread::sleep(Duration::from_millis(250));
                }
                ready = service_ready(port);
                log(&format!("service ready: {ready}"));
            }
            (None, _) => log("app dir not found (server/src/index.js)"),
            (_, None) => log("node.exe not found"),
        }
    }

    let event_loop = EventLoop::new();

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

    let win_builder = WindowBuilder::new()
        .with_title("资料库")
        .with_min_inner_size(LogicalSize::new(960.0, 640.0))
        .with_inner_size(PhysicalSize::new(initial.w, initial.h));
    let win_builder = if initial.x != -1 {
        win_builder.with_position(PhysicalPosition::new(initial.x, initial.y))
    } else {
        win_builder
    };
    let window = win_builder.build(&event_loop).expect("window");
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
        .with_ipc_handler(|req| log(&format!("page: {}", req.body())));

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

    let builder = if ready {
        builder.with_url(format!("http://127.0.0.1:{port}"))
    } else {
        let body = if port_busy {
            error_page(
                "端口被别的程序占了",
                &format!(
                    "本程序需要一个本地端口跑后端服务，但 <code>{port}</code> 已经有别的程序在监听。关掉它，或者设环境变量 <code>AMS_PORT</code> 换一个端口。"
                ),
                port,
            )
        } else {
            match (app.is_some(), find_node().is_some()) {
                (false, _) => error_page(
                    "找不到程序目录",
                    "本程序需要和 <code>server</code> 目录放在一起（会从 exe 所在位置向上找 5 层）。",
                    port,
                ),
                (_, false) => error_page(
                    "找不到 Node.js",
                    "后端服务需要本机的 Node.js 20 以上。已尝试：环境变量 <code>AMS_NODE</code>、<code>PATH</code>、<code>Program Files\\nodejs</code>、WorkBuddy 内置目录。",
                    port,
                ),
                _ => error_page(
                    "后端没有起来",
                    &format!("等了 30 秒端口 {port} 还没有响应。可以点下面的重试，或者看 <code>%LOCALAPPDATA%\\ams-desktop\\server.log</code>。"),
                    port,
                ),
            }
        };
        builder.with_html(body)
    };

    // WebView 必须活到事件循环结束，交给 Rc 托管（拖拽回调里也要用）
    let webview = builder
        .build(&window)
        .expect("webview2 runtime is required");
    *webview_slot.borrow_mut() = Some(webview);

    event_loop.run(move |event, _, control_flow| {
        *control_flow = ControlFlow::Wait;
        let Event::WindowEvent { event, .. } = event else {
            return;
        };
        match event {
            // 拖动 / 缩放时持续记账，关窗那一刻直接用，不用再读窗口
            WindowEvent::Moved(p) => {
                if !window.is_maximized() {
                    last_pos = (p.x, p.y);
                }
            }
            WindowEvent::Resized(size) => {
                if !window.is_maximized() && size.width > 0 && size.height > 0 {
                    last_normal = (size.width, size.height);
                }
            }
            WindowEvent::CloseRequested => {
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

                // 先让窗口消失。收尾（等 checkpoint、杀进程、销毁 WebView2）还在主线程上，
                // 但用户已经看不到它了 —— 以前是窗口僵在那里同步 sleep(900)，点完像卡死。
                let _ = window.set_visible(false);
                // 服务是我们起的才由我们收尸；复用别人起的就别乱杀
                if let Some(mut c) = child.take() {
                    let started = Instant::now();
                    let graceful = ask_shutdown(port);
                    // 答应了就多给点时间 checkpoint；没答应（连不上 / 不是我们的服务）就别等
                    let limit = if graceful { 2500 } else { 300 };
                    if !wait_exit(&mut c, Duration::from_millis(limit)) {
                        let _ = c.kill();
                        let _ = c.wait();
                    }
                    log(&format!(
                        "server stopped: {} in {}ms",
                        if graceful { "graceful" } else { "forced" },
                        started.elapsed().as_millis()
                    ));
                }
                log("---- shell exit ----");
                *control_flow = ControlFlow::Exit;
            }
            _ => {}
        }
    });
}
