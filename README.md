# Publicador Pawformance

Publica automáticamente en Instagram (@pawformancemx) y en la Página de Facebook los posts aprobados, a la hora programada.

- `posts/<fecha>_<hora>_<tema>/` → `post.json` + imágenes (JPG) o video (MP4).
- Cada 15 minutos GitHub Actions revisa qué post ya llegó a su hora y lo publica.
- `publicados.json` registra lo publicado para no repetirlo.
- Solo se publica lo que tiene `"aprobado": true`.

Las claves de Meta están en *Settings → Secrets and variables → Actions*; nunca en el código.
