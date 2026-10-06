use anyhow::{Context, Result, bail, ensure};
use clap::Parser;
use serde::{Deserialize, Serialize};
use serde_json::json;
use std::{
    io::{BufRead, Write},
    path::PathBuf,
    time::{Duration, Instant},
};
use wasmtime::component::{Component, HasSelf, Linker};
use wasmtime::{Config, Engine, ResourceLimiter, Store, UpdateDeadline};

wasmtime::component::bindgen!({
    path: "../wit",
    world: "storage-sandbox",
    imports: { default: trappable },
});

const EPOCH_INTERVAL: Duration = Duration::from_millis(5);
mod kv;
mod manifest;
mod network;
mod public_read;

#[derive(Parser)]
#[command(
    name = "pirs-host",
    version,
    about = "Serve bounded WIT sandbox calls over JSON lines on stdin/stdout"
)]
struct Options {
    #[arg(long, value_name = "WASM_COMPONENT")]
    plugin: Option<PathBuf>,
    /// Private host state root, separate from PDS storage.
    #[arg(long, requires = "installation")]
    state_dir: Option<PathBuf>,
    /// Fixed anonymous local PDS origin for public reads, never guest-selected.
    #[arg(long, requires = "installation")]
    public_pds: Option<String>,
    /// Operator state command: export, delete, or uninstall.
    #[arg(long, requires_all = ["installation", "state_dir"], value_parser = ["export", "delete", "uninstall"])]
    state_command: Option<String>,
    /// Uninstall must explicitly retain, export, or delete state.
    #[arg(long, requires = "state_command", value_parser = ["retain", "export", "delete"])]
    state_action: Option<String>,
    /// New destination file for an export, never stdout.
    #[arg(long, requires = "state_command")]
    export_path: Option<PathBuf>,
    /// Manifest for a local file installation.
    #[arg(long, requires = "install_dir")]
    manifest: Option<PathBuf>,
    /// Validate and copy local bytes to a content-addressed installation.
    #[arg(long, requires_all = ["plugin", "manifest"], conflicts_with_all = ["installation", "qualification_only"])]
    install_dir: Option<PathBuf>,
    /// Run verified installed bytes, never the mutable source file.
    #[arg(long, conflicts_with_all = ["plugin", "qualification_only"])]
    installation: Option<PathBuf>,
    /// Raw component mode for isolated sandbox qualification only.
    #[arg(long, requires = "plugin")]
    qualification_only: bool,
    #[arg(long, default_value_t = 16, value_parser = clap::value_parser!(u64).range(1..=64))]
    memory_mib: u64,
    #[arg(long, default_value_t = 100, value_parser = clap::value_parser!(u64).range(1..=60_000))]
    deadline_ms: u64,
    #[arg(long, default_value_t = 4096, value_parser = clap::value_parser!(u32).range(2..=1_048_576))]
    response_bytes: u32,
    #[arg(long, default_value_t = 1024, value_parser = clap::value_parser!(u32).range(2..=1_048_576))]
    log_bytes: u32,
    #[arg(long, default_value_t = 16_384, value_parser = clap::value_parser!(u32).range(2..=1_048_576))]
    input_bytes: u32,
    /// Kill this runtime if its supervising delivery process dies (Linux).
    #[arg(long)]
    parent_pid: Option<u32>,
}

#[derive(Clone, Serialize)]
struct Limits {
    memory_bytes: usize,
    deadline_ms: u64,
    response_bytes: usize,
    log_bytes: usize,
    input_bytes: usize,
}

#[derive(Clone, Copy, Serialize)]
#[serde(rename_all = "snake_case")]
enum Failure {
    Trap,
    Timeout,
    MemoryLimit,
    ResponseLimit,
    LogLimit,
    InvalidRequest,
}

struct CallState {
    limits: Limits,
    deadline: Instant,
    failure: Option<Failure>,
    peak_memory: usize,
    logs: Vec<String>,
    log_bytes: usize,
    network_grant: Option<network::Grant>,
    network_calls: usize,
    kv: Option<std::sync::Arc<kv::Storage>>,
    kv_read: bool,
    kv_write: bool,
    kv_calls: usize,
    public_reader: Option<std::sync::Arc<public_read::Reader>>,
    records_grant: Option<public_read::Grant>,
    blobs_grant: Option<public_read::Grant>,
    public_calls: usize,
    public_bytes: usize,
}

impl CallState {
    fn new(limits: Limits) -> Self {
        Self {
            deadline: Instant::now() + Duration::from_millis(limits.deadline_ms),
            limits,
            failure: None,
            peak_memory: 0,
            logs: Vec::new(),
            log_bytes: 2,
            network_grant: None,
            network_calls: 0,
            kv: None,
            kv_read: false,
            kv_write: false,
            kv_calls: 0,
            public_reader: None,
            records_grant: None,
            blobs_grant: None,
            public_calls: 0,
            public_bytes: 0,
        }
    }

    fn check_deadline(&mut self) -> Result<()> {
        if Instant::now() >= self.deadline {
            self.failure = Some(Failure::Timeout);
            bail!("call deadline exceeded");
        }
        Ok(())
    }
}

impl ResourceLimiter for CallState {
    fn memory_growing(
        &mut self,
        _current: usize,
        desired: usize,
        maximum: Option<usize>,
    ) -> Result<bool> {
        self.check_deadline()?;
        if desired > self.limits.memory_bytes || maximum.is_some_and(|m| desired > m) {
            self.failure = Some(Failure::MemoryLimit);
            bail!("guest memory ceiling exceeded");
        }
        self.peak_memory = self.peak_memory.max(desired);
        Ok(true)
    }

    fn memory_grow_failed(&mut self, _error: anyhow::Error) -> Result<()> {
        self.failure = Some(Failure::MemoryLimit);
        bail!("guest memory allocation failed")
    }

    fn table_growing(
        &mut self,
        _current: usize,
        desired: usize,
        maximum: Option<usize>,
    ) -> Result<bool> {
        self.check_deadline()?;
        if desired > 4096 || maximum.is_some_and(|m| desired > m) {
            self.failure = Some(Failure::MemoryLimit);
            bail!("guest table ceiling exceeded");
        }
        Ok(true)
    }

    fn table_grow_failed(&mut self, _error: anyhow::Error) -> Result<()> {
        self.failure = Some(Failure::MemoryLimit);
        bail!("guest table allocation failed")
    }

    fn instances(&self) -> usize {
        16
    }
    fn tables(&self) -> usize {
        2
    }
    fn memories(&self) -> usize {
        1
    }
}

// Count encoded JSON string bytes without allocating an escaped copy. Stop
// once the quota is exceeded. Quotes/control characters count on the wire.
fn json_string_bytes(value: &str, bound: usize) -> usize {
    let mut bytes = 2;
    for c in value.chars() {
        bytes += match c {
            '"' | '\\' | '\u{8}' | '\u{c}' | '\n' | '\r' | '\t' => 2,
            '\u{0}'..='\u{1f}' => 6,
            _ => c.len_utf8(),
        };
        if bytes > bound {
            return bytes;
        }
    }
    bytes
}

impl pirs::sandbox::diagnostics::Host for CallState {
    fn log(&mut self, message: String) -> Result<()> {
        self.check_deadline()?;
        let remaining = self.limits.log_bytes.saturating_sub(self.log_bytes);
        let added = json_string_bytes(&message, remaining) + usize::from(!self.logs.is_empty());
        if added > remaining {
            self.failure = Some(Failure::LogLimit);
            bail!("guest log quota exceeded");
        }
        self.log_bytes += added;
        self.logs.push(message);
        Ok(())
    }
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct Request {
    id: Option<u64>,
    input: String,
}

#[derive(Serialize)]
struct Response {
    filtered: bool,
    id: Option<u64>,
    ok: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    result: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    error: Option<Failure>,
    logs: Vec<String>,
    log_bytes: usize,
    peak_memory_bytes: usize,
    elapsed_ms: f64,
}

impl Response {
    fn invalid() -> Self {
        Self {
            filtered: false,
            id: None,
            ok: false,
            result: None,
            error: Some(Failure::InvalidRequest),
            logs: Vec::new(),
            log_bytes: 2,
            peak_memory_bytes: 0,
            elapsed_ms: 0.0,
        }
    }
}

struct Host {
    engine: Engine,
    plugin: StorageSandboxPre<CallState>,
    limits: Limits,
    manifest: Option<manifest::Manifest>,
    installation_id: Option<String>,
    kv: Option<std::sync::Arc<kv::Storage>>,
    public_reader: Option<std::sync::Arc<public_read::Reader>>,
}

impl Host {
    fn new(options: Options) -> Result<Self> {
        let limits = Limits {
            memory_bytes: options.memory_mib as usize * 1024 * 1024,
            deadline_ms: options.deadline_ms,
            response_bytes: options.response_bytes as usize,
            log_bytes: options.log_bytes as usize,
            input_bytes: options.input_bytes as usize,
        };
        let mut config = Config::new();
        config.epoch_interruption(true).wasm_backtrace(false);
        let engine = Engine::new(&config)?;
        let (bytes, manifest, installation_id) = if let Some(path) = &options.installation {
            let (bytes, manifest, receipt) = manifest::load(path, &engine)?;
            (bytes, Some(manifest), Some(receipt.installation_id))
        } else {
            ensure!(options.qualification_only, "an installation is required");
            let path = options.plugin.as_ref().context("missing component")?;
            (
                manifest::read_bounded(path, manifest::MAX_ARTIFACT)?,
                None,
                None,
            )
        };
        let kv = if let Some(m) = &manifest {
            if let Some(quota) = m.kv_quota("kv.write").or(m.kv_quota("kv.read")) {
                Some(std::sync::Arc::new(kv::Storage::open(
                    options
                        .state_dir
                        .as_ref()
                        .context("KV requires --state-dir")?,
                    &m.id,
                    quota,
                )?))
            } else {
                None
            }
        } else {
            None
        };
        let public_reader = if manifest
            .as_ref()
            .is_some_and(|m| m.has("records.read") || m.has("blobs.read"))
        {
            Some(std::sync::Arc::new(public_read::Reader::new(
                options
                    .public_pds
                    .as_deref()
                    .context("public reads require --public-pds")?,
            )?))
        } else {
            None
        };
        let component = Component::new(&engine, bytes)?;
        // No WASI, environment or filesystem is linked. The network
        // callback checks the installed grant. Pre-instantiation checks the WIT
        // function contract before announcing readiness or executing a guest.
        let mut linker = Linker::new(&engine);
        StorageSandbox::add_to_linker::<_, HasSelf<_>>(&mut linker, |state| state)?;
        let plugin = StorageSandboxPre::new(linker.instantiate_pre(&component)?)?;
        let clock_engine = engine.clone();
        std::thread::Builder::new()
            .name("pirs-call-clock".into())
            .spawn(move || {
                loop {
                    std::thread::sleep(EPOCH_INTERVAL);
                    clock_engine.increment_epoch();
                }
            })?;
        Ok(Self {
            engine,
            plugin,
            limits,
            manifest,
            installation_id,
            kv,
            public_reader,
        })
    }

    fn call(&self, mut request: Request) -> Response {
        if let Some(manifest) = &self.manifest {
            match manifest.input(&request.input) {
                Ok(Some(input)) => request.input = input,
                Ok(None) => {
                    return Response {
                        filtered: true,
                        id: request.id,
                        ok: true,
                        result: None,
                        error: None,
                        logs: Vec::new(),
                        log_bytes: 2,
                        peak_memory_bytes: 0,
                        elapsed_ms: 0.0,
                    };
                }
                Err(_) => {
                    return Response {
                        id: request.id,
                        ..Response::invalid()
                    };
                }
            }
        }
        let started = Instant::now();
        let mut store = Store::new(&self.engine, CallState::new(self.limits.clone()));
        store.data_mut().network_grant = self.manifest.as_ref().and_then(|m| m.network_grant());
        store.data_mut().kv = self.kv.clone();
        store.data_mut().public_reader = self.public_reader.clone();
        store.data_mut().records_grant = self
            .manifest
            .as_ref()
            .and_then(|m| m.public_grant("records.read"));
        store.data_mut().blobs_grant = self
            .manifest
            .as_ref()
            .and_then(|m| m.public_grant("blobs.read"));
        store.data_mut().kv_read = self.manifest.as_ref().is_some_and(|m| m.has("kv.read"));
        store.data_mut().kv_write = self.manifest.as_ref().is_some_and(|m| m.has("kv.write"));
        store.limiter(|state| state);
        store.set_epoch_deadline(1);
        store.epoch_deadline_callback(|mut context| {
            context.data_mut().check_deadline()?;
            Ok(UpdateDeadline::Continue(1))
        });
        let result = self
            .plugin
            .instantiate(&mut store)
            .and_then(|plugin| plugin.call_run(&mut store, &request.input));
        let mut output = None;
        let mut failure = store.data().failure;
        if failure.is_none() {
            if Instant::now() >= store.data().deadline {
                failure = Some(Failure::Timeout);
            } else {
                match result {
                    Ok(value)
                        if json_string_bytes(&value, self.limits.response_bytes)
                            <= self.limits.response_bytes =>
                    {
                        output = Some(value)
                    }
                    Ok(_) => failure = Some(Failure::ResponseLimit),
                    Err(_) => failure = Some(Failure::Trap),
                }
            }
        }
        let state = store.into_data();
        Response {
            filtered: false,
            id: request.id,
            ok: failure.is_none(),
            result: output,
            error: failure,
            logs: state.logs,
            log_bytes: state.log_bytes,
            peak_memory_bytes: state.peak_memory,
            elapsed_ms: started.elapsed().as_secs_f64() * 1000.0,
        }
    }
}

enum Line {
    End,
    Bytes(Vec<u8>),
    TooLong,
}

fn bounded_line(reader: &mut impl BufRead, limit: usize) -> std::io::Result<Line> {
    let mut line = Vec::new();
    let mut too_long = false;
    loop {
        let available = reader.fill_buf()?;
        if available.is_empty() {
            return Ok(if too_long {
                Line::TooLong
            } else if line.is_empty() {
                Line::End
            } else {
                Line::Bytes(line)
            });
        }
        let newline = available.iter().position(|&byte| byte == b'\n');
        let length = newline.map_or(available.len(), |position| position + 1);
        if !too_long {
            if line.len() + length > limit {
                too_long = true;
                line.clear();
            } else {
                line.extend_from_slice(&available[..length]);
            }
        }
        reader.consume(length);
        if newline.is_some() {
            return Ok(if too_long {
                Line::TooLong
            } else {
                Line::Bytes(line)
            });
        }
    }
}

fn serve(host: Host) -> Result<()> {
    let mut output = std::io::stdout().lock();
    serde_json::to_writer(
        &mut output,
        &json!({ "ready": true, "interface": "pirs:sandbox@0.1.0", "limits": host.limits, "epoch_interval_ms": 5, "installationId": host.installation_id, "xrpcNsids": host.manifest.as_ref().map(|m| m.xrpc_nsids()).unwrap_or_default() }),
    )?;
    writeln!(output)?;
    output.flush()?;
    let mut input = std::io::stdin().lock();
    loop {
        let response = match bounded_line(&mut input, host.limits.input_bytes)? {
            Line::End => return Ok(()),
            Line::TooLong => Response::invalid(),
            Line::Bytes(bytes) => match serde_json::from_slice::<Request>(&bytes) {
                Ok(request) => host.call(request),
                Err(_) => Response::invalid(),
            },
        };
        serde_json::to_writer(&mut output, &response)?;
        writeln!(output)?;
        output.flush()?;
    }
}

fn main() -> Result<()> {
    // Re-exec replaces the bootstrap address space before the serving host
    // loads a plugin. This clears PDS_* values and every other inherited
    // variable, including CI tokens; no guest API can read environment state.
    #[cfg(unix)]
    if std::env::vars_os().next().is_some() {
        use std::os::unix::process::CommandExt;
        let error = std::process::Command::new(std::env::current_exe()?)
            .args(std::env::args_os().skip(1))
            .env_clear()
            .exec();
        return Err(error).context("could not start the host with a cleared environment");
    }
    #[cfg(not(unix))]
    bail!("the qualified host requires Unix environment replacement");
    let options = Options::parse();
    if let Some(parent) = options.parent_pid {
        #[cfg(target_os = "linux")]
        {
            // Establish the kernel death signal, then check for a parent death
            // during startup. The supervisor supplies its own PID, never a key.
            ensure!(
                unsafe { libc::prctl(libc::PR_SET_PDEATHSIG, libc::SIGKILL) } == 0,
                "could not establish parent death signal"
            );
            ensure!(
                unsafe { libc::getppid() } as u32 == parent,
                "supervisor is gone"
            );
        }
        #[cfg(not(target_os = "linux"))]
        bail!("supervised event delivery requires Linux (parent {parent})");
    }
    if let Some(root) = &options.install_dir {
        let engine = Engine::default();
        let bytes = manifest::read_bounded(
            options.plugin.as_ref().context("missing plugin")?,
            manifest::MAX_ARTIFACT,
        )?;
        let manifest_bytes =
            manifest::read_manifest(options.manifest.as_ref().context("missing manifest")?)?;
        let manifest = manifest::Manifest::parse(&manifest_bytes)?;
        let component = Component::new(&engine, &bytes)?;
        let imports = manifest.check_imports(&engine, &component)?;
        let mut linker = Linker::new(&engine);
        StorageSandbox::add_to_linker::<_, HasSelf<_>>(&mut linker, |state| state)?;
        // Validate all signatures and the export contract without a Store or
        // guest instantiation. Nothing is written before this succeeds.
        let _ = StorageSandboxPre::<CallState>::new(linker.instantiate_pre(&component)?)?;
        let record = manifest::receipt(&bytes, &manifest_bytes, imports);
        let destination = manifest::install(root, &bytes, &manifest_bytes, &record, &engine)?;
        println!("{}", json!({"installed": destination, "receipt": record}));
        return Ok(());
    }
    if options.state_command.is_some() {
        kv::operator(&options)?;
        return Ok(());
    }
    let host = Host::new(options)
        .map_err(|_| anyhow::anyhow!("plugin load or sandbox contract check failed"))?;
    serve(host)
}
