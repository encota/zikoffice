//! Comandi Tauri per la modifica dei PDF: sessioni di modifica, disegno delle pagine, salvataggio e OCR.
//!
//! Il disegno delle pagine e il riconoscimento del testo usano programmi esterni installati sul sistema
//! (`mutool` di MuPDF o `pdftoppm` di Poppler per l'immagine, `tesseract` per l'OCR): sono lasciati
//! fuori dall'app per non appesantirla e per usare le lingue installate dall'utente.

use std::collections::HashMap;
use std::io::Write;
use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};
use std::sync::Mutex;
use std::sync::atomic::{AtomicU32, Ordering};

use lopdf::Document;
use serde::{Deserialize, Serialize};
use tauri::ipc::Response;
use tauri::{AppHandle, Manager, State};

use crate::pdf_edit::{Edit, Found, Mat, OcrWord, PageInfo, Session, UndoInfo, page_infos};

#[derive(Default)]
pub struct PdfState {
    sessions: Mutex<HashMap<u32, Session>>,
    next: AtomicU32,
}

#[derive(Serialize)]
pub struct OpenInfo {
    id: u32,
    pages: Vec<PageInfo>,
}

#[derive(Serialize)]
pub struct ObjOut {
    id: usize,
    end: usize,
    kind: &'static str,
    bbox: [f64; 4],
    text: Option<String>,
}

impl From<&Found> for ObjOut {
    fn from(f: &Found) -> ObjOut {
        ObjOut { id: f.id, end: f.end, kind: f.kind.name(), bbox: f.bbox, text: f.text.clone() }
    }
}

#[derive(Serialize)]
pub struct ApplyOut {
    new_ids: Vec<usize>,
    objects: Vec<ObjOut>,
}

#[derive(Deserialize)]
pub struct EditAction {
    /// "delete" oppure "transform"
    kind: String,
    /// Matrice affine nello spazio della pagina (per "transform").
    matrix: Option<[f64; 6]>,
}

fn lock<'a>(state: &'a State<'_, PdfState>) -> Result<std::sync::MutexGuard<'a, HashMap<u32, Session>>, String> {
    state.sessions.lock().map_err(|_| "Stato interno non disponibile".to_string())
}

fn session<'a>(map: &'a mut HashMap<u32, Session>, id: u32) -> Result<&'a mut Session, String> {
    map.get_mut(&id).ok_or_else(|| "Sessione PDF non trovata (documento già chiuso?)".to_string())
}

fn work_dir(app: &AppHandle) -> Result<PathBuf, String> {
    let d = app.path().app_data_dir().map_err(|e| e.to_string())?.join("pdfwork");
    std::fs::create_dir_all(&d).map_err(|e| format!("Impossibile creare la cartella di lavoro: {e}"))?;
    Ok(d)
}

/// Carica un PDF, togliendo la protezione se la password è giusta (o vuota).
pub fn load_pdf(path: &str, password: Option<&str>) -> Result<Document, String> {
    let doc = Document::load(path).map_err(|e| format!("Impossibile aprire il PDF: {e}"))?;
    if !doc.is_encrypted() {
        return Ok(doc);
    }
    // Un PDF cifrato va riletto passando la password: solo così se ne leggono anche gli oggetti compressi.
    // Molti PDF sono "protetti" solo contro la modifica e si aprono con password vuota.
    Document::load_with_password(path, password.unwrap_or("")).map_err(|_| if password.is_some() { "Password errata".to_string() } else { "PASSWORD_REQUIRED".to_string() })
}

/// Apre un PDF per la modifica. Per i file protetti serve la password (altrimenti l'errore è `PASSWORD_REQUIRED`).
#[tauri::command]
pub fn pdfedit_open(state: State<'_, PdfState>, path: String, password: Option<String>) -> Result<OpenInfo, String> {
    let doc = load_pdf(&path, password.as_deref())?;
    let pages = page_infos(&doc);
    if pages.is_empty() {
        return Err("Il PDF non contiene pagine".into());
    }
    let id = state.next.fetch_add(1, Ordering::SeqCst) + 1;
    lock(&state)?.insert(id, Session::new(doc, path));
    Ok(OpenInfo { id, pages })
}

#[tauri::command]
pub fn pdfedit_close(app: AppHandle, state: State<'_, PdfState>, id: u32) -> Result<(), String> {
    lock(&state)?.remove(&id);
    if let Ok(d) = work_dir(&app) {
        let _ = std::fs::remove_file(d.join(format!("{id}.pdf")));
    }
    Ok(())
}

#[tauri::command]
pub fn pdfedit_objects(state: State<'_, PdfState>, id: u32, page: u32) -> Result<Vec<ObjOut>, String> {
    let mut map = lock(&state)?;
    let s = session(&mut map, id)?;
    Ok(s.objects(page)?.iter().map(ObjOut::from).collect())
}

#[tauri::command]
pub fn pdfedit_apply(state: State<'_, PdfState>, id: u32, page: u32, ids: Vec<usize>, action: EditAction) -> Result<ApplyOut, String> {
    let edit = match action.kind.as_str() {
        "delete" => Edit::Delete,
        "transform" => {
            let m = action.matrix.ok_or("Matrice mancante")?;
            if m.iter().any(|v| !v.is_finite()) {
                return Err("Matrice non valida".into());
            }
            Edit::Transform(Mat(m))
        }
        other => return Err(format!("Azione sconosciuta: {other}")),
    };
    if ids.is_empty() {
        return Err("Nessun oggetto selezionato".into());
    }
    let mut map = lock(&state)?;
    let s = session(&mut map, id)?;
    let new_ids = s.apply(page, &ids, &edit)?;
    let objects = s.objects(page)?.iter().map(ObjOut::from).collect();
    Ok(ApplyOut { new_ids, objects })
}

#[derive(Serialize)]
pub struct UndoOut {
    /// Pagina da ridisegnare.
    page: Option<u32>,
    /// Elenco aggiornato delle pagine, se ne è cambiata la struttura.
    pages: Option<Vec<PageInfo>>,
}

impl From<UndoInfo> for UndoOut {
    fn from(u: UndoInfo) -> UndoOut {
        UndoOut { page: u.page, pages: u.pages }
    }
}

/// Annulla l'ultima modifica.
#[tauri::command]
pub fn pdfedit_undo(state: State<'_, PdfState>, id: u32) -> Result<Option<UndoOut>, String> {
    let mut map = lock(&state)?;
    Ok(session(&mut map, id)?.undo().map(UndoOut::from))
}

#[tauri::command]
pub fn pdfedit_redo(state: State<'_, PdfState>, id: u32) -> Result<Option<UndoOut>, String> {
    let mut map = lock(&state)?;
    Ok(session(&mut map, id)?.redo().map(UndoOut::from))
}

/// Ruota una pagina (`delta` = 90 o -90) e restituisce l'elenco aggiornato delle pagine.
#[tauri::command]
pub fn pdfedit_rotate_page(state: State<'_, PdfState>, id: u32, page: u32, delta: i64) -> Result<Vec<PageInfo>, String> {
    if delta % 90 != 0 {
        return Err("La rotazione dev'essere un multiplo di 90 gradi".into());
    }
    let mut map = lock(&state)?;
    let s = session(&mut map, id)?;
    s.rotate_page(page, delta)?;
    Ok(page_infos(&s.doc))
}

#[tauri::command]
pub fn pdfedit_delete_page(state: State<'_, PdfState>, id: u32, page: u32) -> Result<Vec<PageInfo>, String> {
    let mut map = lock(&state)?;
    let s = session(&mut map, id)?;
    s.delete_page(page)?;
    Ok(page_infos(&s.doc))
}

#[tauri::command]
pub fn pdfedit_move_page(state: State<'_, PdfState>, id: u32, from: u32, to: u32) -> Result<Vec<PageInfo>, String> {
    let mut map = lock(&state)?;
    let s = session(&mut map, id)?;
    s.move_page(from, to)?;
    Ok(page_infos(&s.doc))
}

#[tauri::command]
pub fn pdfedit_can_undo(state: State<'_, PdfState>, id: u32) -> Result<(bool, bool), String> {
    let mut map = lock(&state)?;
    let s = session(&mut map, id)?;
    Ok((!s.undo.is_empty(), !s.redo.is_empty()))
}

/// Aggiorna la copia di lavoro su disco (se serve) e ne restituisce il percorso.
fn refresh_work_copy(app: &AppHandle, state: &State<'_, PdfState>, id: u32) -> Result<PathBuf, String> {
    let path = work_dir(app)?.join(format!("{id}.pdf"));
    let mut map = lock(state)?;
    let s = session(&mut map, id)?;
    if s.work_dirty || !path.exists() {
        std::fs::write(&path, s.serialize()?).map_err(|e| format!("Impossibile preparare la pagina: {e}"))?;
        s.work_dirty = false;
    }
    Ok(path)
}

/// Disegna una pagina come immagine PNG.
pub fn render_png(work: &Path, scratch: &Path, page: u32, dpi: u32) -> Result<Vec<u8>, String> {
    let dpi = dpi.clamp(36, 400);
    // MuPDF scrive il PNG direttamente su stdout.
    let out = Command::new("mutool").args(["draw", "-o", "-", "-F", "png", "-r", &dpi.to_string()]).arg(work).arg((page + 1).to_string()).stdin(Stdio::null()).stderr(Stdio::null()).output();
    if let Ok(o) = &out {
        if o.status.success() && o.stdout.starts_with(b"\x89PNG") {
            return Ok(o.stdout.clone());
        }
    }
    // Ripiego: Poppler, che scrive su file.
    let prefix = scratch.join(format!("render-{}", std::process::id()));
    let status = Command::new("pdftoppm")
        .args(["-png", "-singlefile", "-r", &dpi.to_string(), "-f", &(page + 1).to_string(), "-l", &(page + 1).to_string()])
        .arg(work)
        .arg(&prefix)
        .stdin(Stdio::null())
        .stderr(Stdio::null())
        .status()
        .map_err(|_| "Per mostrare i PDF serve MuPDF o Poppler: installa «mupdf-tools» (sudo apt install mupdf-tools)".to_string())?;
    let png = prefix.with_extension("png");
    let bytes = std::fs::read(&png).map_err(|_| "Impossibile disegnare la pagina".to_string());
    let _ = std::fs::remove_file(&png);
    if !status.success() {
        return Err("Impossibile disegnare la pagina".into());
    }
    bytes
}

#[tauri::command]
pub async fn pdfedit_render(app: AppHandle, state: State<'_, PdfState>, id: u32, page: u32, dpi: u32) -> Result<Response, String> {
    let work = refresh_work_copy(&app, &state, id)?;
    let scratch = work_dir(&app)?;
    let png = tauri::async_runtime::spawn_blocking(move || render_png(&work, &scratch, page, dpi)).await.map_err(|e| e.to_string())??;
    Ok(Response::new(png))
}

/// Salva il PDF modificato (scrittura atomica).
#[tauri::command]
pub fn pdfedit_save(state: State<'_, PdfState>, id: u32, path: String) -> Result<(), String> {
    let bytes = {
        let mut map = lock(&state)?;
        session(&mut map, id)?.serialize()?
    };
    crate::workbook::write_atomically(Path::new(&path), &bytes)?;
    let mut map = lock(&state)?;
    session(&mut map, id)?.source = path;
    Ok(())
}

/// Testo di tutte le pagine (con le modifiche fatte), per estrarlo in un documento.
#[tauri::command]
pub async fn pdfedit_text(app: AppHandle, state: State<'_, PdfState>, id: u32) -> Result<Vec<String>, String> {
    let work = refresh_work_copy(&app, &state, id)?;
    tauri::async_runtime::spawn_blocking(move || {
        let out = Command::new("pdftotext").args(["-enc", "UTF-8"]).arg(&work).arg("-").stdin(Stdio::null()).output().map_err(|_| "Per estrarre il testo serve «poppler-utils»".to_string())?;
        let text = String::from_utf8_lossy(&out.stdout).into_owned();
        let mut pages: Vec<String> = text.split('\u{000C}').map(str::to_string).collect();
        if pages.len() > 1 && pages.last().is_some_and(|p| p.trim().is_empty()) {
            pages.pop();
        }
        Ok(pages)
    })
    .await
    .map_err(|e| e.to_string())?
}

// ---------- OCR ----------

#[derive(Serialize)]
pub struct OcrStatus {
    available: bool,
    languages: Vec<String>,
}

fn tesseract_languages() -> Option<Vec<String>> {
    let out = Command::new("tesseract").arg("--list-langs").stdin(Stdio::null()).output().ok()?;
    if !out.status.success() {
        return None;
    }
    // L'elenco esce su stdout (versioni recenti) o stderr (vecchie); la prima riga è un'intestazione.
    let text = format!("{}{}", String::from_utf8_lossy(&out.stdout), String::from_utf8_lossy(&out.stderr));
    Some(text.lines().skip(1).map(str::trim).filter(|l| !l.is_empty() && *l != "osd" && !l.contains(' ')).map(str::to_string).collect())
}

#[tauri::command]
pub async fn pdfedit_ocr_status() -> OcrStatus {
    tauri::async_runtime::spawn_blocking(|| match tesseract_languages() {
        Some(languages) => OcrStatus { available: true, languages },
        None => OcrStatus { available: false, languages: vec![] },
    })
    .await
    .unwrap_or(OcrStatus { available: false, languages: vec![] })
}

/// Parole di un output TSV di Tesseract (livello 5), con confidenza non negativa.
pub fn parse_tsv(tsv: &str) -> Vec<OcrWord> {
    tsv.lines()
        .skip(1)
        .filter_map(|line| {
            let f: Vec<&str> = line.split('\t').collect();
            if f.len() < 12 || f[0] != "5" {
                return None;
            }
            let conf: f64 = f[10].parse().ok()?;
            let text = f[11].trim();
            if conf < 0.0 || text.is_empty() {
                return None;
            }
            Some(OcrWord { text: text.to_string(), left: f[6].parse().ok()?, top: f[7].parse().ok()?, width: f[8].parse().ok()?, height: f[9].parse().ok()? })
        })
        .collect()
}

fn png_size(png: &[u8]) -> Option<(f64, f64)> {
    if png.len() < 24 || !png.starts_with(b"\x89PNG") {
        return None;
    }
    let w = u32::from_be_bytes([png[16], png[17], png[18], png[19]]);
    let h = u32::from_be_bytes([png[20], png[21], png[22], png[23]]);
    Some((f64::from(w), f64::from(h)))
}

/// Riconosce il testo di una pagina e lo aggiunge come strato invisibile. Restituisce le parole trovate.
#[tauri::command]
pub async fn pdfedit_ocr_page(app: AppHandle, state: State<'_, PdfState>, id: u32, page: u32, lang: String, dpi: u32) -> Result<usize, String> {
    if lang.is_empty() || !lang.chars().all(|c| c.is_ascii_alphanumeric() || c == '+' || c == '_') {
        return Err("Lingua non valida".into());
    }
    let dpi = dpi.clamp(150, 400);
    let work = refresh_work_copy(&app, &state, id)?;
    let scratch = work_dir(&app)?;
    let display_width = {
        let mut map = lock(&state)?;
        let s = session(&mut map, id)?;
        page_infos(&s.doc).get(page as usize).map(|p| p.width).ok_or("Pagina inesistente")?
    };
    let (words, scale) = tauri::async_runtime::spawn_blocking(move || -> Result<(Vec<OcrWord>, f64), String> {
        let png = render_png(&work, &scratch, page, dpi)?;
        let (w, _) = png_size(&png).ok_or("Immagine della pagina non valida")?;
        let mut child = Command::new("tesseract")
            .args(["stdin", "stdout", "-l", &lang, "--dpi", &dpi.to_string(), "--psm", "3", "tsv"])
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::piped())
            .spawn()
            .map_err(|_| "Tesseract non è installato. Per l'OCR esegui: sudo apt install tesseract-ocr tesseract-ocr-ita".to_string())?;
        let mut stdin = child.stdin.take().ok_or("Impossibile avviare Tesseract")?;
        // L'immagine va scritta in un thread a parte: Tesseract potrebbe riempire il buffer di uscita prima di averla letta tutta.
        let writer = std::thread::spawn(move || {
            let _ = stdin.write_all(&png);
        });
        let out = child.wait_with_output().map_err(|e| e.to_string())?;
        let _ = writer.join();
        if !out.status.success() {
            let err = String::from_utf8_lossy(&out.stderr);
            return Err(if err.contains("Failed loading language") || err.contains("Error opening data file") {
                format!("Lingua OCR non installata ({lang}). Esempio: sudo apt install tesseract-ocr-ita")
            } else {
                format!("Tesseract non è riuscito a leggere la pagina: {}", err.lines().last().unwrap_or(""))
            });
        }
        Ok((parse_tsv(&String::from_utf8_lossy(&out.stdout)), w / display_width))
    })
    .await
    .map_err(|e| e.to_string())??;
    let mut map = lock(&state)?;
    session(&mut map, id)?.add_text_layer(page, &words, scale)
}

#[cfg(test)]
mod tests {
    use super::*;

    /// Strumento di sviluppo: `DBG_PDF=file.pdf DBG_OUT=dati.json cargo test dump_objects -- --ignored`
    /// scrive pagine e oggetti di un PDF in JSON (per provare l'interfaccia con dati veri).
    #[test]
    #[ignore]
    fn dump_objects_json() {
        let (Some(pdf), Some(out)) = (std::env::var_os("DBG_PDF"), std::env::var_os("DBG_OUT")) else { return };
        let doc = Document::load(pdf).unwrap();
        let pages = page_infos(&doc);
        let s = Session::new(doc, String::new());
        let objects: Vec<Vec<ObjOut>> = (0..pages.len() as u32).map(|i| s.objects(i).unwrap().iter().map(ObjOut::from).collect()).collect();
        std::fs::write(out, serde_json::json!({ "pages": pages, "objects": objects }).to_string()).unwrap();
    }

    /// PDF protetto da password, creato con qpdf (il test si salta se qpdf non c'è).
    #[test]
    fn encrypted_pdfs_need_the_right_password_and_save_unprotected() {
        if Command::new("qpdf").arg("--version").output().is_err() {
            return;
        }
        let dir = std::env::temp_dir().join(format!("zikoffice-enc-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        let (plain, locked) = (dir.join("plain.pdf"), dir.join("locked.pdf"));
        crate::pdf_edit::tests_support::sample_document().save(&plain).unwrap();
        let ok = Command::new("qpdf").args(["--encrypt", "segreto", "padrone", "256", "--"]).arg(&plain).arg(&locked).status().unwrap();
        assert!(ok.success());

        assert_eq!(load_pdf(locked.to_str().unwrap(), None).unwrap_err(), "PASSWORD_REQUIRED");
        assert_eq!(load_pdf(locked.to_str().unwrap(), Some("sbagliata")).unwrap_err(), "Password errata");
        let doc = load_pdf(locked.to_str().unwrap(), Some("segreto")).unwrap();
        let mut s = Session::new(doc, String::new());
        let texts: Vec<_> = s.objects(0).unwrap().into_iter().filter_map(|f| f.text).collect();
        assert!(texts.contains(&"Hello".to_string()), "il testo va letto dopo la decifratura: {texts:?}");
        s.apply(0, &[s.objects(0).unwrap()[0].id], &Edit::Delete).unwrap();

        // Il file salvato è leggibile senza password e conserva la modifica
        let saved = dir.join("saved.pdf");
        std::fs::write(&saved, s.serialize().unwrap()).unwrap();
        let out = Command::new("pdftotext").arg(&saved).arg("-").output().unwrap();
        let text = String::from_utf8_lossy(&out.stdout);
        assert!(out.status.success() && text.contains("World"), "{text}");
        assert!(!text.contains("Hello"));
        std::fs::remove_dir_all(&dir).unwrap();
    }

    /// Simula l'OCR su scansioni (solo immagine) con la pagina ruotata di 0/90/180/270 gradi:
    /// le parole "riconosciute" (prese dal testo vero) devono finire dove stava il testo.
    /// `ZIKOFFICE_SCAN_FIXTURES=<cartella con orig.pdf e scan-*.pdf> cargo test -- --ignored`
    #[test]
    #[ignore]
    fn ocr_layer_lands_on_the_original_text_for_every_page_rotation() {
        let Some(dir) = std::env::var_os("ZIKOFFICE_SCAN_FIXTURES") else { return };
        let dir = PathBuf::from(dir);
        let orig = crate::pdf_edit::tests_support::poppler_words(&dir.join("orig.pdf"));
        assert!(orig.len() > 15);
        for rot in [0, 90, 180, 270] {
            let scan = dir.join(format!("scan-{rot}.pdf"));
            let mut s = Session::new(Document::load(&scan).unwrap(), String::new());
            let info = page_infos(&s.doc)[0].clone();
            assert_eq!(info.rotate, rot);
            assert!(s.objects(0).unwrap().iter().all(|f| f.kind != crate::pdf_edit::Kind::Text), "la scansione non deve avere testo");
            let png = render_png(&scan, &dir, 0, 150).unwrap();
            let (png_w, _) = png_size(&png).unwrap();
            let scale = png_w / info.width;
            let words: Vec<OcrWord> = orig.iter().map(|w| OcrWord { text: w.1.clone(), left: w.2 * scale, top: w.3 * scale, width: (w.4 - w.2) * scale, height: (w.5 - w.3) * scale }).collect();
            assert_eq!(s.add_text_layer(0, &words, scale).unwrap(), orig.len());
            let out = dir.join(format!("ocr-{rot}.pdf"));
            std::fs::write(&out, s.serialize().unwrap()).unwrap();
            let got = crate::pdf_edit::tests_support::poppler_words(&out);
            let mut worst = 0.0f64;
            for w in &orig {
                let Some(g) = got.iter().filter(|g| g.1 == w.1).min_by(|a, b| ((a.2 - w.2).abs() + (a.3 - w.3).abs()).total_cmp(&((b.2 - w.2).abs() + (b.3 - w.3).abs()))) else { panic!("rotazione {rot}: parola «{}» non trovata nel testo estratto", w.1) };
                let (dx0, dx1, dyc) = ((g.2 - w.2).abs(), (g.4 - w.4).abs(), (((g.3 + g.5) - (w.3 + w.5)) / 2.0).abs());
                worst = worst.max(dx0).max(dx1).max(dyc);
                assert!(dx0 < 2.0 && dx1 < 2.0 && dyc < 4.0, "rotazione {rot}: «{}» fuori posto (dx0 {dx0:.2}, dx1 {dx1:.2}, dy {dyc:.2})", w.1);
            }
            eprintln!("rotazione {rot:>3}: {} parole al loro posto, scarto massimo {worst:.2} pt", orig.len());
        }
    }

    #[test]
    fn parses_tesseract_tsv_words_only() {
        let tsv = "level\tpage_num\tblock_num\tpar_num\tline_num\tword_num\tleft\ttop\twidth\theight\tconf\ttext\n\
                   1\t1\t0\t0\t0\t0\t0\t0\t1240\t1754\t-1\t\n\
                   4\t1\t1\t1\t1\t0\t100\t200\t400\t40\t-1\t\n\
                   5\t1\t1\t1\t1\t1\t100\t200\t120\t40\t96.5\tCiao\n\
                   5\t1\t1\t1\t1\t2\t240\t200\t160\t40\t91.2\tperché\n\
                   5\t1\t1\t1\t1\t3\t420\t200\t10\t40\t-1\tvuota\n\
                   5\t1\t1\t1\t1\t4\t440\t200\t10\t40\t80\t  \n";
        let words = parse_tsv(tsv);
        assert_eq!(words.len(), 2);
        assert_eq!(words[1], OcrWord { text: "perché".into(), left: 240.0, top: 200.0, width: 160.0, height: 40.0 });
    }

    #[test]
    fn reads_png_dimensions() {
        let mut png = b"\x89PNG\r\n\x1a\n\x00\x00\x00\rIHDR".to_vec();
        png.extend(612u32.to_be_bytes());
        png.extend(792u32.to_be_bytes());
        assert_eq!(png_size(&png), Some((612.0, 792.0)));
        assert_eq!(png_size(b"nope"), None);
    }

    #[test]
    fn renders_a_real_page_when_mupdf_is_installed() {
        if Command::new("mutool").arg("-v").output().is_err() && Command::new("pdftoppm").arg("-v").output().is_err() {
            return; // nessun programma di disegno: il test non ha senso su questa macchina
        }
        let dir = std::env::temp_dir().join(format!("zikoffice-render-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        let mut doc = crate::pdf_edit::tests_support::sample_document();
        let pdf = dir.join("p.pdf");
        doc.save(&pdf).unwrap();
        let png = render_png(&pdf, &dir, 0, 72).unwrap();
        assert_eq!(png_size(&png), Some((612.0, 792.0)));
        std::fs::remove_dir_all(&dir).unwrap();
    }
}
