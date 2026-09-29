// findings.mjs — what GeoVivé does with each kind of finding about a layer.
//
// audience   owner:   the app's owner is told so they can fix it in their own systems
//            geovive: kept by GeoVivé only (possible legal escalation); the owner is
//                     told only that the layer is held for review
// schedule   immediate | weekly   when owner notices go out
// hold       review: a person decides before the layer shows
//            note:   the layer can show; the owner is asked to fix it
//            reject: never shown

export const CATEGORIES = {
  personal_info: { label: "Personal information", audience: "owner", schedule: "immediate", hold: "review",
    guidance: "Remove values that identify people (names with contact details, emails, phone numbers, home addresses) from the fields you show." },
  offensive:     { label: "Offensive or abusive content", audience: "owner", schedule: "immediate", hold: "review",
    guidance: "Remove slurs, harassment or graphic content from labels and shown fields." },
  misleading:    { label: "Misleading content", audience: "owner", schedule: "weekly", hold: "review",
    guidance: "Make sure the layer's name, description and values match what the data actually shows, and that official-looking claims are accurate." },
  data_quality:  { label: "Data quality", audience: "owner", schedule: "weekly", hold: "note",
    guidance: "Check the flagged values or shapes at the source (placeholders, obviously wrong values, duplicates)." },
  licensing:     { label: "Credits and licensing", audience: "owner", schedule: "weekly", hold: "note",
    guidance: "Name the data's real source and terms in attribution and license." },
  criminal:      { label: "Possible criminal content", audience: "geovive", hold: "review" },
  cyber:         { label: "Possible security threat", audience: "geovive", hold: "review" },
  targeting:     { label: "Possible targeting of people or protected sites", audience: "geovive", hold: "review" }
};

export const OWNER_CATEGORIES = Object.keys(CATEGORIES).filter(k => CATEGORIES[k].audience === "owner");
export const RETAINED_CATEGORIES = Object.keys(CATEGORIES).filter(k => CATEGORIES[k].audience === "geovive");

// Rule-based findings from checkLayer() map onto the same categories.
export function categoryOfIssue(text) {
  if (/personal information/i.test(text)) return "personal_info";
  if (/licen[cs]e|attribution/i.test(text)) return "licensing";
  if (/coordinates|shapes|limit/i.test(text)) return "data_quality";
  return null;
}
