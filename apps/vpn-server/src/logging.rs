use std::collections::VecDeque;
use std::io::{self, Write};
use std::sync::Arc;

use parking_lot::RwLock;
use tracing_subscriber::fmt::{self, MakeWriter};
use tracing_subscriber::layer::SubscriberExt;
use tracing_subscriber::{EnvFilter, Registry};

const LOG_BUFFER_CAPACITY: usize = 1024;

#[derive(Default)]
pub struct LogBuffer {
    inner: RwLock<VecDeque<String>>,
}

impl LogBuffer {
    pub fn push(&self, line: String) {
        let mut guard = self.inner.write();
        guard.push_back(line);
        while guard.len() > LOG_BUFFER_CAPACITY {
            guard.pop_front();
        }
    }

    pub fn snapshot(&self) -> Vec<String> {
        self.inner.read().iter().cloned().collect()
    }
}

#[derive(Clone)]
struct BufferWriter {
    buffer: Arc<LogBuffer>,
}

impl<'a> MakeWriter<'a> for BufferWriter {
    type Writer = BufferWriterHandle;

    fn make_writer(&'a self) -> Self::Writer {
        BufferWriterHandle {
            buffer: self.buffer.clone(),
            line: Vec::new(),
        }
    }
}

struct BufferWriterHandle {
    buffer: Arc<LogBuffer>,
    line: Vec<u8>,
}

impl Write for BufferWriterHandle {
    fn write(&mut self, buf: &[u8]) -> io::Result<usize> {
        self.line.extend_from_slice(buf);
        Ok(buf.len())
    }

    fn flush(&mut self) -> io::Result<()> {
        if !self.line.is_empty() {
            if let Ok(line) = String::from_utf8(self.line.clone()) {
                self.buffer.push(line);
            }
            self.line.clear();
        }
        Ok(())
    }
}

pub fn init_logging() -> Arc<LogBuffer> {
    let log_buffer = Arc::new(LogBuffer::default());
    let buffer_writer = BufferWriter {
        buffer: log_buffer.clone(),
    };

    let env_filter = EnvFilter::try_from_default_env()
        .or_else(|_| EnvFilter::try_new("info"))
        .expect("invalid log level");

    let stdout_layer = fmt::layer()
        .with_target(false)
        .with_line_number(true)
        .with_writer(io::stdout);

    let buffer_layer = fmt::layer()
        .with_target(true)
        .with_line_number(true)
        .with_writer(buffer_writer);

    let subscriber = Registry::default()
        .with(env_filter)
        .with(stdout_layer)
        .with(buffer_layer);

    tracing::subscriber::set_global_default(subscriber).expect("global subscriber already set");

    log_buffer
}
