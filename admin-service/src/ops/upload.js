// Image + PDF upload pipeline. Routes by MIME type.

import fs from "node:fs/promises";
import path from "node:path";
import sharp from "sharp";

const MAX_IMAGE_BYTES = 10 * 1024 * 1024;
const MAX_PDF_BYTES = 20 * 1024 * 1024;

export async function handleUpload({ buffer, mimeType, originalName, repoRoot }) {
  if (mimeType === "application/pdf") {
    if (buffer.length > MAX_PDF_BYTES) {
      throw new Error(`PDF too large (${(buffer.length / 1024 / 1024).toFixed(1)} MB, max 20 MB).`);
    }
    return await handlePdf({ buffer, originalName, repoRoot });
  }
  if (["image/jpeg", "image/png", "image/webp"].includes(mimeType)) {
    if (buffer.length > MAX_IMAGE_BYTES) {
      throw new Error(`Image too large (${(buffer.length / 1024 / 1024).toFixed(1)} MB, max 10 MB).`);
    }
    return await handleImage({ buffer, originalName, repoRoot });
  }
  throw new Error(`Unsupported file type: ${mimeType}. Allowed: JPEG, PNG, WebP, PDF.`);
}

async function handleImage({ buffer, originalName, repoRoot }) {
  const sanitized = sanitizeName(originalName, ".jpg");
  const uploadsDir = path.join(repoRoot, "ok-tours", "uploads");
  await fs.mkdir(uploadsDir, { recursive: true });
  const finalName = await dedupeName(uploadsDir, sanitized);
  const finalPath = path.join(uploadsDir, finalName);

  await sharp(buffer)
    .rotate()                               // honor EXIF orientation before stripping
    .resize({ width: 1600, height: 1600, fit: "inside", withoutEnlargement: true })
    .jpeg({ quality: 75, mozjpeg: true })
    .toFile(finalPath);

  const stat = await fs.stat(finalPath);
  return {
    path: `uploads/${finalName}`,
    size_kb: Math.round(stat.size / 1024),
    kind: "image",
    original_name: originalName,
  };
}

async function handlePdf({ buffer, originalName, repoRoot }) {
  const sanitized = sanitizeName(originalName, ".pdf");
  const uploadsDir = path.join(repoRoot, "ok-tours", "uploads");
  await fs.mkdir(uploadsDir, { recursive: true });
  const finalName = await dedupeName(uploadsDir, sanitized);
  const finalPath = path.join(uploadsDir, finalName);

  // MVP: write the raw PDF. v1.1 will pipe through qpdf + exiftool + gs for
  // metadata sanitization + compression. For now we just persist the file
  // since the admin user is trusted.
  await fs.writeFile(finalPath, buffer);

  const stat = await fs.stat(finalPath);
  return {
    path: `uploads/${finalName}`,
    size_kb: Math.round(stat.size / 1024),
    kind: "pdf",
    original_name: originalName,
  };
}

function sanitizeName(name, defaultExt) {
  const base = path.basename(name).toLowerCase();
  const ascii = base
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .replace(/[^a-z0-9.\-_]/g, "-")
    .replace(/-+/g, "-")
    .replace(/^[-.]+|[-.]+$/g, "");
  if (!ascii) return `upload${defaultExt}`;
  // Force the correct extension if missing.
  if (!ascii.endsWith(defaultExt)) {
    const stem = ascii.replace(/\.[^.]+$/, "");
    return `${stem}${defaultExt}`;
  }
  return ascii;
}

async function dedupeName(dir, name) {
  let candidate = name;
  let n = 2;
  while (await exists(path.join(dir, candidate))) {
    const dot = name.lastIndexOf(".");
    candidate = `${name.slice(0, dot)}-${n}${name.slice(dot)}`;
    n += 1;
    if (n > 50) throw new Error("Too many name collisions.");
  }
  return candidate;
}

async function exists(p) {
  try {
    await fs.stat(p);
    return true;
  } catch {
    return false;
  }
}
