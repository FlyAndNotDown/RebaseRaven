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

struct Slot {
    flag: Arc<AtomicBool>,
    running: bool,
    reserved: bool,
}

fn tokens() -> &'static Mutex<HashMap<String, Slot>> {
    static TOKENS: OnceLock<Mutex<HashMap<String, Slot>>> = OnceLock::new();
    TOKENS.get_or_init(|| Mutex::new(HashMap::new()))
}

// The webview owns the reservation, including the interval before a blocking
// worker starts and gaps between commands in one user operation.
pub(crate) struct Reservation(String);
impl tauri::Resource for Reservation {}

impl Reservation {
    pub(crate) fn new(id: String) -> AppResult<Self> {
        let mut tokens = tokens().lock().unwrap_or_else(|error| error.into_inner());
        let Entry::Vacant(entry) = tokens.entry(id.clone()) else {
            return Err(AppError::msg("This operation is already running."));
        };
        entry.insert(Slot {
            flag: Arc::default(),
            running: false,
            reserved: true,
        });
        Ok(Self(id))
    }
}

impl Drop for Reservation {
    fn drop(&mut self) {
        let mut tokens = tokens().lock().unwrap_or_else(|error| error.into_inner());
        if let Some(slot) = tokens.get_mut(&self.0) {
            slot.reserved = false;
            if slot.running {
                slot.flag.store(true, Ordering::Relaxed);
            } else {
                tokens.remove(&self.0);
            }
        }
    }
}

struct Scope {
    id: String,
    previous: Option<ActiveCancellation>,
}

impl Drop for Scope {
    fn drop(&mut self) {
        CURRENT.with(|current| current.replace(self.previous.take()));
        let mut tokens = tokens().lock().unwrap_or_else(|error| error.into_inner());
        if let Some(slot) = tokens.get_mut(&self.id) {
            slot.running = false;
            if !slot.reserved {
                tokens.remove(&self.id);
            }
        }
    }
}

pub(crate) fn with_cancel<T>(id: Option<&str>, run: impl FnOnce() -> AppResult<T>) -> AppResult<T> {
    let Some(id) = id.filter(|id| !id.is_empty()) else {
        return run();
    };
    let token = {
        let mut tokens = tokens().lock().unwrap_or_else(|error| error.into_inner());
        let slot = tokens.entry(id.to_owned()).or_insert_with(|| Slot {
            flag: Arc::default(),
            running: false,
            reserved: false,
        });
        if slot.running {
            return Err(AppError::msg("This operation is already running."));
        }
        slot.running = true;
        slot.flag.clone()
    };
    let previous = CURRENT.with(|current| current.replace(Some((id.to_string(), token))));
    let _scope = Scope {
        id: id.to_string(),
        previous,
    };
    check_cancelled()?;
    run()
}

pub(crate) fn cancel_activity(id: &str) -> bool {
    let tokens = tokens().lock().unwrap_or_else(|error| error.into_inner());
    let Some(token) = tokens.get(id) else {
        return false;
    };
    token.flag.store(true, Ordering::Relaxed);
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

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn cancellation_before_worker_start_and_between_commands_belongs_to_the_reservation() {
        for (id, start_first) in [("queued-test", false), ("between-test", true)] {
            let reservation = Reservation::new(id.into()).unwrap();
            if start_first {
                with_cancel(Some(id), || Ok(())).unwrap();
            }
            assert!(cancel_activity(id));
            let result = with_cancel(Some(id), || -> AppResult<()> {
                panic!("cancelled worker ran")
            });
            assert!(result.unwrap_err().is_cancelled());
            drop(reservation);
            assert!(!cancel_activity(id));
        }
    }
}
