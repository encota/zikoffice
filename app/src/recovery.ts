// Copie di recupero dei documenti non salvati (vedi src-tauri/src/recovery.rs).
import { inTauri } from "./files";
import type { DocKind } from "./ribbon/types";

export interface RecoveryEntry {
  id: string;
  name: string;
  kind: DocKind;
  path: string | null;
  saved_at: number;
}

async function core() {
  return import("@tauri-apps/api/core");
}

export async function writeRecovery(entry: Omit<RecoveryEntry, "saved_at">, bytes: Uint8Array): Promise<void> {
  if (!inTauri) return;
  const { invoke } = await core();
  const meta = encodeURIComponent(JSON.stringify({ ...entry, pid: 0, saved_at: 0 }));
  await invoke("recovery_write", bytes, { headers: { meta } });
}

export async function listRecovery(): Promise<RecoveryEntry[]> {
  if (!inTauri) return [];
  const { invoke } = await core();
  return invoke<RecoveryEntry[]>("recovery_list");
}

export async function readRecovery(id: string): Promise<Uint8Array> {
  const { invoke } = await core();
  return new Uint8Array(await invoke<ArrayBuffer>("recovery_read", { id }));
}

export async function deleteRecovery(id: string): Promise<void> {
  if (!inTauri) return;
  const { invoke } = await core();
  await invoke("recovery_delete", { id }).catch(() => undefined);
}
