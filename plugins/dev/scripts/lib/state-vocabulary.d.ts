export interface Gloss {
  term: string;
  plainLabel: string;
  whatsNext: string;
  who: string;
  ifNobody: string;
}

export declare const VOCABULARY_TERMS: ReadonlyArray<string>;

export declare function glossFor(term: string): Gloss;
