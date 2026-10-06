#![cfg_attr(not(feature = "wasi"), no_std)]

extern crate alloc;
use alloc::string::String;
#[cfg(not(any(feature = "network", feature = "kv", feature = "public-read")))]
use alloc::{string::ToString, vec, vec::Vec};

#[global_allocator]
#[cfg(not(feature = "wasi"))]
static ALLOCATOR: dlmalloc::GlobalDlmalloc = dlmalloc::GlobalDlmalloc;

// Newer LLVM can lower string comparisons to memcmp even in no_std builds.
// Volatile reads keep this fixture implementation from lowering to itself.
#[unsafe(no_mangle)]
#[cfg(not(feature = "wasi"))]
pub unsafe extern "C" fn memcmp(
    left: *const core::ffi::c_void,
    right: *const core::ffi::c_void,
    len: usize,
) -> i32 {
    let left = left.cast::<u8>();
    let right = right.cast::<u8>();
    for index in 0..len {
        let a = unsafe { core::ptr::read_volatile(left.add(index)) };
        let b = unsafe { core::ptr::read_volatile(right.add(index)) };
        if a != b {
            return i32::from(a) - i32::from(b);
        }
    }
    0
}

// The wasip2 target normally obtains this export from std. This no_std
// fixture supplies it explicitly so no WASI interfaces enter the component.
#[unsafe(no_mangle)]
#[cfg(not(feature = "wasi"))]
pub unsafe extern "C" fn cabi_realloc(
    ptr: *mut u8,
    old: usize,
    align: usize,
    new: usize,
) -> *mut u8 {
    use alloc::alloc::{Layout, alloc, dealloc, realloc};
    if new == 0 {
        if old != 0 {
            unsafe { dealloc(ptr, Layout::from_size_align(old, align).unwrap()) };
        }
        return align as *mut u8;
    }
    let layout = Layout::from_size_align(if old == 0 { new } else { old }, align).unwrap();
    let allocated = unsafe {
        if old == 0 {
            alloc(layout)
        } else {
            realloc(ptr, layout, new)
        }
    };
    if allocated.is_null() {
        core::arch::wasm32::unreachable();
    }
    allocated
}

#[panic_handler]
#[cfg(not(feature = "wasi"))]
fn panic(_info: &core::panic::PanicInfo<'_>) -> ! {
    core::arch::wasm32::unreachable()
}

#[cfg(not(any(feature = "network", feature = "kv", feature = "public-read")))]
wit_bindgen::generate!({ path: "../wit", world: "sandbox" });
#[cfg(feature = "network")]
wit_bindgen::generate!({ path: "../wit", world: "network-sandbox" });

#[cfg(feature = "kv")]
wit_bindgen::generate!({ path: "../wit", world: "kv-fixture" });

#[cfg(feature = "public-read")]
wit_bindgen::generate!({ path: "../wit", world: "public-read-fixture" });

struct Fixture;

impl Guest for Fixture {
    fn run(input: String) -> String {
        #[cfg(feature = "public-read")]
        {
            let action = input
                .split("\"repo\":\"")
                .nth(1)
                .unwrap_or("")
                .split('"')
                .next()
                .unwrap_or("");
            let parts: alloc::vec::Vec<_> = action.split('|').collect();
            if parts.len() < 4 {
                return "invalid fixture request".into();
            }
            let mut output = String::new();
            let count = if parts[0] == "flood" {
                9
            } else if parts[0] == "budget" {
                3
            } else {
                1
            };
            for _ in 0..count {
                if parts[0] == "blob" || parts[0] == "budget" {
                    match pirs::sandbox::blobs_read::get(
                        parts[1],
                        parts[2],
                        parts[3],
                        parts.get(4).copied().unwrap_or(""),
                    ) {
                        Ok(bytes) => {
                            output.push_str(&alloc::format!("blob:{}:", bytes.len()));
                            if bytes.len() < 100 {
                                for b in bytes {
                                    output.push_str(&alloc::format!("{b:02x}"));
                                }
                            }
                        }
                        Err(e) => output.push_str(&alloc::format!("denied:{e}")),
                    }
                } else {
                    match pirs::sandbox::records_read::get(parts[1], parts[2], parts[3]) {
                        Ok(value) => {
                            if count == 1 {
                                output.push_str(&value);
                            } else {
                                output.push_str("allowed;");
                            }
                        }
                        Err(e) => output.push_str(&alloc::format!("denied:{e}")),
                    }
                }
            }
            return output;
        }
        #[cfg(feature = "kv")]
        {
            let marker = "\"repo\":\"";
            let action = input
                .split(marker)
                .nth(1)
                .unwrap_or("")
                .split('"')
                .next()
                .unwrap_or("");
            return match action {
                "write" => alloc::format!(
                    "{:?}",
                    pirs::sandbox::kv_write::set("entry", Some(&[1, 2, 3]))
                ),
                "flood" => alloc::format!(
                    "{:?}",
                    pirs::sandbox::kv_write::set("entry", Some(&[255; 128]))
                ),
                "delete" => alloc::format!("{:?}", pirs::sandbox::kv_write::set("entry", None)),
                "list" => alloc::format!("{:?}", pirs::sandbox::kv_read::list("ent")),
                _ => alloc::format!("{:?}", pirs::sandbox::kv_read::get("entry")),
            };
        }
        #[cfg(feature = "network")]
        {
            // Qualification input is a public event's repo field. No PDS keys.
            let marker = "\"repo\":\"";
            let url = input
                .split(marker)
                .nth(1)
                .unwrap_or("")
                .split('"')
                .next()
                .unwrap_or("");
            return match pirs::sandbox::network::request("GET", url, &[], &[]) {
                Ok(response) => {
                    alloc::format!("status:{} bytes:{}", response.status, response.body.len())
                }
                Err(error) => alloc::format!("denied:{error}"),
            };
        }
        #[cfg(not(any(feature = "network", feature = "kv", feature = "public-read")))]
        {
            if let Some(call) = input.strip_prefix("xrpc:") {
                if call.contains("tv.test.trap") {
                    panic!("XRPC trap");
                }
                if call.contains("tv.test.loop") {
                    loop {
                        core::hint::black_box(0);
                    }
                }
                if call.contains("tv.test.memory") {
                    let mut blocks = Vec::new();
                    loop {
                        blocks.push(vec![1u8; 1024 * 1024]);
                        core::hint::black_box(&blocks);
                    }
                }
                if call.contains("tv.test.response") {
                    return "x".repeat(8192);
                }
                if call.contains("tv.test.log") {
                    loop {
                        pirs::sandbox::diagnostics::log("guest log line");
                    }
                }
                if call.contains("tv.test.invalid") {
                    return "invalid JSON".into();
                }
                pirs::sandbox::diagnostics::log("served XRPC");
                return call.to_string();
            }
            if let Some(call) = input.strip_prefix("http:") {
                if call.contains("/loop") {
                    loop {
                        core::hint::black_box(0);
                    }
                }
                if call.contains("/flood") {
                    return "x".repeat(65536);
                }
                if call.contains("/invalid") {
                    return "{}".into();
                }
                if call.contains("/headers") {
                    return r#"{"status":200,"contentType":"text/html","body":"bad","headers":{"set-cookie":"stolen=yes"}}"#.into();
                }
                if call.contains("/tiny") {
                    return r#"{"status":200,"contentType":"text/plain","body":"ok"}"#.into();
                }
                if call.contains("/hostile") {
                    return r#"{"status":200,"contentType":"text/html","body":"<!doctype html><title>Hostile installed plugin</title><h1>Hostile installed plugin</h1><p id='result'>script did not run</p><h2>Useful static content</h2><ul><li><strong>Installed HTML</strong> remains formatted</li></ul><table><caption>Static table</caption><tr><th>Name</th><td>Guest</td></tr></table><details><summary>Expand static details</summary><p>Useful disclosure content</p></details><p><a id='ordinary' href='http://127.0.0.1:43141/session'>Try ordinary session link</a></p><p><a id='top' href='http://127.0.0.1:43141/session' target='_top'>Try top session link</a></p><p><a id='blank' href='//127.0.0.1:43141/session' target='_blank' ping='http://127.0.0.1:43141/session'>Try new window session link</a></p><p><a id='encoded' HREF='http&#58;//127.0.0.1:43141/session'>Try encoded session link</a></p><script>document.querySelector('#result').textContent='SCRIPT RAN cookie='+document.cookie;fetch('http://127.0.0.1:43141/session',{credentials:'include'});fetch('http://127.0.0.1:43141/session',{credentials:'omit'});location='http://127.0.0.1:43141/session';</script><img src='http://127.0.0.1:43141/session'><iframe src='http://127.0.0.1:43141/session'></iframe><form action='http://127.0.0.1:43141/session' method='post'><button>Try session form</button></form><meta http-equiv='refresh' content='2;url=http://127.0.0.1:43141/session'>"}"#.into();
                }
                // Echo only the supervisor's credential-free envelope as plain text.
                return alloc::format!(
                    r#"{{"status":200,"contentType":"text/plain","body":{:?}}}"#,
                    call
                );
            }
            if let Some(event) = input.strip_prefix("event:") {
                // A hostile observer echoes every byte it receives. The host,
                // rather than cooperative guest code, must remove denied data.
                if cfg!(feature = "event-echo") {
                    return event.to_string();
                }
                // Qualification observer: confirm the sequenced envelope reached
                // Wasm, without echoing its potentially large CAR body.
                // Avoid a substring search that would require libc's memcmp in
                // this no_std fixture. The envelope starts with its sequence.
                let bytes = event.as_bytes();
                let mut start = 0;
                while start < bytes.len() && bytes[start] != b':' {
                    start += 1;
                }
                start = (start + 1).min(bytes.len());
                let mut end = start;
                while end < bytes.len() && bytes[end].is_ascii_digit() {
                    end += 1;
                }
                let seq = &event[start..end];
                pirs::sandbox::diagnostics::log(&alloc::format!("seq:{seq}"));
                return "observed".into();
            }
            match input.as_str() {
                "trap" => panic!("qualification trap"),
                "loop" => loop {
                    core::hint::black_box(0);
                },
                "allocate" => {
                    let mut blocks = Vec::new();
                    loop {
                        let block = vec![1u8; 1024 * 1024];
                        core::hint::black_box(&block);
                        blocks.push(block);
                    }
                }
                "interpreter" => {
                    // A bytecode interpreter executing a jump to itself. The VM's
                    // instruction count never advances; Wasmtime's wall clock must
                    // still interrupt the Wasm instructions running the interpreter.
                    let code = core::hint::black_box([0x01u8, 0, 0]);
                    let mut pc = 0;
                    loop {
                        match code[pc] {
                            0x01 => {
                                pc = usize::from(code[pc + 1]) | (usize::from(code[pc + 2]) << 8)
                            }
                            _ => panic!("unknown opcode"),
                        }
                        core::hint::black_box(pc);
                    }
                }
                "response-flood" => "x".repeat(8192),
                "escaped-response" => "\0".repeat(8192),
                "boundary-response" => "\n".repeat(511),
                "over-boundary-response" => "\n".repeat(512),
                "log-flood" => loop {
                    pirs::sandbox::diagnostics::log("guest log line");
                },
                "empty-log-flood" => loop {
                    pirs::sandbox::diagnostics::log("");
                },
                "escaped-log" => {
                    pirs::sandbox::diagnostics::log(&"\n".repeat(256));
                    "unreachable after log quota".into()
                }
                _ => {
                    pirs::sandbox::diagnostics::log("served");
                    input.strip_prefix("echo:").unwrap_or(&input).to_string()
                }
            }
        }
    }
}

export!(Fixture);
