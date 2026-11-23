//! Modifica di oggetti nei file PDF: elenco degli oggetti di una pagina (testo, immagini, grafica),
//! spostamento, ridimensionamento ed eliminazione, con annulla e ripeti.
//!
//! Un PDF descrive ogni pagina con un "flusso di contenuto": una sequenza di operatori
//! (`BT … Tj … ET` per il testo, `Do` per le immagini, `re f` per la grafica…). Qui il flusso
//! viene letto operatore per operatore, tenendo traccia della matrice di trasformazione e dei
//! font, così da conoscere posizione e ingombro di ogni oggetto. Le modifiche riscrivono solo
//! il flusso della pagina toccata: spostare un oggetto significa racchiuderlo in `q <cm> … Q`,
//! eliminarlo significa togliere i suoi operatori.

use std::collections::{HashMap, HashSet};
use std::rc::Rc;

use lopdf::content::{Content, Operation};
use lopdf::{Dictionary, Document, Object, ObjectId, Stream};
use serde::Serialize;

use crate::pdf_metrics::{HELVETICA, TIMES};

// ---------- matrici ----------

/// Matrice affine PDF `[a b c d e f]` (convenzione a vettore riga: `p' = p × M`).
#[derive(Clone, Copy, Debug, PartialEq)]
pub struct Mat(pub [f64; 6]);

impl Mat {
    pub const I: Mat = Mat([1.0, 0.0, 0.0, 1.0, 0.0, 0.0]);

    pub fn translate(tx: f64, ty: f64) -> Mat {
        Mat([1.0, 0.0, 0.0, 1.0, tx, ty])
    }

    /// Applica prima `self`, poi `o`.
    pub fn mul(self, o: Mat) -> Mat {
        let [a1, b1, c1, d1, e1, f1] = self.0;
        let [a2, b2, c2, d2, e2, f2] = o.0;
        Mat([
            a1 * a2 + b1 * c2,
            a1 * b2 + b1 * d2,
            c1 * a2 + d1 * c2,
            c1 * b2 + d1 * d2,
            e1 * a2 + f1 * c2 + e2,
            e1 * b2 + f1 * d2 + f2,
        ])
    }

    pub fn apply(self, x: f64, y: f64) -> (f64, f64) {
        let [a, b, c, d, e, f] = self.0;
        (a * x + c * y + e, b * x + d * y + f)
    }

    pub fn inverse(self) -> Option<Mat> {
        let [a, b, c, d, e, f] = self.0;
        let det = a * d - b * c;
        if det.abs() < 1e-12 {
            return None;
        }
        Some(Mat([d / det, -b / det, -c / det, a / det, (c * f - d * e) / det, (b * e - a * f) / det]))
    }
}

fn num(o: &Object) -> Option<f64> {
    match o {
        Object::Integer(i) => Some(*i as f64),
        Object::Real(r) => Some(f64::from(*r)),
        _ => None,
    }
}

fn nums(ops: &[Object]) -> Option<Vec<f64>> {
    ops.iter().map(num).collect()
}

fn real(v: f64) -> Object {
    Object::Real(v as f32)
}

fn mat_operation(op: &str, m: Mat) -> Operation {
    Operation::new(op, m.0.iter().map(|v| real(*v)).collect())
}

// ---------- accesso agli oggetti del documento ----------

fn resolve<'a>(doc: &'a Document, o: &'a Object) -> &'a Object {
    let mut cur = o;
    for _ in 0..16 {
        match cur {
            Object::Reference(id) => match doc.get_object(*id) {
                Ok(next) => cur = next,
                Err(_) => return cur,
            },
            _ => break,
        }
    }
    cur
}

fn dict_of<'a>(doc: &'a Document, o: &'a Object) -> Option<&'a Dictionary> {
    match resolve(doc, o) {
        Object::Dictionary(d) => Some(d),
        Object::Stream(s) => Some(&s.dict),
        _ => None,
    }
}

/// Valore di una chiave ereditabile della pagina (Resources, MediaBox, Rotate…).
fn inherited<'a>(doc: &'a Document, page: ObjectId, key: &[u8]) -> Option<&'a Object> {
    let mut id = page;
    for _ in 0..32 {
        let d = doc.get_dictionary(id).ok()?;
        if let Ok(v) = d.get(key) {
            return Some(resolve(doc, v));
        }
        id = d.get(b"Parent").ok()?.as_reference().ok()?;
    }
    None
}

/// Come `inherited`, ma restituisce il valore così com'è scritto (anche un riferimento), per non duplicarlo.
fn inherited_raw(doc: &Document, page: ObjectId, key: &[u8]) -> Option<Object> {
    let mut id = page;
    for _ in 0..32 {
        let d = doc.get_dictionary(id).ok()?;
        if let Ok(v) = d.get(key) {
            return Some(v.clone());
        }
        id = d.get(b"Parent").ok()?.as_reference().ok()?;
    }
    None
}

fn rect_of(doc: &Document, o: &Object) -> Option<[f64; 4]> {
    let arr = resolve(doc, o).as_array().ok()?;
    if arr.len() < 4 {
        return None;
    }
    let v: Vec<f64> = arr.iter().take(4).map(|x| num(resolve(doc, x))).collect::<Option<_>>()?;
    Some([v[0].min(v[2]), v[1].min(v[3]), v[0].max(v[2]), v[1].max(v[3])])
}

#[derive(Serialize, Clone, Debug)]
pub struct PageInfo {
    pub index: u32,
    /// Riquadro visibile in coordinate PDF `[x0 y0 x1 y1]`.
    pub bbox: [f64; 4],
    /// Rotazione in senso orario: 0, 90, 180 o 270.
    pub rotate: i64,
    /// Dimensioni a video (già ruotate), in punti.
    pub width: f64,
    pub height: f64,
}

pub fn page_geometry(doc: &Document, page: ObjectId) -> ([f64; 4], i64) {
    let media = inherited(doc, page, b"MediaBox").and_then(|o| rect_of(doc, o)).unwrap_or([0.0, 0.0, 612.0, 792.0]);
    let mut b = media;
    if let Some(c) = inherited(doc, page, b"CropBox").and_then(|o| rect_of(doc, o)) {
        let i = [c[0].max(media[0]), c[1].max(media[1]), c[2].min(media[2]), c[3].min(media[3])];
        if i[2] > i[0] && i[3] > i[1] {
            b = i;
        }
    }
    let rot = inherited(doc, page, b"Rotate").and_then(num).unwrap_or(0.0) as i64;
    (b, (rot.rem_euclid(360) / 90) * 90)
}

pub fn page_infos(doc: &Document) -> Vec<PageInfo> {
    doc.get_pages()
        .into_iter()
        .map(|(n, id)| {
            let (bbox, rotate) = page_geometry(doc, id);
            let (w, h) = (bbox[2] - bbox[0], bbox[3] - bbox[1]);
            let (width, height) = if rotate % 180 == 0 { (w, h) } else { (h, w) };
            PageInfo { index: n - 1, bbox, rotate, width, height }
        })
        .collect()
}

// ---------- font ----------

#[derive(Clone, Copy, PartialEq)]
enum StdFont {
    Helvetica,
    Times,
    Courier,
    Other,
}

struct FontInfo {
    cid: bool,
    first: u32,
    widths: Vec<f64>,
    missing: f64,
    cid_w: HashMap<u32, f64>,
    dw: f64,
    std: Option<StdFont>,
    /// Le larghezze sono quelle vere del font (non una stima).
    exact: bool,
    ascent: f64,
    descent: f64,
    to_uni: HashMap<u32, String>,
}

impl FontInfo {
    fn fallback() -> FontInfo {
        FontInfo { cid: false, first: 0, widths: vec![], missing: 500.0, cid_w: HashMap::new(), dw: 1000.0, std: Some(StdFont::Other), exact: false, ascent: 900.0, descent: -220.0, to_uni: HashMap::new() }
    }

    fn width(&self, code: u32) -> f64 {
        if self.cid {
            return self.cid_w.get(&code).copied().unwrap_or(self.dw);
        }
        if let Some(w) = code.checked_sub(self.first).and_then(|i| self.widths.get(i as usize)) {
            return *w;
        }
        match self.std {
            Some(StdFont::Helvetica) if (32..256).contains(&code) => f64::from(HELVETICA[(code - 32) as usize]),
            Some(StdFont::Times) if (32..256).contains(&code) => f64::from(TIMES[(code - 32) as usize]),
            Some(StdFont::Courier) => 600.0,
            _ => self.missing,
        }
    }

    /// Testo leggibile di un codice (per l'anteprima dell'oggetto).
    fn text(&self, code: u32) -> String {
        if let Some(s) = self.to_uni.get(&code) {
            return s.clone();
        }
        if self.cid {
            return String::new();
        }
        char::from_u32(code).filter(|c| !c.is_control()).map(String::from).unwrap_or_default()
    }
}

fn base_font_kind(name: &str) -> StdFont {
    let n = name.rsplit('+').next().unwrap_or(name).to_ascii_lowercase();
    if n.contains("courier") || n.contains("mono") {
        StdFont::Courier
    } else if n.contains("times") || n.contains("serif") && !n.contains("sans") || n.contains("georgia") || n.contains("cambria") {
        StdFont::Times
    } else if n.contains("helvetica") || n.contains("arial") || n.contains("sans") || n.contains("calibri") {
        StdFont::Helvetica
    } else {
        StdFont::Other
    }
}

fn load_font(doc: &Document, font: &Dictionary) -> FontInfo {
    let name = |d: &Dictionary, k: &[u8]| d.get(k).ok().and_then(|o| resolve(doc, o).as_name().ok().map(|n| String::from_utf8_lossy(n).into_owned()));
    let subtype = name(font, b"Subtype").unwrap_or_default();
    let mut f = FontInfo::fallback();
    f.to_uni = font.get(b"ToUnicode").ok().map(|o| parse_to_unicode(doc, o)).unwrap_or_default();

    fn descriptor_of<'a>(doc: &'a Document, d: &'a Dictionary) -> Option<&'a Dictionary> {
        d.get(b"FontDescriptor").ok().and_then(|o| dict_of(doc, o))
    }
    let mut descriptor = descriptor_of(doc, font);

    if subtype == "Type0" {
        f.cid = true;
        f.exact = true;
        f.std = None;
        if let Some(desc) = font.get(b"DescendantFonts").ok().and_then(|o| resolve(doc, o).as_array().ok()).and_then(|a| a.first()).and_then(|o| dict_of(doc, o)) {
            f.dw = desc.get(b"DW").ok().and_then(|o| num(resolve(doc, o))).unwrap_or(1000.0);
            if let Some(w) = desc.get(b"W").ok().and_then(|o| resolve(doc, o).as_array().ok()) {
                parse_cid_widths(doc, w, &mut f.cid_w);
            }
            descriptor = descriptor_of(doc, desc);
        }
    } else {
        f.first = font.get(b"FirstChar").ok().and_then(|o| num(resolve(doc, o))).unwrap_or(0.0).max(0.0) as u32;
        if let Some(w) = font.get(b"Widths").ok().and_then(|o| resolve(doc, o).as_array().ok()) {
            f.widths = w.iter().map(|x| num(resolve(doc, x)).unwrap_or(0.0)).collect();
        }
        // Type 3: le larghezze sono nello spazio del glifo
        if subtype == "Type3" {
            let scale = font.get(b"FontMatrix").ok().and_then(|o| resolve(doc, o).as_array().ok()).and_then(|a| a.first().and_then(|x| num(resolve(doc, x)))).unwrap_or(0.001) * 1000.0;
            f.widths.iter_mut().for_each(|w| *w *= scale);
        }
        if f.widths.is_empty() {
            f.std = Some(base_font_kind(&name(font, b"BaseFont").unwrap_or_default()));
        } else {
            f.exact = true;
            f.std = None;
        }
        f.missing = descriptor.and_then(|d| d.get(b"MissingWidth").ok()).and_then(|o| num(resolve(doc, o))).unwrap_or(if f.exact { 0.0 } else { 500.0 });
    }
    if let Some(d) = descriptor {
        let asc = d.get(b"Ascent").ok().and_then(|o| num(resolve(doc, o))).filter(|v| (200.0..=1600.0).contains(v));
        let desc = d.get(b"Descent").ok().and_then(|o| num(resolve(doc, o))).filter(|v| (-800.0..=0.0).contains(v));
        if let Some(a) = asc {
            f.ascent = a;
        }
        if let Some(de) = desc {
            f.descent = de;
        }
    }
    f
}

/// Array `W` dei font CID: `c [w1 w2 …]` oppure `c_first c_last w`.
fn parse_cid_widths(doc: &Document, w: &[Object], out: &mut HashMap<u32, f64>) {
    let mut i = 0;
    while i < w.len() {
        let Some(first) = num(resolve(doc, &w[i])) else { break };
        match w.get(i + 1).map(|o| resolve(doc, o)) {
            Some(Object::Array(list)) => {
                for (k, x) in list.iter().enumerate() {
                    if let Some(v) = num(resolve(doc, x)) {
                        out.insert(first as u32 + k as u32, v);
                    }
                }
                i += 2;
            }
            Some(last) => {
                let (Some(last), Some(v)) = (num(last), w.get(i + 2).and_then(|o| num(resolve(doc, o)))) else { break };
                if last >= first && last - first < 70_000.0 {
                    for c in first as u32..=last as u32 {
                        out.insert(c, v);
                    }
                }
                i += 3;
            }
            None => break,
        }
    }
}

/// Mappa codici → testo da un flusso ToUnicode (sezioni `bfchar` e `bfrange`).
fn parse_to_unicode(doc: &Document, o: &Object) -> HashMap<u32, String> {
    let mut map = HashMap::new();
    let Object::Stream(s) = resolve(doc, o) else { return map };
    let Ok(data) = s.decompressed_content() else { return map };
    let text = String::from_utf8_lossy(&data);
    // Estrae i token esadecimali <...> e le parole chiave in ordine.
    let mut tokens: Vec<(bool, String)> = Vec::new(); // (è_hex, contenuto)
    let mut chars = text.chars().peekable();
    while let Some(c) = chars.next() {
        if c == '<' {
            let mut hex = String::new();
            for d in chars.by_ref() {
                if d == '>' {
                    break;
                }
                if d.is_ascii_hexdigit() {
                    hex.push(d);
                }
            }
            tokens.push((true, hex));
        } else if c == '[' || c == ']' {
            tokens.push((false, c.to_string()));
        } else if c.is_ascii_alphabetic() {
            let mut w = c.to_string();
            while let Some(&n) = chars.peek() {
                if n.is_ascii_alphanumeric() {
                    w.push(n);
                    chars.next();
                } else {
                    break;
                }
            }
            tokens.push((false, w));
        }
    }
    let code = |h: &str| u32::from_str_radix(h, 16).ok();
    let uni = |h: &str| -> String {
        let units: Vec<u16> = (0..h.len() / 4).filter_map(|i| u16::from_str_radix(&h[i * 4..i * 4 + 4], 16).ok()).collect();
        String::from_utf16_lossy(&units)
    };
    let mut i = 0;
    while i < tokens.len() {
        match tokens[i].1.as_str() {
            "beginbfchar" if !tokens[i].0 => {
                i += 1;
                while i + 1 < tokens.len() && tokens[i].0 && tokens[i + 1].0 {
                    if let Some(c) = code(&tokens[i].1) {
                        map.insert(c, uni(&tokens[i + 1].1));
                    }
                    i += 2;
                }
            }
            "beginbfrange" if !tokens[i].0 => {
                i += 1;
                while i + 2 < tokens.len() && tokens[i].0 && tokens[i + 1].0 {
                    let (Some(lo), Some(hi)) = (code(&tokens[i].1), code(&tokens[i + 1].1)) else { break };
                    if tokens[i + 2].0 {
                        let base = uni(&tokens[i + 2].1);
                        for (k, c) in (lo..=hi.min(lo + 65_535)).enumerate() {
                            let mut chars: Vec<char> = base.chars().collect();
                            if let Some(last) = chars.last_mut() {
                                *last = char::from_u32(*last as u32 + k as u32).unwrap_or(*last);
                            }
                            map.insert(c, chars.into_iter().collect());
                        }
                        i += 3;
                    } else if tokens[i + 2].1 == "[" {
                        let mut j = i + 3;
                        let mut c = lo;
                        while j < tokens.len() && tokens[j].0 {
                            map.insert(c, uni(&tokens[j].1));
                            c += 1;
                            j += 1;
                        }
                        i = j + 1; // salta "]"
                    } else {
                        break;
                    }
                }
            }
            _ => i += 1,
        }
    }
    map
}

// ---------- analisi del flusso di contenuto ----------

#[derive(Clone, Copy, PartialEq, Debug)]
pub enum Kind {
    Text,
    /// Testo invisibile (modo di rendering 3), tipico dell'OCR.
    Hidden,
    Image,
    Form,
    Path,
}

impl Kind {
    pub fn name(self) -> &'static str {
        match self {
            Kind::Text => "text",
            Kind::Hidden => "hidden",
            Kind::Image => "image",
            Kind::Form => "form",
            Kind::Path => "path",
        }
    }
}

#[derive(Clone, Debug)]
pub struct Found {
    /// Indice del primo operatore dell'oggetto (è anche il suo identificativo).
    pub id: usize,
    /// Indice successivo all'ultimo operatore.
    pub end: usize,
    pub kind: Kind,
    /// Ingombro nello spazio utente della pagina `[x0 y0 x1 y1]`.
    pub bbox: [f64; 4],
    pub text: Option<String>,
    /// Matrice di trasformazione corrente all'inizio dell'oggetto.
    pub ctm: Mat,
    /// Matrice del testo al momento del disegno (solo per il testo).
    pub tm: Mat,
    /// Blocco BT…ET che contiene il testo: (indice di BT, indice di ET).
    pub block: Option<(usize, usize)>,
    /// La posizione è calcolata con larghezze vere: si può riscrivere con sicurezza.
    pub exact: bool,
    pub render_mode: i64,
    /// Per l'operatore `"`: spaziatura di parola e di carattere.
    pub spacing: Option<(f64, f64)>,
    pub selectable: bool,
}

#[derive(Clone)]
struct GState {
    ctm: Mat,
    font: Option<Vec<u8>>,
    size: f64,
    tc: f64,
    tw: f64,
    th: f64,
    tl: f64,
    rise: f64,
    mode: i64,
}

enum Item<'a> {
    Str(&'a [u8]),
    Adj(f64),
}

fn bbox_of(points: impl Iterator<Item = (f64, f64)>) -> Option<[f64; 4]> {
    let mut b: Option<[f64; 4]> = None;
    for (x, y) in points {
        b = Some(match b {
            None => [x, y, x, y],
            Some(o) => [o[0].min(x), o[1].min(y), o[2].max(x), o[3].max(y)],
        });
    }
    b
}

fn is_show(op: &str) -> bool {
    matches!(op, "Tj" | "TJ" | "'" | "\"")
}

pub fn analyze(doc: &Document, page: ObjectId, ops: &[Operation]) -> Vec<Found> {
    let resources = inherited(doc, page, b"Resources").and_then(|o| dict_of(doc, o));
    let sub = |key: &[u8]| resources.and_then(|r| r.get(key).ok()).and_then(|o| dict_of(doc, o));
    let fonts = sub(b"Font");
    let xobjects = sub(b"XObject");
    let mut font_cache: HashMap<Vec<u8>, Rc<FontInfo>> = HashMap::new();
    let fallback = Rc::new(FontInfo::fallback());

    let mut out: Vec<Found> = Vec::new();
    let mut st = GState { ctm: Mat::I, font: None, size: 1.0, tc: 0.0, tw: 0.0, th: 1.0, tl: 0.0, rise: 0.0, mode: 0 };
    let mut stack: Vec<GState> = Vec::new();
    let (mut tm, mut tlm) = (Mat::I, Mat::I);
    let mut tm_exact = true;
    let mut bt_start: Option<usize> = None;
    let mut pending: Vec<usize> = Vec::new(); // indici in `out` dei testi del blocco corrente
    let mut path_start: Option<usize> = None;
    let mut path_pts: Vec<(f64, f64)> = Vec::new();

    for (i, op) in ops.iter().enumerate() {
        let o = op.operands.as_slice();
        match op.operator.as_str() {
            "q" => stack.push(st.clone()),
            "Q" => {
                if let Some(s) = stack.pop() {
                    st = s;
                }
            }
            "cm" => {
                if let Some(v) = nums(o).filter(|v| v.len() == 6) {
                    st.ctm = Mat([v[0], v[1], v[2], v[3], v[4], v[5]]).mul(st.ctm);
                }
            }
            "Tf" => {
                if let (Some(Object::Name(n)), Some(s)) = (o.first(), o.get(1).and_then(num)) {
                    st.font = Some(n.clone());
                    st.size = s;
                }
            }
            "Tc" => st.tc = o.first().and_then(num).unwrap_or(0.0),
            "Tw" => st.tw = o.first().and_then(num).unwrap_or(0.0),
            "Tz" => st.th = o.first().and_then(num).unwrap_or(100.0) / 100.0,
            "TL" => st.tl = o.first().and_then(num).unwrap_or(0.0),
            "Ts" => st.rise = o.first().and_then(num).unwrap_or(0.0),
            "Tr" => st.mode = o.first().and_then(num).unwrap_or(0.0) as i64,
            "BT" => {
                tm = Mat::I;
                tlm = Mat::I;
                tm_exact = true;
                bt_start = Some(i);
                pending.clear();
            }
            "ET" => {
                if let Some(b) = bt_start.take() {
                    for &k in &pending {
                        out[k].block = Some((b, i));
                    }
                }
                pending.clear();
            }
            "Td" | "TD" => {
                if let Some(v) = nums(o).filter(|v| v.len() == 2) {
                    if op.operator == "TD" {
                        st.tl = -v[1];
                    }
                    tlm = Mat::translate(v[0], v[1]).mul(tlm);
                    tm = tlm;
                    tm_exact = true;
                }
            }
            "T*" => {
                tlm = Mat::translate(0.0, -st.tl).mul(tlm);
                tm = tlm;
                tm_exact = true;
            }
            "Tm" => {
                if let Some(v) = nums(o).filter(|v| v.len() == 6) {
                    tm = Mat([v[0], v[1], v[2], v[3], v[4], v[5]]);
                    tlm = tm;
                    tm_exact = true;
                }
            }
            s if is_show(s) => {
                let mut spacing = None;
                let items: Vec<Item> = match s {
                    "Tj" | "'" => o.first().and_then(|x| if let Object::String(b, _) = x { Some(vec![Item::Str(b)]) } else { None }).unwrap_or_default(),
                    "\"" => {
                        if let (Some(aw), Some(ac)) = (o.first().and_then(num), o.get(1).and_then(num)) {
                            st.tw = aw;
                            st.tc = ac;
                            spacing = Some((aw, ac));
                        }
                        o.get(2).and_then(|x| if let Object::String(b, _) = x { Some(vec![Item::Str(b)]) } else { None }).unwrap_or_default()
                    }
                    _ => o
                        .first()
                        .and_then(|x| x.as_array().ok())
                        .map(|a| a.iter().filter_map(|e| match e { Object::String(b, _) => Some(Item::Str(b)), other => num(other).map(Item::Adj) }).collect())
                        .unwrap_or_default(),
                };
                if s == "'" || s == "\"" {
                    tlm = Mat::translate(0.0, -st.tl).mul(tlm);
                    tm = tlm;
                    tm_exact = true;
                }
                let font = st
                    .font
                    .as_ref()
                    .map(|name| {
                        font_cache
                            .entry(name.clone())
                            .or_insert_with(|| fonts.and_then(|f| f.get(name).ok()).and_then(|o| dict_of(doc, o)).map(|d| Rc::new(load_font(doc, d))).unwrap_or_else(|| fallback.clone()))
                            .clone()
                    })
                    .unwrap_or_else(|| fallback.clone());
                // Larghezza del testo (spazio del testo, con Tz già applicato)
                let (mut x, mut min_x, mut max_x) = (0.0f64, 0.0f64, 0.0f64);
                let mut text = String::new();
                for item in &items {
                    match item {
                        Item::Adj(n) => {
                            x -= n / 1000.0 * st.size * st.th;
                            if *n < -250.0 {
                                text.push(' ');
                            }
                        }
                        Item::Str(bytes) => {
                            let codes: Vec<u32> = if font.cid { bytes.chunks(2).map(|c| c.iter().fold(0u32, |a, b| a << 8 | u32::from(*b))).collect() } else { bytes.iter().map(|b| u32::from(*b)).collect() };
                            for code in codes {
                                let w = font.width(code) / 1000.0;
                                x += (w * st.size + st.tc + if !font.cid && code == 32 { st.tw } else { 0.0 }) * st.th;
                                text.push_str(&font.text(code));
                            }
                        }
                    }
                    min_x = min_x.min(x);
                    max_x = max_x.max(x);
                }
                let y0 = font.descent / 1000.0 * st.size + st.rise;
                let y1 = font.ascent / 1000.0 * st.size + st.rise;
                let m = tm.mul(st.ctm);
                let bbox = bbox_of([(min_x, y0), (max_x, y0), (max_x, y1), (min_x, y1)].into_iter().map(|(px, py)| m.apply(px, py))).unwrap_or([0.0; 4]);
                let trimmed = text.trim();
                let hidden = st.mode == 3;
                out.push(Found {
                    id: i,
                    end: i + 1,
                    kind: if hidden { Kind::Hidden } else { Kind::Text },
                    bbox,
                    text: Some(text.clone()).filter(|_| !trimmed.is_empty()),
                    ctm: st.ctm,
                    tm,
                    block: None,
                    exact: tm_exact,
                    render_mode: st.mode,
                    spacing,
                    selectable: max_x - min_x > 0.01 && !trimmed.is_empty() || (max_x - min_x > 0.01 && !font.cid),
                });
                if bt_start.is_some() {
                    pending.push(out.len() - 1);
                }
                tm = Mat::translate(x, 0.0).mul(tm);
                tm_exact = tm_exact && font.exact;
            }
            "m" | "l" | "c" | "v" | "y" | "re" | "h" => {
                if path_start.is_none() {
                    path_start = Some(i);
                }
                if let Some(v) = nums(o) {
                    let c = st.ctm;
                    match op.operator.as_str() {
                        "m" | "l" if v.len() == 2 => path_pts.push(c.apply(v[0], v[1])),
                        "c" if v.len() == 6 => path_pts.extend([c.apply(v[0], v[1]), c.apply(v[2], v[3]), c.apply(v[4], v[5])]),
                        "v" | "y" if v.len() == 4 => path_pts.extend([c.apply(v[0], v[1]), c.apply(v[2], v[3])]),
                        "re" if v.len() == 4 => path_pts.extend([c.apply(v[0], v[1]), c.apply(v[0] + v[2], v[1]), c.apply(v[0] + v[2], v[1] + v[3]), c.apply(v[0], v[1] + v[3])]),
                        _ => {}
                    }
                }
            }
            "S" | "s" | "f" | "F" | "f*" | "B" | "B*" | "b" | "b*" => {
                if let (Some(start), Some(mut b)) = (path_start.take(), bbox_of(path_pts.drain(..))) {
                    // Un po' di margine per lo spessore del tratto e per rendere selezionabili le linee sottili
                    let pad = 0.5;
                    b = [b[0] - pad, b[1] - pad, b[2] + pad, b[3] + pad];
                    out.push(Found { id: start, end: i + 1, kind: Kind::Path, bbox: b, text: None, ctm: st.ctm, tm: Mat::I, block: None, exact: true, render_mode: 0, spacing: None, selectable: true });
                }
                path_start = None;
                path_pts.clear();
            }
            "n" => {
                path_start = None;
                path_pts.clear();
            }
            "Do" => {
                if let Some(Object::Name(name)) = o.first() {
                    let xo = xobjects.and_then(|x| x.get(name).ok()).map(|x| resolve(doc, x));
                    if let Some(Object::Stream(s)) = xo {
                        let subtype = s.dict.get(b"Subtype").ok().and_then(|x| x.as_name().ok()).unwrap_or(b"");
                        let (kind, local): (Kind, Vec<(f64, f64)>) = if subtype == b"Form" {
                            let b = s.dict.get(b"BBox").ok().and_then(|x| rect_of(doc, x)).unwrap_or([0.0, 0.0, 1.0, 1.0]);
                            let fm = s.dict.get(b"Matrix").ok().and_then(|x| resolve(doc, x).as_array().ok()).and_then(|a| nums(&a.iter().map(|e| resolve(doc, e).clone()).collect::<Vec<_>>())).filter(|v| v.len() == 6).map(|v| Mat([v[0], v[1], v[2], v[3], v[4], v[5]])).unwrap_or(Mat::I);
                            (Kind::Form, [(b[0], b[1]), (b[2], b[1]), (b[2], b[3]), (b[0], b[3])].into_iter().map(|(x, y)| fm.apply(x, y)).collect())
                        } else {
                            (Kind::Image, vec![(0.0, 0.0), (1.0, 0.0), (1.0, 1.0), (0.0, 1.0)])
                        };
                        if let Some(bb) = bbox_of(local.into_iter().map(|(x, y)| st.ctm.apply(x, y))) {
                            out.push(Found { id: i, end: i + 1, kind, bbox: bb, text: None, ctm: st.ctm, tm: Mat::I, block: None, exact: true, render_mode: 0, spacing: None, selectable: bb[2] - bb[0] > 0.1 && bb[3] - bb[1] > 0.1 });
                        }
                    }
                }
            }
            _ => {}
        }
    }
    out
}

// ---------- modifica ----------

#[derive(Clone, Debug)]
pub enum Edit {
    /// Trasformazione affine nello spazio della pagina (spostamento, ridimensionamento…).
    Transform(Mat),
    Delete,
}

fn page_ops(doc: &Document, page: ObjectId) -> Result<Vec<Operation>, String> {
    let bytes = doc.get_page_content(page).map_err(|e| format!("Contenuto della pagina non leggibile: {e}"))?;
    Ok(Content::decode(&bytes).map_err(|_| "Il contenuto della pagina usa una sintassi non supportata".to_string())?.operations)
}

/// Riscrive gli operatori applicando la modifica agli oggetti indicati.
/// Restituisce i nuovi operatori e i nuovi identificativi degli oggetti modificati.
pub fn rewrite(ops: &[Operation], found: &[Found], targets: &[usize], edit: &Edit) -> Result<(Vec<Operation>, Vec<usize>), String> {
    let target_set: HashSet<usize> = targets.iter().copied().collect();
    let chosen: Vec<&Found> = found.iter().filter(|f| target_set.contains(&f.id)).collect();
    if chosen.len() != target_set.len() {
        return Err("Alcuni oggetti non esistono più: ricarica la pagina".into());
    }
    let local = |f: &Found| -> Result<Option<Mat>, String> {
        match edit {
            Edit::Delete => Ok(None),
            Edit::Transform(t) => f.ctm.inverse().map(|inv| Some(f.ctm.mul(*t).mul(inv))).ok_or_else(|| "Trasformazione non invertibile".to_string()),
        }
    };

    // Blocchi di testo da riscrivere e oggetti non testuali
    let mut blocks: HashMap<usize, usize> = HashMap::new(); // inizio -> fine
    let mut others: HashMap<usize, &Found> = HashMap::new();
    for f in &chosen {
        if matches!(f.kind, Kind::Text | Kind::Hidden) {
            let (a, b) = f.block.ok_or("Questo testo non è dentro un blocco BT…ET valido")?;
            blocks.insert(a, b);
        } else {
            others.insert(f.id, f);
        }
    }
    for f in found.iter().filter(|f| f.block.is_some_and(|(a, _)| blocks.contains_key(&a))) {
        if !f.exact {
            return Err("Il testo in questo punto non si può modificare con sicurezza: il font non ha le misure dei caratteri".into());
        }
        if f.render_mode >= 4 {
            return Err("Il testo usato come maschera di ritaglio non si può modificare".into());
        }
    }

    let mut out: Vec<Operation> = Vec::with_capacity(ops.len() + 8);
    let mut new_ids: Vec<usize> = Vec::new();
    let mut i = 0;
    while i < ops.len() {
        if let Some(&et) = blocks.get(&i) {
            let shows: HashMap<usize, &Found> = found.iter().filter(|f| f.block == Some((i, et))).map(|f| (f.id, f)).collect();
            for (k, op) in ops.iter().enumerate().take(et).skip(i + 1) {
                match op.operator.as_str() {
                    "Td" | "T*" | "Tm" | "BT" | "ET" => {}
                    "TD" => out.push(Operation::new("TL", vec![real(-op.operands.get(1).and_then(num).unwrap_or(0.0))])),
                    s if is_show(s) => {
                        let Some(f) = shows.get(&k) else { continue };
                        if let Some((aw, ac)) = f.spacing {
                            out.push(Operation::new("Tw", vec![real(aw)]));
                            out.push(Operation::new("Tc", vec![real(ac)]));
                        }
                        let is_target = target_set.contains(&k);
                        if is_target && matches!(edit, Edit::Delete) {
                            continue;
                        }
                        let tm = match (is_target, local(f)?) {
                            (true, Some(w)) => f.tm.mul(w),
                            _ => f.tm,
                        };
                        out.push(Operation::new("BT", vec![]));
                        out.push(mat_operation("Tm", tm));
                        if is_target {
                            new_ids.push(out.len());
                        }
                        let operands = if s == "TJ" { op.operands.clone() } else { vec![op.operands.last().cloned().unwrap_or(Object::string_literal(""))] };
                        out.push(Operation::new(if s == "TJ" { "TJ" } else { "Tj" }, operands));
                        out.push(Operation::new("ET", vec![]));
                    }
                    _ => out.push(op.clone()),
                }
            }
            i = et + 1;
        } else if let Some(f) = others.get(&i) {
            match local(f)? {
                None => {}
                Some(w) => {
                    out.push(Operation::new("q", vec![]));
                    out.push(mat_operation("cm", w));
                    new_ids.push(out.len());
                    out.extend(ops[f.id..f.end].iter().cloned());
                    out.push(Operation::new("Q", vec![]));
                }
            }
            i = f.end;
        } else {
            out.push(ops[i].clone());
            i += 1;
        }
    }
    Ok((out, new_ids))
}

// ---------- sessione di modifica ----------

/// Una modifica annullabile: sostituzione di uno o più dizionari (una pagina, oppure l'albero delle pagine).
pub struct EditRec {
    changes: Vec<(ObjectId, Dictionary, Dictionary)>,
    /// Cambia il numero, l'ordine o la forma delle pagine: l'interfaccia deve rileggerle tutte.
    structural: bool,
}

/// Esito di annulla/ripeti.
pub struct UndoInfo {
    /// Pagina da ridisegnare (se la modifica ne ha toccata una sola).
    pub page: Option<u32>,
    /// Se la struttura delle pagine è cambiata, l'elenco aggiornato.
    pub pages: Option<Vec<PageInfo>>,
}

pub struct Session {
    pub doc: Document,
    pub source: String,
    pub undo: Vec<EditRec>,
    pub redo: Vec<EditRec>,
    /// La copia di lavoro su disco (per il disegno) non è aggiornata.
    pub work_dirty: bool,
    pub ocr_font: Option<ObjectId>,
}

impl Session {
    pub fn new(doc: Document, source: String) -> Session {
        Session { doc, source, undo: vec![], redo: vec![], work_dirty: true, ocr_font: None }
    }

    pub fn page_id(&self, index: u32) -> Result<ObjectId, String> {
        self.doc.get_pages().get(&(index + 1)).copied().ok_or_else(|| "Pagina inesistente".to_string())
    }

    pub fn objects(&self, page: u32) -> Result<Vec<Found>, String> {
        let id = self.page_id(page)?;
        let ops = page_ops(&self.doc, id)?;
        Ok(analyze(&self.doc, id, &ops).into_iter().filter(|f| f.selectable).collect())
    }

    /// Sostituisce il contenuto della pagina con i nuovi operatori, registrando l'annulla.
    fn set_content(&mut self, page: ObjectId, ops: Vec<Operation>) -> Result<(), String> {
        let bytes = Content { operations: ops }.encode().map_err(|e| format!("Impossibile scrivere il contenuto: {e}"))?;
        let mut stream = Stream::new(Dictionary::new(), bytes);
        let _ = stream.compress();
        let sid = self.doc.add_object(stream);
        let before = self.doc.get_dictionary(page).map_err(|e| e.to_string())?.clone();
        let mut after = before.clone();
        after.set("Contents", Object::Reference(sid));
        self.commit(page, before, after)
    }

    fn commit(&mut self, page: ObjectId, before: Dictionary, after: Dictionary) -> Result<(), String> {
        self.commit_many(vec![(page, before, after)], false)
    }

    fn commit_many(&mut self, changes: Vec<(ObjectId, Dictionary, Dictionary)>, structural: bool) -> Result<(), String> {
        for (id, _, after) in &changes {
            self.doc.objects.insert(*id, Object::Dictionary(after.clone()));
        }
        self.undo.push(EditRec { changes, structural });
        if self.undo.len() > 100 {
            self.undo.remove(0);
        }
        self.redo.clear();
        self.work_dirty = true;
        Ok(())
    }

    /// Applica una modifica; restituisce i nuovi identificativi degli oggetti toccati.
    pub fn apply(&mut self, page: u32, ids: &[usize], edit: &Edit) -> Result<Vec<usize>, String> {
        let pid = self.page_id(page)?;
        let ops = page_ops(&self.doc, pid)?;
        let found = analyze(&self.doc, pid, &ops);
        let (new_ops, new_ids) = rewrite(&ops, &found, ids, edit)?;
        self.set_content(pid, new_ops)?;
        Ok(new_ids)
    }

    /// Annulla l'ultima modifica.
    pub fn undo(&mut self) -> Option<UndoInfo> {
        let rec = self.undo.pop()?;
        for (id, before, _) in &rec.changes {
            self.doc.objects.insert(*id, Object::Dictionary(before.clone()));
        }
        let info = self.info_for(&rec);
        self.redo.push(rec);
        self.work_dirty = true;
        Some(info)
    }

    pub fn redo(&mut self) -> Option<UndoInfo> {
        let rec = self.redo.pop()?;
        for (id, _, after) in &rec.changes {
            self.doc.objects.insert(*id, Object::Dictionary(after.clone()));
        }
        let info = self.info_for(&rec);
        self.undo.push(rec);
        self.work_dirty = true;
        Some(info)
    }

    fn info_for(&self, rec: &EditRec) -> UndoInfo {
        if rec.structural {
            UndoInfo { page: None, pages: Some(page_infos(&self.doc)) }
        } else {
            UndoInfo { page: rec.changes.first().and_then(|c| self.page_number(c.0)), pages: None }
        }
    }

    fn page_number(&self, id: ObjectId) -> Option<u32> {
        self.doc.get_pages().iter().find(|(_, v)| **v == id).map(|(k, _)| k - 1)
    }

    // ---------- pagine ----------

    fn pages_root(&self) -> Result<ObjectId, String> {
        let root = self.doc.trailer.get(b"Root").ok().and_then(|o| o.as_reference().ok()).ok_or("PDF senza catalogo")?;
        self.doc.get_dictionary(root).ok().and_then(|c| c.get(b"Pages").ok()).and_then(|o| o.as_reference().ok()).ok_or_else(|| "PDF senza albero delle pagine".to_string())
    }

    /// Imposta l'ordine delle pagine (anche eliminandone). L'albero diventa piatto: le proprietà ereditate
    /// (risorse, dimensioni, rotazione) si copiano su ogni pagina, così nulla cambia d'aspetto.
    fn restructure(&mut self, order: Vec<ObjectId>) -> Result<(), String> {
        let root = self.pages_root()?;
        let mut changes = Vec::with_capacity(order.len() + 1);
        for &pid in &order {
            let before = self.doc.get_dictionary(pid).map_err(|e| e.to_string())?.clone();
            let mut after = before.clone();
            for key in [&b"Resources"[..], b"MediaBox", b"CropBox", b"Rotate"] {
                if after.get(key).is_err() {
                    if let Some(v) = inherited_raw(&self.doc, pid, key) {
                        after.set(key, v);
                    }
                }
            }
            after.set("Parent", Object::Reference(root));
            changes.push((pid, before, after));
        }
        let before = self.doc.get_dictionary(root).map_err(|e| e.to_string())?.clone();
        let mut after = before.clone();
        after.set("Kids", Object::Array(order.iter().map(|id| Object::Reference(*id)).collect()));
        after.set("Count", Object::Integer(order.len() as i64));
        changes.push((root, before, after));
        self.commit_many(changes, true)
    }

    fn ordered_pages(&self) -> Vec<ObjectId> {
        self.doc.get_pages().values().copied().collect()
    }

    /// Ruota una pagina di un multiplo di 90 gradi (positivo = in senso orario).
    pub fn rotate_page(&mut self, index: u32, delta: i64) -> Result<(), String> {
        let pid = self.page_id(index)?;
        let (_, current) = page_geometry(&self.doc, pid);
        let before = self.doc.get_dictionary(pid).map_err(|e| e.to_string())?.clone();
        let mut after = before.clone();
        after.set("Rotate", Object::Integer((current + delta).rem_euclid(360)));
        self.commit_many(vec![(pid, before, after)], true)
    }

    pub fn delete_page(&mut self, index: u32) -> Result<(), String> {
        let mut order = self.ordered_pages();
        if order.len() <= 1 {
            return Err("Un PDF deve avere almeno una pagina".into());
        }
        if index as usize >= order.len() {
            return Err("Pagina inesistente".into());
        }
        order.remove(index as usize);
        self.restructure(order)
    }

    /// Sposta la pagina `from` in modo che diventi la pagina `to` (indici da 0).
    pub fn move_page(&mut self, from: u32, to: u32) -> Result<(), String> {
        let mut order = self.ordered_pages();
        let (f, t) = (from as usize, to as usize);
        if f >= order.len() || t >= order.len() {
            return Err("Pagina inesistente".into());
        }
        if f == t {
            return Ok(());
        }
        let p = order.remove(f);
        order.insert(t, p);
        self.restructure(order)
    }

    /// Documento pronto da salvare: senza oggetti non più usati dopo le modifiche.
    pub fn serialize(&self) -> Result<Vec<u8>, String> {
        let mut copy = self.doc.clone();
        copy.prune_objects();
        let mut out = Vec::new();
        copy.save_to(&mut out).map_err(|e| format!("Impossibile scrivere il PDF: {e}"))?;
        Ok(out)
    }

    // ---------- strato di testo invisibile (OCR) ----------

    /// Aggiunge una parola riconosciuta come testo invisibile.
    pub fn add_text_layer(&mut self, page: u32, words: &[OcrWord], scale: f64) -> Result<usize, String> {
        let pid = self.page_id(page)?;
        let (bbox, rotate) = page_geometry(&self.doc, pid);
        let old = page_ops(&self.doc, pid)?;
        // Il contenuto esistente viene racchiuso in `q … Q`: molti programmi (Chrome, per esempio) iniziano la pagina con
        // un `cm` di scala fuori da ogni `q`, e lo strato di testo deve invece partire dallo spazio standard della pagina.
        // Eventuali `q` rimasti aperti si chiudono; i `Q` in eccesso (che i lettori ignorano) si tolgono.
        let mut ops: Vec<Operation> = Vec::with_capacity(old.len() + 16);
        ops.push(Operation::new("q", vec![]));
        let mut depth = 1;
        for op in old {
            match op.operator.as_str() {
                "q" => depth += 1,
                "Q" if depth <= 1 => continue,
                "Q" => depth -= 1,
                _ => {}
            }
            ops.push(op);
        }
        ops.extend((0..depth).map(|_| Operation::new("Q", vec![])));
        ops.push(Operation::new("q", vec![]));
        ops.push(Operation::new("BT", vec![]));
        ops.push(Operation::new("Tr", vec![Object::Integer(3)]));
        let mut count = 0;
        for w in words {
            let (px, py) = (w.left, w.top + w.height * 0.8);
            let size = (w.height / scale * 0.9).clamp(3.0, 300.0);
            let encoded = encode_winansi(&w.text);
            let natural: f64 = encoded.iter().map(|b| if *b >= 32 { f64::from(HELVETICA[(*b - 32) as usize]) } else { 0.0 }).sum::<f64>() / 1000.0 * size;
            if natural <= 0.0 || w.width <= 0.0 {
                continue;
            }
            let tz = (w.width / scale / natural * 100.0).clamp(5.0, 800.0);
            // Immagine (pixel) → spazio della pagina, secondo la rotazione
            let (u, v) = (px / scale, py / scale);
            let (x, y, dir) = match rotate {
                90 => (bbox[0] + v, bbox[1] + u, [0.0, 1.0, -1.0, 0.0]),
                180 => (bbox[2] - u, bbox[1] + v, [-1.0, 0.0, 0.0, -1.0]),
                270 => (bbox[2] - v, bbox[3] - u, [0.0, -1.0, 1.0, 0.0]),
                _ => (bbox[0] + u, bbox[3] - v, [1.0, 0.0, 0.0, 1.0]),
            };
            ops.push(Operation::new("Tf", vec![Object::Name(b"FOcr".to_vec()), real(size)]));
            ops.push(Operation::new("Tz", vec![real(tz)]));
            ops.push(mat_operation("Tm", Mat([dir[0], dir[1], dir[2], dir[3], x, y])));
            ops.push(Operation::new("Tj", vec![Object::String(encoded, lopdf::StringFormat::Literal)]));
            count += 1;
        }
        ops.push(Operation::new("ET", vec![]));
        ops.push(Operation::new("Q", vec![]));
        if count == 0 {
            return Ok(0);
        }

        // Il carattere "Helvetica" va registrato nelle risorse della pagina (copiate, perché potrebbero essere condivise).
        let font_id = match self.ocr_font {
            Some(id) => id,
            None => {
                let mut f = Dictionary::new();
                f.set("Type", Object::Name(b"Font".to_vec()));
                f.set("Subtype", Object::Name(b"Type1".to_vec()));
                f.set("BaseFont", Object::Name(b"Helvetica".to_vec()));
                f.set("Encoding", Object::Name(b"WinAnsiEncoding".to_vec()));
                let id = self.doc.add_object(f);
                self.ocr_font = Some(id);
                id
            }
        };
        let mut resources = inherited(&self.doc, pid, b"Resources").and_then(|o| dict_of(&self.doc, o)).cloned().unwrap_or_default();
        let mut fonts = resources.get(b"Font").ok().and_then(|o| dict_of(&self.doc, o)).cloned().unwrap_or_default();
        fonts.set("FOcr", Object::Reference(font_id));
        resources.set("Font", Object::Dictionary(fonts));

        let bytes = Content { operations: ops }.encode().map_err(|e| e.to_string())?;
        let mut stream = Stream::new(Dictionary::new(), bytes);
        let _ = stream.compress();
        let sid = self.doc.add_object(stream);
        let before = self.doc.get_dictionary(pid).map_err(|e| e.to_string())?.clone();
        let mut after = before.clone();
        after.set("Contents", Object::Reference(sid));
        after.set("Resources", Object::Dictionary(resources));
        self.commit(pid, before, after)?;
        Ok(count)
    }
}

/// Parola riconosciuta dall'OCR, in pixel dell'immagine della pagina.
#[derive(Clone, Debug, PartialEq)]
pub struct OcrWord {
    pub text: String,
    pub left: f64,
    pub top: f64,
    pub width: f64,
    pub height: f64,
}

/// Testo → byte WinAnsi (cp1252). I caratteri non rappresentabili diventano «?».
pub fn encode_winansi(s: &str) -> Vec<u8> {
    s.chars()
        .map(|c| match c {
            ' '..='~' | '\u{A0}'..='\u{FF}' => c as u8,
            '€' => 0x80,
            '‘' => 0x91,
            '’' => 0x92,
            '“' => 0x93,
            '”' => 0x94,
            '•' => 0x95,
            '–' => 0x96,
            '—' => 0x97,
            '…' => 0x85,
            _ => b'?',
        })
        .collect()
}

#[cfg(test)]
mod tests {
    use super::*;
    use lopdf::dictionary;

    /// PDF di prova costruito a mano: due righe di testo, un rettangolo, un TJ con spostamenti e un'immagine.
    pub(super) fn sample(content: &str) -> (Document, ObjectId) {
        let mut doc = Document::with_version("1.5");
        let pages_id = doc.new_object_id();
        let font_id = doc.add_object(dictionary! { "Type" => "Font", "Subtype" => "Type1", "BaseFont" => "Helvetica", "Encoding" => "WinAnsiEncoding" });
        let img_id = doc.add_object(Stream::new(
            dictionary! { "Type" => "XObject", "Subtype" => "Image", "Width" => 1, "Height" => 1, "ColorSpace" => "DeviceGray", "BitsPerComponent" => 8 },
            vec![128],
        ));
        let content_id = doc.add_object(Stream::new(Dictionary::new(), content.as_bytes().to_vec()));
        let page_id = doc.add_object(dictionary! {
            "Type" => "Page", "Parent" => pages_id, "Contents" => content_id,
            "MediaBox" => vec![0.into(), 0.into(), 612.into(), 792.into()],
            "Resources" => dictionary! { "Font" => dictionary! { "F1" => font_id }, "XObject" => dictionary! { "Im1" => img_id } },
        });
        doc.objects.insert(pages_id, Object::Dictionary(dictionary! { "Type" => "Pages", "Kids" => vec![page_id.into()], "Count" => 1 }));
        let catalog = doc.add_object(dictionary! { "Type" => "Catalog", "Pages" => pages_id });
        doc.trailer.set("Root", catalog);
        (doc, page_id)
    }

    pub(super) const CONTENT: &str = "q 1 0 0 1 0 0 cm\n\
        BT /F1 12 Tf 1 0 0 1 100 700 Tm (Hello) Tj 0 -14 Td (World) Tj ET\n\
        1 0 0 rg 50 50 100 40 re f\n\
        BT /F1 10 Tf 200 500 Td [(A) -50 (B)] TJ (C) Tj ET\n\
        q 100 0 0 50 300 300 cm /Im1 Do Q\n\
        Q";

    fn texts(found: &[Found]) -> Vec<String> {
        found.iter().filter(|f| matches!(f.kind, Kind::Text)).filter_map(|f| f.text.clone()).collect()
    }

    #[test]
    fn matrix_inverse_roundtrip() {
        let m = Mat([2.0, 0.5, -1.0, 3.0, 10.0, -4.0]);
        let id = m.mul(m.inverse().unwrap());
        for (a, b) in id.0.iter().zip(Mat::I.0) {
            assert!((a - b).abs() < 1e-9, "{id:?}");
        }
    }

    #[test]
    fn finds_text_path_and_image_with_positions() {
        let (doc, page) = sample(CONTENT);
        let ops = page_ops(&doc, page).unwrap();
        let found = analyze(&doc, page, &ops);
        assert_eq!(texts(&found), vec!["Hello", "World", "AB", "C"]);
        let hello = found.iter().find(|f| f.text.as_deref() == Some("Hello")).unwrap();
        // "Hello" in Helvetica 12pt: H=722 e=556 l=222 l=222 o=556 → 2278/1000×12 = 27,3 pt
        assert!((hello.bbox[0] - 100.0).abs() < 0.01 && (hello.bbox[2] - 127.336).abs() < 0.01, "{:?}", hello.bbox);
        let world = found.iter().find(|f| f.text.as_deref() == Some("World")).unwrap();
        assert!((world.bbox[0] - 100.0).abs() < 0.01 && world.bbox[1] < 686.0 && world.bbox[3] > 686.0);
        let rect = found.iter().find(|f| f.kind == Kind::Path).unwrap();
        // il rettangolo 50,50 100×40 più mezzo punto di margine per lo spessore del tratto
        assert_eq!(rect.bbox, [49.5, 49.5, 150.5, 90.5]);
        let img = found.iter().find(|f| f.kind == Kind::Image).unwrap();
        assert_eq!(img.bbox, [300.0, 300.0, 400.0, 350.0]);
        // C segue AB senza riposizionamento: parte dalla fine di AB
        let (ab, c) = (found.iter().find(|f| f.text.as_deref() == Some("AB")).unwrap(), found.iter().find(|f| f.text.as_deref() == Some("C")).unwrap());
        assert!((c.bbox[0] - ab.bbox[2]).abs() < 0.01);
        assert!(!c.exact, "dopo un font senza Widths la posizione è solo stimata");
    }

    #[test]
    fn delete_removes_only_the_target() {
        let (doc, page) = sample(CONTENT);
        let ops = page_ops(&doc, page).unwrap();
        let before = analyze(&doc, page, &ops);
        let world = before.iter().find(|f| f.text.as_deref() == Some("World")).unwrap();
        let rect = before.iter().find(|f| f.kind == Kind::Path).unwrap();
        let mut s = Session::new(doc, String::new());
        s.apply(0, &[world.id, rect.id], &Edit::Delete).unwrap();
        let ops2 = page_ops(&s.doc, page).unwrap();
        let after = analyze(&s.doc, page, &ops2);
        assert_eq!(texts(&after), vec!["Hello", "AB", "C"]);
        assert!(after.iter().all(|f| f.kind != Kind::Path));
        assert!(after.iter().any(|f| f.kind == Kind::Image));
        // Gli altri testi non si muovono
        let hello_b = before.iter().find(|f| f.text.as_deref() == Some("Hello")).unwrap();
        let hello_a = after.iter().find(|f| f.text.as_deref() == Some("Hello")).unwrap();
        assert_eq!(hello_b.bbox, hello_a.bbox);
    }

    #[test]
    fn move_shifts_exactly_and_undo_restores() {
        let (doc, page) = sample(CONTENT);
        let ops = page_ops(&doc, page).unwrap();
        let before = analyze(&doc, page, &ops);
        let pick = |t: &str| before.iter().find(|f| f.text.as_deref() == Some(t)).unwrap().clone();
        let (world, img, rect) = (pick("World"), before.iter().find(|f| f.kind == Kind::Image).unwrap().clone(), before.iter().find(|f| f.kind == Kind::Path).unwrap().clone());
        let mut s = Session::new(doc, String::new());
        let original = s.doc.get_dictionary(page).unwrap().clone();
        let new_ids = s.apply(0, &[world.id, img.id, rect.id], &Edit::Transform(Mat::translate(15.0, -20.0))).unwrap();
        assert_eq!(new_ids.len(), 3);
        let after = s.objects(0).unwrap();
        for old in [&world, &img, &rect] {
            let moved = after.iter().find(|f| new_ids.contains(&f.id) && f.kind == old.kind && f.text == old.text).unwrap();
            for k in 0..4 {
                let d = if k % 2 == 0 { 15.0 } else { -20.0 };
                assert!((moved.bbox[k] - old.bbox[k] - d).abs() < 0.01, "{:?} → {:?}", old.bbox, moved.bbox);
            }
        }
        // Hello non si è mosso
        let hello = after.iter().find(|f| f.text.as_deref() == Some("Hello")).unwrap();
        assert_eq!(hello.bbox, pick("Hello").bbox);
        // Annulla e ripeti
        assert_eq!(s.undo().and_then(|u| u.page), Some(0));
        assert_eq!(s.doc.get_dictionary(page).unwrap(), &original);
        assert_eq!(s.redo().and_then(|u| u.page), Some(0));
        assert_eq!(s.objects(0).unwrap().len(), after.len());
    }

    #[test]
    fn scale_about_a_point_works_for_text_and_images() {
        let (doc, page) = sample(CONTENT);
        let ops = page_ops(&doc, page).unwrap();
        let before = analyze(&doc, page, &ops);
        let img = before.iter().find(|f| f.kind == Kind::Image).unwrap().clone();
        // raddoppia attorno all'angolo in basso a sinistra (300,300)
        let double = Mat::translate(-300.0, -300.0).mul(Mat([2.0, 0.0, 0.0, 2.0, 0.0, 0.0])).mul(Mat::translate(300.0, 300.0));
        let mut s = Session::new(doc, String::new());
        s.apply(0, &[img.id], &Edit::Transform(double)).unwrap();
        let after = s.objects(0).unwrap();
        let big = after.iter().find(|f| f.kind == Kind::Image).unwrap();
        assert_eq!(big.bbox.map(|v| v.round()), [300.0, 300.0, 500.0, 400.0]);
    }

    #[test]
    fn text_with_explicit_matrices_rewrites_safely() {
        // Ogni riga ha il proprio Tm: nessuna dipende dall'avanzamento dell'altra, quindi le posizioni sono esatte
        // anche con un font senza Widths.
        let content = "BT /F1 12 Tf 1 0 0 1 72 700 Tm (Prima) Tj ET BT /F1 12 Tf 1 0 0 1 72 680 Tm (Seconda) Tj ET";
        let (doc, _) = sample(content);
        let mut s = Session::new(doc, String::new());
        let found = s.objects(0).unwrap();
        assert!(found.iter().all(|f| f.exact));
        let seconda = found.iter().find(|f| f.text.as_deref() == Some("Seconda")).unwrap().id;
        s.apply(0, &[seconda], &Edit::Delete).unwrap();
        assert_eq!(texts(&s.objects(0).unwrap()), vec!["Prima"]);
    }

    #[test]
    fn inexact_text_is_refused_not_corrupted() {
        let (doc, _) = sample(CONTENT);
        let mut s = Session::new(doc, String::new());
        let c = s.objects(0).unwrap().into_iter().find(|f| f.text.as_deref() == Some("C")).unwrap();
        let err = s.apply(0, &[c.id], &Edit::Delete).unwrap_err();
        assert!(err.contains("con sicurezza"), "{err}");
        assert!(s.undo.is_empty(), "nessuna modifica registrata");
    }

    #[test]
    fn ocr_layer_adds_invisible_searchable_text() {
        let (doc, page) = sample("q Q");
        let mut s = Session::new(doc, String::new());
        let words = vec![
            OcrWord { text: "Ciao".into(), left: 100.0, top: 100.0, width: 160.0, height: 40.0 },
            OcrWord { text: "perché".into(), left: 300.0, top: 100.0, width: 220.0, height: 40.0 },
        ];
        assert_eq!(s.add_text_layer(0, &words, 150.0 / 72.0).unwrap(), 2);
        let found = analyze(&s.doc, page, &page_ops(&s.doc, page).unwrap());
        let hidden: Vec<_> = found.iter().filter(|f| f.kind == Kind::Hidden).collect();
        assert_eq!(hidden.len(), 2);
        assert_eq!(hidden[0].text.as_deref(), Some("Ciao"));
        // La parola occupa l'area riconosciuta: 160 px a 150 dpi = 76,8 pt
        assert!((hidden[0].bbox[2] - hidden[0].bbox[0] - 160.0 / (150.0 / 72.0)).abs() < 0.5, "{:?}", hidden[0].bbox);
        assert!((hidden[0].bbox[0] - 100.0 / (150.0 / 72.0)).abs() < 0.5);
        assert_eq!(encode_winansi("perché €"), vec![b'p', b'e', b'r', b'c', b'h', 0xE9, b' ', 0x80]);
        s.undo();
        assert!(s.objects(0).unwrap().iter().all(|f| f.kind != Kind::Hidden));
    }

    #[test]
    fn ocr_layer_ignores_a_scale_left_open_by_the_page_content() {
        // Chrome e altri iniziano la pagina con un `cm` fuori da ogni `q`, e a volte lasciano `q` o `Q` sbilanciati.
        let (doc, page) = sample("0.5 0 0 0.5 0 0 cm q BT /F1 12 Tf 100 700 Td (X) Tj ET Q Q q");
        let mut s = Session::new(doc, String::new());
        let word = OcrWord { text: "Ciao".into(), left: 100.0, top: 100.0, width: 160.0, height: 40.0 };
        s.add_text_layer(0, &[word], 150.0 / 72.0).unwrap();
        let found = analyze(&s.doc, page, &page_ops(&s.doc, page).unwrap());
        let hidden = found.iter().find(|f| f.kind == Kind::Hidden).unwrap();
        let scale = 150.0 / 72.0;
        assert!((hidden.bbox[0] - 100.0 / scale).abs() < 0.01, "x = {} invece di {}", hidden.bbox[0], 100.0 / scale);
        assert!((hidden.bbox[2] - hidden.bbox[0] - 160.0 / scale).abs() < 0.5);
        // Il testo originale resta dov'era (con la sua scala dimezzata)
        let x = found.iter().find(|f| f.text.as_deref() == Some("X")).unwrap();
        assert!((x.bbox[0] - 50.0).abs() < 0.01);
    }

    /// Documento con `n` pagine dentro un albero annidato: Rotate e MediaBox sono ereditati dal nodo intermedio.
    fn multipage(n: usize) -> Document {
        let mut doc = Document::with_version("1.5");
        let root = doc.new_object_id();
        let mid = doc.new_object_id();
        let font = doc.add_object(dictionary! { "Type" => "Font", "Subtype" => "Type1", "BaseFont" => "Helvetica" });
        let mut kids = Vec::new();
        for i in 0..n {
            let c = doc.add_object(Stream::new(Dictionary::new(), format!("BT /F1 12 Tf 100 700 Td (Pagina{}) Tj ET", i + 1).into_bytes()));
            let p = doc.add_object(dictionary! { "Type" => "Page", "Parent" => mid, "Contents" => c });
            kids.push(Object::Reference(p));
        }
        doc.objects.insert(mid, Object::Dictionary(dictionary! {
            "Type" => "Pages", "Parent" => root, "Kids" => kids, "Count" => n as i64,
            "MediaBox" => vec![0.into(), 0.into(), 300.into(), 400.into()], "Rotate" => 90,
            "Resources" => dictionary! { "Font" => dictionary! { "F1" => font } },
        }));
        doc.objects.insert(root, Object::Dictionary(dictionary! { "Type" => "Pages", "Kids" => vec![mid.into()], "Count" => n as i64 }));
        let catalog = doc.add_object(dictionary! { "Type" => "Catalog", "Pages" => root });
        doc.trailer.set("Root", catalog);
        doc
    }

    fn page_texts(s: &Session) -> Vec<String> {
        (0..s.doc.get_pages().len() as u32).map(|i| s.objects(i).unwrap().into_iter().filter_map(|f| f.text).collect::<String>()).collect()
    }

    #[test]
    fn pages_can_be_moved_deleted_and_rotated_with_undo() {
        let mut s = Session::new(multipage(4), String::new());
        assert_eq!(page_texts(&s), ["Pagina1", "Pagina2", "Pagina3", "Pagina4"]);
        let first = page_infos(&s.doc);
        assert_eq!((first[0].rotate, first[0].width, first[0].height), (90, 400.0, 300.0));

        s.move_page(3, 0).unwrap();
        assert_eq!(page_texts(&s), ["Pagina4", "Pagina1", "Pagina2", "Pagina3"]);
        // Spostando l'albero diventa piatto ma le pagine non cambiano d'aspetto (rotazione e misure ereditate)
        let moved = page_infos(&s.doc);
        assert!(moved.iter().all(|p| p.rotate == 90 && p.width == 400.0));

        s.delete_page(1).unwrap();
        assert_eq!(page_texts(&s), ["Pagina4", "Pagina2", "Pagina3"]);

        s.rotate_page(0, 90).unwrap();
        assert_eq!(page_infos(&s.doc)[0].rotate, 180);
        s.rotate_page(0, -270).unwrap();
        assert_eq!(page_infos(&s.doc)[0].rotate, 270);

        // Annulla tutto, un passo alla volta, con l'elenco delle pagine aggiornato
        for _ in 0..2 {
            assert!(s.undo().unwrap().pages.is_some());
        }
        assert_eq!(page_infos(&s.doc)[0].rotate, 90);
        assert_eq!(s.undo().unwrap().pages.unwrap().len(), 4);
        assert_eq!(page_texts(&s), ["Pagina4", "Pagina1", "Pagina2", "Pagina3"]);
        s.undo().unwrap();
        assert_eq!(page_texts(&s), ["Pagina1", "Pagina2", "Pagina3", "Pagina4"]);
        assert!(s.undo().is_none());
        // Ripeti
        s.redo().unwrap();
        s.redo().unwrap();
        assert_eq!(page_texts(&s), ["Pagina4", "Pagina2", "Pagina3"]);
    }

    /// Su PDF reali con più pagine: sposta, elimina e ruota, poi controlla con poppler testo e rotazione di ogni pagina.
    #[test]
    #[ignore]
    fn real_pdfs_page_operations_match_poppler() {
        let Some(dir) = std::env::var_os("ZIKOFFICE_PDF_FIXTURES") else { return };
        let out_dir = std::path::Path::new(&dir).join("_edited");
        std::fs::create_dir_all(&out_dir).unwrap();
        let texts = |path: &std::path::Path| -> Vec<String> {
            let o = std::process::Command::new("pdftotext").arg(path).arg("-").output().unwrap();
            let mut v: Vec<String> = String::from_utf8_lossy(&o.stdout).split('\u{c}').map(|t| t.split_whitespace().collect::<Vec<_>>().join(" ")).collect();
            v.pop(); // dopo l'ultimo salto pagina c'è una stringa vuota
            v
        };
        let mut checked = 0;
        for entry in std::fs::read_dir(&dir).unwrap().flatten() {
            let path = entry.path();
            if path.extension().and_then(|e| e.to_str()) != Some("pdf") {
                continue;
            }
            let before = texts(&path);
            if before.len() < 3 {
                continue;
            }
            let mut s = Session::new(Document::load(&path).unwrap(), String::new());
            let n = before.len() as u32;
            s.move_page(0, n - 1).unwrap();
            s.delete_page(1).unwrap();
            let out = out_dir.join("pages.pdf");
            std::fs::write(&out, s.serialize().unwrap()).unwrap();
            let mut expected = before.clone();
            let first = expected.remove(0);
            expected.push(first);
            expected.remove(1);
            assert_eq!(texts(&out), expected, "{path:?}: testo delle pagine dopo sposta ed elimina");
            let info = std::process::Command::new("pdfinfo").args(["-f", "1", "-l", "1"]).arg(&out).output().unwrap();
            let info = String::from_utf8_lossy(&info.stdout).into_owned();
            assert!(info.contains(&format!("Pages:           {}", n - 1)), "{path:?}: {info}");
            // Rotazione: poppler deve vedere la pagina girata di 90° rispetto a prima
            let rot_of = |p: &std::path::Path| String::from_utf8_lossy(&std::process::Command::new("pdfinfo").args(["-f", "1", "-l", "1"]).arg(p).output().unwrap().stdout).lines().find(|l| l.starts_with("Page    1 rot")).map(str::to_string).unwrap_or_default();
            s.rotate_page(0, 90).unwrap();
            let turned = out_dir.join("pages-rot.pdf");
            std::fs::write(&turned, s.serialize().unwrap()).unwrap();
            let (r0, r1) = (rot_of(&out), rot_of(&turned));
            let val = |l: &str| l.rsplit(':').next().and_then(|v| v.trim().parse::<i64>().ok()).unwrap_or(0);
            assert_eq!((val(&r0) + 90).rem_euclid(360), val(&r1), "{path:?}: rotazione {r0:?} → {r1:?}");
            s.undo();
            s.undo();
            s.undo();
            s.undo();
            let back = out_dir.join("pages-undone.pdf");
            std::fs::write(&back, s.serialize().unwrap()).unwrap();
            assert_eq!(texts(&back), before, "{path:?}: l'annulla non ripristina");
            checked += 1;
        }
        eprintln!("operazioni sulle pagine verificate su {checked} file");
        assert!(checked > 0);
    }

    #[test]
    fn last_page_cannot_be_deleted_and_bad_indices_are_refused() {
        let mut s = Session::new(multipage(1), String::new());
        assert!(s.delete_page(0).is_err());
        assert!(s.move_page(0, 5).is_err());
        assert!(s.rotate_page(3, 90).is_err());
        assert!(s.undo.is_empty());
    }

    #[test]
    fn page_edits_survive_saving() {
        let mut s = Session::new(multipage(3), String::new());
        s.move_page(0, 2).unwrap();
        s.delete_page(0).unwrap();
        let bytes = s.serialize().unwrap();
        let again = Session::new(Document::load_mem(&bytes).unwrap(), String::new());
        assert_eq!(page_texts(&again), ["Pagina3", "Pagina1"]);
    }

    #[test]
    fn page_geometry_reads_boxes_and_rotation() {
        let (mut doc, page) = sample("q Q");
        let d = doc.get_dictionary_mut(page).unwrap();
        d.set("Rotate", 90);
        d.set("CropBox", vec![10.into(), 20.into(), 310.into(), 420.into()]);
        let info = &page_infos(&doc)[0];
        assert_eq!((info.bbox, info.rotate, info.width, info.height), ([10.0, 20.0, 310.0, 420.0], 90, 400.0, 300.0));
    }

    /// Confronto con `pdftotext -bbox` su PDF reali: `ZIKOFFICE_PDF_FIXTURES=<cartella> cargo test -- --ignored`.
    /// Ogni parola trovata da poppler deve cadere dentro un oggetto di testo calcolato qui.
    #[test]
    #[ignore]
    fn real_pdfs_match_poppler_word_boxes() {
        let Some(dir) = std::env::var_os("ZIKOFFICE_PDF_FIXTURES") else { return };
        let (mut words_total, mut words_hit) = (0usize, 0usize);
        for entry in std::fs::read_dir(dir).unwrap().flatten() {
            let path = entry.path();
            if path.extension().and_then(|e| e.to_str()) != Some("pdf") {
                continue;
            }
            let doc = Document::load(&path).unwrap();
            let infos = page_infos(&doc);
            let out = std::process::Command::new("pdftotext").args(["-bbox"]).arg(&path).arg("-").output().unwrap();
            let xml = String::from_utf8_lossy(&out.stdout).into_owned();
            let (mut file_total, mut file_hit, mut inexact, mut objs) = (0usize, 0usize, 0usize, 0usize);
            for (pi, page_xml) in xml.split("<page ").skip(1).enumerate() {
                let Some(info) = infos.get(pi) else { continue };
                let pid = doc.get_pages()[&(info.index + 1)];
                let found = analyze(&doc, pid, &page_ops(&doc, pid).unwrap());
                let boxes: Vec<&Found> = found.iter().filter(|f| f.kind == Kind::Text && f.selectable).collect();
                objs += boxes.len();
                inexact += boxes.iter().filter(|f| !f.exact).count();
                for w in page_xml.split("<word ").skip(1) {
                    let get = |k: &str| -> f64 { w.split(&format!("{k}=\"")).nth(1).and_then(|r| r.split('"').next()).and_then(|v| v.parse().ok()).unwrap_or(f64::NAN) };
                    let (x0, y0, x1, y1) = (get("xMin"), get("yMin"), get("xMax"), get("yMax"));
                    // pdftotext: y verso il basso, dalla cima della pagina (già ruotata). Qui solo pagine non ruotate.
                    if info.rotate != 0 {
                        continue;
                    }
                    let (cx, cy) = ((x0 + x1) / 2.0 + info.bbox[0], info.bbox[3] - (y0 + y1) / 2.0);
                    file_total += 1;
                    if boxes.iter().any(|f| cx >= f.bbox[0] - 1.0 && cx <= f.bbox[2] + 1.0 && cy >= f.bbox[1] - 1.0 && cy <= f.bbox[3] + 1.0) {
                        file_hit += 1;
                    }
                }
            }
            eprintln!("{:<28} parole {file_hit}/{file_total}  oggetti di testo {objs} (stimati {inexact})", path.file_name().unwrap().to_string_lossy());
            words_total += file_total;
            words_hit += file_hit;
        }
        assert!(words_total > 0, "nessuna parola confrontata");
        assert!(words_hit as f64 / words_total as f64 > 0.97, "copertura {words_hit}/{words_total}");
    }

    pub(crate) fn poppler_words(path: &std::path::Path) -> Vec<(usize, String, f64, f64, f64, f64)> {
        let out = std::process::Command::new("pdftotext").args(["-bbox"]).arg(path).arg("-").output().unwrap();
        let xml = String::from_utf8_lossy(&out.stdout).into_owned();
        let mut v = Vec::new();
        for (pi, page) in xml.split("<page ").skip(1).enumerate() {
            for w in page.split("<word ").skip(1) {
                let get = |k: &str| -> f64 { w.split(&format!("{k}=\"")).nth(1).and_then(|r| r.split('"').next()).and_then(|x| x.parse().ok()).unwrap_or(f64::NAN) };
                let text = w.split('>').nth(1).and_then(|t| t.split('<').next()).unwrap_or("").to_string();
                v.push((pi, text, get("xMin"), get("yMin"), get("xMax"), get("yMax")));
            }
        }
        v
    }

    /// Su PDF reali: sposta e poi elimina un testo e verifica con poppler che solo quello sia cambiato.
    #[test]
    #[ignore]
    fn real_pdfs_edits_change_only_the_target() {
        let Some(dir) = std::env::var_os("ZIKOFFICE_PDF_FIXTURES") else { return };
        let out_dir = std::path::Path::new(&dir).join("_edited");
        std::fs::create_dir_all(&out_dir).unwrap();
        let (mut checked, mut skipped) = (0, 0);
        for entry in std::fs::read_dir(&dir).unwrap().flatten() {
            let path = entry.path();
            if path.extension().and_then(|e| e.to_str()) != Some("pdf") {
                continue;
            }
            let doc = Document::load(&path).unwrap();
            let info = page_infos(&doc)[0].clone();
            if info.rotate != 0 {
                continue;
            }
            let mut s = Session::new(doc, String::new());
            let objs = s.objects(0).unwrap();
            // un testo a metà pagina, con almeno una parola
            let Some(target) = objs.iter().filter(|f| f.kind == Kind::Text && f.text.as_deref().is_some_and(|t| t.chars().count() > 3)).nth(2).cloned() else { continue };
            // Spostamento verso una zona libera: se il testo finisse sopra altro testo, poppler lo tratterebbe in modo diverso.
            let free = |dx: f64, dy: f64| {
                let nb = [target.bbox[0] + dx, target.bbox[1] + dy, target.bbox[2] + dx, target.bbox[3] + dy];
                nb[0] > info.bbox[0] + 5.0 && nb[2] < info.bbox[2] - 5.0 && nb[1] > info.bbox[1] + 5.0 && nb[3] < info.bbox[3] - 5.0
                    && !objs.iter().any(|o| o.id != target.id && matches!(o.kind, Kind::Text | Kind::Image) && o.bbox[0] < nb[2] + 3.0 && o.bbox[2] > nb[0] - 3.0 && o.bbox[1] < nb[3] + 3.0 && o.bbox[3] > nb[1] - 3.0)
            };
            let Some(&(dx, dy)) = [(20.0, -30.0), (-20.0, 30.0), (0.0, -90.0), (0.0, 90.0), (40.0, -150.0), (-40.0, 150.0), (60.0, 0.0), (-60.0, 0.0)].iter().find(|(x, y)| free(*x, *y)) else {
                skipped += 1;
                continue;
            };
            let before = poppler_words(&path);
            let to_top = |bbox: &[f64; 4]| ((bbox[0] + bbox[2]) / 2.0 - info.bbox[0], info.bbox[3] - (bbox[1] + bbox[3]) / 2.0);
            let (cx, cy) = to_top(&target.bbox);
            // "dentro": tutta la parola cade nell'ingombro dell'oggetto (una parola a cavallo di due oggetti non vale)
            let (hw, hh) = ((target.bbox[2] - target.bbox[0]) / 2.0, (target.bbox[3] - target.bbox[1]) / 2.0);
            let inside = |w: &(usize, String, f64, f64, f64, f64)| w.0 == 0 && w.2 >= cx - hw - 0.5 && w.4 <= cx + hw + 0.5 && w.3 >= cy - hh - 0.5 && w.5 <= cy + hh + 0.5;
            let touching = |w: &(usize, String, f64, f64, f64, f64)| w.0 == 0 && w.4 >= cx - (target.bbox[2] - target.bbox[0]) / 2.0 - 2.0 && w.2 <= cx + (target.bbox[2] - target.bbox[0]) / 2.0 + 2.0 && w.5 >= cy - (target.bbox[3] - target.bbox[1]) / 2.0 - 2.0 && w.3 <= cy + (target.bbox[3] - target.bbox[1]) / 2.0 + 2.0;
            let moved_count = before.iter().filter(|w| inside(w)).count();
            if moved_count == 0 {
                skipped += 1;
                continue;
            }

            // --- spostamento nello spazio PDF (y verso l'alto); per poppler l'asse y è invertito
            let ids = match s.apply(0, &[target.id], &Edit::Transform(Mat::translate(dx, dy))) {
                Ok(ids) => ids,
                Err(e) => {
                    eprintln!("{:<28} saltato: {e}", path.file_name().unwrap().to_string_lossy());
                    skipped += 1;
                    continue;
                }
            };
            assert_eq!(ids.len(), 1);
            let moved_path = out_dir.join("moved.pdf");
            std::fs::write(&moved_path, s.serialize().unwrap()).unwrap();
            let after = poppler_words(&moved_path);
            // Le parole attaccate all'oggetto possono cambiare divisione (una virgola spostata diventa una parola a sé):
            // per quelle non si pretende nulla. Tutte le altre devono restare identiche o spostarsi esattamente.
            for w in before.iter().filter(|w| inside(w) || !touching(w)) {
                let (ex, ey) = if inside(w) { (dx, -dy) } else { (0.0, 0.0) };
                assert!(after.iter().any(|a| a.0 == w.0 && a.1 == w.1 && (a.2 - (w.2 + ex)).abs() < 0.2 && (a.3 - (w.3 + ey)).abs() < 0.2), "{path:?}: parola «{}» non al posto atteso (dx {ex}, dy {ey})", w.1);
            }

            // --- eliminazione dello stesso oggetto (da una sessione nuova) e annulla
            let doc2 = Document::load(&path).unwrap();
            let mut s2 = Session::new(doc2, String::new());
            let t2 = s2.objects(0).unwrap().into_iter().find(|f| f.id == target.id).unwrap();
            s2.apply(0, &[t2.id], &Edit::Delete).unwrap();
            let del_path = out_dir.join("deleted.pdf");
            std::fs::write(&del_path, s2.serialize().unwrap()).unwrap();
            let after_del = poppler_words(&del_path);
            assert!(after_del.len() <= before.len() - moved_count + 2 && after_del.len() + moved_count + 2 >= before.len(), "{path:?}: parole dopo l'eliminazione");
            assert!(!after_del.iter().any(|a| before.iter().any(|w| inside(w) && w.0 == a.0 && w.1 == a.1 && (w.2 - a.2).abs() < 0.2 && (w.3 - a.3).abs() < 0.2)), "{path:?}: il testo eliminato c'è ancora");
            for w in before.iter().filter(|w| !touching(w)) {
                assert!(after_del.iter().any(|a| a.0 == w.0 && a.1 == w.1 && (a.2 - w.2).abs() < 0.2 && (a.3 - w.3).abs() < 0.2), "{path:?}: «{}» si è mossa", w.1);
            }
            s2.undo();
            let undone = out_dir.join("undone.pdf");
            std::fs::write(&undone, s2.serialize().unwrap()).unwrap();
            let restored = poppler_words(&undone);
            let same = |a: &(usize, String, f64, f64, f64, f64), b: &(usize, String, f64, f64, f64, f64)| a.0 == b.0 && a.1 == b.1 && (a.2 - b.2).abs() < 0.01 && (a.3 - b.3).abs() < 0.01 && (a.4 - b.4).abs() < 0.01 && (a.5 - b.5).abs() < 0.01;
            if before.len() != restored.len() || before.iter().any(|w| !restored.iter().any(|r| same(w, r))) {
                let missing: Vec<_> = before.iter().filter(|w| !restored.iter().any(|r| same(w, r))).take(3).collect();
                panic!("{path:?}: l'annulla non ripristina il PDF ({} vs {} parole), mancano {missing:?}", before.len(), restored.len());
            }
            checked += 1;
        }
        eprintln!("modifiche verificate su {checked} file ({skipped} saltati)");
        assert!(checked > 0);
    }

    #[test]
    fn to_unicode_maps_are_parsed() {
        let mut doc = Document::with_version("1.5");
        let cmap = "/CIDInit /ProcSet findresource begin 2 beginbfchar <0003> <0041> <0004> <00E8> endbfchar 1 beginbfrange <0010> <0012> <0061> endbfrange end";
        let id = doc.add_object(Stream::new(Dictionary::new(), cmap.as_bytes().to_vec()));
        let m = parse_to_unicode(&doc, &Object::Reference(id));
        assert_eq!(m.get(&3).map(String::as_str), Some("A"));
        assert_eq!(m.get(&4).map(String::as_str), Some("è"));
        assert_eq!(m.get(&0x11).map(String::as_str), Some("b"));
    }
}

/// Documento di prova condiviso con i test degli altri moduli.
#[cfg(test)]
pub mod tests_support {
    pub fn poppler_words(path: &std::path::Path) -> Vec<(usize, String, f64, f64, f64, f64)> {
        super::tests::poppler_words(path)
    }
    pub fn sample_document() -> lopdf::Document {
        super::tests::sample(super::tests::CONTENT).0
    }
}
