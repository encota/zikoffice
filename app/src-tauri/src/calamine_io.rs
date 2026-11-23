//! Lettura di fogli di calcolo .xls, .xlsb, .ods (e ripiego per .xlsx particolari)
//! tramite `calamine`, convertiti nel modello interno di IronCalc.

use std::path::Path;

use calamine::{Data, Reader, Sheets, open_workbook_auto, open_workbook_auto_from_rs};
use ironcalc::base::UserModel;

use crate::workbook::{LOCALE, TIMEZONE};

/// Converte una formula OpenFormula di LibreOffice Calc (es. `of:=SUM([.A1:.A2];[.B1])`)
/// nella sintassi Excel inglese accettata da IronCalc (`=SUM(A1:A2,B1)`).
fn normalize_formula(raw: &str, is_ods: bool) -> String {
    let mut s = raw.trim();
    if let Some(rest) = s.strip_prefix("of:") {
        s = rest.trim();
    }
    let body = s.strip_prefix('=').unwrap_or(s);
    if !is_ods {
        return format!("={body}");
    }
    // Rimuove le parentesi quadre dei riferimenti ODS: [.A1:.A2] -> A1:A2, [Foglio1.A1] -> Foglio1!A1
    let mut out = String::with_capacity(body.len() + 1);
    out.push('=');
    let mut chars = body.chars().peekable();
    let mut in_quotes = false;
    while let Some(ch) = chars.next() {
        if ch == '"' {
            in_quotes = !in_quotes;
            out.push(ch);
            continue;
        }
        if in_quotes {
            out.push(ch);
            continue;
        }
        if ch == '[' {
            let mut inner = String::new();
            for c in chars.by_ref() {
                if c == ']' {
                    break;
                }
                inner.push(c);
            }
            // Converte `.A1:.A2` -> `A1:A2` e `Foglio1.A1` -> `Foglio1!A1`
            for (i, part) in inner.split(':').enumerate() {
                if i > 0 {
                    out.push(':');
                }
                if let Some(cell) = part.strip_prefix('.') {
                    out.push_str(cell);
                } else if let Some(dot) = part.rfind('.') {
                    out.push_str(&part[..dot]);
                    out.push('!');
                    out.push_str(&part[dot + 1..]);
                } else {
                    out.push_str(part);
                }
            }
        } else if ch == ';' {
            out.push(',');
        } else {
            out.push(ch);
        }
    }
    out
}

fn format_data_input(cell: &Data) -> Option<String> {
    match cell {
        Data::Empty => None,
        Data::Int(n) => Some(n.to_string()),
        Data::Float(f) => {
            if f.is_finite() {
                Some(f.to_string())
            } else {
                None
            }
        }
        Data::Bool(b) => Some(if *b { "TRUE".into() } else { "FALSE".into() }),
        Data::String(s) => {
            if s.is_empty() {
                None
            } else if s.starts_with('=') {
                Some(format!("'{s}"))
            } else {
                Some(s.clone())
            }
        }
        Data::DateTime(dt) => {
            let serial = dt.as_f64();
            if serial.is_finite() {
                Some(serial.to_string())
            } else {
                None
            }
        }
        Data::DateTimeIso(s) | Data::DurationIso(s) => {
            if s.is_empty() { None } else { Some(s.clone()) }
        }
        Data::Error(e) => Some(e.to_string()),
    }
}

/// Apre un file .xls, .xlsb, .ods o .xlsx con calamine e lo converte nei byte IronCalc.
pub fn read_with_calamine(path: &str) -> Result<Vec<u8>, String> {
    let wb = open_workbook_auto(path).map_err(|e| format!("Impossibile aprire il file: {e}"))?;
    let is_ods = Path::new(path)
        .extension()
        .and_then(|e| e.to_str())
        .is_some_and(|e| e.eq_ignore_ascii_case("ods"));
    let name = Path::new(path)
        .file_stem()
        .map(|s| s.to_string_lossy().into_owned())
        .unwrap_or_else(|| "Cartella".into());
    convert(wb, &name, is_ods)
}

/// Come `read_with_calamine`, ma da dati già in memoria (nessun file temporaneo sul disco).
pub fn read_with_calamine_bytes(bytes: &[u8], name: &str) -> Result<Vec<u8>, String> {
    let wb = open_workbook_auto_from_rs(std::io::Cursor::new(bytes))
        .map_err(|e| format!("Impossibile aprire il file: {e}"))?;
    convert(wb, name, false)
}

fn convert<RS: std::io::Read + std::io::Seek>(mut wb: Sheets<RS>, workbook_name: &str, is_ods: bool) -> Result<Vec<u8>, String> {
    let sheet_names = wb.sheet_names();
    if sheet_names.is_empty() {
        return Err("La cartella di lavoro non contiene alcun foglio".into());
    }
    // Usiamo locale/lingua "en" in fase di caricamento così numeri decimali (`.`)
    // e formule Excel (`=SUM(A1:A2)`) vengono interpretati correttamente, poi passiamo a "it".
    let mut model = UserModel::new_empty(workbook_name, "en", TIMEZONE, "en")?;
    model.pause_evaluation();

    for (idx, sheet_name) in sheet_names.iter().enumerate() {
        let sheet_idx = idx as u32;
        if idx > 0 {
            model.new_sheet()?;
        }
        let _ = model.rename_sheet(sheet_idx, sheet_name);

        let formulas = wb.worksheet_formula(sheet_name).ok();
        let range = match wb.worksheet_range(sheet_name) {
            Ok(r) => r,
            Err(_) => continue,
        };

        let (start_r, start_c) = range.start().unwrap_or((0, 0));
        let (rows, cols) = range.get_size();
        for dr in 0..rows {
            let r0 = start_r as usize + dr;
            if r0 >= 1_048_576 {
                break;
            }
            let r1 = (r0 + 1) as i32;
            for dc in 0..cols {
                let c0 = start_c as usize + dc;
                if c0 >= 16_384 {
                    break;
                }
                let c1 = (c0 + 1) as i32;

                // Se c'è una formula valida la importiamo; se IronCalc non la riconosce, ripieghiamo sul valore salvato.
                let mut written = false;
                if let Some(ref f_range) = formulas {
                    if let Some(f) = f_range.get_value((r0 as u32, c0 as u32)) {
                        let trimmed = f.trim();
                        if !trimmed.is_empty() {
                            let norm = normalize_formula(trimmed, is_ods);
                            if model.set_user_input(sheet_idx, r1, c1, &norm).is_ok() {
                                written = true;
                            }
                        }
                    }
                }
                if !written {
                    if let Some(cell) = range.get((dr, dc)) {
                        if let Some(val) = format_data_input(cell) {
                            let _ = model.set_user_input(sheet_idx, r1, c1, &val);
                        }
                    }
                }
            }
        }
    }

    let _ = model.set_locale(LOCALE);
    model.resume_evaluation();
    model.evaluate();
    Ok(model.get_model().to_bytes())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn normalizes_ods_openformula() {
        assert_eq!(normalize_formula("of:=SUM([.A1:.A3])", true), "=SUM(A1:A3)");
        assert_eq!(normalize_formula("of:=IF([.A1]>0;[.B1];0)", true), "=IF(A1>0,B1,0)");
        assert_eq!(normalize_formula("=SUM([Foglio1.A1:.A2])", true), "=SUM(Foglio1!A1:A2)");
        assert_eq!(normalize_formula("SUM(A1:A2)", false), "=SUM(A1:A2)");
    }
}
