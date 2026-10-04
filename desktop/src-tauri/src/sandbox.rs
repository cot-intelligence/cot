//! Separate HOME and app identity for onboarding test DMGs.
use std::path::PathBuf;

pub fn enabled() -> bool {
    option_env!("COT_DESKTOP_SANDBOX_ID").is_some()
}

pub fn initialize() {
    let Some(id) = option_env!("COT_DESKTOP_SANDBOX_ID") else {
        return;
    };
    let real_home = PathBuf::from(std::env::var_os("HOME").expect("HOME is required"));
    let home = real_home
        .join("Library/Application Support/cot-sandbox")
        .join(id)
        .join("home");
    std::fs::create_dir_all(&home).expect("could not create sandbox HOME");
    std::env::set_var("HOME", &home);
    // Import reads real transcripts; import offsets and everything else stay in the sandbox.
    std::env::set_var("COT_IMPORT_HOME", &real_home);
    std::env::set_var("COT_SANDBOX_HOME", &home);
    std::env::set_var("COT_PORT", "31490");
    std::env::set_var("COT_DISABLE_TELEMETRY", "1");
    std::env::set_var("COT_DISABLE_ANALYTICS", "1");
    for (key, directory) in [
        ("COT_CLAUDE_HOME", ".claude"),
        ("CLAUDE_CONFIG_DIR", ".claude"),
        ("COT_CURSOR_HOME", ".cursor"),
        ("COT_CODEX_HOME", ".codex"),
        ("CODEX_HOME", ".codex"),
        ("COT_AGENTS_HOME", ".agents"),
        ("XDG_CONFIG_HOME", ".config"),
    ] {
        std::env::set_var(key, home.join(directory));
    }
}
