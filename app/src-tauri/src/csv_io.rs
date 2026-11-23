//! File CSV: lettura (con riconoscimento di separatore e codifica) e scrittura.
//!
//! In Italia Excel usa il punto e virgola come separatore, perché la virgola è il
//! separatore decimale; i file vecchi sono spesso in Windows-1252 invece che UTF-8.

use ironcalc::base::{Model, UserModel};

use crate::workbook::{LANGUAGE, LOCALE, TIMEZONE};

/// Decodifica i byte: UTF-8 (con o senza BOM), altrimenti Windows-1252.
pub fn decode(bytes: &[u8]) -> String {
    let bytes = bytes.strip_prefix(b"\xEF\xBB\xBF").unwrap_or(bytes);
    match std::str::from_utf8(bytes) {
        Ok(s) => s.to_owned(),
        Err(_) => bytes.iter().map(|&b| cp1252(b)).collect(),
    }
}

fn cp1252(b: u8) -> char {
    const HIGH: [char; 32] = [
        '€', '\u{81}', '‚', 'ƒ', '„', '…', '†', '‡', 'ˆ', '‰', 'Š', '‹', 'Œ', '\u{8D}', 'Ž', '\u{8F}',
        '\u{90}', '‘', '’', '“', '”', '•', '–', '—', '˜', '™', 'š', '›', 'œ', '\u{9D}', 'ž', 'Ÿ',
    ];
    if (0x80..0xA0).contains(&b) { HIGH[(b - 0x80) as usize] } else { b as char }
}

/// Sceglie il separatore più frequente (fuori dalle virgolette) nelle prime righe.
pub fn sniff_delimiter(text: &str) -> u8 {
    let mut counts = [(b';', 0usize), (b',', 0), (b'\t', 0), (b'|', 0)];
    let mut in_quotes = false;
    for (lines, ch) in text.chars().scan(0usize, |n, ch| { if ch == '\n' { *n += 1; } Some((*n, ch)) }) {
        if lines >= 20 { break; }
        if ch == '"' { in_quotes = !in_quotes; continue; }
        if in_quotes { continue; }
        for (d, n) in counts.iter_mut() {
            if ch as u32 == *d as u32 { *n += 1; }
        }
    }
    counts.iter().max_by_key(|(_, n)| *n).filter(|(_, n)| *n > 0).map(|(d, _)| *d).unwrap_or(b';')
}

/// Crea una cartella di lavoro dal contenuto di un CSV.
pub fn read_csv(bytes: &[u8], name: &str) -> Result<Vec<u8>, String> {
    let text = decode(bytes);
    let delimiter = sniff_delimiter(&text);
    let mut reader = csv::ReaderBuilder::new()
        .delimiter(delimiter)
        .has_headers(false)
        .flexible(true)
        .from_reader(text.as_bytes());
    let mut model = UserModel::new_empty(name, LOCALE, TIMEZONE, LANGUAGE)?;
    model.pause_evaluation();
    for (r, record) in reader.records().enumerate() {
        let record = record.map_err(|e| format!("CSV non valido alla riga {}: {e}", r + 1))?;
        if r >= 1_048_576 { return Err("Il file ha più di 1.048.576 righe".into()); }
        for (c, value) in record.iter().enumerate() {
            if c >= 16_384 || value.is_empty() { continue; }
            model.set_user_input(0, r as i32 + 1, c as i32 + 1, value)?;
        }
    }
    model.resume_evaluation();
    model.evaluate();
    // Ricreiamo il modello dai dati, così la cronologia di Annulla parte vuota.
    Ok(model.get_model().to_bytes())
}

/// Scrive i valori mostrati di un foglio come CSV (separatore ";" e BOM, come Excel in italiano).
pub fn write_csv(model: &Model, sheet: u32) -> Result<Vec<u8>, String> {
    let ws = model.workbook.worksheet(sheet)?;
    let dim = ws.dimension();
    let mut writer = csv::WriterBuilder::new().delimiter(b';').terminator(csv::Terminator::CRLF).from_writer(Vec::new());
    if !ws.sheet_data.is_empty() {
        for r in 1..=dim.max_row {
            let row: Vec<String> = (1..=dim.max_column)
                .map(|c| model.get_formatted_cell_value(sheet, r, c).unwrap_or_default())
                .collect();
            writer.write_record(&row).map_err(|e| e.to_string())?;
        }
    }
    let mut out = b"\xEF\xBB\xBF".to_vec();
    out.extend(writer.into_inner().map_err(|e| e.to_string())?);
    Ok(out)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn decodes_windows_1252_and_bom() {
        assert_eq!(decode(b"\xEF\xBB\xBFcaff\xC3\xA8"), "caffè");
        assert_eq!(decode(b"caff\xE8 \x80"), "caffè €");
    }

    #[test]
    fn sniffs_italian_and_english_delimiters() {
        assert_eq!(sniff_delimiter("nome;prezzo\nmela;1,5\n"), b';');
        assert_eq!(sniff_delimiter("name,price\napple,1.5\n"), b',');
        assert_eq!(sniff_delimiter("a\tb\n1\t2\n"), b'\t');
        assert_eq!(sniff_delimiter("\"a;b\",c,d\n"), b',');
    }

    #[test]
    fn reads_italian_csv_and_writes_it_back() {
        let bytes = read_csv("Prodotto;Prezzo\r\nMele;1,5\r\n\"Pere; Abate\";2\r\nTotale;=SOMMA(B2:B3)\r\n".as_bytes(), "prova").unwrap();
        let mut model = Model::from_bytes(&bytes, LANGUAGE).unwrap();
        model.evaluate();
        assert_eq!(model.get_formatted_cell_value(0, 3, 1).unwrap(), "Pere; Abate");
        assert_eq!(model.get_formatted_cell_value(0, 4, 2).unwrap(), "3,5");
        let out = String::from_utf8(write_csv(&model, 0).unwrap()).unwrap();
        assert_eq!(out, "\u{feff}Prodotto;Prezzo\r\nMele;1,5\r\n\"Pere; Abate\";2\r\nTotale;3,5\r\n");
    }
}
