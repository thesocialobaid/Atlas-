// Singular forms for nested route parameters (Rails' :photo_id, Laravel's
// {photo}). Both frameworks singularise with their own inflector, and the two
// disagree on edge cases (Rails makes "drives" into "drife"). Only the forms
// both agree on are produced here; for anything else this returns null and
// the route is withheld rather than shown with a parameter name that might be
// wrong.

const UNCOUNTABLE = new Set(["equipment", "information", "rice", "money", "species", "series", "fish", "sheep", "police", "news"]);
const IRREGULAR = new Map([
  ["people", "person"],
  ["men", "man"],
  ["women", "woman"],
  ["children", "child"],
  ["movies", "movie"],
  ["statuses", "status"],
  ["aliases", "alias"],
  ["buses", "bus"],
  ["quizzes", "quiz"],
]);
// Endings where the two inflectors part ways, or where a word could be either form.
const RISKY = /(ves|oes|ses|ss|us|is|[aeiou]ches|axes|ices|ae|i)$/;

/** The singular both Rails and Laravel would produce, or null. Applies to the last word of snake_case. */
export function singular(word: string): string | null {
  const cut = Math.max(word.lastIndexOf("_"), word.lastIndexOf("-"));
  const head = word.slice(0, cut + 1);
  const last = word.slice(cut + 1).toLowerCase();
  if (last !== word.slice(cut + 1)) return null;
  if (UNCOUNTABLE.has(last)) return word;
  const irregular = IRREGULAR.get(last);
  if (irregular) return head + irregular;
  if (/sses$/.test(last)) return head + last.slice(0, -2);
  if (RISKY.test(last)) return null;
  if (/[^aeiouy]ies$/.test(last) && last.length > 4) return head + last.slice(0, -3) + "y";
  if (/(shes|[^aeiou]ches|xes)$/.test(last)) return head + last.slice(0, -2);
  if (/[^s]s$/.test(last)) return head + last.slice(0, -1);
  return null;
}
