// Publicador Pawformance: revisa posts/ y publica en Instagram y Facebook los que ya llegaron a su hora.
// Cada post vive en posts/<carpeta>/ con un post.json y sus archivos (JPG para imágenes, MP4 para video).
// Lo que ya se publicó queda registrado en publicados.json para no repetirlo.
//
// post.json:
// {
//   "aprobado": true,
//   "publicar_en": "2026-11-23T13:00:00-06:00",
//   "tipo": "imagen" | "carrusel" | "reel" | "historia",
//   "archivos": ["1.jpg", "2.jpg"],          // en orden; para reel: ["video.mp4"], opcional "portada": "portada.jpg"
//   "copy": "Texto de la publicación con #hashtags",
//   "facebook": true                          // también publicar en la Página (no aplica a historias)
// }
//
// Variables: PAGE_TOKEN, IG_USER_ID, PAGE_ID (secretos de GitHub). SOLO_REVISAR=1 no publica nada.

const fs = require('fs');
const path = require('path');

const G = 'https://graph.facebook.com/v27.0';
const { PAGE_TOKEN, IG_USER_ID, PAGE_ID, GITHUB_REPOSITORY, GITHUB_SHA, SOLO_REVISAR } = process.env;
const RAIZ = path.join(__dirname, '..');
const REGISTRO = path.join(RAIZ, 'publicados.json');
const MAX_RETRASO_H = 24; // si un post se quedó atrasado más de esto, no se publica solo

const sleep = ms => new Promise(r => setTimeout(r, ms));
const urlArchivo = (carpeta, archivo) =>
  `https://raw.githubusercontent.com/${GITHUB_REPOSITORY}/${GITHUB_SHA || 'main'}/posts/${encodeURIComponent(carpeta)}/${encodeURIComponent(archivo)}`;
const esVideo = f => /\.(mp4|mov)$/i.test(f);

async function api(metodo, ruta, params = {}) {
  const body = new URLSearchParams({ ...params, access_token: PAGE_TOKEN });
  const opts = metodo === 'GET' ? {} : { method: metodo, body };
  const url = metodo === 'GET' ? `${G}/${ruta}?${body}` : `${G}/${ruta}`;
  const res = await fetch(url, opts);
  const json = await res.json().catch(() => ({}));
  if (!res.ok || json.error) {
    const e = json.error || {};
    throw new Error(`Meta ${ruta}: ${e.message || res.status} (code ${e.code ?? '-'}, sub ${e.error_subcode ?? '-'})`);
  }
  return json;
}

async function esperarContenedor(id, maxSeg = 300) {
  for (let t = 0; t < maxSeg; t += 5) {
    const { status_code } = await api('GET', id, { fields: 'status_code' });
    if (status_code === 'FINISHED') return;
    if (status_code === 'ERROR' || status_code === 'EXPIRED') throw new Error(`Contenedor ${id} quedó en ${status_code}`);
    await sleep(5000);
  }
  throw new Error(`Contenedor ${id} no terminó de procesarse en ${maxSeg}s`);
}

async function contenedorIG(carpeta, archivo, extra = {}) {
  const url = urlArchivo(carpeta, archivo);
  // video: VIDEO por defecto (REELS/STORIES llegan en extra); imagen: solo image_url (+ STORIES si es historia)
  const p = esVideo(archivo) ? { media_type: 'VIDEO', video_url: url } : { image_url: url };
  const { id } = await api('POST', `${IG_USER_ID}/media`, { ...p, ...extra });
  return id;
}

async function publicarIG(carpeta, post) {
  const { tipo, archivos, copy = '' } = post;
  let creacion;
  if (tipo === 'imagen') {
    creacion = await contenedorIG(carpeta, archivos[0], { caption: copy });
  } else if (tipo === 'carrusel') {
    const hijos = [];
    for (const a of archivos) hijos.push(await contenedorIG(carpeta, a, { is_carousel_item: 'true' }));
    for (const h of hijos) await esperarContenedor(h);
    ({ id: creacion } = await api('POST', `${IG_USER_ID}/media`, { media_type: 'CAROUSEL', children: hijos.join(','), caption: copy }));
  } else if (tipo === 'reel') {
    const extra = { media_type: 'REELS', caption: copy, share_to_feed: 'true' };
    if (post.portada) extra.cover_url = urlArchivo(carpeta, post.portada);
    creacion = await contenedorIG(carpeta, archivos[0], extra);
  } else if (tipo === 'historia') {
    creacion = await contenedorIG(carpeta, archivos[0], { media_type: 'STORIES' });
  } else throw new Error(`tipo desconocido: ${tipo}`);
  await esperarContenedor(creacion);
  const { id } = await api('POST', `${IG_USER_ID}/media_publish`, { creation_id: creacion });
  return id;
}

async function publicarFB(carpeta, post) {
  const { tipo, archivos, copy = '' } = post;
  if (tipo === 'imagen') {
    return (await api('POST', `${PAGE_ID}/photos`, { url: urlArchivo(carpeta, archivos[0]), message: copy })).post_id;
  }
  if (tipo === 'carrusel') {
    const fotos = archivos.filter(a => !esVideo(a));
    const ids = [];
    for (const a of fotos) ids.push((await api('POST', `${PAGE_ID}/photos`, { url: urlArchivo(carpeta, a), published: 'false' })).id);
    const params = { message: copy };
    ids.forEach((id, i) => { params[`attached_media[${i}]`] = JSON.stringify({ media_fbid: id }); });
    return (await api('POST', `${PAGE_ID}/feed`, params)).id;
  }
  if (tipo === 'reel') {
    return (await api('POST', `${PAGE_ID}/videos`, { file_url: urlArchivo(carpeta, archivos[0]), description: copy })).id;
  }
  return null; // historias solo en IG
}

(async () => {
  for (const v of ['PAGE_TOKEN', 'IG_USER_ID', 'PAGE_ID']) if (!process.env[v]) throw new Error(`Falta el secreto ${v}`);
  const registro = fs.existsSync(REGISTRO) ? JSON.parse(fs.readFileSync(REGISTRO, 'utf8')) : {};
  const ahora = new Date();

  const me = await api('GET', IG_USER_ID, { fields: 'username' });
  console.log(`Conectado a Instagram @${me.username}. Hora: ${ahora.toISOString()}`);

  const dirPosts = path.join(RAIZ, 'posts');
  const carpetas = fs.existsSync(dirPosts) ? fs.readdirSync(dirPosts).filter(c => fs.existsSync(path.join(dirPosts, c, 'post.json'))).sort() : [];
  let fallos = 0;

  for (const carpeta of carpetas) {
    const post = JSON.parse(fs.readFileSync(path.join(dirPosts, carpeta, 'post.json'), 'utf8'));
    const r = registro[carpeta] || {};
    const cuando = new Date(post.publicar_en);
    const listoIG = !!r.ig, listoFB = !!r.fb || !post.facebook || post.tipo === 'historia';
    if (listoIG && listoFB) continue;
    if (!post.aprobado) { console.log(`· ${carpeta}: sin aprobar, se omite`); continue; }
    if (isNaN(cuando)) { console.log(`· ${carpeta}: fecha inválida`); fallos++; continue; }
    if (cuando > ahora) { console.log(`· ${carpeta}: programado para ${post.publicar_en}`); continue; }
    if ((ahora - cuando) / 36e5 > MAX_RETRASO_H && !listoIG) { console.log(`! ${carpeta}: lleva más de ${MAX_RETRASO_H} h atrasado; no se publica solo`); continue; }
    for (const a of post.archivos || []) if (!fs.existsSync(path.join(dirPosts, carpeta, a))) throw new Error(`${carpeta}: falta el archivo ${a}`);

    if (SOLO_REVISAR) { console.log(`→ ${carpeta}: TOCA publicar (modo revisión, no se publica)`); continue; }
    console.log(`→ Publicando ${carpeta} (${post.tipo})`);
    try {
      if (!listoIG) { r.ig = await publicarIG(carpeta, post); r.ig_fecha = new Date().toISOString(); console.log(`  ✓ Instagram ${r.ig}`); }
      if (!listoFB) { r.fb = await publicarFB(carpeta, post); r.fb_fecha = new Date().toISOString(); console.log(`  ✓ Facebook ${r.fb}`); }
      delete r.error;
    } catch (e) {
      r.error = e.message; r.intentos = (r.intentos || 0) + 1; fallos++;
      console.log(`  ✗ ${e.message}`);
    }
    registro[carpeta] = r;
    fs.writeFileSync(REGISTRO, JSON.stringify(registro, null, 2) + '\n');
  }
  if (fallos) { console.log(`${fallos} post(s) con error`); process.exitCode = 1; }
})().catch(e => { console.error(e.message); process.exit(1); });
