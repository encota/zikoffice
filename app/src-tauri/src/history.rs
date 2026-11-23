//! Cronologia locale delle versioni: prima di sovrascrivere un file sul disco,
//! salva una copia datata nella cartella dei dati dell'app (fino a 20 versioni per file).

use std::fs;
use std::path::{Path, PathBuf};
use std::time::{SystemTime, UNIX_EPOCH};

use serde::Serialize;
use tauri::{AppHandle, Manager, ipc::Response};

const MAX_VERSIONS: usize = 20;

#[derive(Serialize)]
pub struct HistoryEntry {
    pub id: String,
    pub saved_at: u64,
    pub size: u64,
}

/// Hash fisso (FNV-1a a 64 bit) del percorso: `DefaultHasher` non garantisce lo stesso risultato
/// tra versioni del compilatore, e dopo un aggiornamento la cronologia sembrerebbe sparita.
fn stable_hash(path: &str) -> u64 {
    let mut h: u64 = 0xcbf29ce484222325;
    for b in path.bytes() {
        h ^= u64::from(b);
        h = h.wrapping_mul(0x100000001b3);
    }
    h
}

fn bucket_dir(app: &AppHandle, path: &str) -> Result<PathBuf, String> {
    let base = app.path().app_data_dir().map_err(|e| e.to_string())?.join("cronologia");
    let dir = base.join(format!("{:016x}", stable_hash(path)));
    // Migrazione: le cartelle create con il vecchio hash prendono il nome nuovo.
    if !dir.exists() {
        use std::hash::{DefaultHasher, Hash, Hasher};
        let mut old = DefaultHasher::new();
        path.hash(&mut old);
        let legacy = base.join(format!("{:016x}", old.finish()));
        if legacy.is_dir() {
            let _ = fs::rename(&legacy, &dir);
        }
    }
    Ok(dir)
}

/// Salva uno snapshot della versione attualmente presente sul disco prima della sovrascrittura.
#[tauri::command]
pub fn history_snapshot(app: AppHandle, path: String) -> Result<(), String> {
    let src = Path::new(&path);
    if !src.is_file() {
        return Ok(());
    }
    let bytes = fs::read(src).map_err(|e| e.to_string())?;
    let dir = bucket_dir(&app, &path)?;
    fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
    let now = SystemTime::now().duration_since(UNIX_EPOCH).map(|d| d.as_secs()).unwrap_or(0);
    let ext = src.extension().and_then(|e| e.to_str()).unwrap_or("bin");
    let target = dir.join(format!("{now}.{ext}"));
    crate::workbook::write_atomically(&target, &bytes)?;

    // Mantieni solo le ultime MAX_VERSIONS copie.
    let mut entries: Vec<PathBuf> = fs::read_dir(&dir)
        .map_err(|e| e.to_string())?
        .flatten()
        .map(|e| e.path())
        .filter(|p| p.is_file())
        .collect();
    entries.sort();
    while entries.len() > MAX_VERSIONS {
        let oldest = entries.remove(0);
        let _ = fs::remove_file(oldest);
    }
    Ok(())
}

/// Elenca le versioni salvate per un percorso (dalla più recente alla più vecchia).
#[tauri::command]
pub fn history_list(app: AppHandle, path: String) -> Result<Vec<HistoryEntry>, String> {
    let dir = bucket_dir(&app, &path)?;
    let Ok(rd) = fs::read_dir(&dir) else { return Ok(Vec::new()) };
    let mut out = Vec::new();
    for entry in rd.flatten() {
        let p = entry.path();
        if !p.is_file() {
            continue;
        }
        let Some(name) = p.file_name().and_then(|n| n.to_str()) else { continue };
        let saved_at = name.split('.').next().and_then(|s| s.parse::<u64>().ok()).unwrap_or(0);
        let size = entry.metadata().map(|m| m.len()).unwrap_or(0);
        out.push(HistoryEntry { id: name.to_string(), saved_at, size });
    }
    out.sort_by(|a, b| b.saved_at.cmp(&a.saved_at));
    Ok(out)
}

/// Restituisce i byte di una versione precedente.
#[tauri::command]
pub fn history_read(app: AppHandle, path: String, id: String) -> Result<Response, String> {
    if id.contains('/') || id.contains('\\') || id.contains("..") {
        return Err("Versione non valida".into());
    }
    let file = bucket_dir(&app, &path)?.join(&id);
    let bytes = fs::read(&file).map_err(|e| format!("Impossibile leggere la versione: {e}"))?;
    Ok(Response::new(bytes))
}

#[cfg(test)]
mod tests {
    use super::stable_hash;

    #[test]
    fn hash_is_stable_across_builds() {
        // Valori fissi: se cambiano, la cronologia salvata non si ritroverebbe più.
        assert_eq!(stable_hash(""), 0xcbf29ce484222325);
        assert_eq!(stable_hash("a"), 0xaf63dc4c8601ec8c);
        assert_ne!(stable_hash("/home/x/a.docx"), stable_hash("/home/x/b.docx"));
    }
}
