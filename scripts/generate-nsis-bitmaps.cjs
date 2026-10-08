#!/usr/bin/env node
// Generate the NSIS installer wizard bitmaps for the Windows desktop build.
//
// electron-builder looks for these files in `directories.buildResources`
// (release-artifacts/win/build) and, when present, drops them into the MUI2
// wizard. Without them the installer is the stock grey NSIS skin.
//
//   installerHeader.bmp       150 x  57  (top-right of every wizard page)
//   installerSidebar.bmp      164 x 314  (welcome / finish page, left column)
//   uninstallerSidebar.bmp    164 x 314  (uninstaller welcome / finish page)
//
// Output must be 24-bit BI_RGB BMP: NSIS cannot render 32-bit bitmaps with an
// alpha channel, so transparent areas are composited onto the gradient.
//
// Implementation is pure Node (zlib only) so the same script runs on the Linux
// and Windows build agents; no ImageMagick / sharp dependency is added.
//
// Design (2026-10-07 refresh): instead of a single diagonal gradient + a tiny
// logo (the old "30 years old" look), the wizard now renders a layered,
// modern composition:
//   - a deep forest-green → mint vertical gradient (brand colour derived from
//     the logo's own dominant tone, never hard-coded),
//   - a large centred logo with a soft radial glow,
//   - a crisp "MMH" wordmark in a built-in 5x7 bitmap font (no font lib),
//   - fine geometric accents: hairline rules, a dotted grid and a ring, so the
//     page reads as designed rather than as the stock NSIS skin.
//
// Usage: node scripts/generate-nsis-bitmaps.cjs [--out <dir>] [--logo <png>]

const fs = require("node:fs");
const path = require("node:path");
const zlib = require("node:zlib");

const root = path.resolve(__dirname, "..");

const HEADER = { width: 150, height: 57 };
const SIDEBAR = { width: 164, height: 314 };

const args = process.argv.slice(2);
function argValue(flag, fallback) {
  const index = args.indexOf(flag);
  return index >= 0 && args[index + 1] ? args[index + 1] : fallback;
}

const outDir = path.resolve(argValue("--out", path.join(root, "release-artifacts", "win", "build")));
const logoPath = path.resolve(argValue("--logo", path.join(root, "public", "branding", "mmh-logo-pwa-512.png")));

// ------------------------------------------------------------------ PNG read

function decodePng(buffer) {
  if (buffer.length < 8 || buffer.readUInt32BE(0) !== 0x89504e47) {
    throw new Error("Not a PNG file: " + logoPath);
  }
  let offset = 8;
  let header = null;
  const chunks = [];
  while (offset + 8 <= buffer.length) {
    const length = buffer.readUInt32BE(offset);
    const type = buffer.toString("ascii", offset + 4, offset + 8);
    const start = offset + 8;
    if (type === "IHDR") {
      header = {
        width: buffer.readUInt32BE(start),
        height: buffer.readUInt32BE(start + 4),
        bitDepth: buffer[start + 8],
        colorType: buffer[start + 9],
        interlace: buffer[start + 12],
      };
    } else if (type === "IDAT") {
      chunks.push(buffer.subarray(start, start + length));
    } else if (type === "IEND") {
      break;
    }
    offset = start + length + 4;
  }
  if (!header) throw new Error("PNG has no IHDR chunk: " + logoPath);
  if (header.bitDepth !== 8 || header.interlace !== 0) {
    throw new Error(
      `Unsupported PNG (bitDepth=${header.bitDepth}, interlace=${header.interlace}); expected 8-bit non-interlaced.`,
    );
  }
  const channels = header.colorType === 6 ? 4 : header.colorType === 2 ? 3 : null;
  if (!channels) {
    throw new Error(`Unsupported PNG color type ${header.colorType}; expected 2 (RGB) or 6 (RGBA).`);
  }

  const raw = zlib.inflateSync(Buffer.concat(chunks));
  const { width, height } = header;
  const stride = width * channels;
  const pixels = Buffer.alloc(height * stride);
  let cursor = 0;
  for (let y = 0; y < height; y++) {
    const filter = raw[cursor++];
    const line = raw.subarray(cursor, cursor + stride);
    cursor += stride;
    const current = pixels.subarray(y * stride, (y + 1) * stride);
    const previous = y > 0 ? pixels.subarray((y - 1) * stride, y * stride) : null;
    for (let x = 0; x < stride; x++) {
      const a = x >= channels ? current[x - channels] : 0;
      const b = previous ? previous[x] : 0;
      const c = previous && x >= channels ? previous[x - channels] : 0;
      let value = line[x];
      if (filter === 1) value += a;
      else if (filter === 2) value += b;
      else if (filter === 3) value += (a + b) >> 1;
      else if (filter === 4) {
        const p = a + b - c;
        const pa = Math.abs(p - a);
        const pb = Math.abs(p - b);
        const pc = Math.abs(p - c);
        value += pa <= pb && pa <= pc ? a : pb <= pc ? b : c;
      } else if (filter !== 0) {
        throw new Error("Unsupported PNG scanline filter " + filter);
      }
      current[x] = value & 0xff;
    }
  }

  if (channels === 4) return { width, height, data: pixels };
  const rgba = Buffer.alloc(width * height * 4);
  for (let i = 0, j = 0; i < pixels.length; i += 3, j += 4) {
    rgba[j] = pixels[i];
    rgba[j + 1] = pixels[i + 1];
    rgba[j + 2] = pixels[i + 2];
    rgba[j + 3] = 255;
  }
  return { width, height, data: rgba };
}

// ------------------------------------------------------------------ imaging

// Box (area average) resize on premultiplied alpha, so scaling a transparent
// logo down to a small icon never bleeds the transparent black into the edges.
function resizeRgba(source, sourceWidth, sourceHeight, targetWidth, targetHeight) {
  const scaleX = sourceWidth / targetWidth;
  const scaleY = sourceHeight / targetHeight;
  const output = Buffer.alloc(targetWidth * targetHeight * 4);
  for (let y = 0; y < targetHeight; y++) {
    const y0 = y * scaleY;
    const y1 = (y + 1) * scaleY;
    for (let x = 0; x < targetWidth; x++) {
      const x0 = x * scaleX;
      const x1 = (x + 1) * scaleX;
      let r = 0;
      let g = 0;
      let b = 0;
      let a = 0;
      let weight = 0;
      for (let sy = Math.floor(y0); sy < Math.min(sourceHeight, Math.ceil(y1)); sy++) {
        const wy = Math.min(sy + 1, y1) - Math.max(sy, y0);
        if (wy <= 0) continue;
        for (let sx = Math.floor(x0); sx < Math.min(sourceWidth, Math.ceil(x1)); sx++) {
          const wx = Math.min(sx + 1, x1) - Math.max(sx, x0);
          if (wx <= 0) continue;
          const w = wx * wy;
          const index = (sy * sourceWidth + sx) * 4;
          const alpha = source[index + 3] / 255;
          r += source[index] * alpha * w;
          g += source[index + 1] * alpha * w;
          b += source[index + 2] * alpha * w;
          a += source[index + 3] * w;
          weight += w;
        }
      }
      const target = (y * targetWidth + x) * 4;
      const alphaSum = a / weight;
      if (alphaSum <= 0) continue;
      const alphaScale = 255 / (a / weight);
      output[target] = clampByte((r / weight) * alphaScale);
      output[target + 1] = clampByte((g / weight) * alphaScale);
      output[target + 2] = clampByte((b / weight) * alphaScale);
      output[target + 3] = clampByte(alphaSum);
    }
  }
  return output;
}

function clampByte(value) {
  return Math.max(0, Math.min(255, Math.round(value)));
}

function mix(a, b, t) {
  return [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t, a[2] + (b[2] - a[2]) * t];
}

function averageOpaqueColor(image) {
  let r = 0;
  let g = 0;
  let b = 0;
  let count = 0;
  for (let i = 0; i < image.data.length; i += 4) {
    if (image.data[i + 3] < 32) continue;
    r += image.data[i];
    g += image.data[i + 1];
    b += image.data[i + 2];
    count++;
  }
  if (!count) return [158, 205, 179];
  return [r / count, g / count, b / count];
}

function createCanvas(width, height, topColor, bottomColor) {
  const rgba = Buffer.alloc(width * height * 4);
  for (let y = 0; y < height; y++) {
    const t = y / Math.max(1, height - 1);
    const color = mix(topColor, bottomColor, t);
    for (let x = 0; x < width; x++) {
      const index = (y * width + x) * 4;
      rgba[index] = clampByte(color[0]);
      rgba[index + 1] = clampByte(color[1]);
      rgba[index + 2] = clampByte(color[2]);
      rgba[index + 3] = 255;
    }
  }
  return { width, height, data: rgba };
}

function blendGlow(canvas, accent, centerX, centerY, radius, strength) {
  for (let y = 0; y < canvas.height; y++) {
    for (let x = 0; x < canvas.width; x++) {
      const dx = x - centerX;
      const dy = y - centerY;
      const distance = Math.sqrt(dx * dx + dy * dy) / radius;
      if (distance >= 1) continue;
      const falloff = (1 - distance) * (1 - distance);
      const alpha = strength * falloff;
      if (alpha <= 0.002) continue;
      const index = (y * canvas.width + x) * 4;
      const color = mix([canvas.data[index], canvas.data[index + 1], canvas.data[index + 2]], accent, alpha);
      canvas.data[index] = clampByte(color[0]);
      canvas.data[index + 1] = clampByte(color[1]);
      canvas.data[index + 2] = clampByte(color[2]);
    }
  }
}

function blendImage(canvas, image, left, top) {
  for (let y = 0; y < image.height; y++) {
    const targetY = top + y;
    if (targetY < 0 || targetY >= canvas.height) continue;
    for (let x = 0; x < image.width; x++) {
      const targetX = left + x;
      if (targetX < 0 || targetX >= canvas.width) continue;
      const sourceIndex = (y * image.width + x) * 4;
      const alpha = image.data[sourceIndex + 3] / 255;
      if (alpha <= 0) continue;
      const targetIndex = (targetY * canvas.width + targetX) * 4;
      const color = mix(
        [canvas.data[targetIndex], canvas.data[targetIndex + 1], canvas.data[targetIndex + 2]],
        [image.data[sourceIndex], image.data[sourceIndex + 1], image.data[sourceIndex + 2]],
        alpha,
      );
      canvas.data[targetIndex] = clampByte(color[0]);
      canvas.data[targetIndex + 1] = clampByte(color[1]);
      canvas.data[targetIndex + 2] = clampByte(color[2]);
    }
  }
}

function fillPixel(canvas, x, y, color, alpha) {
  if (x < 0 || y < 0 || x >= canvas.width || y >= canvas.height) return;
  const index = (y * canvas.width + x) * 4;
  const blended = mix(
    [canvas.data[index], canvas.data[index + 1], canvas.data[index + 2]],
    color,
    alpha,
  );
  canvas.data[index] = clampByte(blended[0]);
  canvas.data[index + 1] = clampByte(blended[1]);
  canvas.data[index + 2] = clampByte(blended[2]);
}

// A single-pixel-wide hairline, blended so it softens over the gradient.
function hairline(canvas, color, y, x0, x1, alpha) {
  for (let x = x0; x <= x1; x++) {
    fillPixel(canvas, x, y, color, alpha);
  }
}

// A dotted grid: rows of evenly spaced single-pixel dots, lightly blended.
function dotGrid(canvas, color, x0, y0, x1, y1, spacing, alpha) {
  for (let y = y0; y <= y1; y += spacing) {
    for (let x = x0; x <= x1; x += spacing) {
      fillPixel(canvas, x, y, color, alpha);
    }
  }
}

// A thin ring (outline circle) via midpoint circle drawing.
function ring(canvas, color, cx, cy, radius, alpha) {
  const plot = (x, y) => {
    fillPixel(canvas, cx + x, cy + y, color, alpha);
    fillPixel(canvas, cx - x, cy + y, color, alpha);
    fillPixel(canvas, cx + x, cy - y, color, alpha);
    fillPixel(canvas, cx - x, cy - y, color, alpha);
    fillPixel(canvas, cx + y, cy + x, color, alpha);
    fillPixel(canvas, cx - y, cy + x, color, alpha);
    fillPixel(canvas, cx + y, cy - x, color, alpha);
    fillPixel(canvas, cx - y, cy - x, color, alpha);
  };
  let x = 0;
  let y = radius;
  let d = 3 - 2 * radius;
  plot(x, y);
  while (y >= x) {
    x++;
    if (d > 0) {
      y--;
      d = d + 4 * (x - y) + 10;
    } else {
      d = d + 4 * x + 6;
    }
    plot(x, y);
  }
}

// ------------------------------------------------------------------ bitmap font

// A minimal 5x7 bitmap font covering just the glyphs the wizard needs
// ("MMH" and the "FAMILY FINANCE" subtitle). Rows top-to-bottom, '#' lit.
const FONT_5x7 = {
  " ": [".....", ".....", ".....", ".....", ".....", ".....", "....."],
  A: [".###.", "#...#", "#...#", "#####", "#...#", "#...#", "#...#"],
  C: [".####", "#....", "#....", "#....", "#....", "#....", ".####"],
  E: ["#####", "#....", "#....", "####.", "#....", "#....", "#####"],
  F: ["#####", "#....", "#....", "####.", "#....", "#....", "#...."],
  H: ["#...#", "#...#", "#...#", "#####", "#...#", "#...#", "#...#"],
  I: ["#####", "..#..", "..#..", "..#..", "..#..", "..#..", "#####"],
  L: ["#....", "#....", "#....", "#....", "#....", "#....", "#####"],
  M: ["#...#", "##.##", "#.#.#", "#...#", "#...#", "#...#", "#...#"],
  N: ["#...#", "##..#", "#.#.#", "#..##", "#...#", "#...#", "#...#"],
  Y: ["#...#", "#...#", ".#.#.", "..#..", "..#..", "..#..", "..#.."],
};

const FONT_H = 7;
const FONT_W = 5;

function textWidth(text, scale, letterSpacing) {
  let w = 0;
  for (const ch of text) {
    const glyph = FONT_5x7[ch];
    if (!glyph) continue;
    w += FONT_W * scale + letterSpacing;
  }
  return Math.max(0, w - letterSpacing);
}

function drawText(canvas, text, x, y, color, scale, letterSpacing) {
  let cursorX = x;
  for (const ch of text) {
    const glyph = FONT_5x7[ch];
    if (!glyph) {
      cursorX += FONT_W * scale + letterSpacing;
      continue;
    }
    for (let gy = 0; gy < FONT_H; gy++) {
      const row = glyph[gy];
      for (let gx = 0; gx < FONT_W; gx++) {
        if (row[gx] !== "#") continue;
        for (let sy = 0; sy < scale; sy++) {
          for (let sx = 0; sx < scale; sx++) {
            const px = cursorX + gx * scale + sx;
            const py = y + gy * scale + sy;
            if (px < 0 || py < 0 || px >= canvas.width || py >= canvas.height) continue;
            const index = (py * canvas.width + px) * 4;
            canvas.data[index] = clampByte(color[0]);
            canvas.data[index + 1] = clampByte(color[1]);
            canvas.data[index + 2] = clampByte(color[2]);
            canvas.data[index + 3] = 255;
          }
        }
      }
    }
    cursorX += FONT_W * scale + letterSpacing;
  }
}

// ------------------------------------------------------------------ BMP write

function encodeBmp24(canvas) {
  const { width, height, data } = canvas;
  const rowSize = Math.ceil((width * 3) / 4) * 4;
  const pixelBytes = rowSize * height;
  const output = Buffer.alloc(54 + pixelBytes);
  output.write("BM", 0, "ascii");
  output.writeUInt32LE(54 + pixelBytes, 2);
  output.writeUInt32LE(54, 10);
  output.writeUInt32LE(40, 14);
  output.writeInt32LE(width, 18);
  output.writeInt32LE(height, 22);
  output.writeUInt16LE(1, 26);
  output.writeUInt16LE(24, 28);
  output.writeUInt32LE(0, 30);
  output.writeUInt32LE(pixelBytes, 34);
  output.writeInt32LE(2835, 38);
  output.writeInt32LE(2835, 42);
  for (let y = 0; y < height; y++) {
    const sourceY = height - 1 - y; // BMP rows are stored bottom-up.
    let cursor = 54 + y * rowSize;
    for (let x = 0; x < width; x++) {
      const index = (sourceY * width + x) * 4;
      output[cursor++] = data[index + 2]; // B
      output[cursor++] = data[index + 1]; // G
      output[cursor++] = data[index]; // R
    }
  }
  return output;
}

// ------------------------------------------------------------------ compose

function softWhite(accent) {
  return mix(accent, [255, 255, 255], 0.82);
}

function drawAccentRule(canvas, accent, ruleHeight, maxAlpha) {
  for (let y = canvas.height - ruleHeight; y < canvas.height; y++) {
    if (y < 0) continue;
    for (let x = 0; x < canvas.width; x++) {
      const alpha = (x / Math.max(1, canvas.width - 1)) * maxAlpha;
      const index = (y * canvas.width + x) * 4;
      const color = mix([canvas.data[index], canvas.data[index + 1], canvas.data[index + 2]], accent, alpha);
      canvas.data[index] = clampByte(color[0]);
      canvas.data[index + 1] = clampByte(color[1]);
      canvas.data[index + 2] = clampByte(color[2]);
    }
  }
}

function buildHeader(logo, accent, tint) {
  const { width, height } = HEADER;
  const canvas = createCanvas(width, height, tint.dark, tint.mid);

  // Radial glow behind the logo (right side).
  blendGlow(canvas, accent, width * 0.76, height * 0.5, width * 0.95, 0.22);

  // Logo, right-aligned.
  const logoSize = height - 14;
  const scaled = {
    width: logoSize,
    height: logoSize,
    data: resizeRgba(logo.data, logo.width, logo.height, logoSize, logoSize),
  };
  blendImage(canvas, scaled, width - logoSize - 12, Math.round((height - logoSize) / 2));

  // "MMH" wordmark, left-aligned, with a faint hairline underneath.
  const white = softWhite(accent);
  drawText(canvas, "MMH", 14, Math.round((height - FONT_H * 2) / 2) - 1, white, 2, 2);
  hairline(canvas, mix(accent, white, 0.5), height - 12, 14, 14 + textWidth("MMH", 2, 2), 0.35);

  // Bottom accent rule (kept, re-tinted).
  drawAccentRule(canvas, accent, 2, 0.5);
  return canvas;
}

function buildSidebar(logo, accent, tint, opts) {
  const { width, height } = SIDEBAR;
  const canvas = createCanvas(width, height, tint.dark, tint.mid);
  const white = softWhite(accent);

  // Ambient glow behind the logo.
  blendGlow(canvas, accent, width * 0.5, height * 0.30, width * 1.05, 0.28);

  // Large centred logo.
  const logoSize = opts.logoSize || 116;
  const scaled = {
    width: logoSize,
    height: logoSize,
    data: resizeRgba(logo.data, logo.width, logo.height, logoSize, logoSize),
  };
  blendImage(canvas, scaled, Math.round((width - logoSize) / 2), Math.round(height * 0.17));

  // "MMH" wordmark under the logo.
  const scale = 3;
  const wm = textWidth("MMH", scale, 2);
  drawText(canvas, "MMH", Math.round((width - wm) / 2), Math.round(height * 0.17) + logoSize + 16, white, scale, 2);

  // Subtitle wordmark.
  const subScale = 1;
  const sub = opts.subtitle || "FAMILY FINANCE";
  const sw = textWidth(sub, subScale, 1);
  const subY = Math.round(height * 0.17) + logoSize + 16 + FONT_H * scale + 8;
  drawText(canvas, sub, Math.round((width - sw) / 2), subY, mix(accent, white, 0.45), subScale, 1);

  // Decorative ring peeking from the top-right corner.
  ring(canvas, mix(accent, white, 0.35), Math.round(width * 0.92), Math.round(height * 0.05), Math.round(width * 0.34), 0.28);

  // Dotted grid along the bottom, fading out.
  dotGrid(canvas, mix(accent, white, 0.4), 18, height - 30, width - 18, height - 14, 8, 0.22);

  // Bottom accent rule.
  drawAccentRule(canvas, accent, 3, 0.6);
  return canvas;
}

// A full-bleed welcome/finish page background. The custom nsDialogs page
// stretches it across the whole MUI2 client area (~496x290 px) and draws the
// headline / subtext as white nsDialogs labels on top, so the page reads as a
// single designed dark surface instead of the stock MUI2 white panel.
// `textX` marks the horizontal inset where the nsDialogs labels start, so the
// artwork leaves the right-hand side visually uncluttered for the copy.
function buildWelcomeBackground(logo, accent, tint, opts) {
  const width = opts.width || 496;
  const height = opts.height || 290;
  const canvas = createCanvas(width, height, tint.dark, tint.mid);
  const white = softWhite(accent);

  // Soft diagonal glow behind the logo (left side).
  blendGlow(canvas, accent, width * 0.16, height * 0.32, width * 0.55, 0.30);

  // Left-side logo cluster.
  const logoSize = Math.round(height * 0.34);
  const scaled = {
    width: logoSize,
    height: logoSize,
    data: resizeRgba(logo.data, logo.width, logo.height, logoSize, logoSize),
  };
  blendImage(canvas, scaled, Math.round(width * 0.055), Math.round(height * 0.14));

  // Decorative ring behind the logo, peeking off the left edge.
  ring(canvas, mix(accent, white, 0.30), Math.round(width * 0.02), Math.round(height * 0.12), Math.round(width * 0.30), 0.22);

  // Fine dotted grid across the lower third (subtle texture).
  dotGrid(canvas, mix(accent, white, 0.32), Math.round(width * 0.08), height - 46, width - 18, height - 14, 9, 0.20);

  // A vertical hairline separating the logo zone from the copy zone, so the
  // nsDialogs text area has a clean anchor.
  for (let y = Math.round(height * 0.12); y <= Math.round(height * 0.82); y++) {
    fillPixel(canvas, Math.round(width * 0.34), y, mix(accent, white, 0.35), 0.35);
  }

  // Bottom accent rule.
  drawAccentRule(canvas, accent, 3, 0.6);
  return canvas;
}

// ------------------------------------------------------------------ main

const logo = decodePng(fs.readFileSync(logoPath));
const accent = averageOpaqueColor(logo);
// Tints are derived from the logo's own accent colour so the wizard always
// matches the brand mark without hard-coding hex values. The dark stop is
// deepened toward a near-black green for contrast against the mint accent.
const installerTint = {
  dark: mix(accent, [6, 22, 19], 0.90),
  mid: mix(accent, [6, 22, 19], 0.48),
};
const uninstallerTint = {
  dark: mix(accent, [16, 22, 30], 0.90),
  mid: mix(accent, [16, 22, 30], 0.55),
};

const outputs = [
  ["installerHeader.bmp", buildHeader(logo, accent, installerTint)],
  ["installerSidebar.bmp", buildSidebar(logo, accent, installerTint, { subtitle: "FAMILY FINANCE" })],
  ["uninstallerSidebar.bmp", buildSidebar(logo, accent, uninstallerTint, { subtitle: "UNINSTALL" })],
  ["installerWelcome.bmp", buildWelcomeBackground(logo, accent, installerTint, { width: 496, height: 290 })],
  ["uninstallerWelcome.bmp", buildWelcomeBackground(logo, accent, uninstallerTint, { width: 496, height: 290 })],
];

fs.mkdirSync(outDir, { recursive: true });
for (const [name, canvas] of outputs) {
  const file = path.join(outDir, name);
  fs.writeFileSync(file, encodeBmp24(canvas));
  console.log(`wrote ${file} (${canvas.width}x${canvas.height})`);
}
