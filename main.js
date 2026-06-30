'use strict';

const { Plugin, PluginSettingTab, Setting, moment, Notice, ItemView } = require('obsidian');

const VIEW_TYPE_STREAK_WIDGET = 'property-streak-widget';

// ─── Utilities ────────────────────────────────────────────────────────────────

function generateUUID() {
  return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, c => {
    const r = Math.random() * 16 | 0;
    return (c === 'x' ? r : (r & 0x3 | 0x8)).toString(16);
  });
}

function debounce(fn, ms) {
  let timer = null;
  return function (...args) {
    clearTimeout(timer);
    timer = setTimeout(() => fn.apply(this, args), ms);
  };
}

// Blend hex color toward white by `factor` (0 = original, 1 = white)
function lightenColor(hex, factor) {
  const m = /^#([0-9a-f]{3}|[0-9a-f]{6})$/i.exec(hex);
  if (!m) return hex;
  let h = m[1];
  if (h.length === 3) h = h[0]+h[0]+h[1]+h[1]+h[2]+h[2];
  const r = parseInt(h.slice(0, 2), 16);
  const g = parseInt(h.slice(2, 4), 16);
  const b = parseInt(h.slice(4, 6), 16);
  const toHex = n => Math.round(n + (255 - n) * factor).toString(16).padStart(2, '0');
  return `#${toHex(r)}${toHex(g)}${toHex(b)}`;
}

// ─── Default Settings ─────────────────────────────────────────────────────────

const DEFAULT_SETTINGS = {
  dateFormat: 'YYYY-MM-DD',
  dailyNoteFolder: '',
  streaks: [],
};

function defaultPropertyConfig() {
  return {
    property: '',
    propertyType: 'checkbox',
    incompleteValue: 0,
    incompleteOnEmpty: true,
    incompleteOnContent: '',
  };
}

function defaultStreak() {
  return {
    id: generateUUID(),
    name: 'New Streak',
    type: 'mono',
    operator: 'and',
    color: '',
    showInProperties: true,
    showInWidget: true,
    freezeRegenerationDuration: 7,
    properties: [defaultPropertyConfig()],
  };
}

// ─── Streak Engine ────────────────────────────────────────────────────────────

/**
 * Evaluates whether a single property is complete on a given day.
 * frontmatter may be null (absent note) or an object.
 */
function evaluateProperty(frontmatter, propConfig) {
  if (!frontmatter || !(propConfig.property in frontmatter)) return false;
  const val = frontmatter[propConfig.property];
  switch (propConfig.propertyType) {
    case 'checkbox':
      return val === true;
    case 'number':
      return typeof val === 'number' && val > propConfig.incompleteValue;
    case 'text':
      if (propConfig.incompleteOnEmpty) {
        return typeof val === 'string' && val.trim() !== '';
      } else {
        return typeof val === 'string' && val.trim() !== '' && val !== propConfig.incompleteOnContent;
      }
    case 'list':
      return Array.isArray(val) && val.length > 0;
    default:
      return false;
  }
}

/**
 * Evaluates whether a streak (mono or multi) is complete on a given day.
 */
function evaluateStreakDay(frontmatter, streak) {
  const activeProps = streak.properties.filter(p => p.property && p.property.trim() !== '');
  if (activeProps.length === 0) return false;
  if (activeProps.length === 1) return evaluateProperty(frontmatter, activeProps[0]);
  const op = streak.operator || 'and';
  return op === 'or'
    ? activeProps.some(p => evaluateProperty(frontmatter, p))
    : activeProps.every(p => evaluateProperty(frontmatter, p));
}

/**
 * Returns a map of dateString -> frontmatter for all valid daily notes in the folder.
 * Uses metadataCache so frontmatter is pre-parsed.
 */
function buildDailyNoteMap(app, settings) {
  const map = new Map();
  const folder = settings.dailyNoteFolder
    ? app.vault.getAbstractFileByPath(settings.dailyNoteFolder)
    : app.vault.getRoot();
  if (!folder) return map;

  const files = folder.children
    ? getAllMarkdownFiles(folder)
    : [folder];

  for (const file of files) {
    if (file.extension !== 'md') continue;
    const basename = file.basename;
    const date = moment(basename, settings.dateFormat, true);
    if (!date.isValid()) continue;
    const dateStr = date.format('YYYY-MM-DD');
    const cache = app.metadataCache.getFileCache(file);
    map.set(dateStr, cache && cache.frontmatter ? cache.frontmatter : null);
  }
  return map;
}

function getAllMarkdownFiles(folder) {
  const results = [];
  function recurse(f) {
    if (f.children) {
      for (const child of f.children) recurse(child);
    } else {
      results.push(f);
    }
  }
  recurse(folder);
  return results;
}

/**
 * Forward-simulate streak state from anchor through targetDate (inclusive).
 * Returns an array of day-state objects: { date, complete, length, freezeAvailable, freezeSpent }.
 */
function simulateStreak(streak, noteMap, targetDateStr) {
  if (noteMap.size === 0) {
    return [];
  }

  // Collect all note dates, sort ascending
  const allDates = Array.from(noteMap.keys()).sort();
  if (allDates.length === 0) return [];

  const anchorStr = allDates[0];
  const anchor = moment(anchorStr, 'YYYY-MM-DD', true);
  const target = moment(targetDateStr, 'YYYY-MM-DD', true);

  if (!anchor.isValid() || !target.isValid()) return [];
  if (target.isBefore(anchor)) return [];

  const N = streak.freezeRegenerationDuration;

  let currentLength = 0;
  let freezeAvailable = false;
  let regenCounter = 0; // consecutive complete days since last grant/spend
  const days = [];

  let cursor = anchor.clone();
  while (cursor.isSameOrBefore(target, 'day')) {
    const dateStr = cursor.format('YYYY-MM-DD');
    const frontmatter = noteMap.has(dateStr) ? noteMap.get(dateStr) : null;
    const complete = evaluateStreakDay(frontmatter, streak);
    let freezeSpent = false;

    if (complete) {
      currentLength++;
      regenCounter++;
      // Grant freeze after N consecutive complete days
      if (N > 0 && regenCounter >= N && !freezeAvailable) {
        freezeAvailable = true;
        regenCounter = 0;
      }
    } else {
      if (freezeAvailable) {
        // Spend freeze to bridge this incomplete day
        freezeAvailable = false;
        freezeSpent = true;
        regenCounter = 0;
        // streak continues, length unchanged
      } else {
        // Streak resets
        currentLength = 0;
        regenCounter = 0;
      }
    }

    days.push({
      date: dateStr,
      complete,
      length: currentLength,
      freezeAvailable,
      freezeSpent,
    });

    cursor.add(1, 'day');
  }

  return days;
}

/**
 * Get the streak state for a specific date.
 * Returns { length, complete, freezeSpent, freezeAvailable, previousFreezeSpent, dayStates }
 */
function getStreakStateForDate(streak, noteMap, targetDateStr) {
  const days = simulateStreak(streak, noteMap, targetDateStr);
  if (days.length === 0) {
    return { length: 0, complete: false, freezeSpent: false, freezeAvailable: false, previousFreezeSpent: false, dayStates: [] };
  }
  const last = days[days.length - 1];
  const prev = days.length >= 2 ? days[days.length - 2] : null;
  return {
    length: last.length,
    complete: last.complete,
    freezeSpent: last.freezeSpent,
    freezeAvailable: last.freezeAvailable,
    previousFreezeSpent: prev ? prev.freezeSpent : false,
    dayStates: days,
  };
}

// ─── Message Computation ──────────────────────────────────────────────────────

const MILESTONES = [10, 25, 50, 75, 100];
function nextMilestone(n) {
  for (const m of MILESTONES) {
    if (n < m) return m;
  }
  // every +25 after 100
  return Math.ceil((n + 1) / 25) * 25;
}

function computeMessage(streak, dayStates, targetDateStr, noteMap) {
  if (!dayStates || dayStates.length === 0) return '';
  const idx = dayStates.findIndex(d => d.date === targetDateStr);
  if (idx === -1) return '';
  const day = dayStates[idx];
  const prev = idx > 0 ? dayStates[idx - 1] : null;

  // Old-note states (for days that are not today/future)
  const today = moment().format('YYYY-MM-DD');
  const isToday = targetDateStr === today;
  const isFuture = targetDateStr > today;

  if (!isToday && !isFuture) {
    // Historical display
    if (!day.complete && !day.freezeSpent) {
      if (day.length === 0) return 'You broke this streak';
    }
    if (day.freezeSpent) return 'You spent a streak freeze';
    if (day.length === 1 && (prev === null || prev.length === 0)) return 'You began a new streak';
    if (day.complete) return `Extended to ${day.length}`;
    return '';
  }

  // Today/future: real-time messages by precedence

  // 1. Milestone
  const currentLen = day.length;
  if (day.complete) {
    // Check if we just hit a milestone
    const milestones = getMilestones(currentLen);
    if (milestones.includes(currentLen)) {
      return `Milestone of ${currentLen} achieved!`;
    }
  }
  // Approaching milestone
  const nm = nextMilestone(currentLen);
  if (!day.complete && nm - currentLen === 1) {
    return `Extend your streak to ${nm} today!`;
  }

  // 2. Freeze messages
  if (prev && prev.freezeSpent && !day.complete) {
    return 'Streak Frozen Yesterday!';
  }
  if (prev && prev.freezeSpent && day.complete) {
    return 'Unfroze the streak!';
  }

  // 3. Perfect weeks
  if (currentLen > 0 && currentLen % 7 === 0 && day.complete) {
    const w = currentLen / 7;
    return `${w} perfect week${w > 1 ? 's' : ''} in a row!`;
  }
  if (!day.complete && (currentLen + 1) % 7 === 0) {
    const w = (currentLen + 1) / 7;
    return `Extend today for ${w} perfect week${w > 1 ? 's' : ''} in a row`;
  }

  // 4. Largest effort this week (number or list)
  const prop = streak.type === 'mono' ? streak.properties[0] : null;
  if (prop && (prop.propertyType === 'number' || prop.propertyType === 'list')) {
    const weekMax = computeWeekMax(streak, noteMap, targetDateStr, prop);
    if (weekMax !== null) {
      if (prop.propertyType === 'number') {
        return `${weekMax} is your largest effort this week!`;
      } else {
        return `${weekMax} items is your largest effort this week!`;
      }
    }
  }

  return '';
}

function getMilestones(n) {
  const base = [10, 25, 50, 75, 100];
  const result = [...base];
  let m = 125;
  while (m <= n + 1) {
    result.push(m);
    m += 25;
  }
  return result;
}

function computeWeekMax(streak, noteMap, targetDateStr, prop) {
  const target = moment(targetDateStr, 'YYYY-MM-DD', true);
  // ISO week: Monday to Sunday
  const weekStart = target.clone().startOf('isoWeek');
  const weekEnd = target.clone().endOf('isoWeek');

  let maxVal = null;
  let maxDate = null;

  let cursor = weekStart.clone();
  while (cursor.isSameOrBefore(weekEnd, 'day')) {
    const dateStr = cursor.format('YYYY-MM-DD');
    const fm = noteMap.get(dateStr);
    if (fm && prop.property in fm) {
      const val = fm[prop.property];
      let metric = null;
      if (prop.propertyType === 'number' && typeof val === 'number') {
        metric = val;
      } else if (prop.propertyType === 'list' && Array.isArray(val)) {
        metric = val.length;
      }
      if (metric !== null && (maxVal === null || metric > maxVal)) {
        maxVal = metric;
        maxDate = dateStr;
      }
    }
    cursor.add(1, 'day');
  }

  if (maxDate === targetDateStr && maxVal !== null) {
    return maxVal;
  }
  return null;
}

// ─── Flame State ──────────────────────────────────────────────────────────────

/**
 * Returns one of: 'lit', 'grey', 'frozen', 'abandoned'
 * isToday: whether the displayed day is today (so an incomplete day may still be completable)
 */
function getFlameState(dayState, prevState, isToday) {
  if (!dayState) return 'abandoned';
  if (dayState.complete) return 'lit';
  if (isToday) {
    // Today is never frozen — show grey whenever the streak is still alive coming in
    if ((prevState && prevState.length > 0) || (prevState && prevState.freezeSpent)) return 'grey';
    return 'abandoned';
  }
  // Past day: frozen only when the freeze was actually spent on that specific day
  if (dayState.freezeSpent) return 'frozen';
  return 'abandoned';
}

// ─── SVG Flame Icon ───────────────────────────────────────────────────────────

// Outer path = outer flame silhouette only (first subpath, no inner circle).
// Inner path = inner loop, stacked on top to create the bi-color overlay.
const FLAME_OUTER_PATH = 'M173.793,51.48242a220.94852,220.94852,0,0,0-41.67676-34.34277,8.00334,8.00334,0,0,0-8.23242,0A220.94852,220.94852,0,0,0,82.207,51.48242C54.59473,80.47559,40,112.4668,40,144a88,88,0,0,0,176,0C216,112.4668,201.40527,80.47559,173.793,51.48242Z';
const FLAME_INNER_PATH = 'M128,216a32.03667,32.03667,0,0,1-32-32c0-27.67285,22.52637-47.27734,31.999-54.29688C137.48193,136.72949,160,156.332,160,184A32.03667,32.03667,0,0,1,128,216Z';

function flameSVG() {
  return `<svg viewBox="0 0 256 256" xmlns="http://www.w3.org/2000/svg">
    <path class="streak-flame-outer" d="${FLAME_OUTER_PATH}"/>
    <path class="streak-flame-inner" d="${FLAME_INNER_PATH}"/>
  </svg>`;
}

function applyFlameColors(outerPath, innerPath, flameState, accentColor, textFaint, freezeColor) {
  for (const p of [outerPath, innerPath]) {
    p.style.fill = '';
    p.style.stroke = '';
    p.style.strokeWidth = '';
    p.style.display = '';
    p.removeAttribute('stroke');
  }
  if (flameState === 'lit') {
    outerPath.style.fill = accentColor;
    innerPath.style.fill = lightenColor(accentColor, 0.6);
  } else if (flameState === 'grey') {
    outerPath.style.fill = textFaint;
    innerPath.style.fill = 'none';
  } else if (flameState === 'frozen') {
    outerPath.style.fill = freezeColor;
    innerPath.style.fill = freezeColor;
  } else {
    outerPath.style.fill = 'none';
    outerPath.style.stroke = textFaint;
    outerPath.style.strokeWidth = '6px';
    innerPath.style.display = 'none';
  }
}

// ─── Multi-streak partial flame fill ─────────────────────────────────────────

function getMultiCompletionRatio(streak, noteMap, dateStr) {
  const frontmatter = noteMap.get(dateStr) || null;
  const active = streak.properties.filter(p => p.property && p.property.trim() !== '');
  const done = active.filter(p => evaluateProperty(frontmatter, p)).length;
  return { done, total: active.length };
}

// Injects / updates a bottom-to-top hard-stop linearGradient into the flame SVG.
// accentColor fills the completed fraction; grayColor fills the rest.
// The inner teardrop is hidden for partial states so it doesn't cut across the boundary.
// context: 'i' for inline property widget, 'w' for sidebar widget — keeps IDs
// unique in the document so url(#id) never resolves to the wrong gradient.
function applyPartialFlameGradient(svgEl, pct, accentColor, grayColor, streakId, context = 'i') {
  const NS = 'http://www.w3.org/2000/svg';
  const gradId = `sfg-${context}-${streakId}`;

  let defs = svgEl.querySelector('defs');
  if (!defs) {
    defs = document.createElementNS(NS, 'defs');
    svgEl.prepend(defs);
  }

  let grad = defs.querySelector(`#${gradId}`);
  if (!grad) {
    grad = document.createElementNS(NS, 'linearGradient');
    grad.id = gradId;
    grad.setAttribute('x1', '0');
    grad.setAttribute('y1', '1');
    grad.setAttribute('x2', '0');
    grad.setAttribute('y2', '0');
    grad.setAttribute('gradientUnits', 'objectBoundingBox');
    for (let i = 0; i < 4; i++) {
      grad.appendChild(document.createElementNS(NS, 'stop'));
    }
    defs.appendChild(grad);
  }

  // Hard boundary: two stops at the same offset produce a sharp horizontal slab edge
  const pctStr = `${(pct * 100).toFixed(2)}%`;
  const stops = grad.querySelectorAll('stop');
  stops[0].setAttribute('offset', '0%');     stops[0].setAttribute('stop-color', accentColor);
  stops[1].setAttribute('offset', pctStr);   stops[1].setAttribute('stop-color', accentColor);
  stops[2].setAttribute('offset', pctStr);   stops[2].setAttribute('stop-color', grayColor);
  stops[3].setAttribute('offset', '100%');   stops[3].setAttribute('stop-color', grayColor);

  const outerPath = svgEl.querySelector('.streak-flame-outer');
  const innerPath = svgEl.querySelector('.streak-flame-inner');
  if (outerPath) {
    outerPath.style.fill = `url(#${gradId})`;
    outerPath.style.stroke = '';
    outerPath.style.strokeWidth = '';
  }
  // Hide inner teardrop — it would bisect the gradient boundary
  if (innerPath) innerPath.style.display = 'none';
}

// ─── Plugin ───────────────────────────────────────────────────────────────────

class PropertyStreakPlugin extends Plugin {
  async onload() {
    await this.loadSettings();

    this.registerView(VIEW_TYPE_STREAK_WIDGET, (leaf) => new StreakWidgetView(leaf, this));

    this.addCommand({
      id: 'open-streak-widget',
      name: 'Open streak widget',
      callback: () => this.activateStreakWidget(),
    });

    this.addSettingTab(new PropertyStreakSettingTab(this.app, this));

    // Cache: map of streakId -> cached state
    this._cache = {};

    // Active observers: map of leaf id -> { observer, container }
    this._observers = new Map();

    // Load persisted cache
    const data = await this.loadData();
    if (data && data.cache) {
      this._cache = data.cache;
    }

    // Re-inject on file open
    this.registerEvent(
      this.app.workspace.on('file-open', () => {
        setTimeout(() => this._injectAll(), 100);
      })
    );

    // Re-inject on layout change
    this.registerEvent(
      this.app.workspace.on('layout-change', () => {
        setTimeout(() => this._injectAll(), 100);
      })
    );

    // Recompute on metadata change for daily notes
    this._debouncedRecompute = debounce((file) => {
      const folder = this.settings.dailyNoteFolder;
      const filePath = file.path;
      const inFolder = folder
        ? filePath.startsWith(folder + '/') || filePath.startsWith(folder)
        : true;
      if (inFolder) {
        this._invalidateCache();
        this._injectAll();
      }
    }, 500);

    this.registerEvent(
      this.app.metadataCache.on('changed', (file) => {
        this._debouncedRecompute(file);
      })
    );

    // Initial injection after workspace is ready
    this.app.workspace.onLayoutReady(() => {
      setTimeout(() => this._injectAll(), 200);
    });
  }

  onunload() {
    this._removeAllObservers();
  }

  async activateStreakWidget() {
    const existing = this.app.workspace.getLeavesOfType(VIEW_TYPE_STREAK_WIDGET);
    if (existing.length) {
      this.app.workspace.revealLeaf(existing[0]);
      return;
    }
    const leaf = this.app.workspace.getRightLeaf(false);
    await leaf.setViewState({ type: VIEW_TYPE_STREAK_WIDGET, active: true });
    this.app.workspace.revealLeaf(leaf);
  }

  async loadSettings() {
    const data = await this.loadData();
    const saved = data && data.settings ? data.settings : {};
    this.settings = {
      dateFormat: saved.dateFormat !== undefined ? saved.dateFormat : DEFAULT_SETTINGS.dateFormat,
      dailyNoteFolder: saved.dailyNoteFolder !== undefined ? saved.dailyNoteFolder : DEFAULT_SETTINGS.dailyNoteFolder,
      streaks: Array.isArray(saved.streaks) ? saved.streaks : [],
    };
  }

  async saveSettings() {
    const data = (await this.loadData()) || {};
    data.settings = this.settings;
    await this.saveData(data);
  }

  async _saveCache() {
    const data = (await this.loadData()) || {};
    data.cache = this._cache;
    await this.saveData(data);
  }

  _invalidateCache() {
    this._cache = {};
  }

  // ── DOM Injection ──────────────────────────────────────────────────────────

  _injectAll() {
    this.app.workspace.iterateAllLeaves(leaf => {
      if (leaf.view && leaf.view.getViewType() === 'markdown') {
        this._injectLeaf(leaf);
      }
    });
  }

  _injectLeaf(leaf) {
    const view = leaf.view;
    if (!view) return;

    // Find .metadata-properties container
    const container = view.containerEl.querySelector('.metadata-properties');
    if (!container) return;

    const file = view.file;
    if (!file) return;

    // Determine the date this note represents
    const date = moment(file.basename, this.settings.dateFormat, true);
    const targetDateStr = date.isValid() ? date.format('YYYY-MM-DD') : moment().format('YYYY-MM-DD');

    // Detach old observer if container changed
    const leafId = leaf.id || leaf.containerEl.dataset.streakLeafId || (leaf.containerEl.dataset.streakLeafId = generateUUID());
    const existing = this._observers.get(leafId);
    if (existing && existing.container !== container) {
      existing.observer.disconnect();
      this._observers.delete(leafId);
    }

    // Attach observer if not already watching this container
    if (!this._observers.has(leafId)) {
      const observer = new MutationObserver(debounce(() => {
        // Re-derive file and date at callback time — leaf may have changed file
        const currentFile = leaf.view && leaf.view.file;
        if (!currentFile) return;
        const currentDate = moment(currentFile.basename, this.settings.dateFormat, true);
        const currentDateStr = currentDate.isValid() ? currentDate.format('YYYY-MM-DD') : moment().format('YYYY-MM-DD');
        const currentContainer = leaf.view.containerEl.querySelector('.metadata-properties');
        if (!currentContainer) return;
        this._renderWidgets(currentContainer, currentFile, currentDateStr);
      }, 50));
      observer.observe(container, { childList: true, subtree: true });
      this._observers.set(leafId, { observer, container });
    }

    this._renderWidgets(container, file, targetDateStr);
  }

  _removeAllObservers() {
    for (const { observer } of this._observers.values()) {
      observer.disconnect();
    }
    this._observers.clear();
  }

  _renderWidgets(container, file, targetDateStr) {
    const noteMap = buildDailyNoteMap(this.app, this.settings);
    const rows = container.querySelectorAll('.metadata-property');

    for (const row of rows) {
      // Skip our own injected widget nodes (they're inside rows, not rows themselves,
      // but guard in case Obsidian ever nests them differently)
      if (row.dataset.streakWidget) continue;

      const keyEl = row.querySelector('.metadata-property-key');
      if (!keyEl) continue;
      // Obsidian renders the key as an <input> inside .metadata-property-key;
      // textContent on the container is always empty, so read .value instead.
      const keyInput = keyEl.querySelector('input');
      const keyText = keyInput ? keyInput.value.trim() : keyEl.textContent.trim();
      if (!keyText) continue;

      // Find matching streaks
      const matchingStreaks = this.settings.streaks.filter(streak => {
        if (!streak.showInProperties) return false;
        return streak.properties.some(p => p.property && p.property === keyText);
      });

      for (const streak of matchingStreaks) {
        this._upsertWidget(row, streak, noteMap, targetDateStr);
      }
    }
  }

  _upsertWidget(row, streak, noteMap, targetDateStr) {
    const widgetId = `streak-widget-${streak.id}`;
    let widget = row.querySelector(`[data-streak-id="${streak.id}"]`);

    if (!widget) {
      widget = document.createElement('div');
      widget.className = 'streak-widget';
      widget.dataset.streakId = streak.id;
      widget.dataset.streakWidget = '1';
      row.appendChild(widget);
    }

    this._updateWidgetContent(widget, streak, noteMap, targetDateStr);
  }

  _updateWidgetContent(widget, streak, noteMap, targetDateStr) {
    const state = getStreakStateForDate(streak, noteMap, targetDateStr);
    const { dayStates } = state;

    const today = moment().format('YYYY-MM-DD');
    const isToday = targetDateStr === today;

    const idx = dayStates.findIndex(d => d.date === targetDateStr);
    const dayState = idx >= 0 ? dayStates[idx] : null;
    const prevState = idx > 0 ? dayStates[idx - 1] : null;

    const flameState = getFlameState(dayState, prevState, isToday);
    const message = computeMessage(streak, dayStates, targetDateStr, noteMap);

    // For grey/frozen today (streak alive but not yet complete), show the running-in length
    const displayLength = (isToday && (flameState === 'grey' || flameState === 'frozen'))
      ? (prevState ? prevState.length : 0)
      : (dayState ? dayState.length : 0);

    // Resolve actual color values from computed styles so SVG attributes can be
    // stamped directly — CSS variable inheritance through SVG is unreliable.
    const cs = getComputedStyle(widget);
    const accentColor = streak.color || cs.getPropertyValue('--interactive-accent').trim() || '#7c3aed';
    const textFaint   = cs.getPropertyValue('--text-faint').trim() || '#888888';
    const freezeColor = cs.getPropertyValue('--streak-freeze-color').trim() ||
                        (document.body.classList.contains('theme-light') ? '#2c5f8a' : '#6ab0d4');

    // Flame
    let flameEl = widget.querySelector('.streak-flame');
    if (!flameEl) {
      flameEl = document.createElement('span');
      widget.appendChild(flameEl);
    }
    if (!flameEl.querySelector('.streak-flame-outer')) {
      flameEl.innerHTML = flameSVG();
    }
    flameEl.className = `streak-flame streak-flame--${flameState}`;

    const outerPath = flameEl.querySelector('.streak-flame-outer');
    const innerPath = flameEl.querySelector('.streak-flame-inner');
    if (outerPath && innerPath) {
      applyFlameColors(outerPath, innerPath, flameState, accentColor, textFaint, freezeColor);
    }

    // Multi-streak partial fill: gradient slab from bottom for today only.
    // Runs after applyFlameColors so lit/grey/frozen states are preserved when
    // done === 0 or done === total — only the intermediate case gets the gradient.
    if (streak.type === 'multi' && isToday && outerPath) {
      const { done, total } = getMultiCompletionRatio(streak, noteMap, targetDateStr);
      if (total > 0 && done > 0 && done < total) {
        const svgEl = flameEl.querySelector('svg');
        if (svgEl) applyPartialFlameGradient(svgEl, done / total, accentColor, textFaint, streak.id);
      }
    }

    // Count
    let countEl = widget.querySelector('.streak-count');
    if (!countEl) {
      countEl = document.createElement('span');
      countEl.className = 'streak-count';
      widget.appendChild(countEl);
    }
    countEl.textContent = String(displayLength);

    // Message
    let msgEl = widget.querySelector('.streak-message');
    if (!msgEl) {
      msgEl = document.createElement('span');
      msgEl.className = 'streak-message';
      widget.appendChild(msgEl);
    }
    const isMobile = this.app.isMobile;
    msgEl.textContent = isMobile ? '' : message;
    msgEl.style.display = (message && !isMobile) ? '' : 'none';
  }
}

// ─── Streak Widget View ───────────────────────────────────────────────────────

class StreakWidgetView extends ItemView {
  constructor(leaf, plugin) {
    super(leaf);
    this.plugin = plugin;
  }

  getViewType() { return VIEW_TYPE_STREAK_WIDGET; }
  getDisplayText() { return 'Streaks'; }
  getIcon() { return 'flame'; }

  async onOpen() {
    this._container = this.contentEl.createDiv('streak-widget-view');
    this.refresh();

    this._debouncedRefresh = debounce(() => this.refresh(), 500);

    this.registerEvent(
      this.app.metadataCache.on('changed', () => this._debouncedRefresh())
    );
    this.registerEvent(
      this.app.workspace.on('file-open', () => this.refresh())
    );
    this.registerEvent(
      this.app.workspace.on('active-leaf-change', () => this.refresh())
    );
  }

  async onClose() {}

  refresh() {
    const container = this._container;
    if (!container) return;
    container.empty();

    const noteMap = buildDailyNoteMap(this.app, this.plugin.settings);
    const targetDateStr = moment().format('YYYY-MM-DD');
    const visibleStreaks = this.plugin.settings.streaks.filter(s => s.showInWidget !== false);

    if (visibleStreaks.length === 0) {
      container.createEl('p', { text: 'No streaks set to display in widget.', cls: 'streak-widget-empty' });
      return;
    }

    const cs = getComputedStyle(container);
    const textFaint = cs.getPropertyValue('--text-faint').trim() || '#888888';
    const freezeColor = cs.getPropertyValue('--streak-freeze-color').trim() ||
                        (document.body.classList.contains('theme-light') ? '#2c5f8a' : '#6ab0d4');

    for (const streak of visibleStreaks) {
      const state = getStreakStateForDate(streak, noteMap, targetDateStr);
      const { dayStates } = state;
      const idx = dayStates.findIndex(d => d.date === targetDateStr);
      const dayState = idx >= 0 ? dayStates[idx] : null;
      const prevState = idx > 0 ? dayStates[idx - 1] : null;
      const isToday = true;

      const flameState = getFlameState(dayState, prevState, isToday);
      const displayLength = (flameState === 'grey' || flameState === 'frozen')
        ? (prevState ? prevState.length : 0)
        : (dayState ? dayState.length : 0);

      const accentColor = streak.color || cs.getPropertyValue('--interactive-accent').trim() || '#7c3aed';

      const rowEl = container.createDiv('streak-widget-row');

      const nameEl = rowEl.createEl('span', { cls: 'streak-widget-name', text: streak.name });

      const flameEl = rowEl.createEl('span', { cls: `streak-flame streak-flame--${flameState}` });
      flameEl.innerHTML = flameSVG();
      const outerPath = flameEl.querySelector('.streak-flame-outer');
      const innerPath = flameEl.querySelector('.streak-flame-inner');
      if (outerPath && innerPath) {
        applyFlameColors(outerPath, innerPath, flameState, accentColor, textFaint, freezeColor);
      }

      if (streak.type === 'multi' && outerPath) {
        const { done, total } = getMultiCompletionRatio(streak, noteMap, targetDateStr);
        if (total > 0 && done > 0 && done < total) {
          const svgEl = flameEl.querySelector('svg');
          if (svgEl) applyPartialFlameGradient(svgEl, done / total, accentColor, textFaint, streak.id, 'w');
        }
      }

      rowEl.createEl('span', { cls: 'streak-widget-count', text: String(displayLength) });
    }
  }
}

// ─── Settings Tab ─────────────────────────────────────────────────────────────

class PropertyStreakSettingTab extends PluginSettingTab {
  constructor(app, plugin) {
    super(app, plugin);
    this.plugin = plugin;
  }

  display() {
    const { containerEl } = this;
    containerEl.empty();

    containerEl.createEl('h2', { text: 'Property Streak' });

    // Global settings
    new Setting(containerEl)
      .setName('Daily Note Date Format')
      .setDesc('moment.js format string used to identify daily notes by filename.')
      .addText(text => text
        .setPlaceholder('YYYY-MM-DD')
        .setValue(this.plugin.settings.dateFormat)
        .onChange(async val => {
          this.plugin.settings.dateFormat = val || 'YYYY-MM-DD';
          await this.plugin.saveSettings();
        })
      );

    new Setting(containerEl)
      .setName('Daily Note Folder')
      .setDesc('Folder path to scan for daily notes. Leave empty to scan the entire vault.')
      .addText(text => text
        .setPlaceholder('Daily Notes')
        .setValue(this.plugin.settings.dailyNoteFolder)
        .onChange(async val => {
          this.plugin.settings.dailyNoteFolder = val;
          await this.plugin.saveSettings();
        })
      );

    containerEl.createEl('h3', { text: 'Streaks' });

    // Streak list
    const streakListEl = containerEl.createDiv('streak-settings-list');
    this._renderStreakList(streakListEl);

    // Add new streak button
    new Setting(containerEl)
      .addButton(btn => btn
        .setButtonText('Add new streak')
        .setCta()
        .onClick(async () => {
          this.plugin.settings.streaks.push(defaultStreak());
          await this.plugin.saveSettings();
          this._renderStreakList(streakListEl);
        })
      );
  }

  _renderStreakList(container) {
    container.empty();
    for (let i = 0; i < this.plugin.settings.streaks.length; i++) {
      this._renderStreakRow(container, i);
    }
  }

  _renderStreakRow(container, index) {
    const streak = this.plugin.settings.streaks[index];
    const rowEl = container.createDiv('streak-settings-row');
    rowEl.style.border = '1px solid var(--background-modifier-border)';
    rowEl.style.borderRadius = '6px';
    rowEl.style.padding = '12px';
    rowEl.style.marginBottom = '12px';

    // Header row with name and remove button
    const headerEl = rowEl.createDiv();
    headerEl.style.display = 'flex';
    headerEl.style.justifyContent = 'space-between';
    headerEl.style.alignItems = 'center';
    headerEl.style.marginBottom = '8px';

    const nameInput = headerEl.createEl('input', { type: 'text' });
    nameInput.value = streak.name;
    nameInput.placeholder = 'Streak name';
    nameInput.style.flex = '1';
    nameInput.style.marginRight = '8px';
    nameInput.addEventListener('change', async () => {
      streak.name = nameInput.value;
      await this.plugin.saveSettings();
    });

    const removeBtn = headerEl.createEl('button', { text: '✕' });
    removeBtn.addEventListener('click', async () => {
      this.plugin.settings.streaks.splice(index, 1);
      await this.plugin.saveSettings();
      const listEl = container.parentElement;
      this._renderStreakList(listEl.querySelector('.streak-settings-list') || listEl);
    });

    // Type
    new Setting(rowEl)
      .setName('Type')
      .addDropdown(dd => dd
        .addOption('mono', 'Mono')
        .addOption('multi', 'Multi')
        .setValue(streak.type)
        .onChange(async val => {
          streak.type = val;
          if (val === 'multi' && streak.properties.length < 2) {
            while (streak.properties.length < 2) streak.properties.push(defaultPropertyConfig());
          }
          await this.plugin.saveSettings();
          this._renderStreakList(container.parentElement.querySelector('.streak-settings-list') || container);
        })
      );

    // Color
    new Setting(rowEl)
      .setName('Flame Color')
      .setDesc('Accent color for the lit flame. Leave empty to use vault accent.')
      .addColorPicker(cp => cp
        .setValue(streak.color || '#7c3aed')
        .onChange(async val => {
          streak.color = val;
          await this.plugin.saveSettings();
        })
      );

    // Show in Properties
    new Setting(rowEl)
      .setName('Show in Properties')
      .addToggle(toggle => toggle
        .setValue(streak.showInProperties)
        .onChange(async val => {
          streak.showInProperties = val;
          await this.plugin.saveSettings();
        })
      );

    // Display in widget
    new Setting(rowEl)
      .setName('Display in widget')
      .setDesc("Re-run the 'Open streak widget' command for changes to take place.")
      .addToggle(toggle => toggle
        .setValue(streak.showInWidget !== false)
        .onChange(async val => {
          streak.showInWidget = val;
          await this.plugin.saveSettings();
        })
      );

    // Freeze regeneration duration
    new Setting(rowEl)
      .setName('Streak Freeze Regeneration Duration')
      .setDesc('Number of consecutive complete days needed to earn a freeze. 0 disables freezes.')
      .addText(text => text
        .setValue(String(streak.freezeRegenerationDuration))
        .onChange(async val => {
          const n = parseInt(val, 10);
          streak.freezeRegenerationDuration = isNaN(n) ? 7 : Math.max(0, n);
          await this.plugin.saveSettings();
        })
      );

    // Property blocks
    if (streak.type === 'mono') {
      rowEl.createEl('h4', { text: 'Property' });
      this._renderPropertyConfig(rowEl, streak, 0, false);
    } else {
      const op = streak.operator || 'and';
      rowEl.createEl('h4', { text: `Properties (${op.toUpperCase()})` });

      new Setting(rowEl)
        .setName('Operator')
        .setDesc('How properties are combined: ALL must be complete (AND) or ANY is enough (OR).')
        .addDropdown(dd => dd
          .addOption('and', 'AND — all must be complete')
          .addOption('or', 'OR — any one is enough')
          .setValue(op)
          .onChange(async val => {
            streak.operator = val;
            await this.plugin.saveSettings();
            this._renderStreakList(container.parentElement.querySelector('.streak-settings-list') || container);
          })
        );

      for (let pi = 0; pi < streak.properties.length; pi++) {
        const propBlock = rowEl.createDiv();
        propBlock.style.borderLeft = '2px solid var(--background-modifier-border)';
        propBlock.style.paddingLeft = '12px';
        propBlock.style.marginBottom = '8px';
        this._renderPropertyConfig(propBlock, streak, pi, streak.properties.length > 2);
      }
      const addPropBtn = rowEl.createEl('button', { text: '+ Add property' });
      addPropBtn.addEventListener('click', async () => {
        streak.properties.push(defaultPropertyConfig());
        await this.plugin.saveSettings();
        this._renderStreakList(container.parentElement.querySelector('.streak-settings-list') || container);
      });
    }
  }

  _renderPropertyConfig(container, streak, propIndex, canRemove) {
    const prop = streak.properties[propIndex];

    if (canRemove) {
      const removeRow = new Setting(container)
        .setName(`Property ${propIndex + 1}`)
        .addButton(btn => btn
          .setButtonText('Remove')
          .onClick(async () => {
            if (streak.properties.length > 2) {
              streak.properties.splice(propIndex, 1);
              await this.plugin.saveSettings();
              this.display();
            } else {
              new Notice('Multi streaks require at least 2 properties.');
            }
          })
        );
    }

    new Setting(container)
      .setName('Property Key')
      .setDesc('The frontmatter key to track, e.g. "done" or "daily/exercise".')
      .addText(text => text
        .setPlaceholder('property-key')
        .setValue(prop.property)
        .onChange(async val => {
          prop.property = val;
          await this.plugin.saveSettings();
        })
      );

    new Setting(container)
      .setName('Property Type')
      .addDropdown(dd => dd
        .addOption('checkbox', 'Checkbox')
        .addOption('number', 'Number')
        .addOption('text', 'Text')
        .addOption('list', 'List')
        .setValue(prop.propertyType)
        .onChange(async val => {
          prop.propertyType = val;
          await this.plugin.saveSettings();
          this.display();
        })
      );

    if (prop.propertyType === 'number') {
      new Setting(container)
        .setName('Incomplete Value')
        .setDesc('The property is complete when its value is greater than this number.')
        .addText(text => text
          .setValue(String(prop.incompleteValue))
          .onChange(async val => {
            const n = parseFloat(val);
            prop.incompleteValue = isNaN(n) ? 0 : n;
            await this.plugin.saveSettings();
          })
        );
    }

    if (prop.propertyType === 'text') {
      new Setting(container)
        .setName('Incomplete on Empty')
        .setDesc('Mark as incomplete when the text value is empty.')
        .addToggle(toggle => toggle
          .setValue(prop.incompleteOnEmpty)
          .onChange(async val => {
            prop.incompleteOnEmpty = val;
            await this.plugin.saveSettings();
            this.display();
          })
        );
      if (!prop.incompleteOnEmpty) {
        new Setting(container)
          .setName('Incomplete on Content')
          .setDesc('Mark as incomplete when the text equals this string.')
          .addText(text => text
            .setValue(prop.incompleteOnContent)
            .onChange(async val => {
              prop.incompleteOnContent = val;
              await this.plugin.saveSettings();
            })
          );
      }
    }
  }
}

module.exports = PropertyStreakPlugin;
