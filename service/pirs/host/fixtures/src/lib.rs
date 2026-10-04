#![cfg_attr(not(feature = "wasi"), no_std)]

extern crate alloc;
use alloc::{
    string::{String, ToString},
    vec,
    vec::Vec,
};

#[global_allocator]
#[cfg(not(feature = "wasi"))]
static ALLOCATOR: dlmalloc::GlobalDlmalloc = dlmalloc::GlobalDlmalloc;

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

wit_bindgen::generate!({ path: "../wit", world: "sandbox" });

struct Fixture;

impl Guest for Fixture {
    fn run(input: String) -> String {
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
                        0x01 => pc = usize::from(code[pc + 1]) | (usize::from(code[pc + 2]) << 8),
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

export!(Fixture);
