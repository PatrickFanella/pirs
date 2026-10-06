use anyhow::{Result, ensure};
use reqwest::{Client, Url};
use serde::Deserialize;
use serde_json::Value;
use std::{net::IpAddr, time::Instant};

pub const MAX_RESULT: usize = 64 * 1024;
const MAX_TOTAL: usize = 128 * 1024;
const MAX_CALLS: usize = 8;

#[derive(Clone, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct Grant {
    collections: Vec<String>,
}
impl Grant {
    pub fn parse(value: &Value) -> Result<Self> {
        let grant: Self = serde_json::from_value(value.clone())?;
        ensure!(
            !grant.collections.is_empty()
                && grant.collections.len() <= 64
                && grant.collections.iter().all(|c| super::manifest::nsid(c))
                && grant
                    .collections
                    .iter()
                    .collect::<std::collections::BTreeSet<_>>()
                    .len()
                    == grant.collections.len(),
            "invalid collections"
        );
        Ok(grant)
    }
    fn check(&self, did: &str, collection: &str, rkey: &str) -> Result<()> {
        // DID-only avoids handle resolution or appview fallback. This API covers
        // public account repositories, never Spaces or private preferences.
        let plc = did.len() == 32
            && did.starts_with("did:plc:")
            && did[8..]
                .bytes()
                .all(|c| c.is_ascii_lowercase() || (b'2'..=b'7').contains(&c));
        let web = did.starts_with("did:web:")
            && did.len() > 8
            && did.len() <= 2048
            && did[8..]
                .bytes()
                .all(|c| c.is_ascii_alphanumeric() || b".:%_-".contains(&c));
        ensure!(plc || web, "invalid DID");
        ensure!(
            self.collections.iter().any(|c| c == collection),
            "collection denied"
        );
        ensure!(
            !rkey.is_empty()
                && rkey.len() <= 512
                && rkey != "."
                && rkey != ".."
                && rkey
                    .bytes()
                    .all(|c| c.is_ascii_alphanumeric() || b"._~:-".contains(&c)),
            "invalid record key"
        );
        Ok(())
    }
}

pub struct Reader {
    origin: Url,
}
impl Reader {
    pub fn new(origin: &str) -> Result<Self> {
        let origin = Url::parse(origin)?;
        // A dedicated trusted local-PDS capability, independent of outbound
        // network.request. No DNS, proxy, credentials, guest URL or redirects.
        ensure!(
            origin.scheme() == "http"
                && origin.username().is_empty()
                && origin.password().is_none()
                && origin.query().is_none()
                && origin.fragment().is_none()
                && origin.path() == "/"
                && origin
                    .host_str()
                    .and_then(|h| h.trim_matches(['[', ']']).parse::<IpAddr>().ok())
                    .is_some_and(|ip| ip.is_loopback()),
            "local PDS origin required"
        );
        Ok(Self { origin })
    }
    async fn fetch(
        &self,
        client: &Client,
        method: &str,
        query: &[(&str, &str)],
        bound: usize,
    ) -> Result<Vec<u8>> {
        let mut url = self.origin.join(&format!("/xrpc/{method}"))?;
        url.query_pairs_mut().extend_pairs(query.iter().copied());
        let mut response = client.get(url).send().await?;
        ensure!(response.status() == reqwest::StatusCode::OK, "read refused");
        ensure!(
            response.content_length().is_none_or(|n| n <= bound as u64),
            "result exceeds limit"
        );
        let mut bytes = Vec::new();
        while let Some(chunk) = response.chunk().await? {
            ensure!(bytes.len() + chunk.len() <= bound, "result exceeds limit");
            bytes.extend_from_slice(&chunk);
        }
        Ok(bytes)
    }
    async fn status(&self, client: &Client, did: &str) -> Result<String> {
        let status: Value = serde_json::from_slice(
            &self
                .fetch(
                    client,
                    "com.atproto.sync.getRepoStatus",
                    &[("did", did)],
                    4096,
                )
                .await?,
        )?;
        // getRepoStatus consults the local account DB, including takedowns and
        // deactivations. Unknown/remote DIDs fail, even with appview configured.
        ensure!(
            status["did"] == did && status["active"] == true && status.get("status").is_none(),
            "account unavailable"
        );
        Ok(status["rev"]
            .as_str()
            .filter(|rev| !rev.is_empty() && rev.len() <= 128)
            .ok_or_else(|| anyhow::anyhow!("missing revision"))?
            .to_owned())
    }
    async fn record(
        &self,
        client: &Client,
        did: &str,
        collection: &str,
        rkey: &str,
    ) -> Result<Value> {
        let record: Value = serde_json::from_slice(
            &self
                .fetch(
                    client,
                    "com.atproto.repo.getRecord",
                    &[("repo", did), ("collection", collection), ("rkey", rkey)],
                    MAX_RESULT,
                )
                .await?,
        )?;
        ensure!(
            record["uri"] == format!("at://{did}/{collection}/{rkey}")
                && record["cid"].is_string()
                && record["value"].is_object(),
            "invalid record"
        );
        Ok(record)
    }
    async fn read(
        &self,
        did: &str,
        collection: &str,
        rkey: &str,
        cid: Option<&str>,
    ) -> Result<Vec<u8>> {
        let client = Client::builder()
            .no_proxy()
            .redirect(reqwest::redirect::Policy::none())
            .http1_only()
            .pool_max_idle_per_host(0)
            .build()?;
        let revision = self.status(&client, did).await?;
        let record = self.record(&client, did, collection, rkey).await?;
        let output = if let Some(cid) = cid {
            ensure!(
                cid.len() <= 128
                    && cid.starts_with('b')
                    && cid
                        .bytes()
                        .all(|b| b.is_ascii_lowercase() || (b'2'..=b'7').contains(&b)),
                "invalid CID"
            );
            ensure!(
                references_blob(&record["value"], cid),
                "blob is not referenced by this record"
            );
            // getBlob checks this DID's blob store and blob takedown state.
            // A typed reference is necessary but never sufficient on its own.
            self.fetch(
                &client,
                "com.atproto.sync.getBlob",
                &[("did", did), ("cid", cid)],
                MAX_RESULT,
            )
            .await?
        } else {
            serde_json::to_vec(&record)?
        };
        ensure!(output.len() <= MAX_RESULT, "result exceeds limit");
        // No data cache. Also recheck record visibility: record takedown need
        // not change repo rev. Changed/deleted refs and account state fail closed.
        ensure!(
            self.record(&client, did, collection, rkey).await? == record,
            "record changed"
        );
        if let Some(cid) = cid {
            ensure!(
                self.fetch(
                    &client,
                    "com.atproto.sync.getBlob",
                    &[("did", did), ("cid", cid)],
                    MAX_RESULT
                )
                .await?
                    == output,
                "blob changed"
            );
        }
        ensure!(
            self.status(&client, did).await? == revision,
            "repository changed"
        );
        Ok(output)
    }
}
fn references_blob(value: &Value, cid: &str) -> bool {
    match value {
        Value::Object(map) => {
            (map.get("$type").and_then(Value::as_str) == Some("blob")
                && value["ref"]["$link"] == cid
                && value["mimeType"].is_string()
                && value["size"].as_u64().is_some())
                || map.values().any(|v| references_blob(v, cid))
        }
        Value::Array(items) => items.iter().any(|v| references_blob(v, cid)),
        _ => false,
    }
}
fn runtime() -> &'static tokio::runtime::Runtime {
    static RUNTIME: std::sync::OnceLock<tokio::runtime::Runtime> = std::sync::OnceLock::new();
    RUNTIME.get_or_init(|| {
        tokio::runtime::Builder::new_multi_thread()
            .worker_threads(1)
            .enable_all()
            .build()
            .expect("public read runtime")
    })
}
impl super::CallState {
    fn public_read(
        &mut self,
        did: String,
        collection: String,
        rkey: String,
        cid: Option<String>,
    ) -> Result<std::result::Result<Vec<u8>, String>> {
        self.check_deadline()?;
        let grant = if cid.is_some() {
            &self.blobs_grant
        } else {
            &self.records_grant
        };
        let Some(grant) = grant else {
            return Ok(Err("public read capability denied".into()));
        };
        if grant.check(&did, &collection, &rkey).is_err() {
            return Ok(Err("public read scope denied".into()));
        }
        if self.public_calls >= MAX_CALLS || self.public_bytes >= MAX_TOTAL {
            return Ok(Err("public read quota exceeded".into()));
        }
        self.public_calls += 1;
        let Some(reader) = self.public_reader.clone() else {
            return Ok(Err("public read unavailable".into()));
        };
        let remaining = self.deadline.saturating_duration_since(Instant::now());
        let result = runtime().block_on(async {
            tokio::time::timeout(
                remaining,
                reader.read(&did, &collection, &rkey, cid.as_deref()),
            )
            .await
        });
        self.check_deadline()?;
        Ok(match result {
            Ok(Ok(bytes)) if self.public_bytes + bytes.len() <= MAX_TOTAL => {
                self.public_bytes += bytes.len();
                Ok(bytes)
            }
            // Never echo PDS errors, internal URLs, paths or response bodies.
            _ => Err("public read denied or failed".into()),
        })
    }
}
impl super::pirs::sandbox::records_read::Host for super::CallState {
    fn get(
        &mut self,
        did: String,
        collection: String,
        rkey: String,
    ) -> Result<std::result::Result<String, String>> {
        Ok(self
            .public_read(did, collection, rkey, None)?
            .map(|v| String::from_utf8(v).expect("serialized JSON")))
    }
}
impl super::pirs::sandbox::blobs_read::Host for super::CallState {
    fn get(
        &mut self,
        did: String,
        collection: String,
        rkey: String,
        cid: String,
    ) -> Result<std::result::Result<Vec<u8>, String>> {
        self.public_read(did, collection, rkey, Some(cid))
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn exact_scopes_origins_and_typed_refs() {
        for value in [
            serde_json::json!({"collections": []}),
            serde_json::json!({"collections": ["*"]}),
            serde_json::json!({"collections": ["a.b.c", "a.b.c"]}),
            serde_json::json!({"collections": ["a.b.c"], "spaces": true}),
        ] {
            assert!(Grant::parse(&value).is_err());
        }
        let grant = Grant::parse(&serde_json::json!({"collections": ["tv.123.asset"]})).unwrap();
        assert!(
            grant
                .check("did:plc:abcdefghijklmnopqrstuvwx", "tv.123.asset", "key")
                .is_ok()
        );
        for (did, collection, key) in [
            ("alice.test", "tv.123.asset", "key"),
            ("did:plc:abcdefghijklmnopqrstuvwx", "Tv.123.asset", "key"),
            (
                "did:plc:abcdefghijklmnopqrstuvwx",
                "tv.123.asset",
                "../secret",
            ),
        ] {
            assert!(grant.check(did, collection, key).is_err());
        }
        for url in [
            "http://localhost/",
            "https://127.0.0.1/",
            "http://10.0.0.1/",
            "http://127.0.0.1/private",
            "http://u@127.0.0.1/",
            "http://127.0.0.1/?secret=x",
        ] {
            assert!(Reader::new(url).is_err());
        }
        assert!(Reader::new("http://127.0.0.1:2597").is_ok());
        assert!(!references_blob(
            &serde_json::json!({"ref": {"$link": "cid"}}),
            "cid"
        ));
        assert!(references_blob(
            &serde_json::json!({"nested": [{"$type": "blob", "ref": {"$link": "cid"}, "mimeType": "text/plain", "size": 1}]}),
            "cid"
        ));
    }
}
