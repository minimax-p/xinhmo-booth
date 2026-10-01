/**
 * Build a real keychain batch sheet from your own image, through the actual
 * app -- not a reimplementation of its layout math.
 *
 *     node scripts/keychain-safe-area.js path/to/your-image.jpg [frameId ...]
 *
 * An earlier version of this script recomputed compositeStrip()/
 * buildBatchSheet()'s grid by hand, guessing at one frame's aspect ratio from
 * frames.json. That guess only held for frames with a cropped strip column;
 * grand_4 has no border.rects and uses the full sheet instead, so its grid
 * came out wrong. Rather than chase every frame shape by hand, this launches
 * the booth the same way scripts/e2e.js does (mock camera, dry-run printing,
 * over the Chrome DevTools Protocol via scripts/cdp.js), drops your image
 * into every photo slot, and calls the renderer's own compositeStrip() and
 * buildBatchSheet() -- the exact functions printBatch() in main.js calls for
 * a real order. Whatever comes out is exactly what would print, safe-area
 * calibration included, for any frame you name -- new ones too, nothing here
 * is specific to one.
 *
 * With no frame ids given it builds one sheet per frame in frames.json.
 */
'use strict';

const fs = require('fs');
const path = require('path');

const { launchBooth, sleep } = require('./cdp');

const ROOT = path.join(__dirname, '..');
const PORT = 9334;

const imagePath = process.argv[2];
if (!imagePath) {
  console.error('usage: node scripts/keychain-safe-area.js <image-path> [frameId ...]');
  process.exit(1);
}
if (!fs.existsSync(imagePath)) {
  console.error('no such file:', imagePath);
  process.exit(1);
}

const ext = path.extname(imagePath).slice(1).toLowerCase();
const mime = ext === 'png' ? 'image/png' : 'image/jpeg';
const imageDataUrl = `data:${mime};base64,${fs.readFileSync(imagePath).toString('base64')}`;

(async () => {
  let booth;
  try {
    booth = await launchBooth({ port: PORT, root: ROOT });
    const { evalJs } = booth;

    for (let i = 0; i < 40; i++) {
      if (await evalJs('!!(window.booth && Array.isArray(S.frames) && S.frames.length)')) break;
      await sleep(300);
    }

    const knownFrames = JSON.parse(await evalJs('JSON.stringify(S.frames.map(f => f.id))'));
    const requested = process.argv.slice(3);
    const frameIds = requested.length ? requested : knownFrames;

    const sa = JSON.parse(await evalJs('JSON.stringify(S.cfg.print.safeArea)'));
    const keychainCfg = JSON.parse(await evalJs('JSON.stringify(S.cfg.keychain || {})'));
    const addon = JSON.parse(
      await evalJs('JSON.stringify((S.cfg.pricing.addons || []).find(a => a.id === "keychain") || {})')
    );
    const heightMm = addon.heightMm || keychainCfg.heightMm || 55;
    const widthMm = addon.widthMm || keychainCfg.widthMm;
    const gapMm = keychainCfg.gapMm || 4;
    const perSheet = Math.max(1, addon.perSheet || 8);

    console.log(`safeArea top=${sa.top} right=${sa.right} bottom=${sa.bottom} left=${sa.left} mm ` +
      `(from settings.json, applied by the app's own safeTransform -- not recomputed here)`);

    // Drop the uploaded image into the one photo slot every frame reads from,
    // so compositeStrip() sees a real, loaded image just like a finished
    // session would hand it.
    await evalJs(`(async () => {
      const img = new Image();
      const done = new Promise((res, rej) => { img.onload = res; img.onerror = rej; });
      img.src = ${JSON.stringify(imageDataUrl)};
      await done;
      S.photos = [{ dataUrl: img.src, img }];
      S.selected = new Array(12).fill(0);
      return true;
    })()`);

    for (const frameId of frameIds) {
      if (!knownFrames.includes(frameId)) {
        console.error(`  ${frameId}: no such frame in frames.json (have: ${knownFrames.join(', ')})`);
        continue;
      }
      await evalJs(`(() => { S.frameId = ${JSON.stringify(frameId)}; return true; })()`);

      const stripDataUrl = await evalJs(`(() => {
        const c = document.createElement('canvas');
        return compositeStrip(c) ? c.toDataURL('image/jpeg', 0.92) : null;
      })()`);
      if (!stripDataUrl) {
        console.error(`  ${frameId}: compositeStrip() returned nothing`);
        continue;
      }

      const cells = Array.from({ length: perSheet }, () => ({ code: 'TEST', dataUrl: stripDataUrl }));
      const built = await evalJs(`buildBatchSheet(${JSON.stringify({ heightMm, widthMm, gapMm, cells })})`);
      if (!built || !built.dataUrl) {
        console.error(`  ${frameId}: buildBatchSheet() returned nothing`);
        continue;
      }

      const out = path.join(ROOT, `keychain_safe_area_${frameId}.jpg`);
      fs.writeFileSync(out, Buffer.from(built.dataUrl.replace(/^data:image\/\w+;base64,/, ''), 'base64'));
      console.log(`  ${frameId}: ${built.used} cell(s) -> ${out}`);
    }
  } finally {
    if (booth) booth.kill();
  }
})();
