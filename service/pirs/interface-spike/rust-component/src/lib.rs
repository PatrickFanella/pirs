wit_bindgen::generate!({ path: "..", world: "plugin" });

struct Plugin;

impl Guest for Plugin {
    fn on_event(value: pirs::spike::host::Event) -> u32 {
        assert_eq!(value.seq, 42);
        assert_eq!(value.payload.len(), 64);
        pirs::spike::host::emit(&value)
    }
}

export!(Plugin);
