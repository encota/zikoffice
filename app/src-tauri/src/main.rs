// Su Windows, in release, non apre una finestra di console.
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

fn main() {
    // `zik --register-file-types` (usato dallo script del pacchetto .deb): niente finestra.
    #[cfg(target_os = "linux")]
    if std::env::args().any(|a| a == "--register-file-types") {
        std::process::exit(match zikoffice_lib::register_file_types() {
            Ok(()) => 0,
            Err(e) => {
                eprintln!("{e}");
                1
            }
        });
    }
    zikoffice_lib::run()
}
