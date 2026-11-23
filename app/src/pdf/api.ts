// Chiamate al lato Rust per la modifica dei PDF (vedi src-tauri/src/pdf_cmds.rs).
import type { PageGeo } from "./geometry";

export interface PdfPage extends PageGeo { index: number }

export type ObjKind = "text" | "hidden" | "image" | "form" | "path";

export interface PdfObject {
  id: number;
  end: number;
  kind: ObjKind;
  bbox: [number, number, number, number];
  text: string | null;
}

export interface OpenInfo { id: number; pages: PdfPage[] }
export interface ApplyResult { new_ids: number[]; objects: PdfObject[] }
export interface UndoOut { page: number | null; pages: PdfPage[] | null }
export interface OcrStatus { available: boolean; languages: string[] }

async function call<T>(cmd: string, args?: Record<string, unknown>): Promise<T> {
  const { invoke } = await import("@tauri-apps/api/core");
  return invoke<T>(cmd, args);
}

export const pdfOpen = (path: string, password?: string) => call<OpenInfo>("pdfedit_open", { path, password: password ?? null });
export const pdfClose = (id: number) => call<void>("pdfedit_close", { id });
export const pdfObjects = (id: number, page: number) => call<PdfObject[]>("pdfedit_objects", { id, page });
export const pdfDeleteObjects = (id: number, page: number, ids: number[]) =>
  call<ApplyResult>("pdfedit_apply", { id, page, ids, action: { kind: "delete", matrix: null } });
export const pdfTransformObjects = (id: number, page: number, ids: number[], matrix: number[]) =>
  call<ApplyResult>("pdfedit_apply", { id, page, ids, action: { kind: "transform", matrix } });
export const pdfUndo = (id: number) => call<UndoOut | null>("pdfedit_undo", { id });
export const pdfRedo = (id: number) => call<UndoOut | null>("pdfedit_redo", { id });
export const pdfRotatePage = (id: number, page: number, delta: number) => call<PdfPage[]>("pdfedit_rotate_page", { id, page, delta });
export const pdfDeletePage = (id: number, page: number) => call<PdfPage[]>("pdfedit_delete_page", { id, page });
export const pdfMovePage = (id: number, from: number, to: number) => call<PdfPage[]>("pdfedit_move_page", { id, from, to });
export const pdfCanUndo = (id: number) => call<[boolean, boolean]>("pdfedit_can_undo", { id });
export const pdfSave = (id: number, path: string) => call<void>("pdfedit_save", { id, path });
export const pdfText = (id: number) => call<string[]>("pdfedit_text", { id });
export const pdfOcrStatus = () => call<OcrStatus>("pdfedit_ocr_status");
export const pdfOcrPage = (id: number, page: number, lang: string, dpi: number) => call<number>("pdfedit_ocr_page", { id, page, lang, dpi });

/** Pagina disegnata come immagine PNG. */
export async function pdfRender(id: number, page: number, dpi: number): Promise<Blob> {
  const data = await call<ArrayBuffer>("pdfedit_render", { id, page, dpi });
  return new Blob([data], { type: "image/png" });
}
