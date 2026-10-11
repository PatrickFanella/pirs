#![cfg_attr(target_arch = "wasm32", no_std)]
extern crate alloc;
use alloc::{
    string::{String, ToString},
    vec::Vec,
};
use serde_json::{Value, json};

pub const COLLECTION: &str = "tv.pirs.site.page";
pub const PAGE_BYTES: usize = 8192;

fn response(status: u16, content_type: &str, body: &str) -> String {
    json!({"status":status,"contentType":content_type,"body":body}).to_string()
}

// Each invocation is stateless. Read the current public page rather than retaining
// a stale copy after a commit, deletion, moderation action or runtime restart.
pub fn serve(
    input: &str,
    did: &str,
    mut record: impl FnMut(&str, &str, &str) -> Result<String, String>,
    mut blob: impl FnMut(&str, &str, &str, &str) -> Result<Vec<u8>, String>,
) -> String {
    let Some(raw) = input.strip_prefix("http:") else {
        return commit(input, did).into();
    };
    let Ok(call) = serde_json::from_str::<Value>(raw) else {
        return response(400, "text/plain", "InvalidRequest");
    };
    if call["method"] != "GET" || call["query"] != "" || call["body"] != "" {
        return response(400, "text/plain", "InvalidRequest");
    }
    let rkey = match call["path"].as_str() {
        Some("/") => "index",
        Some("/about") => "about",
        _ => return response(404, "text/plain", "PageUnavailable"),
    };
    let page = (|| -> Option<(String, String)> {
        let raw = record(did, COLLECTION, rkey).ok()?;
        let record: Value = serde_json::from_str(&raw).ok()?;
        if record["value"]["$type"] != COLLECTION {
            return None;
        }
        let file = &record["value"]["file"];
        if file["$type"] != "blob" {
            return None;
        }
        let mime = file["mimeType"].as_str()?;
        if !["text/html", "text/plain"].contains(&mime) {
            return None;
        }
        let size = file["size"].as_u64()?;
        if size > PAGE_BYTES as u64 {
            return None;
        }
        let cid = file["ref"]["$link"].as_str()?;
        let bytes = blob(did, COLLECTION, rkey, cid).ok()?;
        if bytes.len() > PAGE_BYTES || bytes.len() as u64 != size {
            return None;
        }
        Some((mime.into(), String::from_utf8(bytes).ok()?))
    })();
    match page {
        Some((mime, body)) => response(200, &mime, &body),
        None => response(404, "text/plain", "PageUnavailable"),
    }
}

pub fn commit(input: &str, did: &str) -> &'static str {
    let Some(raw) = input.strip_prefix("event:") else {
        return "ignored";
    };
    let Ok(event) = serde_json::from_str::<Value>(raw) else {
        return "ignored";
    };
    if event["type"] != "commit" || event["evt"]["repo"] != did {
        return "ignored";
    }
    if event["evt"]["ops"].as_array().is_some_and(|ops| {
        ops.iter().any(|op| {
            matches!(
                op["path"].as_str(),
                Some("tv.pirs.site.page/index" | "tv.pirs.site.page/about")
            ) && matches!(op["action"].as_str(), Some("create" | "update" | "delete"))
        })
    }) {
        "site-commit"
    } else {
        "ignored"
    }
}

#[cfg(target_arch = "wasm32")]
mod guest;

#[cfg(test)]
mod tests {
    use super::*;
    fn call(path: &str) -> String {
        alloc::format!(
            "http:{}",
            json!({"path":path,"method":"GET","query":"","body":""})
        )
    }
    fn page(mime: &str, size: usize) -> String {
        json!({"value":{"$type":COLLECTION,"file":{"$type":"blob","mimeType":mime,"size":size,"ref":{"$link":"cid"}}}}).to_string()
    }
    #[test]
    fn binds_reads_to_account_collection_and_page() {
        let got = serve(
            &call("/"),
            "did",
            |d, c, k| {
                assert_eq!((d, c, k), ("did", COLLECTION, "index"));
                Ok(page("text/html", 4))
            },
            |d, c, k, cid| {
                assert_eq!((d, c, k, cid), ("did", COLLECTION, "index", "cid"));
                Ok(b"site".to_vec())
            },
        );
        assert_eq!(serde_json::from_str::<Value>(&got).unwrap()["body"], "site");
        for path in ["/../index", "/other", "/xrpc", "//about"] {
            let got = serve(
                &call(path),
                "did",
                |_, _, _| panic!("unexpected read"),
                |_, _, _, _| panic!("unexpected blob"),
            );
            assert_eq!(serde_json::from_str::<Value>(&got).unwrap()["status"], 404);
        }
    }
    #[test]
    fn rejects_mime_size_utf8_and_changed_blob_descriptors() {
        for (mime, size, bytes) in [
            ("image/svg+xml", 1, alloc::vec![120]),
            ("text/plain", 8193, alloc::vec![120;8193]),
            ("text/plain", 1, alloc::vec![255]),
            ("text/plain", 1, alloc::vec![120, 121]),
        ] {
            let got = serve(
                &call("/about"),
                "did",
                |_, _, _| Ok(page(mime, size)),
                |_, _, _, _| Ok(bytes.clone()),
            );
            assert_eq!(serde_json::from_str::<Value>(&got).unwrap()["status"], 404);
        }
        let got = serve(
            &call("/about"),
            "did",
            |_, _, _| Ok(page("text/plain", PAGE_BYTES)),
            |_, _, _, _| Ok(alloc::vec![120;PAGE_BYTES]),
        );
        assert_eq!(serde_json::from_str::<Value>(&got).unwrap()["status"], 200);
    }
    #[test]
    fn scopes_site_commit_acknowledgement() {
        let event = |repo, action| {
            alloc::format!(
                "event:{}",
                json!({"type":"commit","evt":{"repo":repo,"ops":[{"path":"tv.pirs.site.page/index","action":action}]}})
            )
        };
        assert_eq!(commit(&event("did", "update"), "did"), "site-commit");
        assert_eq!(commit(&event("other", "update"), "did"), "ignored");
        assert_eq!(commit(&event("did", "unknown"), "did"), "ignored");
    }
}
