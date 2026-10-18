// Reads a car's details from photos or PDFs of its technical sheet (ficha técnica / tarjeta ITV) or registration papers.
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

const f = (d: string) => z.string().describe(d + ". Vacío si no aparece");
const Ficha = z.object({
  marca: f("Marca (D.1), p. ej. FIAT"),
  modelo: f("Denominación comercial (D.3), p. ej. PANDA 4X4"),
  version: f("Tipo, variante y versión (D.2)"),
  matricula: f("Matrícula (A), sin espacios raros, p. ej. 1234ABC"),
  bastidor: f("Número de bastidor / VIN (E)"),
  fecha_matriculacion: f("Fecha de primera matriculación (B) en formato AAAA-MM-DD"),
  cilindrada: f("Cilindrada en cm3 (P.1), solo el número"),
  potencia: f("Potencia (P.2) tal cual, p. ej. 37 kW o 50 CV"),
  combustible: f("Combustible (P.3): Gasolina, Diésel…"),
  plazas: f("Número de plazas (S.1)"),
  mma: f("Masa máxima autorizada en kg (F.1)"),
  tara: f("Masa en orden de marcha o tara en kg (G)"),
  neumaticos: f("Medida de neumáticos, p. ej. 145/80 R13"),
  itv_hasta: f("Fecha de caducidad de la ITV si hay sello o anotación, AAAA-MM-DD"),
  titular: f("Titular, si aparece en el permiso de circulación"),
  notas: f("Reformas o anotaciones importantes (suspensión, defensas, snorkel…), breve"),
});

const PROMPT = `Las imágenes o PDF son la documentación de un coche (normalmente un 4x4): ficha técnica (tarjeta de inspección técnica), permiso de circulación o equivalentes de otro país (libretto italiano, carte grise…).
Copia cada dato EXACTAMENTE como está impreso, sin inventar. Si un dato no aparece en ninguna foto, déjalo vacío. Las fechas, en formato AAAA-MM-DD.`;

const MEDIA = new Set(["image/jpeg", "image/png", "image/webp", "image/gif", "application/pdf"]);

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: CORS });
  if (req.method !== "POST") return reply(405, { error: "Usa POST." });

  const supabase = createClient(Deno.env.get("SUPABASE_URL")!, Deno.env.get("SUPABASE_ANON_KEY")!, {
    global: { headers: { Authorization: req.headers.get("Authorization") ?? "" } },
  });
  const { data: role } = await supabase.rpc("my_role");
  if (role !== "admin" && role !== "editor") return reply(403, { error: "No tienes permiso para añadir coches." });

  let images: { mediaType: string; data: string }[] = [];
  try { images = (await req.json())?.images ?? []; } catch { /* handled below */ }
  if (!Array.isArray(images) || !images.length || images.length > 4) return reply(400, { error: "Envía entre 1 y 4 fotos o PDF." });
  if (images.some((im) => !MEDIA.has(im?.mediaType) || typeof im?.data !== "string" || !im.data)) return reply(400, { error: "Formato de foto no válido." });

  const client = new Anthropic({ apiKey: Deno.env.get("ANTHROPIC_API_KEY") });
  try {
    const response = await client.messages.parse({
      model: "claude-opus-5-5",
      max_tokens: 4000,
      output_config: { effort: "medium", format: zodOutputFormat(Ficha) },
      messages: [{
        role: "user",
        content: [
          ...images.map((im) => im.mediaType === "application/pdf"
            ? { type: "document" as const, source: { type: "base64" as const, media_type: "application/pdf" as const, data: im.data } }
            : { type: "image" as const, source: { type: "base64" as const, media_type: im.mediaType as "image/jpeg", data: im.data } }),
          { type: "text" as const, text: PROMPT },
        ],
      }],
    });
    if (response.stop_reason === "refusal") return reply(422, { error: "No se pudieron leer estas fotos." });
    return reply(200, { ficha: response.parsed_output ?? {} });
  } catch (err) {
    if (err instanceof Anthropic.RateLimitError) return reply(429, { error: "Demasiadas lecturas seguidas. Espera un poco." });
    if (err instanceof Anthropic.BadRequestError) { console.error(err.message); return reply(400, { error: "Algún archivo no se pudo usar. Prueba con una foto JPG o un PDF más pequeño." }); }
    if (err instanceof Anthropic.APIError) { console.error(err.status, err.message); return reply(503, { error: "El servicio de lectura no responde. Inténtalo de nuevo." }); }
    console.error(err);
    return reply(500, { error: "Error leyendo las fotos." });
  }
});
