//! IPC module for daemon-GUI communication.

pub mod auth;
pub mod handler;
pub mod server;

#[cfg(unix)]
pub mod unix;

#[cfg(windows)]
pub mod windows;
