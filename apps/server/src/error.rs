use serde_json::{Value, json};
pub type Result<T> = std::result::Result<T, Error>;
#[derive(Debug, Clone)]
pub struct Error {
    pub code: String,
    pub message: String,
    pub resource: Option<String>,
    pub current_revision: Option<String>,
    pub blockers: Option<Box<Value>>,
}
impl Error {
    pub fn new(code: impl Into<String>, message: impl Into<String>) -> Self {
        Self {
            code: code.into(),
            message: message.into(),
            resource: None,
            current_revision: None,
            blockers: None,
        }
    }
    pub fn validation(message: impl Into<String>) -> Self {
        Self::new("validation_error", message)
    }
    pub fn conflict(resource: impl Into<String>, current_revision: impl Into<String>) -> Self {
        Self {
            resource: Some(resource.into()),
            current_revision: Some(current_revision.into()),
            ..Self::new(
                "revision_conflict",
                "The resource changed. Refresh it before editing.",
            )
        }
    }
    pub fn details(&self) -> Value {
        let mut v = json!({"code":self.code,"message":self.message,"retryable":matches!(self.code.as_str(),"revision_conflict"|"transport_error"),"recovery":match self.code.as_str(){"revision_conflict"=>"Read the resource, reconcile the edit and retry with its new revision.","transport_error"=>"Retry with the same request_id; reconcile uncertain external actions before repeating them.","validation_error"=>"Correct the supplied arguments.","missing_search"=>"Refresh the saved searches.",_=>"Read current state before retrying; retain the original request_id."}});
        if let Some(x) = &self.resource {
            v["resource"] = json!(x);
        }
        if let Some(x) = &self.current_revision {
            v["current_revision"] = json!(x);
        }
        if let Some(x) = &self.blockers {
            v["blockers"] = (**x).clone();
        }
        v
    }
}
impl std::fmt::Display for Error {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        write!(f, "{}", self.message)
    }
}
impl std::error::Error for Error {}
impl From<rusqlite::Error> for Error {
    fn from(e: rusqlite::Error) -> Self {
        Self::new("storage_error", e.to_string())
    }
}
impl From<serde_json::Error> for Error {
    fn from(e: serde_json::Error) -> Self {
        Self::validation(e.to_string())
    }
}
impl From<std::io::Error> for Error {
    fn from(e: std::io::Error) -> Self {
        Self::new("storage_error", e.to_string())
    }
}
