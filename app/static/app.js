"use strict";

const state = { flights: [], cfg: {}, editingId: null, openId: null, pendingDelete: null };
const $ = (s) => document.querySelector(s);
const NUMS = ["day_to", "night_to", "day_ldg", "night_ldg", "approaches", "se", "me", "xc", "night",
  "actual", "hood", "pic", "dual", "ground", "total", "page"];
const TEXTS = ["date", "aircraft_type", "tail", "dep", "arr", "via", "instructor", "remarks", "notes"];

// ---------- helpers ----------
function el(tag, attrs = {}, ...kids) {
  const n = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (v == null || v === false) continue;
    if (k === "class") n.className = v;
    else if (k.startsWith("on")) n.addEventListener(k.slice(2), v);
    else n.setAttribute(k, v === true ? "" : v);
  }
  for (const k of kids.flat()) if (k != null && k !== false) n.append(k instanceof Node ? k : String(k));
  return n;
}
const num = (v) => (v == null || v === "" ? 0 : Number(v));
const hrs = (v) => (num(v) ? num(v).toFixed(1) : "");
const cnt = (v) => (num(v) ? String(Math.round(num(v))) : "");
const sum = (rows, k) => rows.reduce((a, r) => a + num(r[k]), 0);
const parseDate = (s) => { const [y, m, d] = s.split("-").map(Number); return new Date(y, m - 1, d); };
const fmtDate = (s) => parseDate(s).toLocaleDateString(undefined, { year: "numeric", month: "short", day: "numeric" });
const daysBetween = (a, b) => Math.round((b - a) / 86400000);
function endOfMonthPlus(d, months) { return new Date(d.getFullYear(), d.getMonth() + months + 1, 0); }
function route(f) {
  const parts = [f.dep || "", ...(f.via ? f.via.split(/\s*,\s*/) : []), f.arr || ""].filter(Boolean);
  return parts.join(" → ");
}
function toast(msg) {
  const t = $("#toast"); t.textContent = msg; t.hidden = false;
  clearTimeout(toast._t); toast._t = setTimeout(() => (t.hidden = true), 2600);
}
async function api(path, opts = {}) {
  const res = await fetch(path, {
    credentials: "same-origin",
    ...opts,
    headers: { "Content-Type": "application/json", "X-Flightlog": "1", ...(opts.headers || {}) },
  });
  if (!res.ok) {
    let msg = res.statusText;
    try {
      const j = await res.json();
      msg = typeof j.detail === "string" ? j.detail
        : Array.isArray(j.detail) ? j.detail.map((d) => `${d.loc.slice(-1)[0]}: ${d.msg}`).join("; ") : msg;
    } catch {}
    throw new Error(msg);
  }
  return res.json();
}

// ---------- rendering ----------
function renderStats() {
  const F = state.flights;
  const tiles = [
    ["Total time", hrs(sum(F, "total")) || "0.0", "hero"],
    ["PIC", hrs(sum(F, "pic"))],
    ["Dual received", hrs(sum(F, "dual"))],
    ["Cross-country", hrs(sum(F, "xc"))],
    ["Night", hrs(sum(F, "night"))],
    ["Instrument", `${hrs(sum(F, "actual")) || "0.0"} / ${hrs(sum(F, "hood")) || "0.0"}`, "", "actual / hood"],
    ["Landings", `${cnt(sum(F, "day_ldg"))} / ${cnt(sum(F, "night_ldg"))}`, "", "day / night"],
    ["Flights", String(F.length), "", `${cnt(sum(F, "approaches")) || 0} approaches`],
  ];
  $("#stats").replaceChildren(...tiles.map(([k, v, cls, sub]) =>
    el("div", { class: `stat ${cls || ""}` }, el("div", { class: "v" }, v), el("div", { class: "k" }, sub ? `${k} (${sub})` : k))));
}

function renderCurrency() {
  const F = state.flights;
  const today = new Date(); today.setHours(0, 0, 0, 0);
  const items = [];
  const last = F.length ? F[F.length - 1] : null;
  if (last) {
    const ago = daysBetween(parseDate(last.date), today);
    items.push(["Last flight", `${fmtDate(last.date)} · ${last.tail || ""}`, `${ago.toLocaleString()} days ago`, ago > 90 ? "warn" : "ok"]);
  }
  const fr = [...F].reverse().find((f) => f.flight_review);
  if (fr) {
    const exp = endOfMonthPlus(parseDate(fr.date), 24);
    const left = daysBetween(today, exp);
    items.push(["Flight review", `Last ${fmtDate(fr.date)}; good through ${exp.toLocaleDateString(undefined, { month: "short", year: "numeric" })}`,
      left < 0 ? "Expired" : left < 60 ? `${left} days left` : "Current", left < 0 ? "bad" : left < 60 ? "warn" : "ok"]);
  } else {
    items.push(["Flight review", "None marked in the log", "Unknown", "warn"]);
  }
  const cutoff = new Date(today); cutoff.setDate(cutoff.getDate() - 90);
  const recent = F.filter((f) => parseDate(f.date) > cutoff);
  const ldg = sum(recent, "day_ldg") + sum(recent, "night_ldg");
  const nldg = sum(recent, "night_ldg");
  items.push(["Passengers, day", `${cnt(ldg) || 0} landings in the last 90 days (need 3)`, ldg >= 3 ? "Current" : "Not current", ldg >= 3 ? "ok" : "bad"]);
  items.push(["Passengers, night", `${cnt(nldg) || 0} night landings in the last 90 days (need 3 full-stop)`, nldg >= 3 ? "Current" : "Not current", nldg >= 3 ? "ok" : "bad"]);
  const yr = new Date(today); yr.setFullYear(yr.getFullYear() - 1);
  items.push(["Last 12 months", `${hrs(sum(F.filter((f) => parseDate(f.date) > yr), "total")) || "0.0"} hours`, "", ""]);
  $("#currency").replaceChildren(...items.map(([l, sub, pill, cls]) =>
    el("li", {}, el("span", { class: "lbl" }, l, el("span", { class: "sub" }, ...[sub].flat())), pill ? el("span", { class: `pill ${cls}` }, pill) : "")));
}

function renderYears() {
  const F = state.flights;
  if (!F.length) return $("#years").replaceChildren();
  const first = parseDate(F[0].date).getFullYear();
  const lastY = Math.max(new Date().getFullYear(), parseDate(F[F.length - 1].date).getFullYear());
  const by = {};
  F.forEach((f) => { const y = f.date.slice(0, 4); by[y] = (by[y] || 0) + num(f.total); });
  const max = Math.max(...Object.values(by), 1);
  const bars = [];
  for (let y = first; y <= lastY; y++) {
    const v = by[y] || 0;
    bars.push(el("div", { class: `bar ${v ? "" : "empty"}`, title: `${y}: ${v.toFixed(1)} hrs` },
      el("div", { class: "col", style: `height:${Math.max(2, (v / max) * 100)}%` }, v ? el("span", {}, v.toFixed(0)) : ""),
      el("div", { class: "yr" }, `'${String(y).slice(2)}`)));
  }
  $("#years").replaceChildren(...bars);
}

function renderAircraft() {
  const by = {};
  state.flights.forEach((f) => {
    const k = f.tail || "—";
    by[k] = by[k] || { tail: k, type: f.aircraft_type || "", hrs: 0, n: 0 };
    by[k].hrs += num(f.total); by[k].n++;
  });
  const rows = Object.values(by).sort((a, b) => b.hrs - a.hrs).slice(0, 8);
  $("#aircraft").replaceChildren(...rows.map((r) =>
    el("tr", {}, el("td", { class: "t" }, r.tail), el("td", { class: "muted" }, r.type), el("td", { class: "n" }, r.hrs.toFixed(1)))));
}

function filtered() {
  const q = $("#q").value.trim().toLowerCase();
  const y = $("#year").value;
  return state.flights.filter((f) => {
    if (y && !f.date.startsWith(y)) return false;
    if (!q) return true;
    return [f.date, f.aircraft_type, f.tail, f.dep, f.arr, f.via, f.instructor, f.remarks, f.notes]
      .some((v) => v && String(v).toLowerCase().includes(q));
  });
}

function detailRow(f) {
  const dl = el("dl", { class: "detail-grid" });
  const add = (k, v) => { if (v !== "" && v != null) dl.append(el("div", {}, el("dt", {}, k), el("dd", {}, v))); };
  add("Date", fmtDate(f.date));
  add("Aircraft", [f.aircraft_type, f.tail].filter(Boolean).join(" · "));
  add("Route", route(f));
  add("Instructor / examiner", f.instructor);
  add("Takeoffs (day / night)", `${cnt(f.day_to) || 0} / ${cnt(f.night_to) || 0}`);
  add("Landings (day / night)", `${cnt(f.day_ldg) || 0} / ${cnt(f.night_ldg) || 0}`);
  add("Approaches", cnt(f.approaches));
  const times = [["Total", f.total], ["SE", f.se], ["ME", f.me], ["PIC", f.pic], ["Dual", f.dual], ["XC", f.xc],
    ["Night", f.night], ["Actual", f.actual], ["Hood", f.hood], ["Ground", f.ground]]
    .filter(([, v]) => num(v)).map(([k, v]) => `${k} ${hrs(v)}`).join(" · ");
  add("Time", times);
  add("Logbook page", f.page != null ? String(f.page) : "");
  const box = el("div", {}, dl);
  if (f.remarks) box.append(el("div", { class: "detail-remarks" }, f.remarks));
  if (f.notes) box.append(el("div", { class: "detail-remarks note" }, "Note: ", f.notes));
  if (state.cfg.editor) {
    box.append(el("div", { class: "detail-actions" },
      el("button", { class: "btn sm", onclick: (e) => { e.stopPropagation(); openEdit(f); } }, "Edit"),
      el("button", { class: "btn sm ghost", onclick: (e) => { e.stopPropagation(); askDelete(f); } }, "Delete")));
  }
  return el("tr", { class: "detail" }, el("td", { colspan: "11" }, box));
}

function renderTable() {
  const rows = filtered();
  const tb = el("tbody");
  let lastYear = null;
  [...rows].reverse().forEach((f) => {
    const y = f.date.slice(0, 4);
    if (y !== lastYear) { tb.append(el("tr", { class: "yr-sep" }, el("td", { colspan: "11" }, y))); lastYear = y; }
    const open = state.openId === f.id;
    tb.append(el("tr", { class: `row ${open ? "open" : ""}`, onclick: () => { state.openId = open ? null : f.id; renderTable(); } },
      el("td", { class: "date" }, f.date),
      el("td", { class: "ac" }, el("span", { class: "t" }, f.tail || ""), " ", el("span", { class: "ty" }, f.aircraft_type || "")),
      el("td", { class: "route" }, route(f)),
      el("td", { class: "n" }, hrs(f.total)),
      el("td", { class: "n" }, hrs(f.pic)),
      el("td", { class: "n" }, hrs(f.dual)),
      el("td", { class: "n" }, hrs(f.xc)),
      el("td", { class: "n" }, hrs(f.night)),
      el("td", { class: "n" }, hrs(num(f.actual) + num(f.hood))),
      el("td", { class: "n" }, `${cnt(f.day_ldg) || 0}/${cnt(f.night_ldg) || 0}`),
      el("td", { class: "rem", title: f.remarks || "" }, f.flight_review ? el("span", { class: "tag" }, "FR") : "", " ", f.remarks || "")));
    if (open) tb.append(detailRow(f));
  });
  $("#flights tbody").replaceWith(tb);
  const inst = sum(rows, "actual") + sum(rows, "hood");
  $("#flights tfoot").replaceChildren(el("tr", {},
    el("td", { colspan: "3" }, rows.length === state.flights.length ? "Totals" : `Totals (${rows.length} shown)`),
    ...[sum(rows, "total"), sum(rows, "pic"), sum(rows, "dual"), sum(rows, "xc"), sum(rows, "night"), inst]
      .map((v) => el("td", { class: "n" }, v.toFixed(1))),
    el("td", { class: "n" }, `${cnt(sum(rows, "day_ldg")) || 0}/${cnt(sum(rows, "night_ldg")) || 0}`),
    el("td", {})));
  $("#count").textContent = `(${rows.length})`;
}

function renderLists() {
  const years = [...new Set(state.flights.map((f) => f.date.slice(0, 4)))].sort().reverse();
  const sel = $("#year"), cur = sel.value;
  sel.replaceChildren(el("option", { value: "" }, "All years"), ...years.map((y) => el("option", { value: y }, y)));
  sel.value = years.includes(cur) ? cur : "";
  const uniq = (k) => [...new Set(state.flights.map((f) => f[k]).filter(Boolean))].sort();
  $("#types").replaceChildren(...uniq("aircraft_type").map((v) => el("option", { value: v })));
  $("#tails").replaceChildren(...uniq("tail").map((v) => el("option", { value: v })));
  $("#instructors").replaceChildren(...uniq("instructor").map((v) => el("option", { value: v })));
}

function renderAuth() {
  const ed = state.cfg.editor;
  $("#add-btn").hidden = !ed;
  $("#signout-btn").hidden = !ed;
  $("#who").hidden = !ed;
  $("#who").textContent = ed ? state.cfg.email : "";
  $("#signin-btn").hidden = ed;
}

function renderAll() { renderStats(); renderPilot(); renderCurrency(); renderYears(); renderAircraft(); renderLists(); renderTable(); renderAuth(); }

async function load() {
  const [cfg, flights] = await Promise.all([api("/api/config"), api("/api/flights")]);
  state.cfg = cfg; state.flights = flights;
  document.title = cfg.title || "Flight Log";
  $("#site-title").textContent = cfg.title || "Flight Log";
  $("#foot").replaceChildren(cfg.footer ? `${cfg.footer} Click a flight for details.` : "Click a flight for details.",
    ...(cfg.source_url && /^https:\/\//.test(cfg.source_url)
      ? [" · ", el("a", { href: cfg.source_url, target: "_blank", rel: "noopener" }, "Source code on GitHub")] : []));
  renderAll();
}

// ---------- sign in ----------
function loadGsi() {
  return new Promise((resolve, reject) => {
    if (window.google?.accounts?.id) return resolve();
    const s = el("script", { src: "https://accounts.google.com/gsi/client", async: true });
    s.onload = resolve; s.onerror = () => reject(new Error("Couldn't load Google sign-in"));
    document.head.append(s);
  });
}
async function openSignIn() {
  const dlg = $("#signin-dlg"), err = $("#signin-err");
  err.hidden = true; dlg.showModal();
  if (!state.cfg.google_client_id) { err.textContent = "Google sign-in isn't configured on the server yet (GOOGLE_CLIENT_ID)."; err.hidden = false; return; }
  try {
    await loadGsi();
    google.accounts.id.initialize({
      client_id: state.cfg.google_client_id,
      callback: async ({ credential }) => {
        try {
          const r = await api("/api/login", { method: "POST", body: JSON.stringify({ credential }) });
          state.cfg.editor = true; state.cfg.email = r.email;
          dlg.close(); renderAll(); toast("Signed in. You can now add and edit flights.");
        } catch (e) { err.textContent = e.message; err.hidden = false; }
      },
    });
    google.accounts.id.renderButton($("#gsi-btn"), { theme: "outline", size: "large", text: "signin_with" });
  } catch (e) { err.textContent = e.message; err.hidden = false; }
}
async function signOut() {
  await api("/api/logout", { method: "POST" });
  state.cfg.editor = false; state.cfg.email = null;
  window.google?.accounts?.id?.disableAutoSelect?.();
  renderAll(); toast("Signed out");
}

// ---------- pilot panel: certificates, medical, checkouts ----------
const CLASS_NAMES = ["", "First", "Second", "Third"];
function medicalStatus(med) {
  if (!med || !med.medical_exam_date) return null;
  // 14 CFR 61.23: for private-pilot privileges, any class lasts 60 calendar months if under 40 at the exam, else 24
  const exp = endOfMonthPlus(parseDate(med.medical_exam_date), med.medical_under_40 ? 60 : 24);
  const today = new Date(); today.setHours(0, 0, 0, 0);
  const left = daysBetween(today, exp);
  return { exp, left, pill: left < 0 ? "Expired" : left < 60 ? `${left} days left` : "Current",
    cls: left < 0 ? "bad" : left < 60 ? "warn" : "ok" };
}

function renderPilot() {
  const p = (state.cfg && state.cfg.pilot) || { certificates: [], medical: {}, checkouts: [] };
  const ed = state.cfg.editor;
  const empty = !p.certificates.length && !p.medical.medical_exam_date && !p.checkouts.length;
  $("#pilot-panel").hidden = empty && !ed;
  $("#pilot-edit").hidden = !ed;
  const list = el("ul", { class: "currency" });
  p.certificates.forEach((c) => list.append(el("li", {},
    el("span", { class: "lbl" }, c.title,
      el("span", { class: "sub" }, [c.ratings, c.issued ? `Issued ${fmtDate(c.issued)}` : null].filter(Boolean).join(" · "))))));
  const ms = medicalStatus(p.medical);
  if (ms) {
    list.append(el("li", {},
      el("span", { class: "lbl" }, "Medical",
        el("span", { class: "sub" }, `${CLASS_NAMES[p.medical.medical_class] || "Third"} class, exam ${fmtDate(p.medical.medical_exam_date)}; `
          + `good through ${ms.exp.toLocaleDateString(undefined, { month: "short", day: "numeric", year: "numeric" })}`)),
      el("span", { class: `pill ${ms.cls}` }, ms.pill)));
  }
  const box = el("div", {}, list);
  if (p.checkouts.length) {
    // One color per organization, in order of first appearance (first org = blue); no org = neutral
    const orgs = [...new Set(p.checkouts.map((c) => c.org).filter(Boolean))];
    const orgClass = (o) => (o ? `org-${orgs.indexOf(o) % 6}` : "org-none");
    box.append(el("div", { class: "lbl checkouts-h" }, "Checked out in"),
      el("div", { class: "chips" }, ...p.checkouts.map((c) =>
        el("span", { class: `chip ${orgClass(c.org)}`, title: [c.org, c.note].filter(Boolean).join(" · ") },
          c.aircraft, c.note ? el("span", { class: "chip-note" }, c.note) : ""))));
    if (orgs.length) {
      box.append(el("div", { class: "org-legend" }, ...orgs.map((o) =>
        el("span", { class: orgClass(o) }, el("i", { class: "dot", "aria-hidden": "true" }), o))));
    }
  }
  if (empty && ed) box.append(el("p", { class: "muted" }, "Add your certificates, medical, and the aircraft you're checked out in."));
  $("#pilot").replaceChildren(box);
}

function rowInputs(container, fields, values = {}) {
  const row = el("div", { class: "edit-row" },
    ...fields.map(([name, label, type, ph, list]) => el("label", {}, label,
      el("input", { name, type: type || "text", placeholder: ph || "", value: values[name] || "", list }))),
    el("button", { type: "button", class: "btn sm ghost", title: "Remove", onclick: () => row.remove() }, "✕"));
  container.append(row);
}
const CERT_FIELDS = [["title", "Certificate", "text", "Private Pilot"], ["ratings", "Ratings", "text", "Airplane Single Engine Land"], ["issued", "Issued", "date"]];
const CHECKOUT_FIELDS = [["aircraft", "Aircraft", "text", "C-172"], ["org", "Organization", "text", "WCFC", "orgs"],
  ["note", "Note (optional)", "text", "2015"]];

function openPilot() {
  const p = state.cfg.pilot || { certificates: [], medical: {}, checkouts: [] };
  const f = $("#pilot-form");
  f.reset(); $("#pilot-err").hidden = true;
  $("#cert-rows").replaceChildren(); $("#checkout-rows").replaceChildren();
  p.certificates.forEach((c) => rowInputs($("#cert-rows"), CERT_FIELDS, c));
  p.checkouts.forEach((c) => rowInputs($("#checkout-rows"), CHECKOUT_FIELDS, c));
  $("#orgs").replaceChildren(...[...new Set(p.checkouts.map((c) => c.org).filter(Boolean))].map((o) => el("option", { value: o })));
  f.elements.medical_class.value = String(p.medical.medical_class || 3);
  f.elements.medical_exam_date.value = p.medical.medical_exam_date || "";
  f.elements.medical_under_40.checked = !!p.medical.medical_under_40;
  $("#pilot-dlg").showModal();
}

function readRows(container, fields) {
  return [...container.querySelectorAll(".edit-row")].map((r) => {
    const o = {};
    fields.forEach(([name]) => { const v = r.querySelector(`[name="${name}"]`).value.trim(); o[name] = v || null; });
    return o;
  }).filter((o) => o[fields[0][0]]);   // skip rows with the first field empty
}

async function savePilot(e) {
  e.preventDefault();
  const f = $("#pilot-form"), err = $("#pilot-err");
  err.hidden = true;
  try {
    state.cfg.pilot = await api("/api/settings/pilot", { method: "PUT", body: JSON.stringify({
      certificates: readRows($("#cert-rows"), CERT_FIELDS),
      checkouts: readRows($("#checkout-rows"), CHECKOUT_FIELDS),
      medical: f.elements.medical_exam_date.value ? {
        medical_class: Number(f.elements.medical_class.value),
        medical_exam_date: f.elements.medical_exam_date.value,
        medical_under_40: f.elements.medical_under_40.checked } : {},
    }) });
    $("#pilot-dlg").close(); renderPilot(); toast("Pilot info updated");
  } catch (ex) { err.textContent = ex.message; err.hidden = false; }
}

// ---------- add / edit / delete ----------
function openEdit(f) {
  const form = $("#edit-form");
  form.reset();
  $("#edit-err").hidden = true;
  state.editingId = f ? f.id : null;
  $("#edit-title").textContent = f ? `Edit flight · ${f.date}` : "Add flight";
  const last = state.flights[state.flights.length - 1] || {};
  const src = f || {
    date: new Date().toLocaleDateString("en-CA"), dep: state.cfg.home_airport || "", arr: state.cfg.home_airport || "",
    page: last.page ?? null, aircraft_type: last.aircraft_type, tail: last.tail,
  };
  for (const k of [...TEXTS, ...NUMS]) if (form.elements[k]) form.elements[k].value = src[k] ?? "";
  form.elements.flight_review.checked = !!src.flight_review;
  $("#edit-dlg").showModal();
  form.elements.date.focus();
}

function formData() {
  const form = $("#edit-form"), out = {};
  for (const k of TEXTS) out[k] = form.elements[k].value.trim() || null;
  for (const k of NUMS) { const v = form.elements[k].value; out[k] = v === "" ? null : Number(v); }
  out.flight_review = form.elements.flight_review.checked;
  return out;
}

async function saveFlight(e) {
  e.preventDefault();
  const err = $("#edit-err"); err.hidden = true;
  const data = formData();
  if (!data.date) { err.textContent = "Date is required."; err.hidden = false; return; }
  if (!data.total) { err.textContent = "Total time is required."; err.hidden = false; return; }
  $("#save-btn").disabled = true;
  try {
    const id = state.editingId;
    const saved = await api(id ? `/api/flights/${id}` : "/api/flights", { method: id ? "PUT" : "POST", body: JSON.stringify(data) });
    state.flights = await api("/api/flights");
    state.openId = saved.id;
    $("#edit-dlg").close(); renderAll(); toast(id ? "Flight updated" : "Flight added");
  } catch (ex) { err.textContent = ex.message; err.hidden = false; }
  finally { $("#save-btn").disabled = false; }
}

function askDelete(f) {
  state.pendingDelete = f;
  $("#confirm-text").textContent = `${f.date} · ${f.tail || ""} · ${route(f)} · ${hrs(f.total)} hrs`;
  $("#confirm-dlg").showModal();
}
async function doDelete() {
  const f = state.pendingDelete; if (!f) return;
  try {
    await api(`/api/flights/${f.id}`, { method: "DELETE" });
    state.flights = state.flights.filter((x) => x.id !== f.id);
    $("#confirm-dlg").close(); renderAll(); toast("Flight deleted");
  } catch (ex) { toast(ex.message); }
}

// ---------- wiring ----------
document.addEventListener("click", (e) => { if (e.target.matches("[data-close]")) e.target.closest("dialog").close(); });
$("#signin-btn").addEventListener("click", openSignIn);
$("#signout-btn").addEventListener("click", signOut);
$("#add-btn").addEventListener("click", () => openEdit(null));
$("#edit-form").addEventListener("submit", saveFlight);
$("#confirm-yes").addEventListener("click", doDelete);
$("#pilot-form").addEventListener("submit", savePilot);
$("#pilot-edit").addEventListener("click", openPilot);
$("#add-cert").addEventListener("click", () => rowInputs($("#cert-rows"), CERT_FIELDS));
$("#add-checkout").addEventListener("click", () => rowInputs($("#checkout-rows"), CHECKOUT_FIELDS));
$("#q").addEventListener("input", renderTable);
$("#year").addEventListener("change", renderTable);
$("#edit-form").elements.total.addEventListener("change", (e) => {
  const se = $("#edit-form").elements.se;
  if (!se.value) se.value = e.target.value;
});
load().catch((e) => toast(`Couldn't load the logbook: ${e.message}`));
