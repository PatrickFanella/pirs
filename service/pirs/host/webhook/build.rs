fn main() {
    println!("cargo:rerun-if-env-changed=PIRS_WEBHOOK_CONFIG");
    let config = match std::env::var("PIRS_WEBHOOK_CONFIG") {
        Ok(path) => {
            println!("cargo:rerun-if-changed={path}");
            std::fs::read_to_string(path).expect("read webhook configuration")
        }
        Err(_) => {
            assert_ne!(
                std::env::var("CARGO_CFG_TARGET_ARCH").unwrap(),
                "wasm32",
                "build the component with webhook/build.py and disposable configuration"
            );
            r#"{"url":"http://localhost/notice","key":"0000000000000000000000000000000000000000000000000000000000000000","collections":["app.bsky.feed.post"]}"#.into()
        }
    };
    let _: serde_json::Value = serde_json::from_str(&config).expect("valid configuration JSON");
    std::fs::write(
        std::path::PathBuf::from(std::env::var_os("OUT_DIR").unwrap()).join("config.rs"),
        format!("const CONFIG: &str = {config:?};"),
    )
    .unwrap();
}
