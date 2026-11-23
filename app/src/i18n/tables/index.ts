// Ogni file contiene le frasi di una parte dell'applicazione: [it, en, es, fr, de, pt].
// La chiave è il testo italiano così com'è nel codice (vedi ../index.ts).
export type Row = readonly [it: string, en: string, es: string, fr: string, de: string, pt: string];

import { CONTENT } from "./content";
import { FUNCTIONS } from "./functions";
import { NOTICES } from "./notices";
import { SLIDES } from "./slides";
import { UI } from "./ui";

export const ROWS: readonly Row[] = [...UI, ...CONTENT, ...FUNCTIONS, ...SLIDES, ...NOTICES];
