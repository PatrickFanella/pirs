#![cfg_attr(target_arch = "wasm32", no_std)]
extern crate alloc;
use alloc::{format, string::String, vec::Vec};
use hmac::{Hmac, Mac};
use serde_json::{Value, json};
use sha2::Sha256;

#[cfg(target_arch = "wasm32")]
include!(concat!(env!("OUT_DIR"), "/config.rs"));
pub const MAX_ATTEMPTS: usize = 3;

pub fn signature(key: &[u8], body: &[u8]) -> String {
    let mut mac = Hmac::<Sha256>::new_from_slice(key).expect("HMAC key");
    mac.update(b"pirs-commit-v1\n");
    mac.update(body);
    let mut result = String::from("sha256=");
    for byte in mac.finalize().into_bytes() {
        result.push_str(&format!("{byte:02x}"));
    }
    result
}

// Project again so the notice never includes CAR blocks or unrelated fields,
// even if an operator changes the host grant to a broader collection set.
pub fn notice(input: &str, collections: &[Value]) -> Result<Option<Vec<u8>>, &'static str> {
    let event: Value = serde_json::from_str(input.strip_prefix("event:").ok_or("event required")?)
        .map_err(|_| "invalid event")?;
    if event["type"] != "commit" {
        return Ok(None);
    }
    let seq = event["seq"]
        .as_u64()
        .filter(|s| *s <= 9_007_199_254_740_991)
        .ok_or("sequence required")?;
    let repo = event["evt"]["repo"].as_str().ok_or("repo required")?;
    let rev = event["evt"]["rev"].as_str().ok_or("rev required")?;
    let time = event["time"].as_str().ok_or("time required")?;
    let mut selected = Vec::new();
    for op in event["evt"]["ops"].as_array().ok_or("ops required")? {
        let path = op["path"].as_str().ok_or("path required")?;
        let (collection, rkey) = path.split_once('/').ok_or("invalid path")?;
        if rkey.is_empty() || rkey.contains('/') {
            return Err("invalid path");
        }
        let action = op["action"].as_str().ok_or("action required")?;
        if !["create", "update", "delete"].contains(&action) {
            return Err("invalid action");
        }
        if collections.iter().any(|c| c.as_str() == Some(collection)) {
            selected.push(json!({"action": action, "path": path}));
        }
    }
    if selected.is_empty() {
        return Ok(None);
    }
    let body = serde_json::to_vec(&json!({"version": 1, "seq": seq, "repo": repo,
        "rev": rev, "time": time, "ops": selected}))
    .map_err(|_| "encoding failed")?;
    if body.len() > 16 * 1024 {
        return Err("notice exceeds network quota");
    }
    Ok(Some(body))
}

// Immediate retries fit the synchronous WIT contract. The host also bounds
// total wall time. A terminal failure traps, so the supervisor keeps its cursor.
pub fn deliver(mut send: impl FnMut() -> Result<u16, ()>) -> Result<usize, &'static str> {
    for attempt in 1..=MAX_ATTEMPTS {
        match send() {
            Ok(200..=299) => return Ok(attempt),
            Ok(429 | 500..=599) | Err(()) => {}
            Ok(_) => return Err("receiver rejected notice"),
        }
    }
    Err("webhook attempts exhausted")
}

#[cfg(target_arch = "wasm32")]
mod guest;

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn filters_and_projects_mixed_commits() {
        let input = r#"event:{"seq":42,"type":"commit","time":"now","evt":{"repo":"did:plc:test","rev":"rev","blocks":"DENIED","ops":[{"action":"create","path":"app.bsky.feed.post/one","value":"SECRET"},{"action":"delete","path":"org.test.denied/two"}]}}"#;
        let body = notice(input, &[json!("app.bsky.feed.post")])
            .unwrap()
            .unwrap();
        let value: Value = serde_json::from_slice(&body).unwrap();
        assert_eq!(
            value["ops"],
            json!([{"action":"create","path":"app.bsky.feed.post/one"}])
        );
        assert!(!String::from_utf8(body).unwrap().contains("SECRET"));
        assert!(notice(input, &[json!("org.test.other")]).unwrap().is_none());
        assert!(
            notice("event:{\"type\":\"account\"}", &[])
                .unwrap()
                .is_none()
        );
    }
    #[test]
    fn retries_are_bounded_and_permanent_errors_stop() {
        let mut calls = 0;
        assert_eq!(
            deliver(|| {
                calls += 1;
                Err(())
            }),
            Err("webhook attempts exhausted")
        );
        assert_eq!(calls, 3);
        let mut calls = 0;
        assert_eq!(
            deliver(|| {
                calls += 1;
                Ok(if calls < 3 { 503 } else { 204 })
            }),
            Ok(3)
        );
        assert_eq!(deliver(|| Ok(400)), Err("receiver rejected notice"));
        assert_eq!(deliver(|| Ok(302)), Err("receiver rejected notice"));
        assert_eq!(deliver(|| Ok(429)), Err("webhook attempts exhausted"));
    }
    #[test]
    fn signature_covers_exact_bytes_and_domain() {
        let key = [7; 32];
        assert_eq!(
            signature(&key, b"notice"),
            "sha256=4da4763d6fd1753b5d62b8800346e2b6ceb547f16b34922a32b9f020acfa0f20"
        );
        assert_eq!(signature(&key, b"notice").len(), 71);
        assert_ne!(signature(&key, b"notice"), signature(&key, b"notice\n"));
        assert_ne!(signature(&key, b"notice"), signature(&[8; 32], b"notice"));
    }
}
