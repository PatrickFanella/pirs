use serde::Deserialize;

#[derive(Deserialize)]
struct Event {
    seq: u32,
    payload: String,
}

static mut INPUT: [u8; 4096] = [0; 4096];

#[link(wasm_import_module = "pirs")]
unsafe extern "C" {
    fn emit(ptr: u32, len: u32) -> u32;
}

#[unsafe(no_mangle)]
pub extern "C" fn input_ptr() -> u32 {
    (&raw mut INPUT).cast::<u8>() as u32
}

#[unsafe(no_mangle)]
pub extern "C" fn on_event(ptr: u32, len: u32) -> u32 {
    assert_eq!(ptr, input_ptr());
    assert!(len <= 4096);
    let bytes = unsafe { std::slice::from_raw_parts(ptr as *const u8, len as usize) };
    let event: Event = serde_json::from_slice(bytes).expect("event JSON");
    assert_eq!(event.seq, 42);
    assert_eq!(event.payload.len(), 64);
    unsafe { emit(ptr, len) }
}
