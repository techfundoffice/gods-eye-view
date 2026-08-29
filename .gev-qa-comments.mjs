import puppeteer from 'puppeteer';

const CANDIDATES = [
  process.env.PUPPETEER_EXECUTABLE_PATH,
  (() => { try { return puppeteer.executablePath(); } catch { return null; } })(),
].filter(Boolean);

let browser = null;
for (const executablePath of CANDIDATES) {
  try {
    browser = await puppeteer.launch({
      executablePath,
      headless: 'new',
      args: ['--no-sandbox', '--disable-setuid-sandbox', '--use-gl=swiftshader', '--enable-unsafe-swiftshader'],
    });
    console.log('launched', executablePath);
    break;
  } catch (error) { console.log('skip', executablePath, error.message.split('\n')[0]); }
}
if (!browser) { console.log('NO BROWSER'); process.exit(2); }

const page = await browser.newPage();
await page.setViewport({ width: 1600, height: 950 });
const errors = [];
page.on('pageerror', (e) => errors.push(String(e).split('\n')[0]));
await page.goto('http://127.0.0.1:5399/', { waitUntil: 'networkidle2', timeout: 60000 });
await new Promise((r) => setTimeout(r, 4000));

const read = () => {
  const panel = document.getElementById('youtube-comments-panel');
  if (!panel) return { present: false };
  const box = panel.getBoundingClientRect();
  return {
    present: true,
    inRightRail: panel.parentElement?.id === 'right-context-rail',
    collapsed: panel.classList.contains('collapsed'),
    rightEdge: Math.round(box.right),
    viewportWidth: window.innerWidth,
    width: Math.round(box.width),
    height: Math.round(box.height),
    status: document.getElementById('youtube-comments-status')?.textContent,
    subject: document.getElementById('youtube-comments-video')?.textContent,
    emptyRow: document.querySelector('#youtube-comments-list .youtube-feed-empty')?.textContent || null,
    moreDisabled: document.getElementById('youtube-comments-more')?.disabled,
    refreshDisabled: document.getElementById('youtube-comments-refresh')?.disabled,
    collapseGlyph: panel.querySelector('.panel-collapse-btn')?.textContent,
  };
};

console.log('collapsed:', JSON.stringify(await page.evaluate(read), null, 1));

await page.click('#youtube-comments-panel .panel-collapse-btn');
await new Promise((r) => setTimeout(r, 700));
const expanded = await page.evaluate(read);
console.log('expanded:', JSON.stringify(expanded, null, 1));

// Feed the view a real thread set through the live controller, as the API would.
const rendered = await page.evaluate(() => {
  const controller = window.__godsEyeView?.youtubePanel;
  if (!controller?.commentsPanel) return { wired: false };
  controller.state.connection = 'connected';
  controller.state.videos = [{ id: 'v1', snippet: { title: 'Harbor watch' }, statistics: {} }];
  controller.state.videoId = 'v1';
  controller.state.comments = [
    { id: 't1', author: 'Operator', text: 'First thread', publishedAt: '2026-08-29T10:00:00Z', likeCount: 3, replyCount: 1, replies: [{ id: 'r1', author: 'Viewer', text: 'A reply', publishedAt: '2026-08-29T10:05:00Z', likeCount: 0 }] },
    { id: 't2', author: 'Analyst', text: 'Second thread', publishedAt: '2026-08-29T10:10:00Z', likeCount: 0, replyCount: 4, replies: [] },
  ];
  controller.state.commentsNextPageToken = 'page-2';
  controller._render();
  return {
    wired: true,
    status: document.getElementById('youtube-comments-status').textContent,
    subject: document.getElementById('youtube-comments-video').textContent,
    count: document.getElementById('youtube-comments-count').textContent,
    threads: document.querySelectorAll('#youtube-comments-list .youtube-comment-thread').length,
    replies: document.querySelectorAll('#youtube-comments-list .youtube-comment-reply').length,
    hint: document.querySelector('.youtube-comment-reply-hint')?.textContent || null,
    moreDisabled: document.getElementById('youtube-comments-more').disabled,
    listScrolls: (() => { const l = document.getElementById('youtube-comments-list'); return l.scrollHeight >= l.clientHeight; })(),
  };
});
console.log('rendered:', JSON.stringify(rendered, null, 1));
console.log('pageerrors:', errors.slice(0, 5));
await page.screenshot({ path: process.env.SP + '/comments-panel.png' });
await browser.close();
