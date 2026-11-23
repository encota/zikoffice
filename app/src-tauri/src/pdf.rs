//! Esportazione PDF: stampa la webview (con il contenuto "da stampa" già preparato
//! dall'interfaccia) sulla stampante virtuale "Stampa su file" di GTK, senza finestre.

#[cfg(target_os = "linux")]
#[tauri::command]
pub async fn export_pdf(window: tauri::WebviewWindow, path: String, width: f64, height: f64, margin: f64) -> Result<(), String> {
    use std::sync::mpsc;
    use std::time::Duration;

    let (tx, rx) = mpsc::channel::<Result<(), String>>();
    let uri = url_from_path(&path)?;
    window
        .with_webview(move |wv| {
            use webkit2gtk::{PrintOperation, PrintOperationExt};

            // La stampante virtuale che scrive su file: il suo nome è tradotto nella lingua del sistema
            // (es. "Stampa su file"), quindi lo chiediamo al catalogo di traduzioni di GTK.
            let printer = gtk::glib::dgettext(Some("gtk30"), "Print to File").to_string();

            let settings = gtk::PrintSettings::new();
            settings.set_printer(&printer);
            settings.set("output-uri", Some(&uri));
            settings.set("output-file-format", Some("pdf"));
            settings.set_n_copies(1);

            let setup = gtk::PageSetup::new();
            let paper = gtk::PaperSize::new_custom("zikoffice", "ZikOffice", width, height, gtk::Unit::Points);
            setup.set_paper_size(&paper);
            for m in [gtk::PositionType::Top, gtk::PositionType::Bottom, gtk::PositionType::Left, gtk::PositionType::Right] {
                match m {
                    gtk::PositionType::Top => setup.set_top_margin(margin, gtk::Unit::Points),
                    gtk::PositionType::Bottom => setup.set_bottom_margin(margin, gtk::Unit::Points),
                    gtk::PositionType::Left => setup.set_left_margin(margin, gtk::Unit::Points),
                    _ => setup.set_right_margin(margin, gtk::Unit::Points),
                }
            }

            let op = PrintOperation::new(&wv.inner());
            op.set_print_settings(&settings);
            op.set_page_setup(&setup);
            let ok = tx.clone();
            op.connect_finished(move |_| { let _ = ok.send(Ok(())); });
            let fail = tx;
            op.connect_failed(move |_, err| { let _ = fail.send(Err(format!("Stampa non riuscita: {err}"))); });
            op.print();
        })
        .map_err(|e| e.to_string())?;

    tauri::async_runtime::spawn_blocking(move || {
        rx.recv_timeout(Duration::from_secs(120)).map_err(|_| "L'esportazione PDF non ha risposto".to_string())?
    })
    .await
    .map_err(|e| e.to_string())??;

    let size = std::fs::metadata(&path).map(|m| m.len()).unwrap_or(0);
    if size == 0 {
        return Err("Il PDF non è stato creato".into());
    }
    Ok(())
}

#[cfg(not(target_os = "linux"))]
#[tauri::command]
pub async fn export_pdf(_path: String, _width: f64, _height: f64, _margin: f64) -> Result<(), String> {
    Err("Su questo sistema usa Stampa → Salva come PDF".into())
}

#[cfg(target_os = "linux")]
fn url_from_path(path: &str) -> Result<String, String> {
    let abs = std::path::Path::new(path);
    if !abs.is_absolute() {
        return Err("Percorso non valido".into());
    }
    // Codifica come URI file:// (spazi e lettere accentate inclusi).
    let mut out = String::from("file://");
    for b in abs.to_string_lossy().bytes() {
        if b.is_ascii_alphanumeric() || b"/-_.~".contains(&b) { out.push(b as char); } else { out.push_str(&format!("%{b:02X}")); }
    }
    Ok(out)
}
