//! Importazione testo da file PDF (con ripiego OCR), strumenti PDF (unisci/estrai pagine)
//! e decifratura di file Office (.docx / .xlsx) protetti da password (MS-OFFCRYPTO AES).

use std::collections::BTreeMap;
use std::fs;
use std::path::Path;

use lopdf::{Document, Object, ObjectId};
use tauri::ipc::Response;

/// Magic bytes dei contenitori OLE2 (usati dai file .docx/.xlsx cifrati con password).
pub const OLE2_MAGIC: [u8; 8] = [0xD0, 0xCF, 0x11, 0xE0, 0xA1, 0xB1, 0x1A, 0xE1];

pub fn is_ole2(bytes: &[u8]) -> bool {
    bytes.len() >= 8 && bytes[..8] == OLE2_MAGIC
}

/// Decifra un file .docx o .xlsx protetto da password e restituisce i byte ZIP in chiaro.
#[tauri::command]
pub fn decrypt_office_file(path: String, password: String) -> Result<Response, String> {
    let raw = fs::read(&path).map_err(|e| format!("Impossibile leggere il file: {e}"))?;
    let plain = office_crypto::decrypt_from_bytes(raw, &password)
        .map_err(|_| "Password errata o algoritmo di cifratura non supportato".to_string())?;
    Ok(Response::new(plain))
}

/// Estrae il testo di un file PDF pagina per pagina per aprirlo e modificarlo come documento.
/// Usa `pdf-extract` in Rust puro, con ripiego su `pdftotext` e infine OCR (`pdftoppm` + `tesseract`).
#[tauri::command]
pub fn import_pdf_pages(path: String) -> Result<Vec<String>, String> {
    if !Path::new(&path).is_file() {
        return Err("File PDF non trovato".into());
    }
    if let Ok(pages) = pdf_extract::extract_text_by_pages(&path) {
        if pages.iter().any(|p| !p.trim().is_empty()) {
            return Ok(pages);
        }
    }
    if let Ok(output) = std::process::Command::new("pdftotext").args(["-enc", "UTF-8", &path, "-"]).output() {
        if output.status.success() {
            let text = String::from_utf8_lossy(&output.stdout);
            let pages: Vec<String> = text.split('\u{000C}').map(|s| s.to_string()).collect();
            let trimmed: Vec<String> = if pages.len() > 1 && pages.last().is_some_and(|p| p.trim().is_empty()) {
                pages[..pages.len() - 1].to_vec()
            } else {
                pages
            };
            if trimmed.iter().any(|p| !p.trim().is_empty()) {
                return Ok(trimmed);
            }
        }
    }
    // Ripiego OCR se pdftoppm e tesseract sono installati (PDF scansionati).
    if let Ok(pages) = ocr_pdf(&path) {
        if pages.iter().any(|p| !p.trim().is_empty()) {
            return Ok(pages);
        }
    }
    Err("Il PDF non contiene testo selezionabile (per i PDF scansionati installa tesseract-ocr e tesseract-ocr-ita)".into())
}

fn ocr_pdf(path: &str) -> Result<Vec<String>, String> {
    let tmp = std::env::temp_dir().join(format!("zikoffice-ocr-{}", std::process::id()));
    let _ = fs::remove_dir_all(&tmp);
    fs::create_dir_all(&tmp).map_err(|e| e.to_string())?;
    let prefix = tmp.join("page");
    let st = std::process::Command::new("pdftoppm")
        .args(["-png", "-r", "200", path])
        .arg(&prefix)
        .status()
        .map_err(|e| e.to_string())?;
    if !st.success() {
        let _ = fs::remove_dir_all(&tmp);
        return Err("pdftoppm fallito".into());
    }
    let mut imgs: Vec<_> = fs::read_dir(&tmp)
        .map_err(|e| e.to_string())?
        .flatten()
        .map(|e| e.path())
        .filter(|p| p.extension().and_then(|e| e.to_str()) == Some("png"))
        .collect();
    imgs.sort();
    let mut pages = Vec::new();
    for img in imgs {
        let out = std::process::Command::new("tesseract")
            .arg(&img)
            .args(["stdout", "-l", "ita+eng"])
            .output()
            .map_err(|e| e.to_string())?;
        if out.status.success() {
            pages.push(String::from_utf8_lossy(&out.stdout).into_owned());
        }
    }
    let _ = fs::remove_dir_all(&tmp);
    Ok(pages)
}

/// Unisce più file PDF in un unico PDF di destinazione.
#[tauri::command]
pub fn pdf_merge(paths: Vec<String>, out_path: String) -> Result<usize, String> {
    if paths.len() < 2 {
        return Err("Seleziona almeno due file PDF da unire".into());
    }
    let mut max_id = 1u32;
    let mut documents_pages: BTreeMap<ObjectId, Object> = BTreeMap::new();
    let mut documents_objects: BTreeMap<ObjectId, Object> = BTreeMap::new();
    let mut document = Document::with_version("1.5");

    for path in &paths {
        let mut doc = Document::load(path).map_err(|e| format!("Impossibile leggere «{path}»: {e}"))?;
        doc.renumber_objects_with(max_id);
        max_id = doc.max_id + 1;
        for (_, object_id) in doc.get_pages() {
            if let Ok(obj) = doc.get_object(object_id) {
                documents_pages.insert(object_id, obj.to_owned());
            }
        }
        documents_objects.extend(doc.objects);
    }

    let mut catalog_object: Option<(ObjectId, Object)> = None;
    let mut pages_object: Option<(ObjectId, Object)> = None;

    for (object_id, object) in documents_objects {
        match object.type_name().unwrap_or(b"") {
            b"Catalog" => {
                catalog_object = Some((catalog_object.as_ref().map(|(id, _)| *id).unwrap_or(object_id), object));
            }
            b"Pages" => {
                if let Ok(dictionary) = object.as_dict() {
                    let mut dictionary = dictionary.clone();
                    if let Some((_, ref obj)) = pages_object {
                        if let Ok(old_dict) = obj.as_dict() {
                            dictionary.extend(old_dict);
                        }
                    }
                    pages_object = Some((pages_object.as_ref().map(|(id, _)| *id).unwrap_or(object_id), Object::Dictionary(dictionary)));
                }
            }
            b"Page" | b"Outlines" | b"Outline" => {}
            _ => {
                document.objects.insert(object_id, object);
            }
        }
    }

    let (pages_id, pages_obj) = pages_object.ok_or("Struttura PDF non valida (Pages mancante)")?;
    let (catalog_id, catalog_obj) = catalog_object.ok_or("Struttura PDF non valida (Catalog mancante)")?;

    let page_count = documents_pages.len();
    for (object_id, object) in &documents_pages {
        if let Ok(dict) = object.as_dict() {
            let mut dict = dict.clone();
            dict.set("Parent", pages_id);
            document.objects.insert(*object_id, Object::Dictionary(dict));
        }
    }
    if let Ok(dict) = pages_obj.as_dict() {
        let mut dict = dict.clone();
        dict.set("Count", page_count as u32);
        dict.set("Kids", documents_pages.keys().map(|id| Object::Reference(*id)).collect::<Vec<_>>());
        document.objects.insert(pages_id, Object::Dictionary(dict));
    }
    if let Ok(dict) = catalog_obj.as_dict() {
        let mut dict = dict.clone();
        dict.set("Pages", pages_id);
        dict.remove(b"Outlines");
        document.objects.insert(catalog_id, Object::Dictionary(dict));
    }
    document.trailer.set("Root", catalog_id);
    document.max_id = document.objects.len() as u32;
    document.renumber_objects();
    document.compress();

    let mut buf = Vec::new();
    document.save_to(&mut buf).map_err(|e| format!("Errore salvataggio PDF unito: {e}"))?;
    crate::workbook::write_atomically(Path::new(&out_path), &buf)?;
    Ok(page_count)
}

/// Estrae un sottoinsieme di pagine (es. "1-3, 5") da un PDF in un nuovo file PDF.
#[tauri::command]
pub fn pdf_split(path: String, pages_spec: String, out_path: String) -> Result<usize, String> {
    let mut doc = Document::load(&path).map_err(|e| format!("Impossibile leggere il PDF: {e}"))?;
    let total = doc.get_pages().len() as u32;
    if total == 0 {
        return Err("Il PDF non contiene pagine".into());
    }
    let mut keep = Vec::new();
    for part in pages_spec.split(',') {
        let p = part.trim();
        if p.is_empty() {
            continue;
        }
        if let Some((a, b)) = p.split_once('-') {
            let start: u32 = a.trim().parse().map_err(|_| format!("Intervallo non valido: «{p}»"))?;
            let end: u32 = b.trim().parse().map_err(|_| format!("Intervallo non valido: «{p}»"))?;
            for n in start..=end {
                if n >= 1 && n <= total && !keep.contains(&n) {
                    keep.push(n);
                }
            }
        } else {
            let n: u32 = p.parse().map_err(|_| format!("Numero pagina non valido: «{p}»"))?;
            if n >= 1 && n <= total && !keep.contains(&n) {
                keep.push(n);
            }
        }
    }
    if keep.is_empty() {
        return Err(format!("Nessuna pagina valida scelta (il PDF ha {total} pagine)"));
    }
    let to_delete: Vec<u32> = (1..=total).filter(|n| !keep.contains(n)).collect();
    if !to_delete.is_empty() {
        doc.delete_pages(&to_delete);
    }
    doc.prune_objects();
    let mut buf = Vec::new();
    doc.save_to(&mut buf).map_err(|e| format!("Errore salvataggio PDF estratto: {e}"))?;
    crate::workbook::write_atomically(Path::new(&out_path), &buf)?;
    Ok(keep.len())
}
