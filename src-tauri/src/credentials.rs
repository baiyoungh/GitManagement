//! Enumerable metadata for multi-account HTTP(S) credentials. Secrets live only
//! in the OS keyring; key identities are unrelated to mutable URL/account data.

use crate::error::{AppError, AppResult};
use crate::security;
use crate::storage::Db;
use rusqlite::{params, Connection, OptionalExtension};
use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
pub struct CredentialProfile {
    pub id: String,
    pub name: String,
    /// Canonical HTTP(S) origin, without userinfo, path, query, or fragment.
    pub url: String,
    pub username: String,
}

// Deliberately not Debug or Serialize: this request can carry a secret.
#[derive(Deserialize)]
pub struct CredentialInput {
    pub id: Option<String>,
    pub name: String,
    pub url: String,
    pub username: String,
    pub secret: Option<String>,
}

trait SecretStore {
    fn get(&self, key: &str) -> AppResult<Option<(String, String)>>;
    fn put(&self, key: &str, username: &str, secret: &str) -> AppResult<()>;
    /// Must be idempotent (NoEntry is success).
    fn remove(&self, key: &str) -> AppResult<()>;
}

struct KeyringStore;
impl SecretStore for KeyringStore {
    fn get(&self, key: &str) -> AppResult<Option<(String, String)>> {
        security::load_credential_result(key)
    }
    fn put(&self, key: &str, username: &str, secret: &str) -> AppResult<()> {
        security::save_credential(key, username, secret)
    }
    fn remove(&self, key: &str) -> AppResult<()> {
        security::delete_credential(key)
    }
}

fn not_found() -> AppError {
    AppError::new("credential.notFound")
}
fn invalid(field: &str) -> AppError {
    AppError::new("credential.invalidInput").param("field", field)
}
// Do not propagate arbitrary SQLite trigger/error text through this boundary.
fn db_error(_: rusqlite::Error) -> AppError {
    AppError::new("db.error")
}

fn row(r: &rusqlite::Row<'_>) -> rusqlite::Result<(CredentialProfile, String)> {
    Ok((
        CredentialProfile {
            id: r.get(0)?,
            name: r.get(1)?,
            url: r.get(2)?,
            username: r.get(3)?,
        },
        r.get(4)?,
    ))
}
fn get(conn: &Connection, id: &str) -> AppResult<(CredentialProfile, String)> {
    conn.query_row(
        "SELECT id, name, url, username, keyring_key FROM credential_profile WHERE id = ?1",
        [id],
        row,
    )
    .optional()
    .map_err(db_error)?
    .ok_or_else(not_found)
}

pub fn list(db: &Db) -> AppResult<Vec<CredentialProfile>> {
    let conn = db.conn();
    let mut stmt = conn.prepare(
        "SELECT id, name, url, username, keyring_key FROM credential_profile ORDER BY name COLLATE NOCASE, id"
    ).map_err(db_error)?;
    let rows = stmt
        .query_map([], |r| row(r).map(|(profile, _)| profile))
        .map_err(db_error)?;
    rows.collect::<Result<_, _>>().map_err(db_error)
}

/// Username hints are case-sensitive, percent-decoded, and never include passwords.
pub fn matching(db: &Db, url: &str) -> AppResult<Vec<CredentialProfile>> {
    let (origin, hint) = security::http_scope(url).ok_or_else(|| invalid("url"))?;
    Ok(list(db)?
        .into_iter()
        .filter(|p| p.url == origin && hint.as_ref().map_or(true, |u| u == &p.username))
        .collect())
}

pub fn save(db: &Db, input: CredentialInput) -> AppResult<CredentialProfile> {
    save_with(db, input, &KeyringStore)
}
pub fn delete(db: &Db, id: &str) -> AppResult<()> {
    delete_with(db, id, &KeyringStore)
}
pub fn load(db: &Db, id: &str) -> AppResult<(CredentialProfile, String)> {
    load_with(db, id, &KeyringStore)
}

/// Legacy keychains cannot be enumerated. Only query an old host entry on demand
/// when no catalog profile matches this origin/account hint. Never hides denial.
pub fn load_legacy_if_unmatched(db: &Db, url: &str) -> AppResult<Option<(String, String)>> {
    legacy_with(db, url, &KeyringStore)
}
fn legacy_with(
    db: &Db,
    url: &str,
    store: &impl SecretStore,
) -> AppResult<Option<(String, String)>> {
    let (origin, hint) = security::http_scope(url).ok_or_else(|| invalid("url"))?;
    if !matching(db, url)?.is_empty() {
        return Ok(None);
    }
    Ok(store
        .get(&origin)?
        .filter(|(username, _)| hint.as_ref().map_or(true, |h| h == username)))
}

fn load_with(
    db: &Db,
    id: &str,
    store: &impl SecretStore,
) -> AppResult<(CredentialProfile, String)> {
    // Hold the DB lock across keyring access so a concurrent edit cannot retire
    // the version being loaded. All catalog mutations use this same lock.
    let conn = db.conn();
    let (profile, key) = get(&conn, id)?;
    let (_, secret) = store.get(&key)?.ok_or_else(not_found)?;
    Ok((profile, secret))
}

/// Retry retired/staged keys. Failures leave a durable, metadata-only cleanup
/// record; never delete an entry still referenced by a live profile.
fn cleanup(conn: &Connection, id: Option<&str>, store: &impl SecretStore) -> AppResult<()> {
    let mut stmt = conn
        .prepare(
            "SELECT keyring_key FROM credential_key_cleanup WHERE (?1 IS NULL OR profile_id = ?1)
         AND keyring_key NOT IN (SELECT keyring_key FROM credential_profile)",
        )
        .map_err(db_error)?;
    let keys: Vec<String> = stmt
        .query_map([id], |r| r.get(0))
        .map_err(db_error)?
        .collect::<Result<_, _>>()
        .map_err(db_error)?;
    drop(stmt);
    let mut first_error = None;
    for key in keys {
        // Attempt every key: one denied retired version must not prevent
        // rollback of an unrelated newly staged version.
        let result = store.remove(&key).and_then(|()| {
            conn.execute(
                "DELETE FROM credential_key_cleanup WHERE keyring_key = ?1",
                [&key],
            )
            .map_err(db_error)?;
            Ok(())
        });
        if first_error.is_none() {
            first_error = result.err();
        }
    }
    first_error.map_or(Ok(()), Err)
}

fn save_with(
    db: &Db,
    input: CredentialInput,
    store: &impl SecretStore,
) -> AppResult<CredentialProfile> {
    let name = input.name.trim();
    let username = input.username.trim();
    if name.is_empty() || name.chars().any(char::is_control) {
        return Err(invalid("name"));
    }
    if username.is_empty() || username.chars().any(char::is_control) {
        return Err(invalid("username"));
    }
    // Catalog input must not carry embedded secrets; even a username-only URL
    // is rejected so explicit username is the single account source of truth.
    let (url, hint) = security::http_scope(&input.url).ok_or_else(|| invalid("url"))?;
    let parsed = tauri::Url::parse(&input.url).map_err(|_| invalid("url"))?;
    if hint.is_some()
        || parsed.password().is_some()
        || input
            .url
            .split("://")
            .nth(1)
            .and_then(|r| r.split(['/', '?', '#']).next())
            .is_some_and(|a| a.contains('@'))
    {
        return Err(invalid("url"));
    }
    if input.secret.as_ref().is_some_and(|s| s.is_empty() || s.len() > 16384 || s.contains(['\r', '\n', '\0'])) {
        return Err(invalid("secret"));
    }
    let mut conn = db.conn();
    let previous = input.id.as_deref().map(|id| get(&conn, id)).transpose()?;
    let id = previous
        .as_ref()
        .map(|(p, _)| p.id.clone())
        .unwrap_or_else(|| uuid::Uuid::new_v4().to_string());
    let profile = CredentialProfile {
        id,
        name: name.into(),
        url,
        username: username.into(),
    };
    let Some(secret) = input.secret else {
        let (_, key) = previous.ok_or_else(|| invalid("secret"))?;
        // Metadata-only edit deliberately does not read/write the keyring.
        conn.execute("UPDATE credential_profile SET name = ?2, url = ?3, username = ?4 WHERE id = ?1 AND keyring_key = ?5",
            params![profile.id, profile.name, profile.url, profile.username, key]).map_err(db_error)?;
        return Ok(profile);
    };
    // Best effort retries include failed creates which have no profile ID left
    // for a caller to address. They never turn a committed edit into an error.
    let _ = cleanup(&conn, None, store);
    let key = format!("credential:v1:{}:{}", profile.id, uuid::Uuid::new_v4());
    // Reserve a cleanup record BEFORE touching the keyring. On crashes or failed
    // rollback this record makes an otherwise orphaned staged secret retryable.
    conn.execute(
        "INSERT INTO credential_key_cleanup (keyring_key, profile_id) VALUES (?1, ?2)",
        params![key, profile.id],
    )
    .map_err(db_error)?;
    if let Err(error) = store.put(&key, &profile.username, &secret) {
        let _ = cleanup(&conn, Some(&profile.id), store);
        return Err(error);
    }
    let persist = (|| -> AppResult<()> {
        let tx = conn.transaction().map_err(db_error)?;
        tx.execute("INSERT INTO credential_profile (id, name, url, username, keyring_key) VALUES (?1, ?2, ?3, ?4, ?5)
            ON CONFLICT(id) DO UPDATE SET name = excluded.name, url = excluded.url,
            username = excluded.username, keyring_key = excluded.keyring_key",
            params![profile.id, profile.name, profile.url, profile.username, key]).map_err(db_error)?;
        tx.execute(
            "DELETE FROM credential_key_cleanup WHERE keyring_key = ?1",
            [&key],
        )
        .map_err(db_error)?;
        if let Some((_, old_key)) = &previous {
            tx.execute("INSERT OR IGNORE INTO credential_key_cleanup (keyring_key, profile_id) VALUES (?1, ?2)",
                params![old_key, profile.id]).map_err(db_error)?;
        }
        tx.commit().map_err(db_error)
    })();
    // On failure, the active key is still the old version; remove the staged
    // version. On success, remove the retired version. Failed cleanup is queued.
    let _ = cleanup(&conn, Some(&profile.id), store);
    persist?;
    Ok(profile)
}

fn delete_with(db: &Db, id: &str, store: &impl SecretStore) -> AppResult<()> {
    let conn = db.conn();
    let (_, key) = get(&conn, id)?;
    cleanup(&conn, Some(id), store)?;
    // Read for compensation if SQLite deletion fails after the keyring delete.
    let original = store.get(&key)?;
    store.remove(&key)?;
    if let Err(error) = conn.execute("DELETE FROM credential_profile WHERE id = ?1", [id]) {
        if let Some((username, secret)) = original {
            if store.put(&key, &username, &secret).is_err() {
                // Both systems failed; metadata is retained, not silently lost.
                return Err(AppError::new("credential.deleteRollbackFailed"));
            }
        }
        return Err(db_error(error));
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::cell::{Cell, RefCell};
    use std::collections::HashMap;

    #[derive(Default)]
    struct MemoryStore {
        values: RefCell<HashMap<String, (String, String)>>,
        deny: Cell<bool>,
        deny_delete: Cell<bool>,
        reads: Cell<usize>,
    }
    impl SecretStore for MemoryStore {
        fn get(&self, key: &str) -> AppResult<Option<(String, String)>> {
            self.reads.set(self.reads.get() + 1);
            if self.deny.get() {
                return Err(AppError::new("credential.accessDenied"));
            }
            Ok(self.values.borrow().get(key).cloned())
        }
        fn put(&self, key: &str, username: &str, secret: &str) -> AppResult<()> {
            if self.deny.get() {
                return Err(AppError::new("credential.accessDenied"));
            }
            self.values
                .borrow_mut()
                .insert(key.into(), (username.into(), secret.into()));
            Ok(())
        }
        fn remove(&self, key: &str) -> AppResult<()> {
            if self.deny.get() || self.deny_delete.get() {
                return Err(AppError::new("credential.accessDenied"));
            }
            self.values.borrow_mut().remove(key);
            Ok(())
        }
    }
    fn input(username: &str) -> CredentialInput {
        CredentialInput {
            id: None,
            name: format!("Account {username}"),
            url: "https://GitHub.com:443/team/repo.git?x=y".into(),
            username: username.into(),
            secret: Some("test-only-secret".into()),
        }
    }
    fn edit(profile: &CredentialProfile, secret: Option<&str>) -> CredentialInput {
        CredentialInput {
            id: Some(profile.id.clone()),
            name: "Renamed".into(),
            url: "https://other.example:8443/path".into(),
            username: "other-user".into(),
            secret: secret.map(str::to_string),
        }
    }

    #[test]
    fn metadata_and_multi_account_matching() {
        let db = Db::open_in_memory().unwrap();
        let store = MemoryStore::default();
        let alice = save_with(&db, input("alice"), &store).unwrap();
        let bob = save_with(&db, input("bob"), &store).unwrap();
        assert_eq!(alice.url, "https://github.com");
        assert!(uuid::Uuid::parse_str(&alice.id).is_ok());
        assert_ne!(alice.id, bob.id);
        assert_eq!(matching(&db, "https://github.com/a").unwrap().len(), 2);
        assert_eq!(
            matching(&db, "https://%61lice:ignored@GITHUB.com:443/a?x").unwrap(),
            vec![alice]
        );
        assert!(matching(&db, "https://Alice@github.com")
            .unwrap()
            .is_empty());
        assert!(matching(&db, "http://github.com").unwrap().is_empty());
        assert!(matching(&db, "https://github.com:444").unwrap().is_empty());
        let json = serde_json::to_string(&list(&db).unwrap()).unwrap();
        assert!(!json.contains("secret"));
        assert!(!json.contains("keyring"));
        let conn = db.conn();
        let metadata: String = conn.query_row("SELECT group_concat(id || name || url || username || keyring_key) FROM credential_profile", [], |r| r.get(0)).unwrap();
        assert!(!metadata.contains("test-only-secret"));
        let columns: Vec<String> = conn
            .prepare("PRAGMA table_info(credential_profile)")
            .unwrap()
            .query_map([], |r| r.get(1))
            .unwrap()
            .collect::<Result<_, _>>()
            .unwrap();
        assert_eq!(
            columns,
            vec!["id", "name", "url", "username", "keyring_key"]
        );
    }

    #[test]
    fn omitted_secret_survives_account_and_origin_edit_without_keyring_access() {
        let db = Db::open_in_memory().unwrap();
        let store = MemoryStore::default();
        let p = save_with(&db, input("alice"), &store).unwrap();
        let old_key = get(&db.conn(), &p.id).unwrap().1;
        store.deny.set(true);
        let edited = save_with(&db, edit(&p, None), &store).unwrap();
        assert_eq!(edited.id, p.id);
        assert_eq!(get(&db.conn(), &p.id).unwrap().1, old_key);
        store.deny.set(false);
        let (loaded, secret) = load_with(&db, &p.id, &store).unwrap();
        assert_eq!(loaded.username, "other-user");
        assert_eq!(secret, "test-only-secret");
    }

    #[test]
    fn secret_rotation_cleanup_retries_and_delete() {
        let db = Db::open_in_memory().unwrap();
        let store = MemoryStore::default();
        let p = save_with(&db, input("alice"), &store).unwrap();
        let old = get(&db.conn(), &p.id).unwrap().1;
        store.deny_delete.set(true);
        save_with(&db, edit(&p, Some("replacement")), &store).unwrap();
        assert_ne!(get(&db.conn(), &p.id).unwrap().1, old);
        assert_eq!(load_with(&db, &p.id, &store).unwrap().1, "replacement");
        assert_eq!(store.values.borrow().len(), 2);
        assert!(delete_with(&db, &p.id, &store).is_err());
        assert_eq!(list(&db).unwrap().len(), 1);
        store.deny_delete.set(false);
        delete_with(&db, &p.id, &store).unwrap();
        assert!(store.values.borrow().is_empty());
        assert!(list(&db).unwrap().is_empty());
    }

    #[test]
    fn failed_metadata_write_rolls_back_new_key_and_preserves_old() {
        let db = Db::open_in_memory().unwrap();
        let store = MemoryStore::default();
        let p = save_with(&db, input("alice"), &store).unwrap();
        db.conn().execute_batch("CREATE TRIGGER fail_update BEFORE UPDATE ON credential_profile BEGIN SELECT RAISE(ABORT, 'failure'); END;").unwrap();
        assert!(save_with(&db, edit(&p, Some("new-secret")), &store).is_err());
        assert_eq!(
            load_with(&db, &p.id, &store).unwrap(),
            (p, "test-only-secret".into())
        );
        assert_eq!(store.values.borrow().len(), 1);
        db.conn().execute_batch("CREATE TRIGGER fail_insert BEFORE INSERT ON credential_profile BEGIN SELECT RAISE(ABORT, 'failure'); END;").unwrap();
        assert!(save_with(&db, input("bob"), &store).is_err());
        assert_eq!(store.values.borrow().len(), 1);
    }

    #[test]
    fn failed_create_rollback_is_durable_and_retried() {
        let db = Db::open_in_memory().unwrap();
        let store = MemoryStore::default();
        db.conn().execute_batch("CREATE TRIGGER fail_insert BEFORE INSERT ON credential_profile BEGIN SELECT RAISE(ABORT, 'failure'); END;").unwrap();
        store.deny_delete.set(true);
        assert!(save_with(&db, input("alice"), &store).is_err());
        assert!(list(&db).unwrap().is_empty());
        assert_eq!(store.values.borrow().len(), 1);
        let queued: i64 = db
            .conn()
            .query_row("SELECT COUNT(*) FROM credential_key_cleanup", [], |r| {
                r.get(0)
            })
            .unwrap();
        assert_eq!(queued, 1);
        db.conn()
            .execute_batch("DROP TRIGGER fail_insert;")
            .unwrap();
        store.deny_delete.set(false);
        save_with(&db, input("bob"), &store).unwrap();
        assert_eq!(store.values.borrow().len(), 1);
        let queued: i64 = db
            .conn()
            .query_row("SELECT COUNT(*) FROM credential_key_cleanup", [], |r| {
                r.get(0)
            })
            .unwrap();
        assert_eq!(queued, 0);
    }

    #[test]
    fn denied_write_never_creates_metadata_and_missing_differs_from_denied() {
        let db = Db::open_in_memory().unwrap();
        let store = MemoryStore::default();
        store.deny.set(true);
        assert_eq!(
            save_with(&db, input("alice"), &store).unwrap_err().code,
            "credential.accessDenied"
        );
        assert!(list(&db).unwrap().is_empty());
        store.deny.set(false);
        let p = save_with(&db, input("alice"), &store).unwrap();
        store.deny.set(true);
        assert_eq!(
            load_with(&db, &p.id, &store).unwrap_err().code,
            "credential.accessDenied"
        );
        store.deny.set(false);
        let key = get(&db.conn(), &p.id).unwrap().1;
        store.remove(&key).unwrap();
        assert_eq!(
            load_with(&db, &p.id, &store).unwrap_err().code,
            "credential.notFound"
        );
    }

    #[test]
    fn failed_delete_metadata_write_restores_secret() {
        let db = Db::open_in_memory().unwrap();
        let store = MemoryStore::default();
        let p = save_with(&db, input("alice"), &store).unwrap();
        db.conn().execute_batch("CREATE TRIGGER fail_delete BEFORE DELETE ON credential_profile BEGIN SELECT RAISE(ABORT, 'failure'); END;").unwrap();
        assert!(delete_with(&db, &p.id, &store).is_err());
        assert_eq!(load_with(&db, &p.id, &store).unwrap().1, "test-only-secret");
    }

    #[test]
    fn validation_never_exposes_request_secret() {
        let db = Db::open_in_memory().unwrap();
        let store = MemoryStore::default();
        for url in [
            "ssh://git@host",
            "https:///missing",
            "https://alice:topsecret@host",
            "https://alice@host",
            "https://host:",
            "https://host:bad",
            "https://host:65536",
            "https://a b",
        ] {
            let mut i = input("alice");
            i.url = url.into();
            let error = save_with(&db, i, &store).unwrap_err();
            assert!(!format!("{error:?}").contains("topsecret"));
        }
        let mut i = input("");
        assert!(save_with(&db, i, &store).is_err());
        i = input("alice");
        i.name = "  ".into();
        assert!(save_with(&db, i, &store).is_err());
        i = input("alice");
        i.secret = None;
        assert!(save_with(&db, i, &store).is_err());
        i = input("alice");
        i.secret = Some(String::new());
        assert!(save_with(&db, i, &store).is_err());
        i = input("alice");
        i.id = Some("missing".into());
        assert!(save_with(&db, i, &store).is_err());
        assert!(store.values.borrow().is_empty());
    }

    #[test]
    fn legacy_only_on_demand_and_only_without_catalog_match() {
        let db = Db::open_in_memory().unwrap();
        let store = MemoryStore::default();
        store.put("https://github.com", "alice", "old").unwrap();
        assert!(list(&db).unwrap().is_empty());
        assert_eq!(
            legacy_with(&db, "https://alice@github.com/repo", &store).unwrap(),
            Some(("alice".into(), "old".into()))
        );
        assert!(legacy_with(&db, "https://bob@github.com", &store)
            .unwrap()
            .is_none());
        let p = save_with(&db, input("alice"), &store).unwrap();
        let reads = store.reads.get();
        assert!(legacy_with(&db, "https://github.com", &store)
            .unwrap()
            .is_none());
        assert_eq!(store.reads.get(), reads);
        let key = get(&db.conn(), &p.id).unwrap().1;
        store.remove(&key).unwrap();
        assert!(load_with(&db, &p.id, &store).is_err());
        assert!(legacy_with(&db, "https://alice@github.com", &store)
            .unwrap()
            .is_none());
        store.deny.set(true);
        assert_eq!(
            legacy_with(&db, "https://bob@github.com", &store)
                .unwrap_err()
                .code,
            "credential.accessDenied"
        );
    }
}
