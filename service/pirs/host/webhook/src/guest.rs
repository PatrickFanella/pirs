use super::*;
#[global_allocator]
static ALLOCATOR: dlmalloc::GlobalDlmalloc = dlmalloc::GlobalDlmalloc;

// Newer LLVM can lower string comparisons to memcmp even in no_std builds.
// Volatile reads keep this component implementation from lowering to itself.
#[unsafe(no_mangle)]
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
fn panic(_info: &core::panic::PanicInfo<'_>) -> ! {
    core::arch::wasm32::unreachable()
}

wit_bindgen::generate!({ path: "../wit", world: "webhook" });
struct Webhook;
impl Guest for Webhook {
    fn run(input: String) -> String {
        let config: Value = serde_json::from_str(CONFIG).expect("configuration");
        let Some(body) = notice(
            &input,
            config["collections"].as_array().expect("collections"),
        )
        .expect("valid commit") else {
            return "filtered".into();
        };
        let hex = config["key"].as_str().expect("key");
        let key: Vec<u8> = (0..hex.len())
            .step_by(2)
            .map(|i| u8::from_str_radix(&hex[i..i + 2], 16).expect("key byte"))
            .collect();
        let headers = alloc::vec![
            ("content-type".into(), "application/json".into()),
            ("x-pirs-signature".into(), signature(&key, &body))
        ];
        let attempts = deliver(|| {
            pirs::sandbox::network::request(
                "POST",
                config["url"].as_str().expect("URL"),
                &headers,
                &body,
            )
            .map(|r| r.status)
            .map_err(|_| ())
        })
        .expect("webhook delivery failed");
        format!("delivered:{attempts}")
    }
}
export!(Webhook);
