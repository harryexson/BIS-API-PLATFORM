// DEPLOY STEP: point this at wherever the developer portal is actually served.
const PORTAL_URL = '/portal';
document.querySelectorAll('[data-portal-link]').forEach((el) => {
  el.setAttribute('href', PORTAL_URL + el.dataset.portalLink);
});

document.getElementById('year').textContent = String(new Date().getFullYear());

// ---------- Nav ----------
const navToggle = document.querySelector('.nav-toggle');
const navLinks = document.getElementById('nav-links');
navToggle.addEventListener('click', () => {
  const open = navLinks.classList.toggle('is-open');
  navToggle.setAttribute('aria-expanded', String(open));
});
navLinks.querySelectorAll('a').forEach((a) =>
  a.addEventListener('click', () => {
    navLinks.classList.remove('is-open');
    navToggle.setAttribute('aria-expanded', 'false');
  }),
);

// ---------- Entrance choreography ----------
const prefersReduced = matchMedia('(prefers-reduced-motion: reduce)').matches;

const revealGroups = document.querySelectorAll('section, .relay-section');
const revealIO = new IntersectionObserver(
  (entries) => {
    entries.forEach((entry) => {
      if (!entry.isIntersecting) return;
      const children = entry.target.querySelectorAll(':scope > .reveal, :scope .reveal[data-stagger]');
      const seen = new Set();
      let i = 0;
      children.forEach((el) => {
        if (seen.has(el)) return;
        seen.add(el);
        el.style.setProperty('--stagger-delay', `${Math.min(i, 5) * 90}ms`);
        i++;
      });
      requestAnimationFrame(() => children.forEach((el) => el.classList.add('in')));
      revealIO.unobserve(entry.target);
    });
  },
  { threshold: 0.15 },
);
revealGroups.forEach((g) => revealIO.observe(g));

// ---------- The relay diagram (the product's core idea, made interactive) ----------
const stage = document.getElementById('relay-stage');
const pulse = document.getElementById('relay-pulse');
const statusEl = document.getElementById('relay-status');
const DEFAULT_STATUS = statusEl.textContent;

const NODES = Array.from(document.querySelectorAll('.relay-node')).map((btn) => {
  const i = Number(btn.dataset.index);
  return {
    el: btn,
    line: document.querySelector(`.relay-line[data-i="${i}"]`),
    name: btn.dataset.name,
    healthy: true,
  };
});

const PRIORITY = [0, 2, 3, 4, 8, 1, 5, 6, 7, 9, 12, 10, 11, 13];
let cursor = 0;

function setStatus(text) {
  statusEl.textContent = text;
}

function toggleNode(i) {
  const node = NODES[i];
  node.healthy = !node.healthy;
  node.el.classList.toggle('is-down', !node.healthy);
  node.el.setAttribute('aria-pressed', String(!node.healthy));
  node.line.classList.toggle('is-down', !node.healthy);
  setStatus(
    node.healthy
      ? `${node.name} is back online.`
      : `${node.name} is offline for this demo. Send a test event to see BIS route around it.`,
  );
}

NODES.forEach((n, i) => n.el.addEventListener('click', () => toggleNode(i)));

function routeTo(i) {
  const line = NODES[i].line;
  const x = Number(line.getAttribute('x2'));
  const y = Number(line.getAttribute('y2'));
  pulse.style.transform = `translate(${x - 200}px, ${y - 200}px)`;
  pulse.classList.add('is-live');
  line.classList.add('is-active');
  NODES[i].el.classList.add('is-routed');
  setTimeout(
    () => {
      pulse.classList.remove('is-live');
      line.classList.remove('is-active');
      NODES[i].el.classList.remove('is-routed');
    },
    prefersReduced ? 0 : 900,
  );
}

function sendTestEvent() {
  const skipped = [];
  for (let attempt = 0; attempt < PRIORITY.length; attempt++) {
    const idx = PRIORITY[(cursor + attempt) % PRIORITY.length];
    if (NODES[idx].healthy) {
      cursor = (cursor + attempt + 1) % PRIORITY.length;
      routeTo(idx);
      setStatus(
        skipped.length
          ? `${skipped.join(', ')} offline. Rerouted to ${NODES[idx].name}.`
          : `Routed to ${NODES[idx].name}.`,
      );
      return;
    }
    skipped.push(NODES[idx].name);
  }
  setStatus('Every rail is offline in this demo. Reset to try again.');
}

document.getElementById('relay-send').addEventListener('click', sendTestEvent);
document.getElementById('relay-reset').addEventListener('click', () => {
  NODES.forEach((n, i) => {
    if (!n.healthy) toggleNode(i);
  });
  cursor = 0;
  setStatus(DEFAULT_STATUS);
});

// Self-drawing connector lines, staggered, once the diagram scrolls into view.
const relayLines = Array.from(document.querySelectorAll('.relay-line'));
relayLines.forEach((line) => {
  const len = line.getTotalLength();
  line.style.strokeDasharray = String(len);
  line.style.strokeDashoffset = prefersReduced ? '0' : String(len);
  line.style.setProperty('--line-delay', `${Number(line.dataset.i) * 40}ms`);
});

const stageIO = new IntersectionObserver(
  (entries) => {
    entries.forEach((entry) => {
      if (!entry.isIntersecting) return;
      relayLines.forEach((line) => {
        line.style.strokeDashoffset = '0';
      });
      if (!prefersReduced) {
        setTimeout(sendTestEvent, 1300);
      }
      stageIO.unobserve(entry.target);
    });
  },
  { threshold: 0.25 },
);
if (stage) stageIO.observe(stage);

// Reduced motion can flip on mid-session; make sure the diagram still ends up legible.
matchMedia('(prefers-reduced-motion: reduce)').addEventListener('change', (e) => {
  if (e.matches) {
    relayLines.forEach((line) => {
      line.style.strokeDashoffset = '0';
    });
  }
});
