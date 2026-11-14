// Windows release 包不弹出控制台窗口
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

fn main() {
    if std::env::var("GITMANAGEMENT_KEYGEN_ASKPASS").as_deref() == Ok("1") {
        std::process::exit(gitmanagement_lib::ssh_keys::run_askpass());
    }
    if std::env::args().nth(1).as_deref() == Some("--gitmanagement-ssh") {
        std::process::exit(gitmanagement_lib::ssh::run_wrapper());
    }
    if std::env::var(gitmanagement_lib::ssh::ASKPASS_ENV).as_deref() == Ok("1") {
        std::process::exit(gitmanagement_lib::ssh::run_askpass());
    }
    if std::env::args().nth(1).as_deref() == Some("--gitmanagement-credential") {
        let action = std::env::args().nth(2).unwrap_or_default();
        std::process::exit(gitmanagement_lib::auth::run_helper(&action));
    }
    // 同一个可执行文件兼任 GIT_ASKPASS 程序：git 调用时带有环境变量标记，
    // 此时只从系统钥匙串取出凭据输出到 stdout，不启动 GUI。
    if gitmanagement_lib::askpass::is_askpass_invocation() {
        std::process::exit(gitmanagement_lib::askpass::run());
    }
    gitmanagement_lib::run()
}
