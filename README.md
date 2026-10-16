# Libro de Rallies

Registro de las pruebas de rally por año y etapa. Los waypoints se leen solos de las fotos del roadbook, se ven sobre Google Maps, salen en Google Earth con un enlace que se actualiza solo, y cada etapa se descarga en GPX en el orden del roadbook.

Funciona con **Supabase** (base de datos, acceso con Google y el servidor que lee las fotos) y **Vercel** (la web y tu dominio).

## Qué hay aquí

| Carpeta / archivo | Qué es |
|---|---|
| `public/` | La web: `index.html`, `app.js`, `style.css` y `config.js` (los datos de tu proyecto). |
| `supabase/migrations/` | Las tablas y las reglas de quién puede ver y quién puede escribir. |
| `supabase/functions/leer-roadbook` | Lee las fotos del roadbook con Claude. |
| `supabase/functions/kml` | El enlace de Google Earth que se actualiza solo. |
| `.github/workflows/supabase.yml` | Sube a Supabase los cambios de base de datos y funciones. |
| `vercel.json` | Le dice a Vercel que la web está en `public/`. |

## Quién entra

- La primera persona que entra con Google en la web recién publicada puede pulsar **Ser el administrador**. Desde ese momento nadie más puede.
- El administrador da acceso desde el panel **Acceso**, con el correo de Google de cada persona y uno de estos permisos: *Solo ver*, *Ver y añadir* o *Administrador*.
- Quien no esté en la lista ve «Sin acceso».

## Puesta en marcha (una sola vez)

Usa tus cuentas personales, no las de la empresa.

1. **Proyecto de Supabase.** En <https://supabase.com/dashboard> › *New project* (por ejemplo `libro-de-rallies`, región *Central EU (Frankfurt)*). Apunta la contraseña de la base de datos.
   - En *Project Settings* › *API* copia la **Project URL** y la clave **anon / publishable**.
   - El *Reference ID* es la parte de la URL antes de `.supabase.co`.
2. **Entrar con Google.**
   - En <https://console.cloud.google.com> crea un proyecto › *APIs y servicios* › *Pantalla de consentimiento de OAuth* (tipo *Externo*, rellena nombre y correo, y publícala).
   - *Credenciales* › *Crear credenciales* › *ID de cliente de OAuth* › *Aplicación web*. En *URI de redireccionamiento autorizados* pega `https://TU_REF.supabase.co/auth/v1/callback`.
   - En Supabase › *Authentication* › *Sign In / Providers* › **Google**: actívalo y pega el *Client ID* y el *Client Secret*.
   - En Supabase › *Authentication* › *URL Configuration*: *Site URL* = tu dominio (por ejemplo `https://rallies.tudominio.com`) y en *Redirect URLs* añade también la dirección `https://….vercel.app`.
3. **Clave de Google Maps.** En el mismo proyecto de Google Cloud › *APIs y servicios* › habilita **Maps JavaScript API** › *Credenciales* › *Crear clave de API*. Restríngela a *Sitios web* con tu dominio y `*.vercel.app`.
4. **Clave de Claude** (para leer las fotos). En <https://console.anthropic.com> › *API Keys* › crea una. Guárdala en Supabase › *Edge Functions* › *Secrets* con el nombre `ANTHROPIC_API_KEY`. No la pegues en ningún otro sitio.
5. **Subir la base de datos y las funciones** (automático desde GitHub).
   - En Supabase › tu avatar › *Account* › *Access Tokens* › crea un token.
   - En GitHub › este repositorio › *Settings* › *Secrets and variables* › *Actions*:
     - secreto `SUPABASE_ACCESS_TOKEN` = el token;
     - secreto `SUPABASE_DB_PASSWORD` = la contraseña de la base de datos;
     - pestaña *Variables*: `SUPABASE_PROJECT_REF` = el Reference ID.
   - En *Actions* › *Subir base de datos y funciones a Supabase* › *Run workflow*.
   - Sin GitHub Actions también vale: pega el archivo de `supabase/migrations/` en Supabase › *SQL Editor* › *Run*, y sube las funciones con `npx supabase functions deploy --project-ref TU_REF`.
6. **Rellenar `public/config.js`** con la URL, la clave anon y la clave de Maps (o pásaselas a Claude y lo hace él). No son secretas.
7. **Publicar en Vercel.** <https://vercel.com/new> › importa este repositorio › *Framework Preset: Other* › *Deploy*. Cada cambio en GitHub se publica solo.
8. **Dominio propio.** En Vercel › el proyecto › *Settings* › *Domains* › añade tu dominio y copia los registros DNS en la web donde lo compraste. Después ponlo como *Site URL* en Supabase (paso 2) y en la restricción de la clave de Maps (paso 3).

## Google Earth siempre al día

En la web, el administrador pulsa **Crear enlace** en el panel de Google Earth. En Google Earth Pro (ordenador): *Añadir* › *Enlace de red* › pega el enlace. Earth muestra todos los años y etapas por carpetas y se actualiza solo. Quien tenga el enlace puede ver los waypoints, así que compártelo solo con quien quieras.
