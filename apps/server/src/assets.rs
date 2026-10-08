use std::{io::Read, sync::LazyLock};
include!(concat!(env!("OUT_DIR"), "/assets.rs"));
pub fn panel() -> &'static str {
    static HTML: LazyLock<String> = LazyLock::new(|| {
        let bytes = include_bytes!(concat!(env!("OUT_DIR"), "/panel.html.gz"));
        let mut value = String::new();
        flate2::read::GzDecoder::new(&bytes[..])
            .read_to_string(&mut value)
            .expect("embedded UI");
        value
    });
    &HTML
}
pub const TARGET: &str = env!("GOODFINDS_TARGET");
