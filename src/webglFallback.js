/**
 * A deliberately lightweight fallback for browsers where Cesium cannot create
 * a usable WebGL context. The application chrome is still useful without the
 * 3D renderer (ADMIN, YouTube settings, and chat), so an unsupported preview
 * should not look like a crashed application.
 */

const FALLBACK_CANVAS_ID = 'gev-2d-fallback-canvas';

function prefersReducedMotion() {
  try {
    return globalThis.matchMedia?.('(prefers-reduced-motion: reduce)')?.matches === true;
  } catch {
    return false;
  }
}

function drawFallbackGlobe(context, width, height, phase = 0) {
  const pixelRatio = globalThis.devicePixelRatio || 1;
  const centerX = width / 2;
  const centerY = height / 2;
  const radius = Math.min(width, height) * 0.31;

  context.clearRect(0, 0, width, height);
  context.save();
  context.scale(pixelRatio, pixelRatio);

  const gradient = context.createRadialGradient(
    centerX - radius * 0.3,
    centerY - radius * 0.35,
    radius * 0.08,
    centerX,
    centerY,
    radius * 1.05,
  );
  gradient.addColorStop(0, 'rgba(28, 104, 130, 0.52)');
  gradient.addColorStop(0.55, 'rgba(4, 31, 47, 0.94)');
  gradient.addColorStop(1, 'rgba(1, 7, 15, 0.98)');

  context.beginPath();
  context.arc(centerX, centerY, radius, 0, Math.PI * 2);
  context.fillStyle = gradient;
  context.shadowColor = 'rgba(0, 212, 255, 0.48)';
  context.shadowBlur = 42;
  context.fill();
  context.shadowBlur = 0;

  context.save();
  context.beginPath();
  context.arc(centerX, centerY, radius - 1, 0, Math.PI * 2);
  context.clip();
  context.strokeStyle = 'rgba(63, 220, 255, 0.28)';
  context.lineWidth = 1;

  for (let latitude = -60; latitude <= 60; latitude += 30) {
    const y = centerY + Math.sin((latitude * Math.PI) / 180) * radius;
    const ellipseWidth = Math.cos((latitude * Math.PI) / 180) * radius;
    context.beginPath();
    context.ellipse(centerX, y, ellipseWidth, radius * 0.16, 0, 0, Math.PI * 2);
    context.stroke();
  }

  for (let longitude = 0; longitude < 4; longitude += 1) {
    const rotation = phase + (longitude * Math.PI) / 4;
    context.beginPath();
    context.ellipse(
      centerX,
      centerY,
      Math.abs(Math.cos(rotation)) * radius,
      radius,
      0,
      0,
      Math.PI * 2,
    );
    context.stroke();
  }

  // Small signal points make the fallback read as a live operations surface
  // without claiming that real data layers are active.
  const signals = [
    [-0.31, -0.19],
    [0.18, -0.34],
    [0.36, 0.11],
    [-0.12, 0.33],
    [-0.45, 0.21],
  ];
  for (const [x, y] of signals) {
    context.beginPath();
    context.arc(centerX + x * radius, centerY + y * radius, 2.5, 0, Math.PI * 2);
    context.fillStyle = '#25e6ff';
    context.shadowColor = '#25e6ff';
    context.shadowBlur = 12;
    context.fill();
    context.shadowBlur = 0;
  }
  context.restore();

  context.beginPath();
  context.arc(centerX, centerY, radius, 0, Math.PI * 2);
  context.strokeStyle = 'rgba(115, 235, 255, 0.7)';
  context.lineWidth = 1.5;
  context.stroke();
  context.restore();
}

function resizeCanvas(canvas, context) {
  const bounds = canvas.getBoundingClientRect();
  const pixelRatio = globalThis.devicePixelRatio || 1;
  const width = Math.max(1, Math.round(bounds.width * pixelRatio));
  const height = Math.max(1, Math.round(bounds.height * pixelRatio));
  if (canvas.width !== width || canvas.height !== height) {
    canvas.width = width;
    canvas.height = height;
  }
  return {
    width: bounds.width,
    height: bounds.height,
  };
}

/**
 * Mount the non-WebGL experience. This is not a replacement globe and does
 * not pretend that live 3D data layers are running; it is a safe, visible
 * degraded state that preserves the surrounding application surfaces.
 */
export function initWebGLFallback({
  container = globalThis.document?.getElementById?.('cesiumContainer'),
  loadingScreen = globalThis.document?.getElementById?.('loading-screen'),
  loaderStatus = loadingScreen?.querySelector?.('.loader-status'),
  reason = 'webgl-unavailable',
} = {}) {
  if (!container) return null;

  container.replaceChildren();
  container.classList.add('gev-2d-fallback-container');

  const canvas = document.createElement('canvas');
  canvas.id = FALLBACK_CANVAS_ID;
  canvas.className = 'gev-2d-fallback-canvas';
  canvas.setAttribute('role', 'img');
  canvas.setAttribute(
    'aria-label',
    'Static 2D fallback globe. Hardware-accelerated WebGL is unavailable.',
  );
  container.appendChild(canvas);

  const status = document.createElement('section');
  status.className = 'gev-2d-fallback-status';
  status.setAttribute('aria-live', 'polite');
  status.innerHTML = `
    <span class="gev-2d-fallback-kicker">2D FALLBACK MODE</span>
    <h2>GEV interface is online</h2>
    <p>3D globe rendering is unavailable in this browser session. ADMIN, YouTube settings, and live chat remain available.</p>
    <button type="button" class="gev-2d-fallback-retry">RETRY 3D MODE</button>
  `;
  container.appendChild(status);

  const retry = status.querySelector('.gev-2d-fallback-retry');
  retry?.addEventListener('click', () => {
    retry.disabled = true;
    retry.textContent = 'RELOADING…';
    globalThis.location?.reload?.();
  });

  const context = canvas.getContext?.('2d');
  if (!context) {
    status.querySelector('p').textContent =
      '3D globe rendering is unavailable, but ADMIN, YouTube settings, and live chat remain available.';
  } else {
    let phase = 0;
    let frame = 0;
    const reducedMotion = prefersReducedMotion();
    const render = () => {
      const { width, height } = resizeCanvas(canvas, context);
      drawFallbackGlobe(context, width, height, phase);
      if (!reducedMotion) {
        phase += 0.0018;
        frame = globalThis.requestAnimationFrame?.(render) || 0;
      }
    };
    render();
    // Store a cancellation hook so future startup/retry work can cleanly
    // replace this renderer instead of leaving an animation loop behind.
    canvas.__gevCancelFallback = () => {
      if (frame) globalThis.cancelAnimationFrame?.(frame);
    };
    globalThis.addEventListener?.('resize', render, { passive: true });
  }

  if (loaderStatus) {
    loaderStatus.textContent = '3D unavailable. GEV interface loaded in 2D fallback mode.';
    loaderStatus.setAttribute('role', 'status');
  }
  loadingScreen?.classList.add('hidden');
  document.body?.classList.add('webgl-fallback-active');
  globalThis.__gevGpuCompatibility = {
    ...(globalThis.__gevGpuCompatibility || {}),
    mode: '2d-fallback',
    reason,
  };

  return {
    mode: '2d-fallback',
    canvas,
    reason,
    destroy() {
      canvas.__gevCancelFallback?.();
      container.classList.remove('gev-2d-fallback-container');
      container.replaceChildren();
      document.body?.classList.remove('webgl-fallback-active');
    },
  };
}