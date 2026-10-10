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

include!(concat!(env!("OUT_DIR"), "/config.rs"));
wit_bindgen::generate!({ path: "../wit", world: "static-site" });
struct Site;
impl Guest for Site {
    fn run(input: String) -> String {
        serve(
            &input,
            DID,
            pirs::sandbox::records_read::get,
            pirs::sandbox::blobs_read::get,
        )
    }
}
export!(Site);
