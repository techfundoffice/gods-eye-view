/**
 * Brand / image library for ADMIN Image Library.
 * Owns the Youtube Chat brand logo (#youtube-chat-brand .youtube-chat-brand-logo).
 *
 * @module imageLibrary
 */

export const EVENT = "gev:image-library-changed";
export const STORAGE_KEY = "gev:image-library-v1";

export const DEFAULT_BRAND_LOGO_URL =
  "/public/cloud-computer-logo-dark.png?v=yellow5";

/**
 * @typedef {{ version: number, brandLogoUrl: string, updatedAt?: string }} ImageLibraryConfig
 */

/** @returns {ImageLibraryConfig} */
export function defaultConfig() {
  return {
    version: 1,
    brandLogoUrl: DEFAULT_BRAND_LOGO_URL,
  };
}

/**
 * @param {unknown} raw
 * @returns {ImageLibraryConfig}
 */
export function normalizeConfig(raw) {
  const base = defaultConfig();
  if (!raw || typeof raw !== "object") return base;
  const url = String(/** @type {any} */ (raw).brandLogoUrl || "").trim();
  return {
    version: 1,
    brandLogoUrl: url || DEFAULT_BRAND_LOGO_URL,
    updatedAt: typeof /** @type {any} */ (raw).updatedAt === "string"
      ? /** @type {any} */ (raw).updatedAt
      : undefined,
  };
}

/** @returns {ImageLibraryConfig} */
export function readConfig() {
  try {
    const raw = globalThis.localStorage?.getItem(STORAGE_KEY);
    if (!raw) return defaultConfig();
    const cfg = normalizeConfig(JSON.parse(raw));
    // Migrate legacy dark/low-contrast PNG to high-contrast mark.
    const url = String(cfg.brandLogoUrl || "");
    if (
      url.includes("Cloud_Computer_Ai.com_Logo_")
      || url.includes("cloud-computer-logo-hc.")
    ) {
      return writeConfig({ brandLogoUrl: DEFAULT_BRAND_LOGO_URL });
    }
    return cfg;
  } catch {
    return defaultConfig();
  }
}

/**
 * @param {ImageLibraryConfig} config
 * @returns {ImageLibraryConfig}
 */
export function writeConfig(config) {
  const next = normalizeConfig({
    ...config,
    updatedAt: new Date().toISOString(),
  });
  try {
    globalThis.localStorage?.setItem(STORAGE_KEY, JSON.stringify(next));
  } catch {
    /* ignore quota */
  }
  try {
    globalThis.document?.dispatchEvent?.(new CustomEvent(EVENT, { detail: next }));
    globalThis.dispatchEvent?.(new CustomEvent(EVENT, { detail: next }));
  } catch {
    /* ignore */
  }
  return next;
}

/**
 * Apply brand logo to live Youtube Chat brand img(s).
 * @param {Document} [doc]
 * @param {ImageLibraryConfig} [config]
 */
export function applyBrandLogo(doc = globalThis.document, config = readConfig()) {
  if (!doc?.querySelectorAll) return;
  const url = String(config?.brandLogoUrl || DEFAULT_BRAND_LOGO_URL).trim() || DEFAULT_BRAND_LOGO_URL;
  const imgs = doc.querySelectorAll(
    "#youtube-chat-brand .youtube-chat-brand-logo, img.youtube-chat-brand-logo",
  );
  for (const img of imgs) {
    try {
      if (img.getAttribute("src") !== url) img.setAttribute("src", url);
      if (!img.getAttribute("alt")) img.setAttribute("alt", "Cloud Computer AI.com");
    } catch {
      /* ignore */
    }
  }
}

/**
 * Boot: apply saved logo and keep listening for ADMIN saves.
 * @param {Document} [doc]
 * @returns {() => void}
 */
export function initImageLibrary(doc = globalThis.document) {
  applyBrandLogo(doc);
  const onChange = () => applyBrandLogo(doc, readConfig());
  try {
    doc?.addEventListener?.(EVENT, onChange);
    globalThis.addEventListener?.(EVENT, onChange);
  } catch {
    /* ignore */
  }
  return () => {
    try {
      doc?.removeEventListener?.(EVENT, onChange);
      globalThis.removeEventListener?.(EVENT, onChange);
    } catch {
      /* ignore */
    }
  };
}
