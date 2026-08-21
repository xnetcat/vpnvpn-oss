//! Prometheus instrumentation for the VPN node.
//!
//! All metrics exposed here are kept live: the periodic sampler calls
//! [`update_from_statuses`] every few seconds, the peer-sync loop calls
//! [`set_registered_peers`], and the admin server calls
//! [`record_admin_auth_failure`]. Byte counters are fed *deltas* (the
//! underlying `wg`/OpenVPN counters are cumulative and reset on reconnect or
//! restart, so we `saturating_sub` against the previous sample) — never the raw
//! cumulative value, which would explode a Prometheus counter.

use crate::vpn::BackendStatus;
use once_cell::sync::Lazy;
use prometheus::{
    Encoder, IntCounter, IntCounterVec, IntGauge, IntGaugeVec, Opts, Registry, TextEncoder,
};
use std::collections::HashMap;
use std::sync::Mutex;

pub static REGISTRY: Lazy<Registry> = Lazy::new(Registry::new);

// --- Gauges (point-in-time; SET every sample) ---

static SESSIONS_ACTIVE: Lazy<IntGauge> = Lazy::new(|| {
    let gauge = IntGauge::new("vpn_active_sessions", "Number of active VPN sessions")
        .expect("create active_sessions metric");
    REGISTRY.register(Box::new(gauge.clone())).ok();
    gauge
});

static SESSIONS_ACTIVE_PROTO: Lazy<IntGaugeVec> = Lazy::new(|| {
    let vec = IntGaugeVec::new(
        Opts::new(
            "vpn_active_sessions_by_protocol",
            "Active VPN sessions per protocol",
        ),
        &["protocol"],
    )
    .expect("create active sessions proto vec");
    REGISTRY.register(Box::new(vec.clone())).ok();
    vec
});

static PEERS_REGISTERED: Lazy<IntGauge> = Lazy::new(|| {
    let gauge = IntGauge::new(
        "vpn_registered_peers",
        "Number of peers currently provisioned on the node",
    )
    .expect("create peers gauge");
    REGISTRY.register(Box::new(gauge.clone())).ok();
    gauge
});

// --- Counters (monotonic) ---

static SESSIONS_TOTAL: Lazy<IntCounter> = Lazy::new(|| {
    let counter = IntCounter::new(
        "vpn_sessions_total",
        "Total VPN sessions started (approximated from active-session increases)",
    )
    .expect("create sessions_total metric");
    REGISTRY.register(Box::new(counter.clone())).ok();
    counter
});

static BYTES_TRANSFERS: Lazy<IntCounterVec> = Lazy::new(|| {
    let vec = IntCounterVec::new(
        Opts::new("vpn_transfer_bytes_total", "Transferred bytes by direction"),
        &["direction"],
    )
    .expect("create bytes counter vec");
    REGISTRY.register(Box::new(vec.clone())).ok();
    vec
});

static BYTES_TRANSFERS_PROTO: Lazy<IntCounterVec> = Lazy::new(|| {
    let vec = IntCounterVec::new(
        Opts::new(
            "vpn_transfer_bytes_total_by_protocol",
            "Transferred bytes by protocol and direction",
        ),
        &["protocol", "direction"],
    )
    .expect("create bytes counter vec by protocol");
    REGISTRY.register(Box::new(vec.clone())).ok();
    vec
});

static AUTH_FAILURES: Lazy<IntCounter> = Lazy::new(|| {
    let counter = IntCounter::new("vpn_admin_auth_failures", "Failed admin authentications")
        .expect("create auth failures counter");
    REGISTRY.register(Box::new(counter.clone())).ok();
    counter
});

// --- Delta-tracking state (cumulative-source counters need deltas) ---

/// Last observed cumulative byte total per (protocol, direction).
static LAST_BYTES: Lazy<Mutex<HashMap<(String, String), u64>>> =
    Lazy::new(|| Mutex::new(HashMap::new()));
/// Last observed active-session count per protocol, used to approximate
/// `vpn_sessions_total` from positive jumps in the active gauge.
static LAST_ACTIVE: Lazy<Mutex<HashMap<String, u64>>> = Lazy::new(|| Mutex::new(HashMap::new()));

/// Encode the current registry into the Prometheus text exposition format.
pub fn encode_prometheus() -> Vec<u8> {
    let encoder = TextEncoder::new();
    let metric_families = REGISTRY.gather();
    let mut buffer = Vec::new();
    encoder
        .encode(&metric_families, &mut buffer)
        .expect("encode metrics");
    buffer
}

/// Refresh all status-derived metrics from one sampling pass over the backends.
pub fn update_from_statuses(statuses: &[BackendStatus]) {
    let mut last_bytes = LAST_BYTES.lock().unwrap_or_else(|e| e.into_inner());
    let mut last_active = LAST_ACTIVE.lock().unwrap_or_else(|e| e.into_inner());

    let mut total_active: i64 = 0;
    let mut agg_egress: u64 = 0;
    let mut agg_ingress: u64 = 0;

    for st in statuses {
        total_active += st.active_sessions as i64;
        SESSIONS_ACTIVE_PROTO
            .with_label_values(&[&st.protocol])
            .set(st.active_sessions as i64);

        for (direction, cumulative) in [("egress", st.egress_bytes), ("ingress", st.ingress_bytes)]
        {
            let key = (st.protocol.clone(), direction.to_string());
            let previous = last_bytes.get(&key).copied().unwrap_or(0);
            // saturating_sub yields 0 on a reset (reconnect/restart), keeping the
            // counter monotonic at the cost of a small, bounded under-count.
            let delta = cumulative.saturating_sub(previous);
            last_bytes.insert(key, cumulative);
            // Touch the series each sample so it exists (at 0) even without
            // traffic, then advance it by the delta.
            let series = BYTES_TRANSFERS_PROTO.with_label_values(&[&st.protocol, direction]);
            if delta > 0 {
                series.inc_by(delta);
                if direction == "egress" {
                    agg_egress += delta;
                } else {
                    agg_ingress += delta;
                }
            }
        }

        // Count newly-started sessions as the positive delta in the active count.
        let current_active = st.active_sessions as u64;
        let previous_active = last_active.get(&st.protocol).copied().unwrap_or(0);
        if current_active > previous_active {
            SESSIONS_TOTAL.inc_by(current_active - previous_active);
        }
        last_active.insert(st.protocol.clone(), current_active);
    }

    SESSIONS_ACTIVE.set(total_active);
    if agg_egress > 0 {
        BYTES_TRANSFERS
            .with_label_values(&["egress"])
            .inc_by(agg_egress);
    }
    if agg_ingress > 0 {
        BYTES_TRANSFERS
            .with_label_values(&["ingress"])
            .inc_by(agg_ingress);
    }
}

/// Force-register the label-free and aggregate series so they appear at 0 before
/// any activity (Prometheus best practice — avoids gaps on an idle node). The
/// per-protocol series register on the first sampling pass.
pub fn ensure_registered() {
    SESSIONS_ACTIVE.set(0);
    PEERS_REGISTERED.set(0);
    SESSIONS_TOTAL.inc_by(0);
    AUTH_FAILURES.inc_by(0);
    BYTES_TRANSFERS.with_label_values(&["egress"]).inc_by(0);
    BYTES_TRANSFERS.with_label_values(&["ingress"]).inc_by(0);
}

/// Record how many peers are currently provisioned on the node (called from the
/// peer-sync loop after each successful fetch).
pub fn set_registered_peers(total: usize) {
    PEERS_REGISTERED.set(total as i64);
}

/// Increment the failed-admin-authentication counter.
pub fn record_admin_auth_failure() {
    AUTH_FAILURES.inc();
}

#[cfg(test)]
mod tests {
    use super::*;

    fn status(protocol: &str, active: usize, egress: u64, ingress: u64) -> BackendStatus {
        BackendStatus {
            protocol: protocol.to_string(),
            active_sessions: active,
            egress_bytes: egress,
            ingress_bytes: ingress,
            running: true,
        }
    }

    #[test]
    fn byte_counters_use_deltas_not_cumulative_totals() {
        // Two samples of the *same* cumulative counter must advance the
        // Prometheus counter by the delta, not by the cumulative value twice.
        update_from_statuses(&[status("wireguard", 1, 1_000, 500)]);
        let after_first = BYTES_TRANSFERS_PROTO
            .with_label_values(&["wireguard", "egress"])
            .get();
        update_from_statuses(&[status("wireguard", 1, 1_500, 800)]);
        let after_second = BYTES_TRANSFERS_PROTO
            .with_label_values(&["wireguard", "egress"])
            .get();
        // Delta of 500, regardless of the absolute starting point of the counter.
        assert_eq!(after_second - after_first, 500);
    }

    #[test]
    fn ensure_registered_exposes_counters_before_any_activity() {
        ensure_registered();
        let out = String::from_utf8(encode_prometheus()).unwrap();
        // These counters are only touched by ensure_registered until there is
        // real activity, so their presence proves initialization works.
        assert!(out.contains("vpn_sessions_total"));
        assert!(out.contains("vpn_admin_auth_failures"));
    }

    #[test]
    fn active_sessions_gauge_reflects_latest_sample() {
        update_from_statuses(&[status("openvpn", 3, 0, 0)]);
        assert_eq!(
            SESSIONS_ACTIVE_PROTO.with_label_values(&["openvpn"]).get(),
            3
        );
        update_from_statuses(&[status("openvpn", 1, 0, 0)]);
        assert_eq!(
            SESSIONS_ACTIVE_PROTO.with_label_values(&["openvpn"]).get(),
            1
        );
    }

    #[test]
    fn counter_survives_cumulative_reset() {
        // A reconnect resets the underlying cumulative counter; the delta for
        // that sample is clamped to 0 (no negative inc), keeping monotonicity.
        update_from_statuses(&[status("ikev2", 1, 9_000, 0)]);
        let before = BYTES_TRANSFERS_PROTO
            .with_label_values(&["ikev2", "egress"])
            .get();
        update_from_statuses(&[status("ikev2", 1, 10, 0)]); // reset to a small value
        let after = BYTES_TRANSFERS_PROTO
            .with_label_values(&["ikev2", "egress"])
            .get();
        assert_eq!(before, after, "reset must not decrement or overflow");
    }
}
