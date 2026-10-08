use std::{env, fs, io::Write, path::PathBuf};
fn main() {
    let root = PathBuf::from(env::var("CARGO_MANIFEST_DIR").unwrap()).join("../..");
    let out = PathBuf::from(env::var("OUT_DIR").unwrap());
    let html = root.join("dist/build/web/panel.html");
    println!("cargo:rerun-if-changed={}", html.display());
    let bytes = fs::read(&html).expect("Build the UI first: bun run --filter @goodfinds/ui build");
    let mut zipped = flate2::write::GzEncoder::new(Vec::new(), flate2::Compression::best());
    zipped.write_all(&bytes).unwrap();
    fs::write(out.join("panel.html.gz"), zipped.finish().unwrap()).unwrap();
    let contracts = root.join("apps/server/data/contracts.json");
    println!("cargo:rerun-if-changed={}", contracts.display());
    let mut zipped = flate2::write::GzEncoder::new(Vec::new(), flate2::Compression::best());
    zipped
        .write_all(&fs::read(contracts).expect("Generate native contracts first"))
        .unwrap();
    fs::write(out.join("contracts.json.gz"), zipped.finish().unwrap()).unwrap();
    let sources = root.join("packages/contracts/data/search-cover-sources.json");
    println!("cargo:rerun-if-changed={}", sources.display());
    let data: serde_json::Value = serde_json::from_slice(&fs::read(sources).unwrap()).unwrap();
    let mut images = vec![data["rental"].clone()];
    for group in ["rental_presets", "vehicle_presets", "marketplace_presets"] {
        images.extend(data[group].as_object().unwrap().values().cloned());
    }
    let mut code = String::from(
        "pub fn bundled_image(id:&str)->Option<(&'static [u8],&'static str)>{let id=match id{\n",
    );
    for (old, new) in data["media_id_aliases"].as_object().unwrap() {
        code.push_str(&format!("{old:?}=>{:?},\n", new.as_str().unwrap()));
    }
    code.push_str("_=>id};match id{\n");
    let mut seen = std::collections::HashSet::new();
    for image in images {
        let id = image["media_id"].as_str().unwrap();
        if !seen.insert(id.to_owned()) {
            continue;
        }
        let path = root
            .join("assets/search-covers")
            .join(image["file"].as_str().unwrap())
            .canonicalize()
            .unwrap();
        println!("cargo:rerun-if-changed={}", path.display());
        code.push_str(&format!(
            "{id:?}=>Some((include_bytes!({:?}),\"image/webp\")),\n",
            path.to_str().unwrap()
        ));
    }
    code.push_str("_=>None}}\n");
    fs::write(out.join("assets.rs"), code).unwrap();
    println!(
        "cargo:rustc-env=GOODFINDS_TARGET={}",
        env::var("TARGET").unwrap()
    );
}
