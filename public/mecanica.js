// Mecánica tab: repair videos for the Panda. YouTube links (shared, they play with internet) and the person's own
// video files, kept on this device so they play without internet.
import { idb } from "./mapas.js";
const $ = (id) => document.getElementById(id);

export const ytId = (u) => {
  const m = String(u).match(/(?:youtu\.be\/|youtube(?:-nocookie)?\.com\/(?:watch\?(?:.*&)?v=|embed\/|shorts\/|live\/))([\w-]{11})/);
  return m ? m[1] : null;
};

export function setupMecanica({ sb, canEdit, user, writeErr }) {
  let shared = [], own = [], loaded = false;
  const urls = new Map(); // own video id -> object URL
  const msg = (t) => { $("mecMsg").textContent = t || ""; };

  async function load() {
    const { data, error } = await sb.from("videos").select("*");
    shared = error ? [] : data.sort((a, b) => String(a.created_at).localeCompare(String(b.created_at))).map((v) => ({ id: v.id, topic: v.topic, title: v.title, yt: ytId(v.url), url: v.url, by: v.created_by }));
    try { own = await idb.all("videos"); } catch (e) { own = []; }
    loaded = true; render();
  }

  function card(v) {
    const li = document.createElement("li"); li.className = "vid";
    const box = document.createElement("div"); box.className = "player";
    if (v.yt) {
      const b = document.createElement("button"); b.type = "button"; b.className = "thumb"; b.setAttribute("aria-label", "Ver " + v.title);
      b.style.backgroundImage = `url(https://img.youtube.com/vi/${v.yt}/hqdefault.jpg)`;
      b.innerHTML = '<span class="play">▶</span>';
      b.onclick = () => {
        if (!navigator.onLine) { msg("Sin conexión: los vídeos de YouTube necesitan internet."); return; }
        const f = document.createElement("iframe");
        f.src = `https://www.youtube-nocookie.com/embed/${v.yt}?autoplay=1&rel=0`;
        f.allow = "autoplay; encrypted-media; picture-in-picture; fullscreen"; f.allowFullscreen = true; f.title = v.title;
        box.replaceChildren(f);
      };
      box.append(b);
    } else if (v.blob) {
      if (!urls.has(v.id)) urls.set(v.id, URL.createObjectURL(v.blob));
      const vid = document.createElement("video"); vid.controls = true; vid.preload = "metadata"; vid.src = urls.get(v.id);
      box.append(vid);
    }
    const t = document.createElement("div"); t.className = "vt"; t.textContent = v.title;
    const meta = document.createElement("div"); meta.className = "vm";
    meta.textContent = v.blob ? `En este dispositivo · ${(v.size / 1048576).toFixed(0)} MB · funciona sin internet` : "YouTube · necesita internet";
    const btns = document.createElement("div"); btns.className = "btns";
    if (v.yt) {
      const a = document.createElement("a"); a.className = "btn ghost"; a.href = "https://www.youtube.com/watch?v=" + v.yt; a.target = "_blank"; a.rel = "noopener";
      a.textContent = "Abrir en YouTube"; btns.append(a);
    }
    if (v.blob || canEdit()) {
      const del = document.createElement("button"); del.type = "button"; del.className = "ghost"; del.textContent = "Quitar";
      del.onclick = async () => {
        if (!del.dataset.armed) { del.dataset.armed = "1"; del.textContent = "¿Seguro?"; del.className = "warn"; return; }
        try {
          if (v.blob) { await idb.del("videos", v.id); if (urls.has(v.id)) { URL.revokeObjectURL(urls.get(v.id)); urls.delete(v.id); } }
          else { const { error } = await sb.from("videos").delete().eq("id", v.id); if (error) throw error; }
          load();
        } catch (e) { msg(writeErr(e)); }
      };
      btns.append(del);
    }
    li.append(box, t, meta, btns);
    return li;
  }

  function render() {
    if (!loaded) return;
    const all = [...shared.filter((v) => v.yt), ...own];
    const topics = [...new Set(all.map((v) => v.topic))];
    const box = $("mecTopics"); box.textContent = "";
    if (!all.length) box.textContent = "No hay vídeos. Añade uno abajo.";
    topics.forEach((tp) => {
      const sec = document.createElement("section"); sec.className = "topic";
      const h = document.createElement("h3"); h.textContent = tp;
      const ul = document.createElement("ul"); ul.className = "vids";
      all.filter((v) => v.topic === tp).forEach((v) => ul.append(card(v)));
      sec.append(h, ul); box.append(sec);
    });
    const dl = $("mecTopicList"); dl.textContent = "";
    topics.forEach((tp) => { const o = document.createElement("option"); o.value = tp; dl.append(o); });
  }

  $("mecAdd").onsubmit = async (e) => {
    e.preventDefault();
    const topic = $("mecTopic").value.trim() || "Otros", url = $("mecUrl").value.trim(), id = ytId(url);
    if (!id) { msg("Pega el enlace de un vídeo de YouTube (youtube.com/watch?v=… o youtu.be/…)."); return; }
    try {
      const { error } = await sb.from("videos").insert({ topic, title: $("mecTitle").value.trim() || "Vídeo de YouTube", url: "https://www.youtube.com/watch?v=" + id, created_by: user().email });
      if (error) throw error;
      $("mecUrl").value = ""; $("mecTitle").value = ""; msg(`Añadido a «${topic}».`); load();
    } catch (er) { msg(writeErr(er)); }
  };
  $("mecFile").addEventListener("change", async (e) => {
    const files = [...e.target.files]; e.target.value = "";
    const topic = $("mecTopic").value.trim() || "Mis vídeos";
    for (const f of files) {
      try {
        await idb.put("videos", { id: f.name + "|" + f.size, topic, title: f.name.replace(/\.[^.]+$/, ""), size: f.size, blob: f, added: Date.now() });
        if (navigator.storage && navigator.storage.persist) navigator.storage.persist();
      } catch (er) { msg(`${f.name}: no se pudo guardar (${er.message || er}).`); return; }
    }
    if (files.length) { msg(`Guardado${files.length > 1 ? "s" : ""} en «${topic}» en este dispositivo: se ve${files.length > 1 ? "n" : ""} sin internet.`); load(); }
  });

  return { show: () => { if (!loaded) load(); else render(); } };
}
