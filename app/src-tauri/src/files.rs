//! Lettura e scrittura di file binari (per i documenti .docx, elaborati nell'interfaccia).

use std::path::Path;

use tauri::ipc::{InvokeBody, Request, Response};

use crate::workbook::write_atomically;

/// Dimensione massima di un file aperto (per non bloccare l'app con file enormi).
const MAX_SIZE: u64 = 512 * 1024 * 1024;

#[tauri::command]
pub fn read_file(path: String) -> Result<Response, String> {
    let meta = std::fs::metadata(&path).map_err(|e| format!("Impossibile aprire il file: {e}"))?;
    if meta.len() > MAX_SIZE {
        return Err("Il file è troppo grande (oltre 512 MB)".into());
    }
    let bytes = std::fs::read(&path).map_err(|e| format!("Impossibile leggere il file: {e}"))?;
    Ok(Response::new(bytes))
}

/// Scrive i byte ricevuti (corpo della richiesta) nel percorso indicato dall'header `path`.
#[tauri::command]
pub fn write_file(request: Request<'_>) -> Result<(), String> {
    let path = request
        .headers()
        .get("path")
        .and_then(|v| v.to_str().ok())
        .map(crate::workbook::percent_decode)
        .ok_or("Percorso del file mancante")??;
    let InvokeBody::Raw(bytes) = request.body() else {
        return Err("Dati del file mancanti".into());
    };
    // `mkdir: 1` crea anche la cartella che lo contiene (immagini accanto a un documento Markdown).
    if request.headers().get("mkdir").is_some() {
        if let Some(dir) = Path::new(&path).parent().filter(|d| !d.as_os_str().is_empty()) {
            std::fs::create_dir_all(dir).map_err(|e| format!("Impossibile creare la cartella: {e}"))?;
        }
    }
    write_atomically(Path::new(&path), bytes)
}

/// Converte un file con LibreOffice (soffice) nel formato indicato e ne restituisce i byte.
fn convert_with_office(path: &str, to: &str, missing: &str, failed: &str) -> Result<Vec<u8>, String> {
    let src = Path::new(path);
    if !src.is_file() {
        return Err("File non trovato".into());
    }
    let tmp = std::env::temp_dir().join(format!("zikoffice-{to}-{}", std::process::id()));
    let _ = std::fs::remove_dir_all(&tmp);
    std::fs::create_dir_all(&tmp).map_err(|e| format!("Impossibile preparare la cartella temporanea: {e}"))?;
    let status = std::process::Command::new("soffice")
        .args(["--headless", "--convert-to", to, "--outdir"])
        .arg(&tmp)
        .arg(src)
        .status();
    let res = (|| -> Result<Vec<u8>, String> {
        let st = status.map_err(|_| missing.to_string())?;
        if !st.success() {
            return Err(failed.into());
        }
        let stem = src.file_stem().ok_or("Nome file non valido")?;
        let out = tmp.join(format!("{}.{to}", stem.to_string_lossy()));
        std::fs::read(&out).map_err(|e| format!("Impossibile leggere il file convertito: {e}"))
    })();
    let _ = std::fs::remove_dir_all(&tmp);
    res
}

/// Converte un vecchio file binario Word 97-2003 (.doc) in .docx tramite LibreOffice (se installato)
/// e restituisce i byte del .docx pronto da aprire in ZikOffice.
#[tauri::command]
pub fn convert_legacy_doc(path: String) -> Result<Response, String> {
    convert_with_office(
        &path,
        "docx",
        "Per aprire i vecchi file .doc installa LibreOffice (soffice) oppure converti il file in .docx",
        "Conversione del file .doc non riuscita",
    )
    .map(Response::new)
}

/// Le vecchie presentazioni (.ppt) e quelle OpenDocument (.odp) si aprono convertendole in .pptx.
#[tauri::command]
pub fn convert_to_pptx(path: String) -> Result<Response, String> {
    convert_with_office(
        &path,
        "pptx",
        "Per aprire i file .ppt e .odp installa LibreOffice (soffice) oppure salvali come .pptx",
        "Conversione della presentazione non riuscita",
    )
    .map(Response::new)
}
