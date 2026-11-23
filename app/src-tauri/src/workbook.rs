//! Apertura e salvataggio delle cartelle di lavoro (.xlsx, .csv).

use std::fs::{self, File};
use std::io::{Cursor, Read, Write};
use std::path::{Path, PathBuf};

use ironcalc::base::Model;
use ironcalc::export::save_xlsx_to_writer;
use ironcalc::import::{load_from_xlsx, load_from_xlsx_bytes};
use tauri::ipc::{InvokeBody, Request, Response};

const EXTRAS_ENTRY: &str = "zikoffice/extras.json";

/// Impostazioni regionali: formule in italiano (SOMMA, SE…), virgola decimale.
pub const LOCALE: &str = "it";
pub const LANGUAGE: &str = "it";
pub const TIMEZONE: &str = "Europe/Rome";

fn extension(path: &str) -> Option<String> {
    Path::new(path).extension().and_then(|e| e.to_str()).map(str::to_ascii_lowercase)
}

/// Legge un file (.xlsx, .xlsm, .xls, .xlsb, .ods, .csv, .tsv) e restituisce la cartella nel formato interno di IronCalc.
/// Supporta anche file .xlsx/.xlsm protetti da password.
#[tauri::command]
pub fn open_workbook(path: String, password: Option<String>) -> Result<Response, String> {
    match extension(&path).as_deref() {
        Some("xlsx") | Some("xlsm") => {
            let raw = fs::read(&path).map_err(|e| format!("Impossibile leggere il file: {e}"))?;
            if crate::pdf_import::is_ole2(&raw) {
                let Some(pw) = password else {
                    return Err("PASSWORD_REQUIRED".into());
                };
                let plain = office_crypto::decrypt_from_bytes(raw, &pw)
                    .map_err(|_| "Password errata o file protetto non supportato".to_string())?;
                // Tutto in memoria: il contenuto in chiaro non tocca mai il disco.
                let name = Path::new(&path).file_stem().map(|s| s.to_string_lossy().into_owned()).unwrap_or_default();
                let bytes = match load_from_xlsx_bytes(&plain, &name, LOCALE, TIMEZONE)
                    .map_err(|e| e.to_string())
                    .and_then(|wb| Model::from_workbook(wb, LANGUAGE))
                {
                    Ok(mut m) => { m.evaluate(); m.to_bytes() }
                    Err(_) => crate::calamine_io::read_with_calamine_bytes(&plain, &name)?,
                };
                return Ok(Response::new(bytes));
            }
            match load_from_xlsx(&path, LOCALE, TIMEZONE, LANGUAGE) {
                Ok(mut model) => {
                    // Molti programmi non salvano i risultati delle formule: ricalcoliamo tutto all'apertura.
                    model.evaluate();
                    Ok(Response::new(model.to_bytes()))
                }
                Err(_) => {
                    // Ripiego su calamine per file .xlsx/.xlsm con caratteristiche non standard.
                    Ok(Response::new(crate::calamine_io::read_with_calamine(&path)?))
                }
            }
        }
        Some("xls") | Some("xlsb") | Some("ods") => {
            Ok(Response::new(crate::calamine_io::read_with_calamine(&path)?))
        }
        Some("csv") | Some("tsv") | Some("txt") => {
            let bytes = fs::read(&path).map_err(|e| format!("Impossibile leggere il file: {e}"))?;
            let name = Path::new(&path).file_stem().map(|s| s.to_string_lossy().into_owned()).unwrap_or_default();
            Ok(Response::new(crate::csv_io::read_csv(&bytes, &name)?))
        }
        _ => Err("Formato non supportato: si possono aprire file .xlsx, .xlsm, .xls, .xlsb, .ods, .csv e .tsv".into()),
    }
}

/// Legge i metadati extra di ZikOffice (grafici, formattazione condizionale, convalida, note) da un .xlsx.
#[tauri::command]
pub fn read_xlsx_extras(path: String) -> Result<Option<String>, String> {
    let Ok(file) = File::open(&path) else { return Ok(None) };
    let Ok(mut archive) = zip::ZipArchive::new(file) else { return Ok(None) };
    let Ok(mut entry) = archive.by_name(EXTRAS_ENTRY) else { return Ok(None) };
    let mut s = String::new();
    entry.read_to_string(&mut s).map_err(|e| e.to_string())?;
    Ok(Some(s))
}

/// Excel pretende che ogni parte del pacchetto abbia un tipo dichiarato in `[Content_Types].xml`:
/// senza, segnala il file come danneggiato. Aggiunge `Default Extension="json"` se manca.
fn declare_json_type(xml: &[u8]) -> Vec<u8> {
    let text = String::from_utf8_lossy(xml);
    if text.contains("Extension=\"json\"") {
        return xml.to_vec();
    }
    match text.find("<Default ") {
        Some(i) => format!("{}<Default Extension=\"json\" ContentType=\"application/json\"/>{}", &text[..i], &text[i..]).into_bytes(),
        None => xml.to_vec(),
    }
}

/// Incorpora `zikoffice/extras.json` dentro lo ZIP di un file .xlsx appena salvato (ignorato da Excel/LibreOffice).
fn embed_extras_in_xlsx(xlsx_bytes: Vec<u8>, extras_json: &str) -> Result<Vec<u8>, String> {
    let mut reader = zip::ZipArchive::new(Cursor::new(xlsx_bytes)).map_err(|e| e.to_string())?;
    let mut out = Cursor::new(Vec::new());
    {
        let mut writer = zip::ZipWriter::new(&mut out);
        for i in 0..reader.len() {
            let mut file = reader.by_index(i).map_err(|e| e.to_string())?;
            let name = file.name().map_err(|e| e.to_string())?.into_owned();
            if name == EXTRAS_ENTRY {
                continue;
            }
            let content_types = name == "[Content_Types].xml";
            let opts = zip::write::SimpleFileOptions::default().compression_method(file.compression());
            writer.start_file(name, opts).map_err(|e| e.to_string())?;
            let mut buf = Vec::new();
            file.read_to_end(&mut buf).map_err(|e| e.to_string())?;
            if content_types {
                buf = declare_json_type(&buf);
            }
            writer.write_all(&buf).map_err(|e| e.to_string())?;
        }
        let opts = zip::write::SimpleFileOptions::default().compression_method(zip::CompressionMethod::Deflated);
        writer.start_file(EXTRAS_ENTRY, opts).map_err(|e| e.to_string())?;
        writer.write_all(extras_json.as_bytes()).map_err(|e| e.to_string())?;
        writer.finish().map_err(|e| e.to_string())?;
    }
    Ok(out.into_inner())
}

/// Salva la cartella ricevuta dall'interfaccia come .xlsx o .csv.
/// Il percorso arriva nell'header `path` (codificato come URI), i dati nel corpo;
/// per il CSV l'header `sheet` indica quale foglio salvare; per .xlsx `extras` (opzionale)
/// contiene grafici, formattazione condizionale, convalida e note in JSON codificato URI.
#[tauri::command]
pub fn save_workbook(request: Request<'_>) -> Result<(), String> {
    let header = |name: &str| request.headers().get(name).and_then(|v| v.to_str().ok());
    let path = header("path").map(percent_decode).ok_or("Percorso del file mancante")??;
    let InvokeBody::Raw(body) = request.body() else {
        return Err("Dati della cartella mancanti".into());
    };
    // Con l'header `framing: extras` il corpo è [lunghezza u32][JSON dei dati extra][cartella]:
    // i dati extra possono essere grandi e nelle intestazioni HTTP non ci stanno.
    let (extras, bytes) = if header("framing") == Some("extras") { split_framed(body)? } else { (None, &body[..]) };
    let model = Model::from_bytes(bytes, LANGUAGE)?;
    if extension(&path).as_deref() == Some("csv") {
        let sheet = header("sheet").and_then(|s| s.parse().ok()).unwrap_or(0);
        return write_atomically(Path::new(&path), &crate::csv_io::write_csv(&model, sheet)?);
    }
    if extension(&path).as_deref() == Some("ods") {
        return write_atomically(Path::new(&path), &crate::ods_export::write_ods(&model)?);
    }
    write_xlsx_atomically(&model, Path::new(&path), extras)
}

/// Separa il corpo `[lunghezza u32 LE][extras UTF-8][cartella]`.
fn split_framed(body: &[u8]) -> Result<(Option<&str>, &[u8]), String> {
    let len = body.get(..4).map(|b| u32::from_le_bytes([b[0], b[1], b[2], b[3]]) as usize).ok_or("Dati non validi")?;
    let extras = body.get(4..4 + len).ok_or("Dati non validi")?;
    let extras = std::str::from_utf8(extras).map_err(|_| "Dati extra non validi")?;
    Ok((Some(extras).filter(|s| !s.is_empty()), &body[4 + len..]))
}

fn write_xlsx_atomically(model: &Model, target: &Path, extras: Option<&str>) -> Result<(), String> {
    let cursor = save_xlsx_to_writer(model, Cursor::new(Vec::new()))
        .map_err(|e| format!("Errore durante il salvataggio: {e}"))?;
    let mut bytes = cursor.into_inner();
    if let Some(json) = extras.filter(|s| !s.is_empty()) {
        bytes = embed_extras_in_xlsx(bytes, json)?;
    }
    write_atomically(target, &bytes)
}

/// Scrive prima in un file temporaneo accanto alla destinazione e poi lo rinomina:
/// se qualcosa va storto a metà, il file originale resta intatto.
pub fn write_atomically(target: &Path, data: &[u8]) -> Result<(), String> {
    let dir = target.parent().filter(|p| !p.as_os_str().is_empty()).unwrap_or(Path::new("."));
    let file_name = target.file_name().ok_or("Nome del file non valido")?;
    let tmp: PathBuf = dir.join(format!(".{}.zikoffice-tmp", file_name.to_string_lossy()));

    let result = (|| -> Result<(), String> {
        let mut file = File::create(&tmp).map_err(|e| format!("Impossibile scrivere il file: {e}"))?;
        file.write_all(data).map_err(|e| format!("Errore durante il salvataggio: {e}"))?;
        file.sync_all().map_err(|e| format!("Errore durante il salvataggio: {e}"))?;
        fs::rename(&tmp, target).map_err(|e| format!("Impossibile sostituire il file: {e}"))
    })();
    if result.is_err() {
        let _ = fs::remove_file(&tmp);
    }
    result
}

/// File passati da riga di comando (es. doppio clic su un .xlsx nel file manager).
#[tauri::command]
pub fn startup_files() -> Vec<String> {
    std::env::args()
        .skip(1)
        .filter(|a| !a.starts_with('-'))
        .filter_map(|a| fs::canonicalize(&a).ok())
        .filter(|p| p.is_file())
        .map(|p| p.to_string_lossy().into_owned())
        .collect()
}

/// Decodifica una stringa prodotta da `encodeURIComponent`.
pub fn percent_decode(s: &str) -> Result<String, String> {
    let bytes = s.as_bytes();
    let mut out = Vec::with_capacity(bytes.len());
    let mut i = 0;
    while i < bytes.len() {
        if bytes[i] == b'%' {
            let hex = s.get(i + 1..i + 3).ok_or("Percorso non valido")?;
            out.push(u8::from_str_radix(hex, 16).map_err(|_| "Percorso non valido")?);
            i += 3;
        } else {
            out.push(bytes[i]);
            i += 1;
        }
    }
    String::from_utf8(out).map_err(|_| "Percorso non valido".into())
}

#[cfg(test)]
mod tests {
    use super::*;
    use ironcalc::base::UserModel;

    #[test]
    fn decodes_uri_components() {
        assert_eq!(percent_decode("%2Fhome%2Fio%2FBilancio%202026.xlsx").unwrap(), "/home/io/Bilancio 2026.xlsx");
        assert_eq!(percent_decode("caf%C3%A8").unwrap(), "cafè");
        assert!(percent_decode("%G1").is_err());
    }

    #[test]
    fn save_then_open_keeps_values_and_formulas() {
        let dir = std::env::temp_dir().join(format!("zikoffice-test-{}", std::process::id()));
        fs::create_dir_all(&dir).unwrap();
        let path = dir.join("prova.xlsx");

        let mut m = UserModel::new_empty("prova", LOCALE, TIMEZONE, LANGUAGE).unwrap();
        m.set_user_input(0, 1, 1, "1,5").unwrap();
        m.set_user_input(0, 2, 1, "2").unwrap();
        m.set_user_input(0, 3, 1, "=SOMMA(A1:A2)").unwrap();
        m.evaluate();
        let model = Model::from_bytes(&m.to_bytes(), LANGUAGE).unwrap();

        // Salvare due volte sullo stesso file deve funzionare (sovrascrittura), anche con extras JSON.
        let extras = r#"{"charts":[{"id":1}],"notes":{"0:1:1":"Nota"}}"#;
        write_xlsx_atomically(&model, &path, Some(extras)).unwrap();
        write_xlsx_atomically(&model, &path, Some(extras)).unwrap();

        assert!(open_workbook(path.to_string_lossy().into_owned(), None).is_ok());
        assert_eq!(read_xlsx_extras(path.to_string_lossy().into_owned()).unwrap().as_deref(), Some(extras));
        let back = UserModel::from_model(
            load_from_xlsx(&path.to_string_lossy(), LOCALE, TIMEZONE, LANGUAGE).unwrap(),
        );
        assert_eq!(back.get_formatted_cell_value(0, 3, 1).unwrap(), "3,5");
        assert_eq!(back.get_cell_content(0, 3, 1).unwrap(), "=SOMMA(A1:A2)");
        fs::remove_dir_all(&dir).unwrap();
    }

    /// Simula la chiamata dell'interfaccia: `invoke("save_workbook", bytes, { headers: { path } })`
    /// e poi `invoke("open_workbook", { path })`, passando dal vero sistema IPC di Tauri.
    #[test]
    fn save_and_open_through_tauri_ipc() {
        use tauri::ipc::{CallbackFn, InvokeBody};
        use tauri::test::{INVOKE_KEY, get_ipc_response, mock_builder, mock_context, noop_assets};
        use tauri::webview::InvokeRequest;

        let app = mock_builder()
            .invoke_handler(tauri::generate_handler![open_workbook, save_workbook])
            .build(mock_context(noop_assets()))
            .unwrap();
        let webview = tauri::WebviewWindowBuilder::new(&app, "main", Default::default()).build().unwrap();
        let request = |cmd: &str, body: InvokeBody, headers: tauri::http::HeaderMap| InvokeRequest {
            cmd: cmd.into(),
            callback: CallbackFn(0),
            error: CallbackFn(1),
            url: "tauri://localhost".parse().unwrap(),
            body,
            headers,
            invoke_key: INVOKE_KEY.to_string(),
        };

        let dir = std::env::temp_dir().join(format!("zikoffice-ipc-{}", std::process::id()));
        fs::create_dir_all(&dir).unwrap();
        // Percorso con spazi e lettere accentate, codificato come fa encodeURIComponent.
        let path = dir.join("Spese di casa è.xlsx");
        let encoded: String = path.to_string_lossy().bytes().map(|b| {
            if b.is_ascii_alphanumeric() || b"-_.!~*'()".contains(&b) { (b as char).to_string() } else { format!("%{b:02X}") }
        }).collect();

        let mut m = UserModel::new_empty("prova", LOCALE, TIMEZONE, LANGUAGE).unwrap();
        m.set_user_input(0, 1, 1, "=6*7").unwrap();
        m.evaluate();

        let mut headers = tauri::http::HeaderMap::new();
        headers.insert("path", encoded.parse().unwrap());
        get_ipc_response(&webview, request("save_workbook", InvokeBody::Raw(m.to_bytes()), headers)).expect("salvataggio via IPC");
        assert!(path.exists());

        let body = InvokeBody::Json(serde_json::json!({ "path": path.to_string_lossy() }));
        let response = get_ipc_response(&webview, request("open_workbook", body, Default::default())).expect("apertura via IPC");
        let tauri::ipc::InvokeResponseBody::Raw(bytes) = response else { panic!("attesi dati binari") };
        let back = UserModel::from_bytes(&bytes, LANGUAGE).unwrap();
        assert_eq!(back.get_formatted_cell_value(0, 1, 1).unwrap(), "42");
        fs::remove_dir_all(&dir).unwrap();
    }

    #[test]
    fn extras_declare_their_content_type_for_excel() {
        let mut m = UserModel::new_empty("p", LOCALE, TIMEZONE, LANGUAGE).unwrap();
        m.set_user_input(0, 1, 1, "1").unwrap();
        let model = Model::from_bytes(&m.to_bytes(), LANGUAGE).unwrap();
        let plain = save_xlsx_to_writer(&model, Cursor::new(Vec::new())).unwrap().into_inner();
        let with = embed_extras_in_xlsx(plain, "{\"a\":1}").unwrap();
        let mut zip = zip::ZipArchive::new(Cursor::new(with)).unwrap();
        let mut ct = String::new();
        zip.by_name("[Content_Types].xml").unwrap().read_to_string(&mut ct).unwrap();
        assert!(ct.contains("Extension=\"json\""), "{ct}");
        assert_eq!(ct.matches("Extension=\"json\"").count(), 1);
        // Un secondo salvataggio non duplica la dichiarazione.
        let again = embed_extras_in_xlsx(zip_bytes(&mut zip), "{\"a\":2}").unwrap();
        let mut zip2 = zip::ZipArchive::new(Cursor::new(again)).unwrap();
        let mut ct2 = String::new();
        zip2.by_name("[Content_Types].xml").unwrap().read_to_string(&mut ct2).unwrap();
        assert_eq!(ct2.matches("Extension=\"json\"").count(), 1);
    }

    fn zip_bytes(zip: &mut zip::ZipArchive<Cursor<Vec<u8>>>) -> Vec<u8> {
        let mut out = Cursor::new(Vec::new());
        {
            let mut w = zip::ZipWriter::new(&mut out);
            for i in 0..zip.len() {
                let mut f = zip.by_index(i).unwrap();
                w.start_file(f.name().unwrap().into_owned(), zip::write::SimpleFileOptions::default()).unwrap();
                let mut b = Vec::new();
                f.read_to_end(&mut b).unwrap();
                w.write_all(&b).unwrap();
            }
            w.finish().unwrap();
        }
        out.into_inner()
    }

    #[test]
    fn framed_body_carries_large_extras() {
        let big = "x".repeat(300_000); // molto oltre i limiti delle intestazioni HTTP
        let mut body = (big.len() as u32).to_le_bytes().to_vec();
        body.extend(big.as_bytes());
        body.extend([1, 2, 3]);
        let (extras, rest) = split_framed(&body).unwrap();
        assert_eq!(extras.unwrap().len(), 300_000);
        assert_eq!(rest, &[1, 2, 3]);
        assert!(split_framed(&[9, 9]).is_err());
        assert!(split_framed(&[255, 255, 255, 255, 1]).is_err());
    }

    #[test]
    fn rejects_unsupported_formats() {
        assert!(open_workbook("/tmp/x.numbers".into(), None).is_err());
        assert!(open_workbook("/tmp/x.unknown".into(), None).is_err());
    }
}
