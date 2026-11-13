// Puente entre la app y el servidor: implementa claude.use("db" | "user" | "downloads")
// con la misma interfaz que tenía la app dentro de Claude.
(() => {
  "use strict";
  const err = (code, message) => Object.assign(new Error(message), { code, message });

  async function api(ruta, cuerpo) {
    let r;
    try {
      r = await fetch("/api/" + ruta, { method: "POST", headers: { "content-type": "application/json" }, credentials: "same-origin", body: JSON.stringify(cuerpo || {}) });
    } catch (e) { throw err("unavailable", "Sin conexión con el servidor"); }
    if (r.status === 401) { location.href = "/login"; throw err("revoked", "Sesión vencida"); }
    const j = await r.json().catch(() => ({}));
    if (!r.ok) throw err(j.code || "unavailable", j.message || "Error " + r.status);
    return j;
  }

  /* ---------- rutas ---------- */
  const SEG = /^[A-Za-z0-9_\-.~:@+]+$/;
  function validar(path, par) {
    if (typeof path !== "string" || !path) throw new TypeError("Ruta inválida");
    const s = path.split("/");
    if (!s.every(x => SEG.test(x) && x !== "." && x !== "..")) throw new TypeError("Ruta inválida: " + path);
    if ((s.length % 2 === 0) !== par) throw new TypeError(`La ruta "${path}" tiene ${s.length} segmentos`);
    return s;
  }
  const nuevoId = () => { const a = "abcdefghijklmnopqrstuvwxyz0123456789"; let s = ""; const r = crypto.getRandomValues(new Uint8Array(20)); for (const x of r) s += a[x % 36]; return s; };
  const META = Object.freeze({ fromCache: false, hasPendingWrites: false });
  const docSnap = (id, data) => Object.freeze({ id, exists: data != null, data: () => (data == null ? undefined : data), metadata: META });

  /* ---------- suscripciones ---------- */
  const subs = new Set();
  const pendientes = new Map();
  function programar(sub, ms = 80) {
    if (pendientes.has(sub)) return;
    pendientes.set(sub, setTimeout(() => { pendientes.delete(sub); refrescar(sub); }, ms));
  }
  async function refrescar(sub) {
    if (sub.muerta) return;
    if (sub.corriendo) { sub.otraVez = true; return; }
    sub.corriendo = true;
    try {
      if (sub.tipo === "doc") {
        const { data } = await api("get", { path: sub.path });
        const txt = JSON.stringify(data ?? null);
        if (sub.primera || txt !== sub.prev) { sub.primera = false; sub.prev = txt; if (!sub.muerta) sub.next(docSnap(sub.id, data)); }
      } else {
        const { docs } = await api("query", sub.q);
        const txts = new Map(docs.map(d => [d.id, JSON.stringify(d.data)]));
        const prevIds = sub.prevIds || [];
        const cambios = [];
        const nuevos = docs.map(d => docSnap(d.id, d.data));
        const idx = new Map(docs.map((d, i) => [d.id, i]));
        const prevIdx = new Map(prevIds.map((id, i) => [id, i]));
        prevIds.forEach((id, i) => { if (!idx.has(id)) cambios.push({ type: "removed", doc: sub.prevSnaps.get(id), oldIndex: i, newIndex: -1 }); });
        nuevos.forEach((s, i) => {
          if (!prevIdx.has(s.id)) cambios.push({ type: "added", doc: s, oldIndex: -1, newIndex: i });
          else if (sub.prevTxt.get(s.id) !== txts.get(s.id) || prevIdx.get(s.id) !== i) cambios.push({ type: "modified", doc: s, oldIndex: prevIdx.get(s.id), newIndex: i });
        });
        if (sub.primera || cambios.length) {
          sub.primera = false;
          sub.prevIds = docs.map(d => d.id); sub.prevTxt = txts; sub.prevSnaps = new Map(nuevos.map(s => [s.id, s]));
          const snap = Object.freeze({ docs: nuevos, size: nuevos.length, empty: !nuevos.length, docChanges: () => cambios, metadata: META });
          if (!sub.muerta) sub.next(snap);
        }
      }
    } catch (e) {
      if (e && e.code === "revoked" || e && e.code === "invalid_argument") { sub.muerta = true; subs.delete(sub); if (sub.error) sub.error(e); }
      // errores transitorios: se reintenta en el próximo aviso o refresco periódico
    } finally {
      sub.corriendo = false;
      if (sub.otraVez) { sub.otraVez = false; programar(sub, 0); }
    }
  }
  function suscribir(sub, next, error) {
    Object.assign(sub, { next, error, primera: true, prevTxt: new Map(), prevSnaps: new Map() });
    subs.add(sub); refrescar(sub);
    return () => { sub.muerta = true; subs.delete(sub); };
  }
  const tocar = coll => { for (const s of subs) if (s.coll === coll) programar(s, 0); };

  // Avisos en vivo desde el servidor
  let es;
  function conectar() {
    es = new EventSource("/api/eventos");
    es.onopen = () => { for (const s of subs) programar(s, 0); };
    es.onmessage = ev => { try { const { c, i } = JSON.parse(ev.data); for (const s of subs) if (s.coll === c && (s.tipo !== "doc" || s.id === i)) programar(s); } catch (e) {} };
  }
  conectar();
  setInterval(() => { for (const s of subs) programar(s, 0); }, 30000);
  document.addEventListener("visibilitychange", () => { if (document.visibilityState === "visible") for (const s of subs) programar(s, 0); });

  /* ---------- referencias ---------- */
  function docRef(path) {
    const s = validar(path, true);
    const id = s[s.length - 1], coll = s.slice(0, -1).join("/");
    const escribir = async (acc, data) => { await api(acc, { path, data }); tocar(coll); };
    return Object.freeze({
      id, path,
      get: async () => { const { data } = await api("get", { path }); return docSnap(id, data); },
      set: data => escribir("set", data),
      update: data => escribir("update", data),
      delete: () => escribir("delete"),
      acquire: async () => ({ acquired: true, holder: "local" }),
      onSnapshot: (next, error) => suscribir({ tipo: "doc", path, id, coll }, next, error),
      collection: sub => colRef(path + "/" + sub),
    });
  }
  function query(coll, q) {
    return {
      where: (f, op, v) => query(coll, { ...q, where: [...q.where, [f, op, v]] }),
      orderBy: (f, dir = "asc") => query(coll, { ...q, orderBy: [f, dir] }),
      limit: n => query(coll, { ...q, limit: n }),
      get: async () => {
        const { docs } = await api("query", q);
        const l = docs.map(d => docSnap(d.id, d.data));
        return Object.freeze({ docs: l, size: l.length, empty: !l.length, docChanges: () => l.map((d, i) => ({ type: "added", doc: d, oldIndex: -1, newIndex: i })), metadata: META });
      },
      onSnapshot: (next, error) => suscribir({ tipo: "query", coll, q }, next, error),
    };
  }
  function colRef(path) {
    validar(path, false);
    return Object.freeze({
      path,
      ...query(path, { coll: path, where: [], orderBy: null, limit: null }),
      doc: id => docRef(path + "/" + (id ?? nuevoId())),
      add: async data => { const r = docRef(path + "/" + nuevoId()); await r.set(data); return r; },
    });
  }
  const db = Object.freeze({ doc: docRef, collection: colRef });

  /* ---------- usuario ---------- */
  let yo = null;
  const yoP = fetch("/api/yo", { credentials: "same-origin" }).then(r => { if (r.status === 401) { location.href = "/login"; return null; } return r.json(); }).then(j => (yo = j)).catch(() => null);
  const puedeEscribir = () => !!yo && (yo.escribir === "*" || (Array.isArray(yo.escribir) && yo.escribir.length > 0));
  const user = Object.freeze({
    id: async () => (await yoP)?.id ?? null,
    can: async p => { await yoP; return p === "data.write" ? puedeEscribir() : null; },
    canEdit: async () => (await yoP)?.rol === "admin",
    isOwner: async () => (await yoP)?.rol === "admin",
    profiles: async ids => (await api("perfiles", { ids })).perfiles,
  });

  /* ---------- descargas ---------- */
  const downloads = Object.freeze({
    save: async ({ filename, data }) => {
      const blob = data instanceof Blob ? data : new Blob([data]);
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a"); a.href = url; a.download = filename || "archivo"; document.body.appendChild(a); a.click(); a.remove();
      setTimeout(() => URL.revokeObjectURL(url), 60000);
    },
  });

  const caps = { db, user, downloads };
  window.claude = Object.freeze({ use: name => new Promise(res => setTimeout(() => res(caps[name] || null), 0)) });

  /* ---------- barra de sesión ---------- */
  yoP.then(j => {
    if (!j) return;
    const pon = () => {
      const d = document.createElement("div");
      d.id = "sesion-usual";
      d.innerHTML = `<span></span> · <a href="/clave">Contraseña</a> · <a href="/logout">Salir</a>`;
      d.querySelector("span").textContent = j.nombre + (j.rolNombre ? " (" + j.rolNombre + ")" : "");
      const st = document.createElement("style");
      st.textContent = `#sesion-usual{position:fixed;left:10px;bottom:calc(10px + env(safe-area-inset-bottom,0px));z-index:9999;font:12px Inter,-apple-system,sans-serif;padding:6px 10px;border-radius:999px;background:rgba(127,127,127,.16);backdrop-filter:blur(6px);-webkit-backdrop-filter:blur(6px);color:inherit;opacity:.75}#sesion-usual:hover{opacity:1}#sesion-usual a{color:inherit}`;
      document.head.appendChild(st); document.body.appendChild(d);
    };
    if (document.body) pon(); else document.addEventListener("DOMContentLoaded", pon);
  });
})();
