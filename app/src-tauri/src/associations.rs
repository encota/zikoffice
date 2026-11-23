//! Linux: ZikOffice diventa l'app predefinita per i formati che apre.
//!
//! Succede da solo all'installazione del .deb (lo script del pacchetto lancia
//! `zik --register-file-types` per l'utente che installa) e, se lì non è stato possibile
//! (installazione da un programma grafico), al primo avvio. Una volta sola: se poi l'utente
//! sceglie un'altra app per un formato, la scelta resta sua. Si ripete solo se ZikOffice
//! impara ad aprire formati nuovi.

use std::path::{Path, PathBuf};

/// Nome del file .desktop installato dal pacchetto (deriva da `productName`).
const DESKTOP_FILE: &str = "ZikOffice.desktop";
/// L'elenco dei formati è uno solo: quello delle associazioni in tauri.conf.json.
const CONF: &str = include_str!("../tauri.conf.json");

pub fn mime_types() -> Vec<String> {
    let conf: serde_json::Value = serde_json::from_str(CONF).unwrap_or_default();
    let mut out: Vec<String> = conf["bundle"]["fileAssociations"]
        .as_array()
        .map(|list| list.iter().filter_map(|a| a["mimeType"].as_str().map(str::to_owned)).collect())
        .unwrap_or_default();
    out.sort();
    out.dedup();
    out
}

/// ZikOffice è installato (c'è il suo .desktop): in sviluppo non si tocca nulla.
fn installed() -> bool {
    ["/usr/share/applications", "/usr/local/share/applications"]
        .iter()
        .any(|d| Path::new(d).join(DESKTOP_FILE).is_file())
}

fn marker() -> Option<PathBuf> {
    let base = std::env::var_os("XDG_CONFIG_HOME")
        .map(PathBuf::from)
        .or_else(|| std::env::var_os("HOME").map(|h| PathBuf::from(h).join(".config")))?;
    Some(base.join("zikoffice").join("file-types-registered"))
}

/// Imposta ZikOffice come app predefinita per tutti i formati supportati (utente corrente).
pub fn register() -> Result<(), String> {
    let mimes = mime_types();
    // xdg-mime scrive in ~/.config/mimeapps.list: la cartella deve esistere (utente appena creato).
    if let Some(dir) = marker().and_then(|m| m.parent().and_then(|p| p.parent()).map(Path::to_path_buf)) {
        let _ = std::fs::create_dir_all(dir);
    }
    let status = std::process::Command::new("xdg-mime")
        .arg("default")
        .arg(DESKTOP_FILE)
        .args(&mimes)
        .status()
        .map_err(|e| format!("xdg-mime non disponibile: {e}"))?;
    if !status.success() {
        return Err("xdg-mime non è riuscito a impostare le associazioni".into());
    }
    if let Some(m) = marker() {
        if let Some(dir) = m.parent() {
            let _ = std::fs::create_dir_all(dir);
        }
        let _ = std::fs::write(&m, mimes.join("\n"));
    }
    Ok(())
}

/// Al primo avvio dopo l'installazione (o dopo un aggiornamento con formati nuovi).
pub fn first_run() {
    if !installed() {
        return;
    }
    let Some(m) = marker() else { return };
    if std::fs::read_to_string(&m).ok().as_deref() == Some(mime_types().join("\n").as_str()) {
        return;
    }
    std::thread::spawn(|| {
        if let Err(e) = register() {
            eprintln!("Associazioni dei file: {e}");
        }
    });
}

#[cfg(test)]
mod tests {
    #[test]
    fn elenco_formati_dal_file_di_configurazione() {
        let m = super::mime_types();
        for t in [
            "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
            "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
            "application/vnd.openxmlformats-officedocument.presentationml.presentation",
            "application/pdf",
        ] {
            assert!(m.iter().any(|x| x == t), "manca {t}");
        }
    }
}
