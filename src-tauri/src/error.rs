//! 统一错误类型。
//!
//! 约定（见 specs/07 第 1 节）：Rust 侧不返回任何面向用户的中文/英文文案，
//! 只返回错误码 `code` + 参数 `params`，由前端 i18n 翻译；`detail` 放 git 原文输出（已脱敏）。

use serde::Serialize;
use std::collections::BTreeMap;
use std::fmt;

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AppError {
    pub code: String,
    pub params: BTreeMap<String, String>,
    pub detail: Option<String>,
}

impl AppError {
    pub fn new(code: impl Into<String>) -> Self {
        Self {
            code: code.into(),
            params: BTreeMap::new(),
            detail: None,
        }
    }

    pub fn param(mut self, key: &str, value: impl ToString) -> Self {
        self.params.insert(key.to_string(), value.to_string());
        self
    }

    pub fn detail(mut self, detail: impl Into<String>) -> Self {
        let d = detail.into();
        self.detail = if d.is_empty() { None } else { Some(d) };
        self
    }

    pub fn internal(msg: impl Into<String>) -> Self {
        Self::new("internal").detail(msg)
    }
}

impl fmt::Display for AppError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match &self.detail {
            Some(d) => write!(f, "{}: {}", self.code, d),
            None => write!(f, "{}", self.code),
        }
    }
}

impl std::error::Error for AppError {}

impl From<rusqlite::Error> for AppError {
    fn from(e: rusqlite::Error) -> Self {
        AppError::new("db.error").detail(e.to_string())
    }
}

impl From<std::io::Error> for AppError {
    fn from(e: std::io::Error) -> Self {
        AppError::new("io.error").detail(e.to_string())
    }
}

impl From<serde_json::Error> for AppError {
    fn from(e: serde_json::Error) -> Self {
        AppError::internal(e.to_string())
    }
}

pub type AppResult<T> = Result<T, AppError>;
