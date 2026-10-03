use anyhow::{Result, ensure};
use serde_json::json;
use std::{path::Path, time::Instant};
use wasmtime::component::types::ComponentItem;
use wasmtime::component::{Component, Linker as ComponentLinker, ResourceTable};
use wasmtime::{Caller, Engine, Linker, Module, Store};
use wasmtime_wasi::p1::WasiP1Ctx;
use wasmtime_wasi::{WasiCtx, WasiCtxBuilder, WasiCtxView, WasiView};

wasmtime::component::bindgen!({ path: "..", world: "plugin" });

const SEQ: u32 = 42;
const PAYLOAD: &str = "xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx";
const CALLS: usize = 10_000;

struct State {
    wasi: WasiCtx,
    table: ResourceTable,
    p1: WasiP1Ctx,
    calls: usize,
}

impl State {
    fn new() -> Self {
        Self {
            wasi: WasiCtxBuilder::new().build(),
            table: ResourceTable::new(),
            p1: WasiCtxBuilder::new().build_p1(),
            calls: 0,
        }
    }
}

impl WasiView for State {
    fn ctx(&mut self) -> WasiCtxView<'_> {
        WasiCtxView {
            ctx: &mut self.wasi,
            table: &mut self.table,
        }
    }
}

impl pirs::spike::host::Host for State {
    fn emit(&mut self, value: pirs::spike::host::Event) -> u32 {
        assert_eq!(value.seq, SEQ);
        assert_eq!(value.payload, PAYLOAD);
        self.calls += 1;
        value.seq + 1
    }
}

fn elapsed_us(start: Instant) -> f64 {
    start.elapsed().as_secs_f64() * 1e6
}

fn describe_import(engine: &Engine, item: ComponentItem) -> serde_json::Value {
    match item {
        ComponentItem::ComponentInstance(interface) => json!({
            "kind": "interface",
            "members": interface.exports(engine).map(|(name, item)| json!({
                "name": name, "type": describe_import(engine, item)
            })).collect::<Vec<_>>()
        }),
        ComponentItem::ComponentFunc(function) => json!({
            "kind": "function",
            "params": function.params().map(|(name, ty)| json!({"name": name, "type": format!("{ty:?}")})).collect::<Vec<_>>(),
            "results": function.results().map(|ty| format!("{ty:?}")).collect::<Vec<_>>()
        }),
        ComponentItem::Type(_) => json!({"kind": "type"}),
        ComponentItem::Resource(_) => json!({"kind": "resource"}),
        other => json!({"kind": format!("{other:?}")}),
    }
}

fn component(engine: &Engine, path: &Path) -> Result<serde_json::Value> {
    let start = Instant::now();
    let module = Component::from_file(engine, path)?;
    let compile_us = elapsed_us(start);
    // This happens before any Store or instance is created.
    let imports: Vec<_> = module
        .component_type()
        .imports(engine)
        .map(|(name, item)| json!({ "name": name, "type": describe_import(engine, item) }))
        .collect();
    let mut linker = ComponentLinker::new(engine);
    wasmtime_wasi::p2::add_to_linker_sync(&mut linker)?;
    Plugin::add_to_linker::<_, wasmtime::component::HasSelf<_>>(&mut linker, |s| s)?;
    let mut instantiation_us = Vec::new();
    for _ in 0..25 {
        let start = Instant::now();
        let mut store = Store::new(engine, State::new());
        let _plugin = Plugin::instantiate(&mut store, &module, &linker)?;
        instantiation_us.push(elapsed_us(start));
    }
    let mut store = Store::new(engine, State::new());
    let plugin = Plugin::instantiate(&mut store, &module, &linker)?;
    let event = pirs::spike::host::Event {
        seq: SEQ,
        payload: PAYLOAD.into(),
    };
    for _ in 0..1000 {
        ensure!(plugin.call_on_event(&mut store, &event)? == SEQ + 1);
    }
    let mut call_us = Vec::new();
    for _ in 0..5 {
        let start = Instant::now();
        for _ in 0..CALLS {
            ensure!(plugin.call_on_event(&mut store, &event)? == SEQ + 1);
        }
        call_us.push(elapsed_us(start) / CALLS as f64);
    }
    ensure!(
        store.data().calls == 1000 + 5 * CALLS,
        "one host call per event"
    );
    Ok(
        json!({"artifact": path, "bytes": path.metadata()?.len(), "imports": imports,
        "compile_us": compile_us, "instantiate_us": instantiation_us,
        "call_us": call_us, "verified_host_calls": store.data().calls}),
    )
}

fn core(engine: &Engine, path: &Path) -> Result<serde_json::Value> {
    let start = Instant::now();
    let module = Module::from_file(engine, path)?;
    let compile_us = elapsed_us(start);
    // Module metadata, before instantiation or execution.
    let imports: Vec<_> = module
        .imports()
        .map(|i| {
            json!({
                "module": i.module(), "name": i.name(), "type": format!("{:?}", i.ty())
            })
        })
        .collect();
    let mut linker = Linker::new(engine);
    wasmtime_wasi::p1::add_to_linker_sync(&mut linker, |s: &mut State| &mut s.p1)?;
    linker.func_wrap(
        "pirs",
        "emit",
        |mut caller: Caller<'_, State>, ptr: u32, len: u32| -> Result<u32> {
            let memory = caller
                .get_export("memory")
                .and_then(|e| e.into_memory())
                .ok_or_else(|| anyhow::anyhow!("guest memory missing"))?;
            ensure!(len <= 4096, "response bound");
            let mut bytes = vec![0; len as usize];
            memory.read(&caller, ptr as usize, &mut bytes)?;
            let event: serde_json::Value = serde_json::from_slice(&bytes)?;
            ensure!(
                event["seq"] == SEQ && event["payload"] == PAYLOAD,
                "event mismatch"
            );
            caller.data_mut().calls += 1;
            Ok(SEQ + 1)
        },
    )?;
    let mut instantiation_us = Vec::new();
    for _ in 0..25 {
        let start = Instant::now();
        let mut store = Store::new(engine, State::new());
        let instance = linker.instantiate(&mut store, &module)?;
        if let Ok(init) = instance.get_typed_func::<(), ()>(&mut store, "_initialize") {
            init.call(&mut store, ())?;
        }
        instantiation_us.push(elapsed_us(start));
    }
    let mut store = Store::new(engine, State::new());
    let instance = linker.instantiate(&mut store, &module)?;
    if let Ok(init) = instance.get_typed_func::<(), ()>(&mut store, "_initialize") {
        init.call(&mut store, ())?;
    }
    let ptr = instance
        .get_typed_func::<(), u32>(&mut store, "input_ptr")?
        .call(&mut store, ())?;
    let memory = instance.get_memory(&mut store, "memory").unwrap();
    let call = instance.get_typed_func::<(u32, u32), u32>(&mut store, "on_event")?;
    let bytes = serde_json::to_vec(&json!({"seq": SEQ, "payload": PAYLOAD}))?;
    for _ in 0..1000 {
        memory.write(&mut store, ptr as usize, &bytes)?;
        ensure!(call.call(&mut store, (ptr, bytes.len() as u32))? == SEQ + 1);
    }
    let mut call_us = Vec::new();
    for _ in 0..5 {
        let start = Instant::now();
        for _ in 0..CALLS {
            memory.write(&mut store, ptr as usize, &bytes)?;
            ensure!(call.call(&mut store, (ptr, bytes.len() as u32))? == SEQ + 1);
        }
        call_us.push(elapsed_us(start) / CALLS as f64);
    }
    ensure!(
        store.data().calls == 1000 + 5 * CALLS,
        "one host call per event"
    );
    Ok(
        json!({"artifact": path, "bytes": path.metadata()?.len(), "imports": imports,
        "compile_us": compile_us, "instantiate_us": instantiation_us,
        "call_us": call_us, "verified_host_calls": store.data().calls}),
    )
}

fn main() -> Result<()> {
    let engine = Engine::default();
    let paths = std::env::args().skip(1);
    for path in paths {
        let path = Path::new(&path);
        let bytes = std::fs::read(path)?;
        ensure!(bytes.len() >= 8, "truncated wasm");
        let result = if bytes[4..8] == [0x0d, 0, 1, 0] {
            component(&engine, path)?
        } else {
            core(&engine, path)?
        };
        println!("{result}");
    }
    Ok(())
}
