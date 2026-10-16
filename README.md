# Libro de Rallies

Registro de las pruebas de rally por año y etapa. Los waypoints se leen solos de las fotos del roadbook, cada etapa puede llevar su track (GPX o KML), todo se ve sobre Google Maps, salen en Google Earth con un enlace que se actualiza solo, y cada etapa se descarga en GPX en el orden del roadbook.

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

- Cada persona entra con su correo y una contraseña. No se envía ningún correo.
- Tu cuenta la creas tú en Supabase (paso 2). La primera vez que entras en la web pulsas **Ser el administrador** y desde ese momento nadie más puede.
- Para dar acceso a alguien: panel **Acceso** › su correo, el permiso (*Solo ver*, *Ver y añadir* o *Administrador*) y una contraseña (el botón *Inventar contraseña* te da una). Le pasas la dirección, su correo y la contraseña. Cada uno puede cambiarla con el botón **Contraseña** de arriba.
- Si alguien olvida la contraseña, vuelve a darle acceso con una nueva.

## Puesta en marcha (una sola vez)

Usa tus cuentas personales, no las de la empresa.

1. **Proyecto de Supabase.** En <https://supabase.com/dashboard> › *New project* (por ejemplo `libro-de-rallies`, región *Central EU (Frankfurt)*). Apunta la contraseña de la base de datos.
   - En *Project Settings* › *API* copia la **Project URL** y la clave **anon / publishable**.
   - El *Reference ID* es la parte de la URL antes de `.supabase.co`.
2. **Tu cuenta.** En Supabase › *Authentication* › *Users* › *Add user* › *Create new user*: tu correo, una contraseña y marca *Auto Confirm User*.
   - En *Authentication* › *Sign In / Providers* desactiva *Allow new users to sign up*, para que solo entre quien tú des de alta.
3. **Clave de Claude** (para leer las fotos). En <https://console.anthropic.com> › *API Keys* › crea una. Guárdala en Supabase › *Edge Functions* › *Secrets* con el nombre `ANTHROPIC_API_KEY`. No la pegues en ningún otro sitio.
4. **Subir la base de datos y las funciones** (automático desde GitHub).
   - En Supabase › tu avatar › *Account* › *Access Tokens* › crea un token.
   - En GitHub › este repositorio › *Settings* › *Secrets and variables* › *Actions*:
     - secreto `SUPABASE_ACCESS_TOKEN` = el token;
     - secreto `SUPABASE_DB_PASSWORD` = la contraseña de la base de datos;
     - pestaña *Variables*: `SUPABASE_PROJECT_REF` = el Reference ID.
   - En *Actions* › *Subir base de datos y funciones a Supabase* › *Run workflow*.
5. **Rellenar `public/config.js`** con la URL y la clave anon (o pásaselas a Claude y lo hace él). No son secretas.
6. **Publicar en Vercel.** <https://vercel.com/new> › importa este repositorio › *Framework Preset: Other* › *Deploy*. Cada cambio en GitHub se publica solo.
7. **Dominio propio.** En Vercel › el proyecto › *Settings* › *Domains* › añade tu dominio y copia los registros DNS en la web donde lo compraste.

El mapa de la web es de satélite y no necesita clave. Cada waypoint tiene sus botones para abrirlo en Google Maps y en Google Earth.

## Google Earth

Marca en la tabla los waypoints que quieras y pulsa **Abrir en Google Earth**. Se descarga un KML con esa selección (y el track, si está a la vista). Con Google Earth Pro instalado se abre al pincharlo en la barra de descargas. En Earth web: *Proyectos › Abrir › Importar archivo KML*.
