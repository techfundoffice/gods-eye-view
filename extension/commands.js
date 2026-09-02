(function installGevExtensionPolicy(global) {
  const MAX_COMMENT = 500;
  const MAX_NAME = 80;
  const MAX_ID = 160;
  const HELP = 'I can help you if you type /live-contacts , /space-missions, /environmental, /explore-manually';

  function clean(value, max) {
    return String(value == null ? '' : value)
      .replace(/[\u0000-\u001f\u007f]/g, ' ')
      .trim()
      .slice(0, max);
  }

  function action(action, args) {
    return { action, args: args || {} };
  }

  function parse(text) {
    const input = clean(text, MAX_COMMENT);
    const match = input.match(/^(\S+)(?:\s+([\s\S]*))?$/);
    if (!match) return { recognized: false, reason: 'empty' };
    const command = match[1].toLowerCase();
    const request = clean(match[2] || '', MAX_COMMENT);
    const preset = {
      '/live-contacts': '/live-contacts',
      '/space-missions': '/space-missions',
      '/environmental': '/environmental',
      '/explore-manually': '/explore-manually',
    }[command];
    if (preset) {
      if (request) return { recognized: false, reason: 'arguments-not-allowed' };
      return { recognized: true, command, kind: 'action', actions: [action('run_view_preset', { preset })] };
    }
    if (command === '/help') {
      return request
        ? { recognized: false, reason: 'arguments-not-allowed' }
        : { recognized: true, command, kind: 'help', answer: HELP, actions: [] };
    }
    if (command === '/gods-eye-view') {
      return request
        ? { recognized: false, reason: 'arguments-not-allowed' }
        : { recognized: true, command, kind: 'action', actions: [action('zoom_to_globe')] };
    }
    if (!['/x', '/z'].includes(command)) return { recognized: false, reason: 'unknown' };
    const globe = /^(?:globe|reset)$/i.exec(request);
    if (globe) return { recognized: true, command, kind: 'action', actions: [action('zoom_to_globe')] };
    const zoom = /^zoom\s+(in|out)\s+(little|medium|lot)$/i.exec(request);
    if (zoom) {
      return {
        recognized: true,
        command,
        kind: 'action',
        actions: [action('adjust_camera_zoom', { direction: zoom[1].toLowerCase(), amount: zoom[2].toLowerCase() })],
      };
    }
    const destination = request.match(/^(?:fly\s+to|go\s+to|location)\s+(.+)$/i)?.[1];
    if (destination) {
      const query = clean(destination, 200);
      if (!query) return { recognized: false, reason: 'location-required' };
      return { recognized: true, command, kind: 'action', actions: [action('fly_to_location', { query, waitForArrival: true })] };
    }
    return { recognized: false, reason: 'unsupported-request' };
  }

  global.GevExtensionPolicy = Object.freeze({
    MAX_COMMENT,
    MAX_NAME,
    MAX_ID,
    clean,
    parse,
  });
}(globalThis));