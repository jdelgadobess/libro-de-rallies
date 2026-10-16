# Libro de Rallies

Registro de las pruebas de rally por año y etapa. Los waypoints se leen solos de las fotos del roadbook, se ven sobre Google Maps, salen en Google Earth con un enlace que se actualiza solo, y cada etapa se descarga en GPX en el orden del roadbook.

## Qué hay aquí

| Carpeta / archivo | Qué es |
|---|---|
| `public/` | La web: `index.html`, `app.js`, `style.css` y `config.js` (los datos de tu proyecto). |
| `functions/` | El servidor: lee las fotos con Claude (`leerRoadbook`) y sirve el KML para Google Earth (`kml`). |
| `firestore.rules` | Quién puede ver y quién puede escribir. |
| `.github/workflows/publicar.yml` | Publica la web sola cada vez que cambia el código. |

## Quién entra

- La primera persona que entra con Google en la web recién publicada puede pulsar **Ser el administrador**. Desde ese momento nadie más puede reclamarla.
- El administrador da acceso desde el panel **Acceso**, con el correo de Google de cada persona y uno de estos permisos: *Solo ver*, *Ver y añadir* o *Administrador*.
- Quien no esté en la lista ve «Sin acceso».

## Puesta en marcha (una sola vez)

Todo con tu cuenta personal de Google, no la de la empresa.

1. **Proyecto de Firebase.** En <https://console.firebase.google.com> › *Crear proyecto* (por ejemplo `libro-de-rallies`).
   - Pásalo al plan **Blaze** (pago por uso). Hace falta para el servidor. Con este uso, el gasto debería quedarse en el cupo gratuito o en céntimos (es una estimación). Pon una alerta de presupuesto de 5 € en Google Cloud › Facturación.
   - *Authentication* › *Sign-in method* › activa **Google**.
   - *Firestore Database* › *Crear base de datos* › ubicación `europe-west1` › modo producción.
   - *Configuración del proyecto* › *Tus apps* › icono web `</>` › registra la app y copia el bloque `firebaseConfig`.
2. **Clave de Google Maps.** En <https://console.cloud.google.com>, con el mismo proyecto: *APIs y servicios* › habilita **Maps JavaScript API** › *Credenciales* › *Crear clave de API*. Restríngela a *Sitios web* con tu dominio y `*.web.app`.
3. **Clave de Claude** (para leer las fotos). En <https://console.anthropic.com> › *API Keys*.
   - Guárdala como secreto del proyecto. En Google Cloud › *Secret Manager* › crea un secreto llamado `ANTHROPIC_API_KEY` con la clave como valor.
4. **Rellenar `public/config.js`** con el bloque de Firebase y la clave de Maps (o pásaselos a Claude y lo hace él).
5. **Publicación automática.**
   - En Google Cloud › *IAM* › *Cuentas de servicio*, crea una cuenta `github-publicar` con los roles *Firebase Admin*, *Cloud Functions Admin*, *Service Account User*, *Secret Manager Secret Accessor*, *Cloud Build Editor* y *Artifact Registry Administrator*. Crea una clave JSON y descárgala.
   - En GitHub › este repositorio › *Settings* › *Secrets and variables* › *Actions*:
     - secreto `FIREBASE_SERVICE_ACCOUNT` = el contenido del JSON;
     - variable `FIREBASE_PROJECT_ID` = el id del proyecto de Firebase.
   - En *Actions* › *Publicar la web* › *Run workflow*. Desde ahí, cada cambio se publica solo.
6. **Dominio propio.** Firebase › *Hosting* › *Añadir dominio personalizado*. Escribe tu dominio y copia los registros DNS que te da en la web donde lo compraste. Puede tardar unas horas en activarse.

## Google Earth siempre al día

En la web, el administrador pulsa **Crear enlace** en el panel de Google Earth. En Google Earth Pro (ordenador): *Añadir* › *Enlace de red* › pega el enlace. Earth muestra todos los años y etapas por carpetas y se actualiza solo. Quien tenga el enlace puede ver los waypoints, así que compártelo solo con quien quieras.

## Probar en local

```bash
cd functions && npm install && cd ..
npx firebase-tools emulators:start --project demo-rallies
```

Con `emulators: true` en `public/config.js`, la web usa los emuladores en `http://localhost:5000`.
