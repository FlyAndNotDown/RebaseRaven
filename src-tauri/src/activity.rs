//! Cancellation shared by native commands that report progress to a UI activity.

use std::cell::RefCell;
use std::collections::{hash_map::Entry, HashMap};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex, OnceLock};

use crate::error::{AppError, AppResult};

type ActiveCancellation = (String, Arc<AtomicBool>);

thread_local! {
    static CURRENT: RefCell<Option<ActiveCancellation>> = const { RefCell::new(None) };
}

fn tokens() -> &'static Mutex<HashMap<String, Arc<AtomicBool>>> {
    static TOKENS: OnceLock<Mutex<HashMap<String, Arc<AtomicBool>>>> = OnceLock::new();
    TOKENS.get_or_init(|| Mutex::new(HashMap::new()))
}

struct Scope {
    id: String,
    previous: Option<ActiveCancellation>,
}

impl Drop for Scope {
    fn drop(&mut self) {
        CURRENT.with(|current| current.replace(self.previous.take()));
        tokens()
            .lock()
            .unwrap_or_else(|error| error.into_inner())
            .remove(&self.id);
    }
}

pub(crate) fn with_cancel<T>(id: Option<&str>, run: impl FnOnce() -> AppResult<T>) -> AppResult<T> {
    let Some(id) = id.filter(|id| !id.is_empty()) else {
        return run();
    };
    let token = Arc::new(AtomicBool::new(false));
    {
        let mut tokens = tokens().lock().unwrap_or_else(|error| error.into_inner());
        match tokens.entry(id.to_string()) {
            Entry::Occupied(_) => return Err(AppError::msg("This operation is already running.")),
            Entry::Vacant(entry) => entry.insert(token.clone()),
        };
    }
    let previous = CURRENT.with(|current| current.replace(Some((id.to_string(), token))));
    let _scope = Scope {
        id: id.to_string(),
        previous,
    };
    run()
}

pub(crate) fn cancel_activity(id: &str) -> bool {
    let tokens = tokens().lock().unwrap_or_else(|error| error.into_inner());
    let Some(token) = tokens.get(id) else {
        return false;
    };
    token.store(true, Ordering::Relaxed);
    true
}

pub(crate) fn current_cancel() -> Option<ActiveCancellation> {
    CURRENT.with(|current| current.borrow().clone())
}

pub(crate) fn check_cancelled() -> AppResult<()> {
    let cancelled = CURRENT.with(|current| {
        current
            .borrow()
            .as_ref()
            .is_some_and(|(_, token)| token.load(Ordering::Relaxed))
    });
    if cancelled {
        Err(AppError::cancelled())
    } else {
        Ok(())
    }
}
