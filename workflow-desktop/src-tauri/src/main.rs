// Desktop shell entry. All Workflow operations go over HTTPS to Workflow
// Core with a bearer token; the shell owns windowing, tray and OS
// integration only - it never talks to databases directly.
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

fn main() {
    workflow_desktop_lib::run()
}
