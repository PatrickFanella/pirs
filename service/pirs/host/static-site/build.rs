fn main() {
    println!("cargo:rerun-if-env-changed=PIRS_SITE_DID");
    let did = std::env::var("PIRS_SITE_DID").unwrap_or_else(|_| {
        assert_ne!(
            std::env::var("CARGO_CFG_TARGET_ARCH").unwrap(),
            "wasm32",
            "use static-site/build.py with a public local DID"
        );
        "did:plc:aaaaaaaaaaaaaaaaaaaaaaaa".into()
    });
    assert!(
        did.starts_with("did:plc:")
            && did.len() == 32
            && did[8..]
                .bytes()
                .all(|b| b.is_ascii_lowercase() || (b'2'..=b'7').contains(&b)),
        "public PLC DID required"
    );
    std::fs::write(
        std::path::PathBuf::from(std::env::var_os("OUT_DIR").unwrap()).join("config.rs"),
        format!("const DID: &str = {did:?};"),
    )
    .unwrap();
}
