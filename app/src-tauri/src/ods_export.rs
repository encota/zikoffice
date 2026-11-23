//! Esportazione nativa di cartelle di lavoro in formato .ods (OpenDocument Spreadsheet),
//! compatibile con LibreOffice Calc ed Excel.

use std::io::{Cursor, Write};

use ironcalc::base::Model;
use zip::{CompressionMethod, ZipWriter, write::SimpleFileOptions};

fn esc(s: &str) -> String {
    s.replace('&', "&amp;")
        .replace('<', "&lt;")
        .replace('>', "&gt;")
        .replace('"', "&quot;")
}

/// Esporta l'intera cartella di lavoro (tutti i fogli) in byte .ods validi.
pub fn write_ods(model: &Model) -> Result<Vec<u8>, String> {
    let mut sheets_xml = String::new();
    let count = model.workbook.worksheets.len() as u32;
    for sheet in 0..count {
        let ws = model.workbook.worksheet(sheet)?;
        let dim = ws.dimension();
        sheets_xml.push_str(&format!(r#"<table:table table:name="{}">"#, esc(&ws.name)));
        if !ws.sheet_data.is_empty() {
            for r in 1..=dim.max_row {
                sheets_xml.push_str("<table:table-row>");
                for c in 1..=dim.max_column {
                    let display = model.get_formatted_cell_value(sheet, r, c).unwrap_or_default();
                    if display.is_empty() {
                        sheets_xml.push_str("<table:table-cell/>");
                        continue;
                    }
                    let cleaned = display.replace(['€', '$', '£', ' '], "").replace(',', ".");
                    if let Ok(v) = cleaned.parse::<f64>() {
                        sheets_xml.push_str(&format!(
                            r#"<table:table-cell office:value-type="float" office:value="{v}"><text:p>{}</text:p></table:table-cell>"#,
                            esc(&display)
                        ));
                    } else if display.eq_ignore_ascii_case("vero") || display.eq_ignore_ascii_case("true") {
                        sheets_xml.push_str(&format!(
                            r#"<table:table-cell office:value-type="boolean" office:boolean-value="true"><text:p>{}</text:p></table:table-cell>"#,
                            esc(&display)
                        ));
                    } else if display.eq_ignore_ascii_case("falso") || display.eq_ignore_ascii_case("false") {
                        sheets_xml.push_str(&format!(
                            r#"<table:table-cell office:value-type="boolean" office:boolean-value="false"><text:p>{}</text:p></table:table-cell>"#,
                            esc(&display)
                        ));
                    } else {
                        sheets_xml.push_str(&format!(
                            r#"<table:table-cell office:value-type="string"><text:p>{}</text:p></table:table-cell>"#,
                            esc(&display)
                        ));
                    }
                }
                sheets_xml.push_str("</table:table-row>");
            }
        } else {
            sheets_xml.push_str("<table:table-row><table:table-cell/></table:table-row>");
        }
        sheets_xml.push_str("</table:table>");
    }

    let content_xml = format!(
        r#"<?xml version="1.0" encoding="UTF-8"?>
<office:document-content xmlns:office="urn:oasis:names:tc:opendocument:xmlns:office:1.0" xmlns:table="urn:oasis:names:tc:opendocument:xmlns:table:1.0" xmlns:text="urn:oasis:names:tc:opendocument:xmlns:text:1.0" office:version="1.2">
<office:body><office:spreadsheet>{sheets_xml}</office:spreadsheet></office:body>
</office:document-content>"#
    );
    let manifest_xml = r#"<?xml version="1.0" encoding="UTF-8"?>
<manifest:manifest xmlns:manifest="urn:oasis:names:tc:opendocument:xmlns:manifest:1.0" manifest:version="1.2">
<manifest:file-entry manifest:full-path="/" manifest:media-type="application/vnd.oasis.opendocument.spreadsheet"/>
<manifest:file-entry manifest:full-path="content.xml" manifest:media-type="text/xml"/>
</manifest:manifest>"#;

    let mut out = Cursor::new(Vec::new());
    {
        let mut zip = ZipWriter::new(&mut out);
        zip.start_file("mimetype", SimpleFileOptions::default().compression_method(CompressionMethod::Stored))
            .map_err(|e| e.to_string())?;
        zip.write_all(b"application/vnd.oasis.opendocument.spreadsheet").map_err(|e| e.to_string())?;
        let deflated = SimpleFileOptions::default().compression_method(CompressionMethod::Deflated);
        zip.start_file("content.xml", deflated).map_err(|e| e.to_string())?;
        zip.write_all(content_xml.as_bytes()).map_err(|e| e.to_string())?;
        zip.start_file("META-INF/manifest.xml", deflated).map_err(|e| e.to_string())?;
        zip.write_all(manifest_xml.as_bytes()).map_err(|e| e.to_string())?;
        zip.finish().map_err(|e| e.to_string())?;
    }
    Ok(out.into_inner())
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::workbook::{LANGUAGE, LOCALE, TIMEZONE};
    use ironcalc::base::UserModel;

    #[test]
    fn writes_valid_ods_readable_by_calamine() {
        let mut m = UserModel::new_empty("prova", LOCALE, TIMEZONE, LANGUAGE).unwrap();
        m.set_user_input(0, 1, 1, "Prodotto").unwrap();
        m.set_user_input(0, 1, 2, "Prezzo").unwrap();
        m.set_user_input(0, 2, 1, "Caffè").unwrap();
        m.set_user_input(0, 2, 2, "2,5").unwrap();
        m.evaluate();
        let bytes = write_ods(m.get_model()).unwrap();
        let tmp = std::env::temp_dir().join(format!("zikoffice-ods-{}.ods", std::process::id()));
        std::fs::write(&tmp, &bytes).unwrap();
        let back_bytes = crate::calamine_io::read_with_calamine(&tmp.to_string_lossy()).unwrap();
        let _ = std::fs::remove_file(&tmp);
        let back = Model::from_bytes(&back_bytes, LANGUAGE).unwrap();
        assert_eq!(back.get_formatted_cell_value(0, 2, 1).unwrap(), "Caffè");
        assert_eq!(back.get_formatted_cell_value(0, 2, 2).unwrap(), "2,5");
    }
}
