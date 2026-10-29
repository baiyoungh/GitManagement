// Windows release 包不弹出控制台窗口
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

fn main() {
    // 同一个可执行文件兼任 GIT_ASKPASS 程序：git 调用时带有环境变量标记，
    // 此时只从系统钥匙串取出凭据输出到 stdout，不启动 GUI。
    if gitmanagement_lib::askpass::is_askpass_invocation() {
        std::process::exit(gitmanagement_lib::askpass::run());
    }
    gitmanagement_lib::run()
}
