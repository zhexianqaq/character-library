//! 把图标和版本信息编译进 PE 资源。
//!
//! 为什么需要这一步：`with_window_icon` / `WM_SETICON` 只改运行时的窗口与
//! 任务栏图标，exe 文件本身在资源管理器、桌面快捷方式、文件属性里仍然显示
//! 默认的 Rust 图标 —— 那一份来自 PE 里的 RT_GROUP_ICON，必须构建时写进去。
//!
//! 为什么不用 winres crate：它靠调 reg.exe 去注册表里找 Windows SDK，
//! 而本机的安全策略把 reg.exe 拉黑了（winres 直接 panic）。这里改为自己
//! 找 rc.exe、自己拼 .rc、自己把 .res 交给链接器，零依赖且路径可覆盖
//! （RC_EXE 环境变量）。

use std::env;
use std::fs;
use std::path::PathBuf;
use std::process::Command;

/// 找 rc.exe：环境变量 → PATH → Windows SDK（取版本号最大的那套）。
fn find_rc() -> Option<PathBuf> {
    if let Ok(p) = env::var("RC_EXE") {
        let pb = PathBuf::from(&p);
        if pb.is_file() {
            return Some(pb);
        }
    }
    if let Some(paths) = env::var_os("PATH") {
        for dir in env::split_paths(&paths) {
            let p = dir.join("rc.exe");
            if p.is_file() {
                return Some(p);
            }
        }
    }
    for base in [
        r"C:\Program Files (x86)\Windows Kits\10\bin",
        r"C:\Program Files\Windows Kits\10\bin",
    ] {
        let Ok(rd) = fs::read_dir(base) else {
            continue;
        };
        let mut best: Option<(Vec<u32>, PathBuf)> = None;
        for entry in rd.flatten() {
            let candidate = entry.path().join("x64").join("rc.exe");
            if !candidate.is_file() {
                continue;
            }
            let name = entry.file_name().to_string_lossy().to_string();
            let ver: Vec<u32> = name.split('.').filter_map(|s| s.parse().ok()).collect();
            if best.as_ref().is_none_or(|(v, _)| ver > *v) {
                best = Some((ver, candidate));
            }
        }
        if let Some((_, p)) = best {
            return Some(p);
        }
    }
    None
}

fn main() {
    if env::var("CARGO_CFG_TARGET_OS").as_deref() != Ok("windows") {
        return;
    }
    println!("cargo:rerun-if-changed=assets/icon.ico");
    println!("cargo:rerun-if-changed=build.rs");
    println!("cargo:rerun-if-env-changed=RC_EXE");

    let manifest = PathBuf::from(env::var("CARGO_MANIFEST_DIR").expect("CARGO_MANIFEST_DIR"));
    let icon = manifest.join("assets").join("icon.ico");
    if !icon.is_file() {
        panic!("缺少图标：{}（先跑 node desktop/make-icon.mjs）", icon.display());
    }

    let out_dir = PathBuf::from(env::var("OUT_DIR").expect("OUT_DIR"));
    let rc_file = out_dir.join("app.rc");
    let res_file = out_dir.join("app.res");

    // 版本号来自 Cargo.toml，省得两处手改
    let ver = env::var("CARGO_PKG_VERSION").unwrap_or_else(|_| "0.0.0".into());
    let mut nums: Vec<u32> = ver.split('.').filter_map(|s| s.parse().ok()).collect();
    while nums.len() < 4 {
        nums.push(0);
    }
    let v4 = format!("{},{},{},{}", nums[0], nums[1], nums[2], nums[3]);

    // rc.exe 不认 UTF-8 里的反斜杠转义以外的写法，路径里的 \ 要成对
    let icon_path = icon.display().to_string().replace('\\', r"\\");

    // 两个要点（都是踩过的）：
    // - VERSIONINFO 的资源 ID 必须是数字 1。写成 `VS_VERSION_INFO VERSIONINFO`
    //   会把资源名变成字符串，GetFileVersionInfo 按 ID 1 查不到，文件属性全空。
    // - BLOCK 用中性的 "000004b0"（langid 0 + Unicode），任何系统语言都能读到。
    let rc_text = format!(
        r#"#pragma code_page(65001)

1 VERSIONINFO
 FILEVERSION {v4}
 PRODUCTVERSION {v4}
 FILEFLAGSMASK 0x3fL
 FILEFLAGS 0x0L
 FILEOS 0x40004L
 FILETYPE 0x1L
 FILESUBTYPE 0x0L
BEGIN
    BLOCK "StringFileInfo"
    BEGIN
        BLOCK "000004b0"
        BEGIN
            VALUE "FileDescription", "本机动漫 / cosplay 素材库"
            VALUE "FileVersion", "{ver}"
            VALUE "InternalName", "ams-desktop"
            VALUE "OriginalFilename", "资料库.exe"
            VALUE "ProductName", "资料库"
            VALUE "ProductVersion", "{ver}"
        END
    END
    BLOCK "VarFileInfo"
    BEGIN
        VALUE "Translation", 0x0, 0x04b0
    END
END

1 ICON "{icon_path}"
"#
    );
    fs::write(&rc_file, &rc_text).expect("写 app.rc");

    let rc = find_rc().unwrap_or_else(|| {
        panic!("找不到 rc.exe：装 Windows SDK，或用 RC_EXE 环境变量指向它")
    });
    println!("cargo:warning=rc = {}", rc.display());

    let status = Command::new(&rc)
        .arg("/nologo")
        .arg("/fo")
        .arg(&res_file)
        .arg(&rc_file)
        .status()
        .expect("运行 rc.exe 失败");
    if !status.success() {
        panic!("rc.exe 退出码 {:?}", status.code());
    }

    // 把 .res 直接交给链接器；link.exe 认输入文件后缀。
    // 用 `rustc-link-arg` 而不是 `-bins`：后者在只有单个 bin 时也常被丢掉，
    // 实测资源进不去（版本信息全空）；前者与 winres 的写法一致，稳定生效。
    println!("cargo:rustc-link-arg={}", res_file.display());
}
