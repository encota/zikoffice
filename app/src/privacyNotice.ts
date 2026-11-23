// Avviso sull'uso di servizi esterni (Assistente, Claude, Antigravity… avviati dal Terminale):
// il testo esce dal computer. Si può chiudere; con la casella «non mostrare più» resta nascosto
// finché l'applicazione non viene aggiornata (cambia versione), poi ricompare una volta.
import { h } from "./dom";

const KEY = "zikoffice.ai.notice.hidden"; // versione dell'applicazione per cui l'utente ha scelto di non vederlo più
let dismissedThisSession = false;

export async function appVersion(): Promise<string> {
  try {
    const { getVersion } = await import("@tauri-apps/api/app");
    return await getVersion();
  } catch {
    return "dev";
  }
}

function storage(): Pick<Storage, "getItem" | "setItem"> | null {
  try { return localStorage; } catch { return null; }
}

/** Va mostrato? Sì, a meno che sia stato chiuso in questa sessione o nascosto «per sempre» in questa versione. */
export function shouldShowNotice(version: string, store: Pick<Storage, "getItem"> | null = storage()): boolean {
  if (dismissedThisSession) return false;
  try { return store?.getItem(KEY) !== version; } catch { return true; }
}

export function dismissNotice(version: string, forever: boolean, store: Pick<Storage, "setItem"> | null = storage()): void {
  dismissedThisSession = true;
  if (!forever) return;
  try { store?.setItem(KEY, version); } catch { /* senza archivio resta nascosto solo per questa sessione */ }
}

/** Solo per i test. */
export function resetNoticeSession(): void {
  dismissedThisSession = false;
}

export function buildNotice(version: string, onDone: () => void): HTMLElement {
  const forever = h("input", { type: "checkbox", id: "ai-notice-forever" }) as HTMLInputElement;
  return h("div", { class: "dock-notice-inner", role: "note" },
    h("div", { class: "dock-notice-text" },
      h("strong", {}, "I tuoi testi escono dal computer"),
      h("p", {}, "ZikOffice non invia nulla a nessuno. Ma l'Assistente — e qualunque programma tu avvii nel Terminale, come Claude o Antigravity — manda il testo che gli dai al servizio che lo gestisce, fuori dal tuo computer. Da quel momento come viene conservato e usato lo decidono quel servizio e le sue condizioni, non ZikOffice né chi lo sviluppa, e non ne siamo responsabili. Con documenti riservati usalo solo se sai che è consentito.")),
    h("div", { class: "dock-notice-actions" },
      h("label", { class: "dock-notice-check", for: "ai-notice-forever" }, forever, "Non mostrare più questo avviso (fino al prossimo aggiornamento)"),
      h("button", { class: "dock-btn primary", onclick: () => { dismissNotice(version, forever.checked); onDone(); } }, "Ho capito")));
}
