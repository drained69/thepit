/**
 * Coin icons: an emoji, or an uploaded image stored on-chain as a small
 * raster data URL (the contracts accept PNG/JPEG/WebP/GIF ≤ 16 KB, never SVG).
 */
import { useEffect, useState } from "react";
import { viewMethod } from "../lib/near";
import { PREVIEW } from "./config";

/** Mirrors the contracts' MAX_ICON_BYTES, with headroom for safety. */
export const MAX_ICON_BYTES = 16_000;
/** NEAR storage price: 10^19 yocto per byte. */
export const BYTE_COST = 10n ** 19n;
const SAFE_IMAGE = /^data:image\/(png|jpeg|webp|gif);base64,[A-Za-z0-9+/=]+$/;

export const isImageIcon = (icon: string | null | undefined): icon is string => !!icon && SAFE_IMAGE.test(icon);
export const iconBytes = (icon: string | null) => (icon ? new TextEncoder().encode(icon).length : 0);

function load(file: File): Promise<HTMLImageElement> {
  return new Promise((resolve, reject) => {
    const url = URL.createObjectURL(file);
    const img = new Image();
    img.onload = () => {
      URL.revokeObjectURL(url);
      resolve(img);
    };
    img.onerror = () => {
      URL.revokeObjectURL(url);
      reject(new Error("That file isn't an image this browser can read."));
    };
    img.src = url;
  });
}

/**
 * Center-crop to a square, then shrink and compress until it fits on-chain.
 * WebP keeps transparency; browsers that can't encode WebP fall back to JPEG
 * on the app's dark background.
 */
export async function imageToIcon(file: File): Promise<{ icon: string; size: number; format: string }> {
  if (!file.type.startsWith("image/")) throw new Error("Pick an image file (PNG, JPG, WebP, GIF, SVG…).");
  if (file.size > 20 * 1024 * 1024) throw new Error("That image is over 20 MB. Pick a smaller one.");
  const img = await load(file);
  const side = Math.min(img.naturalWidth, img.naturalHeight);
  if (!side) throw new Error("That image is empty.");
  const sx = (img.naturalWidth - side) / 2;
  const sy = (img.naturalHeight - side) / 2;
  for (const px of [160, 128, 96, 72]) {
    const canvas = document.createElement("canvas");
    canvas.width = canvas.height = px;
    const ctx = canvas.getContext("2d")!;
    ctx.imageSmoothingQuality = "high";
    for (const [type, bg] of [["image/webp", null], ["image/jpeg", "#1a0b2a"]] as const) {
      ctx.clearRect(0, 0, px, px);
      if (bg) {
        ctx.fillStyle = bg;
        ctx.fillRect(0, 0, px, px);
      }
      ctx.drawImage(img, sx, sy, side, side, 0, 0, px, px);
      for (const q of [0.9, 0.8, 0.65, 0.5, 0.38]) {
        const icon = canvas.toDataURL(type, q);
        if (!icon.startsWith(`data:${type};`)) break; // encoder unsupported here
        if (icon.length <= MAX_ICON_BYTES && SAFE_IMAGE.test(icon)) return { icon, size: px, format: type.slice(6).toUpperCase() };
      }
    }
  }
  throw new Error("Couldn't shrink that image under 16 KB. Try a simpler picture.");
}

const metaCache = new Map<string, Promise<string | null>>();

/** A coin's icon: the registry's emoji, or its image from the coin's own `ft_metadata`. */
export function useCoinIcon(contract: string | undefined, icon: string | null, hasImage?: boolean): string | null {
  const [img, setImg] = useState<string | null>(null);
  useEffect(() => {
    if (!hasImage || !contract || PREVIEW) return;
    let live = true;
    if (!metaCache.has(contract)) {
      metaCache.set(
        contract,
        viewMethod(contract, "ft_metadata", {}).then((m: any) => (isImageIcon(m?.icon) ? m.icon : null)).catch(() => {
          metaCache.delete(contract);
          return null;
        }),
      );
    }
    metaCache.get(contract)!.then((i) => live && setImg(i));
    return () => {
      live = false;
    };
  }, [contract, hasImage]);
  return hasImage ? img : icon;
}
