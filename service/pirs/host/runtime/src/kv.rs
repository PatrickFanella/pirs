use anyhow::{Context, Result, ensure};
use serde::Deserialize;
use serde_json::Value;
use std::{
    collections::BTreeMap,
    fs,
    io::{Read, Write},
    os::unix::fs::{DirBuilderExt, OpenOptionsExt},
    path::{Path, PathBuf},
    sync::Mutex,
};

type Data = BTreeMap<String, Vec<u8>>;
const MAX_QUOTA: usize = 1024 * 1024;

#[derive(Deserialize)]
#[serde(deny_unknown_fields, rename_all = "camelCase")]
struct Grant {
    quota_bytes: usize,
}
pub fn quota(value: &Value) -> Result<usize> {
    let grant: Grant = serde_json::from_value(value.clone())?;
    ensure!(
        (2..=MAX_QUOTA).contains(&grant.quota_bytes),
        "invalid KV quota"
    );
    Ok(grant.quota_bytes)
}
fn private_dir(path: &Path) -> Result<()> {
    private_dir_with_sync(path, |parent| Ok(fs::File::open(parent)?.sync_all()?))
}
fn private_dir_with_sync(path: &Path, mut sync: impl FnMut(&Path) -> Result<()>) -> Result<()> {
    ensure!(path.is_absolute(), "state directory must be absolute");
    let ancestors: Vec<_> = path.ancestors().collect();
    for directory in ancestors.into_iter().rev() {
        let Some(parent) = directory.parent() else {
            continue;
        };
        match fs::DirBuilder::new().mode(0o700).create(directory) {
            Ok(()) => (),
            Err(e) if e.kind() == std::io::ErrorKind::AlreadyExists => (),
            Err(e) => return Err(e.into()),
        }
        ensure!(
            fs::symlink_metadata(directory)?.file_type().is_dir(),
            "state directory must not be a symlink"
        );
        // Sync existing entries too: a prior attempt or concurrent creator may
        // have created the directory but failed before syncing its parent.
        sync(parent)?;
    }
    Ok(())
}
fn key(value: &str) -> Result<()> {
    ensure!(!value.is_empty() && value.len() <= 256, "invalid key");
    Ok(())
}

struct Namespace {
    directory: PathBuf,
    _lock: fs::File,
}
impl Namespace {
    fn open(root: &Path, id: &str) -> Result<Self> {
        ensure!(root.is_absolute(), "state root must be absolute");
        ensure!(
            !id.is_empty()
                && id
                    .bytes()
                    .all(|c| c.is_ascii_lowercase() || c.is_ascii_digit() || c == b'-'),
            "invalid namespace"
        );
        private_dir(root)?;
        // The lock lives outside the namespace so deletion cannot create a second
        // lock inode while another process still holds the original one.
        let lock = fs::OpenOptions::new()
            .read(true)
            .write(true)
            .create(true)
            .truncate(false)
            .mode(0o600)
            .custom_flags(libc::O_NOFOLLOW)
            .open(root.join(format!(".{id}.lock")))?;
        ensure!(
            unsafe {
                libc::flock(
                    std::os::fd::AsRawFd::as_raw_fd(&lock),
                    libc::LOCK_EX | libc::LOCK_NB,
                )
            } == 0,
            "plugin state is in use; stop its host first"
        );
        let directory = root.join(id);
        private_dir(&directory)?;
        Ok(Self {
            directory,
            _lock: lock,
        })
    }
    fn delete(&self) -> Result<()> {
        fs::remove_dir_all(&self.directory)?;
        fs::File::open(self.directory.parent().unwrap())?.sync_all()?;
        Ok(())
    }
}

pub struct Storage {
    namespace: Namespace,
    quota: usize,
    data: Mutex<Data>,
}
impl Storage {
    pub fn open(root: &Path, id: &str, quota: usize) -> Result<Self> {
        Self::load(Namespace::open(root, id)?, quota)
    }
    fn load(namespace: Namespace, quota: usize) -> Result<Self> {
        let path = namespace.directory.join("state.json");
        let data = match fs::OpenOptions::new()
            .read(true)
            .custom_flags(libc::O_NOFOLLOW)
            .open(&path)
        {
            Ok(file) => {
                let mut bytes = Vec::new();
                file.take(quota as u64 + 1).read_to_end(&mut bytes)?;
                ensure!(bytes.len() <= quota, "stored state exceeds quota");
                let data: Data = serde_json::from_slice(&bytes)?;
                for k in data.keys() {
                    key(k)?;
                }
                ensure!(
                    serde_json::to_vec(&data)?.len() <= quota,
                    "stored state exceeds quota"
                );
                data
            }
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => Data::new(),
            Err(e) => return Err(e.into()),
        };
        Ok(Self {
            namespace,
            quota,
            data: Mutex::new(data),
        })
    }
    fn bytes(&self) -> Result<Vec<u8>> {
        Ok(serde_json::to_vec(&*self.data.lock().unwrap())?)
    }
    fn get(&self, k: &str) -> Result<Option<Vec<u8>>> {
        key(k)?;
        Ok(self.data.lock().unwrap().get(k).cloned())
    }
    fn list(&self, prefix: &str) -> Result<Vec<String>> {
        ensure!(prefix.len() <= 256, "invalid prefix");
        let keys: Vec<_> = self
            .data
            .lock()
            .unwrap()
            .keys()
            .filter(|k| k.starts_with(prefix))
            .take(257)
            .cloned()
            .collect();
        ensure!(
            keys.len() <= 256 && serde_json::to_vec(&keys)?.len() <= 65536,
            "listing exceeds response bound; use a narrower prefix"
        );
        Ok(keys)
    }
    fn set(&self, k: &str, value: Option<Vec<u8>>) -> Result<()> {
        key(k)?;
        ensure!(
            value.as_ref().is_none_or(|v| v.len() <= self.quota),
            "quota exceeded"
        );
        let mut data = self.data.lock().unwrap();
        let mut next = data.clone();
        if let Some(v) = value {
            next.insert(k.to_owned(), v);
        } else {
            next.remove(k);
        }
        let bytes = serde_json::to_vec(&next)?;
        ensure!(bytes.len() <= self.quota, "quota exceeded");
        let staging = self.namespace.directory.join(".state.tmp");
        // A previous crash can leave this private, never-visible staging file.
        match fs::remove_file(&staging) {
            Ok(()) => (),
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => (),
            Err(e) => return Err(e.into()),
        }
        let mut file = fs::OpenOptions::new()
            .write(true)
            .create_new(true)
            .mode(0o600)
            .custom_flags(libc::O_NOFOLLOW)
            .open(&staging)?;
        file.write_all(&bytes)?;
        file.sync_all()?;
        fs::rename(&staging, self.namespace.directory.join("state.json"))?;
        // Keep memory aligned with the visible file even if directory sync fails.
        *data = next;
        fs::File::open(&self.namespace.directory)?.sync_all()?;
        Ok(())
    }
    fn export(&self, path: &Path) -> Result<()> {
        ensure!(path.is_absolute(), "export path must be absolute");
        let mut file = fs::OpenOptions::new()
            .write(true)
            .create_new(true)
            .mode(0o600)
            .custom_flags(libc::O_NOFOLLOW)
            .open(path)?;
        file.write_all(&self.bytes()?)?;
        file.sync_all()?;
        fs::File::open(path.parent().context("export parent")?)?.sync_all()?;
        Ok(())
    }
}

impl crate::CallState {
    fn storage(&mut self, write: bool) -> Result<std::sync::Arc<Storage>> {
        self.check_deadline()?;
        self.kv_calls += 1;
        ensure!(self.kv_calls <= 128, "KV call limit exceeded");
        ensure!(
            if write { self.kv_write } else { self.kv_read },
            "KV capability denied"
        );
        self.kv.clone().context("KV state unavailable")
    }
}
impl crate::pirs::sandbox::kv_read::Host for crate::CallState {
    fn get(&mut self, key: String) -> Result<Result<Option<Vec<u8>>, String>> {
        Ok(self
            .storage(false)
            .and_then(|s| s.get(&key))
            .map_err(|_| "KV read denied or unavailable".into()))
    }
    fn list(&mut self, prefix: String) -> Result<Result<Vec<String>, String>> {
        Ok(self
            .storage(false)
            .and_then(|s| s.list(&prefix))
            .map_err(|_| "KV listing denied or exceeds bound".into()))
    }
}
impl crate::pirs::sandbox::kv_write::Host for crate::CallState {
    fn set(&mut self, key: String, value: Option<Vec<u8>>) -> Result<Result<(), String>> {
        Ok(self
            .storage(true)
            .and_then(|s| s.set(&key, value))
            .map_err(|_| "KV write denied, unavailable, or quota exceeded".into()))
    }
}

pub fn operator(options: &crate::Options) -> Result<()> {
    let command = options.state_command.as_deref().unwrap();
    let action = if command == "uninstall" {
        options
            .state_action
            .as_deref()
            .context("uninstall requires --state-action retain, export, or delete")?
    } else {
        ensure!(
            options.state_action.is_none(),
            "state-action is only for uninstall"
        );
        command
    };
    ensure!(
        (action == "export") == options.export_path.is_some(),
        "export requires --export-path, other actions forbid it"
    );
    let installation = options.installation.as_ref().unwrap();
    let (_, manifest, _) = crate::manifest::load(installation, &wasmtime::Engine::default())?;
    let quota = manifest
        .kv_quota("kv.write")
        .or(manifest.kv_quota("kv.read"))
        .context("installation has no KV grant")?;
    let mut namespace = Some(Namespace::open(
        options.state_dir.as_ref().unwrap(),
        &manifest.id,
    )?);
    // Keep the same lock through installation removal, including export.
    let storage = if action == "export" {
        Some(Storage::load(namespace.take().unwrap(), quota)?)
    } else {
        None
    };
    let namespace = if let Some(storage) = &storage {
        storage.export(options.export_path.as_ref().unwrap())?;
        &storage.namespace
    } else {
        namespace.as_ref().unwrap()
    };
    if action == "delete" {
        namespace.delete()?;
    }
    if command == "uninstall" {
        // Export means export and retain. Deletion is always an explicit choice.
        fs::remove_dir_all(installation)?;
        fs::File::open(installation.parent().unwrap())?.sync_all()?;
    }
    println!(
        "{}",
        serde_json::json!({"stateCommand": command, "stateAction": action, "plugin": manifest.id})
    );
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn directory_creation_syncs_every_parent_and_retries_failures() -> Result<()> {
        let base = std::env::temp_dir().join(format!("pirs-kv-sync-{}", std::process::id()));
        let directory = base.join("ancestor/root/plugin");
        let mut expected: Vec<_> = directory
            .ancestors()
            .skip(1)
            .map(Path::to_path_buf)
            .collect();
        expected.reverse();
        for fail_at in 0..expected.len() {
            let mut observed = Vec::new();
            let result = private_dir_with_sync(&directory, |parent| {
                observed.push(parent.to_path_buf());
                if observed.len() - 1 == fail_at {
                    anyhow::bail!("injected directory sync failure");
                }
                Ok(fs::File::open(parent)?.sync_all()?)
            });
            assert!(result.is_err());
            assert_eq!(observed, expected[..=fail_at]);
            // Retry must sync even the entries left behind by the failed attempt.
            observed.clear();
            private_dir_with_sync(&directory, |parent| {
                observed.push(parent.to_path_buf());
                Ok(fs::File::open(parent)?.sync_all()?)
            })?;
            assert_eq!(observed, expected);
            let storage = Storage::open(directory.parent().unwrap(), "plugin", 32)?;
            storage.set("k", Some(vec![1]))?;
            drop(storage);
            fs::remove_dir_all(&base)?;
        }
        Ok(())
    }
    #[test]
    fn encoded_boundaries_and_callbacks() -> Result<()> {
        let root = std::env::temp_dir().join(format!("pirs-kv-bounds-{}", std::process::id()));
        let storage = Storage::open(&root, "boundary", 8)?;
        storage.set("k", Some(vec![]))?; // {"k":[]} is exactly eight bytes.
        assert_eq!(storage.bytes()?.len(), 8);
        assert!(storage.set("k", Some(vec![0])).is_err());
        assert!(storage.set("", None).is_err());
        assert!(storage.get(&"x".repeat(257)).is_err());
        drop(storage);
        let storage = Storage::open(&root, "listing", MAX_QUOTA)?;
        for i in 0..257 {
            storage.set(&format!("key{i:03}"), Some(vec![]))?;
        }
        assert!(storage.list("").is_err());
        assert_eq!(storage.list("key00")?.len(), 10);
        let mut state = crate::CallState::new(crate::Limits {
            memory_bytes: 1024,
            deadline_ms: 1000,
            response_bytes: 1024,
            log_bytes: 1024,
            input_bytes: 1024,
        });
        state.kv = Some(std::sync::Arc::new(storage));
        assert!(state.storage(false).is_err());
        assert!(state.storage(true).is_err());
        state.kv_read = true;
        state.kv_write = true;
        state.kv_calls = 127;
        assert!(state.storage(false).is_ok());
        assert!(state.storage(true).is_err());
        drop(state);
        fs::remove_dir_all(root)?;
        Ok(())
    }
    #[test]
    fn durable_quota_isolation_export_delete_and_lock() -> Result<()> {
        let root = std::env::temp_dir().join(format!("pirs-kv-unit-{}", std::process::id()));
        private_dir(&root)?;
        let a = Storage::open(&root, "a", 32)?;
        a.set("k", Some(vec![255]))?;
        assert!(a.set("k", Some(vec![255; 32])).is_err());
        assert_eq!(a.get("k")?, Some(vec![255]));
        assert!(Storage::open(&root, "a", 32).is_err());
        let b = Storage::open(&root, "b", 32)?;
        assert_eq!(b.get("k")?, None);
        assert_eq!(a.list("")?, vec!["k"]);
        a.export(&root.join("export.json"))?;
        assert_eq!(fs::read(root.join("export.json"))?, a.bytes()?);
        drop(a);
        let a = Storage::open(&root, "a", 32)?;
        assert_eq!(a.get("k")?, Some(vec![255]));
        a.set("k", None)?;
        assert_eq!(a.get("k")?, None);
        a.namespace.delete()?;
        drop(a);
        drop(b);
        fs::remove_dir_all(root)?;
        Ok(())
    }
}
