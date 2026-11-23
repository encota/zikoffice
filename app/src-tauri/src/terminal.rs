//! Terminale integrato (pseudo-terminale) e assistente basato sui programmi a riga di comando
//! (`claude`, `agy`) con cui l'utente è già collegato col proprio abbonamento.

use portable_pty::{native_pty_system, Child, CommandBuilder, MasterPty, PtySize};
use serde::Serialize;
use std::collections::HashMap;
use std::io::{Read, Write};
use std::path::PathBuf;
use std::process::{Command, Stdio};
use std::sync::atomic::{AtomicU32, Ordering};
use std::sync::Mutex;
use std::time::{Duration, Instant};
use tauri::ipc::Channel;

struct TermSession {
    master: Box<dyn MasterPty + Send>,
    writer: Box<dyn Write + Send>,
    child: Box<dyn Child + Send + Sync>,
}

#[derive(Default)]
pub struct TermState {
    next: AtomicU32,
    sessions: Mutex<HashMap<u32, TermSession>>,
}

#[derive(Serialize, Clone)]
#[serde(tag = "kind", rename_all = "lowercase")]
pub enum TermEvent {
    Data { text: String },
    Exit { code: Option<u32> },
}

fn size(rows: u16, cols: u16) -> PtySize {
    PtySize { rows: rows.max(1), cols: cols.max(1), pixel_width: 0, pixel_height: 0 }
}

fn home() -> PathBuf {
    std::env::var_os("HOME").map(PathBuf::from).unwrap_or_else(|| PathBuf::from("/"))
}

/// Taglia `pending` alla fine dell'ultimo carattere UTF-8 completo e restituisce il testo.
/// Gli ultimi byte di un carattere spezzato restano in `pending` per la lettura successiva.
fn take_utf8(pending: &mut Vec<u8>) -> String {
    match std::str::from_utf8(pending) {
        Ok(s) => {
            let out = s.to_string();
            pending.clear();
            out
        }
        Err(e) => {
            let valid = e.valid_up_to();
            match e.error_len() {
                // Sequenza non valida in mezzo: la sostituiamo e andiamo avanti.
                Some(bad) => {
                    let mut out = String::from_utf8_lossy(&pending[..valid + bad]).into_owned();
                    pending.drain(..valid + bad);
                    out.push_str(&take_utf8(pending));
                    out
                }
                // Carattere incompleto in fondo: aspettiamo il resto.
                None => {
                    let out = String::from_utf8_lossy(&pending[..valid]).into_owned();
                    pending.drain(..valid);
                    out
                }
            }
        }
    }
}

#[tauri::command]
pub fn term_open(state: tauri::State<'_, TermState>, cwd: Option<String>, rows: u16, cols: u16, on_event: Channel<TermEvent>) -> Result<u32, String> {
    let pair = native_pty_system().openpty(size(rows, cols)).map_err(|e| format!("Impossibile aprire il terminale: {e}"))?;
    let shell = std::env::var("SHELL").ok().filter(|s| !s.is_empty()).unwrap_or_else(|| "/bin/bash".into());
    let mut cmd = CommandBuilder::new(shell);
    cmd.env("TERM", "xterm-256color");
    cmd.env("COLORTERM", "truecolor");
    // Il terminale non deve credere di essere dentro un'altra sessione di assistente.
    for var in ["CLAUDECODE", "CLAUDE_CODE_ENTRYPOINT"] {
        cmd.env_remove(var);
    }
    let dir = cwd.map(PathBuf::from).filter(|p| p.is_dir()).unwrap_or_else(home);
    cmd.cwd(dir);
    let child = pair.slave.spawn_command(cmd).map_err(|e| format!("Impossibile avviare la shell: {e}"))?;
    drop(pair.slave);
    let mut reader = pair.master.try_clone_reader().map_err(|e| e.to_string())?;
    let writer = pair.master.take_writer().map_err(|e| e.to_string())?;

    let id = state.next.fetch_add(1, Ordering::Relaxed) + 1;
    state.sessions.lock().unwrap().insert(id, TermSession { master: pair.master, writer, child });

    std::thread::spawn(move || {
        let mut buf = [0u8; 8192];
        let mut pending: Vec<u8> = Vec::new();
        loop {
            match reader.read(&mut buf) {
                Ok(0) | Err(_) => break,
                Ok(n) => {
                    pending.extend_from_slice(&buf[..n]);
                    let text = take_utf8(&mut pending);
                    if !text.is_empty() && on_event.send(TermEvent::Data { text }).is_err() {
                        return;
                    }
                }
            }
        }
        let _ = on_event.send(TermEvent::Exit { code: None });
    });
    Ok(id)
}

#[tauri::command]
pub fn term_write(state: tauri::State<'_, TermState>, id: u32, data: String) -> Result<(), String> {
    let mut map = state.sessions.lock().unwrap();
    let s = map.get_mut(&id).ok_or("Terminale chiuso")?;
    s.writer.write_all(data.as_bytes()).map_err(|e| e.to_string())?;
    s.writer.flush().map_err(|e| e.to_string())
}

#[tauri::command]
pub fn term_resize(state: tauri::State<'_, TermState>, id: u32, rows: u16, cols: u16) -> Result<(), String> {
    let map = state.sessions.lock().unwrap();
    let s = map.get(&id).ok_or("Terminale chiuso")?;
    s.master.resize(size(rows, cols)).map_err(|e| e.to_string())
}

#[tauri::command]
pub fn term_close(state: tauri::State<'_, TermState>, id: u32) {
    if let Some(mut s) = state.sessions.lock().unwrap().remove(&id) {
        let _ = s.child.kill();
    }
}

// ---------- assistente ----------

#[derive(Serialize)]
pub struct AiStatus {
    pub claude: bool,
    pub agy: bool,
}

/// Cerca un programma nel PATH e nelle cartelle dove di solito si installano (la finestra
/// avviata dal menu non sempre eredita il PATH della shell).
fn find_program(name: &str) -> Option<PathBuf> {
    let mut dirs: Vec<PathBuf> = std::env::var_os("PATH").map(|p| std::env::split_paths(&p).collect()).unwrap_or_default();
    let h = home();
    dirs.push(h.join(".local/bin"));
    dirs.push(h.join(".gemini/bin"));
    dirs.push(h.join(".claude/local"));
    dirs.push(h.join(".npm-global/bin"));
    dirs.push("/usr/local/bin".into());
    if let Ok(entries) = std::fs::read_dir(h.join(".nvm/versions/node")) {
        for e in entries.flatten() {
            dirs.push(e.path().join("bin"));
        }
    }
    dirs.into_iter().map(|d| d.join(name)).find(|p| p.is_file())
}

#[tauri::command]
pub fn ai_status() -> AiStatus {
    AiStatus { claude: find_program("claude").is_some(), agy: find_program("agy").is_some() }
}

/// Esegue un'istruzione su un testo con il motore scelto e restituisce la risposta.
/// Il programma parte in una cartella temporanea vuota e senza strumenti: vede solo il testo ricevuto.
#[tauri::command]
pub async fn ai_run(engine: String, instruction: String, text: String) -> Result<String, String> {
    tauri::async_runtime::spawn_blocking(move || run_engine(&engine, &instruction, &text)).await.map_err(|e| e.to_string())?
}

const AGY_INLINE_LIMIT: usize = 100_000;
const TIMEOUT: Duration = Duration::from_secs(300);

fn run_engine(engine: &str, instruction: &str, text: &str) -> Result<String, String> {
    let program = find_program(engine).ok_or_else(|| format!("Il programma «{engine}» non è installato o non è nel PATH"))?;
    let work = std::env::temp_dir().join(format!("zikoffice-ai-{}", std::process::id()));
    std::fs::create_dir_all(&work).map_err(|e| e.to_string())?;
    let result = (|| {
        let mut cmd = Command::new(&program);
        cmd.current_dir(&work).stdout(Stdio::piped()).stderr(Stdio::piped());
        for var in ["CLAUDECODE", "CLAUDE_CODE_ENTRYPOINT"] {
            cmd.env_remove(var);
        }
        let stdin_text: Option<String>;
        match engine {
            "claude" => {
                // Il testo arriva da stdin, senza strumenti né salvataggio della sessione.
                cmd.args(["-p", "--tools", "", "--no-session-persistence"]).arg(instruction).stdin(Stdio::piped());
                stdin_text = Some(text.to_string());
            }
            "agy" => {
                // agy non legge stdin: il testo va nel prompt, oppure in un file se è troppo lungo.
                let prompt = if text.len() + instruction.len() < AGY_INLINE_LIMIT {
                    format!("{instruction}\nNon usare strumenti e non creare file: rispondi direttamente.\n\n--- TESTO ---\n{text}")
                } else {
                    std::fs::write(work.join("testo.txt"), text).map_err(|e| e.to_string())?;
                    format!("Leggi il file testo.txt in questa cartella e poi esegui questa istruzione sul suo contenuto. Non creare né modificare file: rispondi direttamente.\n{instruction}")
                };
                cmd.arg(format!("--print={prompt}")).stdin(Stdio::null());
                stdin_text = None;
            }
            other => return Err(format!("Motore sconosciuto: {other}")),
        }
        let mut child = cmd.spawn().map_err(|e| format!("Impossibile avviare «{engine}»: {e}"))?;
        if let Some(t) = stdin_text {
            if let Some(mut stdin) = child.stdin.take() {
                std::thread::spawn(move || {
                    let _ = stdin.write_all(t.as_bytes());
                });
            }
        }
        let mut out = child.stdout.take().ok_or("stdout non disponibile")?;
        let mut err = child.stderr.take().ok_or("stderr non disponibile")?;
        let out_t = std::thread::spawn(move || {
            let mut s = Vec::new();
            let _ = out.read_to_end(&mut s);
            s
        });
        let err_t = std::thread::spawn(move || {
            let mut s = Vec::new();
            let _ = err.read_to_end(&mut s);
            s
        });
        let start = Instant::now();
        let status = loop {
            if let Some(st) = child.try_wait().map_err(|e| e.to_string())? {
                break st;
            }
            if start.elapsed() > TIMEOUT {
                let _ = child.kill();
                let _ = child.wait();
                return Err("Tempo scaduto: l'assistente non ha risposto in 5 minuti".into());
            }
            std::thread::sleep(Duration::from_millis(100));
        };
        let stdout = String::from_utf8_lossy(&out_t.join().unwrap_or_default()).trim().to_string();
        let stderr = String::from_utf8_lossy(&err_t.join().unwrap_or_default()).trim().to_string();
        if !status.success() || stdout.is_empty() {
            let detail = if stderr.is_empty() { stdout } else { stderr };
            return Err(format!("«{engine}» non ha dato una risposta{}", if detail.is_empty() { String::new() } else { format!(": {}", detail.chars().take(600).collect::<String>()) }));
        }
        Ok(stdout)
    })();
    let _ = std::fs::remove_dir_all(&work);
    result
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn utf8_split_across_reads_is_reassembled() {
        let bytes = "àè€".as_bytes();
        let mut pending = bytes[..3].to_vec(); // "à" + primo byte di "è"
        assert_eq!(take_utf8(&mut pending), "à");
        pending.extend_from_slice(&bytes[3..]);
        assert_eq!(take_utf8(&mut pending), "è€");
        assert!(pending.is_empty());
    }

    #[test]
    fn invalid_bytes_are_replaced_not_stuck() {
        let mut pending = vec![b'a', 0xff, b'b'];
        assert_eq!(take_utf8(&mut pending), "a\u{fffd}b");
        assert!(pending.is_empty());
    }

    /// Prova vera con i programmi installati (usa l'abbonamento): `cargo test -- --ignored ai_engines`.
    #[test]
    #[ignore]
    fn ai_engines_answer() {
        for engine in ["claude", "agy"] {
            if find_program(engine).is_none() { eprintln!("{engine}: non installato"); continue; }
            let out = run_engine(engine, "Riassumi in una frase breve.", "Il gatto dorme sul divano tutto il giorno e di notte esce a caccia di topi in giardino.\nÈ un gatto molto pigro.").unwrap();
            eprintln!("{engine}: {out}");
            assert!(out.to_lowercase().contains("gatto"), "{out}");
        }
    }

    #[test]
    fn pty_runs_a_command_and_reports_output() {
        let pair = native_pty_system().openpty(size(24, 80)).unwrap();
        let mut cmd = CommandBuilder::new("/bin/sh");
        cmd.args(["-c", "printf 'ciao %s' \"$((6*7))\""]);
        let mut child = pair.slave.spawn_command(cmd).unwrap();
        drop(pair.slave);
        let mut reader = pair.master.try_clone_reader().unwrap();
        let mut out = String::new();
        let mut buf = [0u8; 256];
        while let Ok(n) = reader.read(&mut buf) {
            if n == 0 { break; }
            out.push_str(&String::from_utf8_lossy(&buf[..n]));
        }
        child.wait().unwrap();
        assert!(out.contains("ciao 42"), "{out:?}");
    }
}
