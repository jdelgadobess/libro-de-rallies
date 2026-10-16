// Reads the waypoints (name, coordinates, page) from photos of roadbook pages.
import Anthropic from "npm:@anthropic-ai/sdk@0.129.0";
import { zodOutputFormat } from "npm:@anthropic-ai/sdk@0.129.0/helpers/zod";
import { z } from "npm:zod@4.6.5";
import { createClient } from "npm:@supabase/supabase-js@2.117.2";

const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};
const reply = (status: number, body: unknown) =>
  new Response(JSON.stringify(body), { status, headers: { ...CORS, "Content-Type": "application/json" } });

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

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: CORS });
  if (req.method !== "POST") return reply(405, { error: "Usa POST." });

  // who is calling: the database decides with the same rules as the web
  const supabase = createClient(Deno.env.get("SUPABASE_URL")!, Deno.env.get("SUPABASE_ANON_KEY")!, {
    global: { headers: { Authorization: req.headers.get("Authorization") ?? "" } },
  });
  const { data: role } = await supabase.rpc("my_role");
  if (role !== "admin" && role !== "editor") return reply(403, { error: "No tienes permiso para añadir waypoints." });

  let images: { mediaType: string; data: string }[] = [];
  try { images = (await req.json())?.images ?? []; } catch { /* handled below */ }
  if (!Array.isArray(images) || !images.length || images.length > 10) return reply(400, { error: "Envía entre 1 y 10 fotos." });
  if (images.some((im) => !MEDIA.has(im?.mediaType) || typeof im?.data !== "string" || !im.data)) return reply(400, { error: "Formato de foto no válido." });

  const client = new Anthropic({ apiKey: Deno.env.get("ANTHROPIC_API_KEY") });
  try {
    const response = await client.messages.parse({
      model: "claude-opus-5-5",
      max_tokens: 16000,
      output_config: { effort: "high", format: zodOutputFormat(Lectura) },
      messages: [{
        role: "user",
        content: [
          ...images.map((im) => ({
            type: "image" as const,
            source: { type: "base64" as const, media_type: im.mediaType as "image/jpeg", data: im.data },
          })),
          { type: "text" as const, text: PROMPT },
        ],
      }],
    });
    if (response.stop_reason === "refusal") return reply(422, { error: "No se pudieron leer estas fotos." });
    if (response.stop_reason === "max_tokens") return reply(413, { error: "Demasiados waypoints de una vez. Sube menos fotos por tanda." });
    return reply(200, { waypoints: response.parsed_output?.waypoints ?? [] });
  } catch (err) {
    if (err instanceof Anthropic.RateLimitError) return reply(429, { error: "Demasiadas lecturas seguidas. Espera un poco." });
    if (err instanceof Anthropic.AuthenticationError) { console.error("Clave de Anthropic no válida"); return reply(500, { error: "La clave de lectura de fotos no es válida." }); }
    if (err instanceof Anthropic.BadRequestError) { console.error(err.message); return reply(400, { error: "Alguna foto no se pudo usar. Prueba con JPG." }); }
    if (err instanceof Anthropic.APIError) { console.error(err.status, err.message); return reply(503, { error: "El servicio de lectura no responde. Inténtalo de nuevo." }); }
    console.error(err);
    return reply(500, { error: "Error leyendo las fotos." });
  }
});
