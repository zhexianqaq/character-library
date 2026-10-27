#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

//! 资料库桌面壳（Windows / WebView2）。
//!
//! 只做三件事：把本机 Node 服务拉起来、用 WebView2 打开 `http://127.0.0.1:<port>`、
//! 让 F5 / Ctrl+R 刷新页面。页面本身还是 `web/` 里那一套，一行 HTML 都不改。
//!
//! 之所以要有壳：浏览器拖拽只给字节、不给路径（File 对象没有 path），
//! 壳能拿到真实路径，后续「拖进来就解压入库、把源包删掉」才有得做。

use std::env;
use std::fs;
use std::io::{Read, Write};
use std::net::{SocketAddr, TcpStream};
use std::path::{Path, PathBuf};
use std::process::{Child, Command, Stdio};
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};

use tao::dpi::LogicalSize;
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
fn ask_shutdown(port: u16) {
    let addr: SocketAddr = ([127, 0, 0, 1], port).into();
    let mut stream = match TcpStream::connect_timeout(&addr, Duration::from_millis(400)) {
        Ok(s) => s,
        Err(_) => return,
    };
    let _ = stream.set_read_timeout(Some(Duration::from_millis(1500)));
    let req = format!(
        "POST /api/shutdown HTTP/1.1\r\nHost: 127.0.0.1:{port}\r\nContent-Length: 0\r\nConnection: close\r\n\r\n"
    );
    let _ = stream.write_all(req.as_bytes());
    let mut buf = [0u8; 128];
    let _ = stream.read(&mut buf);
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

fn main() {
    let port: u16 = env::var("AMS_PORT")
        .ok()
        .and_then(|v| v.parse().ok())
        .unwrap_or(DEFAULT_PORT);

    log("---- shell start ----");
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
    let window = WindowBuilder::new()
        .with_title("资料库")
        .with_inner_size(LogicalSize::new(1440.0, 900.0))
        .with_min_inner_size(LogicalSize::new(960.0, 640.0))
        .build(&event_loop)
        .expect("window");

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

    let _webview = builder
        .build(&window)
        .expect("webview2 runtime is required");

    event_loop.run(move |event, _, control_flow| {
        *control_flow = ControlFlow::Wait;
        if let Event::WindowEvent {
            event: WindowEvent::CloseRequested,
            ..
        } = event
        {
            // 服务是我们起的才由我们收尸；复用别人起的就别乱杀
            if let Some(mut c) = child.take() {
                ask_shutdown(port);
                std::thread::sleep(Duration::from_millis(900));
                let _ = c.try_wait();
                let _ = c.kill();
                let _ = c.wait();
                log("server stopped");
            }
            log("---- shell exit ----");
            *control_flow = ControlFlow::Exit;
        }
    });
}
