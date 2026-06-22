const fs = require('fs');

const cfg = {
  SUPABASE_URL: (process.env.SUPABASE_URL || '').trim(),
  SUPABASE_ANON_KEY: (process.env.SUPABASE_ANON_KEY || '').trim(),
  FAMILY_PIN: (process.env.FAMILY_PIN || '').trim()
};

if (!cfg.SUPABASE_URL || !cfg.SUPABASE_ANON_KEY || !cfg.FAMILY_PIN) {
  console.error('Faltan secrets: SUPABASE_URL, SUPABASE_ANON_KEY y FAMILY_PIN en GitHub Actions');
  process.exit(1);
}

const inline = '<script>window.SODERIA_CONFIG = ' + JSON.stringify(cfg) + ';</script>';
let html = fs.readFileSync('index.html', 'utf8');
const marker = /<!-- SODERIA_CONFIG:.*?-->\s*<script src="config\.js"><\/script>/s;

if (!marker.test(html)) {
  console.error('No se encontró el marcador SODERIA_CONFIG en index.html');
  process.exit(1);
}

html = html.replace(marker, '<!-- SODERIA_CONFIG (inyectado en deploy, no va al repo) -->\n' + inline);
fs.writeFileSync('index.html', html);
console.log('Config inyectada en index.html para deploy');
