// Comanda Usual — servidor
// Sirve la app, maneja el login y guarda los datos en Postgres.
// La app habla con /api/* a través de public/shim.js (misma interfaz que tenía en Claude).

import { SQL } from "bun";

const PORT = Number(Bun.env.PORT || 3000);
const DIR = import.meta.dir;

/* ---------------- Roles y permisos ----------------
   Por ahora solo existe "admin" (acceso a todo).
   Para sumar cuentas limitadas se agrega un rol acá:
   - leer / escribir: "*" o lista de colecciones
   - pestanas: "*" o lista de pestañas visibles en la app */
type Rol = { nombre: string; leer: "*" | string[]; escribir: "*" | string[]; pestanas: "*" | string[]; usuarios?: boolean };
const ROLES: Record<string, Rol> = {
  admin: { nombre: "Administrador", leer: "*", escribir: "*", pestanas: "*", usuarios: true },
};
const rolDe = (u: Usuario) => ROLES[u.rol] || null;
const raiz = (coll: string) => coll.split("/")[0];
const puede = (u: Usuario, accion: "leer" | "escribir", coll: string) => {
  const r = rolDe(u); if (!r) return false;
  const p = r[accion]; return p === "*" || p.includes(raiz(coll));
};

/* ---------------- Almacenamiento ---------------- */
type Usuario = { id: string; usuario: string; nombre: string; rol: string; pass: string; activo: boolean };
const pg = Bun.env.DATABASE_URL ? new SQL(Bun.env.DATABASE_URL) : null;
const docs = new Map<string, Map<string, any>>(); // coll -> id -> data
const usuarios = new Map<string, Usuario>();       // id -> usuario
const sesiones = new Map<string, { uid: string; vence: number }>();

async function iniciarBase() {
  if (pg) {
    await pg`create table if not exists docs (coll text not null, id text not null, data jsonb not null, actualizado timestamptz not null default now(), primary key (coll, id))`;
    await pg`create table if not exists usuarios (id text primary key, usuario text not null unique, nombre text not null, rol text not null default 'admin', pass text not null, activo boolean not null default true, creado timestamptz not null default now())`;
    await pg`create table if not exists sesiones (token text primary key, uid text not null references usuarios(id) on delete cascade, vence timestamptz not null)`;
    // Arreglo: versiones anteriores guardaban cada documento como texto JSON dentro del jsonb (doble codificación)
    const arreglados = await pg`update docs set data = (data #>> '{}')::jsonb where jsonb_typeof(data) = 'string' returning id`;
    if (arreglados.length) console.log(`Documentos reparados (estaban guardados como texto): ${arreglados.length}`);
    for (const r of await pg`select coll, id, data::text as data from docs`) { let d = JSON.parse(r.data); if (typeof d === "string") d = JSON.parse(d); col(r.coll).set(r.id, d); }
    for (const r of await pg`select id, usuario, nombre, rol, pass, activo from usuarios`) usuarios.set(r.id, r as Usuario);
    for (const r of await pg`select token, uid, vence from sesiones where vence > now()`) sesiones.set(r.token, { uid: r.uid, vence: new Date(r.vence).getTime() });
    await pg`delete from sesiones where vence <= now()`;
  }
  // Datos iniciales (copia de la app anterior), solo si la base está vacía
  let total = 0; for (const m of docs.values()) total += m.size;
  if (total === 0) {
    const f = Bun.file(DIR + "/seed.json");
    if (await f.exists()) {
      const seed = await f.json() as Record<string, Record<string, any>>;
      let n = 0;
      for (const [c, ds] of Object.entries(seed)) for (const [id, data] of Object.entries(ds)) { await guardar(c, id, data); n++; }
      console.log(`Datos iniciales cargados: ${n} documentos`);
    }
  }
  // Cuenta admin inicial
  if (usuarios.size === 0) {
    const clave = Bun.env.ADMIN_PASSWORD;
    if (!clave) { console.error("Falta ADMIN_PASSWORD: no se creó la cuenta admin"); }
    else {
      const u: Usuario = {
        id: Bun.env.ADMIN_ID || "u_kGXy4VJOykAdzDxZtPZF3g",
        usuario: (Bun.env.ADMIN_USER || "admin").toLowerCase(),
        nombre: Bun.env.ADMIN_NOMBRE || "Admin",
        rol: "admin", pass: await Bun.password.hash(clave), activo: true,
      };
      await guardarUsuario(u);
      console.log(`Cuenta admin creada: ${u.usuario}`);
    }
  }
}
function col(c: string) { let m = docs.get(c); if (!m) { m = new Map(); docs.set(c, m); } return m; }
async function guardar(c: string, id: string, data: any) {
  if (pg) await pg`insert into docs (coll, id, data) values (${c}, ${id}, ${JSON.stringify(data)}::text::jsonb) on conflict (coll, id) do update set data = excluded.data, actualizado = now()`;
  col(c).set(id, data);
}
async function borrar(c: string, id: string) {
  if (pg) await pg`delete from docs where coll = ${c} and id = ${id}`;
  col(c).delete(id);
}
async function guardarUsuario(u: Usuario) {
  if (pg) await pg`insert into usuarios (id, usuario, nombre, rol, pass, activo) values (${u.id}, ${u.usuario}, ${u.nombre}, ${u.rol}, ${u.pass}, ${u.activo}) on conflict (id) do update set usuario = excluded.usuario, nombre = excluded.nombre, rol = excluded.rol, pass = excluded.pass, activo = excluded.activo`;
  usuarios.set(u.id, u);
}

/* ---------------- Sesiones ---------------- */
const DIAS_SESION = 30;
function cookie(req: Request, nombre: string) {
  const h = req.headers.get("cookie") || "";
  for (const p of h.split(";")) { const [k, ...v] = p.trim().split("="); if (k === nombre) return decodeURIComponent(v.join("=")); }
  return null;
}
function usuarioDe(req: Request): Usuario | null {
  const t = cookie(req, "sesion"); if (!t) return null;
  const s = sesiones.get(t); if (!s || s.vence < Date.now()) return null;
  const u = usuarios.get(s.uid); return u && u.activo ? u : null;
}
async function crearSesion(uid: string) {
  const token = Buffer.from(crypto.getRandomValues(new Uint8Array(32))).toString("base64url");
  const vence = Date.now() + DIAS_SESION * 864e5;
  if (pg) await pg`insert into sesiones (token, uid, vence) values (${token}, ${uid}, ${new Date(vence)})`;
  sesiones.set(token, { uid, vence });
  return token;
}
async function cerrarSesion(req: Request) {
  const t = cookie(req, "sesion"); if (!t) return;
  sesiones.delete(t); if (pg) await pg`delete from sesiones where token = ${t}`;
}
const esHttps = (req: Request) => req.headers.get("x-forwarded-proto") === "https" || new URL(req.url).protocol === "https:";
const cookieSesion = (req: Request, token: string, maxAge: number) =>
  `sesion=${token}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${maxAge}${esHttps(req) ? "; Secure" : ""}`;

// Límite de intentos de login por IP: 10 cada 15 minutos
const intentos = new Map<string, number[]>();
function ipDe(req: Request, server: any) { return (req.headers.get("x-forwarded-for") || "").split(",")[0].trim() || server.requestIP(req)?.address || "?"; }
function bloqueado(ip: string) { const ahora = Date.now(); const l = (intentos.get(ip) || []).filter(t => ahora - t < 15 * 60e3); intentos.set(ip, l); return l.length >= 10; }

/* ---------------- Rutas y consultas ---------------- */
const SEG = /^[A-Za-z0-9_\-.~:@+]+$/;
function partir(path: unknown, par: boolean) {
  if (typeof path !== "string") throw new Err("invalid_argument", "Ruta inválida");
  const s = path.split("/");
  if (!s.every(x => SEG.test(x) && x !== "." && x !== "..") || s.length > 16 || (s.length % 2 === 0) !== par) throw new Err("invalid_argument", "Ruta inválida: " + path);
  return s;
}
const rutaDoc = (p: unknown) => { const s = partir(p, true); return { c: s.slice(0, -1).join("/"), id: s[s.length - 1] }; };
const rutaCol = (p: unknown) => partir(p, false).join("/");
class Err extends Error { constructor(public code: string, msg: string, public status = 400) { super(msg); } }

const esObj = (v: any) => v !== null && typeof v === "object" && !Array.isArray(v);
function fusionar(base: any, parche: any) {
  const out = { ...base };
  for (const [k, v] of Object.entries(parche)) out[k] = esObj(v) && esObj(out[k]) ? fusionar(out[k], v) : v;
  return out;
}
function comparar(a: any, b: any) {
  if (typeof a === typeof b && (typeof a === "number" || typeof a === "string" || typeof a === "boolean")) return a < b ? -1 : a > b ? 1 : 0;
  return null;
}
function cumple(d: any, [campo, op, val]: [string, string, any]) {
  const v = d?.[campo];
  const ig = (x: any, y: any) => JSON.stringify(x) === JSON.stringify(y);
  switch (op) {
    case "==": case "eq": return ig(v, val);
    case "!=": case "ne": return v !== undefined && !ig(v, val);
    case "in": return Array.isArray(val) && val.some(x => ig(v, x));
    case "not-in": return v !== undefined && Array.isArray(val) && !val.some(x => ig(v, x));
    case "array-contains": return Array.isArray(v) && v.some(x => ig(x, val));
    default: {
      const c = comparar(v, val); if (c === null) return false;
      return op === "<" || op === "lt" ? c < 0 : op === "<=" || op === "lte" ? c <= 0 : op === ">" || op === "gt" ? c > 0 : op === ">=" || op === "gte" ? c >= 0 : false;
    }
  }
}
function consultar(c: string, where: any[] = [], orderBy: [string, string] | null = null, limit?: number) {
  let l = [...col(c).entries()].map(([id, data]) => ({ id, data }));
  for (const w of where || []) l = l.filter(x => cumple(x.data, w));
  if (orderBy) {
    const [f, dir] = orderBy; const s = dir === "desc" ? -1 : 1;
    l.sort((a, b) => {
      const va = a.data?.[f], vb = b.data?.[f];
      if (va === undefined && vb === undefined) return a.id < b.id ? -1 : 1;
      if (va === undefined) return 1; if (vb === undefined) return -1;
      return (comparar(va, vb) ?? 0) * s || (a.id < b.id ? -1 : 1);
    });
  } else l.sort((a, b) => a.id < b.id ? -1 : a.id > b.id ? 1 : 0);
  if (limit) l = l.slice(0, Math.max(1, Math.min(1000, limit)));
  return l;
}

/* ---------------- Tiempo real (SSE) ---------------- */
const oyentes = new Set<ReadableStreamDefaultController>();
const enc = new TextEncoder();
function avisar(c: string, id: string) {
  const msg = enc.encode(`data: ${JSON.stringify({ c, i: id })}\n\n`);
  for (const o of oyentes) { try { o.enqueue(msg); } catch { oyentes.delete(o); } }
}
setInterval(() => { const p = enc.encode(`: ping\n\n`); for (const o of oyentes) { try { o.enqueue(p); } catch { oyentes.delete(o); } } }, 25e3);

/* ---------------- Páginas ---------------- */
let APP = "";
async function cargarApp() {
  const html = await Bun.file(DIR + "/public/app.html").text();
  APP = html.replace("<head>", `<head><script src="/shim.js?v=${Date.now()}"></script>`);
}
const ESC: Record<string, string> = { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" };
const esc = (s: string) => s.replace(/[&<>"]/g, c => ESC[c]);
function pagina(titulo: string, cuerpo: string) {
  return `<!doctype html><html lang="es"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>${titulo} · Comanda Usual</title>
<link rel="stylesheet" href="https://fonts.googleapis.com/css2?family=Inter:wght@400;500;600;700&display=swap">
<style>
*{box-sizing:border-box}body{margin:0;min-height:100vh;display:grid;place-items:center;background:#f4f4f5;font:15px Inter,-apple-system,sans-serif;color:#18181b}
@media (prefers-color-scheme:dark){body{background:#0f0f11;color:#f4f4f5}.card{background:#18181b!important;border-color:#27272a!important}input{background:#0f0f11!important;color:#f4f4f5!important;border-color:#3f3f46!important}}
.card{width:min(360px,92vw);background:#fff;border:1px solid #e4e4e7;border-radius:14px;padding:28px}
h1{font-size:20px;margin:0 0 4px}p.sub{margin:0 0 22px;color:#71717a;font-size:13px}
label{display:block;font-size:13px;font-weight:500;margin:14px 0 6px}
input{width:100%;padding:10px 12px;border:1px solid #d4d4d8;border-radius:8px;font:inherit;background:#fff}
input:focus{outline:2px solid #6366f1;outline-offset:-1px;border-color:transparent}
button{margin-top:20px;width:100%;padding:11px;border:0;border-radius:8px;background:#18181b;color:#fff;font:600 15px Inter,sans-serif;cursor:pointer}
@media (prefers-color-scheme:dark){button{background:#f4f4f5;color:#18181b}}
.err{margin-top:14px;padding:9px 12px;border-radius:8px;background:#fee2e2;color:#991b1b;font-size:13px}
.ok{margin-top:14px;padding:9px 12px;border-radius:8px;background:#dcfce7;color:#166534;font-size:13px}
a{color:#6366f1;font-size:13px}
</style></head><body><div class="card">${cuerpo}</div></body></html>`;
}
const loginHTML = (error = "", usuario = "") => pagina("Entrar", `
<h1>Comanda Usual</h1><p class="sub">Ingresá con tu usuario</p>
<form method="post" action="/login">
<label for="u">Usuario</label><input id="u" name="usuario" autocomplete="username" autocapitalize="none" required value="${esc(usuario)}" autofocus>
<label for="p">Contraseña</label><input id="p" name="clave" type="password" autocomplete="current-password" required>
<button>Entrar</button>${error ? `<div class="err">${esc(error)}</div>` : ""}
</form>`);
const claveHTML = (msg = "", ok = false) => pagina("Cambiar contraseña", `
<h1>Cambiar contraseña</h1><p class="sub"><a href="/">← Volver a la comanda</a></p>
<form method="post" action="/clave">
<label for="a">Contraseña actual</label><input id="a" name="actual" type="password" autocomplete="current-password" required>
<label for="n">Nueva contraseña</label><input id="n" name="nueva" type="password" autocomplete="new-password" minlength="8" required>
<label for="r">Repetir nueva</label><input id="r" name="repetir" type="password" autocomplete="new-password" minlength="8" required>
<button>Guardar</button>${msg ? `<div class="${ok ? "ok" : "err"}">${esc(msg)}</div>` : ""}
</form>`);

const html = (body: string, status = 200, extra: Record<string, string> = {}) =>
  new Response(body, { status, headers: { "content-type": "text/html; charset=utf-8", "cache-control": "no-store", ...extra } });
const json = (data: any, status = 200) => Response.json(data, { status, headers: { "cache-control": "no-store" } });
const ir = (a: string, extra: Record<string, string> = {}) => new Response(null, { status: 303, headers: { location: a, ...extra } });

/* ---------------- Servidor ---------------- */
await iniciarBase();
await cargarApp();

Bun.serve({
  port: PORT,
  idleTimeout: 0,
  async fetch(req, server) {
    const url = new URL(req.url);
    const p = url.pathname;
    try {
      if (p === "/salud") return new Response("ok");

      if (p === "/login" && req.method === "GET") return usuarioDe(req) ? ir("/") : html(loginHTML());
      if (p === "/login" && req.method === "POST") {
        const ip = ipDe(req, server);
        const f = await req.formData();
        const usuario = String(f.get("usuario") || "").trim().toLowerCase();
        const clave = String(f.get("clave") || "");
        if (bloqueado(ip)) return html(loginHTML("Demasiados intentos. Probá de nuevo en unos minutos.", usuario), 429);
        const u = [...usuarios.values()].find(x => x.usuario === usuario && x.activo);
        if (!u || !(await Bun.password.verify(clave, u.pass))) {
          intentos.get(ip)!.push(Date.now());
          return html(loginHTML("Usuario o contraseña incorrectos", usuario), 401);
        }
        intentos.delete(ip);
        const token = await crearSesion(u.id);
        return ir("/", { "set-cookie": cookieSesion(req, token, DIAS_SESION * 86400) });
      }
      if (p === "/logout") { await cerrarSesion(req); return ir("/login", { "set-cookie": cookieSesion(req, "", 0) }); }

      const u = usuarioDe(req);
      if (!u) return p.startsWith("/api/") ? json({ code: "revoked", message: "Sesión vencida" }, 401) : ir("/login");

      if (p === "/" || p === "/index.html") return html(APP);
      if (p === "/shim.js") return new Response(Bun.file(DIR + "/public/shim.js"), { headers: { "content-type": "text/javascript; charset=utf-8", "cache-control": "no-store" } });
      if (p === "/clave" && req.method === "GET") return html(claveHTML());
      if (p === "/clave" && req.method === "POST") {
        const f = await req.formData();
        const actual = String(f.get("actual") || ""), nueva = String(f.get("nueva") || ""), rep = String(f.get("repetir") || "");
        if (!(await Bun.password.verify(actual, u.pass))) return html(claveHTML("La contraseña actual no es correcta"), 400);
        if (nueva.length < 8) return html(claveHTML("La nueva contraseña tiene que tener al menos 8 caracteres"), 400);
        if (nueva !== rep) return html(claveHTML("Las contraseñas nuevas no coinciden"), 400);
        await guardarUsuario({ ...u, pass: await Bun.password.hash(nueva) });
        return html(claveHTML("Contraseña actualizada", true));
      }

      if (p === "/api/yo") {
        const r = rolDe(u);
        return json({ id: u.id, usuario: u.usuario, nombre: u.nombre, rol: u.rol, rolNombre: r?.nombre || u.rol, pestanas: r?.pestanas || [], escribir: r?.escribir || [], usuarios: !!r?.usuarios });
      }
      if (p === "/api/eventos") {
        let ctl: ReadableStreamDefaultController;
        const stream = new ReadableStream({
          start(c) { ctl = c; oyentes.add(c); c.enqueue(enc.encode(`retry: 3000\n: hola\n\n`)); },
          cancel() { oyentes.delete(ctl); },
        });
        req.signal.addEventListener("abort", () => oyentes.delete(ctl));
        return new Response(stream, { headers: { "content-type": "text/event-stream", "cache-control": "no-store", "x-accel-buffering": "no" } });
      }

      if (req.method === "POST" && p.startsWith("/api/")) {
        const b = await req.json().catch(() => { throw new Err("invalid_argument", "JSON inválido"); });
        const acc = p.slice(5);
        if (acc === "perfiles") {
          const out: Record<string, { name: string }> = {};
          for (const id of Array.isArray(b.ids) ? b.ids : []) { const x = usuarios.get(id); if (x) out[id] = { name: x.nombre }; }
          return json({ perfiles: out });
        }
        if (acc === "query") {
          const c = rutaCol(b.coll);
          if (!puede(u, "leer", c)) return json({ docs: [] });
          return json({ docs: consultar(c, b.where, b.orderBy, b.limit) });
        }
        const { c, id } = rutaDoc(b.path);
        if (acc === "get") return json({ data: puede(u, "leer", c) ? col(c).get(id) ?? null : null });
        if (!puede(u, "escribir", c)) throw new Err("invalid_argument", "Sin permiso para modificar esto", 403);
        if (acc === "set" || acc === "update") {
          if (!esObj(b.data)) throw new Err("invalid_argument", "El documento tiene que ser un objeto");
          if (JSON.stringify(b.data).length > 256 * 1024) throw new Err("invalid_argument", "Documento demasiado grande");
          let data = b.data;
          if (acc === "update") { const prev = col(c).get(id); if (prev === undefined) throw new Err("invalid_argument", "El documento no existe"); data = fusionar(prev, b.data); }
          await guardar(c, id, data); avisar(c, id); return json({ ok: true });
        }
        if (acc === "delete") { await borrar(c, id); avisar(c, id); return json({ ok: true }); }
      }
      return new Response("No encontrado", { status: 404 });
    } catch (e: any) {
      if (e instanceof Err) return json({ code: e.code, message: e.message }, e.status);
      console.error(e);
      return json({ code: "unavailable", message: "Error del servidor" }, 500);
    }
  },
});
console.log(`Comanda Usual escuchando en :${PORT}${pg ? "" : " (sin base de datos: datos en memoria)"}`);
