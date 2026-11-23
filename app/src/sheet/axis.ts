/**
 * Posizioni di righe o colonne con dimensioni variabili.
 * Le somme progressive sono calcolate solo fin dove serve e rifatte quando
 * cambia una dimensione: così anche 1.048.576 righe restano veloci.
 * Gli indici partono da 1, come in IronCalc ed Excel.
 */
export class Axis {
  private prefix = new Float64Array(1024); // prefix[n] = somma delle dimensioni 1..n
  private known = 0;

  constructor(private readonly max: number, private readonly sizeOf: (i: number) => number) {}

  invalidate(): void {
    this.known = 0;
  }

  size(i: number): number {
    return this.sizeOf(i);
  }

  private ensure(n: number): void {
    n = Math.min(n, this.max);
    if (n <= this.known) return;
    if (n >= this.prefix.length) {
      const next = new Float64Array(Math.min(this.max + 1, Math.max(n + 1, this.prefix.length * 2)));
      next.set(this.prefix.subarray(0, this.known + 1));
      this.prefix = next;
    }
    for (let i = this.known + 1; i <= n; i++) this.prefix[i] = this.prefix[i - 1] + this.sizeOf(i);
    this.known = n;
  }

  /** Posizione di inizio dell'elemento i (in unità non zoomate). */
  start(i: number): number {
    this.ensure(i - 1);
    return this.prefix[i - 1];
  }

  /** Posizione di fine degli elementi 1..n. */
  total(n: number): number {
    this.ensure(n);
    return this.prefix[n];
  }

  /** Indice dell'elemento che contiene la posizione `pos`. */
  indexAt(pos: number): number {
    if (pos <= 0) return 1;
    while (this.known < this.max && this.prefix[this.known] <= pos) this.ensure(Math.min(this.max, this.known * 2 + 256));
    let lo = 1, hi = this.known;
    while (lo < hi) {
      const mid = (lo + hi) >> 1;
      if (this.prefix[mid] <= pos) lo = mid + 1;
      else hi = mid;
    }
    return lo;
  }
}
