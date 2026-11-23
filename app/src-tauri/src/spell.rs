//! Controllo ortografico multilingua con i dizionari Hunspell del sistema (italiano per primo).
//!
//! Il dizionario attivo resta in memoria; le parole aggiunte dall'utente vengono
//! salvate in un dizionario personale nella cartella dei dati dell'app.

use std::collections::BTreeSet;
use std::fs;
use std::path::PathBuf;
use std::sync::{Mutex, OnceLock};

use spellbook::Dictionary;
use tauri::{AppHandle, Manager};

struct SpellState {
    lang: String,
    dict: Option<Dictionary>,
}

static STATE: OnceLock<Mutex<SpellState>> = OnceLock::new();

const SEARCH_DIRS: [&str; 3] = ["/usr/share/hunspell", "/usr/share/myspell/dicts", "/usr/share/myspell"];

fn personal_path(app: &AppHandle) -> Option<PathBuf> {
    app.path().app_data_dir().ok().map(|d| d.join("dizionario-personale.txt"))
}

fn load(app: &AppHandle, lang: &str) -> Option<Dictionary> {
    for dir in SEARCH_DIRS {
        let aff = format!("{dir}/{lang}.aff");
        let dic = format!("{dir}/{lang}.dic");
        let (Ok(aff), Ok(dic)) = (fs::read_to_string(&aff), fs::read_to_string(&dic)) else { continue };
        let Ok(mut d) = Dictionary::new(&aff, &dic) else { continue };
        if let Some(p) = personal_path(app) {
            if let Ok(words) = fs::read_to_string(p) {
                for w in words.lines().map(str::trim).filter(|w| !w.is_empty()) {
                    let _ = d.add(w);
                }
            }
        }
        return Some(d);
    }
    None
}

fn with_state<T>(app: &AppHandle, f: impl FnOnce(&mut SpellState) -> T) -> Result<T, String> {
    let cell = STATE.get_or_init(|| {
        let lang = "it_IT".to_string();
        let dict = load(app, &lang);
        Mutex::new(SpellState { lang, dict })
    });
    let mut guard = cell.lock().map_err(|_| "Dizionario non disponibile".to_string())?;
    Ok(f(&mut guard))
}

fn with_dict<T>(app: &AppHandle, f: impl FnOnce(&mut Dictionary) -> T) -> Result<T, String> {
    with_state(app, |st| {
        let dict = st.dict.as_mut().ok_or_else(|| format!("Dizionario «{}» non trovato (installa hunspell-it)", st.lang))?;
        Ok(f(dict))
    })?
}

/// Elenca i codici lingua dei dizionari Hunspell installati sul sistema (es. ["it_IT", "en_US"]).
#[tauri::command]
pub fn spell_list_langs() -> Vec<String> {
    let mut found = BTreeSet::new();
    for dir in SEARCH_DIRS {
        let Ok(rd) = fs::read_dir(dir) else { continue };
        for entry in rd.flatten() {
            let p = entry.path();
            if p.extension().and_then(|e| e.to_str()) == Some("dic") {
                if let Some(stem) = p.file_stem().and_then(|s| s.to_str()) {
                    if !stem.starts_with("hyph_") && !stem.starts_with("th_") {
                        let aff = p.with_extension("aff");
                        if aff.exists() {
                            found.insert(stem.to_string());
                        }
                    }
                }
            }
        }
    }
    found.into_iter().collect()
}

/// Cambia la lingua attiva del controllo ortografico (es. "it_IT", "en_US").
#[tauri::command]
pub fn spell_set_lang(app: AppHandle, lang: String) -> Result<String, String> {
    let loaded = load(&app, &lang).ok_or_else(|| format!("Dizionario «{lang}» non installato"))?;
    with_state(&app, |st| {
        st.lang = lang.clone();
        st.dict = Some(loaded);
    })?;
    Ok(lang)
}

/// Per ogni parola: true se è scritta correttamente.
#[tauri::command]
pub fn spell_check(app: AppHandle, words: Vec<String>) -> Result<Vec<bool>, String> {
    with_dict(&app, |d| words.iter().map(|w| d.check(w)).collect())
}

#[tauri::command]
pub fn spell_suggest(app: AppHandle, word: String) -> Result<Vec<String>, String> {
    with_dict(&app, |d| {
        let mut out = Vec::new();
        d.suggest(&word, &mut out);
        out.truncate(6);
        out
    })
}

/// Aggiunge una parola al dizionario personale (resta anche nelle sessioni successive).
#[tauri::command]
pub fn spell_add(app: AppHandle, word: String) -> Result<(), String> {
    let word = word.trim().to_string();
    if word.is_empty() || word.contains(char::is_whitespace) {
        return Err("Parola non valida".into());
    }
    with_dict(&app, |d| d.add(&word).map_err(|e| e.to_string()))??;
    if let Some(p) = personal_path(&app) {
        if let Some(parent) = p.parent() {
            let _ = fs::create_dir_all(parent);
        }
        let mut text = fs::read_to_string(&p).unwrap_or_default();
        if !text.lines().any(|l| l == word) {
            text.push_str(&word);
            text.push('\n');
            crate::workbook::write_atomically(&p, text.as_bytes())?;
        }
    }
    Ok(())
}
