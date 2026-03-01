# Vocento Article Exporter

Web app en Next.js para que redactores de periódicos del grupo Vocento descarguen vistas previas de sus artículos (titular, subtítulo, descriptor y metadatos) a partir de la URL de autor.

## Funcionalidades

- Entrada de URL de autor (por ejemplo `https://www.laverdad.es/autor/...`).
- Recoge hasta 60 resultados por autor (incluyendo paginación/"Ver más noticias" cuando está accesible por URL).
- Exportación en:
  - CSV
  - JSON
  - Markdown
  - PDF
- Interfaz accesible, simple y rápida, y molona.

## Requisitos

- Node.js 20+
- npm 10+

## Desarrollo local

```bash
npm ci
npm run dev
```

Abrir `http://localhost:3000`.

## Simular producción en local

```bash
npm ci
npm run build
npm run start
```

Abrir `http://localhost:3000`.

## Probar el endpoint en producción

```bash
curl -X POST https://TU_DOMINIO/api/export \
  -H "content-type: application/json" \
  -d '{"authorUrl":"https://www.laverdad.es/autor/javier-perez-parra-527.html","format":"csv"}' \
  -o articulos.csv
```

`format` soportados: `csv`, `json`, `markdown`, `pdf`.

## Despliegue recomendado (Vercel)

1. Subir este repo a GitHub.
2. Importar el repo en Vercel.
3. Hacer deploy.
4. Verificar UI y endpoint `/api/export`.

## Nota importante de red

El backend consulta páginas externas de medios Vocento en tiempo real. El entorno de despliegue debe permitir salida HTTPS a esos dominios.
