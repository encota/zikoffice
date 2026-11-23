//! Punto d'ingresso dell'applicazione, condiviso tra desktop e mobile.
//!
//! Il foglio di calcolo gira nell'interfaccia (IronCalc compilato in WebAssembly);
//! qui in Rust c'è solo ciò che il browser non sa fare: leggere e scrivere
//! i file .xlsx sul disco. I due lati si scambiano la cartella di lavoro nel
//! formato interno di IronCalc (stessa versione su entrambi i lati).

mod associations;
mod calamine_io;
mod csv_io;
mod files;
mod history;
mod ods_export;
mod pdf;
mod pdf_cmds;
mod pdf_edit;
mod pdf_metrics;
mod pdf_import;
mod recovery;
mod spell;
mod terminal;
mod workbook;

/// Autotest (solo build di sviluppo): con ZIKOFFICE_SELFTEST=<cartella> l'interfaccia
/// prova da sola crea → salva → riapri dentro la vera webview e riporta l'esito.
#[cfg(debug_assertions)]
mod selftest {
    #[tauri::command]
    pub fn selftest_dir() -> Option<String> {
        std::env::var("ZIKOFFICE_SELFTEST").ok()
    }

    #[tauri::command]
    pub fn selftest_report(app: tauri::AppHandle, ok: bool, message: String) {
        println!("SELFTEST {}: {message}", if ok { "OK" } else { "FALLITO" });
        app.exit(if ok { 0 } else { 1 });
    }
}

/// `zik --register-file-types`: rende ZikOffice l'app predefinita per i suoi formati ed esce.
#[cfg(target_os = "linux")]
pub fn register_file_types() -> Result<(), String> {
    associations::register()
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    #[cfg(target_os = "linux")]
    associations::first_run();

    use tauri::{Emitter, Manager};

    let mut builder = tauri::Builder::default().plugin(tauri_plugin_dialog::init()).manage(pdf_cmds::PdfState::default()).manage(terminal::TermState::default());

    // Istanza singola su desktop: aprire un secondo file dal file manager lo apre come nuova scheda.
    #[cfg(desktop)]
    if std::env::var_os("ZIKOFFICE_SELFTEST").is_none() {
        builder = builder.plugin(tauri_plugin_single_instance::init(|app, args, cwd| {
            let cwd_path = std::path::PathBuf::from(&cwd);
            let files: Vec<String> = args
                .into_iter()
                .skip(1)
                .filter(|a| !a.starts_with('-'))
                .filter_map(|a| {
                    let p = std::path::PathBuf::from(&a);
                    let full = if p.is_absolute() { p } else { cwd_path.join(p) };
                    std::fs::canonicalize(full).ok()
                })
                .filter(|p| p.is_file())
                .map(|p| p.to_string_lossy().into_owned())
                .collect();
            if let Some(win) = app.get_webview_window("main") {
                let _ = win.unminimize();
                let _ = win.set_focus();
                if !files.is_empty() {
                    let _ = win.emit("open-files", files);
                }
            }
        }));
    }

    builder
        .invoke_handler(tauri::generate_handler![
            workbook::open_workbook,
            workbook::save_workbook,
            workbook::read_xlsx_extras,
            workbook::startup_files,
            terminal::term_open,
            terminal::term_write,
            terminal::term_resize,
            terminal::term_close,
            terminal::ai_status,
            terminal::ai_run,
            files::read_file,
            files::write_file,
            files::convert_legacy_doc,
            files::convert_to_pptx,
            history::history_snapshot,
            history::history_list,
            history::history_read,
            pdf::export_pdf,
            pdf_cmds::pdfedit_open,
            pdf_cmds::pdfedit_close,
            pdf_cmds::pdfedit_objects,
            pdf_cmds::pdfedit_apply,
            pdf_cmds::pdfedit_undo,
            pdf_cmds::pdfedit_redo,
            pdf_cmds::pdfedit_rotate_page,
            pdf_cmds::pdfedit_delete_page,
            pdf_cmds::pdfedit_move_page,
            pdf_cmds::pdfedit_can_undo,
            pdf_cmds::pdfedit_render,
            pdf_cmds::pdfedit_save,
            pdf_cmds::pdfedit_text,
            pdf_cmds::pdfedit_ocr_status,
            pdf_cmds::pdfedit_ocr_page,
            pdf_import::decrypt_office_file,
            pdf_import::import_pdf_pages,
            pdf_import::pdf_merge,
            pdf_import::pdf_split,
            recovery::recovery_write,
            recovery::recovery_list,
            recovery::recovery_read,
            recovery::recovery_delete,
            spell::spell_check,
            spell::spell_suggest,
            spell::spell_add,
            spell::spell_list_langs,
            spell::spell_set_lang,
            #[cfg(debug_assertions)]
            selftest::selftest_dir,
            #[cfg(debug_assertions)]
            selftest::selftest_report,
        ])
        .run(tauri::generate_context!())
        .expect("errore durante l'avvio di ZikOffice");
}
