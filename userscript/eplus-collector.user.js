// ==UserScript==
// @name         Eplus 会员信息采集器
// @namespace    eplus-assistant
// @version      1.3.0
// @description  在 eplus.jp / member.eplus.jp / orderhistory.eplus.jp 上引导采集会员资料、抽选记录，展示当前 IP/来源地，一键导出统一 JSON，并支持登录页一键填写
// @author       yuuuiv
// @license      MIT
// @match        https://eplus.jp/*
// @match        https://member.eplus.jp/*
// @match        https://orderhistory.eplus.jp/*
// @grant        GM_setValue
// @grant        GM_getValue
// @grant        GM_addStyle
// @grant        GM_xmlhttpRequest
// @connect      ip-api.com
// @connect      ipwho.is
// @run-at       document-idle
// ==/UserScript==

(function () {
  'use strict';

  // ---------------------------------------------------------------------
  // Icons - inline SVG (Lucide path data), never emoji. Mirrors the icon
  // style already used in the desktop account manager (lucide-react) so
  // both surfaces read as one design system.
  // ---------------------------------------------------------------------

  const ICONS = {
    sun: '<circle cx="12" cy="12" r="4"/><path d="M12 2v2"/><path d="M12 20v2"/><path d="m4.93 4.93 1.41 1.41"/><path d="m17.66 17.66 1.41 1.41"/><path d="M2 12h2"/><path d="M20 12h2"/><path d="m6.34 17.66-1.41 1.41"/><path d="m19.07 4.93-1.41 1.41"/>',
    moon: '<path d="M20.985 12.486a9 9 0 1 1-9.473-9.472c.405-.022.617.46.402.803a6 6 0 0 0 8.268 8.268c.344-.215.825-.004.803.401"/>',
    monitor: '<rect width="20" height="14" x="2" y="3" rx="2"/><line x1="8" x2="16" y1="21" y2="21"/><line x1="12" x2="12" y1="17" y2="21"/>',
    chevronDown: '<path d="m6 9 6 6 6-6"/>',
    keyRound: '<path d="M2.586 17.414A2 2 0 0 0 2 18.828V21a1 1 0 0 0 1 1h3a1 1 0 0 0 1-1v-1a1 1 0 0 1 1-1h1a1 1 0 0 0 1-1v-1a1 1 0 0 1 1-1h.172a2 2 0 0 0 1.414-.586l.814-.814a6.5 6.5 0 1 0-4-4z"/><circle cx="16.5" cy="7.5" r=".5" fill="currentColor"/>',
    download: '<path d="M12 15V3"/><path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/><path d="m7 10 5 5 5-5"/>',
    x: '<path d="M18 6 6 18"/><path d="m6 6 12 12"/>',
    check: '<path d="M20 6 9 17l-5-5"/>',
  };

  function icon(name, size) {
    size = size || 16;
    return (
      '<svg class="ec-icon" width="' + size + '" height="' + size + '" viewBox="0 0 24 24" fill="none" ' +
      'stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">' +
      (ICONS[name] || '') +
      '</svg>'
    );
  }

  // ---------------------------------------------------------------------
  // Storage keys & schema
  // ---------------------------------------------------------------------

  const STORAGE_KEYS = {
    credentials: 'eplus_collector_credentials_v1',
    // A single fixed bucket - NOT keyed by email. Keying by email meant that typing/changing the
    // email field after already visiting some pages made previously-collected data appear to
    // vanish (it was sitting under a different storage key). The current email is still recorded
    // on the harvest object itself for the export payload/filename.
    harvest: 'eplus_collector_harvest_v2',
    collapsed: 'eplus_collector_collapsed_v1',
    theme: 'eplus_collector_theme_v1',
  };

  function emptyHarvest() {
    return {
      eplusEmail: '',
      profile: {},
      creditCards: [],
      companions: [],
      lotteryRecords: [],
      harvestedPages: {},
    };
  }

  function sanitizeKey(email) {
    return (email || '').trim().toLowerCase().replace(/[^a-z0-9@._-]/g, '_') || '_pending';
  }

  function getCredentials() {
    const raw = GM_getValue(STORAGE_KEYS.credentials, '');
    if (!raw) return { email: '', password: '', remember: true };
    try {
      const parsed = JSON.parse(raw);
      return {
        email: parsed.email || '',
        password: parsed.remember ? parsed.password || '' : '',
        remember: parsed.remember !== false,
      };
    } catch (e) {
      return { email: '', password: '', remember: true };
    }
  }

  function saveCredentials(next) {
    const toStore = {
      email: next.email || '',
      password: next.remember ? next.password || '' : '',
      remember: next.remember !== false,
    };
    GM_setValue(STORAGE_KEYS.credentials, JSON.stringify(toStore));
  }

  function loadHarvest() {
    const raw = GM_getValue(STORAGE_KEYS.harvest, '');
    if (!raw) return emptyHarvest();
    try {
      const parsed = JSON.parse(raw);
      return Object.assign(emptyHarvest(), parsed);
    } catch (e) {
      return emptyHarvest();
    }
  }

  function saveHarvest(harvest) {
    GM_setValue(STORAGE_KEYS.harvest, JSON.stringify(harvest));
  }

  // ---------------------------------------------------------------------
  // Session boundary - one browser window (including a private/incognito
  // window) is meant to collect exactly one account. GM_setValue is a single
  // bucket shared by every window/tab the script runs in - normal or
  // incognito alike - so without this, opening a fresh incognito window to
  // start a new account still shows the previous account's "已采集" state.
  //
  // window.name is one of the few things that survives cross-origin
  // navigation within the same tab (this script spans eplus.jp,
  // member.eplus.jp, orderhistory.eplus.jp) yet is always empty on a brand
  // new tab/window. So: empty window.name => first load in this tab => wipe
  // the harvest bucket and stamp a session marker; non-empty and already
  // ours => same tab continuing across pages => leave the harvest alone.
  // ---------------------------------------------------------------------

  var SESSION_NAME_PREFIX = 'eplus-collector-session:';

  function ensureFreshSession() {
    if (typeof window.name === 'string' && window.name.indexOf(SESSION_NAME_PREFIX) === 0) return;
    saveHarvest(emptyHarvest());
    window.name = SESSION_NAME_PREFIX + Date.now() + '-' + Math.random().toString(36).slice(2);
  }

  function mergeById(existing, incoming, idField) {
    const byId = new Map(existing.map((item) => [item[idField], item]));
    incoming.forEach((item) => {
      if (item[idField]) byId.set(item[idField], item);
    });
    return Array.from(byId.values());
  }

  // ---------------------------------------------------------------------
  // Page routing & extractors
  //
  // Every extractor below always returns a result object once called (never null) - the caller
  // only invokes them after the URL has already matched a known page, so "found zero items" (no
  // companions registered, no cards on file, ...) is itself a valid, collectible answer and must
  // still mark that page as harvested. Returning null here previously left pages stuck at
  // "未采集" forever whenever the real answer was "nothing here".
  // ---------------------------------------------------------------------

  function splitByBr(container) {
    const groups = [[]];
    container.childNodes.forEach((node) => {
      if (node.nodeType === Node.ELEMENT_NODE && node.tagName === 'BR') {
        groups.push([]);
      } else if (node.nodeType === Node.ELEMENT_NODE && node.tagName === 'SPAN') {
        const text = node.textContent.trim();
        if (text) groups[groups.length - 1].push(text);
      }
    });
    return groups.map((g) => g.join(' ').trim()).filter(Boolean);
  }

  function extractAddress(container) {
    const clone = container.cloneNode(true);
    clone.querySelectorAll('div[id$="_on"]').forEach((el) => el.remove());
    return clone.textContent.replace(/\s+/g, ' ').trim();
  }

  function extractPhone() {
    const input = document.querySelector('#telnumInput');
    const fallback = document.querySelector('#registerTelnumPrev');
    const value = (input && input.value) || (fallback && fallback.value) || '';
    const profile = {};
    if (value) profile.phone = value;
    return { profile };
  }

  function extractBasicInfo() {
    const rows = document.querySelectorAll('#updateMemberForm table tbody tr');
    const profile = {};

    const row1 = rows[0];
    const nameContainer = row1 && row1.querySelector('td .c-text-full-w');
    if (nameContainer) {
      const groups = splitByBr(nameContainer);
      if (groups[0]) profile.name = groups[0];
      if (groups[1]) profile.nameKana = groups[1];
    }

    const row2 = rows[1];
    if (row2) {
      const texts = Array.from(row2.querySelectorAll('.check_text'))
        .map((el) => el.textContent.trim())
        .filter(Boolean);
      if (texts[0]) profile.gender = texts[0];
      if (texts[1]) profile.birthYear = texts[1];
    }

    const row3 = rows[2];
    const addressContainer = row3 && row3.querySelector('td .c-text-full-w');
    if (addressContainer) {
      const address = extractAddress(addressContainer);
      if (address) profile.address = address;
    }

    return { profile };
  }

  function extractCreditCards() {
    const blocks = document.querySelectorAll('.c-creditCardInfo');
    const cards = [];
    blocks.forEach((block) => {
      const infoInput = block.querySelector('.c-creditCardInfo__btn input[type="hidden"]');
      const idBtn = block.querySelector('[data-creditcardid]');
      const creditCardId = idBtn ? idBtn.getAttribute('data-creditcardid') || '' : '';
      if (!infoInput) return;
      const mask = infoInput.getAttribute('numbermask') || '';
      const last4 = mask.replace(/[^0-9]/g, '').slice(-4);
      const expireParts = (infoInput.getAttribute('expiremonth') || '').split('/');
      cards.push({
        creditCardId,
        brand: infoInput.getAttribute('brand') || '',
        last4,
        holder: infoInput.getAttribute('creditcardholder') || '',
        expireMonth: expireParts[0] || '',
        expireYear: expireParts[1] || '',
      });
    });
    // Replace outright (not merge-by-id): this page shows the complete current card list on every
    // visit, so a card removed on the real site must disappear here too, not linger forever.
    return { creditCards: cards, replaceCreditCards: true };
  }

  function extractCompanions() {
    let rows = document.querySelectorAll('#pc-ui #dokoshaList tr');
    if (!rows.length) rows = document.querySelectorAll('#sp-ui #dokoshaList tr');
    const companions = [];
    rows.forEach((row) => {
      const btn = row.querySelector('button');
      const onclick = btn ? btn.getAttribute('onclick') || '' : '';
      const idMatch = onclick.match(/dokoshaId\.value=['"](\d+)['"]/);
      const companionId = idMatch ? idMatch[1] : '';
      const nameCell = row.querySelector('.name, .dokoshaInfo');
      const spans = nameCell
        ? Array.from(nameCell.querySelectorAll('span'))
            .map((s) => s.textContent.trim())
            .filter(Boolean)
        : [];
      const emailCell = row.querySelector('.sinseiInfo');
      const dateCell = row.querySelector('.saishuUpdateDateTime');
      const name = spans.slice(0, 2).join(' ');
      const maskedEmail = emailCell ? emailCell.textContent.trim() : spans[2] || '';
      const approvedAt = dateCell ? dateCell.textContent.trim() : spans[3] || '';
      if (!name && !companionId) return;
      companions.push({ companionId, name, maskedEmail, approvedAt });
    });
    // Replace outright, same reasoning as credit cards: this list is a full current snapshot.
    return { companions, replaceCompanions: true };
  }

  function extractLotteryRecords() {
    // The order-history page mixes 先着 (first-come, no lottery status) purchases in with
    // 抽選 (lottery) applications. Only the latter carry an election_status_message, so use
    // its presence to keep this list scoped to actual lottery records.
    const blocks = document.querySelectorAll('.m-ms01-aplItem[data-id]');
    const records = [];
    blocks.forEach((block) => {
      const orderId = block.getAttribute('data-id') || '';
      if (!orderId) return;
      const get = (suffix) => {
        const el = block.querySelector('[id$="' + suffix + '"]');
        return el ? el.textContent.trim() : '';
      };
      const status = get('-election_status_message');
      if (!status) return;
      const detailBtn = block.querySelector('[id$="-detail_button"]');
      records.push({
        orderId,
        tourName: get('-tour_name'),
        eventDatetime: get('-event_datetime'),
        venueName: get('-venue_name'),
        receptionName: get('-reception_name'),
        orderDatetime: get('-order_datetime'),
        status,
        statusDetail: get('-status_message'),
        detailUrl: detailBtn ? detailBtn.getAttribute('href') || '' : '',
      });
    });
    // Merged by orderId (not replaced): the site's own status filter can show a narrower subset
    // ("未入金・未発券" etc.) at different times, so accumulating across visits is correct here.
    return { lotteryRecords: records };
  }

  // Routed by feature-detection (does the field/form we need exist?), not URL path prefix. The
  // real site redirects the same nav link through different paths depending on entry point (e.g.
  // 携帯電話番号変更 lands on /telnum-auth, not the /telnumber-ninsho the menu link points to), so
  // matching on path was unreliable; matching on "is the thing I want to scrape on this page" is
  // both simpler and correct regardless of whatever path the site happens to redirect through.
  const PAGE_DEFS = [
    {
      id: 'telnumber-ninsho',
      label: '电话号码',
      host: 'member.eplus.jp',
      match: () => Boolean(document.querySelector('#telnumInput')),
      url: 'https://member.eplus.jp/telnumber-ninsho',
      extractor: extractPhone,
    },
    {
      id: 'update-member',
      label: '姓名&性别&住址',
      host: 'member.eplus.jp',
      match: () => Boolean(document.querySelector('#updateMemberForm')),
      url: 'https://member.eplus.jp/update-member',
      extractor: extractBasicInfo,
    },
    {
      id: 'update-creditcard',
      label: '信用卡信息',
      host: 'member.eplus.jp',
      match: () => Boolean(document.querySelector('#updateCreditCardForm')),
      url: 'https://member.eplus.jp/update-creditcard',
      extractor: extractCreditCards,
    },
    {
      id: 'update-dokosha',
      label: '同行者名单',
      host: 'member.eplus.jp',
      match: () => Boolean(document.querySelector('#dokoshaForm')),
      url: 'https://member.eplus.jp/update-dokosha',
      extractor: extractCompanions,
    },
    {
      id: 'jyoukyou',
      label: '抽选申请记录',
      host: 'orderhistory.eplus.jp',
      match: () => location.pathname === '/list' || Boolean(document.querySelector('.m-ms01-aplItem, #msO1-filter-all')),
      url: 'https://orderhistory.eplus.jp/list',
      extractor: extractLotteryRecords,
    },
  ];

  function currentPageDef() {
    const host = location.hostname;
    return PAGE_DEFS.find((p) => p.host === host && p.match()) || null;
  }

  // ---------------------------------------------------------------------
  // 申込み履歴 pagination - the order-history list only renders 40 records at a time behind a
  // "もっと見る" button (e.g. "全116件中 40件を表示中"); everything past the first batch is
  // invisible to extractLotteryRecords() until that button is clicked repeatedly. Each click's
  // DOM mutation is already picked up by the MutationObserver below (which re-runs extraction),
  // so this loop only needs to keep clicking - it doesn't need to extract anything itself.
  // ---------------------------------------------------------------------

  let lotteryExpansionState = 'idle'; // idle | expanding | done

  function startLotteryAutoExpand() {
    if (lotteryExpansionState !== 'idle') return;
    lotteryExpansionState = 'expanding';
    autoExpandLotteryList(0);
  }

  function autoExpandLotteryList(attempt) {
    function finish() {
      lotteryExpansionState = 'done';
      scheduleRescrape(200);
    }
    if (attempt > 60) {
      finish();
      return;
    }
    const btn = document.querySelector('button.c-readmore');
    if (!btn || btn.offsetParent === null) {
      finish();
      return;
    }
    const numEl = btn.querySelector('.c-readmore__num');
    if (numEl) {
      const match = numEl.textContent.match(/全(\d+)件中\s*(\d+)件/);
      if (match && Number(match[2]) >= Number(match[1])) {
        finish();
        return;
      }
    }
    btn.click();
    setTimeout(function () {
      autoExpandLotteryList(attempt + 1);
    }, 900);
  }

  function runExtractionAndPersist() {
    const pageDef = currentPageDef();
    if (!pageDef) return false;
    const result = pageDef.extractor() || {};

    const harvest = loadHarvest();
    if (result.profile) Object.assign(harvest.profile, result.profile);
    if (result.creditCards) {
      harvest.creditCards = result.replaceCreditCards ? result.creditCards : mergeById(harvest.creditCards, result.creditCards, 'creditCardId');
    }
    if (result.companions) {
      harvest.companions = result.replaceCompanions ? result.companions : mergeById(harvest.companions, result.companions, 'companionId');
    }
    if (result.lotteryRecords) harvest.lotteryRecords = mergeById(harvest.lotteryRecords, result.lotteryRecords, 'orderId');
    harvest.harvestedPages[pageDef.id] = new Date().toISOString();
    if (liveCredentials.email) harvest.eplusEmail = liveCredentials.email;

    saveHarvest(harvest);
    return true;
  }

  // ---------------------------------------------------------------------
  // Login autofill
  // ---------------------------------------------------------------------

  function findLoginFields() {
    const idA = document.querySelector('#js-modal input[name="login_id"]');
    const pwA = document.querySelector('#js-modal input[name="login_pw"]');
    if (idA && pwA) return { variant: 'A', idField: idA, pwField: pwA };

    const idB = document.querySelector('#loginId, input[name="loginId"]');
    const pwB = document.querySelector('#loginPassword, input[name="loginPassword"]');
    if (idB && pwB) return { variant: 'B', idField: idB, pwField: pwB };

    return null;
  }

  function setNativeValue(el, value) {
    const proto = Object.getPrototypeOf(el);
    const desc = Object.getOwnPropertyDescriptor(proto, 'value');
    if (desc && desc.set) {
      desc.set.call(el, value);
    } else {
      el.value = value;
    }
    ['input', 'change', 'keyup'].forEach((type) => {
      el.dispatchEvent(new Event(type, { bubbles: true }));
    });
  }

  function fillLoginFields(fields, email, password) {
    setNativeValue(fields.idField, email);
    setNativeValue(fields.pwField, password);
  }

  // ---------------------------------------------------------------------
  // IP / origin lookup
  //
  // ip-api.com (HTTP, no key) is primary - GM_xmlhttpRequest isn't subject to the page's HTTPS
  // mixed-content restrictions since it runs outside page context. ipwho.is (HTTPS) is a fallback
  // in case ip-api.com is rate-limited or blocked from the user's network.
  // ---------------------------------------------------------------------

  let ipInfoState = { loading: true };

  function loadIpInfo(onDone) {
    ipInfoState = { loading: true };
    GM_xmlhttpRequest({
      method: 'GET',
      url: 'http://ip-api.com/json/?fields=status,message,country,regionName,city,query',
      timeout: 8000,
      onload: function (res) {
        try {
          const data = JSON.parse(res.responseText);
          if (data && data.status === 'success') {
            ipInfoState = { ip: data.query, country: data.country || '', region: data.regionName || '', city: data.city || '' };
            onDone();
            return;
          }
        } catch (e) {
          // fall through to fallback provider below
        }
        loadIpInfoFallback(onDone);
      },
      onerror: function () { loadIpInfoFallback(onDone); },
      ontimeout: function () { loadIpInfoFallback(onDone); },
    });
  }

  function loadIpInfoFallback(onDone) {
    GM_xmlhttpRequest({
      method: 'GET',
      url: 'https://ipwho.is/',
      timeout: 8000,
      onload: function (res) {
        try {
          const data = JSON.parse(res.responseText);
          if (data && data.success !== false && data.ip) {
            ipInfoState = { ip: data.ip, country: data.country || '', region: data.region || '', city: data.city || '' };
          } else {
            ipInfoState = { error: (data && data.message) || '查询失败' };
          }
        } catch (e) {
          ipInfoState = { error: '解析失败' };
        }
        onDone();
      },
      onerror: function () {
        ipInfoState = { error: '网络请求失败' };
        onDone();
      },
      ontimeout: function () {
        ipInfoState = { error: '请求超时' };
        onDone();
      },
    });
  }

  // ---------------------------------------------------------------------
  // Export
  // ---------------------------------------------------------------------

  function buildFilename(email) {
    const safe = sanitizeKey(email).replace('@', '_at_');
    return (safe === '_pending' ? 'eplus-harvest-unknown' : safe) + '.json';
  }

  function exportHarvest(email, selectedStatuses) {
    const harvest = loadHarvest();
    const filteredRecords = harvest.lotteryRecords.filter((r) => selectedStatuses.has(r.status));
    const payload = {
      schemaVersion: 1,
      eplusEmail: email || harvest.eplusEmail || '',
      collectedAt: new Date().toISOString(),
      profile: harvest.profile,
      creditCards: harvest.creditCards,
      companions: harvest.companions,
      lotteryRecords: filteredRecords,
      harvestedPages: harvest.harvestedPages,
    };
    const blob = new Blob([JSON.stringify(payload, null, 2)], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = buildFilename(payload.eplusEmail);
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(function () {
      URL.revokeObjectURL(url);
    }, 2000);
  }

  // ---------------------------------------------------------------------
  // Styles
  //
  // Motion follows github.com/emilkowalski/skills (emil-design-eng): custom ease-out/ease-in-out
  // curves (never ease-in), transitions over keyframes for interruptible UI, only transform/
  // opacity/grid-track animate, press feedback via scale(0.97), nothing scales from 0, hover
  // gated behind (hover:hover), and prefers-reduced-motion strips movement but keeps fades.
  // ---------------------------------------------------------------------

  // .ec-overlay/.ec-modal (the export dialog) is appended to document.body as a SIBLING of
  // #eplus-collector-panel, not a descendant - a modal must escape the panel's own overflow/
  // max-height so it can center in the full viewport. That means every rule and CSS variable
  // scoped as "#eplus-collector-panel X" is invisible inside it (custom properties don't cross
  // sibling boundaries), so every shared rule below is written for both roots explicitly.
  var PANEL_ROOTS = '#eplus-collector-panel, .ec-overlay';

  GM_addStyle(
    PANEL_ROOTS + '{--ec-ease-out:cubic-bezier(0.23,1,0.32,1);--ec-ease-in-out:cubic-bezier(0.77,0,0.175,1);' +
      '--ec-bg:#131722f2;--ec-input:#0c0f18;--ec-text:#e2e8f0;--ec-muted:#8892a4;' +
      '--ec-border:rgba(255,255,255,0.12);--ec-primary:#8fa6cb;--ec-primary-hover:#a3b9dc;--ec-primary-text:#10141c;' +
      '--ec-danger:#f06060;--ec-warning:#b8d775;--ec-success:#8aa399;--ec-modal-bg:#131722;}' +
      '#eplus-collector-panel[data-theme="light"], .ec-overlay[data-theme="light"]{--ec-bg:#ffffffe6;--ec-input:#ffffff;--ec-text:#1a2130;' +
      '--ec-muted:#5b6472;--ec-border:rgba(15,23,42,0.14);--ec-primary:#365fa1;--ec-primary-hover:#274c86;' +
      '--ec-primary-text:#ffffff;--ec-danger:#d43f3f;--ec-warning:#8a6d1a;--ec-success:#3d715c;--ec-modal-bg:#ffffff;}' +
      '#eplus-collector-panel{position:fixed;right:16px;bottom:16px;z-index:2147483647;width:320px;' +
      'max-height:80vh;background:var(--ec-bg);color:var(--ec-text);border:1px solid var(--ec-border);' +
      'border-radius:10px;box-shadow:0 8px 28px rgba(0,0,0,0.35);font:13px/1.5 "Segoe UI",system-ui,-apple-system,sans-serif;' +
      'backdrop-filter:blur(6px);opacity:0;transform:translateY(12px);' +
      'transition:opacity 240ms var(--ec-ease-out),transform 240ms var(--ec-ease-out);}' +
      '#eplus-collector-panel.is-mounted{opacity:1;transform:translateY(0);}' +
      PANEL_ROOTS + ' *{box-sizing:border-box;}' +
      PANEL_ROOTS + ' .ec-icon{display:block;flex-shrink:0;}' +
      '.ec-header{display:flex;align-items:center;justify-content:space-between;padding:10px 12px;gap:8px;' +
      'border-bottom:1px solid var(--ec-border);cursor:pointer;user-select:none;}' +
      '.ec-header strong{font-size:13px;font-weight:600;}' +
      '.ec-header-right{display:flex;align-items:center;gap:6px;}' +
      '.ec-icon-btn{display:inline-flex;align-items:center;justify-content:center;width:26px;height:26px;padding:0;' +
      'background:transparent;border:1px solid var(--ec-border);border-radius:6px;color:var(--ec-text);cursor:pointer;' +
      'transition:transform 140ms var(--ec-ease-out),background-color 140ms ease;}' +
      '.ec-icon-btn:active{transform:scale(0.9);}' +
      '.ec-chevron{display:inline-flex;color:var(--ec-muted);transform:rotate(180deg);' +
      'transition:transform 220ms var(--ec-ease-in-out);}' +
      '#eplus-collector-panel.is-collapsed .ec-chevron{transform:rotate(0deg);}' +
      '.ec-body-wrap{display:grid;grid-template-rows:1fr;transition:grid-template-rows 220ms var(--ec-ease-in-out);}' +
      '#eplus-collector-panel.is-collapsed .ec-body-wrap{grid-template-rows:0fr;}' +
      '.ec-body-inner{overflow:hidden;min-height:0;}' +
      '.ec-body{max-height:calc(80vh - 47px);overflow-y:auto;padding:12px;display:flex;flex-direction:column;gap:12px;}' +
      '.ec-section{border:1px solid var(--ec-border);border-radius:8px;padding:10px;}' +
      '.ec-section h4{margin:0 0 8px;font-size:12px;color:var(--ec-muted);font-weight:600;text-transform:uppercase;letter-spacing:.02em;}' +
      '.ec-row{display:flex;align-items:center;gap:8px;margin-bottom:6px;}' +
      '.ec-row:last-child{margin-bottom:0;}' +
      PANEL_ROOTS.split(', ').map(function (r) { return r + ' input[type=text],' + r + ' input[type=password],' + r + ' input[type=email]'; }).join(',') + '{' +
      'width:100%;background:var(--ec-input);border:1px solid var(--ec-border);border-radius:6px;color:var(--ec-text);' +
      'padding:6px 8px;font-size:12px;transition:border-color 140ms ease;}' +
      PANEL_ROOTS.split(', ').map(function (r) { return r + ' input:focus-visible,' + r + ' button:focus-visible,' + r + ' select:focus-visible'; }).join(',') + '{' +
      'outline:2px solid var(--ec-primary);outline-offset:1px;}' +
      PANEL_ROOTS.split(', ').map(function (r) { return r + ' label.ec-check'; }).join(',') + '{display:flex;align-items:center;gap:6px;font-size:12px;color:var(--ec-muted);}' +
      PANEL_ROOTS.split(', ').map(function (r) { return r + ' select'; }).join(',') + '{background:var(--ec-input);border:1px solid var(--ec-border);border-radius:6px;' +
      'color:var(--ec-text);padding:4px 6px;font-size:12px;}' +
      PANEL_ROOTS.split(', ').map(function (r) { return r + ' button'; }).join(',') + '{cursor:pointer;border-radius:6px;border:1px solid var(--ec-border);' +
      'background:var(--ec-input);color:var(--ec-text);padding:6px 10px;font-size:12px;display:inline-flex;' +
      'align-items:center;justify-content:center;gap:6px;transition:transform 140ms var(--ec-ease-out),background-color 140ms ease,filter 140ms ease;}' +
      PANEL_ROOTS.split(', ').map(function (r) { return r + ' button.ec-primary'; }).join(',') + '{background:var(--ec-primary);border-color:var(--ec-primary);' +
      'color:var(--ec-primary-text);font-weight:600;}' +
      PANEL_ROOTS.split(', ').map(function (r) { return r + ' button:active'; }).join(',') + '{transform:scale(0.97);}' +
      '.ec-page-item{display:flex;align-items:center;justify-content:space-between;padding:6px 0;' +
      'border-bottom:1px dashed var(--ec-border);}' +
      '.ec-page-item:last-child{border-bottom:none;}' +
      '.ec-page-item-label{display:inline-flex;align-items:center;gap:8px;}' +
      '.ec-page-item a{color:var(--ec-primary);text-decoration:none;font-size:12px;}' +
      '.ec-dot{width:16px;height:16px;border-radius:50%;border:1.5px solid var(--ec-border);flex-shrink:0;' +
      'display:inline-flex;align-items:center;justify-content:center;color:transparent;transition:background-color 140ms ease,border-color 140ms ease;}' +
      '.ec-dot.done{background:var(--ec-success);border-color:var(--ec-success);color:var(--ec-primary-text);}' +
      '.ec-page-item.ec-stagger{opacity:0;transform:translateY(6px);animation:ecFadeUp 260ms var(--ec-ease-out) forwards;}' +
      '@keyframes ecFadeUp{to{opacity:1;transform:translateY(0);}}' +
      '.ec-muted{color:var(--ec-muted);font-size:11px;}' +
      '.ec-danger{color:var(--ec-danger);}' +
      '.ec-warning{color:var(--ec-warning);}' +
      '.ec-success{color:var(--ec-success);}' +
      '.ec-overlay{position:fixed;inset:0;background:rgba(0,0,0,.5);z-index:2147483647;display:flex;' +
      'align-items:center;justify-content:center;opacity:0;transition:opacity 180ms var(--ec-ease-out);}' +
      '.ec-overlay.is-visible{opacity:1;}' +
      '.ec-overlay.is-leaving{transition-duration:130ms;}' +
      '.ec-modal{width:320px;max-height:80vh;overflow-y:auto;background:var(--ec-modal-bg);border:1px solid var(--ec-border);' +
      'border-radius:10px;padding:14px;color:var(--ec-text);font:13px/1.5 "Segoe UI",system-ui,-apple-system,sans-serif;' +
      'transform:scale(0.95);opacity:0;transition:transform 200ms var(--ec-ease-out),opacity 200ms var(--ec-ease-out);}' +
      '.ec-overlay.is-visible .ec-modal{transform:scale(1);opacity:1;}' +
      '.ec-overlay.is-leaving .ec-modal{transition-duration:150ms;}' +
      '.ec-modal h3{margin:0 0 10px;font-size:14px;}' +
      '.ec-status-list{display:flex;flex-direction:column;gap:6px;margin-bottom:12px;}' +
      '.ec-modal-actions{display:flex;justify-content:flex-end;gap:8px;}' +
      '@media (hover:hover) and (pointer:fine){' +
      PANEL_ROOTS.split(', ').map(function (r) { return r + ' button:hover'; }).join(',') + '{filter:brightness(1.08);}' +
      '.ec-icon-btn:hover{background:var(--ec-input);}' +
      '.ec-page-item a:hover{text-decoration:underline;}' +
      '}' +
      '@media (prefers-reduced-motion:reduce){' +
      '#eplus-collector-panel{transition:opacity 120ms ease;transform:none !important;}' +
      '.ec-body-wrap,.ec-chevron{transition:none;}' +
      PANEL_ROOTS.split(', ').map(function (r) { return r + ' button'; }).join(',') + '{transition:background-color 140ms ease;}' +
      PANEL_ROOTS.split(', ').map(function (r) { return r + ' button:active'; }).join(',') + '{transform:none;}' +
      '.ec-overlay,.ec-modal{transition:opacity 120ms ease;transform:none !important;}' +
      '.ec-page-item.ec-stagger{animation:none;opacity:1;transform:none;}' +
      '}'
  );

  // ---------------------------------------------------------------------
  // Panel rendering
  //
  // The panel shell (root/header/body-wrap) is created once and kept mounted so the collapse and
  // theme-toggle transitions above actually have something persistent to animate - rebuilding the
  // whole tree on every background data refresh (as the first version of this script did) means
  // there's never a "before" state for a CSS transition to run from. Only .ec-body's innerHTML is
  // replaced on data refresh, and that happens silently/instantly by design: per the frequency
  // rule, a background poll that can fire many times per minute must not animate.
  // ---------------------------------------------------------------------

  let collapsed = GM_getValue(STORAGE_KEYS.collapsed, false);
  let exportSelectedStatuses = null;
  let progressListAnimated = false;
  // Kept in memory and updated on every keystroke so a background render() (triggered by the
  // MutationObserver/click watcher) never clobbers text the user is mid-typing.
  let liveCredentials = getCredentials();

  const THEME_CYCLE = ['system', 'light', 'dark'];
  const THEME_LABEL = { system: '跟随系统', light: '浅色', dark: '深色' };
  const THEME_ICON_NAME = { system: 'monitor', light: 'sun', dark: 'moon' };

  function getThemePreference() {
    const stored = GM_getValue(STORAGE_KEYS.theme, 'system');
    return THEME_CYCLE.indexOf(stored) === -1 ? 'system' : stored;
  }

  function getEffectiveTheme() {
    const preference = getThemePreference();
    if (preference !== 'system') return preference;
    return window.matchMedia && window.matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light';
  }

  function h(html) {
    const template = document.createElement('template');
    template.innerHTML = html.trim();
    return template.content.firstChild;
  }

  function escapeAttr(value) {
    return String(value || '').replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;');
  }

  function toggleCollapsed() {
    collapsed = !collapsed;
    GM_setValue(STORAGE_KEYS.collapsed, collapsed);
    updateChrome();
  }

  function ensurePanelShell() {
    const existing = document.getElementById('eplus-collector-panel');
    if (existing) return existing;

    const panel = h('<div id="eplus-collector-panel"></div>');
    const header = h(
      '<div class="ec-header" role="button" tabindex="0">' +
        '<strong>Eplus 采集助手</strong>' +
        '<span class="ec-header-right">' +
        '<button type="button" class="ec-icon-btn" id="ec-theme-toggle"></button>' +
        '<span class="ec-chevron">' + icon('chevronDown', 16) + '</span>' +
        '</span>' +
        '</div>'
    );
    const bodyWrap = h('<div class="ec-body-wrap"><div class="ec-body-inner"><div class="ec-body"></div></div></div>');
    panel.appendChild(header);
    panel.appendChild(bodyWrap);
    document.body.appendChild(panel);

    header.addEventListener('click', function (e) {
      if (e.target.closest && e.target.closest('#ec-theme-toggle')) return;
      toggleCollapsed();
    });
    header.addEventListener('keydown', function (e) {
      if (e.target.closest && e.target.closest('#ec-theme-toggle')) return;
      if (e.key === 'Enter' || e.key === ' ') {
        e.preventDefault();
        toggleCollapsed();
      }
    });
    header.querySelector('#ec-theme-toggle').addEventListener('click', function (e) {
      e.stopPropagation();
      const current = getThemePreference();
      const next = THEME_CYCLE[(THEME_CYCLE.indexOf(current) + 1) % THEME_CYCLE.length];
      GM_setValue(STORAGE_KEYS.theme, next);
      updateChrome();
    });

    // Double rAF: append happens hidden (opacity:0), then wait a frame so the browser paints that
    // state before flipping to visible - otherwise the entrance transition gets coalesced away.
    requestAnimationFrame(function () {
      requestAnimationFrame(function () {
        panel.classList.add('is-mounted');
      });
    });

    return panel;
  }

  function updateChrome() {
    const panel = ensurePanelShell();
    panel.setAttribute('data-theme', getEffectiveTheme());
    panel.classList.toggle('is-collapsed', collapsed);
    panel.querySelector('.ec-header').setAttribute('aria-expanded', String(!collapsed));
    const themeBtn = panel.querySelector('#ec-theme-toggle');
    const pref = getThemePreference();
    themeBtn.innerHTML = icon(THEME_ICON_NAME[pref], 15);
    themeBtn.title = '主题：' + THEME_LABEL[pref] + '（点击切换）';
    themeBtn.setAttribute('aria-label', themeBtn.title);
  }

  function render() {
    updateChrome();
    updateBody();
  }

  function updateBody() {
    const panel = ensurePanelShell();
    const body = panel.querySelector('.ec-body');
    const credentials = liveCredentials;
    const harvest = loadHarvest();
    const loginFields = findLoginFields();

    // Account section
    const accountSection = h(
      '<div class="ec-section">' +
        '<h4>账号</h4>' +
        '<div class="ec-row"><input type="email" id="ec-email" placeholder="邮箱" value="' +
        escapeAttr(credentials.email) +
        '"></div>' +
        '<div class="ec-row"><input type="password" id="ec-password" placeholder="密码" value="' +
        escapeAttr(credentials.password) +
        '"></div>' +
        '<div class="ec-row"><label class="ec-check"><input type="checkbox" id="ec-remember"' +
        (credentials.remember ? ' checked' : '') +
        '> 记住密码（明文存储在浏览器脚本管理器中）</label></div>' +
        (loginFields
          ? '<div class="ec-row"><button id="ec-fill-login" class="ec-primary" style="width:100%">' + icon('keyRound', 14) + '一键填写登录信息</button></div>'
          : '') +
        '</div>'
    );

    // Progress section
    const pagesHtml = PAGE_DEFS.map(function (p, index) {
      const done = harvest.harvestedPages[p.id];
      const expanding = p.id === 'jyoukyou' && lotteryExpansionState === 'expanding';
      const statusText = expanding ? '自动展开中…' : done ? '已采集' : '未采集';
      const staggerAttrs = progressListAnimated ? '' : ' class="ec-page-item ec-stagger" style="animation-delay:' + index * 45 + 'ms"';
      return (
        '<div' + (staggerAttrs || ' class="ec-page-item"') + '>' +
        '<span class="ec-page-item-label"><span class="ec-dot' +
        (done ? ' done' : '') +
        '">' + (done ? icon('check', 10) : '') + '</span> <a href="' +
        p.url +
        '">' +
        p.label +
        '</a></span>' +
        '<span class="ec-muted">' +
        statusText +
        '</span>' +
        '</div>'
      );
    }).join('');
    progressListAnimated = true;
    const progressSection = h('<div class="ec-section"><h4>采集进度</h4>' + pagesHtml + '</div>');

    // IP section
    const ipSection = h('<div class="ec-section" id="ec-ip-section"><h4>当前 IP / 来源地</h4>' + renderIpInfo() + '</div>');

    // Export section
    const exportSection = h(
      '<div class="ec-section">' +
        '<h4>导出</h4>' +
        '<div class="ec-muted" style="margin-bottom:8px">手机号' +
        (harvest.profile.phone ? '已获取' : '未获取') +
        ' · 基本信息' +
        (harvest.profile.name ? '已获取' : '未获取') +
        ' · 信用卡' +
        harvest.creditCards.length +
        '张 · 同行者' +
        harvest.companions.length +
        '人 · 抽选记录' +
        harvest.lotteryRecords.length +
        '条</div>' +
        '<button id="ec-export" class="ec-primary" style="width:100%">' + icon('download', 14) + '导出采集文件</button>' +
        '</div>'
    );

    body.innerHTML = '';
    body.appendChild(accountSection);
    body.appendChild(progressSection);
    body.appendChild(ipSection);
    body.appendChild(exportSection);

    const emailInput = body.querySelector('#ec-email');
    const passwordInput = body.querySelector('#ec-password');
    const rememberInput = body.querySelector('#ec-remember');

    function persistCredentials() {
      liveCredentials = {
        email: emailInput.value,
        password: passwordInput.value,
        remember: rememberInput.checked,
      };
      saveCredentials(liveCredentials);
    }
    emailInput.addEventListener('input', persistCredentials);
    passwordInput.addEventListener('input', persistCredentials);
    rememberInput.addEventListener('change', persistCredentials);

    const fillBtn = body.querySelector('#ec-fill-login');
    if (fillBtn) {
      fillBtn.addEventListener('click', function () {
        const fields = findLoginFields();
        if (fields) fillLoginFields(fields, emailInput.value, passwordInput.value);
      });
    }

    body.querySelector('#ec-export').addEventListener('click', function () {
      openExportDialog(emailInput.value);
    });
  }

  function renderIpInfo() {
    if (ipInfoState.loading) return '<div class="ec-muted">查询中…</div>';
    if (ipInfoState.error) return '<div class="ec-danger">' + escapeAttr(ipInfoState.error) + '</div>';
    const isJapan = ipInfoState.country === '日本' || ipInfoState.country === 'Japan';
    const cls = isJapan ? 'ec-success' : 'ec-warning';
    return (
      '<div>IP: ' +
      escapeAttr(ipInfoState.ip) +
      '</div><div class="' +
      cls +
      '">' +
      escapeAttr(ipInfoState.country) +
      ' ' +
      escapeAttr(ipInfoState.region) +
      ' ' +
      escapeAttr(ipInfoState.city) +
      (isJapan ? '' : '（非日本 IP，部分功能可能受限）') +
      '</div>'
    );
  }

  function refreshIpSection() {
    const panel = document.getElementById('eplus-collector-panel');
    const section = panel && panel.querySelector('#ec-ip-section');
    if (section) section.innerHTML = '<h4>当前 IP / 来源地</h4>' + renderIpInfo();
  }

  function openExportDialog(email) {
    const harvest = loadHarvest();
    const statuses = Array.from(new Set(harvest.lotteryRecords.map((r) => r.status).filter(Boolean)));
    exportSelectedStatuses = new Set(statuses);

    const panelTheme = document.getElementById('eplus-collector-panel');
    const overlay = h('<div class="ec-overlay" data-theme="' + (panelTheme ? panelTheme.getAttribute('data-theme') : getEffectiveTheme()) + '"></div>');
    const checksHtml = statuses.length
      ? statuses
          .map(
            (s) =>
              '<label class="ec-check"><input type="checkbox" checked data-status="' +
              escapeAttr(s) +
              '"> ' +
              escapeAttr(s) +
              '（' +
              harvest.lotteryRecords.filter((r) => r.status === s).length +
              '条）</label>'
          )
          .join('')
      : '<div class="ec-muted">尚未采集到抽选记录，导出文件里该项会是空列表</div>';

    const modal = h(
      '<div class="ec-modal">' +
        '<h3>导出前筛选抽选记录状态</h3>' +
        '<div class="ec-status-list">' +
        checksHtml +
        '</div>' +
        '<div class="ec-muted" style="margin-bottom:10px">手机号/基本信息/地址/同行者/信用卡不受此筛选影响，始终全量导出</div>' +
        '<div class="ec-modal-actions">' +
        '<button id="ec-export-cancel">' + icon('x', 14) + '取消</button>' +
        '<button id="ec-export-confirm" class="ec-primary">' + icon('download', 14) + '下载</button>' +
        '</div>' +
        '</div>'
    );
    overlay.appendChild(modal);
    document.body.appendChild(overlay);

    requestAnimationFrame(function () {
      requestAnimationFrame(function () {
        overlay.classList.add('is-visible');
      });
    });

    function closeDialog() {
      overlay.classList.remove('is-visible');
      overlay.classList.add('is-leaving');
      setTimeout(function () {
        overlay.remove();
      }, 160);
    }

    modal.querySelectorAll('input[data-status]').forEach((input) => {
      input.addEventListener('change', () => {
        const status = input.getAttribute('data-status');
        if (input.checked) exportSelectedStatuses.add(status);
        else exportSelectedStatuses.delete(status);
      });
    });

    document.getElementById('ec-export-cancel').addEventListener('click', closeDialog);
    document.getElementById('ec-export-confirm').addEventListener('click', () => {
      exportHarvest(email, exportSelectedStatuses);
      closeDialog();
    });
    overlay.addEventListener('click', (e) => {
      if (e.target === overlay) closeDialog();
    });
    document.addEventListener('keydown', function onKeyDown(e) {
      if (e.key === 'Escape') {
        document.removeEventListener('keydown', onKeyDown);
        closeDialog();
      }
    });
  }

  // ---------------------------------------------------------------------
  // Init
  // ---------------------------------------------------------------------

  let rescrapeTimer = null;
  function isTypingInPanel() {
    const active = document.activeElement;
    return Boolean(active && (active.id === 'ec-email' || active.id === 'ec-password'));
  }
  function scheduleRescrape(delay) {
    if (rescrapeTimer) clearTimeout(rescrapeTimer);
    rescrapeTimer = setTimeout(function () {
      if (runExtractionAndPersist() && !isTypingInPanel()) render();
    }, delay);
  }

  function init() {
    ensureFreshSession();
    render();
    loadIpInfo(refreshIpSection);
    const pageDef = currentPageDef();
    if (pageDef && pageDef.id === 'jyoukyou') startLotteryAutoExpand();
    scheduleRescrape(1000);

    // Catch async DOM changes: companion sub-view swaps, login modal opening, etc.
    // Skip refresh if focus is inside our own panel so it doesn't clobber in-progress typing.
    document.addEventListener(
      'click',
      function (e) {
        if (e.target.closest && e.target.closest('#eplus-collector-panel, .ec-overlay')) return;
        scheduleRescrape(600);
        setTimeout(function () {
          if (isTypingInPanel()) return;
          render();
        }, 300);
      },
      true
    );

    function isOwnElement(node) {
      return (
        node.nodeType === Node.ELEMENT_NODE &&
        (node.id === 'eplus-collector-panel' || node.classList.contains('ec-overlay'))
      );
    }
    const observer = new MutationObserver(function (mutations) {
      const isOwnMutation = mutations.every(function (m) {
        const nodes = Array.prototype.slice
          .call(m.addedNodes)
          .concat(Array.prototype.slice.call(m.removedNodes));
        return nodes.length > 0 && nodes.every(isOwnElement);
      });
      if (isOwnMutation) return;
      scheduleRescrape(700);
    });
    observer.observe(document.body, { childList: true, subtree: true });
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }
})();
