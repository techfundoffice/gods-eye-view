/** One live YouTube viewer owns the globe at a time. */

export const HOST_FOLLOWUP_MS = 90_000;
export const HOST_FOLLOWUP_SECONDS = 90;
export const HOST_VIEW_OPTIONS = 'Downtown closer · 3D buildings · overhead · orbit · live flights';

const VIEW_CHOICE = /\b(?:downtown(?:\s+closer)?|closer|close(?:-?up)?|3d(?:\s+buildings)?|photorealistic|overhead|orbit|live\s+flights|flights|traffic|cctv)\b/i;

const bounded = (value, max) => String(value ?? '').replace(/[\u0000-\u001f\u007f]/g, ' ').trim().slice(0, max);

export function hostViewerIdentity(comment = {}, record = {}) {
  const handle = bounded(comment.authorHandle || comment.author?.handle || record.authorHandle, 80);
  const name = bounded(comment.author?.displayName || comment.viewer || record.viewer, 80);
  const label = handle || name;
  return {
    key: label.toLowerCase(),
    handle: label,
    name: name || label,
  };
}

export function atHandle(handle) {
  const raw = bounded(handle, 80);
  if (!raw) return 'Viewer';
  return raw.startsWith('@') ? raw : `@${raw}`;
}

export function formatHostAsk({ handle, place, seconds = HOST_FOLLOWUP_SECONDS } = {}) {
  const who = atHandle(handle);
  const where = bounded(place, 80) || 'this place';
  return `${who} Map-style overview of ${where} is up. Want a different view? ${HOST_VIEW_OPTIONS}. You have ${seconds} seconds to reply or I move on to the next viewer.`;
}

export function formatHostFollowupAsk({ handle, place, summary, seconds = HOST_FOLLOWUP_SECONDS } = {}) {
  const who = atHandle(handle);
  const done = bounded(summary, 120) || 'Updated the view';
  const where = bounded(place, 80);
  const loc = where ? ` of ${where}` : '';
  return `${who} ${done}${loc}. Anything else? ${HOST_VIEW_OPTIONS}. You have ${seconds} seconds to reply or I move on to the next viewer.`;
}

export function isViewChoiceComment(text) {
  const raw = bounded(text, 500);
  if (!raw) return false;
  if (/\b(?:navigate to|take me to|go to|fly to)\s+\S/i.test(raw)) return false;
  return VIEW_CHOICE.test(raw);
}

export function isNewPlaceComment(text) {
  const raw = bounded(text, 500);
  if (!raw || isViewChoiceComment(raw)) return false;
  return /\b(?:navigate to|take me to|go to|fly to|zoom to|focus on|look at|show me|show|see|view|find|locate)\s+(?:me\s+)?(.{2,160})$/i.test(raw);
}

export function createHostSession({ now = Date.now } = {}) {
  let session = null;

  function current() {
    if (!session) return null;
    if (now() >= session.expiresAt) {
      session = null;
      return null;
    }
    return { ...session };
  }

  function open(identity, place, commandId) {
    const handle = identity?.handle || identity?.name || 'Viewer';
    const key = String(identity?.key || handle).toLowerCase();
    if (!key) return null;
    session = {
      key,
      handle,
      place: bounded(place, 80),
      commandId: bounded(commandId, 160),
      expiresAt: now() + HOST_FOLLOWUP_MS,
    };
    return { ...session };
  }

  function touch(place) {
    if (!current()) return null;
    if (place) session.place = bounded(place, 80);
    session.expiresAt = now() + HOST_FOLLOWUP_MS;
    return { ...session };
  }

  function clear() {
    session = null;
  }

  function isOwner(identity) {
    const active = current();
    return Boolean(active && identity?.key && active.key === identity.key);
  }

  function shouldHold(identity) {
    const active = current();
    return Boolean(active && identity?.key && active.key !== identity.key);
  }

  return { current, open, touch, clear, isOwner, shouldHold };
}
