// Coches tab: the team's 4x4s with their technical sheet. Claude can fill the form from photos of the ficha técnica.
import { idb } from "./mapas.js";
const $ = (id) => document.getElementById(id);

const GROUPS = [
  ["Identificación", [
    ["alias", "Nombre del coche", "La Panda roja"], ["marca", "Marca"], ["modelo", "Modelo"], ["version", "Versión / tipo"],
    ["matricula", "Matrícula"], ["bastidor", "Nº de bastidor (VIN)"], ["fecha_matriculacion", "1ª matriculación", "", "date"], ["titular", "Titular"]]],
  ["Motor y pesos", [
    ["cilindrada", "Cilindrada (cc)"], ["potencia", "Potencia"], ["combustible", "Combustible"], ["plazas", "Plazas"],
    ["mma", "MMA (kg)"], ["tara", "Tara (kg)"], ["neumaticos", "Neumáticos"]]],
  ["Papeles", [
    ["itv_hasta", "ITV válida hasta", "", "date"], ["seguro", "Seguro (compañía)"], ["poliza", "Nº de póliza"],
    ["seguro_hasta", "Seguro válido hasta", "", "date"], ["asistencia", "Teléfono de asistencia", "", "tel"]]],
  ["Mantenimiento", [
    ["aceite", "Aceite y capacidades"], ["recambios", "Recambios (filtros, correa, bujías…)"], ["notas", "Notas y reformas", "", "area"]]],
];
const FIELDS = GROUPS.flatMap(([, f]) => f);
const LABEL = Object.fromEntries(FIELDS.map(([k, l]) => [k, l]));
const fmtDate = (s) => /^\d{4}-\d{2}-\d{2}$/.test(s || "") ? s.split("-").reverse().join("/") : s;

function expiry(s) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(s || "")) return null;
  const days = Math.floor((new Date(s + "T23:59:59") - new Date()) / 864e5);
  return days < 0 ? ["bad", "caducada"] : days <= 30 ? ["warn", `caduca en ${days} día${days === 1 ? "" : "s"}`] : ["ok", ""];
}

const BUCKET = "coches";
const fmtSize = (b) => b >= 1048576 ? (b / 1048576).toFixed(1).replace(".", ",") + " MB" : Math.max(1, Math.round(b / 1024)) + " KB";
const kind = (name) => { const e = (name.split(".").pop() || "").toLowerCase(); return e === "pdf" ? "PDF" : /^(jpe?g|png|webp|heic|gif)$/.test(e) ? "FOTO" : /^(docx?|odt|rtf)$/.test(e) ? "DOC" : /^(xlsx?|ods|csv)$/.test(e) ? "XLS" : e.slice(0, 4).toUpperCase() || "ARCH"; };
const safeName = (n) => n.normalize("NFD").replace(/[\u0300-\u036f]/g, "").replace(/[^\w.-]+/g, "_").slice(-80);
const b64 = (file) => new Promise((ok, ko) => { const r = new FileReader(); r.onload = () => ok(String(r.result).split(",")[1]); r.onerror = () => ko(r.error); r.readAsDataURL(file); });

export function setupCoches({ sb, canEdit, user, writeErr, toJpeg }) {
  let cars = [], loaded = false, editing = null, photos = [], docs = [], newDocs = [], dropDocs = [];

  async function uploadDocs(carId, files) {
    const out = [];
    for (const f of files) {
      const path = `${carId}/${Date.now()}-${safeName(f.name)}`;
      const { error } = await sb.storage.from(BUCKET).upload(path, f, { contentType: f.type || "application/octet-stream" });
      if (error) throw new Error(`«${f.name}» no se pudo subir: ${error.message}`);
      out.push({ path, name: f.name, size: f.size, type: f.type || "", added: new Date().toISOString() });
    }
    return out;
  }
  async function openDoc(d) {
    const w = window.open("", "_blank");
    const { data, error } = await sb.storage.from(BUCKET).createSignedUrl(d.path, 3600);
    if (error || !data) { if (w) w.close(); msg(navigator.onLine ? "No se pudo abrir el documento." : "Sin conexión: los documentos necesitan internet."); return; }
    if (w) w.location = data.signedUrl; else location.href = data.signedUrl;
  }
  function docList(list, onRemove) {
    const ul = document.createElement("ul"); ul.className = "docs";
    list.forEach((d, i) => {
      const li = document.createElement("li");
      const k = document.createElement("span"); k.className = "dk"; k.textContent = kind(d.name);
      const a = document.createElement(d.path ? "button" : "span"); a.className = d.path ? "dn link" : "dn";
      if (d.path) { a.type = "button"; a.onclick = () => openDoc(d); }
      a.textContent = d.name;
      const sz = document.createElement("span"); sz.className = "ds"; sz.textContent = d.path ? fmtSize(d.size) : fmtSize(d.size) + " · se sube al guardar";
      li.append(k, a, sz);
      if (onRemove) { const x = document.createElement("button"); x.type = "button"; x.className = "ghost"; x.textContent = "✕"; x.title = "Quitar documento"; x.onclick = () => onRemove(i); li.append(x); }
      ul.append(li);
    });
    return ul;
  }
  const msg = (t) => { $("carMsg").textContent = t || ""; };

  async function load() {
    const { data, error } = await sb.from("cars").select("*").order("created_at");
    if (error) {
      try { cars = (await idb.get("kv", "cars")) || []; } catch (e) { cars = []; }
      if (cars.length) msg("Sin conexión: ves la copia guardada en este dispositivo.");
    } else {
      cars = data;
      idb.put("kv", cars, "cars").catch(() => {});
    }
    loaded = true; render();
  }

  function render() {
    if (!loaded) return;
    const ul = $("carList"); ul.textContent = "";
    if (!cars.length) { const p = document.createElement("p"); p.className = "hint"; p.textContent = "Aún no hay coches. Pulsa «Añadir coche» y saca una foto de la ficha técnica."; ul.append(p); }
    cars.forEach((c) => ul.append(card(c)));
    $("carNew").hidden = !canEdit() || !!editing;
    $("carForm").hidden = !editing;
  }

  function card(c) {
    const d = c.data || {};
    const li = document.createElement("article"); li.className = "car";
    const head = document.createElement("header");
    const h = document.createElement("h3"); h.textContent = d.alias || [d.marca, d.modelo].filter(Boolean).join(" ") || "Coche";
    const sub = document.createElement("div"); sub.className = "cm"; sub.textContent = [d.marca, d.modelo, d.version].filter(Boolean).join(" · ");
    const left = document.createElement("div"); left.append(h, sub);
    head.append(left);
    if (d.matricula) { const pl = document.createElement("span"); pl.className = "plate"; pl.innerHTML = '<i>E</i>'; pl.append(d.matricula); head.append(pl); }
    li.append(head);

    const alerts = document.createElement("div"); alerts.className = "alerts";
    [["itv_hasta", "ITV"], ["seguro_hasta", "Seguro"]].forEach(([k, n]) => {
      const e = expiry(d[k]); if (!e) return;
      const s = document.createElement("span"); s.className = "due " + e[0];
      s.textContent = `${n}: ${fmtDate(d[k])}${e[1] ? " · " + e[1] : ""}`; alerts.append(s);
    });
    if (alerts.childNodes.length) li.append(alerts);

    GROUPS.forEach(([g, fields]) => {
      const rows = fields.filter(([k]) => k !== "alias" && k !== "marca" && k !== "modelo" && k !== "matricula" && d[k]);
      if (!rows.length) return;
      const dl = document.createElement("dl");
      const cap = document.createElement("div"); cap.className = "g"; cap.textContent = g; dl.append(cap);
      rows.forEach(([k, l, , t]) => {
        const dt = document.createElement("dt"); dt.textContent = l;
        const dd = document.createElement("dd");
        if (t === "tel") { const a = document.createElement("a"); a.href = "tel:" + d[k].replace(/[^\d+]/g, ""); a.textContent = d[k]; dd.append(a); }
        else dd.textContent = t === "date" ? fmtDate(d[k]) : d[k];
        dl.append(dt, dd);
      });
      li.append(dl);
    });

    if ((c.docs || []).length || canEdit()) {
      const sec = document.createElement("div"); sec.className = "docsec";
      const cap = document.createElement("div"); cap.className = "g"; cap.textContent = "Documentos"; sec.append(cap);
      if ((c.docs || []).length) sec.append(docList(c.docs));
      if (canEdit()) {
        const id = "carDocQuick_" + c.id;
        const lab = document.createElement("label"); lab.className = "btn ghost"; lab.htmlFor = id; lab.textContent = "Subir documentos";
        const inp = document.createElement("input"); inp.type = "file"; inp.id = id; inp.multiple = true; inp.className = "vh";
        inp.onchange = async () => {
          const files = [...inp.files]; inp.value = ""; if (!files.length) return;
          lab.textContent = "Subiendo…"; lab.classList.add("busy");
          try {
            const added = await uploadDocs(c.id, files);
            const { error } = await sb.from("cars").update({ docs: [...(c.docs || []), ...added], updated_at: new Date().toISOString() }).eq("id", c.id);
            if (error) throw error;
            msg(`${added.length > 1 ? added.length + " documentos subidos" : "Documento subido"} a «${d.alias || d.modelo || d.matricula || "el coche"}».`); load();
          } catch (er) { msg(writeErr(er)); lab.textContent = "Subir documentos"; lab.classList.remove("busy"); }
        };
        sec.append(lab, inp);
      }
      li.append(sec);
    }

    if ((c.photos || []).length) {
      const ph = document.createElement("div"); ph.className = "carph";
      c.photos.forEach((src, i) => {
        const a = document.createElement("a"); a.href = src; a.target = "_blank"; a.title = "Ver la foto " + (i + 1);
        a.onclick = (e) => { e.preventDefault(); const w = window.open(); if (w) { w.document.title = "Ficha técnica"; const im = w.document.createElement("img"); im.src = src; im.style.maxWidth = "100%"; w.document.body.append(im); } };
        const im = document.createElement("img"); im.src = src; im.alt = "Ficha técnica, foto " + (i + 1); a.append(im); ph.append(a);
      });
      li.append(ph);
    }

    if (canEdit()) {
      const btns = document.createElement("div"); btns.className = "btns";
      const ed = document.createElement("button"); ed.type = "button"; ed.className = "ghost"; ed.textContent = "Editar";
      ed.onclick = () => open(c);
      const del = document.createElement("button"); del.type = "button"; del.className = "ghost"; del.textContent = "Quitar";
      del.onclick = async () => {
        if (!del.dataset.armed) { del.dataset.armed = "1"; del.textContent = "¿Seguro?"; del.className = "warn"; return; }
        const paths = (c.docs || []).map((x) => x.path);
        if (paths.length) await sb.storage.from(BUCKET).remove(paths);
        const { error } = await sb.from("cars").delete().eq("id", c.id);
        if (error) msg(writeErr(error)); else { msg(""); load(); }
      };
      btns.append(ed, del); li.append(btns);
    }
    return li;
  }

  // the form is built once from GROUPS
  const body = $("carFields");
  GROUPS.forEach(([g, fields]) => {
    const fs = document.createElement("fieldset"); const lg = document.createElement("legend"); lg.textContent = g; fs.append(lg);
    fields.forEach(([k, l, ph, t]) => {
      const lab = document.createElement("label"); lab.textContent = l;
      const inp = document.createElement(t === "area" ? "textarea" : "input");
      inp.id = "car_" + k; if (t && t !== "area") inp.type = t; if (ph) inp.placeholder = ph; if (t === "area") inp.rows = 3;
      lab.append(inp); fs.append(lab);
    });
    body.append(fs);
  });

  function showPhotos() {
    const box = $("carPhotos"); box.textContent = "";
    photos.forEach((src, i) => {
      const fig = document.createElement("figure");
      const im = document.createElement("img"); im.src = src; im.alt = "Foto " + (i + 1);
      const x = document.createElement("button"); x.type = "button"; x.className = "ghost"; x.textContent = "✕"; x.title = "Quitar foto";
      x.onclick = () => { photos.splice(i, 1); showPhotos(); };
      fig.append(im, x); box.append(fig);
    });
  }
  function showDocs() {
    const box = $("carDocs"); box.textContent = "";
    const all = [...docs, ...newDocs.map((f) => ({ name: f.name, size: f.size }))];
    if (all.length) box.append(docList(all, (i) => {
      if (i < docs.length) dropDocs.push(docs.splice(i, 1)[0]); else newDocs.splice(i - docs.length, 1);
      showDocs();
    }));
  }
  function open(c) {
    editing = c || { id: null, data: {} };
    photos = [...(editing.photos || [])]; docs = [...(editing.docs || [])]; newDocs = []; dropDocs = [];
    showDocs();
    FIELDS.forEach(([k]) => { $("car_" + k).value = editing.data[k] || ""; });
    $("carFormTitle").textContent = c ? "Editar coche" : "Nuevo coche";
    showPhotos(); msg(""); render();
    $("carForm").scrollIntoView({ behavior: "smooth", block: "start" });
  }
  const close = () => { editing = null; photos = []; docs = []; newDocs = []; dropDocs = []; render(); };
  $("carDocIn").addEventListener("change", (e) => { newDocs.push(...e.target.files); e.target.value = ""; showDocs(); });

  $("carNew").onclick = () => open(null);
  $("carCancel").onclick = close;
  $("carPhotoIn").addEventListener("change", async (e) => {
    const files = [...e.target.files].slice(0, 4); e.target.value = "";
    if (!files.length) return;
    const out = $("carReadMsg");
    try {
      out.textContent = `Leyendo ${files.length > 1 ? "los archivos" : "el archivo"} de la ficha técnica…`;
      $("carPhotoBtn").classList.add("busy");
      const pdfs = files.filter((f) => f.type === "application/pdf" || /\.pdf$/i.test(f.name)), imgs = files.filter((f) => !pdfs.includes(f));
      const big = pdfs.find((f) => f.size > 8 * 1048576);
      if (big) throw new Error(`«${big.name}» pesa demasiado para leerlo (máx. 8 MB). Súbelo como documento y rellena los datos a mano.`);
      const [readImgs, keep, readPdfs] = await Promise.all([Promise.all(imgs.map((f) => toJpeg(f, 2000))), Promise.all(imgs.map((f) => toJpeg(f, 1400))),
        Promise.all(pdfs.map(async (f) => ({ mediaType: "application/pdf", data: await b64(f) })))]);
      const read = [...readPdfs, ...readImgs];
      keep.forEach((im) => photos.push("data:image/jpeg;base64," + im.data)); showPhotos();
      newDocs.push(...pdfs); showDocs();
      const { data, error } = await sb.functions.invoke("leer-ficha", { body: { images: read } });
      if (error) { let m = ""; try { m = (await error.context.json()).error; } catch (er) {} throw new Error(m || "No se pudo leer la ficha."); }
      const got = Object.entries(data.ficha || {}).filter(([k, v]) => LABEL[k] && String(v).trim());
      got.forEach(([k, v]) => { $("car_" + k).value = String(v).trim(); $("car_" + k).classList.add("read"); });
      out.textContent = got.length ? `He rellenado ${got.length} datos de la ficha (marcados en verde). Revísalos y pulsa Guardar.` : "No encontré datos en las fotos. Rellénalos a mano.";
    } catch (er) { out.textContent = er.message || String(er); }
    $("carPhotoBtn").classList.remove("busy");
  });
  $("carForm").onsubmit = async (e) => {
    e.preventDefault();
    const data = {};
    FIELDS.forEach(([k]) => { const v = $("car_" + k).value.trim(); if (v) data[k] = k === "matricula" ? v.toUpperCase().replace(/\s+/g, "") : v; });
    if (!data.alias && !data.matricula && !data.modelo) { $("carReadMsg").textContent = "Pon al menos el nombre, el modelo o la matrícula."; return; }
    const row = { data, photos, updated_at: new Date().toISOString() };
    const save = $("carForm").querySelector("button[type=submit]"); save.disabled = true;
    try {
      let id = editing.id;
      if (id) { const { error } = await sb.from("cars").update(row).eq("id", id); if (error) throw error; }
      else { const { data: ins, error } = await sb.from("cars").insert({ ...row, created_by: user().email }).select("id").single(); if (error) throw error; id = ins.id; }
      if (newDocs.length || dropDocs.length) {
        if (newDocs.length) $("carReadMsg").textContent = `Subiendo ${newDocs.length > 1 ? newDocs.length + " documentos" : "el documento"}…`;
        const added = await uploadDocs(id, newDocs);
        const { error } = await sb.from("cars").update({ docs: [...docs, ...added] }).eq("id", id); if (error) throw error;
        if (dropDocs.length) await sb.storage.from(BUCKET).remove(dropDocs.map((x) => x.path));
      }
    } catch (er) { $("carReadMsg").textContent = writeErr(er); save.disabled = false; return; }
    save.disabled = false;
    FIELDS.forEach(([k]) => $("car_" + k).classList.remove("read"));
    $("carReadMsg").textContent = "";
    msg(`Guardado «${data.alias || data.modelo || data.matricula}».`);
    close(); load();
  };

  return { show: () => { if (!loaded) load(); else render(); } };
}
