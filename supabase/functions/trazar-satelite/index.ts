// Looks at a satellite image between two waypoints and traces a visible dirt track joining them, if there is a clear one.
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

const Traza = z.object({
  encontrado: z.boolean().describe("true solo si se ve con claridad una pista, camino o rodada que lleve de A a B"),
  claridad: z.enum(["alta", "media", "baja"]).describe("Lo claro que se ve el camino trazado"),
  puntos: z.array(z.object({ x: z.number(), y: z.number() })).describe("Puntos del camino en píxeles de la imagen, de A a B, siguiendo sus curvas"),
  nota: z.string().describe("Una frase: qué camino has seguido o por qué no hay ninguno claro"),
});

const MEDIA = new Set(["image/jpeg", "image/png", "image/webp"]);

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: CORS });
  if (req.method !== "POST") return reply(405, { error: "Usa POST." });

  const supabase = createClient(Deno.env.get("SUPABASE_URL")!, Deno.env.get("SUPABASE_ANON_KEY")!, {
    global: { headers: { Authorization: req.headers.get("Authorization") ?? "" } },
  });
  const { data: role } = await supabase.rpc("my_role");
  if (!role) return reply(403, { error: "No tienes acceso." });

  let b: { image?: { mediaType: string; data: string }; width?: number; height?: number; a?: number[]; b?: number[]; mpp?: number } = {};
  try { b = await req.json(); } catch { /* handled below */ }
  const ok = (p?: number[]) => Array.isArray(p) && p.length === 2 && p.every((v) => Number.isFinite(v));
  if (!b.image || !MEDIA.has(b.image.mediaType) || typeof b.image.data !== "string" || !ok(b.a) || !ok(b.b) || !b.width || !b.height)
    return reply(400, { error: "Datos no válidos." });

  const prompt = `Imagen de satélite de Marruecos (norte arriba), de ${b.width}×${b.height} píxeles, unos ${Number(b.mpp).toFixed(1)} metros por píxel.
El punto A es el círculo verde en (${Math.round(b.a![0])}, ${Math.round(b.a![1])}) y el punto B el círculo rojo en (${Math.round(b.b![0])}, ${Math.round(b.b![1])}).
Un coche 4x4 de rally tiene que ir de A a B. Busca en la imagen una pista de tierra, camino, rodadas marcadas o carretera que lleve de A a B (o que pase muy cerca de los dos).
Si la ves con claridad, traza su recorrido con puntos en píxeles de la imagen, empezando en A y terminando en B, uno cada 20–40 píxeles y en cada curva, siguiendo el centro del camino. No traces líneas rectas campo a través ni por lechos de río sin rodadas.
Si no hay ningún camino claro, pon "encontrado": false y deja "puntos" vacío.`;

  const client = new Anthropic({ apiKey: Deno.env.get("ANTHROPIC_API_KEY") });
  try {
    const response = await client.messages.parse({
      model: "claude-opus-5-5",
      max_tokens: 8000,
      output_config: { effort: "high", format: zodOutputFormat(Traza) },
      messages: [{
        role: "user",
        content: [
          { type: "image", source: { type: "base64", media_type: b.image.mediaType as "image/jpeg", data: b.image.data } },
          { type: "text", text: prompt },
        ],
      }],
    });
    if (response.stop_reason === "refusal") return reply(422, { error: "No se pudo analizar la imagen." });
    return reply(200, response.parsed_output ?? { encontrado: false, claridad: "baja", puntos: [], nota: "" });
  } catch (err) {
    if (err instanceof Anthropic.RateLimitError) return reply(429, { error: "Demasiadas consultas seguidas. Espera un poco." });
    if (err instanceof Anthropic.APIError) { console.error(err.status, err.message); return reply(503, { error: "El servicio no responde. Inténtalo de nuevo." }); }
    console.error(err);
    return reply(500, { error: "Error analizando el satélite." });
  }
});
