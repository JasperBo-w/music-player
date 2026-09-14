/* ==========================================================================
   音乐播放器 · 下载页脚本
   --------------------------------------------------------------------------
   三件事：
     1. 读取 site.config.json，把配置渲染进 [data-cfg] 节点和各个列表
     2. 粒子星座背景（跟随鼠标，尊重"减少动态效果"设置）
     3. 滚动入场动画、复制校验值、截图灯箱

   所有文案都来自配置，不要在这个文件里硬编码产品信息 —— 发新版只改 JSON。
   ========================================================================== */

/* ==========================================================================
   1. 配置读取与渲染
   ========================================================================== */

/** 取嵌套字段，例如 get(cfg, 'release.downloads.windows') */
function get(obj, path) {
  return path.split('.').reduce((acc, key) => (acc == null ? undefined : acc[key]), obj);
}

/** 统一版本号显示：配置里写 0.1.0 或 v0.1.0 都行，这里补上 v 前缀 */
function versionTag(v) {
  if (!v) return '';
  return String(v).startsWith('v') ? String(v) : `v${v}`;
}

/**
 * 判断某个配置值是否还是占位符 —— 占位符不展示，避免页面上出现 REPLACE 字样，
 * 也避免访客点到一个指向不存在文件的下载按钮。
 *
 * 注意 REPLACE 两侧不一定是空格（常见写法是 pub-REPLACE-WITH-YOUR-BUCKET），
 * 所以不能用 ' REPLACE ' 这种带空格包裹的模式去匹配。
 */
function isPlaceholder(value) {
  if (value == null) return true;
  const s = String(value).trim();
  if (!s) return true;
  return /REPLACE|PLACEHOLDER|TODO|XXX|^待填写|^待补充/i.test(s);
}

/**
 * 是否开启了系统的"减少动态效果"。
 * matchMedia 在老浏览器 / 某些内嵌 WebView 里不存在，缺了就当作"没开"，
 * 而不是让整个脚本在初始化阶段抛错 —— 那样页面会整片空白。
 */
function prefersReducedMotion() {
  if (typeof window === 'undefined' || typeof window.matchMedia !== 'function') return false;
  try {
    return window.matchMedia('(prefers-reduced-motion: reduce)').matches === true;
  } catch {
    return false;
  }
}

function setText(el, text) {
  if (el) el.textContent = text == null ? '' : String(text);
}

/** 往所有 [data-cfg="key"] 节点写入配置值 */
function renderBindings(cfg) {
  const version = versionTag(get(cfg, 'release.version'));
  const downloadUrl = get(cfg, 'release.downloads.windows');
  const hasDownload = !isPlaceholder(downloadUrl);

  // 这几个字段是链接：除了填文字，还要写进 href。用配置键名当选择器，
  // 这样一个字段能同时驱动导航栏、按钮、页脚里的多个链接。
  const linkKeys = ['repoUrl', 'issuesUrl'];

  const map = {
    appName: cfg.appName,
    appNameEn: cfg.appNameEn,
    tagline: cfg.tagline,
    description: cfg.description,

    version,
    'version-pill': version,
    channelLabel: get(cfg, 'release.channelLabel') || get(cfg, 'release.channel'),
    fileName: get(cfg, 'release.fileName'),
    fileSize: isPlaceholder(get(cfg, 'release.fileSize')) ? '待发布' : get(cfg, 'release.fileSize'),
    releaseDate: get(cfg, 'release.releaseDate'),
    sha256: isPlaceholder(get(cfg, 'release.sha256')) ? '发布时公布' : get(cfg, 'release.sha256'),
    minWindows: get(cfg, 'release.minWindows'),

    repoUrl: cfg.repoUrl,
    issuesUrl: cfg.issuesUrl,

    disclaimer: get(cfg, 'legal.disclaimer'),
    copyright: get(cfg, 'legal.copyright')
  };

  for (const [key, value] of Object.entries(map)) {
    document.querySelectorAll(`[data-cfg="${key}"]`).forEach((el) => {
      if (key === 'appNameEn') {
        setText(el, String(value || '').toUpperCase());
      } else {
        setText(el, value);
      }

      // 标题里的文字要同时喂给 data-text，供伪元素做色差层
      if (el.classList.contains('glitch')) el.dataset.text = String(value ?? '');

      // 链接字段：把 href 也一起填上，否则页面上全是 '#' 空链接
      if (linkKeys.includes(key)) {
        if (isPlaceholder(value)) {
          el.removeAttribute('href');
          el.setAttribute('aria-disabled', 'true');
        } else {
          el.href = value;
          el.rel = 'noopener';
          // 站外链接开新标签；站内相对链接保持原样
          if (/^https?:\/\//i.test(value)) el.target = '_blank';
          el.removeAttribute('aria-disabled');
        }
      }
    });
  }

  // 下载按钮：配置里还是占位符时，不指向坏链接，而是明确提示未发布
  const btn = document.getElementById('btn-download');
  if (btn) {
    if (hasDownload) {
      btn.href = downloadUrl;
      btn.target = '_blank';
      btn.rel = 'noopener';
      btn.removeAttribute('aria-disabled');
    } else {
      btn.removeAttribute('href');
      btn.setAttribute('aria-disabled', 'true');
      btn.style.opacity = '.55';
      btn.style.cursor = 'not-allowed';
      btn.title = '安装包尚未上传：请在 site.config.json 的 release.downloads.windows 填入 R2 链接';
      const strong = btn.querySelector('strong');
      if (strong) setText(strong, '安装包未发布');
    }
  }

  // 按钮上的小字：把版本号和文件大小合并成一行元信息
  const meta = document.querySelector('[data-cfg="fileMeta"]');
  if (meta) {
    const parts = ['.exe'];
    if (!isPlaceholder(get(cfg, 'release.fileSize'))) parts.push(get(cfg, 'release.fileSize'));
    setText(meta, parts.join(' · '));
  }

  // 备用下载线路
  const mirrors = (get(cfg, 'release.mirrors') || []).filter((m) => m && m.url && !isPlaceholder(m.url));
  const mirrorBox = document.getElementById('mirrors');
  if (mirrorBox && mirrors.length) {
    mirrorBox.innerHTML =
      '备用线路：' +
      mirrors
        .map((m) => `<a href="${escapeAttr(m.url)}" rel="noopener" target="_blank">${escapeHtml(m.label || m.url)}</a>`)
        .join('　·　');
  }
}

/* ==========================================================================
   2. 列表渲染
   ========================================================================== */

function escapeHtml(s) {
  return String(s ?? '').replace(/[&<>"']/g, (c) =>
    ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c])
  );
}
function escapeAttr(s) {
  return escapeHtml(s).replace(/`/g, '&#96;');
}

function renderFeatures(cfg) {
  const grid = document.getElementById('feature-grid');
  const list = cfg.features || [];
  if (!grid || !list.length) return;

  grid.innerHTML = list
    .map(
      (f, i) => `
      <article class="card reveal" style="transition-delay:${Math.min(i, 5) * 60}ms">
        <span class="card-icon" aria-hidden="true">${escapeHtml(f.icon || '◆')}</span>
        <h3 class="card-title">${escapeHtml(f.title)}</h3>
        <p class="card-text">${escapeHtml(f.text)}</p>
      </article>`
    )
    .join('');
}

function renderScreenshots(cfg) {
  const section = document.getElementById('shots');
  const grid = document.getElementById('shot-grid');
  const list = (cfg.screenshots || []).filter((s) => s && s.src);
  if (!section || !grid) return;

  // 没有截图就整段隐藏，而不是留一个空标题
  if (!list.length) {
    section.hidden = true;
    return;
  }

  section.hidden = false;
  grid.innerHTML = list
    .map(
      (s, i) => `
      <figure class="shot reveal" style="transition-delay:${Math.min(i, 5) * 70}ms"
              data-src="${escapeAttr(s.src)}" data-cap="${escapeAttr(s.caption || '')}">
        <img src="${escapeAttr(s.src)}" alt="${escapeAttr(s.caption || `${cfg.appName} 界面截图`)}" loading="lazy" decoding="async" />
        ${s.caption ? `<figcaption class="mono">${escapeHtml(s.caption)}</figcaption>` : ''}
      </figure>`
    )
    .join('');

  grid.querySelectorAll('.shot').forEach((fig) => {
    fig.addEventListener('click', () => openLightbox(fig.dataset.src, fig.dataset.cap));
  });
}

function renderChangelog(cfg) {
  const box = document.getElementById('log-list');
  const list = cfg.changelog || [];
  if (!box || !list.length) return;

  box.innerHTML = list
    .map(
      (entry, i) => `
      <div class="log-entry reveal" style="transition-delay:${Math.min(i, 4) * 70}ms">
        <div class="log-head">
          <span class="log-ver mono">${escapeHtml(versionTag(entry.version))}</span>
          <span class="log-date mono">${escapeHtml(entry.date || '')}</span>
        </div>
        <ul class="log-list">
          ${(entry.items || []).map((it) => `<li>${escapeHtml(it)}</li>`).join('')}
        </ul>
      </div>`
    )
    .join('');
}

function renderFaq(cfg) {
  const box = document.getElementById('faq-list');
  const list = cfg.faq || [];
  if (!box || !list.length) return;

  box.innerHTML = list
    .map(
      (item, i) => `
      <details class="faq-item reveal" style="transition-delay:${Math.min(i, 5) * 50}ms"${i === 0 ? ' open' : ''}>
        <summary>
          <span class="faq-q">${escapeHtml(item.q)}</span>
          <span class="faq-sign" aria-hidden="true"></span>
        </summary>
        <p class="faq-a">${escapeHtml(item.a)}</p>
      </details>`
    )
    .join('');
}

/* ==========================================================================
   3. 状态条 —— 四个数字型摘要，带滚动入场时的跳数动画
   ========================================================================== */

function renderStatbar(cfg) {
  const box = document.getElementById('statbar');
  if (!box) return;

  const fileSize = get(cfg, 'release.fileSize');
  const sha = get(cfg, 'release.sha256');

  const stats = [
    { label: 'VERSION', value: versionTag(get(cfg, 'release.version')), cls: 'accent' },
    { label: 'INSTALLER', value: isPlaceholder(fileSize) ? '待发布' : fileSize, small: true },
    { label: 'SHA-256', value: isPlaceholder(sha) ? '发布时公布' : `${String(sha).slice(0, 12)}…`, small: true },
    { label: 'BUILD', value: get(cfg, 'release.releaseDate') || '—' }
  ];

  box.innerHTML = stats
    .map(
      (s) => `
      <div class="stat reveal">
        <span class="stat-label mono">${escapeHtml(s.label)}</span>
        <span class="stat-value mono${s.small ? ' small' : ''}${s.cls ? ' ' + s.cls : ''}"
              data-count="${escapeAttr(s.value)}">${escapeHtml(s.value)}</span>
      </div>`
    )
    .join('');
}

/** 纯数字部分从 0 滚到目标值；带单位/日期的原样显示，避免出现怪数字 */
function animateCount(el) {
  const raw = el.dataset.count || '';
  const m = raw.match(/^(\d+(?:\.\d+)?)\s*([A-Za-z%]*)$/);
  if (!m) return;
  const target = parseFloat(m[1]);
  const unit = m[2] || '';
  const decimals = (m[1].split('.')[1] || '').length;
  const dur = 700;
  const t0 = performance.now();

  function tick(now) {
    const p = Math.min(1, (now - t0) / dur);
    const eased = 1 - Math.pow(1 - p, 3);
    el.textContent = (target * eased).toFixed(decimals) + unit;
    if (p < 1) requestAnimationFrame(tick);
    else el.textContent = raw;
  }
  requestAnimationFrame(tick);
}

/* ==========================================================================
   4. 复制校验值
   ========================================================================== */

function wireCopyButtons() {
  document.querySelectorAll('[data-copy]').forEach((btn) => {
    btn.addEventListener('click', async () => {
      const key = btn.dataset.copy;
      const src = document.querySelector(`[data-cfg="${key}"]`);
      if (!src) return;
      const text = src.textContent.trim();

      try {
        await navigator.clipboard.writeText(text);
      } catch {
        // 非 HTTPS 或浏览器拒绝剪贴板时退回到选区方案
        const ta = document.createElement('textarea');
        ta.value = text;
        ta.style.position = 'fixed';
        ta.style.opacity = '0';
        document.body.appendChild(ta);
        ta.select();
        try { document.execCommand('copy'); } catch { /* 忽略 */ }
        ta.remove();
      }

      const original = btn.textContent;
      btn.textContent = 'COPIED';
      btn.classList.add('done');
      setTimeout(() => {
        btn.textContent = original;
        btn.classList.remove('done');
      }, 1600);
    });
  });
}

/* ==========================================================================
   5. 截图灯箱
   ========================================================================== */

let lastFocused = null;

function openLightbox(src, caption) {
  const lb = document.getElementById('lightbox');
  const img = document.getElementById('lb-img');
  const cap = document.getElementById('lb-cap');
  if (!lb || !img) return;

  lastFocused = document.activeElement;
  img.src = src;
  setText(cap, caption || '');
  lb.hidden = false;
  document.body.style.overflow = 'hidden';
  lb.querySelector('.lb-close')?.focus();
}

function closeLightbox() {
  const lb = document.getElementById('lightbox');
  const img = document.getElementById('lb-img');
  if (!lb || lb.hidden) return;

  lb.hidden = true;
  if (img) img.removeAttribute('src');
  document.body.style.overflow = '';
  lastFocused?.focus?.();
}

function wireLightbox() {
  const lb = document.getElementById('lightbox');
  if (!lb) return;

  lb.addEventListener('click', (e) => {
    // 点空白处或关闭按钮都关；点图片本身不关
    if (e.target === lb || e.target.classList.contains('lb-close')) closeLightbox();
  });

  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') closeLightbox();
  });
}

/* ==========================================================================
   6. 滚动入场动画
   ========================================================================== */

function wireReveal() {
  const items = document.querySelectorAll('.reveal');
  if (!items.length) return;

  const reduce = prefersReducedMotion();
  if (reduce || !('IntersectionObserver' in window)) {
    items.forEach((el) => el.classList.add('in'));
    return;
  }

  const io = new IntersectionObserver(
    (entries) => {
      entries.forEach((entry) => {
        if (!entry.isIntersecting) return;
        const el = entry.target;
        el.classList.add('in');
        el.querySelectorAll('[data-count]').forEach(animateCount);
        io.unobserve(el);
      });
    },
    { rootMargin: '0px 0px -12% 0px', threshold: 0.08 }
  );

  items.forEach((el) => io.observe(el));
}

/* ==========================================================================
   7. 粒子星座背景
   --------------------------------------------------------------------------
   和播放器本体的粒子系统同一个思路，但这里的目的是"氛围"而不是视觉主体：
   密度低、速度慢、只在近距离连线，保证不抢内容注意力、也不吃 CPU。
   ========================================================================== */

function startParticles() {
  const canvas = document.getElementById('bg');
  if (!canvas) return;

  const reduce = prefersReducedMotion();
  if (reduce) return;

  const ctx = canvas.getContext('2d', { alpha: true });
  if (!ctx) return;

  const ACCENT = [232, 200, 122];
  const ICE = [143, 233, 255];
  const LINK_DIST = 148;
  const MOUSE_DIST = 190;

  let w = 0;
  let h = 0;
  let dpr = 1;
  let particles = [];
  let raf = 0;
  let running = true;
  const mouse = { x: -1e4, y: -1e4 };

  function resize() {
    dpr = Math.min(window.devicePixelRatio || 1, 2);
    w = canvas.clientWidth;
    h = canvas.clientHeight;
    canvas.width = Math.floor(w * dpr);
    canvas.height = Math.floor(h * dpr);
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);

    // 密度跟着面积走，但设上下限：小屏别太空，大屏别太密
    const count = Math.round(Math.min(96, Math.max(34, (w * h) / 24000)));
    particles = Array.from({ length: count }, () => spawn());
  }

  function spawn() {
    const ice = Math.random() < 0.16;
    return {
      x: Math.random() * w,
      y: Math.random() * h,
      vx: (Math.random() - 0.5) * 0.24,
      vy: (Math.random() - 0.5) * 0.24,
      r: Math.random() * 1.3 + 0.6,
      a: Math.random() * 0.4 + 0.28,
      c: ice ? ICE : ACCENT
    };
  }

  function frame() {
    if (!running) return;
    ctx.clearRect(0, 0, w, h);

    for (const p of particles) {
      p.x += p.vx;
      p.y += p.vy;

      // 边界回绕，比反弹更不容易在高密度时挤成一团
      if (p.x < -20) p.x = w + 20;
      if (p.x > w + 20) p.x = -20;
      if (p.y < -20) p.y = h + 20;
      if (p.y > h + 20) p.y = -20;
    }

    // 连线：只连近距离的点。O(n²) 在 n≤96 时完全不是问题
    for (let i = 0; i < particles.length; i++) {
      const a = particles[i];
      for (let j = i + 1; j < particles.length; j++) {
        const b = particles[j];
        const dx = a.x - b.x;
        const dy = a.y - b.y;
        const d2 = dx * dx + dy * dy;
        if (d2 > LINK_DIST * LINK_DIST) continue;

        const d = Math.sqrt(d2);
        const alpha = (1 - d / LINK_DIST) * 0.14;
        ctx.strokeStyle = `rgba(${ACCENT[0]},${ACCENT[1]},${ACCENT[2]},${alpha})`;
        ctx.lineWidth = 0.7;
        ctx.beginPath();
        ctx.moveTo(a.x, a.y);
        ctx.lineTo(b.x, b.y);
        ctx.stroke();
      }
    }

    // 粒子本体 + 与鼠标的高亮连线
    for (const p of particles) {
      const mdx = p.x - mouse.x;
      const mdy = p.y - mouse.y;
      const md2 = mdx * mdx + mdy * mdy;
      const near = md2 < MOUSE_DIST * MOUSE_DIST;

      if (near) {
        const md = Math.sqrt(md2) || 1;
        const alpha = (1 - md / MOUSE_DIST) * 0.3;
        ctx.strokeStyle = `rgba(${ACCENT[0]},${ACCENT[1]},${ACCENT[2]},${alpha})`;
        ctx.lineWidth = 0.8;
        ctx.beginPath();
        ctx.moveTo(p.x, p.y);
        ctx.lineTo(mouse.x, mouse.y);
        ctx.stroke();
      }

      ctx.fillStyle = `rgba(${p.c[0]},${p.c[1]},${p.c[2]},${p.a})`;
      ctx.beginPath();
      ctx.arc(p.x, p.y, near ? p.r * 1.5 : p.r, 0, Math.PI * 2);
      ctx.fill();
    }

    raf = requestAnimationFrame(frame);
  }

  // 鼠标位置用 client 坐标即可 —— 画布是 fixed 满屏的，坐标一一对应
  window.addEventListener('pointermove', (e) => {
    mouse.x = e.clientX;
    mouse.y = e.clientY;
  }, { passive: true });

  window.addEventListener('pointerleave', () => {
    mouse.x = -1e4;
    mouse.y = -1e4;
  });

  // 页面切到后台就停掉，省电也省 CPU
  document.addEventListener('visibilitychange', () => {
    if (document.hidden) {
      running = false;
      cancelAnimationFrame(raf);
    } else if (!running) {
      running = true;
      frame();
    }
  });

  let resizeTimer = 0;
  window.addEventListener('resize', () => {
    clearTimeout(resizeTimer);
    resizeTimer = setTimeout(resize, 160);
  });

  resize();
  frame();
}

/* ==========================================================================
   8. 启动
   ========================================================================== */

async function init() {
  let cfg;
  try {
    const res = await fetch('/site.config.json', { cache: 'no-cache' });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    cfg = await res.json();
  } catch (err) {
    // 配置拉不到就明确报错。静默失败会让人以为页面坏了却找不到原因
    const box = document.getElementById('config-error');
    const msg = document.getElementById('config-error-msg');
    if (box && msg) {
      box.hidden = false;
      msg.textContent = `读取 /site.config.json 失败：${err.message}。请确认该文件已随站点一起部署，且 JSON 格式合法。`;
    }
    return;
  }

  renderBindings(cfg);
  renderFeatures(cfg);
  renderScreenshots(cfg);
  renderChangelog(cfg);
  renderFaq(cfg);
  renderStatbar(cfg);

  wireCopyButtons();
  wireLightbox();
  wireReveal();
  startParticles();

  document.documentElement.dataset.ready = 'true';
}

if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', init);
} else {
  init();
}
