//! Actual ssh-keygen + application askpass. All key material lives in a disposable home.
use gitmanagement_lib::ssh_keys::{generate_with_directory, read_public, SshKeyGenerate};
use std::path::Path;
use std::process::Command;

fn generate(home: &Path, phrase: &str) -> gitmanagement_lib::error::AppResult<gitmanagement_lib::ssh_keys::SshKeyInfo> {
    generate_with_directory(home, Path::new(env!("CARGO_BIN_EXE_gitmanagement")), SshKeyGenerate {
        name: "id_ed25519".into(), comment: "integration-only".into(), passphrase: phrase.into(),
    })
}
#[test]
fn real_encrypted_key_generation_returns_only_public_material_and_never_overwrites() {
    let home = tempfile::tempdir().unwrap();
    let key = generate(home.path(), "private-test-only-phrase").unwrap();
    assert!(key.public_key.starts_with("ssh-ed25519 "));
    assert!(key.fingerprint.starts_with("SHA256:"));
    let public = read_public(Path::new(&key.public_path)).unwrap();
    assert_eq!(public.public_key, key.public_key);
    let private_path = key.private_path.as_ref().unwrap();
    let before = std::fs::read(private_path).unwrap();
    let fingerprint = Command::new("ssh-keygen").args(["-lf", &key.public_path, "-E", "sha256"]).output().unwrap();
    assert!(fingerprint.status.success());
    assert!(String::from_utf8_lossy(&fingerprint.stdout).contains(&key.fingerprint));
    let without_phrase = Command::new("ssh-keygen").args(["-y", "-P", "", "-f", private_path]).output().unwrap();
    assert!(!without_phrase.status.success(), "generated private key must be encrypted");
    let error = generate(home.path(), "different-phrase").err().unwrap();
    assert_eq!(error.code, "sshKeys.exists");
    assert_eq!(std::fs::read(private_path).unwrap(), before);
    let returned = serde_json::to_string(&key).unwrap();
    assert!(!returned.contains("PRIVATE KEY"));
    assert!(!returned.contains("private-test-only-phrase"));
    #[cfg(unix)] {
        use std::os::unix::fs::PermissionsExt;
        assert_eq!(std::fs::metadata(private_path).unwrap().permissions().mode() & 0o777, 0o600);
        assert_eq!(std::fs::metadata(home.path().join(".ssh")).unwrap().permissions().mode() & 0o777, 0o700);
    }
}
#[test]
fn real_unencrypted_generation_requires_no_terminal_and_validates_public_file_only() {
    let home = tempfile::tempdir().unwrap();
    let key = generate(home.path(), "").unwrap();
    let private = key.private_path.as_ref().unwrap();
    let derived = Command::new("ssh-keygen").args(["-y", "-P", "", "-f", private]).output().unwrap();
    assert!(derived.status.success());
    let public = String::from_utf8(derived.stdout).unwrap();
    assert_eq!(public.split_whitespace().take(2).collect::<Vec<_>>(), key.public_key.split_whitespace().take(2).collect::<Vec<_>>());
    assert_eq!(read_public(Path::new(private)).err().unwrap().code, "sshKeys.invalidPublic");
    let disguised = home.path().join("private.pub");
    std::fs::copy(private, &disguised).unwrap();
    assert_eq!(read_public(&disguised).err().unwrap().code, "sshKeys.invalidPublic");
}
