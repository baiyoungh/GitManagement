//! SQLite 存储（specs/07 第 3 节）。git 原生信息不入库。

use crate::error::{AppError, AppResult};
use crate::sync_engine::{SyncDirection, SyncRule, SyncTarget};
use rusqlite::{params, Connection, OptionalExtension};
use serde::Serialize;
use std::collections::HashMap;
use std::path::Path;
use std::sync::Mutex;
use std::time::{SystemTime, UNIX_EPOCH};

/// 迁移按顺序执行，`PRAGMA user_version` 记录已执行到第几条
const MIGRATIONS: &[&str] = &[
    // v1：specs/07 第 3 节中的全部表
    r#"
    CREATE TABLE repo_group (
      id TEXT PRIMARY KEY, name TEXT NOT NULL, sort INTEGER NOT NULL
    );
    CREATE TABLE repo (
      id TEXT PRIMARY KEY,
      path TEXT NOT NULL UNIQUE,
      root_commit TEXT,
      name TEXT NOT NULL,
      group_id TEXT REFERENCES repo_group(id) ON DELETE SET NULL,
      favorite INTEGER DEFAULT 0,
      sort INTEGER NOT NULL,
      auto_fetch_minutes INTEGER,
      created_at INTEGER NOT NULL
    );
    CREATE TABLE sync_rule (
      id TEXT PRIMARY KEY,
      repo_id TEXT NOT NULL REFERENCES repo(id) ON DELETE CASCADE,
      branch_pattern TEXT NOT NULL,
      primary_target_id TEXT,
      sort INTEGER NOT NULL
    );
    CREATE TABLE sync_target (
      id TEXT PRIMARY KEY,
      rule_id TEXT NOT NULL REFERENCES sync_rule(id) ON DELETE CASCADE,
      remote TEXT,
      url TEXT,
      remote_branch TEXT NOT NULL,
      direction TEXT NOT NULL CHECK (direction IN ('push','pull','both')),
      force INTEGER DEFAULT 0,
      enabled INTEGER DEFAULT 1
    );
    CREATE TABLE changelist (
      id TEXT PRIMARY KEY,
      repo_id TEXT NOT NULL REFERENCES repo(id) ON DELETE CASCADE,
      name TEXT NOT NULL, is_active INTEGER DEFAULT 0, sort INTEGER NOT NULL
    );
    CREATE TABLE changelist_file (
      changelist_id TEXT NOT NULL REFERENCES changelist(id) ON DELETE CASCADE,
      path TEXT NOT NULL,
      checked INTEGER DEFAULT 1,
      PRIMARY KEY (changelist_id, path)
    );
    CREATE TABLE commit_message_history (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      repo_id TEXT, message TEXT NOT NULL, created_at INTEGER NOT NULL
    );
    CREATE TABLE setting (key TEXT PRIMARY KEY, value TEXT NOT NULL);
    CREATE INDEX idx_history_repo ON commit_message_history(repo_id, created_at DESC);
    "#,
    // v2（M3）：分组折叠状态；变更列表文件一个文件只属于一个列表（specs/04 第 4 节）
    r#"
    ALTER TABLE repo_group ADD COLUMN collapsed INTEGER DEFAULT 0;
    CREATE TABLE changelist_member (
      repo_id TEXT NOT NULL REFERENCES repo(id) ON DELETE CASCADE,
      path TEXT NOT NULL,
      changelist_id TEXT NOT NULL REFERENCES changelist(id) ON DELETE CASCADE,
      PRIMARY KEY (repo_id, path)
    );
    "#,
    // v3: enumerable credential metadata only; secrets remain in the OS keyring.
    r#"
    CREATE TABLE credential_profile (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      url TEXT NOT NULL,
      username TEXT NOT NULL,
      keyring_key TEXT NOT NULL UNIQUE
    );
    CREATE INDEX idx_credential_origin ON credential_profile(url);
    CREATE TABLE credential_key_cleanup (
      keyring_key TEXT PRIMARY KEY,
      profile_id TEXT NOT NULL
    );
    "#,
];

#[derive(Debug, Clone, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct RepoGroup {
    pub id: String,
    pub name: String,
    pub sort: i64,
    pub collapsed: bool,
}

#[derive(Debug, Clone, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct Changelist {
    pub id: String,
    pub name: String,
    pub active: bool,
    pub sort: i64,
    /// 明确归属于该列表的文件；不在任何列表中的改动属于活动列表
    pub files: Vec<String>,
}

const HISTORY_LIMIT: i64 = 50;

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RepoRecord {
    pub id: String,
    pub path: String,
    pub root_commit: Option<String>,
    pub name: String,
    pub group_id: Option<String>,
    pub favorite: bool,
    pub sort: i64,
    pub auto_fetch_minutes: Option<i64>,
    pub created_at: i64,
}

pub struct Db {
    conn: Mutex<Connection>,
}

fn now() -> i64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_secs() as i64)
        .unwrap_or(0)
}

impl Db {
    pub fn open(path: &Path) -> AppResult<Self> {
        if let Some(parent) = path.parent() {
            std::fs::create_dir_all(parent)?;
        }
        Self::init(Connection::open(path)?)
    }

    pub fn open_in_memory() -> AppResult<Self> {
        Self::init(Connection::open_in_memory()?)
    }

    fn init(conn: Connection) -> AppResult<Self> {
        conn.pragma_update(None, "foreign_keys", "ON")?;
        // journal_mode 会返回一行结果，必须用 _and_check 版本，否则报 ExecuteReturnedResults
        conn.pragma_update_and_check(None, "journal_mode", "WAL", |_| Ok(()))?;
            let version: i64 = conn.query_row("PRAGMA user_version", [], |r| r.get(0))?;
        for (i, sql) in MIGRATIONS.iter().enumerate() {
            let v = i as i64 + 1;
            if v > version {
                let tx = conn.unchecked_transaction()?;
                tx.execute_batch(sql)?;
                tx.pragma_update(None, "user_version", v)?;
                tx.commit()?;
            }
        }
        Ok(Self { conn: Mutex::new(conn) })
    }

    pub(crate) fn conn(&self) -> std::sync::MutexGuard<'_, Connection> {
        self.conn.lock().unwrap_or_else(|e| e.into_inner())
    }

    // ---------- repo ----------

    fn row_to_repo(r: &rusqlite::Row) -> rusqlite::Result<RepoRecord> {
        Ok(RepoRecord {
            id: r.get(0)?,
            path: r.get(1)?,
            root_commit: r.get(2)?,
            name: r.get(3)?,
            group_id: r.get(4)?,
            favorite: r.get::<_, i64>(5)? != 0,
            sort: r.get(6)?,
            auto_fetch_minutes: r.get(7)?,
            created_at: r.get(8)?,
        })
    }

    const REPO_COLS: &'static str =
        "id, path, root_commit, name, group_id, favorite, sort, auto_fetch_minutes, created_at";

    pub fn list_repos(&self) -> AppResult<Vec<RepoRecord>> {
        let conn = self.conn();
        let mut stmt = conn.prepare(&format!(
            "SELECT {} FROM repo ORDER BY favorite DESC, sort, name COLLATE NOCASE",
            Self::REPO_COLS
        ))?;
        let rows = stmt.query_map([], Self::row_to_repo)?;
        Ok(rows.collect::<Result<_, _>>()?)
    }

    pub fn get_repo(&self, id: &str) -> AppResult<RepoRecord> {
        self.conn()
            .query_row(
                &format!("SELECT {} FROM repo WHERE id = ?1", Self::REPO_COLS),
                [id],
                Self::row_to_repo,
            )
            .optional()?
            .ok_or_else(|| AppError::new("repo.notFound").param("id", id))
    }

    pub fn find_repo_by_path(&self, path: &str) -> AppResult<Option<RepoRecord>> {
        Ok(self
            .conn()
            .query_row(
                &format!("SELECT {} FROM repo WHERE path = ?1", Self::REPO_COLS),
                [path],
                Self::row_to_repo,
            )
            .optional()?)
    }

    pub fn insert_repo(&self, path: &str, name: &str, root_commit: Option<&str>) -> AppResult<RepoRecord> {
        let id = uuid::Uuid::new_v4().to_string();
        {
            let conn = self.conn();
            let sort: i64 = conn.query_row("SELECT COALESCE(MAX(sort), 0) + 1 FROM repo", [], |r| r.get(0))?;
            conn.execute(
                "INSERT INTO repo (id, path, root_commit, name, sort, created_at) VALUES (?1, ?2, ?3, ?4, ?5, ?6)",
                params![id, path, root_commit, name, sort, now()],
            )?;
            // 默认变更列表，用于持久化勾选状态（specs/04 第 1.3 节）
            conn.execute(
                "INSERT INTO changelist (id, repo_id, name, is_active, sort) VALUES (?1, ?2, 'Changes', 1, 0)",
                params![uuid::Uuid::new_v4().to_string(), id],
            )?;
        }
        self.get_repo(&id)
    }

    pub fn update_repo_path(&self, id: &str, path: &str) -> AppResult<()> {
        self.conn().execute("UPDATE repo SET path = ?2 WHERE id = ?1", params![id, path])?;
        Ok(())
    }

    pub fn rename_repo(&self, id: &str, name: &str) -> AppResult<()> {
        self.conn().execute("UPDATE repo SET name = ?2 WHERE id = ?1", params![id, name])?;
        Ok(())
    }

    pub fn set_favorite(&self, id: &str, favorite: bool) -> AppResult<()> {
        self.conn()
            .execute("UPDATE repo SET favorite = ?2 WHERE id = ?1", params![id, favorite as i64])?;
        Ok(())
    }

    pub fn delete_repo(&self, id: &str) -> AppResult<()> {
        self.conn().execute("DELETE FROM repo WHERE id = ?1", [id])?;
        Ok(())
    }

    // ---------- 勾选状态 ----------

    fn default_changelist(&self, conn: &Connection, repo_id: &str) -> AppResult<String> {
        if let Some(id) = conn
            .query_row(
                // 勾选状态固定挂在最早的列表上，不随活动列表切换而变化
                "SELECT id FROM changelist WHERE repo_id = ?1 ORDER BY sort, rowid LIMIT 1",
                [repo_id],
                |r| r.get::<_, String>(0),
            )
            .optional()?
        {
            return Ok(id);
        }
        let id = uuid::Uuid::new_v4().to_string();
        conn.execute(
            "INSERT INTO changelist (id, repo_id, name, is_active, sort) VALUES (?1, ?2, 'Changes', 1, 0)",
            params![id, repo_id],
        )?;
        Ok(id)
    }

    /// 返回 路径 → 是否勾选；不在表中的文件由前端按默认规则决定
    pub fn get_checked(&self, repo_id: &str) -> AppResult<HashMap<String, bool>> {
        let conn = self.conn();
        let cl = self.default_changelist(&conn, repo_id)?;
        let mut stmt = conn.prepare("SELECT path, checked FROM changelist_file WHERE changelist_id = ?1")?;
        let rows = stmt.query_map([&cl], |r| Ok((r.get::<_, String>(0)?, r.get::<_, i64>(1)? != 0)))?;
        Ok(rows.collect::<Result<_, _>>()?)
    }

    pub fn set_checked(&self, repo_id: &str, entries: &HashMap<String, bool>) -> AppResult<()> {
        let mut conn = self.conn();
        let cl = self.default_changelist(&conn, repo_id)?;
        let tx = conn.transaction()?;
        {
            let mut stmt = tx.prepare(
                "INSERT INTO changelist_file (changelist_id, path, checked) VALUES (?1, ?2, ?3)
                 ON CONFLICT(changelist_id, path) DO UPDATE SET checked = excluded.checked",
            )?;
            for (path, checked) in entries {
                stmt.execute(params![cl, path, *checked as i64])?;
            }
        }
        tx.commit()?;
        Ok(())
    }

    /// 删除已不在变更列表中的文件记录，避免表无限增长
    pub fn prune_checked(&self, repo_id: &str, keep: &[String]) -> AppResult<()> {
        let mut conn = self.conn();
        let cl = self.default_changelist(&conn, repo_id)?;
        let tx = conn.transaction()?;
        tx.execute_batch("CREATE TEMP TABLE IF NOT EXISTS keep_path (path TEXT PRIMARY KEY); DELETE FROM keep_path;")?;
        {
            let mut stmt = tx.prepare("INSERT OR IGNORE INTO keep_path (path) VALUES (?1)")?;
            for p in keep {
                stmt.execute([p])?;
            }
        }
        tx.execute(
            "DELETE FROM changelist_file WHERE changelist_id = ?1 AND path NOT IN (SELECT path FROM keep_path)",
            [&cl],
        )?;
        tx.execute_batch("DELETE FROM keep_path;")?;
        tx.commit()?;
        Ok(())
    }

    // ---------- 提交消息历史 ----------

    pub fn add_message(&self, repo_id: &str, message: &str) -> AppResult<()> {
        let msg = message.trim();
        if msg.is_empty() {
            return Ok(());
        }
        let conn = self.conn();
        conn.execute(
            "DELETE FROM commit_message_history WHERE repo_id = ?1 AND message = ?2",
            params![repo_id, msg],
        )?;
        conn.execute(
            "INSERT INTO commit_message_history (repo_id, message, created_at) VALUES (?1, ?2, ?3)",
            params![repo_id, msg, now()],
        )?;
        conn.execute(
            "DELETE FROM commit_message_history WHERE repo_id = ?1 AND id NOT IN
             (SELECT id FROM commit_message_history WHERE repo_id = ?1 ORDER BY created_at DESC, id DESC LIMIT ?2)",
            params![repo_id, HISTORY_LIMIT],
        )?;
        Ok(())
    }

    pub fn messages(&self, repo_id: &str) -> AppResult<Vec<String>> {
        let conn = self.conn();
        let mut stmt = conn.prepare(
            "SELECT message FROM commit_message_history WHERE repo_id = ?1 ORDER BY created_at DESC, id DESC LIMIT ?2",
        )?;
        let rows = stmt.query_map(params![repo_id, HISTORY_LIMIT], |r| r.get::<_, String>(0))?;
        Ok(rows.collect::<Result<_, _>>()?)
    }

    // ---------- 设置 ----------

    pub fn get_setting(&self, key: &str) -> AppResult<Option<String>> {
        Ok(self
            .conn()
            .query_row("SELECT value FROM setting WHERE key = ?1", [key], |r| r.get(0))
            .optional()?)
    }

    pub fn set_setting(&self, key: &str, value: &str) -> AppResult<()> {
        self.conn().execute(
            "INSERT INTO setting (key, value) VALUES (?1, ?2) ON CONFLICT(key) DO UPDATE SET value = excluded.value",
            params![key, value],
        )?;
        Ok(())
    }

    pub fn all_settings(&self) -> AppResult<HashMap<String, String>> {
        let conn = self.conn();
        let mut stmt = conn.prepare("SELECT key, value FROM setting")?;
        let rows = stmt.query_map([], |r| Ok((r.get::<_, String>(0)?, r.get::<_, String>(1)?)))?;
        Ok(rows.collect::<Result<_, _>>()?)
    }

    // ---------- 仓库分组与排序（R-04） ----------

    pub fn list_groups(&self) -> AppResult<Vec<RepoGroup>> {
        let conn = self.conn();
        let mut stmt = conn.prepare("SELECT id, name, sort, COALESCE(collapsed, 0) FROM repo_group ORDER BY sort, name")?;
        let rows = stmt.query_map([], |r| {
            Ok(RepoGroup { id: r.get(0)?, name: r.get(1)?, sort: r.get(2)?, collapsed: r.get::<_, i64>(3)? != 0 })
        })?;
        Ok(rows.collect::<Result<_, _>>()?)
    }

    pub fn create_group(&self, name: &str) -> AppResult<RepoGroup> {
        let id = uuid::Uuid::new_v4().to_string();
        let conn = self.conn();
        let sort: i64 = conn.query_row("SELECT COALESCE(MAX(sort), 0) + 1 FROM repo_group", [], |r| r.get(0))?;
        conn.execute("INSERT INTO repo_group (id, name, sort) VALUES (?1, ?2, ?3)", params![id, name, sort])?;
        Ok(RepoGroup { id, name: name.to_string(), sort, collapsed: false })
    }

    pub fn rename_group(&self, id: &str, name: &str) -> AppResult<()> {
        self.conn().execute("UPDATE repo_group SET name = ?2 WHERE id = ?1", params![id, name])?;
        Ok(())
    }

    pub fn set_group_collapsed(&self, id: &str, collapsed: bool) -> AppResult<()> {
        self.conn().execute("UPDATE repo_group SET collapsed = ?2 WHERE id = ?1", params![id, collapsed as i64])?;
        Ok(())
    }

    /// 删除分组；组内仓库回到"未分组"（外键 ON DELETE SET NULL）
    pub fn delete_group(&self, id: &str) -> AppResult<()> {
        let conn = self.conn();
        conn.execute("UPDATE repo SET group_id = NULL WHERE group_id = ?1", [id])?;
        conn.execute("DELETE FROM repo_group WHERE id = ?1", [id])?;
        Ok(())
    }

    /// 按给定顺序重写分组排序
    pub fn reorder_groups(&self, ids: &[String]) -> AppResult<()> {
        let mut conn = self.conn();
        let tx = conn.transaction()?;
        for (i, id) in ids.iter().enumerate() {
            tx.execute("UPDATE repo_group SET sort = ?2 WHERE id = ?1", params![id, i as i64])?;
        }
        tx.commit()?;
        Ok(())
    }

    /// 拖拽：把仓库移到某分组（None = 未分组），并按 ordered_ids 重写该组内顺序
    pub fn move_repos(&self, group_id: Option<&str>, ordered_ids: &[String]) -> AppResult<()> {
        let mut conn = self.conn();
        let tx = conn.transaction()?;
        for (i, id) in ordered_ids.iter().enumerate() {
            tx.execute("UPDATE repo SET group_id = ?2, sort = ?3 WHERE id = ?1", params![id, group_id, i as i64])?;
        }
        tx.commit()?;
        Ok(())
    }

    pub fn set_repo_group(&self, repo_id: &str, group_id: Option<&str>) -> AppResult<()> {
        let conn = self.conn();
        let sort: i64 = conn.query_row(
            "SELECT COALESCE(MAX(sort), 0) + 1 FROM repo WHERE group_id IS ?1",
            params![group_id],
            |r| r.get(0),
        )?;
        conn.execute("UPDATE repo SET group_id = ?2, sort = ?3 WHERE id = ?1", params![repo_id, group_id, sort])?;
        Ok(())
    }

    // ---------- 变更列表（C-09） ----------

    pub fn list_changelists(&self, repo_id: &str) -> AppResult<Vec<Changelist>> {
        let conn = self.conn();
        // 确保至少有一个默认列表
        self.default_changelist(&conn, repo_id)?;
        let mut stmt = conn.prepare(
            "SELECT id, name, is_active, sort FROM changelist WHERE repo_id = ?1 ORDER BY sort, rowid",
        )?;
        let lists: Vec<(String, String, bool, i64)> = stmt
            .query_map([repo_id], |r| Ok((r.get(0)?, r.get(1)?, r.get::<_, i64>(2)? != 0, r.get(3)?)))?
            .collect::<Result<_, _>>()?;
        let mut fstmt = conn.prepare("SELECT path FROM changelist_member WHERE changelist_id = ?1 ORDER BY path")?;
        let mut out = Vec::new();
        let any_active = lists.iter().any(|l| l.2);
        for (i, (id, name, active, sort)) in lists.into_iter().enumerate() {
            let files = fstmt.query_map([&id], |r| r.get::<_, String>(0))?.collect::<Result<_, _>>()?;
            out.push(Changelist { id, name, active: active || (!any_active && i == 0), sort, files });
        }
        Ok(out)
    }

    pub fn create_changelist(&self, repo_id: &str, name: &str) -> AppResult<Changelist> {
        let conn = self.conn();
        self.default_changelist(&conn, repo_id)?;
        let id = uuid::Uuid::new_v4().to_string();
        let sort: i64 = conn.query_row(
            "SELECT COALESCE(MAX(sort), 0) + 1 FROM changelist WHERE repo_id = ?1",
            [repo_id],
            |r| r.get(0),
        )?;
        conn.execute(
            "INSERT INTO changelist (id, repo_id, name, is_active, sort) VALUES (?1, ?2, ?3, 0, ?4)",
            params![id, repo_id, name, sort],
        )?;
        Ok(Changelist { id, name: name.to_string(), active: false, sort, files: Vec::new() })
    }

    pub fn rename_changelist(&self, id: &str, name: &str) -> AppResult<()> {
        self.conn().execute("UPDATE changelist SET name = ?2 WHERE id = ?1", params![id, name])?;
        Ok(())
    }

    pub fn set_active_changelist(&self, repo_id: &str, id: &str) -> AppResult<()> {
        let mut conn = self.conn();
        let tx = conn.transaction()?;
        tx.execute("UPDATE changelist SET is_active = (id = ?2) WHERE repo_id = ?1", params![repo_id, id])?;
        tx.commit()?;
        Ok(())
    }

    /// 删除列表：其中的文件回到活动列表。勾选状态表 changelist_file 挂在默认列表上，不受影响。
    pub fn delete_changelist(&self, repo_id: &str, id: &str) -> AppResult<()> {
        let conn = self.conn();
        let count: i64 = conn.query_row("SELECT COUNT(*) FROM changelist WHERE repo_id = ?1", [repo_id], |r| r.get(0))?;
        if count <= 1 {
            return Err(AppError::new("changelist.lastOne"));
        }
        let checked_holder = self.default_changelist(&conn, repo_id)?;
        let was_active: bool = conn
            .query_row("SELECT is_active FROM changelist WHERE id = ?1", [id], |r| r.get::<_, i64>(0))
            .optional()?
            .map(|v| v != 0)
            .unwrap_or(false);
        if id == checked_holder {
            // 勾选状态挂在被删除的列表上：转移到下一个列表
            let next: String = conn.query_row(
                "SELECT id FROM changelist WHERE repo_id = ?1 AND id != ?2 ORDER BY sort LIMIT 1",
                params![repo_id, id],
                |r| r.get(0),
            )?;
            conn.execute(
                "UPDATE OR REPLACE changelist_file SET changelist_id = ?2 WHERE changelist_id = ?1",
                params![id, next],
            )?;
        }
        conn.execute("DELETE FROM changelist WHERE id = ?1 AND repo_id = ?2", params![id, repo_id])?;
        if was_active {
            conn.execute(
                "UPDATE changelist SET is_active = 1 WHERE id = (SELECT id FROM changelist WHERE repo_id = ?1 ORDER BY sort LIMIT 1)",
                [repo_id],
            )?;
        }
        Ok(())
    }

    /// 把文件移到某列表（一个文件只属于一个列表）
    pub fn move_to_changelist(&self, repo_id: &str, id: &str, paths: &[String]) -> AppResult<()> {
        let mut conn = self.conn();
        let tx = conn.transaction()?;
        {
            let mut stmt = tx.prepare(
                "INSERT INTO changelist_member (repo_id, path, changelist_id) VALUES (?1, ?2, ?3)
                 ON CONFLICT(repo_id, path) DO UPDATE SET changelist_id = excluded.changelist_id",
            )?;
            for p in paths {
                stmt.execute(params![repo_id, p, id])?;
            }
        }
        tx.commit()?;
        Ok(())
    }

    /// 清理已不在改动中的文件归属
    pub fn prune_changelist_members(&self, repo_id: &str, keep: &[String]) -> AppResult<()> {
        let mut conn = self.conn();
        let tx = conn.transaction()?;
        tx.execute_batch("CREATE TEMP TABLE IF NOT EXISTS keep_member (path TEXT PRIMARY KEY); DELETE FROM keep_member;")?;
        {
            let mut stmt = tx.prepare("INSERT OR IGNORE INTO keep_member (path) VALUES (?1)")?;
            for p in keep {
                stmt.execute([p])?;
            }
        }
        tx.execute(
            "DELETE FROM changelist_member WHERE repo_id = ?1 AND path NOT IN (SELECT path FROM keep_member)",
            [repo_id],
        )?;
        tx.execute_batch("DELETE FROM keep_member;")?;
        tx.commit()?;
        Ok(())
    }

    // ---------- 同步规则（specs/03 第 1、5 节） ----------

    pub fn list_rules(&self, repo_id: &str) -> AppResult<Vec<SyncRule>> {
        let conn = self.conn();
        let mut stmt = conn.prepare(
            "SELECT id, branch_pattern, primary_target_id, sort FROM sync_rule WHERE repo_id = ?1 ORDER BY sort, branch_pattern",
        )?;
        let rules: Vec<(String, String, Option<String>, i64)> = stmt
            .query_map([repo_id], |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?, r.get(3)?)))?
            .collect::<Result<_, _>>()?;
        let mut tstmt = conn.prepare(
            "SELECT id, remote, url, remote_branch, direction, force, enabled FROM sync_target WHERE rule_id = ?1 ORDER BY rowid",
        )?;
        let mut out = Vec::new();
        for (id, pattern, primary, sort) in rules {
            let targets = tstmt
                .query_map([&id], |r| {
                    Ok(SyncTarget {
                        id: r.get(0)?,
                        remote: r.get(1)?,
                        url: r.get(2)?,
                        remote_branch: r.get(3)?,
                        direction: SyncDirection::parse(&r.get::<_, String>(4)?),
                        force: r.get::<_, i64>(5)? != 0,
                        enabled: r.get::<_, i64>(6)? != 0,
                    })
                })?
                .collect::<Result<_, _>>()?;
            out.push(SyncRule {
                id,
                repo_id: repo_id.to_string(),
                branch_pattern: pattern,
                targets,
                primary_target_id: primary,
                order: sort,
            });
        }
        Ok(out)
    }

    /// 新增或整体替换一条规则（含全部目标）；id 为空时生成新 id
    pub fn upsert_rule(&self, rule: &SyncRule) -> AppResult<SyncRule> {
        let mut rule = rule.clone();
        if rule.id.is_empty() {
            rule.id = uuid::Uuid::new_v4().to_string();
        }
        for t in rule.targets.iter_mut() {
            if t.id.is_empty() {
                t.id = uuid::Uuid::new_v4().to_string();
            }
        }
        // primary 必须指向本规则内的目标
        if let Some(p) = &rule.primary_target_id {
            if !rule.targets.iter().any(|t| &t.id == p) {
                rule.primary_target_id = None;
            }
        }
        let mut conn = self.conn();
        let tx = conn.transaction()?;
        tx.execute(
            "INSERT INTO sync_rule (id, repo_id, branch_pattern, primary_target_id, sort) VALUES (?1, ?2, ?3, ?4, ?5)
             ON CONFLICT(id) DO UPDATE SET branch_pattern = excluded.branch_pattern,
               primary_target_id = excluded.primary_target_id, sort = excluded.sort",
            params![rule.id, rule.repo_id, rule.branch_pattern, rule.primary_target_id, rule.order],
        )?;
        tx.execute("DELETE FROM sync_target WHERE rule_id = ?1", [&rule.id])?;
        for t in &rule.targets {
            tx.execute(
                "INSERT INTO sync_target (id, rule_id, remote, url, remote_branch, direction, force, enabled)
                 VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8)",
                params![t.id, rule.id, t.remote, t.url, t.remote_branch, t.direction.as_str(), t.force as i64, t.enabled as i64],
            )?;
        }
        tx.commit()?;
        Ok(rule)
    }

    pub fn delete_rule(&self, id: &str) -> AppResult<()> {
        self.conn().execute("DELETE FROM sync_rule WHERE id = ?1", [id])?;
        Ok(())
    }

    /// remote 改名后同步更新规则中的引用
    pub fn rename_rule_remote(&self, repo_id: &str, old: &str, new: &str) -> AppResult<()> {
        self.conn().execute(
            "UPDATE sync_target SET remote = ?3 WHERE remote = ?2 AND rule_id IN (SELECT id FROM sync_rule WHERE repo_id = ?1)",
            params![repo_id, old, new],
        )?;
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn credential_migration_preserves_v2_metadata() {
        let conn = Connection::open_in_memory().unwrap();
        for sql in &MIGRATIONS[..2] { conn.execute_batch(sql).unwrap(); }
        conn.pragma_update(None, "user_version", 2).unwrap();
        conn.execute("INSERT INTO setting (key, value) VALUES ('legacy', 'kept')", []).unwrap();
        let db = Db::init(conn).unwrap();
        assert_eq!(db.get_setting("legacy").unwrap().as_deref(), Some("kept"));
        let conn = db.conn();
        let count: i64 = conn.query_row("SELECT COUNT(*) FROM credential_profile", [], |r| r.get(0)).unwrap();
        assert_eq!(count, 0);
        let version: i64 = conn.query_row("PRAGMA user_version", [], |r| r.get(0)).unwrap();
        assert_eq!(version, MIGRATIONS.len() as i64);
    }

    #[test]
    fn repo_crud_and_checked() {
        let db = Db::open_in_memory().unwrap();
        let r = db.insert_repo("/w/app", "app", Some("abc")).unwrap();
        assert_eq!(db.list_repos().unwrap().len(), 1);
        assert!(db.find_repo_by_path("/w/app").unwrap().is_some());

        let mut m = HashMap::new();
        m.insert("a.ts".to_string(), true);
        m.insert("b.ts".to_string(), false);
        db.set_checked(&r.id, &m).unwrap();
        assert_eq!(db.get_checked(&r.id).unwrap(), m);
        db.prune_checked(&r.id, &["a.ts".to_string()]).unwrap();
        assert_eq!(db.get_checked(&r.id).unwrap().len(), 1);

        db.delete_repo(&r.id).unwrap();
        assert!(db.list_repos().unwrap().is_empty());
    }

    #[test]
    fn message_history_dedup() {
        let db = Db::open_in_memory().unwrap();
        db.add_message("r", "feat: a").unwrap();
        db.add_message("r", "fix: b").unwrap();
        db.add_message("r", "feat: a").unwrap();
        assert_eq!(db.messages("r").unwrap(), vec!["feat: a", "fix: b"]);
    }

    #[test]
    fn rules_roundtrip() {
        let db = Db::open_in_memory().unwrap();
        let r = db.insert_repo("/w/app", "app", None).unwrap();
        let t = |remote: &str, dir: SyncDirection| SyncTarget {
            id: String::new(),
            remote: Some(remote.into()),
            url: None,
            remote_branch: "${branch}".into(),
            direction: dir,
            force: false,
            enabled: true,
        };
        let saved = db
            .upsert_rule(&SyncRule {
                id: String::new(),
                repo_id: r.id.clone(),
                branch_pattern: "feature/*".into(),
                targets: vec![t("origin", SyncDirection::Both), t("github", SyncDirection::Push)],
                primary_target_id: None,
                order: 10,
            })
            .unwrap();
        assert!(!saved.id.is_empty());
        let mut edited = saved.clone();
        edited.primary_target_id = Some(edited.targets[0].id.clone());
        edited.targets[1].enabled = false;
        db.upsert_rule(&edited).unwrap();

        let rules = db.list_rules(&r.id).unwrap();
        assert_eq!(rules.len(), 1);
        assert_eq!(rules[0], edited);

        db.rename_rule_remote(&r.id, "github", "gh").unwrap();
        assert_eq!(db.list_rules(&r.id).unwrap()[0].targets[1].remote.as_deref(), Some("gh"));

        // 删除仓库级联删除规则
        db.delete_repo(&r.id).unwrap();
        assert!(db.list_rules(&r.id).unwrap().is_empty());
    }

    #[test]
    fn groups_and_changelists() {
        let db = Db::open_in_memory().unwrap();
        let a = db.insert_repo("/w/a", "a", None).unwrap();
        let b = db.insert_repo("/w/b", "b", None).unwrap();
        let g1 = db.create_group("公司").unwrap();
        let g2 = db.create_group("个人").unwrap();
        db.reorder_groups(&[g2.id.clone(), g1.id.clone()]).unwrap();
        assert_eq!(db.list_groups().unwrap()[0].id, g2.id);
        db.move_repos(Some(&g1.id), &[b.id.clone(), a.id.clone()]).unwrap();
        let repos = db.list_repos().unwrap();
        assert_eq!(repos[0].id, b.id);
        assert_eq!(repos[1].group_id.as_deref(), Some(g1.id.as_str()));
        db.delete_group(&g1.id).unwrap();
        assert!(db.list_repos().unwrap().iter().all(|r| r.group_id.is_none()));

        // 变更列表
        let mut m = HashMap::new();
        m.insert("x.ts".to_string(), false);
        db.set_checked(&a.id, &m).unwrap();
        let lists = db.list_changelists(&a.id).unwrap();
        assert_eq!(lists.len(), 1);
        assert!(lists[0].active);
        let dbg = db.create_changelist(&a.id, "调试").unwrap();
        db.move_to_changelist(&a.id, &dbg.id, &["d.ts".into(), "x.ts".into()]).unwrap();
        db.set_active_changelist(&a.id, &dbg.id).unwrap();
        // 切换活动列表后勾选状态不变
        assert_eq!(db.get_checked(&a.id).unwrap(), m);
        let lists = db.list_changelists(&a.id).unwrap();
        assert!(lists[1].active && !lists[0].active);
        assert_eq!(lists[1].files, vec!["d.ts", "x.ts"]);
        db.prune_changelist_members(&a.id, &["d.ts".into()]).unwrap();
        assert_eq!(db.list_changelists(&a.id).unwrap()[1].files, vec!["d.ts"]);
        // 删除默认列表：勾选状态转移，剩下的列表成为活动列表
        db.delete_changelist(&a.id, &lists[0].id).unwrap();
        assert_eq!(db.get_checked(&a.id).unwrap(), m);
        let lists = db.list_changelists(&a.id).unwrap();
        assert_eq!(lists.len(), 1);
        assert!(lists[0].active);
        assert!(db.delete_changelist(&a.id, &lists[0].id).is_err());
    }

    #[test]
    fn settings() {
        let db = Db::open_in_memory().unwrap();
        db.set_setting("language", "zh-CN").unwrap();
        db.set_setting("language", "en-US").unwrap();
        assert_eq!(db.get_setting("language").unwrap().as_deref(), Some("en-US"));
    }
}
