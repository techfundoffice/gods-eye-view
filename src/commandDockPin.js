/**
 * First-run pin policy for the command-dock LOCATION and VISUAL PRESETS trays.
 *
 * A fresh visit (nothing stored) pins both trays open. VISUAL PRESETS
 * (`control-panel`) always stay pinned and expanded so the broadcast picture
 * never hides style tiles / map chips. LOCATION still honours stored unpin.
 */

/** Command-dock trays that can stay open via the pin control. */
export const COMMAND_DOCK_PINNABLE_PANEL_IDS = Object.freeze([
  'control-panel',
  'location-bar',
]);

/** Trays that must stay expanded on the homepage globe regardless of stored pin. */
export const ALWAYS_VISIBLE_DOCK_PANEL_IDS = Object.freeze([
  'control-panel',
  'location-bar',
  'pp-toggles',
  'cctv-panel',
  'global-context-panel',
  'radio-panel',
]);

/**
 * Whether a command-dock tray should start PINNED.
 *
 * @param {string|null} storedPin `'1'`, `'0'`, or null if unset/unreadable.
 * @param {string|null} storedCollapse `'1'`, `'0'`, or null if unset/unreadable.
 * @param {string} [panelId]
 * @returns {boolean}
 */
export function resolveCommandDockPin(storedPin, storedCollapse, panelId) {
  if (ALWAYS_VISIBLE_DOCK_PANEL_IDS.includes(panelId)) return true;
  if (storedPin === '1') return true;
  if (storedPin === '0') return false;
  if (storedCollapse === '1' || storedCollapse === '0') return false;
  return true;
}

/**
 * Pins or unpins a command-dock tray. Pinning expands it; unpinning collapses
 * it unless this is a restore or the pointer is still over the tray.
 *
 * @param {object} args
 * @param {Element|null|undefined} args.panelEl
 * @param {Element|null|undefined} args.button
 * @param {Element|null|undefined} [args.dock]
 * @param {boolean} [args.pin]
 * @param {boolean} [args.restore=false]
 * @param {boolean} [args.persist=true]
 * @param {boolean} [args.hovering=false]
 * @param {function(boolean, object): void} args.setCollapsed
 * @param {function(boolean): void} [args.savePin]
 * @returns {boolean|undefined}
 */
export function pinCommandDockPanel({
  panelEl,
  button,
  dock,
  pin,
  restore = false,
  persist = true,
  hovering = false,
  setCollapsed,
  savePin,
} = {}) {
  if (!panelEl || !button) return undefined;
  const forceOpen = ALWAYS_VISIBLE_DOCK_PANEL_IDS.includes(panelEl.id);
  const shouldPin = forceOpen
    ? true
    : (typeof pin === 'boolean' ? pin : !panelEl.classList.contains('dock-pinned'));
  panelEl.classList.toggle('dock-pinned', shouldPin);
  button.setAttribute('aria-pressed', String(shouldPin));
  dock?.querySelectorAll?.('.dock-pinned-top').forEach((pinnedPanel) => {
    pinnedPanel.classList.remove('dock-pinned-top');
  });
  if (shouldPin || forceOpen) {
    panelEl.classList.add('dock-pinned-top');
    setCollapsed(false, {
      explicit: !restore,
      restore,
      persist,
      syncShare: false,
    });
  } else {
    dock?.querySelector?.('.dock-pinned')?.classList.add('dock-pinned-top');
    if (!restore && !hovering) {
      setCollapsed(true, {
        explicit: true,
        persist,
        syncShare: false,
      });
    }
  }
  if (persist !== false) savePin?.(shouldPin);
  return shouldPin;
}

/**
 * Applies first-run PINNED defaults unless a stored choice or share-link panel
 * field already owns the tray.
 *
 * @param {object} args
 * @param {Map<string, {pinned?: boolean, collapsed?: boolean}>} [args.shareById]
 * @param {boolean} args.allowStored
 * @param {function(string): (string|null)} args.readPin
 * @param {function(string): (string|null)} args.readCollapse
 * @param {function(string, boolean, object): void} args.setPin
 * @param {function(string, object): void} args.restoreCollapse
 * @returns {void}
 */
export function restoreCommandDockPinDefaults({
  shareById,
  allowStored,
  readPin,
  readCollapse,
  setPin,
  restoreCollapse,
} = {}) {
  for (const panelId of COMMAND_DOCK_PINNABLE_PANEL_IDS) {
    const shareSpec = shareById?.get?.(panelId);
    if (
      !ALWAYS_VISIBLE_DOCK_PANEL_IDS.includes(panelId)
      && shareSpec
      && (typeof shareSpec.pinned === 'boolean' || typeof shareSpec.collapsed === 'boolean')
    ) {
      continue;
    }
    const storedPin = allowStored ? readPin(panelId) : null;
    const storedCollapse = allowStored ? readCollapse(panelId) : null;
    const shouldPin = resolveCommandDockPin(storedPin, storedCollapse, panelId);
    setPin(panelId, shouldPin, {
      restore: true,
      persist: false,
      syncShare: false,
    });
    if (!shouldPin && !ALWAYS_VISIBLE_DOCK_PANEL_IDS.includes(panelId)) {
      restoreCollapse(panelId, { allowStored });
    }
  }
}
