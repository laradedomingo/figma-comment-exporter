# figma-comment-exporter

Sincroniza los comentarios de uno o varios archivos de Figma (o de una carpeta entera) con una hoja de Google Sheets. Cada ejecución reescribe la pestaña `Comentarios`, así que los hilos resueltos o borrados en Figma quedan reflejados sin lógica de diferencias. La pestaña `Sync` guarda la fecha de la última sincronización, el número de filas y los avisos.

Puede ejecutarse en local o de forma programada con GitHub Actions (cada 30 minutos, de lunes a viernes de 8:00 a 20:00, hora de Madrid).

## Resultado

Así queda la pestaña `Comentarios` en Google Sheets tras una sincronización: una fila por comentario o respuesta, con su estado, autor, fecha, capa de Figma y un enlace directo al comentario.

![Hoja de Google Sheets con los comentarios de Figma sincronizados](docs/google-sheet-result.png)

## Requisitos

- Node.js 20.6 o superior
- Una cuenta de Figma con acceso a los archivos que quieres exportar
- Una cuenta de Google (para la hoja de cálculo y la cuenta de servicio)

## Configuración

### 1. Token de Figma

1. En Figma, ve a **Settings → Security → Personal access tokens** y genera un token.
2. Dale permisos de lectura para comentarios, contenido y metadatos de archivos (`file_comments:read`, `file_content:read`, `file_metadata:read`). Si vas a usar `FIGMA_FOLDER_ID`, añade también el scope de lectura de carpetas.
3. Copia el token (empieza por `figd_`). Solo se muestra una vez.

### 2. Cuenta de servicio de Google

1. En [Google Cloud Console](https://console.cloud.google.com/), crea un proyecto (o usa uno existente) y activa la **Google Sheets API**.
2. Ve a **IAM y administración → Cuentas de servicio** y crea una cuenta de servicio.
3. En esa cuenta, **Claves → Agregar clave → Crear clave nueva → JSON**. Se descargará un archivo `.json`.
4. Guárdalo como `service-account.json` en la raíz del proyecto (está en `.gitignore`). Puedes ver la estructura esperada en [service-account.example.json](service-account.example.json).

### 3. Hoja de Google Sheets

1. Crea una hoja de cálculo vacía.
2. Compártela con el `client_email` de la cuenta de servicio (aparece dentro del JSON) con permiso de **Editor**.
3. Copia el ID de la hoja: es la parte de la URL entre `/d/` y `/edit`.

Las pestañas `Comentarios` y `Sync` se crean solas si no existen.

### 4. Qué archivos exportar

Puedes indicar archivos concretos, una carpeta, o ambos:

- `FIGMA_FILE_KEYS`: claves de archivo separadas por comas. La clave es la parte de la URL tras `/design/`, por ejemplo `figma.com/design/AbCdEf123456/Mi-archivo` → `AbCdEf123456`.
- `FIGMA_FOLDER_ID`: ID de una carpeta de Figma; se exportan todos sus archivos.

## Uso en local

```bash
npm install
cp .env.example .env
# edita .env con tus valores
npm run sync:local
```

Variables de `.env`:

| Variable | Obligatoria | Descripción |
| --- | --- | --- |
| `FIGMA_TOKEN` | Sí | Token personal de Figma |
| `FIGMA_FILE_KEYS` | Esta o `FIGMA_FOLDER_ID` | Claves de archivo separadas por comas |
| `FIGMA_FOLDER_ID` | Esta o `FIGMA_FILE_KEYS` | ID de carpeta de Figma |
| `SHEET_ID` | Sí | ID de la hoja de Google |
| `GOOGLE_SERVICE_ACCOUNT_FILE` | Sí (local) | Ruta al JSON de la cuenta de servicio |

Variables opcionales:

- `SHEET_TAB`: nombre de la pestaña de comentarios (por defecto `Comentarios`).
- `FETCH_NODE_NAMES=false`: no consulta los nombres de capa. Ese endpoint tiene límites de uso estrictos, por eso los nombres se guardan en `.cache/node-names.json` y solo se piden los nuevos.

## Ejecución programada con GitHub Actions

El workflow está en [.github/workflows/figma-comments.yml](.github/workflows/figma-comments.yml). En tu repositorio, ve a **Settings → Secrets and variables → Actions** y configura:

**Secrets**

| Nombre | Valor |
| --- | --- |
| `FIGMA_TOKEN` | Token personal de Figma |
| `GOOGLE_SERVICE_ACCOUNT_JSON` | Contenido completo del JSON de la cuenta de servicio |

**Variables**

| Nombre | Valor |
| --- | --- |
| `SHEET_ID` | ID de la hoja de Google |
| `FIGMA_FILE_KEYS` | Claves de archivo separadas por comas (opcional si usas carpeta) |
| `FIGMA_FOLDER_ID` | ID de carpeta (opcional si usas claves de archivo) |

Puedes lanzarlo a mano desde la pestaña **Actions → Sincronizar comentarios de Figma → Run workflow**.

> **Repositorio público:** GitHub desactiva los workflows programados tras 60 días sin actividad en el repositorio; si se detienen, reactívalos desde la pestaña Actions.

## Seguridad

- **Nunca subas `.env` ni `service-account.json`.** Ya están en `.gitignore`; solo se versiona `.env.example`, que contiene valores de ejemplo.
- Si un token o una clave llegan a publicarse por error, revócalos de inmediato (en Figma y en Google Cloud) y genera otros nuevos.
