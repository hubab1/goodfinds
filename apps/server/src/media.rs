//! Content-addressed, private local media storage. No downloads or runtime dependencies.
use crate::error::{Error, Result};
use base64::{Engine, engine::general_purpose::STANDARD};
use serde_json::{Value, json};
use sha2::{Digest, Sha256};
use std::{
    collections::HashSet,
    fs::{self, OpenOptions},
    io::Write,
    path::{Path, PathBuf},
};

fn digest(bytes: &[u8]) -> String {
    format!("{:x}", Sha256::digest(bytes))
}
fn valid_id(id: &str) -> Result<()> {
    if id.len() != 64
        || !id
            .bytes()
            .all(|b| b.is_ascii_digit() || (b'a'..=b'f').contains(&b))
    {
        return Err(Error::validation("Invalid media ID"));
    }
    Ok(())
}
pub fn mime(bytes: &[u8], videos: bool) -> Result<&'static str> {
    if bytes.starts_with(&[255, 216, 255]) {
        return Ok("image/jpeg");
    }
    if bytes.starts_with(&[137, 80, 78, 71, 13, 10, 26, 10]) {
        return Ok("image/png");
    }
    if bytes.get(0..4) == Some(b"RIFF") && bytes.get(8..12) == Some(b"WEBP") {
        return Ok("image/webp");
    }
    if videos && bytes.len() >= 24 && bytes.get(4..8) == Some(b"ftyp") {
        let size = u32::from_be_bytes(bytes[0..4].try_into().unwrap()) as usize;
        let brands = String::from_utf8_lossy(&bytes[8..bytes.len().min(size).max(8)]);
        if regex::Regex::new(r"isom|iso[2-9]|mp4[12]|avc1|M4V |MSNV")
            .unwrap()
            .is_match(&brands)
        {
            return Ok("video/mp4");
        }
    }
    if videos
        && bytes.starts_with(&[0x1a, 0x45, 0xdf, 0xa3])
        && bytes[..bytes.len().min(4096)]
            .windows(4)
            .any(|w| w == b"webm")
    {
        return Ok("video/webm");
    }
    Err(Error::validation(if videos {
        "Use downloaded JPEG, PNG, WebP, MP4 or WebM files. Other file types are not supported."
    } else {
        "Use downloaded JPEG, PNG or WebP images. Other file types are not supported."
    }))
}
fn media_bytes(path: &Path, limit: u64) -> Result<Vec<u8>> {
    let info = fs::symlink_metadata(path)?;
    if !info.is_file() || info.len() == 0 || info.len() > limit {
        return Err(Error::validation(format!(
            "Each file must be a regular file of up to {} MB.",
            limit / 1_000_000
        )));
    }
    let bytes = fs::read(path)?;
    if bytes.is_empty() || bytes.len() as u64 > limit {
        return Err(Error::validation(format!(
            "Each file must be a regular file of up to {} MB.",
            limit / 1_000_000
        )));
    }
    Ok(bytes)
}
fn save(folder: &Path, id: &str, bytes: &[u8]) -> Result<()> {
    let pending = folder.join(format!("pending-{}", crate::util::id()));
    let result = (|| -> Result<()> {
        let mut options = OpenOptions::new();
        options.write(true).create_new(true);
        #[cfg(unix)]
        {
            use std::os::unix::fs::OpenOptionsExt;
            options.mode(0o600);
        }
        let mut file = options.open(&pending)?;
        file.write_all(bytes)?;
        file.sync_all()?;
        fs::rename(&pending, folder.join(id))?;
        Ok(())
    })();
    if pending.exists() {
        let _ = fs::remove_file(pending);
    }
    result
}
pub fn cache_files(root: &Path, input: &Value, videos: bool) -> Result<Value> {
    let files = input
        .as_array()
        .ok_or_else(|| Error::validation("Files must be an array"))?;
    if files.is_empty() || files.len() > 20 {
        return Err(Error::validation("Cache between one and twenty files"));
    }
    let mut total = 0usize;
    let mut prepared = Vec::new();
    for file in files {
        let obj = file
            .as_object()
            .ok_or_else(|| Error::validation("Invalid media file"))?;
        if obj.len() != 2 || !obj.contains_key("path") || !obj.contains_key("label") {
            return Err(Error::validation("Media file needs only path and label"));
        }
        let path = file["path"]
            .as_str()
            .filter(|x| !x.is_empty())
            .ok_or_else(|| Error::validation("Media path is required"))?;
        let label = file["label"]
            .as_str()
            .filter(|x| x.chars().count() <= 200)
            .ok_or_else(|| Error::validation("Invalid media label"))?;
        let bytes = media_bytes(
            Path::new(path),
            if videos { 50_000_000 } else { 10_000_000 },
        )?;
        total += bytes.len();
        if total > if videos { 100_000_000 } else { 50_000_000 } {
            return Err(Error::validation(format!(
                "Cache files in batches of up to {} MB.",
                if videos { 100 } else { 50 }
            )));
        }
        let kind = mime(&bytes, videos)?;
        if kind.starts_with("image/") && bytes.len() > 10_000_000 {
            return Err(Error::validation("Each image must be up to 10 MB."));
        }
        prepared.push((digest(&bytes), kind, label.to_owned(), bytes));
    }
    let folder = root.join("media");
    fs::create_dir_all(&folder)?;
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        fs::set_permissions(&folder, fs::Permissions::from_mode(0o700))?;
    }
    let mut saved = HashSet::new();
    for (id, _, _, bytes) in &prepared {
        if saved.insert(id.clone()) {
            save(&folder, id, bytes)?;
        }
    }
    Ok(Value::Array(prepared.into_iter().map(|(id,kind,label,bytes)|json!({"id":id,"mime_type":kind,"size_bytes":bytes.len(),"label":label})).collect()))
}
fn read(root: &Path, id: &str, limit: u64) -> Result<(PathBuf, Vec<u8>)> {
    valid_id(id)?;
    let path = root.join("media").join(id);
    let bytes = media_bytes(&path, limit)?;
    if digest(&bytes) != id {
        return Err(Error::validation(
            "The saved media has changed. Download it again.",
        ));
    }
    Ok((path, bytes))
}
pub fn read_image(root: &Path, id: &str) -> Result<Value> {
    valid_id(id)?;
    if let Some((bytes, kind)) = crate::assets::bundled_image(id) {
        return Ok(json!({"type":"image","mimeType":kind,"data":STANDARD.encode(bytes)}));
    }
    let (_, bytes) = read(root, id, 10_000_000)?;
    let kind = mime(&bytes, false)?;
    Ok(json!({"type":"image","mimeType":kind,"data":STANDARD.encode(bytes)}))
}
pub fn read_video(root: &Path, id: &str) -> Result<Value> {
    let (_, bytes) = read(root, id, 50_000_000)?;
    let kind = mime(&bytes, true)?;
    if !kind.starts_with("video/") {
        return Err(Error::validation("The saved file is not a video."));
    }
    Ok(json!({"mime_type":kind,"data":STANDARD.encode(bytes)}))
}
pub fn read_media_file(root: &Path, id: &str) -> Result<Value> {
    let (path, bytes) = read(root, id, 50_000_000)?;
    Ok(json!({"media_id":id,"path":path,"mime_type":mime(&bytes,true)?,"size_bytes":bytes.len()}))
}
pub fn validate_references(root: &Path, observations: &Value) -> Result<()> {
    let rows = observations
        .as_array()
        .ok_or_else(|| Error::validation("Observations must be an array"))?;
    let mut images = HashSet::new();
    let mut videos = HashSet::new();
    for row in rows {
        if let Some(id) = row["seller_avatar_media_id"].as_str() {
            images.insert(id);
        }
        for photo in row["photos"].as_array().into_iter().flatten() {
            images.insert(
                photo["media_id"]
                    .as_str()
                    .ok_or_else(|| Error::validation("Invalid image reference"))?,
            );
        }
        for video in row["videos"].as_array().into_iter().flatten() {
            videos.insert(
                video["media_id"]
                    .as_str()
                    .ok_or_else(|| Error::validation("Invalid video reference"))?,
            );
            if let Some(id) = video["poster_media_id"].as_str() {
                images.insert(id);
            }
        }
    }
    for id in images {
        read_image(root, id)?;
    }
    for id in videos {
        read_video(root, id)?;
    }
    Ok(())
}
#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn detects_types_and_rejects_lookalikes() {
        assert_eq!(mime(&[255, 216, 255], false).unwrap(), "image/jpeg");
        assert!(mime(b"<svg></svg>", false).is_err());
        assert!(valid_id("../private").is_err());
    }
    #[test]
    fn cache_checks_hash_and_separates_video() {
        let dir = std::env::temp_dir().join(crate::util::id());
        fs::create_dir_all(&dir).unwrap();
        let source = dir.join("source");
        fs::write(&source, [255, 216, 255, 1, 2, 3]).unwrap();
        let result = cache_files(&dir, &json!([{"path":source,"label":"Sample"}]), true).unwrap();
        let id = result[0]["id"].as_str().unwrap();
        assert!(read_image(&dir, id).is_ok());
        assert!(read_video(&dir, id).is_err());
        fs::write(dir.join("media").join(id), [255, 216, 255, 4]).unwrap();
        assert!(read_image(&dir, id).is_err());
        fs::remove_dir_all(dir).unwrap();
    }
}
