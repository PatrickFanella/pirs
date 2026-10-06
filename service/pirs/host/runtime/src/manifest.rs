use anyhow::{Result, bail, ensure};
use serde::{Deserialize, Serialize};
use serde_json::{Value, json};
use sha2::{Digest, Sha256};
use std::{
    collections::BTreeSet,
    fs,
    io::{Read, Write},
    path::Path,
};
use wasmtime::{
    Engine,
    component::{Component, types::ComponentItem},
};

pub const MAX_ARTIFACT: u64 = 16 * 1024 * 1024;
const MAX_MANIFEST: u64 = 64 * 1024;

#[derive(Clone, Deserialize, Serialize)]
#[serde(deny_unknown_fields, rename_all = "camelCase")]
pub struct Manifest {
    schema_version: u32,
    pub id: String,
    min_spec_level: u32,
    hooks: Vec<String>,
    capabilities: Vec<Capability>,
}

#[derive(Clone, Deserialize, Serialize)]
#[serde(deny_unknown_fields)]
struct Capability {
    name: String,
    constraints: Value,
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields, rename_all = "camelCase")]
struct Subscription {
    event_types: Vec<String>,
    collections: Vec<String>,
}

#[derive(Deserialize, Serialize, PartialEq)]
#[serde(deny_unknown_fields, rename_all = "camelCase")]
pub struct Receipt {
    schema_version: u32,
    pub installation_id: String,
    artifact_sha256: String,
    manifest_sha256: String,
    imports: Vec<String>,
}

pub fn read_bounded(path: &Path, ceiling: u64) -> Result<Vec<u8>> {
    let mut bytes = Vec::new();
    fs::File::open(path)?
        .take(ceiling + 1)
        .read_to_end(&mut bytes)?;
    ensure!(bytes.len() as u64 <= ceiling, "file exceeds size ceiling");
    Ok(bytes)
}

fn digest(bytes: &[u8]) -> String {
    format!("{:x}", Sha256::digest(bytes))
}

fn unique(values: &[String]) -> bool {
    values.iter().collect::<BTreeSet<_>>().len() == values.len()
}

// Mirrors @atproto/syntax 0.7.6: only the first authority label and
// final name must start with a letter; the name cannot contain hyphens.
fn nsid(value: &str) -> bool {
    let parts: Vec<_> = value.split('.').collect();
    value.len() <= 317
        && parts.len() >= 3
        && parts.iter().all(|part| {
            !part.is_empty()
                && part.len() <= 63
                && part.as_bytes()[0].is_ascii_alphanumeric()
                && part
                    .as_bytes()
                    .last()
                    .is_some_and(u8::is_ascii_alphanumeric)
                && part.bytes().all(|c| c.is_ascii_alphanumeric() || c == b'-')
        })
        && parts[0].as_bytes()[0].is_ascii_alphabetic()
        && parts.last().is_some_and(|name| {
            name.as_bytes()[0].is_ascii_alphabetic()
                && name.bytes().all(|c| c.is_ascii_alphanumeric())
        })
}

fn reserved_xrpc(value: &str) -> bool {
    let authority = value
        .rsplit_once('.')
        .map_or("", |(authority, _)| authority);
    let authority = authority.to_ascii_lowercase();
    ["com.atproto", "app.bsky"]
        .iter()
        .any(|reserved| authority == *reserved || authority.starts_with(&format!("{reserved}.")))
}

#[derive(Clone, Deserialize, Serialize)]
#[serde(deny_unknown_fields, rename_all = "camelCase")]
pub struct HttpGrant {
    pub routes: Vec<String>,
    pub request_bytes: usize,
    pub response_bytes: usize,
    pub deadline_ms: u64,
}

fn http_route(path: &str) -> bool {
    path.starts_with('/')
        && path.len() <= 256
        && !path.contains("//")
        && !path.contains("..")
        && path
            .bytes()
            .all(|c| c.is_ascii_alphanumeric() || b"/-_.".contains(&c))
        && !["/xrpc", "/oauth", "/.well-known"]
            .iter()
            .any(|prefix| path == *prefix || path.starts_with(&format!("{prefix}/")))
}

impl Manifest {
    pub fn parse(bytes: &[u8]) -> Result<Self> {
        let manifest: Self = serde_json::from_slice(bytes)?;
        ensure!(manifest.schema_version == 1, "unsupported manifest version");
        ensure!(manifest.min_spec_level <= 1, "unsupported spec level");
        ensure!(
            !manifest.id.is_empty()
                && manifest.id.len() <= 128
                && manifest
                    .id
                    .bytes()
                    .all(|c| c.is_ascii_lowercase() || c.is_ascii_digit() || c == b'-'),
            "invalid plugin id"
        );
        ensure!(unique(&manifest.hooks), "duplicate hook");
        let names: Vec<_> = manifest
            .capabilities
            .iter()
            .map(|cap| cap.name.clone())
            .collect();
        ensure!(unique(&names), "duplicate capability");
        for capability in &manifest.capabilities {
            match capability.name.as_str() {
                "diagnostics.log" => ensure!(
                    capability.constraints == json!({}),
                    "unknown diagnostics constraint"
                ),
                "network.request" => {
                    crate::network::Grant::parse(&capability.constraints)?;
                }
                "kv.read" | "kv.write" => {
                    crate::kv::quota(&capability.constraints)?;
                }
                "xrpc.serve" => {
                    #[derive(Deserialize)]
                    #[serde(deny_unknown_fields)]
                    struct Methods {
                        nsids: Vec<String>,
                    }
                    let grant: Methods = serde_json::from_value(capability.constraints.clone())?;
                    ensure!(
                        !grant.nsids.is_empty() && grant.nsids.len() <= 64 && unique(&grant.nsids),
                        "invalid XRPC methods"
                    );
                    ensure!(
                        grant.nsids.iter().all(|n| nsid(n) && !reserved_xrpc(n)),
                        "invalid or reserved XRPC method"
                    );
                    ensure!(
                        manifest.min_spec_level == 1
                            && manifest.hooks.contains(&"xrpc.serve".to_owned()),
                        "XRPC requires level 1 and hook"
                    );
                }
                "http.serve" => {
                    let grant: HttpGrant = serde_json::from_value(capability.constraints.clone())?;
                    ensure!(
                        !grant.routes.is_empty()
                            && grant.routes.len() <= 64
                            && unique(&grant.routes)
                            && grant.routes.iter().all(|p| http_route(p)),
                        "invalid HTTP routes"
                    );
                    ensure!(
                        (1..=8192).contains(&grant.request_bytes)
                            && (1..=16384).contains(&grant.response_bytes)
                            && (1..=1000).contains(&grant.deadline_ms),
                        "invalid HTTP limits"
                    );
                    ensure!(
                        manifest.min_spec_level == 1
                            && manifest.hooks.contains(&"http.serve".to_owned()),
                        "HTTP requires level 1 and hook"
                    );
                }
                "events.subscribe" => {
                    let grant: Subscription =
                        serde_json::from_value(capability.constraints.clone())?;
                    ensure!(
                        !grant.event_types.is_empty() && unique(&grant.event_types),
                        "invalid event types"
                    );
                    ensure!(
                        grant.event_types.iter().all(
                            |t| ["commit", "sync", "identity", "account"].contains(&t.as_str())
                        ),
                        "unknown event type"
                    );
                    ensure!(
                        !grant.collections.is_empty() && unique(&grant.collections),
                        "invalid collections"
                    );
                    ensure!(
                        grant.collections == ["*"] || grant.collections.iter().all(|c| nsid(c)),
                        "invalid collection constraint"
                    );
                    let hooks: BTreeSet<_> = grant
                        .event_types
                        .iter()
                        .map(|t| format!("event.{t}"))
                        .collect();
                    ensure!(
                        hooks
                            == manifest
                                .hooks
                                .iter()
                                .filter(|h| !["xrpc.serve", "http.serve"].contains(&h.as_str()))
                                .cloned()
                                .collect(),
                        "hooks must match subscription event types"
                    );
                }
                // Shared spec vocabulary. Recognition never grants a capability
                // that this runtime has no implementation for.
                "records.read" | "records.write" | "blobs.read" | "record.validate"
                | "record.unique" | "account.create" | "auth.session" => {
                    bail!("capability is not supported by this runtime")
                }
                _ => bail!("unknown capability category or operation"),
            }
        }
        ensure!(
            manifest
                .hooks
                .iter()
                .all(|h| if ["xrpc.serve", "http.serve"].contains(&h.as_str()) {
                    manifest.has(h)
                } else {
                    manifest.has("events.subscribe")
                }),
            "hooks require events.subscribe"
        );
        ensure!(
            (manifest.min_spec_level == 1)
                == (manifest.has("xrpc.serve") || manifest.has("http.serve")),
            "level 1 requires a serving grant"
        );
        if manifest.has("kv.read") && manifest.has("kv.write") {
            ensure!(
                manifest.kv_quota("kv.read") == manifest.kv_quota("kv.write"),
                "KV quotas must match"
            );
        }
        Ok(manifest)
    }

    pub fn http_grant(&self) -> Option<HttpGrant> {
        self.capabilities
            .iter()
            .find(|c| c.name == "http.serve")
            .map(|c| serde_json::from_value(c.constraints.clone()).expect("validated HTTP grant"))
    }

    pub fn xrpc_nsids(&self) -> Vec<String> {
        self.capabilities
            .iter()
            .find(|c| c.name == "xrpc.serve")
            .map(|c| {
                serde_json::from_value(c.constraints["nsids"].clone()).expect("validated NSIDs")
            })
            .unwrap_or_default()
    }

    // Only the trusted HTTP supervisor writes this envelope after service auth.
    // Independently enforce the installed method grant before guest allocation.
    pub fn input(&self, input: &str) -> Result<Option<String>> {
        if let Some(raw) = input.strip_prefix("xrpc:") {
            #[derive(Deserialize)]
            #[serde(deny_unknown_fields)]
            struct Call {
                nsid: String,
                method: String,
                issuer: String,
                query: String,
                body: Option<Value>,
            }
            let call: Call = serde_json::from_str(raw)?;
            ensure!(self.xrpc_nsids().contains(&call.nsid), "undeclared NSID");
            ensure!(
                ["GET", "POST"].contains(&call.method.as_str()),
                "invalid HTTP method"
            );
            ensure!(
                call.issuer.starts_with("did:plc:")
                    && call.issuer.len() == 32
                    && call.issuer[8..]
                        .bytes()
                        .all(|c| c.is_ascii_lowercase() || (b'2'..=b'7').contains(&c)),
                "invalid issuer"
            );
            ensure!(
                call.query.len() <= 8192 && (call.method == "POST" || call.body.is_none()),
                "invalid request"
            );
            return Ok(Some(input.to_owned()));
        }
        if let Some(raw) = input.strip_prefix("http:") {
            #[derive(Deserialize)]
            #[serde(deny_unknown_fields)]
            struct Call {
                path: String,
                method: String,
                query: String,
                body: String,
            }
            let call: Call = serde_json::from_str(raw)?;
            let grant = self
                .http_grant()
                .ok_or_else(|| anyhow::anyhow!("no HTTP grant"))?;
            ensure!(
                grant.routes.contains(&call.path) && http_route(&call.path),
                "undeclared route"
            );
            ensure!(
                ["GET", "POST"].contains(&call.method.as_str())
                    && call.query.len() <= 1024
                    && call.body.len() <= grant.request_bytes
                    && (call.method == "POST" || call.body.is_empty()),
                "invalid HTTP request"
            );
            return Ok(Some(input.to_owned()));
        }
        self.event_input(input)
    }

    pub fn network_grant(&self) -> Option<crate::network::Grant> {
        self.capabilities
            .iter()
            .find(|c| c.name == "network.request")
            .map(|c| crate::network::Grant::parse(&c.constraints).expect("validated grant"))
    }

    pub fn kv_quota(&self, name: &str) -> Option<usize> {
        self.capabilities
            .iter()
            .find(|c| c.name == name)
            .map(|c| crate::kv::quota(&c.constraints).expect("validated quota"))
    }

    pub fn has(&self, name: &str) -> bool {
        self.capabilities.iter().any(|c| c.name == name)
    }

    pub fn check_imports(&self, engine: &Engine, component: &Component) -> Result<Vec<String>> {
        let mut imports = Vec::new();
        for (name, item) in component.component_type().imports(engine) {
            let (capability, allowed_operations): (&str, &[&str]) = match name {
                "pirs:sandbox/diagnostics@0.1.0" => ("diagnostics.log", &["log"]),
                "pirs:sandbox/network@0.1.0" => ("network.request", &["request"]),
                "pirs:sandbox/kv-read@0.1.0" => ("kv.read", &["get", "list"]),
                "pirs:sandbox/kv-write@0.1.0" => ("kv.write", &["set"]),
                _ => bail!("unsupported component import"),
            };
            ensure!(self.has(capability), "undeclared capability import");
            let ComponentItem::ComponentInstance(instance) = item else {
                bail!("invalid import kind")
            };
            for (operation, item) in instance.exports(engine) {
                // The network result record is a WIT type, not authority.
                // instantiate_pre below verifies its complete shape.
                if capability == "network.request"
                    && operation == "response"
                    && matches!(item, ComponentItem::Type(_))
                {
                    continue;
                }
                ensure!(
                    allowed_operations.contains(&operation)
                        && matches!(item, ComponentItem::ComponentFunc(_)),
                    "unsupported import operation"
                );
                imports.push(format!("{name}.{operation}"));
            }
        }
        imports.sort();
        Ok(imports)
    }

    // Events arrive as data, not a guest-controlled subscribe call. This check
    // runs before Store creation even when the supervisor is bypassed.
    pub fn event_input(&self, input: &str) -> Result<Option<String>> {
        let raw = input
            .strip_prefix("event:")
            .ok_or_else(|| anyhow::anyhow!("installed plugins accept only events"))?;
        let event: Value = serde_json::from_str(raw)?;
        let seq = event["seq"]
            .as_u64()
            .filter(|s| *s <= 9_007_199_254_740_991)
            .ok_or_else(|| anyhow::anyhow!("invalid sequence"))?;
        let kind = event["type"]
            .as_str()
            .ok_or_else(|| anyhow::anyhow!("missing type"))?;
        ensure!(
            ["commit", "sync", "identity", "account"].contains(&kind),
            "unknown event type"
        );
        ensure!(
            event["time"].is_string() && event["evt"].is_object(),
            "invalid event envelope"
        );
        let Some(capability) = self
            .capabilities
            .iter()
            .find(|c| c.name == "events.subscribe")
        else {
            return Ok(None);
        };
        let grant: Subscription = serde_json::from_value(capability.constraints.clone())?;
        if !grant.event_types.iter().any(|t| t == kind) {
            return Ok(None);
        }
        if grant.collections == ["*"] {
            return Ok(Some(input.to_owned()));
        }
        // Sync CARs have no collection boundaries. Account/identity events have
        // no collection. Only a projected commit can satisfy a scoped grant.
        if kind != "commit" {
            return Ok(None);
        }
        let ops = event["evt"]["ops"]
            .as_array()
            .ok_or_else(|| anyhow::anyhow!("missing commit ops"))?;
        let mut permitted = Vec::new();
        for op in ops {
            let path = op["path"]
                .as_str()
                .ok_or_else(|| anyhow::anyhow!("invalid op path"))?;
            let (collection, rkey) = path
                .split_once('/')
                .ok_or_else(|| anyhow::anyhow!("invalid record path"))?;
            ensure!(
                nsid(collection) && !rkey.is_empty() && !rkey.contains('/'),
                "invalid record path"
            );
            let action = op["action"]
                .as_str()
                .ok_or_else(|| anyhow::anyhow!("missing action"))?;
            ensure!(
                ["create", "update", "delete"].contains(&action),
                "invalid action"
            );
            if grant.collections.iter().any(|c| c == collection) {
                permitted.push(json!({"path": path, "action": action}));
            }
        }
        if permitted.is_empty() {
            return Ok(None);
        }
        // CARs and unknown fields can contain records from other collections,
        // including in a single-collection commit. Pass only safe metadata.
        let projected = json!({"seq": seq, "type": kind, "time": event["time"],
            "evt": {"repo": event["evt"]["repo"].as_str(), "rev": event["evt"]["rev"].as_str(), "ops": permitted}});
        Ok(Some(format!(
            "event:{}",
            serde_json::to_string(&projected)?
        )))
    }
}

pub fn receipt(artifact: &[u8], manifest: &[u8], imports: Vec<String>) -> Receipt {
    let artifact_sha256 = digest(artifact);
    let manifest_sha256 = digest(manifest);
    let installation_id =
        digest(format!("pirs-install-v1\0{artifact_sha256}\0{manifest_sha256}").as_bytes());
    Receipt {
        schema_version: 1,
        installation_id,
        artifact_sha256,
        manifest_sha256,
        imports,
    }
}

pub fn load(path: &Path, engine: &Engine) -> Result<(Vec<u8>, Manifest, Receipt)> {
    let artifact = read_bounded(&path.join("plugin.wasm"), MAX_ARTIFACT)?;
    let bytes = read_bounded(&path.join("manifest.json"), MAX_MANIFEST)?;
    let manifest = Manifest::parse(&bytes)?;
    let component = Component::new(engine, &artifact)?;
    let expected = receipt(
        &artifact,
        &bytes,
        manifest.check_imports(engine, &component)?,
    );
    let recorded: Receipt =
        serde_json::from_slice(&read_bounded(&path.join("receipt.json"), MAX_MANIFEST)?)?;
    ensure!(
        recorded == expected
            && path.file_name().and_then(|s| s.to_str()) == Some(expected.installation_id.as_str()),
        "installation checksum mismatch; reinstall changed artifact"
    );
    Ok((artifact, manifest, expected))
}

pub fn install(
    root: &Path,
    artifact: &[u8],
    manifest: &[u8],
    record: &Receipt,
    engine: &Engine,
) -> Result<std::path::PathBuf> {
    use std::os::unix::fs::{DirBuilderExt, OpenOptionsExt};
    fs::DirBuilder::new()
        .recursive(true)
        .mode(0o700)
        .create(root)?;
    let destination = root.join(&record.installation_id);
    if destination.exists() {
        load(&destination, engine)?;
        return Ok(destination);
    }
    let staging = root.join(format!(
        ".install-{}-{}",
        std::process::id(),
        std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)?
            .as_nanos()
    ));
    fs::DirBuilder::new().mode(0o700).create(&staging)?;
    let result = (|| -> Result<()> {
        for (name, bytes) in [
            ("plugin.wasm", artifact),
            ("manifest.json", manifest),
            (
                "receipt.json",
                serde_json::to_vec_pretty(record)?.as_slice(),
            ),
        ] {
            let mut file = fs::OpenOptions::new()
                .write(true)
                .create_new(true)
                .mode(0o600)
                .open(staging.join(name))?;
            file.write_all(bytes)?;
            file.sync_all()?;
        }
        fs::File::open(&staging)?.sync_all()?;
        match fs::rename(&staging, &destination) {
            Ok(()) => {}
            Err(error) if destination.exists() => {
                load(&destination, engine)?;
                let _ = error;
            }
            Err(error) => return Err(error.into()),
        }
        fs::File::open(root)?.sync_all()?;
        Ok(())
    })();
    if staging.exists() {
        fs::remove_dir_all(&staging)?;
    }
    result?;
    Ok(destination)
}

pub fn read_manifest(path: &Path) -> Result<Vec<u8>> {
    read_bounded(path, MAX_MANIFEST)
}

#[cfg(test)]
mod nsid_tests {
    use super::*;

    #[test]
    fn atproto_nsid_syntax() {
        for valid in ["tv.123.echo", "tv.a-b.echo", "Tv.Test.echo2", "a.b.c"] {
            assert!(nsid(valid), "{valid}");
        }
        for invalid in [
            "tv.test.bad-name",
            "1tv.test.echo",
            "tv.-test.echo",
            "tv.test-.echo",
            "tv.test.1echo",
            "tv..echo",
            "tv.test.écho",
        ] {
            assert!(!nsid(invalid), "{invalid}");
        }
    }

    #[test]
    fn reserved_xrpc_authority_is_case_insensitive() {
        for method in ["Com.Atproto.repo.describeRepo", "APP.Bsky.feed.getTimeline"] {
            let manifest = json!({"schemaVersion": 1, "id": "test", "minSpecLevel": 1,
                "hooks": ["xrpc.serve"], "capabilities": [{"name": "xrpc.serve", "constraints": {"nsids": [method]}}]});
            assert!(
                Manifest::parse(&serde_json::to_vec(&manifest).unwrap()).is_err(),
                "{method}"
            );
        }
    }

    #[test]
    fn numeric_collection_projection_preserves_exact_grants() {
        let value = json!({"schemaVersion": 1, "id": "test", "minSpecLevel": 0,
            "hooks": ["event.commit"], "capabilities": [{"name": "events.subscribe", "constraints": {
                "eventTypes": ["commit"], "collections": ["tv.123.echo"]}}]});
        let manifest = Manifest::parse(&serde_json::to_vec(&value).unwrap()).unwrap();
        let event = json!({"seq": 1, "type": "commit", "time": "now", "evt": {
            "repo": "did:plc:test", "rev": "1", "blocks": "private", "ops": [
                {"path": "tv.123.echo/a", "action": "create"},
                {"path": "Tv.123.echo/b", "action": "create"},
                {"path": "tv.other.echo/c", "action": "delete"}]}});
        let filtered = manifest
            .event_input(&format!("event:{event}"))
            .unwrap()
            .unwrap();
        let projected: Value =
            serde_json::from_str(filtered.strip_prefix("event:").unwrap()).unwrap();
        assert_eq!(
            projected["evt"]["ops"],
            json!([{"path": "tv.123.echo/a", "action": "create"}])
        );
        assert!(projected["evt"].get("blocks").is_none());
    }
}
