//! System tray implementation for vpnVPN Desktop.
//!
//! Provides quick access to VPN controls from the system tray/menu bar.

use tauri::{
    image::Image,
    menu::{CheckMenuItem, Menu, MenuItem, PredefinedMenuItem},
    tray::{MouseButton, MouseButtonState, TrayIcon, TrayIconBuilder, TrayIconEvent},
    AppHandle, Emitter, Manager, Runtime, Wry,
};

/// Tray menu item IDs
mod ids {
    pub const STATUS: &str = "status";
    pub const CONNECT: &str = "connect";
    pub const DISCONNECT: &str = "disconnect";
    pub const KILL_SWITCH: &str = "kill_switch";
    pub const AUTO_START: &str = "auto_start";
    pub const OPEN_APP: &str = "open_app";
    pub const SETTINGS: &str = "settings";
    pub const QUIT: &str = "quit";
}

/// VPN connection state for tray updates
#[derive(Clone, Debug, Default)]
pub struct TrayState {
    pub connected: bool,
    pub kill_switch_enabled: bool,
    pub auto_start_enabled: bool,
    pub server_name: Option<String>,
}

/// Create and configure the system tray
pub fn create_tray(app: &AppHandle<Wry>) -> Result<TrayIcon<Wry>, Box<dyn std::error::Error>> {
    let state = TrayState::default();
    let menu = build_tray_menu(app, &state)?;

    // Load the default (disconnected) tray icon
    let icon = load_tray_icon(false)?;

    let tray = TrayIconBuilder::with_id("vpnvpn-tray")
        .icon(icon)
        .menu(&menu)
        .show_menu_on_left_click(false)
        .tooltip("vpnVPN - Disconnected")
        .on_menu_event(move |app, event| {
            handle_menu_event(app, event.id.as_ref());
        })
        .on_tray_icon_event(|tray, event| {
            // On left click, show the main window
            if let TrayIconEvent::Click {
                button: MouseButton::Left,
                button_state: MouseButtonState::Up,
                ..
            } = event
            {
                if let Some(window) = tray.app_handle().get_webview_window("main") {
                    let _ = window.show();
                    let _ = window.set_focus();
                }
            }
        })
        .build(app)?;

    Ok(tray)
}

/// Build the tray menu based on current state
fn build_tray_menu<R: Runtime>(
    app: &AppHandle<R>,
    state: &TrayState,
) -> Result<Menu<R>, Box<dyn std::error::Error>> {
    let menu = Menu::new(app)?;

    // Status line (disabled, just for display)
    let status_text = if state.connected {
        format!(
            "● Connected{}",
            state
                .server_name
                .as_ref()
                .map(|s| format!(" to {}", s))
                .unwrap_or_default()
        )
    } else {
        "○ Disconnected".to_string()
    };

    let status_item = MenuItem::with_id(app, ids::STATUS, &status_text, false, None::<&str>)?;
    menu.append(&status_item)?;

    // Separator
    menu.append(&PredefinedMenuItem::separator(app)?)?;

    // Connect/Disconnect
    if state.connected {
        let disconnect = MenuItem::with_id(app, ids::DISCONNECT, "Disconnect", true, None::<&str>)?;
        menu.append(&disconnect)?;
    } else {
        let connect = MenuItem::with_id(app, ids::CONNECT, "Connect", true, None::<&str>)?;
        menu.append(&connect)?;
    }

    // Separator
    menu.append(&PredefinedMenuItem::separator(app)?)?;

    // Kill Switch toggle
    let kill_switch = CheckMenuItem::with_id(
        app,
        ids::KILL_SWITCH,
        "Kill Switch",
        true,
        state.kill_switch_enabled,
        None::<&str>,
    )?;
    menu.append(&kill_switch)?;

    // Auto-start toggle
    let auto_start = CheckMenuItem::with_id(
        app,
        ids::AUTO_START,
        "Auto-connect on startup",
        true,
        state.auto_start_enabled,
        None::<&str>,
    )?;
    menu.append(&auto_start)?;

    // Separator
    menu.append(&PredefinedMenuItem::separator(app)?)?;

    // Open App
    let open_app = MenuItem::with_id(app, ids::OPEN_APP, "Open vpnVPN", true, None::<&str>)?;
    menu.append(&open_app)?;

    // Settings
    let settings = MenuItem::with_id(app, ids::SETTINGS, "Settings...", true, None::<&str>)?;
    menu.append(&settings)?;

    // Separator
    menu.append(&PredefinedMenuItem::separator(app)?)?;

    // Quit
    let quit = MenuItem::with_id(app, ids::QUIT, "Quit vpnVPN", true, None::<&str>)?;
    menu.append(&quit)?;

    Ok(menu)
}

/// Handle menu item clicks
fn handle_menu_event<R: Runtime>(app: &AppHandle<R>, menu_id: &str) {
    match menu_id {
        ids::CONNECT => {
            // Emit event to frontend to connect
            let _ = app.emit("tray-connect", ());
            show_main_window(app);
        }
        ids::DISCONNECT => {
            // Emit event to frontend to disconnect
            let _ = app.emit("tray-disconnect", ());
        }
        ids::KILL_SWITCH => {
            // Toggle kill switch - emit event to frontend
            let _ = app.emit("tray-toggle-kill-switch", ());
        }
        ids::AUTO_START => {
            // Toggle auto-start - emit event to frontend
            let _ = app.emit("tray-toggle-auto-start", ());
        }
        ids::OPEN_APP => {
            show_main_window(app);
        }
        ids::SETTINGS => {
            // Open settings
            let _ = app.emit("tray-open-settings", ());
            show_main_window(app);
        }
        ids::QUIT => {
            // Quit the application
            app.exit(0);
        }
        _ => {}
    }
}

/// Show and focus the main window
fn show_main_window<R: Runtime>(app: &AppHandle<R>) {
    if let Some(window) = app.get_webview_window("main") {
        let _ = window.show();
        let _ = window.unminimize();
        let _ = window.set_focus();
    }
}

/// Load tray icon based on connection state
fn load_tray_icon(connected: bool) -> Result<Image<'static>, Box<dyn std::error::Error>> {
    // The two `include_bytes!` arms embed different icon files; clippy flags the
    // branches as identical because the macro invocations look the same.
    #[allow(clippy::if_same_then_else)]
    let icon_bytes = if connected {
        include_bytes!("../icons/tray-icon-connected.png")
    } else {
        include_bytes!("../icons/tray-icon-disconnected.png")
    };

    Ok(Image::from_bytes(icon_bytes)?)
}

/// Update tray state (call from frontend via command)
pub fn update_tray_state(app: &AppHandle<Wry>, state: &TrayState) -> Result<(), String> {
    let tray = app.tray_by_id("vpnvpn-tray").ok_or("Tray not found")?;

    // Update icon
    let icon = load_tray_icon(state.connected).map_err(|e| e.to_string())?;
    tray.set_icon(Some(icon)).map_err(|e| e.to_string())?;

    // Update tooltip
    let tooltip = if state.connected {
        format!(
            "vpnVPN - Connected{}",
            state
                .server_name
                .as_ref()
                .map(|s| format!(" to {}", s))
                .unwrap_or_default()
        )
    } else {
        "vpnVPN - Disconnected".to_string()
    };
    tray.set_tooltip(Some(&tooltip))
        .map_err(|e| e.to_string())?;

    // Rebuild menu with new state
    let menu = build_tray_menu(app, state).map_err(|e| e.to_string())?;
    tray.set_menu(Some(menu)).map_err(|e| e.to_string())?;

    Ok(())
}
