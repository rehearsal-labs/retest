//! The process's output: one reply at a time, whole, from whichever thread has one.

use std::io::Write;
use std::sync::{Arc, Mutex};

use crate::protocol::{Reply, write_reply};

#[derive(Clone)]
pub struct Replies {
    writer: Arc<Mutex<Box<dyn Write + Send>>>,
}

impl Replies {
    pub fn new(writer: Box<dyn Write + Send>) -> Self {
        Replies {
            writer: Arc::new(Mutex::new(writer)),
        }
    }

    /// Writes `reply`. A client that stopped reading is gone; its input closing is what ends the process, so a
    /// failed write is not an error here.
    pub fn send(&self, reply: &Reply) {
        let mut writer = self
            .writer
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner());
        let _ = write_reply(&mut *writer, reply);
    }
}
