// Cheap Spanish-vs-English guess for a passage fragment. Shared by the
// chunk-and-gloss Edge Function and the client (no imports, no runtime APIs).
//
// The pipeline itself lets the model detect the input language, but two places
// need to know it without the model: the Edge Function's omission check (only
// meaningful when the source is Spanish, where tlText must reproduce the input)
// and the client's failure handling, which treats a failed English batch as a
// hole in the book (retry with shifted boundaries, render the English) and a
// failed Spanish batch as a missing gloss (render the Spanish).

const SPANISH_WORDS = new Set([
  'el', 'la', 'los', 'las', 'que', 'y', 'en', 'un', 'una', 'es', 'por', 'con', 'se',
  'del', 'al', 'lo', 'como', 'pero', 'su', 'sus', 'más', 'le', 'ya', 'muy', 'sin',
  'sobre', 'también', 'fue', 'era', 'está', 'yo', 'él', 'ella', 'porque', 'cuando',
  'donde', 'todo', 'hay', 'nos', 'mi', 'me', 'este', 'esta', 'para',
]);

const ENGLISH_WORDS = new Set([
  'the', 'and', 'of', 'to', 'is', 'in', 'that', 'it', 'was', 'he', 'she', 'with',
  'for', 'as', 'his', 'her', 'you', 'i', 'on', 'at', 'but', 'not', 'be', 'had',
  'have', 'they', 'this', 'which', 'were', 'from', 'by', 'would', 'there', 'their',
  'what', 'an', 'my', 'we', 'been', 'will', 'into', 'could', 'said',
]);

export type SourceLanguage = 'es' | 'en';

export function detectSourceLanguage(text: string): SourceLanguage {
  const lower = text.toLowerCase();
  // Spanish-only characters are strong evidence on their own.
  let es = (lower.match(/[ñ¿¡áéíóú]/g) ?? []).length * 2;
  let en = 0;
  for (const w of lower.match(/[a-zñáéíóúü']+/g) ?? []) {
    if (SPANISH_WORDS.has(w)) es++;
    if (ENGLISH_WORDS.has(w)) en++;
  }
  return en > es ? 'en' : 'es';
}
