//! Bounded worktree access with optimistic save and no symlink traversal.
use crate::error::{AppError, AppResult};
use serde::Serialize;
use sha2::{Digest, Sha256};
use std::fs;
use std::io::{Read, Write};
use std::path::{Component, Path, PathBuf};

const MAX_BYTES: u64 = 2 * 1024 * 1024;

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct FileEntry {
    name: String,
    path: String,
    directory: bool,
    symlink: bool,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Directory {
    entries: Vec<FileEntry>,
    truncated: bool,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Document {
    pub text: Option<String>,
    pub revision: String,
    pub size: u64,
    pub eol: String,
    pub bom: bool,
    pub read_only: Option<String>,
}

fn checked_metadata(path: &Path) -> AppResult<fs::Metadata> {
    let metadata = fs::symlink_metadata(path)?;
    if metadata.file_type().is_symlink() {
        return Err(AppError::new("files.unsafePath"));
    }
    // Junctions and other Windows reparse points must not bypass the symlink check.
    #[cfg(windows)]
    {
        use std::os::windows::fs::MetadataExt;
        if metadata.file_attributes() & 0x400 != 0 {
            return Err(AppError::new("files.unsafePath"));
        }
    }
    Ok(metadata)
}

fn resolve(root: &Path, relative: &str) -> AppResult<PathBuf> {
    let root = root.canonicalize()?;
    let mut path = root.clone();
    for component in Path::new(relative).components() {
        match component {
            Component::Normal(name) if !name.to_string_lossy().eq_ignore_ascii_case(".git") => {
                path.push(name);
                checked_metadata(&path)?;
            }
            _ => return Err(AppError::new("files.unsafePath")),
        }
    }
    let path = path.canonicalize()?;
    let bounded = path
        .strip_prefix(&root)
        .map_err(|_| AppError::new("files.unsafePath"))?;
    // Also check canonical names, e.g. Windows short-name aliases for .git.
    if bounded.components().any(|part| {
        part.as_os_str()
            .to_string_lossy()
            .eq_ignore_ascii_case(".git")
    }) {
        return Err(AppError::new("files.unsafePath"));
    }
    Ok(path)
}

/// Mutations accept only explicit, slash-separated repo-relative names, never the root.
/// Inspect the raw string: Path::components normalizes away interior `.` and empty parts.
fn validate_mutation_path(relative: &str) -> AppResult<()> {
    if relative.is_empty()
        || relative.starts_with(['/', '\\'])
        || relative.as_bytes().get(1) == Some(&b':')
        || relative.contains('\\')
    {
        return Err(AppError::new("files.unsafePath"));
    }
    for name in relative.split('/') {
        if name == "." || name == ".." || name.eq_ignore_ascii_case(".git") {
            return Err(AppError::new("files.unsafePath"));
        }
        // Use portable names on every platform: no ADS, device names, or Win32
        // trailing-dot/space aliases. Do not silently trim or normalize user input.
        let stem = name.split('.').next().unwrap_or("").to_ascii_uppercase();
        let reserved = matches!(
            stem.as_str(),
            "CON" | "PRN" | "AUX" | "NUL" | "CONIN$" | "CONOUT$"
        ) || ["COM", "LPT"].iter().any(|prefix| {
            stem.strip_prefix(prefix).map_or(false, |suffix| {
                matches!(
                    suffix,
                    "1" | "2" | "3" | "4" | "5" | "6" | "7" | "8" | "9" | "¹" | "²" | "³"
                )
            })
        });
        if name.trim().is_empty()
            || name.ends_with(['.', ' '])
            || name
                .chars()
                .any(|c| c.is_control() || "<>:\"|?*".contains(c))
            || reserved
        {
            return Err(AppError::new("files.invalidName"));
        }
    }
    Ok(())
}

/// Unlike resolve, the leaf need not exist. Parents must already be real directories.
fn resolve_destination(root: &Path, relative: &str) -> AppResult<PathBuf> {
    validate_mutation_path(relative)?;
    let (parent, name) = relative.rsplit_once('/').unwrap_or(("", relative));
    let parent = resolve(root, parent)?;
    if !checked_metadata(&parent)?.is_dir() {
        return Err(AppError::new("files.unsafePath"));
    }
    let destination = parent.join(name);
    match fs::symlink_metadata(&destination) {
        Ok(_) => {
            checked_metadata(&destination)?;
            Err(AppError::new("files.exists"))
        }
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(destination),
        Err(e) => Err(e.into()),
    }
}

fn mutation_error(error: std::io::Error) -> AppError {
    if error.kind() == std::io::ErrorKind::AlreadyExists {
        AppError::new("files.exists")
    } else {
        error.into()
    }
}

/// Create one empty file or directory, without creating parents or replacing anything.
pub fn create(root: &Path, relative: &str, directory: bool) -> AppResult<()> {
    let destination = resolve_destination(root, relative)?;
    if directory {
        fs::create_dir(destination).map_err(mutation_error)?;
    } else {
        fs::OpenOptions::new()
            .write(true)
            .create_new(true)
            .open(destination)
            .map_err(mutation_error)?;
    }
    Ok(())
}

// std::fs::rename can replace a destination (including an empty directory on Unix).
// Use native, atomic no-replace operations, never an existence-check + plain rename.
#[cfg(any(target_os = "macos", target_os = "linux"))]
fn rename_noreplace(source: &Path, destination: &Path) -> std::io::Result<()> {
    use std::ffi::CString;
    use std::os::raw::{c_char, c_int, c_uint};
    use std::os::unix::ffi::OsStrExt;
    let source = CString::new(source.as_os_str().as_bytes())?;
    let destination = CString::new(destination.as_os_str().as_bytes())?;
    #[cfg(target_os = "macos")]
    let result = {
        extern "C" {
            fn renamex_np(from: *const c_char, to: *const c_char, flags: c_uint) -> c_int;
        }
        // RENAME_EXCL: fail if any destination entry already exists.
        unsafe { renamex_np(source.as_ptr(), destination.as_ptr(), 0x00000004) }
    };
    #[cfg(target_os = "linux")]
    let result = {
        extern "C" {
            fn renameat2(
                from_dir: c_int,
                from: *const c_char,
                to_dir: c_int,
                to: *const c_char,
                flags: c_uint,
            ) -> c_int;
        }
        // AT_FDCWD, RENAME_NOREPLACE. Unsupported kernels/filesystems fail closed.
        unsafe { renameat2(-100, source.as_ptr(), -100, destination.as_ptr(), 1) }
    };
    if result == 0 {
        Ok(())
    } else {
        Err(std::io::Error::last_os_error())
    }
}

#[cfg(windows)]
fn rename_noreplace(source: &Path, destination: &Path) -> std::io::Result<()> {
    use std::os::windows::ffi::OsStrExt;
    #[link(name = "kernel32")]
    extern "system" {
        fn MoveFileExW(from: *const u16, to: *const u16, flags: u32) -> i32;
    }
    let source: Vec<u16> = source.as_os_str().encode_wide().chain(Some(0)).collect();
    let destination: Vec<u16> = destination
        .as_os_str()
        .encode_wide()
        .chain(Some(0))
        .collect();
    // Neither REPLACE_EXISTING nor COPY_ALLOWED: same-volume, no-clobber move only.
    if unsafe { MoveFileExW(source.as_ptr(), destination.as_ptr(), 0) } != 0 {
        Ok(())
    } else {
        Err(std::io::Error::last_os_error())
    }
}

#[cfg(not(any(target_os = "macos", target_os = "linux", windows)))]
fn rename_noreplace(_: &Path, _: &Path) -> std::io::Result<()> {
    Err(std::io::Error::new(
        std::io::ErrorKind::Unsupported,
        "no atomic no-replace rename available",
    ))
}

/// Move a file or directory to an absent path; never merge directories or overwrite.
pub fn rename(root: &Path, relative: &str, new_relative: &str) -> AppResult<()> {
    validate_mutation_path(relative)?;
    validate_mutation_path(new_relative)?;
    let source = resolve(root, relative)?;
    let metadata = checked_metadata(&source)?;
    if !(metadata.is_file() || metadata.is_dir()) {
        return Err(AppError::new("files.unsafePath"));
    }
    let destination = resolve_destination(root, new_relative)?;
    if metadata.is_dir() && destination.starts_with(&source) {
        return Err(AppError::new("files.unsafePath"));
    }
    rename_noreplace(&source, &destination).map_err(mutation_error)
}

/// Intentionally nonrecursive: directories must be empty, including hidden entries.
pub fn delete(root: &Path, relative: &str) -> AppResult<()> {
    validate_mutation_path(relative)?;
    let path = resolve(root, relative)?;
    let metadata = checked_metadata(&path)?;
    if metadata.is_dir() {
        match fs::remove_dir(&path) {
            Ok(()) => Ok(()),
            Err(error) => {
                // Avoid relying on DirectoryNotEmpty, which postdates our Rust MSRV.
                if let Ok(mut entries) = fs::read_dir(&path) {
                    if let Some(Ok(_)) = entries.next() {
                        return Err(AppError::new("files.notEmpty"));
                    }
                }
                Err(error.into())
            }
        }
    } else if metadata.is_file() {
        fs::remove_file(path).map_err(AppError::from)
    } else {
        Err(AppError::new("files.unsafePath"))
    }
}

pub fn list(root: &Path, relative: &str) -> AppResult<Directory> {
    let dir = resolve(root, relative)?;
    let mut entries = Vec::new();
    let mut truncated = false;
    for entry in fs::read_dir(dir)? {
        let entry = entry?;
        let name = match entry.file_name().into_string() {
            Ok(name) if !name.eq_ignore_ascii_case(".git") => name,
            _ => continue,
        };
        if entries.len() == 10_000 {
            truncated = true;
            break;
        }
        let ty = entry.file_type()?;
        entries.push(FileEntry {
            path: if relative.is_empty() {
                name.clone()
            } else {
                format!("{relative}/{name}")
            },
            name,
            directory: ty.is_dir(),
            symlink: ty.is_symlink() || !(ty.is_file() || ty.is_dir()),
        });
    }
    entries.sort_by(|a, b| {
        b.directory
            .cmp(&a.directory)
            .then_with(|| a.name.to_lowercase().cmp(&b.name.to_lowercase()))
            .then(a.name.cmp(&b.name))
    });
    Ok(Directory { entries, truncated })
}

fn read_bytes(path: &Path) -> AppResult<Vec<u8>> {
    if !fs::metadata(path)?.is_file() {
        return Err(AppError::new("files.notFile"));
    }
    let file = fs::File::open(path)?;
    if !file.metadata()?.is_file() {
        return Err(AppError::new("files.notFile"));
    }
    let mut data = Vec::new();
    file.take(MAX_BYTES + 1).read_to_end(&mut data)?;
    Ok(data)
}

fn document(data: &[u8]) -> Document {
    let mut doc = Document {
        text: None,
        revision: format!("{:x}", Sha256::digest(data)),
        size: data.len() as u64,
        eol: "LF".into(),
        bom: data.starts_with(&[0xef, 0xbb, 0xbf]),
        read_only: None,
    };
    if data.len() as u64 > MAX_BYTES {
        doc.read_only = Some("tooLarge".into());
        return doc;
    }
    let bytes = if doc.bom { &data[3..] } else { data };
    let text = match std::str::from_utf8(bytes) {
        Ok(text) if !bytes.contains(&0) => text,
        _ => {
            doc.read_only = Some("binary".into());
            return doc;
        }
    };
    let crlf = text.matches("\r\n").count();
    let lf = text.matches('\n').count();
    let cr = text.matches('\r').count();
    if crlf > 0 && crlf == lf && cr == crlf {
        doc.eol = "CRLF".into();
    } else if cr > 0 {
        doc.eol = "mixed".into();
        doc.read_only = Some("mixedEol".into());
    }
    doc.text = Some(text.replace("\r\n", "\n"));
    doc
}

pub fn read(root: &Path, relative: &str) -> AppResult<Document> {
    let path = resolve(root, relative)?;
    let mut doc = document(&read_bytes(&path)?);
    doc.size = fs::metadata(&path)?.len();
    if doc.read_only.is_none() && fs::metadata(path)?.permissions().readonly() {
        doc.read_only = Some("permissions".into());
    }
    Ok(doc)
}

pub fn save(root: &Path, relative: &str, revision: &str, text: &str) -> AppResult<Document> {
    let path = resolve(root, relative)?;
    let old = read_bytes(&path)?;
    let doc = document(&old);
    if doc.revision != revision {
        return Err(AppError::new("files.conflict"));
    }
    if doc.read_only.is_some() {
        return Err(AppError::new("files.readOnly"));
    }
    let permissions = fs::metadata(&path)?.permissions();
    if permissions.readonly() {
        return Err(AppError::new("files.readOnly"));
    }
    let content = if doc.eol == "CRLF" {
        text.replace("\r\n", "\n").replace('\n', "\r\n")
    } else {
        text.to_string()
    };
    let mut bytes = if doc.bom {
        vec![0xef, 0xbb, 0xbf]
    } else {
        Vec::new()
    };
    bytes.extend_from_slice(content.as_bytes());
    if bytes.len() as u64 > MAX_BYTES {
        return Err(AppError::new("files.tooLarge"));
    }
    let mut tmp = tempfile::NamedTempFile::new_in(
        path.parent()
            .ok_or_else(|| AppError::new("files.unsafePath"))?,
    )?;
    tmp.write_all(&bytes)?;
    tmp.as_file().set_permissions(permissions)?;
    tmp.as_file().sync_all()?;
    // Check again after preparing the replacement, so external edits cannot silently disappear.
    if resolve(root, relative)? != path || read_bytes(&path)? != old {
        return Err(AppError::new("files.conflict"));
    }
    tmp.persist(&path).map_err(|e| AppError::from(e.error))?;
    Ok(document(&bytes))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn file_and_directory_mutation_lifecycle() {
        let root = tempfile::tempdir().unwrap();
        create(root.path(), "folder", true).unwrap();
        create(root.path(), "folder/文件.txt", false).unwrap();
        assert_eq!(fs::read(root.path().join("folder/文件.txt")).unwrap(), b"");
        fs::write(root.path().join("folder/文件.txt"), "keep content").unwrap();
        rename(root.path(), "folder/文件.txt", "folder/renamed.txt").unwrap();
        assert!(!root.path().join("folder/文件.txt").exists());
        rename(root.path(), "folder", "moved").unwrap();
        assert_eq!(
            fs::read_to_string(root.path().join("moved/renamed.txt")).unwrap(),
            "keep content"
        );
        delete(root.path(), "moved/renamed.txt").unwrap();
        delete(root.path(), "moved").unwrap();
        assert_eq!(fs::read_dir(root.path()).unwrap().count(), 0);
    }

    #[test]
    fn create_and_rename_never_replace_existing_entries() {
        let root = tempfile::tempdir().unwrap();
        create(root.path(), "file", false).unwrap();
        fs::write(root.path().join("file"), "original").unwrap();
        create(root.path(), "dir", true).unwrap();
        for name in ["file", "dir"] {
            for directory in [false, true] {
                assert_eq!(
                    create(root.path(), name, directory).unwrap_err().code,
                    "files.exists"
                );
            }
            for source in ["source-file", "source-dir"] {
                if !root.path().join(source).exists() {
                    create(root.path(), source, source == "source-dir").unwrap();
                }
                assert_eq!(
                    rename(root.path(), source, name).unwrap_err().code,
                    "files.exists"
                );
                assert!(root.path().join(source).exists());
                // Exercise the native no-clobber primitive itself, bypassing the
                // preflight check: this is what protects against a racing creator.
                assert!(
                    rename_noreplace(&root.path().join(source), &root.path().join(name)).is_err()
                );
                assert!(root.path().join(source).exists());
            }
        }
        assert_eq!(
            fs::read_to_string(root.path().join("file")).unwrap(),
            "original"
        );
        assert_eq!(fs::read_dir(root.path().join("dir")).unwrap().count(), 0);
        assert_eq!(
            rename(root.path(), "file", "file").unwrap_err().code,
            "files.exists"
        );
    }

    #[test]
    fn rejects_invalid_mutation_paths_and_protects_root_and_git() {
        let root = tempfile::tempdir().unwrap();
        create(root.path(), "source", false).unwrap();
        fs::create_dir(root.path().join(".git")).unwrap();
        fs::write(root.path().join(".git/config"), "metadata").unwrap();
        for (paths, code) in [
            (
                &[
                    "",
                    ".",
                    "..",
                    "./source",
                    "source/.",
                    "a/../b",
                    "../escape",
                    "/absolute",
                    "C:/file",
                    "C:file",
                    "\\\\host\\share",
                    "a\\b",
                    ".git",
                    ".GIT/config",
                    "a/.git/config",
                ][..],
                "files.unsafePath",
            ),
            (
                &[
                    "a//b",
                    "a/",
                    " ",
                    "a/ ",
                    "trailing.",
                    "trailing ",
                    "nul",
                    "CON.txt",
                    "com1",
                    "LPT9.log",
                    "folder/stream:name",
                    "a?b",
                    "a*b",
                    "a\0b",
                    "a\nb",
                ][..],
                "files.invalidName",
            ),
        ] {
            for path in paths {
                for directory in [false, true] {
                    assert_eq!(
                        create(root.path(), path, directory).unwrap_err().code,
                        code,
                        "create {path:?}"
                    );
                }
                assert_eq!(
                    rename(root.path(), path, "target").unwrap_err().code,
                    code,
                    "rename source {path:?}"
                );
                assert_eq!(
                    rename(root.path(), "source", path).unwrap_err().code,
                    code,
                    "rename destination {path:?}"
                );
                assert_eq!(
                    delete(root.path(), path).unwrap_err().code,
                    code,
                    "delete {path:?}"
                );
            }
        }
        assert!(list(root.path(), "").is_ok());
        assert_eq!(
            fs::read_to_string(root.path().join(".git/config")).unwrap(),
            "metadata"
        );
        assert!(root.path().join("source").is_file());
        assert!(!root.path().join("target").exists());
    }

    #[test]
    fn requires_existing_parents_and_refuses_recursive_deletion_and_self_move() {
        let root = tempfile::tempdir().unwrap();
        create(root.path(), "folder", true).unwrap();
        create(root.path(), "folder/.hidden", false).unwrap();
        create(root.path(), "folder/child", true).unwrap();
        assert_eq!(
            delete(root.path(), "folder").unwrap_err().code,
            "files.notEmpty"
        );
        assert_eq!(
            rename(root.path(), "folder", "folder/child/moved")
                .unwrap_err()
                .code,
            "files.unsafePath"
        );
        for directory in [false, true] {
            assert!(create(root.path(), "missing/new", directory).is_err());
        }
        assert!(rename(root.path(), "folder/.hidden", "missing/new").is_err());
        assert!(delete(root.path(), "missing").is_err());
        assert!(root.path().join("folder/.hidden").is_file());
        assert!(!root.path().join("missing").exists());
        delete(root.path(), "folder/.hidden").unwrap();
        assert_eq!(
            delete(root.path(), "folder").unwrap_err().code,
            "files.notEmpty"
        );
        delete(root.path(), "folder/child").unwrap();
        delete(root.path(), "folder").unwrap();
    }

    #[cfg(any(target_os = "macos", target_os = "linux", windows))]
    #[test]
    fn concurrent_renames_have_exactly_one_winner() {
        let root = tempfile::tempdir().unwrap();
        for directory in [false, true] {
            for source in ["a", "b"] {
                create(root.path(), source, directory).unwrap();
                let content = if directory {
                    format!("{source}/content")
                } else {
                    source.to_string()
                };
                fs::write(root.path().join(content), source).unwrap();
            }
            let barrier = std::sync::Arc::new(std::sync::Barrier::new(2));
            let handles: Vec<_> = ["a", "b"]
                .into_iter()
                .map(|source| {
                    let root = root.path().to_path_buf();
                    let barrier = barrier.clone();
                    std::thread::spawn(move || {
                        barrier.wait();
                        (source, rename(&root, source, "winner"))
                    })
                })
                .collect();
            let results: Vec<_> = handles
                .into_iter()
                .map(|handle| handle.join().unwrap())
                .collect();
            assert_eq!(
                results.iter().filter(|(_, result)| result.is_ok()).count(),
                1
            );
            for (source, result) in results {
                let location = if result.is_ok() { "winner" } else { source };
                let content = if directory {
                    format!("{location}/content")
                } else {
                    location.to_string()
                };
                assert_eq!(
                    fs::read_to_string(root.path().join(&content)).unwrap(),
                    source
                );
                delete(root.path(), &content).unwrap();
                if directory {
                    delete(root.path(), location).unwrap();
                }
            }
        }
    }

    #[cfg(unix)]
    #[test]
    fn mutations_refuse_symlinks_in_sources_destinations_and_parents() {
        use std::os::unix::fs::symlink;
        let root = tempfile::tempdir().unwrap();
        let external = tempfile::tempdir().unwrap();
        fs::write(external.path().join("secret"), "keep").unwrap();
        create(root.path(), "source", false).unwrap();
        symlink(external.path(), root.path().join("link")).unwrap();
        symlink(
            external.path().join("secret"),
            root.path().join("file-link"),
        )
        .unwrap();
        symlink(
            external.path().join("missing"),
            root.path().join("dangling"),
        )
        .unwrap();
        for path in ["link", "file-link", "dangling", "link/secret"] {
            assert_eq!(
                delete(root.path(), path).unwrap_err().code,
                "files.unsafePath"
            );
            assert_eq!(
                rename(root.path(), path, "target").unwrap_err().code,
                "files.unsafePath"
            );
            assert_eq!(
                rename(root.path(), "source", path).unwrap_err().code,
                "files.unsafePath"
            );
            for directory in [false, true] {
                assert_eq!(
                    create(root.path(), path, directory).unwrap_err().code,
                    "files.unsafePath"
                );
            }
        }
        assert_eq!(
            create(root.path(), "link/new", false).unwrap_err().code,
            "files.unsafePath"
        );
        assert_eq!(
            rename(root.path(), "source", "link/new").unwrap_err().code,
            "files.unsafePath"
        );
        assert!(!external.path().join("new").exists());
        assert_eq!(
            fs::read_to_string(external.path().join("secret")).unwrap(),
            "keep"
        );
        assert!(root.path().join("source").exists());
        assert!(fs::symlink_metadata(root.path().join("dangling")).is_ok());
    }

    #[test]
    fn save_preserves_bom_crlf_permissions_and_detects_conflicts() {
        let root = tempfile::tempdir().unwrap();
        let path = root.path().join("file.txt");
        fs::write(&path, b"\xef\xbb\xbfhello\r\nworld\r\n").unwrap();
        let doc = read(root.path(), "file.txt").unwrap();
        assert_eq!(doc.text.as_deref(), Some("hello\nworld\n"));
        save(root.path(), "file.txt", &doc.revision, "changed\n").unwrap();
        assert_eq!(fs::read(&path).unwrap(), b"\xef\xbb\xbfchanged\r\n");
        assert_eq!(
            save(root.path(), "file.txt", &doc.revision, "stale")
                .unwrap_err()
                .code,
            "files.conflict"
        );
    }

    #[test]
    fn protects_binary_mixed_large_paths_and_git_metadata() {
        let root = tempfile::tempdir().unwrap();
        fs::write(root.path().join("binary"), [0, 255]).unwrap();
        fs::write(root.path().join("mixed"), "one\r\ntwo\n").unwrap();
        fs::write(
            root.path().join("large"),
            vec![b'x'; MAX_BYTES as usize + 1],
        )
        .unwrap();
        assert_eq!(
            read(root.path(), "binary").unwrap().read_only.as_deref(),
            Some("binary")
        );
        assert_eq!(
            read(root.path(), "mixed").unwrap().read_only.as_deref(),
            Some("mixedEol")
        );
        assert_eq!(
            read(root.path(), "large").unwrap().read_only.as_deref(),
            Some("tooLarge")
        );
        for path in ["../escape", "/tmp/file", ".git/config", "nested/../../x"] {
            assert!(read(root.path(), path).is_err());
        }
    }

    #[test]
    fn lists_directories_first_and_excludes_git() {
        let root = tempfile::tempdir().unwrap();
        fs::create_dir(root.path().join("z-dir")).unwrap();
        fs::create_dir(root.path().join(".git")).unwrap();
        fs::write(root.path().join("a.txt"), "").unwrap();
        let dir = list(root.path(), "").unwrap();
        assert_eq!(dir.entries.len(), 2);
        assert_eq!(dir.entries[0].name, "z-dir");
    }

    #[cfg(unix)]
    #[test]
    fn refuses_symlink_targets() {
        let root = tempfile::tempdir().unwrap();
        let external = tempfile::tempdir().unwrap();
        fs::write(external.path().join("secret"), "keep").unwrap();
        std::os::unix::fs::symlink(external.path(), root.path().join("link")).unwrap();
        assert!(list(root.path(), "link").is_err());
        assert!(read(root.path(), "link/secret").is_err());
        assert!(save(root.path(), "link/secret", "", "overwrite").is_err());
        assert_eq!(
            fs::read_to_string(external.path().join("secret")).unwrap(),
            "keep"
        );
    }
}
