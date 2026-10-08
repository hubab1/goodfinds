//! Checksummed SQLite backups and configuration exports. Backups are assembled
//! privately and published only after every source file has passed validation.
use crate::{
    error::{Error, Result},
    storage::Workspace,
    util,
};
use rusqlite::{Connection, OpenFlags};
use serde::{Deserialize, Serialize};
use serde_json::{Value, json};
use sha2::{Digest, Sha256};
#[cfg(unix)]
use std::fs::File;
use std::{
    collections::HashSet,
    fs::{self, OpenOptions},
    io::Write,
    path::{Component, Path, PathBuf},
    time::Duration,
};

const SCHEMA_VERSION: u64 = 4;
#[derive(Serialize, Deserialize)]
struct BackupFile {
    path: String,
    sha256: String,
    bytes: u64,
}
#[derive(Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
struct Manifest {
    format: u64,
    schema_version: u64,
    created_at: String,
    files: Vec<BackupFile>,
}
fn fail<T>(message: &str) -> Result<T> {
    Err(Error::validation(message))
}
fn digest(bytes: &[u8]) -> String {
    format!("{:x}", Sha256::digest(bytes))
}
fn hash_name(name: &str) -> bool {
    name.len() == 64
        && name
            .bytes()
            .all(|c| c.is_ascii_digit() || (b'a'..=b'f').contains(&c))
}
fn absolute(path: &Path) -> Result<PathBuf> {
    let joined = if path.is_absolute() {
        path.to_owned()
    } else {
        std::env::current_dir()?.join(path)
    };
    let mut out = PathBuf::new();
    for part in joined.components() {
        match part {
            Component::CurDir => {}
            Component::ParentDir => {
                out.pop();
            }
            _ => out.push(part.as_os_str()),
        }
    }
    Ok(out)
}
fn exists(path: &Path) -> bool {
    fs::symlink_metadata(path).is_ok()
}
fn regular(path: &Path) -> Result<()> {
    if !fs::symlink_metadata(path)?.file_type().is_file() {
        return fail("Backup files must be regular files");
    }
    Ok(())
}
fn private_directory(path: &Path) -> Result<()> {
    let mut builder = fs::DirBuilder::new();
    builder.recursive(true);
    #[cfg(unix)]
    {
        use std::os::unix::fs::DirBuilderExt;
        builder.mode(0o700);
    }
    builder.create(path)?;
    Ok(())
}
fn private_file(path: &Path, bytes: &[u8]) -> Result<()> {
    let mut options = OpenOptions::new();
    options.write(true).create_new(true);
    #[cfg(unix)]
    {
        use std::os::unix::fs::OpenOptionsExt;
        options.mode(0o600);
    }
    let mut file = options.open(path)?;
    file.write_all(bytes)?;
    file.sync_all()?;
    Ok(())
}
fn private_permissions(path: &Path) -> Result<()> {
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        fs::set_permissions(path, fs::Permissions::from_mode(0o600))?;
    }
    #[cfg(not(unix))]
    let _ = path;
    Ok(())
}
fn verify_database(path: &Path, workspace: bool) -> Result<u64> {
    regular(path)?;
    let db = Connection::open_with_flags(path, OpenFlags::SQLITE_OPEN_READ_ONLY)?;
    db.busy_timeout(Duration::from_secs(10))?;
    let version = db.query_row("PRAGMA user_version", [], |r| r.get::<_, i64>(0))? as u64;
    if workspace && version != SCHEMA_VERSION {
        return fail("Unsupported workspace backup schema");
    }
    let mut stmt = db.prepare("PRAGMA integrity_check")?;
    let messages: Vec<String> = stmt
        .query_map([], |r| r.get(0))?
        .collect::<std::result::Result<_, _>>()?;
    if messages != ["ok"] {
        return fail("The backup database failed its integrity check");
    }
    Ok(version)
}
fn snapshot_database(source: &Path, target: &Path) -> Result<()> {
    regular(source)?;
    let db = Connection::open_with_flags(source, OpenFlags::SQLITE_OPEN_READ_ONLY)?;
    db.busy_timeout(Duration::from_secs(10))?;
    db.execute("VACUUM INTO ?", [target.to_string_lossy().as_ref()])?;
    private_permissions(target)?;
    // Windows FlushFileBuffers requires a handle opened with write access.
    OpenOptions::new().write(true).open(target)?.sync_all()?;
    Ok(())
}
struct Stage {
    path: PathBuf,
}
impl Drop for Stage {
    fn drop(&mut self) {
        let _ = fs::remove_dir_all(&self.path);
    }
}
// Directory publication must not replace an empty directory another process
// creates between validation and rename. Both supported Unix kernels provide
// an atomic no-replace rename; Windows directory rename already refuses one.
fn publish_new(source: &Path, destination: &Path) -> Result<()> {
    #[cfg(any(target_os = "macos", target_os = "linux"))]
    {
        use std::{ffi::CString, os::unix::ffi::OsStrExt};
        let from = CString::new(source.as_os_str().as_bytes())
            .map_err(|_| Error::validation("Invalid backup path"))?;
        let to = CString::new(destination.as_os_str().as_bytes())
            .map_err(|_| Error::validation("Invalid backup path"))?;
        #[cfg(target_os = "macos")]
        unsafe extern "C" {
            fn renamex_np(
                from: *const std::ffi::c_char,
                to: *const std::ffi::c_char,
                flags: u32,
            ) -> i32;
        }
        #[cfg(target_os = "linux")]
        unsafe extern "C" {
            fn renameat2(
                from_fd: i32,
                from: *const std::ffi::c_char,
                to_fd: i32,
                to: *const std::ffi::c_char,
                flags: u32,
            ) -> i32;
        }
        // SAFETY: the pointers refer to live NUL-terminated paths throughout
        // this synchronous call. Flags request atomic exclusion, never exchange.
        #[cfg(target_os = "macos")]
        let status = unsafe { renamex_np(from.as_ptr(), to.as_ptr(), 0x00000004) };
        #[cfg(target_os = "linux")]
        let status = unsafe { renameat2(-100, from.as_ptr(), -100, to.as_ptr(), 1) };
        if status != 0 {
            return Err(std::io::Error::last_os_error().into());
        }
        Ok(())
    }
    #[cfg(not(any(target_os = "macos", target_os = "linux")))]
    {
        fs::rename(source, destination)?;
        Ok(())
    }
}
fn stage(output: &Path, work: impl FnOnce(&Path) -> Result<()>) -> Result<()> {
    if exists(output) {
        return fail(
            "Choose a new output directory; existing workspaces and backups are preserved",
        );
    }
    let parent = output
        .parent()
        .ok_or_else(|| Error::validation("Choose an output directory"))?;
    private_directory(parent)?;
    let folder = parent.join(format!(".goodfinds-backup-{}", util::id()));
    let guard = Stage {
        path: folder.clone(),
    };
    private_directory(&folder)?;
    work(&folder)?;
    if exists(output) {
        return fail("The output directory was created elsewhere; choose a new directory");
    }
    publish_new(&folder, output)?;
    #[cfg(unix)]
    File::open(parent)?.sync_all()?;
    drop(guard);
    Ok(())
}

pub fn backup_workspace(database: &Path, output: &Path) -> Result<Value> {
    let source = absolute(database)?;
    let destination = absolute(output)?;
    let workspace = source
        .parent()
        .ok_or_else(|| Error::validation("Choose a workspace database"))?;
    let media = if workspace.file_name().is_some_and(|n| n == "sample") {
        workspace.parent().unwrap_or(workspace)
    } else {
        workspace
    }
    .join("media");
    if destination == workspace || destination.starts_with(&media) {
        return fail("Choose a separate backup directory outside the media cache");
    }
    let mut count = 0;
    stage(&destination, |folder| {
        let target = folder.join("workspace.sqlite");
        snapshot_database(&source, &target)?;
        let schema_version = verify_database(&target, true)?;
        let diagnostics = workspace.join("connections.sqlite");
        if exists(&diagnostics) {
            snapshot_database(&diagnostics, &folder.join("connections.sqlite"))?
        }
        if exists(&media) {
            let metadata = fs::symlink_metadata(&media)?;
            if !metadata.is_dir() || metadata.file_type().is_symlink() {
                return fail("The media cache must be a local directory");
            }
            private_directory(&folder.join("media"))?;
            for entry in fs::read_dir(&media)? {
                let entry = entry?;
                let name = entry.file_name();
                let Some(name) = name.to_str().filter(|name| hash_name(name)) else {
                    continue;
                };
                let path = entry.path();
                regular(&path)?;
                let bytes = fs::read(&path)?;
                if digest(&bytes) != name {
                    return fail("A cached media file failed its content-hash check");
                }
                private_file(&folder.join("media").join(name), &bytes)?
            }
        }
        let mut names = vec!["workspace.sqlite".to_string()];
        if exists(&folder.join("connections.sqlite")) {
            names.push("connections.sqlite".into())
        }
        if exists(&folder.join("media")) {
            for entry in fs::read_dir(folder.join("media"))? {
                names.push(format!("media/{}", entry?.file_name().to_string_lossy()))
            }
        }
        names.sort();
        let mut files = vec![];
        for path in names {
            let bytes = fs::read(folder.join(&path))?;
            files.push(BackupFile {
                path,
                sha256: digest(&bytes),
                bytes: bytes.len() as u64,
            })
        }
        count = files.len();
        let manifest = Manifest {
            format: 1,
            schema_version,
            created_at: util::iso(util::now()),
            files,
        };
        let mut bytes = serde_json::to_vec_pretty(&manifest)?;
        bytes.push(b'\n');
        private_file(&folder.join("manifest.json"), &bytes)?;
        Ok(())
    })?;
    Ok(json!({"backup":destination,"files":count}))
}
pub fn restore_workspace(input: &Path, output: &Path) -> Result<Value> {
    let source = absolute(input)?;
    let destination = absolute(output)?;
    let manifest_path = source.join("manifest.json");
    regular(&manifest_path)?;
    let manifest: Manifest = serde_json::from_slice(&fs::read(manifest_path)?)?;
    if manifest.format != 1 {
        return fail("Unsupported backup format");
    }
    if manifest.schema_version != SCHEMA_VERSION {
        return fail("This backup uses an unsupported workspace schema");
    }
    util::time(&manifest.created_at)?;
    let mut seen = HashSet::new();
    for file in &manifest.files {
        if !["workspace.sqlite", "connections.sqlite"].contains(&file.path.as_str())
            && !file.path.strip_prefix("media/").is_some_and(hash_name)
        {
            return fail("Invalid backup file manifest");
        }
        if !hash_name(&file.sha256) || !seen.insert(&file.path) {
            return fail("Invalid backup file manifest");
        }
    }
    if !manifest.files.iter().any(|f| f.path == "workspace.sqlite") {
        return fail("Invalid backup file manifest");
    }
    stage(&destination, |folder| {
        for file in &manifest.files {
            let path = source.join(&file.path);
            regular(&path)?;
            if file.path.starts_with("media/")
                && fs::symlink_metadata(source.join("media"))?
                    .file_type()
                    .is_symlink()
            {
                return fail("Backup media cannot use a symbolic link");
            }
            let bytes = fs::read(path)?;
            if bytes.len() as u64 != file.bytes
                || digest(&bytes) != file.sha256
                || (file.path.starts_with("media/")
                    && file.path.strip_prefix("media/") != Some(file.sha256.as_str()))
            {
                return fail("The backup file failed its checksum");
            }
            let target = folder.join(&file.path);
            private_directory(target.parent().unwrap())?;
            private_file(&target, &bytes)?
        }
        if verify_database(&folder.join("workspace.sqlite"), true)? != manifest.schema_version {
            return fail("Backup schema version does not match its manifest");
        }
        if exists(&folder.join("connections.sqlite")) {
            verify_database(&folder.join("connections.sqlite"), false)?;
        }
        Ok(())
    })?;
    Ok(json!({"workspace":destination,"database":destination.join("workspace.sqlite")}))
}

pub fn export_workspace(database: &Path, output: &Path) -> Result<Value> {
    let source = absolute(database)?;
    let destination = absolute(output)?;
    if source == destination {
        return fail("Export configuration to a separate JSON file");
    }
    regular(&source)?;
    let db = Connection::open(&source)?;
    db.busy_timeout(Duration::from_secs(10))?;
    crate::storage::initialize(&db)?;
    let root = source
        .parent()
        .ok_or_else(|| Error::validation("Choose a workspace database"))?
        .to_owned();
    let mut ws = Workspace {
        db,
        config: Value::Null,
        root,
        mode: "live".into(),
        now: util::now(),
        access_context: util::id(),
        automations_directory: None,
    };
    ws.db.execute_batch("BEGIN IMMEDIATE")?;
    let loaded = ws.reload_config();
    match loaded {
        Ok(()) => ws.db.execute_batch("COMMIT")?,
        Err(e) => {
            let _ = ws.db.execute_batch("ROLLBACK");
            return Err(e);
        }
    }
    let parent = destination
        .parent()
        .ok_or_else(|| Error::validation("Choose a JSON output file"))?;
    private_directory(parent)?;
    let temporary = parent.join(format!(".goodfinds-export-{}.tmp", util::id()));
    let mut bytes = serde_json::to_vec_pretty(&ws.config)?;
    bytes.push(b'\n');
    let written: Result<()> = (|| {
        private_file(&temporary, &bytes)?;
        fs::rename(&temporary, &destination)?;
        #[cfg(unix)]
        File::open(parent)?.sync_all()?;
        Ok(())
    })();
    if written.is_err() {
        let _ = fs::remove_file(&temporary);
    }
    written?;
    Ok(json!({"database":source,"config":destination}))
}

#[cfg(test)]
mod tests {
    use super::*;
    fn workspace(root: &Path) -> Workspace {
        Workspace::open(root, "live", "backup-test").unwrap()
    }
    #[test]
    fn wal_snapshot_restores_settings_connections_and_media_without_overwrites() {
        let dir = tempfile::tempdir().unwrap();
        let mut ws = workspace(&dir.path().join("workspace"));
        ws.config["origin"] = json!("Example town");
        ws.save_config().unwrap();
        ws.db.execute("INSERT INTO checks.connection_checks VALUES('id','request','context','hash','complete','2026-10-08T00:00:00Z','{}')",[]).unwrap();
        let media = ws.root.join("media");
        fs::create_dir(&media).unwrap();
        let bytes = b"fixture media";
        let name = digest(bytes);
        fs::write(media.join(&name), bytes).unwrap();
        let target = dir.path().join("backup");
        let result = backup_workspace(&ws.root.join("workspace.sqlite"), &target).unwrap();
        assert_eq!(result["files"], 3);
        let restore = dir.path().join("restored");
        restore_workspace(&target, &restore).unwrap();
        let restored = workspace(&restore);
        assert_eq!(restored.config["origin"], "Example town");
        assert_eq!(fs::read(restore.join("media").join(name)).unwrap(), bytes);
        let count: i64 = restored
            .db
            .query_row("SELECT COUNT(*) FROM checks.connection_checks", [], |r| {
                r.get(0)
            })
            .unwrap();
        assert_eq!(count, 1);
        assert!(backup_workspace(&ws.root.join("workspace.sqlite"), &target).is_err());
        assert!(restore_workspace(&target, &restore).is_err());
        assert_eq!(restored.config["origin"], "Example town");
    }
    #[test]
    fn corrupt_media_checksum_or_manifest_does_not_publish_partial_restore() {
        let dir = tempfile::tempdir().unwrap();
        let ws = workspace(&dir.path().join("workspace"));
        let backup = dir.path().join("backup");
        backup_workspace(&ws.root.join("workspace.sqlite"), &backup).unwrap();
        fs::write(backup.join("workspace.sqlite"), b"corrupt").unwrap();
        let restore = dir.path().join("restored");
        assert!(restore_workspace(&backup, &restore).is_err());
        assert!(!restore.exists());
        assert!(!fs::read_dir(dir.path()).unwrap().any(|e| {
            e.unwrap()
                .file_name()
                .to_string_lossy()
                .starts_with(".goodfinds-backup-")
        }));
        let media = ws.root.join("media");
        fs::create_dir(&media).unwrap();
        fs::write(media.join("a".repeat(64)), b"wrong hash").unwrap();
        assert!(
            backup_workspace(
                &ws.root.join("workspace.sqlite"),
                &dir.path().join("bad-backup")
            )
            .is_err()
        );
        assert!(!dir.path().join("bad-backup").exists());
    }
    #[test]
    fn traversal_duplicates_and_wrong_schema_are_rejected() {
        let dir = tempfile::tempdir().unwrap();
        let ws = workspace(&dir.path().join("workspace"));
        let backup = dir.path().join("backup");
        backup_workspace(&ws.root.join("workspace.sqlite"), &backup).unwrap();
        let path = backup.join("manifest.json");
        let original: Value = serde_json::from_slice(&fs::read(&path).unwrap()).unwrap();
        for corruption in 0..3 {
            let mut m = original.clone();
            match corruption {
                0 => m["files"][0]["path"] = json!("../workspace/workspace.sqlite"),
                1 => {
                    let file = m["files"][0].clone();
                    m["files"].as_array_mut().unwrap().push(file)
                }
                _ => m["schema_version"] = json!(999),
            }
            fs::write(&path, serde_json::to_vec(&m).unwrap()).unwrap();
            let target = dir.path().join(format!("restore-{corruption}"));
            assert!(restore_workspace(&backup, &target).is_err());
            assert!(!target.exists())
        }
    }
    #[test]
    fn sample_backup_includes_shared_media_and_rejects_media_descendants() {
        let dir = tempfile::tempdir().unwrap();
        let ws = Workspace::open(&dir.path().join("workspace"), "sample", "backup-sample").unwrap();
        let bytes = b"shared media";
        let name = digest(bytes);
        private_directory(&ws.root.join("media")).unwrap();
        fs::write(ws.root.join("media").join(name), bytes).unwrap();
        let target = dir.path().join("sample-backup");
        assert_eq!(
            backup_workspace(&ws.folder().join("workspace.sqlite"), &target).unwrap()["files"],
            3
        );
        assert!(
            backup_workspace(
                &ws.folder().join("workspace.sqlite"),
                &ws.root.join("media/nested")
            )
            .is_err()
        );
    }
    #[test]
    fn export_respects_database_name_and_preserves_database() {
        let dir = tempfile::tempdir().unwrap();
        let root = dir.path().join("workspace");
        let mut ws = workspace(&root);
        ws.config["origin"] = json!("Example export town");
        ws.save_config().unwrap();
        let db = root.join("workspace.sqlite");
        let output = dir.path().join("config.json");
        export_workspace(&db, &output).unwrap();
        let config: Value = serde_json::from_slice(&fs::read(&output).unwrap()).unwrap();
        assert_eq!(config["origin"], "Example export town");
        assert!(export_workspace(&db, &db).is_err());
        assert_eq!(verify_database(&db, true).unwrap(), SCHEMA_VERSION);
    }
    #[cfg(unix)]
    #[test]
    fn symlinked_database_or_media_is_rejected() {
        use std::os::unix::fs::symlink;
        let dir = tempfile::tempdir().unwrap();
        let ws = workspace(&dir.path().join("workspace"));
        let link = dir.path().join("linked.sqlite");
        symlink(ws.root.join("workspace.sqlite"), &link).unwrap();
        assert!(backup_workspace(&link, &dir.path().join("backup-link")).is_err());
        let media = dir.path().join("outside-media");
        fs::create_dir(&media).unwrap();
        symlink(&media, ws.root.join("media")).unwrap();
        assert!(
            backup_workspace(
                &ws.root.join("workspace.sqlite"),
                &dir.path().join("backup-media")
            )
            .is_err()
        );
        assert!(!dir.path().join("backup-media").exists());
    }
    #[test]
    fn publication_never_replaces_an_existing_empty_directory() {
        let dir = tempfile::tempdir().unwrap();
        let stage = dir.path().join("stage");
        let destination = dir.path().join("destination");
        fs::create_dir(&stage).unwrap();
        fs::write(stage.join("sentinel"), b"staged").unwrap();
        fs::create_dir(&destination).unwrap();
        assert!(publish_new(&stage, &destination).is_err());
        assert!(stage.join("sentinel").is_file());
        assert!(fs::read_dir(&destination).unwrap().next().is_none());
    }
}
