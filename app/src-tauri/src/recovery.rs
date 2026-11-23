//! Copie di recupero dei documenti non salvati (in caso di chiusura anomala).
//!
//! Ogni documento aperto e modificato ha due file nella cartella dei dati dell'app:
//! `<id>.bin` (contenuto) e `<id>.json` (nome, tipo, percorso, processo che lo sta usando).
//! All'avvio si propongono solo le copie dei processi non più in esecuzione.

use std::fs;
use std::path::PathBuf;

use serde::{Deserialize, Serialize};
use tauri::ipc::{InvokeBody, Request, Response};
use tauri::{AppHandle, Manager};

use crate::workbook::{percent_decode, write_atomically};

#[derive(Serialize, Deserialize, Clone)]
pub struct RecoveryEntry {
    pub id: String,
    pub name: String,
    pub kind: String,
    pub path: Option<String>,
    pub pid: u32,
    pub saved_at: u64,
}

fn dir(app: &AppHandle) -> Result<PathBuf, String> {
    let d = app.path().app_data_dir().map_err(|e| e.to_string())?.join("recovery");
    fs::create_dir_all(&d).map_err(|e| format!("Impossibile creare la cartella di recupero: {e}"))?;
    Ok(d)
}

fn valid_id(id: &str) -> Result<(), String> {
    if !id.is_empty() && id.len() <= 64 && id.chars().all(|c| c.is_ascii_alphanumeric() || c == '-') {
        Ok(())
    } else {
        Err("Identificativo non valido".into())
    }
}

/// Il processo che ha scritto la copia è ancora in esecuzione?
fn alive(pid: u32) -> bool {
    if pid == std::process::id() {
        return true;
    }
    #[cfg(target_os = "linux")]
    {
        std::path::Path::new(&format!("/proc/{pid}")).exists()
    }
    #[cfg(not(target_os = "linux"))]
    {
        false
    }
}

#[tauri::command]
pub fn recovery_write(app: AppHandle, request: Request<'_>) -> Result<(), String> {
    let meta = request
        .headers()
        .get("meta")
        .and_then(|v| v.to_str().ok())
        .map(percent_decode)
        .ok_or("Dati mancanti")??;
    let mut entry: RecoveryEntry = serde_json::from_str(&meta).map_err(|e| e.to_string())?;
    valid_id(&entry.id)?;
    entry.pid = std::process::id();
    entry.saved_at = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_secs())
        .unwrap_or(0);
    let InvokeBody::Raw(bytes) = request.body() else {
        return Err("Contenuto mancante".into());
    };
    let d = dir(&app)?;
    write_atomically(&d.join(format!("{}.bin", entry.id)), bytes)?;
    write_atomically(&d.join(format!("{}.json", entry.id)), serde_json::to_string(&entry).map_err(|e| e.to_string())?.as_bytes())
}

/// Copie lasciate da sessioni chiuse male (non da finestre ancora aperte).
#[tauri::command]
pub fn recovery_list(app: AppHandle) -> Result<Vec<RecoveryEntry>, String> {
    let d = dir(&app)?;
    let mut out = Vec::new();
    for e in fs::read_dir(&d).map_err(|e| e.to_string())?.flatten() {
        let p = e.path();
        if p.extension().and_then(|x| x.to_str()) != Some("json") {
            continue;
        }
        let Ok(text) = fs::read_to_string(&p) else { continue };
        let Ok(entry) = serde_json::from_str::<RecoveryEntry>(&text) else { continue };
        if !alive(entry.pid) && d.join(format!("{}.bin", entry.id)).exists() {
            out.push(entry);
        }
    }
    out.sort_by(|a, b| b.saved_at.cmp(&a.saved_at));
    Ok(out)
}

#[tauri::command]
pub fn recovery_read(app: AppHandle, id: String) -> Result<Response, String> {
    valid_id(&id)?;
    let bytes = fs::read(dir(&app)?.join(format!("{id}.bin"))).map_err(|e| e.to_string())?;
    Ok(Response::new(bytes))
}

#[tauri::command]
pub fn recovery_delete(app: AppHandle, id: String) -> Result<(), String> {
    valid_id(&id)?;
    let d = dir(&app)?;
    let _ = fs::remove_file(d.join(format!("{id}.bin")));
    let _ = fs::remove_file(d.join(format!("{id}.json")));
    Ok(())
}
