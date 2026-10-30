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

fn resolve(root: &Path, relative: &str) -> AppResult<PathBuf> {
    let mut path = root.canonicalize()?;
    for component in Path::new(relative).components() {
        match component {
            Component::Normal(name) if !name.to_string_lossy().eq_ignore_ascii_case(".git") => {
                path.push(name);
                if fs::symlink_metadata(&path)?.file_type().is_symlink() {
                    return Err(AppError::new("files.unsafePath"));
                }
            }
            _ => return Err(AppError::new("files.unsafePath")),
        }
    }
    Ok(path)
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
