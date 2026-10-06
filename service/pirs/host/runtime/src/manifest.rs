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
    id: String,
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

fn nsid(value: &str) -> bool {
    let parts: Vec<_> = value.split('.').collect();
    value.len() <= 317
        && parts.len() >= 3
        && parts.iter().all(|part| {
            !part.is_empty()
                && part.len() <= 63
                && part.as_bytes()[0].is_ascii_alphabetic()
                && part
                    .as_bytes()
                    .last()
                    .is_some_and(u8::is_ascii_alphanumeric)
                && part.bytes().all(|c| c.is_ascii_alphanumeric() || c == b'-')
        })
}

impl Manifest {
    pub fn parse(bytes: &[u8]) -> Result<Self> {
        let manifest: Self = serde_json::from_slice(bytes)?;
        ensure!(manifest.schema_version == 1, "unsupported manifest version");
        ensure!(manifest.min_spec_level == 0, "unsupported spec level");
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
                        hooks == manifest.hooks.iter().cloned().collect(),
                        "hooks must match subscription event types"
                    );
                }
                // Shared spec vocabulary. Recognition never grants a capability
                // that this runtime has no implementation for.
                "xrpc.serve" | "http.serve" | "records.read" | "records.write" | "blobs.read"
                | "network.request" | "kv.read" | "kv.write" | "record.validate"
                | "record.unique" | "account.create" | "auth.session" => {
                    bail!("capability is not supported by this runtime")
                }
                _ => bail!("unknown capability category or operation"),
            }
        }
        ensure!(
            manifest.hooks.is_empty() || manifest.has("events.subscribe"),
            "hooks require events.subscribe"
        );
        Ok(manifest)
    }

    fn has(&self, name: &str) -> bool {
        self.capabilities.iter().any(|c| c.name == name)
    }

    pub fn check_imports(&self, engine: &Engine, component: &Component) -> Result<Vec<String>> {
        let mut imports = Vec::new();
        for (name, item) in component.component_type().imports(engine) {
            ensure!(
                name == "pirs:sandbox/diagnostics@0.1.0",
                "unsupported component import"
            );
            ensure!(self.has("diagnostics.log"), "undeclared diagnostics import");
            let ComponentItem::ComponentInstance(instance) = item else {
                bail!("invalid import kind")
            };
            for (operation, item) in instance.exports(engine) {
                ensure!(
                    operation == "log" && matches!(item, ComponentItem::ComponentFunc(_)),
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
