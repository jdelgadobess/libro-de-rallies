import { onCall, onRequest, HttpsError } from "firebase-functions/https";
import { defineSecret } from "firebase-functions/params";
import { logger } from "firebase-functions";
import { initializeApp } from "firebase-admin/app";
import { getFirestore } from "firebase-admin/firestore";
import Anthropic from "@anthropic-ai/sdk";
import { zodOutputFormat } from "@anthropic-ai/sdk/helpers/zod";
import { z } from "zod";

initializeApp();
const db = getFirestore();
const ANTHROPIC_API_KEY = defineSecret("ANTHROPIC_API_KEY");
const REGION = "europe-west1";

/* ---------- who is calling ---------- */
async function roleOf(auth) {
  if (!auth) return null;
  const owner = await db.doc("config/owner").get();
  if (owner.exists && owner.get("uid") === auth.uid) return "admin";
  const email = String(auth.token.email || "").toLowerCase();
  if (!email) return null;
  const m = await db.doc(`members/${email}`).get();
  return m.exists ? m.get("role") : null;
}

/* ---------- read waypoints from roadbook photos ---------- */
const Waypoint = z.object({
  name: z.string().describe("Nombre tal cual: WP27, WPV3, DSS, ASS, CP2…"),
  lat: z.string().describe("Latitud exactamente como está impresa, con hemisferio, p. ej. N30°42.503'"),
  lon: z.string().describe("Longitud exactamente como está impresa, con hemisferio, p. ej. W004°28.337'"),
  page: z.string().describe("Número de página del roadbook, o vacío si no se ve"),
  box: z.string().describe("Número de casilla o viñeta, o vacío"),
  km: z.string().describe("Kilómetro parcial de la casilla, o vacío"),
  note: z.string().describe("Nota breve si la hay (radio de validación, CAP…), o vacío"),
  dudoso: z.boolean().describe("true si algún dígito no se lee con seguridad"),
});
const Lectura = z.object({ waypoints: z.array(Waypoint) });

const PROMPT = `Las imágenes son fotos de páginas completas del roadbook de un rally raid en Marruecos.
Extrae TODOS los waypoints que tengan coordenadas GPS escritas (WP, WPV, WPM, WPS, WPE, WPC, DSS, ASS, CP…), en el orden en que aparecen en el roadbook.
Copia las coordenadas EXACTAMENTE como están impresas, con su hemisferio. No calcules, no redondees y no inventes: si un dígito no se lee con seguridad, marca "dudoso": true.
El número de página suele estar en una esquina de la hoja. Si no hay ningún waypoint con coordenadas, devuelve una lista vacía.`;

const MEDIA = new Set(["image/jpeg", "image/png", "image/webp", "image/gif"]);

export const leerRoadbook = onCall(
  { region: REGION, secrets: [ANTHROPIC_API_KEY], timeoutSeconds: 300, memory: "512MiB" },
  async (req) => {
    const role = await roleOf(req.auth);
    if (role !== "admin" && role !== "editor") throw new HttpsError("permission-denied", "No tienes permiso para añadir waypoints.");
    const images = Array.isArray(req.data?.images) ? req.data.images : [];
    if (!images.length || images.length > 10) throw new HttpsError("invalid-argument", "Envía entre 1 y 10 fotos.");
    for (const im of images) {
      if (!MEDIA.has(im?.mediaType) || typeof im?.data !== "string" || !im.data) throw new HttpsError("invalid-argument", "Formato de foto no válido.");
    }

    const client = new Anthropic({ apiKey: ANTHROPIC_API_KEY.value() });
    try {
      const response = await client.messages.parse({
        model: "claude-opus-5-5",
        max_tokens: 16000,
        output_config: { effort: "high", format: zodOutputFormat(Lectura) },
        messages: [{
          role: "user",
          content: [
            ...images.map((im) => ({ type: "image", source: { type: "base64", media_type: im.mediaType, data: im.data } })),
            { type: "text", text: PROMPT },
          ],
        }],
      });
      if (response.stop_reason === "refusal") throw new HttpsError("failed-precondition", "No se pudieron leer estas fotos.");
      if (response.stop_reason === "max_tokens") throw new HttpsError("resource-exhausted", "Demasiados waypoints de una vez. Sube menos fotos por tanda.");
      return { waypoints: response.parsed_output?.waypoints ?? [] };
    } catch (err) {
      if (err instanceof HttpsError) throw err;
      if (err instanceof Anthropic.RateLimitError) throw new HttpsError("resource-exhausted", "Demasiadas lecturas seguidas. Espera un poco.");
      if (err instanceof Anthropic.AuthenticationError) { logger.error("Clave de Anthropic no válida"); throw new HttpsError("internal", "La clave de lectura de fotos no es válida."); }
      if (err instanceof Anthropic.BadRequestError) { logger.error(err.message); throw new HttpsError("invalid-argument", "Alguna foto no se pudo usar. Prueba con JPG."); }
      if (err instanceof Anthropic.APIError) { logger.error(err.status, err.message); throw new HttpsError("unavailable", "El servicio de lectura no responde. Inténtalo de nuevo."); }
      logger.error(err);
      throw new HttpsError("internal", "Error leyendo las fotos.");
    }
  },
);

/* ---------- live KML feed for Google Earth (network link) ---------- */
const xe = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&apos;" }[c]));
const COLORS = ["#c1272d", "#2f4fb5", "#006233", "#e3a21a", "#b5532c", "#1b8a8a", "#7a3b8f", "#d9662b", "#4f7f2a", "#8c1d40"];
const abgr = (c) => "ff" + c.slice(5, 7) + c.slice(3, 5) + c.slice(1, 3);
const natural = (a, b) => String(a).localeCompare(String(b), "es", { numeric: true });
function orderKey(w) {
  const n = String(w.name || "").toUpperCase().trim();
  if (/^(DSS|START|SALIDA|DEPART)/.test(n)) return -1;
  if (/^(ASS|FIN|LLEGADA|ARRIV)/.test(n)) return 1e9;
  const m = n.match(/\d+/);
  return m ? parseInt(m[0], 10) : 5e8;
}

export const kml = onRequest({ region: REGION, cors: true }, async (req, res) => {
  const token = String(req.path || "").split("/").filter(Boolean).pop()?.replace(/\.kml$/, "");
  const feed = await db.doc("config/feed").get();
  if (!token || !feed.exists || feed.get("token") !== token) { res.status(404).send("No encontrado"); return; }

  const [rs, ws] = await Promise.all([db.collection("rallies").get(), db.collection("waypoints").get()]);
  const rallies = rs.docs.map((d) => ({ id: d.id, ...d.data() })).sort((a, b) => b.year - a.year);
  const wps = ws.docs.map((d) => d.data()).filter((w) => Number.isFinite(w.lat) && Number.isFinite(w.lon));
  let styles = "";
  COLORS.forEach((c, i) => { styles += `<Style id="c${i}"><IconStyle><color>${abgr(c)}</color><Icon><href>http://maps.google.com/mapfiles/kml/paddle/wht-blank.png</href></Icon></IconStyle></Style>\n`; });
  let body = "";
  for (const r of rallies) {
    const mine = wps.filter((w) => w.rallyId === r.id);
    if (!mine.length) continue;
    const stages = [...new Set(mine.map((w) => String(w.stage ?? "")))].sort((a, b) => (a === "") - (b === "") || natural(a, b));
    body += `<Folder><name>${xe(r.year + " · " + r.name)}</name>\n`;
    stages.forEach((s, si) => {
      body += `<Folder><name>${xe(s ? "Etapa " + s : "Sin etapa")}</name>\n`;
      mine.filter((w) => String(w.stage ?? "") === s).sort((a, b) => orderKey(a) - orderKey(b) || (a.seq ?? 0) - (b.seq ?? 0)).forEach((w) => {
        const desc = [w.page ? "Pág " + w.page : "", w.desc].filter(Boolean).join(" · ");
        body += `<Placemark><name>${xe(w.name)}</name><description>${xe(desc)}</description><styleUrl>#c${si % COLORS.length}</styleUrl><Point><coordinates>${w.lon.toFixed(6)},${w.lat.toFixed(6)},0</coordinates></Point></Placemark>\n`;
      });
      body += `</Folder>\n`;
    });
    body += `</Folder>\n`;
  }
  res.set("Content-Type", "application/vnd.google-earth.kml+xml; charset=utf-8");
  res.set("Cache-Control", "no-store");
  res.send(`<?xml version="1.0" encoding="UTF-8"?>\n<kml xmlns="http://www.opengis.net/kml/2.2"><Document><name>Libro de Rallies</name>\n${styles}${body}</Document></kml>\n`);
});
