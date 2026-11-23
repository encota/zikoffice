import { langInfo, t } from "../i18n";
import { Model } from "./engine";

// Generato da IronCalc 0.9.1 (nomi delle funzioni in italiano). Non modificare a mano l'elenco.
// Il programma lo traduce nella lingua scelta con `functionNames()` / `functionHelp()` (in fondo al file).
export const FUNCTION_NAMES_IT: readonly string[] = ["ADESSO", "AMBIENTE.INFO", "AMMORT", "AMMORT.ANNUO", "AMMORT.COST", "AMMORT.DEGR", "AMMORT.FISSO", "AMMORT.PER", "AMMORT.VAR", "ANNO", "ANNULLA.SPAZI", "ARABO", "ARCCOS", "ARCCOSH", "ARCCOT", "ARCCOTH", "ARCSEN", "ARCSENH", "ARCTAN", "ARCTAN.2", "ARCTANH", "AREE", "ARRAYTOTEXT", "ARROTONDA", "ARROTONDA.DIFETTO", "ARROTONDA.DIFETTO.MAT", "ARROTONDA.DIFETTO.PRECISA", "ARROTONDA.ECCESSO", "ARROTONDA.ECCESSO.MAT", "ARROTONDA.ECCESSO.PRECISA", "ARROTONDA.MULTIPLO", "ARROTONDA.PER.DIF", "ARROTONDA.PER.ECC", "ASC", "ASIMMETRIA", "ASIMMETRIA.P", "ASS", "BASE", "BESSEL.I", "BESSEL.J", "BESSEL.K", "BESSEL.Y", "BETADIST", "BETAINV", "BINARIO.DECIMALE", "BINARIO.HEX", "BINARIO.OCT", "BINOMDIST", "BIT.SPOSTA.DX", "BIT.SPOSTA.SX", "BITAND", "BITOR", "BITXOR", "BOT.EQUIV", "BOT.PREZZO", "BOT.REND", "BYCOL", "BYROW", "CAP.CUM", "CASUALE", "CASUALE.TRA", "CELLA", "CERCA", "CERCA.ORIZZ", "CERCA.VERT", "CERCA.X", "CHIDIST", "CHIINV", "CHITEST", "CHOOSECOLS", "CHOOSEROWS", "CODICE", "CODICE.CARATT", "CODIFICA.URL", "COLLEG.IPERTESTUALE", "COLONNE", "COMBINAZIONE", "COMBINAZIONE.VALORI", "COMP.ARGOMENTO", "COMP.CONIUGATO", "COMP.COS", "COMP.COSH", "COMP.COT", "COMP.CSC", "COMP.CSCH", "COMP.DIFF", "COMP.DIV", "COMP.EXP", "COMP.IMMAGINARIO", "COMP.LN", "COMP.LOG10", "COMP.LOG2", "COMP.MODULO", "COMP.PARTE.REALE", "COMP.POTENZA", "COMP.PRODOTTO", "COMP.RADQ", "COMP.SEC", "COMP.SECH", "COMP.SEN", "COMP.SENH", "COMP.SOMMA", "COMP.TAN", "COMPLESSO", "CONCAT", "CONCATENA", "CONFIDENCE", "CONFIDENZA.NORM", "CONFIDENZA.T", "CONFRONTA", "CONTA.NUMERI", "CONTA.PIÙ.SE", "CONTA.SE", "CONTA.VALORI", "CONTA.VUOTE", "CONVERTI", "CORRELAZIONE", "COS", "COSH", "COT", "COTH", "COVAR", "COVARIANZA.C", "COVARIANZA.P", "CRESCITA", "CRITBINOM", "CSC", "CSCH", "CURTOSI", "DATA", "DATA.DIFF", "DATA.MESE", "DATA.VALORE", "DB.CONTA.NUMERI", "DB.CONTA.VALORI", "DB.DEV.ST", "DB.DEV.ST.POP", "DB.MAX", "DB.MEDIA", "DB.MIN", "DB.PRODOTTO", "DB.SOMMA", "DB.VALORI", "DB.VAR", "DB.VAR.POP", "DECIMALE", "DECIMALE.BINARIO", "DECIMALE.HEX", "DECIMALE.OCT", "DELTA", "DESTRA", "DESTRAB", "DEV.Q", "DEV.ST", "DEV.ST.C", "DEV.ST.P", "DEV.ST.POP.VALORI", "DEV.ST.VALORI", "DISPARI", "DISTRIB.BETA.N", "DISTRIB.BINOM.N", "DISTRIB.BINOM.NEG.N", "DISTRIB.CHI.QUAD", "DISTRIB.CHI.QUAD.DS", "DISTRIB.EXP.N", "DISTRIB.F.DS", "DISTRIB.GAMMA.N", "DISTRIB.IPERGEOM.N", "DISTRIB.LOGNORM.N", "DISTRIB.NORM.N", "DISTRIB.NORM.ST.N", "DISTRIB.POISSON", "DISTRIB.PROB", "DISTRIB.T.2T", "DISTRIB.T.DS", "DISTRIB.T.N", "DISTRIB.WEIBULL", "DISTRIBF", "DIVIDI.TESTO", "DOLLARO", "DROP", "DURATA", "DURATA.M", "DURATA.P", "E", "ECMA.CEILING", "EFFETTIVO", "ERR.STD.YX", "ERRORE.TIPO", "EXP", "EXPAND", "EXPONDIST", "FALSO", "FATT.DOPPIO", "FATTORIALE", "FDIST", "FILTRO", "FINE.MESE", "FINV", "FISHER", "FISSO", "FOGLI", "FOGLIO", "FRAZIONE.ANNO", "FREQUENZA", "FTEST", "FUNZ.ERRORE", "FUNZ.ERRORE.COMP", "FUNZ.ERRORE.COMP.PRECISA", "FUNZ.ERRORE.PRECISA", "GAMMA", "GAMMADIST", "GAMMAINV", "GAUSS", "GIORNI", "GIORNI.CED", "GIORNI.CED.INIZ.LIQ", "GIORNI.CED.NUOVI", "GIORNI.LAVORATIVI.TOT", "GIORNI.LAVORATIVI.TOT.INTL", "GIORNO", "GIORNO.LAVORATIVO", "GIORNO.LAVORATIVO.INTL", "GIORNO.SETTIMANA", "GIORNO360", "GRADI", "GRANDE", "HEX.BINARIO", "HEX.DECIMALE", "HEX.OCT", "HSTACK", "HYPGEOMDIST", "IDENTICO", "INDICE", "INDIRETTO", "INDIRIZZO", "INT", "INT.CUMUL", "INT.MATURATO.PER", "INT.MATURATO.SCAD", "INTERCETTA", "INTERESSE.RATA", "INTERESSI", "INTERESSI.RATA", "INTERVALLO.DISTRIB.BINOM.N.", "INV.BETA.N", "INV.BINOM", "INV.CHI.QUAD", "INV.CHI.QUAD.DS", "INV.F.DS", "INV.FISHER", "INV.GAMMA.N", "INV.LOGNORM.N", "INV.NORM.N", "INV.NORM.S", "INV.T.2T", "INVF", "INVT", "ISO.ARROTONDA.ECCESSO", "ISOMITTED", "LAMBDA", "LET", "LIBERA", "LN", "LN.GAMMA", "LN.GAMMA.PRECISA", "LOG", "LOG10", "LOGINV", "LOGNORMDIST", "LUNGHEZZA", "LUNGHEZZAB", "MAIUSC", "MAIUSC.INIZ", "MAKEARRAY", "MAP", "MATR.CASUALE", "MATR.DETERM", "MATR.INVERSA", "MATR.PRODOTTO", "MATR.SOMMA.PRODOTTO", "MATR.TRASPOSTA", "MAX", "MAX.PIÙ.SE", "MAX.VALORI", "MCD", "MCM", "MEDIA", "MEDIA.ARMONICA", "MEDIA.DEV", "MEDIA.GEOMETRICA", "MEDIA.PIÙ.SE", "MEDIA.SE", "MEDIA.TRONCATA", "MEDIA.VALORI", "MEDIANA", "MESE", "MIN", "MIN.PIÙ.SE", "MIN.VALORI", "MINUSC", "MINUTO", "MODA.MULT", "MODA.UNO", "MODE", "MULTINOMIALE", "MUNIT", "NEGBINOMDIST", "NOMINALE", "NON", "NON.DISP", "NORMALIZZA", "NORMDIST", "NORMINV", "NORMSDIST", "NORMSINV", "NUM", "NUM.CED", "NUM.RATE", "NUM.SETTIMANA", "NUM.SETTIMANA.ISO", "O", "OCT.BINARIO", "OCT.DECIMALE", "OCT.HEX", "OGGI", "ORA", "ORARIO", "ORARIO.VALORE", "ORDINA", "ORDINAPER", "P.RATA", "PARI", "PEARSON", "PENDENZA", "PERCENTILE", "PERCENTILE.ESCL", "PERCENTILE.INCL", "PERCENTRANK", "PERCENTUALE.DI", "PERMUT", "PERMUTAZIONE", "PHI", "PI.GRECO", "PICCOLO", "PIÙ.SE", "POISSON", "POTENZA", "PREVISIONE", "PREVISIONE.ETS", "PREVISIONE.ETS.INTCONFIDENZA", "PREVISIONE.ETS.STAGIONALITÀ", "PREVISIONE.ETS.STAT", "PREVISIONE.LINEARE", "PREZZO", "PREZZO.PRIMO.IRREGOLARE", "PREZZO.SCAD", "PREZZO.SCONT", "PREZZO.ULT.IRREGOLARE", "PRODOTTO", "PROSSIMA.SCAD.CED", "QUARTILE", "QUARTILE.ESCL", "QUARTILE.INCL", "QUOZIENTE", "RADIANTI", "RADQ", "RADQ.PI.GRECO", "RANGO.MEDIA", "RANGO.PERCENTUALE.ESCL", "RANGO.PERCENTUALE.INCL", "RANGO.UG", "RANK", "RATA", "REDUCE", "REGEXEXTRACT", "REGEXREPLACE", "REGEXTEST", "REGR.LIN", "REGR.LOG", "REND.PRIMO.IRREGOLARE", "REND.SCAD", "REND.TITOLO", "REND.TITOLO.SCONT", "REND.ULT.IRREGOLARE", "RESTO", "RICERCA", "RICERCAB", "RIF.COLONNA", "RIF.RIGA", "RIGHE", "RIMPIAZZA", "RIMPIAZZAB", "RIPETI", "RIT.INVEST.EFFETT", "ROMANO", "RQ", "SCAD.CED.PREC", "SCAN", "SCARTO", "SCEGLI", "SE", "SE.ERRORE", "SE.NON.DISP.", "SEC", "SECH", "SECONDO", "SEGNO", "SEN", "SENH", "SEQUENZA", "SINISTRA", "SINISTRAB", "SOGLIA", "SOMMA", "SOMMA.DIFF.Q", "SOMMA.PIÙ.SE", "SOMMA.Q", "SOMMA.Q.DIFF", "SOMMA.SE", "SOMMA.SERIE", "SOMMA.SOMMA.Q", "SOSTITUISCI", "STDEVP", "STRINGA.ESTRAI", "STRINGA.ESTRAIB", "SUBTOTALE", "SWITCH", "T", "TAKE", "TAN", "TANH", "TASSO", "TASSO.INT", "TASSO.SCONTO", "TDIST", "TENDENZA", "TEST.CHI.QUAD", "TESTF", "TESTO", "TESTO.DOPO", "TESTO.FORMULA", "TESTO.PRIMA", "TESTO.UNISCI", "TESTT", "TESTZ", "TINV", "TIPO", "TIR.COST", "TIR.VAR", "TIR.X", "TOCOL", "TOROW", "TRIMRANGE", "TRONCA", "TROVA", "TROVAB", "TTEST", "UNICHAR", "UNICO", "UNICODE", "VA", "VAL.DISPARI", "VAL.ERR", "VAL.ERRORE", "VAL.FORMULA", "VAL.FUT", "VAL.FUT.CAPITALE", "VAL.LOGICO", "VAL.NON.DISP", "VAL.NON.TESTO", "VAL.NUMERO", "VAL.PARI", "VAL.RIF", "VAL.TESTO", "VAL.VUOTO", "VALORE", "VALORE.A.TESTO", "VALORE.NUMERO", "VALUTA.DEC", "VALUTA.FRAZ", "VAN", "VAN.X", "VAR", "VAR.C", "VAR.P", "VAR.POP.VALORI", "VAR.VALORI", "VARP", "VERO", "VSTACK", "WEIBULL", "WRAPCOLS", "WRAPROWS", "XMATCH", "XOR", "ZTEST"];

/** Sintassi e descrizione delle funzioni più usate (in italiano; chiave = nome italiano). */
export const FUNCTION_HELP_IT: Readonly<Record<string, readonly [string, string]>> = {
 "SOMMA": [
  "SOMMA(num1; [num2]; …)",
  "Somma i numeri o gli intervalli indicati"
 ],
 "SOMMA.SE": [
  "SOMMA.SE(intervallo; criterio; [int_somma])",
  "Somma le celle che soddisfano un criterio"
 ],
 "SOMMA.PIÙ.SE": [
  "SOMMA.PIÙ.SE(int_somma; int_criteri1; criterio1; …)",
  "Somma le celle che soddisfano più criteri"
 ],
 "MEDIA": [
  "MEDIA(num1; [num2]; …)",
  "Media aritmetica"
 ],
 "MEDIA.SE": [
  "MEDIA.SE(intervallo; criterio; [int_media])",
  "Media delle celle che soddisfano un criterio"
 ],
 "CONTA.NUMERI": [
  "CONTA.NUMERI(val1; …)",
  "Conta le celle che contengono numeri"
 ],
 "CONTA.VALORI": [
  "CONTA.VALORI(val1; …)",
  "Conta le celle non vuote"
 ],
 "CONTA.VUOTE": [
  "CONTA.VUOTE(intervallo)",
  "Conta le celle vuote"
 ],
 "CONTA.SE": [
  "CONTA.SE(intervallo; criterio)",
  "Conta le celle che soddisfano un criterio"
 ],
 "CONTA.PIÙ.SE": [
  "CONTA.PIÙ.SE(int1; criterio1; …)",
  "Conta le celle che soddisfano più criteri"
 ],
 "MAX": [
  "MAX(num1; …)",
  "Valore massimo"
 ],
 "MIN": [
  "MIN(num1; …)",
  "Valore minimo"
 ],
 "SE": [
  "SE(test; se_vero; [se_falso])",
  "Restituisce un valore se la condizione è vera, un altro se è falsa"
 ],
 "SE.ERRORE": [
  "SE.ERRORE(valore; se_errore)",
  "Restituisce se_errore se il valore è un errore"
 ],
 "PIÙ.SE": [
  "PIÙ.SE(test1; valore1; …)",
  "Verifica più condizioni in ordine"
 ],
 "E": [
  "E(logico1; …)",
  "VERO se tutte le condizioni sono vere"
 ],
 "O": [
  "O(logico1; …)",
  "VERO se almeno una condizione è vera"
 ],
 "NON": [
  "NON(logico)",
  "Inverte VERO e FALSO"
 ],
 "CERCA.VERT": [
  "CERCA.VERT(valore; tabella; indice_col; [intervallo])",
  "Cerca un valore nella prima colonna e restituisce un valore della stessa riga"
 ],
 "CERCA.ORIZZ": [
  "CERCA.ORIZZ(valore; tabella; indice_riga; [intervallo])",
  "Cerca un valore nella prima riga"
 ],
 "CERCA.X": [
  "CERCA.X(valore; matrice_ricerca; matrice_restituita; …)",
  "Ricerca moderna in righe o colonne"
 ],
 "INDICE": [
  "INDICE(matrice; riga; [col])",
  "Valore alla posizione indicata"
 ],
 "CONFRONTA": [
  "CONFRONTA(valore; matrice; [tipo])",
  "Posizione di un valore in un intervallo"
 ],
 "ARROTONDA": [
  "ARROTONDA(num; cifre)",
  "Arrotonda al numero di cifre indicato"
 ],
 "ARROTONDA.PER.ECC": [
  "ARROTONDA.PER.ECC(num; cifre)",
  "Arrotonda per eccesso"
 ],
 "ARROTONDA.PER.DIF": [
  "ARROTONDA.PER.DIF(num; cifre)",
  "Arrotonda per difetto"
 ],
 "INT": [
  "INT(num)",
  "Parte intera"
 ],
 "ASS": [
  "ASS(num)",
  "Valore assoluto"
 ],
 "RADQ": [
  "RADQ(num)",
  "Radice quadrata"
 ],
 "POTENZA": [
  "POTENZA(num; esponente)",
  "Elevamento a potenza"
 ],
 "RESTO": [
  "RESTO(num; divisore)",
  "Resto della divisione"
 ],
 "OGGI": [
  "OGGI()",
  "Data di oggi"
 ],
 "ADESSO": [
  "ADESSO()",
  "Data e ora attuali"
 ],
 "DATA": [
  "DATA(anno; mese; giorno)",
  "Crea una data"
 ],
 "ANNO": [
  "ANNO(data)",
  "Anno di una data"
 ],
 "MESE": [
  "MESE(data)",
  "Mese di una data"
 ],
 "GIORNO": [
  "GIORNO(data)",
  "Giorno di una data"
 ],
 "GIORNO.SETTIMANA": [
  "GIORNO.SETTIMANA(data; [tipo])",
  "Giorno della settimana come numero"
 ],
 "GIORNI.LAVORATIVI.TOT": [
  "GIORNI.LAVORATIVI.TOT(inizio; fine; [festivi])",
  "Giorni lavorativi tra due date"
 ],
 "CONCATENA": [
  "CONCATENA(testo1; …)",
  "Unisce più testi"
 ],
 "CONCAT": [
  "CONCAT(testo1; …)",
  "Unisce più testi o intervalli"
 ],
 "TESTO.UNISCI": [
  "TESTO.UNISCI(delimitatore; ignora_vuote; testo1; …)",
  "Unisce testi con un separatore"
 ],
 "TESTO": [
  "TESTO(valore; formato)",
  "Converte un numero in testo con un formato"
 ],
 "SINISTRA": [
  "SINISTRA(testo; [num])",
  "Primi caratteri di un testo"
 ],
 "DESTRA": [
  "DESTRA(testo; [num])",
  "Ultimi caratteri di un testo"
 ],
 "STRINGA.ESTRAI": [
  "STRINGA.ESTRAI(testo; inizio; num)",
  "Caratteri dal centro di un testo"
 ],
 "LUNGHEZZA": [
  "LUNGHEZZA(testo)",
  "Numero di caratteri"
 ],
 "MAIUSC": [
  "MAIUSC(testo)",
  "Tutto maiuscolo"
 ],
 "MINUSC": [
  "MINUSC(testo)",
  "Tutto minuscolo"
 ],
 "MAIUSC.INIZ": [
  "MAIUSC.INIZ(testo)",
  "Iniziali maiuscole"
 ],
 "ANNULLA.SPAZI": [
  "ANNULLA.SPAZI(testo)",
  "Toglie gli spazi in eccesso"
 ],
 "SOSTITUISCI": [
  "SOSTITUISCI(testo; vecchio; nuovo; [occorrenza])",
  "Sostituisce un testo con un altro"
 ],
 "TROVA": [
  "TROVA(cercato; testo; [inizio])",
  "Posizione di un testo (maiuscole distinte)"
 ],
 "RICERCA": [
  "RICERCA(cercato; testo; [inizio])",
  "Posizione di un testo"
 ],
 "RATA": [
  "RATA(tasso; periodi; va; [vf]; [tipo])",
  "Rata di un prestito"
 ],
 "VAL.FUT": [
  "VAL.FUT(tasso; periodi; rata; [va]; [tipo])",
  "Valore futuro di un investimento"
 ],
 "VA": [
  "VA(tasso; periodi; rata; [vf]; [tipo])",
  "Valore attuale"
 ],
 "MEDIANA": [
  "MEDIANA(num1; …)",
  "Valore mediano"
 ],
 "DEV.ST": [
  "DEV.ST(num1; …)",
  "Deviazione standard di un campione"
 ],
 "FILTRO": [
  "FILTRO(matrice; includi; [se_vuoto])",
  "Filtra un intervallo"
 ],
 "ORDINA": [
  "ORDINA(matrice; …)",
  "Ordina un intervallo"
 ],
 "SEQUENZA": [
  "SEQUENZA(righe; [colonne]; [inizio]; [passo])",
  "Sequenza di numeri"
 ],
 "VAL.NUMERO": [
  "VAL.NUMERO(valore)",
  "VERO se è un numero"
 ],
 "VAL.VUOTO": [
  "VAL.VUOTO(valore)",
  "VERO se la cella è vuota"
 ],
 "VAL.ERRORE": [
  "VAL.ERRORE(valore)",
  "VERO se è un errore"
 ],
 "VAL.TESTO": [
  "VAL.TESTO(valore)",
  "VERO se è un testo"
 ],
 "SUBTOTALE": [
  "SUBTOTALE(funzione; rif1; …)",
  "Subtotale che ignora le righe nascoste dai filtri"
 ],
 "PRODOTTO": [
  "PRODOTTO(num1; …)",
  "Moltiplica i numeri"
 ],
 "MATR.SOMMA.PRODOTTO": [
  "MATR.SOMMA.PRODOTTO(matrice1; …)",
  "Somma dei prodotti"
 ],
 "CASUALE": [
  "CASUALE()",
  "Numero casuale tra 0 e 1"
 ],
 "CASUALE.TRA": [
  "CASUALE.TRA(min; max)",
  "Intero casuale tra due valori"
 ],
 "DATA.DIFF": [
  "DATA.DIFF(inizio; fine; unità)",
  "Differenza tra date in giorni, mesi o anni"
 ],
 "FINE.MESE": [
  "FINE.MESE(data; mesi)",
  "Ultimo giorno del mese"
 ],
 "DATA.MESE": [
  "DATA.MESE(data; mesi)",
  "Aggiunge mesi a una data"
 ],
 "COLLEG.IPERTESTUALE": [
  "COLLEG.IPERTESTUALE(indirizzo; [nome])",
  "Crea un collegamento"
 ]
};

// ---------- nei nomi della lingua scelta ----------

interface Localized { names: string[]; fromLocal: Map<string, string>; toLocal: Map<string, string> }
const localized = new Map<string, Localized>();

/** Nomi delle funzioni (e corrispondenza con quelli italiani) nella lingua delle formule in uso. */
function loc(): Localized {
  const language = langInfo().sheetLanguage;
  let hit = localized.get(language);
  if (hit) return hit;
  const names: string[] = [];
  const fromLocal = new Map<string, string>(), toLocal = new Map<string, string>();
  if (language === "it") {
    for (const n of FUNCTION_NAMES_IT) { names.push(n); fromLocal.set(n, n); toLocal.set(n, n); }
  } else {
    // Il file non dipende dalla lingua: si scrive ogni funzione in italiano e la si rilegge nella lingua scelta.
    const it = new Model("x", "it", "UTC", "it");
    FUNCTION_NAMES_IT.forEach((n, i) => { try { it.setUserInput(0, i + 1, 1, `=${n}(1)`); } catch { /* firma non valida: ignora */ } });
    const other = Model.fromBytes(it.toBytes(), language);
    FUNCTION_NAMES_IT.forEach((n, i) => {
      let content = "";
      try { content = other.getCellContent(0, i + 1, 1); } catch { /* ignora */ }
      const m = /^=(.+)\(1\)$/.exec(content);
      const local = m ? m[1] : n;
      if (!fromLocal.has(local)) { names.push(local); fromLocal.set(local, n); }
      toLocal.set(n, local);
    });
    names.sort((a, b) => a.localeCompare(b));
  }
  hit = { names, fromLocal, toLocal };
  localized.set(language, hit);
  return hit;
}

/** Elenco per i suggerimenti mentre si scrive una formula. */
export function functionNames(): readonly string[] { return loc().names; }

const ARG = /^([A-Za-zÀ-ù_.]+?)(\d*)$/;

/** Sintassi e descrizione di una funzione, dato il nome così com'è scritto nella lingua in uso. */
export function functionHelp(name: string): readonly [string, string] | undefined {
  const l = loc();
  const it = l.fromLocal.get(name);
  const base = it ? FUNCTION_HELP_IT[it] : undefined;
  if (!base) return undefined;
  if (langInfo().id === "it") return base;
  const open = base[0].indexOf("(");
  const args = base[0].slice(open).replace(/[A-Za-zÀ-ù_.0-9]+/g, (w) => {
    const m = ARG.exec(w);
    return m ? t("fx:" + m[1]).replace(/^fx:/, "") + m[2] : w;
  });
  const sep = langInfo().sheetLocale === "en" ? ", " : "; ";
  return [`${l.toLocal.get(it!) ?? name}${args.replace(/; /g, sep)}`, t(base[1])];
}

/** Nome di una funzione (scritto in italiano nel codice) nella lingua delle formule in uso. */
export function fn(italian: string): string { return loc().toLocal.get(italian) ?? italian; }

/** Un numero come si scrive in una formula nella lingua in uso (0,22 oppure 0.22). */
export function num(x: number): string { return langInfo().sheetLocale === "en" ? String(x) : String(x).replace(".", ","); }
