/**
 * dsh-skill-manager — browser half.
 *
 * Classic plugin bundle: this script runs in the browser module loader and only
 * registers a factory. The factory materialises into the plugin face
 * (`{ inject, apply }`) that the client kernel mounts.
 *
 * Registers:
 *   - `sidebar.panellist` entry `skill-manager` (order 20) + its inline SVG icon
 *   - `main` keyed panel `skill-manager` rendering the skill management page
 *
 * The module id equals the published package name. Only `react` may be
 * required; every surface colour comes from the allowed theme tokens.
 */
window.__ModuleLoader__.load({
  id: '@local/dsh-skill-manager',
  factory(require) {
    const React = require('react');
    const h = React.createElement;

    /* --------------------------------------------------------------------
     * Constants
     * ------------------------------------------------------------------ */

    const NS = 'skillManager';
    const API_PATH = '/skill-manager/api';
    const POLL_INTERVAL_MS = 1000;
    const POLL_LIMIT = 60;
    const BINDING_LIMIT = 50;
    const TAG_TEXT_LIMIT = 24;
    const USER_TAG_LIMIT = 8;

    /** Sort modes for the toolbar sort control (default: most used first). */
    const SORT_OPTIONS = ['calls', 'name', 'installed', 'updated'];
    const SORT_LABELS = {
      calls: 'sortCalls',
      name: 'sortName',
      installed: 'sortInstalled',
      updated: 'sortUpdated',
    };

    /** Time buckets for the installed/updated filter radios. */
    const RANGE_OPTIONS = ['all', '7', '30', '90', 'older'];
    const RANGE_LABELS = {
      all: 'filterAll',
      7: 'range7',
      30: 'range30',
      90: 'range90',
      older: 'rangeOlder',
    };

    /** Persisted list/cards layout preference. */
    const LAYOUT_STORAGE_KEY = 'dsh-skill-manager:layout';

    /**
     * Last payload the host returned — module scoped, so it survives the page
     * component being unmounted/remounted (switching main panels). Reopening the
     * panel paints real data immediately and refreshes silently in the
     * background instead of flashing a skeleton on every visit. The GET is
     * non-blocking on the host, so the cache can be stale while the host
     * rescans; `inventory` tells the page when that is the case.
     */
    let cachedPayload = null;

    /**
     * Muted AI tags per skill. The host payload only lists the tags that are
     * still shown, so the client keeps its own union to make every `setTags`
     * call lossless (module scoped, so switching panels does not reset it).
     */
    let mutedTagsCache = {};

    /** Module-scoped layout fallback so panel switches keep the chosen layout. */
    let cachedLayout = null;

    /** Skill source → locale key. Unknown sources fall back to the raw value. */
    const SOURCE_LABELS = {
      'user-dsh': 'sourceUser',
      'user-agents': 'sourceUser',
      'project-dsh': 'sourceProject',
      'project-agents': 'sourceProject',
      custom: 'sourceCustom',
      bundled: 'sourceBundled',
    };

    /**
     * Deterministic letter-tile identity palette. Every entry is a theme token
     * mixed into the raised surface, so the tile adapts to light and dark mode
     * while still giving each skill a stable colour.
     */
    const TILE_PALETTE = [
      { token: 'var(--dsw-alias-brand-primary)', mix: 22 },
      { token: 'var(--dsw-alias-state-success-primary)', mix: 48 },
      { token: 'var(--dsw-alias-state-warn-primary)', mix: 48 },
      { token: 'var(--dsw-alias-state-error-primary)', mix: 48 },
    ];

    /* --------------------------------------------------------------------
     * Locale dictionaries
     * ------------------------------------------------------------------ */

    const zh = {
      nav: '技能',
      title: '技能',
      subtitle: '管理本机技能：启用状态、调用次数与项目可见范围',
      refreshStats: '刷新统计',
      refreshStatsBusy: '统计中…',
      scanning: '统计更新中…',
      syncingSkills: '正在同步技能列表…',
      scanned: '已扫描 {scanned}/{total} 个会话',
      searchLabel: '搜索技能',
      searchPlaceholder: '搜索技能名称或描述…',
      filterAll: '全部',
      filterEnabled: '已启用',
      filterDisabled: '已禁用',
      filterBound: '已绑定',
      summary: '{total} 个技能 · 已启用 {enabled} · 已禁用 {disabled} · 累计调用 {calls} 次',
      sourceUser: '用户',
      sourceProject: '项目',
      sourceCustom: '自定义',
      sourceBundled: '内置',
      sourceOther: '其他',
      boundBadge: '仅 {count} 个项目',
      calls: '调用 {count} 次',
      noDescription: '暂无描述',
      loadFailed: '加载技能列表失败',
      retry: '重试',
      dismiss: '关闭',
      clearSearch: '清空搜索',
      actionFailed: '操作失败：{message}',
      emptyNoSkills: '还没有安装任何技能',
      emptyNoSkillsHint: '把技能放到 ~/.dsh/skills 下，或通过插件安装技能包。',
      emptyNoMatch: '没有匹配的技能',
      emptyNoMatchHint: '换个关键词，或清除当前筛选条件。',
      clearFilters: '清除筛选',
      moreActions: '更多操作',
      menuBindings: '项目可见范围…',
      menuDelete: '删除技能',
      toggleBindings: '项目可见范围',
      enableSkill: '启用技能：{name}',
      disableSkill: '禁用技能：{name}',
      bindingHelp: '不勾选任何项目 = 所有项目可见；勾选后只有这些项目里的会话能看到并调用该技能。',
      bindingSearch: '搜索项目名称或路径…',
      bindingSelected: '已选 {count} 个项目',
      bindingNone: '未选择（所有项目可见）',
      bindingClear: '清除全部绑定',
      bindingEmpty: '没有匹配的项目',
      bindingLimit: '最多绑定 50 个项目',
      workspacesEmpty: '还没有工作区',
      untitledWorkspace: '未命名项目',
      unlistedWorkspace: '不在工作区列表中',
      boundFallbackHint: '工作区列表暂不可用，以下是已绑定的项目 ID。',
      workspaceSessions: '{count} 个会话',
      currentWorkspace: '当前',
      removeBinding: '取消绑定 {name}',
      sortMenuLabel: '排序方式',
      sortCalls: '调用次数 ↓',
      sortName: '名称 A→Z',
      sortInstalled: '安装时间 ↓',
      sortUpdated: '更新时间 ↓',
      layoutLabel: '排版',
      layoutList: '列表',
      layoutCards: '卡片',
      filterButton: '筛选',
      filterButtonAria: '筛选（{count} 个条件）',
      filterTags: '标签（任一）',
      filterClearTags: '清除',
      filterNoTags: '暂无标签',
      filterInstalled: '安装时间',
      filterUpdated: '更新时间',
      range7: '近 7 天',
      range30: '近 30 天',
      range90: '近 90 天',
      rangeOlder: '更早（>90 天）',
      filterReset: '重置全部',
      detailWorkspaces: '项目可见范围',
      detailTags: '标签',
      detailToggle: '技能详情',
      tagAiTooltip: 'AI 生成',
      tagsEmpty: '还没有标签',
      tagAddPlaceholder: '添加标签…',
      tagAdd: '添加',
      tagRemove: '移除标签 {name}',
      tagMute: '忽略 AI 标签 {name}',
      tagDuplicate: '标签已存在',
      tagLimit: '最多 8 个自定义标签',
      historyInstalled: '安装时间',
      historyUpdated: '更新时间',
      menuTags: '编辑标签…',
      aiTagButton: 'AI 标签',
      aiTaggingRunning: '生成中…',
      aiTaggingDisabled: '未启用 AI 标签',
      aiTagged: 'AI 标签 {tagged}/{total}',
      deleteConfirm: '删除 “{name}”？将移动到回收站（不进入技能目录，仍可手动恢复）。',
      cancel: '取消',
      delete: '删除',
      deleting: '删除中…',
    };

    const en = {
      nav: 'Skills',
      title: 'Skills',
      subtitle: 'Manage local skills: enable state, call counts, and per-project visibility',
      refreshStats: 'Refresh stats',
      refreshStatsBusy: 'Scanning…',
      scanning: 'Updating stats…',
      syncingSkills: 'Syncing skills…',
      scanned: 'Scanned {scanned}/{total} sessions',
      searchLabel: 'Search skills',
      searchPlaceholder: 'Search skill name or description…',
      filterAll: 'All',
      filterEnabled: 'Enabled',
      filterDisabled: 'Disabled',
      filterBound: 'Scoped',
      summary: '{total} skills · {enabled} enabled · {disabled} disabled · {calls} calls in total',
      sourceUser: 'User',
      sourceProject: 'Project',
      sourceCustom: 'Custom',
      sourceBundled: 'Built-in',
      sourceOther: 'Other',
      boundBadge: '{count} projects only',
      calls: '{count} calls',
      noDescription: 'No description',
      loadFailed: 'Failed to load skills',
      retry: 'Retry',
      dismiss: 'Dismiss',
      clearSearch: 'Clear search',
      actionFailed: 'Action failed: {message}',
      emptyNoSkills: 'No skills installed yet',
      emptyNoSkillsHint: 'Add a skill under ~/.dsh/skills, or install a skill package as a plugin.',
      emptyNoMatch: 'No matching skills',
      emptyNoMatchHint: 'Try another keyword, or clear the current filters.',
      clearFilters: 'Clear filters',
      moreActions: 'More actions',
      menuBindings: 'Project visibility…',
      menuDelete: 'Delete skill',
      toggleBindings: 'Project visibility',
      enableSkill: 'Enable skill: {name}',
      disableSkill: 'Disable skill: {name}',
      bindingHelp: 'No projects selected means every project can use this skill; otherwise only sessions in the selected projects can see and call it.',
      bindingSearch: 'Search project name or path…',
      bindingSelected: '{count} projects selected',
      bindingNone: 'Nothing selected (all projects)',
      bindingClear: 'Clear all',
      bindingEmpty: 'No matching projects',
      bindingLimit: 'Up to 50 projects',
      workspacesEmpty: 'No workspaces yet',
      untitledWorkspace: 'Untitled project',
      unlistedWorkspace: 'Not in the workspace list',
      boundFallbackHint: 'The workspace list is unavailable; these are the bound project IDs.',
      workspaceSessions: '{count} sessions',
      currentWorkspace: 'Current',
      removeBinding: 'Unbind {name}',
      sortMenuLabel: 'Sort by',
      sortCalls: 'Calls ↓',
      sortName: 'Name A→Z',
      sortInstalled: 'Installed ↓',
      sortUpdated: 'Updated ↓',
      layoutLabel: 'Layout',
      layoutList: 'List',
      layoutCards: 'Cards',
      filterButton: 'Filter',
      filterButtonAria: 'Filter ({count} active)',
      filterTags: 'Tags (any)',
      filterClearTags: 'Clear',
      filterNoTags: 'No tags yet',
      filterInstalled: 'Installed',
      filterUpdated: 'Updated',
      range7: 'Last 7 days',
      range30: 'Last 30 days',
      range90: 'Last 90 days',
      rangeOlder: 'Older (>90 days)',
      filterReset: 'Reset all',
      detailWorkspaces: 'Project visibility',
      detailTags: 'Tags',
      detailToggle: 'Skill details',
      tagAiTooltip: 'AI generated',
      tagsEmpty: 'No tags yet',
      tagAddPlaceholder: 'Add a tag…',
      tagAdd: 'Add',
      tagRemove: 'Remove tag {name}',
      tagMute: 'Mute AI tag {name}',
      tagDuplicate: 'Tag already exists',
      tagLimit: 'Up to 8 custom tags',
      historyInstalled: 'Installed',
      historyUpdated: 'Updated',
      menuTags: 'Edit tags…',
      aiTagButton: 'AI tags',
      aiTaggingRunning: 'Generating…',
      aiTaggingDisabled: 'AI tagging is disabled',
      aiTagged: 'AI tags {tagged}/{total}',
      deleteConfirm: 'Delete “{name}”? It will be moved to the trash (not the skills directory; you can still restore it manually).',
      cancel: 'Cancel',
      delete: 'Delete',
      deleting: 'Deleting…',
    };

    function interpolate(template, params) {
      if (!params) return template;
      return String(template).replace(/\{(\w+)\}/g, function (match, name) {
        return Object.prototype.hasOwnProperty.call(params, name) ? String(params[name]) : match;
      });
    }

    function makeT(dict) {
      return function t(key, params) {
        let template = dict[key];
        if (template === undefined) template = zh[key];
        if (template === undefined) template = key;
        return interpolate(template, params);
      };
    }

    /** Used when the framework does not hand the page a bound translator. */
    const fallbackT = makeT(zh);

    /* --------------------------------------------------------------------
     * Payload normalisation — the page must render for any partial response
     * ------------------------------------------------------------------ */

    function asArray(value) {
      return Array.isArray(value) ? value : [];
    }

    function asNumber(value, fallback) {
      return typeof value === 'number' && isFinite(value) ? value : fallback;
    }

    function asString(value, fallback) {
      return typeof value === 'string' ? value : fallback;
    }

    function stringIds(value) {
      return asArray(value).filter(function (id) {
        return typeof id === 'string' && id !== '';
      });
    }

    function finiteOrNull(value) {
      return typeof value === 'number' && isFinite(value) ? value : null;
    }

    function nonEmptyStringOrNull(value) {
      return typeof value === 'string' && value !== '' ? value : null;
    }

    /** A skill tag: `{ text, source }`; anything but `ai` counts as user. */
    function normalizeSkillTag(raw) {
      if (typeof raw === 'string') {
        const text = raw.trim();
        return text === '' ? null : { text: text, source: 'user' };
      }
      if (!raw || typeof raw !== 'object') return null;
      const text = asString(raw.text, '').trim();
      if (text === '') return null;
      return { text: text, source: raw.source === 'ai' ? 'ai' : 'user' };
    }

    /** A tag-filter option: `{ text, count }`. */
    function normalizeTagCount(raw) {
      if (!raw || typeof raw !== 'object') return null;
      const text = asString(raw.text, '').trim();
      if (text === '') return null;
      return { text: text, count: asNumber(raw.count, 0) };
    }

    function normalizeSkill(raw) {
      if (!raw || typeof raw !== 'object') return null;
      const name = asString(raw.name, '');
      if (name === '') return null;
      /* v2 field first; an older host may still answer with session bindings. */
      const boundWorkspaces =
        raw.boundWorkspaces !== undefined ? stringIds(raw.boundWorkspaces) : stringIds(raw.boundSessions);
      return {
        name: name,
        description: asString(raw.description, ''),
        source: asString(raw.source, ''),
        enabled: raw.enabled !== false,
        boundWorkspaces: boundWorkspaces,
        calls: asNumber(raw.calls, 0),
        lastUsedAt: finiteOrNull(raw.lastUsedAt),
        deletable: raw.deletable === true,
        installedAt: finiteOrNull(raw.installedAt),
        updatedAt: finiteOrNull(raw.updatedAt),
        tags: asArray(raw.tags)
          .map(normalizeSkillTag)
          .filter(function (tag) {
            return tag !== null;
          }),
        /* Optional echo of the muted AI set; keeps later setTags calls lossless. */
        mutedTags: asArray(raw.mutedTags).filter(function (text) {
          return typeof text === 'string' && text !== '';
        }),
      };
    }

    /** v2 workspace row; tolerates the legacy session shape (id/title/cwd). */
    function normalizeWorkspace(raw) {
      if (!raw || typeof raw !== 'object') return null;
      const id = asString(raw.id, '');
      if (id === '') return null;
      return {
        id: id,
        title: asString(raw.title, ''),
        path: asString(raw.path, asString(raw.cwd, '')),
        sessions: asNumber(raw.sessions, asNumber(raw.sessionCount, 0)),
      };
    }

    function normalizePayload(raw) {
      const src = raw && typeof raw === 'object' ? raw : {};
      const skills = asArray(src.skills)
        .map(normalizeSkill)
        .filter(function (skill) {
          return skill !== null;
        });
      const workspaceSource = src.workspaces !== undefined ? src.workspaces : src.sessions;
      const workspaces = asArray(workspaceSource)
        .map(normalizeWorkspace)
        .filter(function (workspace) {
          return workspace !== null;
        });
      const statsRaw = src.stats && typeof src.stats === 'object' ? src.stats : {};
      const inventoryRaw = src.inventory && typeof src.inventory === 'object' ? src.inventory : {};
      const taggingRaw = src.tagging && typeof src.tagging === 'object' ? src.tagging : {};
      const summaryRaw = src.summary && typeof src.summary === 'object' ? src.summary : {};
      const tagOptions = asArray(src.tags)
        .map(normalizeTagCount)
        .filter(function (tag) {
          return tag !== null;
        });
      const enabledCount = skills.filter(function (skill) {
        return skill.enabled;
      }).length;
      const boundCount = skills.filter(function (skill) {
        return skill.boundWorkspaces.length > 0;
      }).length;
      const callCount = skills.reduce(function (total, skill) {
        return total + skill.calls;
      }, 0);
      return {
        skills: skills,
        workspaces: workspaces,
        summary: {
          total: asNumber(summaryRaw.total, skills.length),
          enabled: asNumber(summaryRaw.enabled, enabledCount),
          disabled: asNumber(summaryRaw.disabled, skills.length - enabledCount),
          bound: asNumber(summaryRaw.bound, boundCount),
          calls: asNumber(summaryRaw.calls, callCount),
        },
        stats: {
          scanning: statsRaw.scanning === true,
          updatedAt: asNumber(statsRaw.updatedAt, 0),
          scannedSessions: asNumber(statsRaw.scannedSessions, 0),
          totalSessions: asNumber(statsRaw.totalSessions, 0),
        },
        /* Absent (older host) means "settled": ready, not refreshing. */
        inventory: {
          ready: inventoryRaw.ready !== false,
          refreshing: inventoryRaw.refreshing === true,
          updatedAt: asNumber(inventoryRaw.updatedAt, 0),
        },
        /* v3 tag catalogue for the filter popover. */
        tags: tagOptions,
        /* v3 AI tagging state; absent means "off". */
        tagging: {
          enabled: taggingRaw.enabled === true,
          running: taggingRaw.running === true,
          queued: asNumber(taggingRaw.queued, 0),
          lastRunAt: asNumber(taggingRaw.lastRunAt, 0),
          lastError: nonEmptyStringOrNull(taggingRaw.lastError),
          tagged: asNumber(taggingRaw.tagged, 0),
          model: nonEmptyStringOrNull(taggingRaw.model),
        },
        currentWorkspaceId:
          typeof src.currentWorkspaceId === 'string' && src.currentWorkspaceId !== ''
            ? src.currentWorkspaceId
            : null,
        currentWorkspacePath: typeof src.currentWorkspacePath === 'string' ? src.currentWorkspacePath : null,
        trashDir: asString(src.trashDir, ''),
      };
    }

    /* --------------------------------------------------------------------
     * HTTP — GET payload, POST { ok:true, payload } | { ok:false, error }
     * ------------------------------------------------------------------ */

    function toRequestError(response, body) {
      const error = body && body.error && typeof body.error === 'object' ? body.error : {};
      const message = asString(error.message, '') || 'HTTP ' + (response && response.status);
      const wrapped = new Error(message);
      wrapped.code = asString(error.code, 'internal');
      return wrapped;
    }

    function readJson(response) {
      return response
        .json()
        .catch(function () {
          return null;
        });
    }

    /** Every payload the host hands us becomes the reopen cache. */
    function rememberPayload(payload) {
      if (payload) cachedPayload = payload;
      return payload;
    }

    async function getPayload() {
      const response = await fetch(API_PATH, {
        method: 'GET',
        headers: { accept: 'application/json' },
        cache: 'no-store',
      });
      const body = await readJson(response);
      if (!response.ok || !body || body.ok !== true) throw toRequestError(response, body);
      return rememberPayload(normalizePayload(body));
    }

    async function postAction(action, params) {
      const body = Object.assign({ action: action }, params || {});
      const response = await fetch(API_PATH, {
        method: 'POST',
        headers: { 'content-type': 'application/json', accept: 'application/json' },
        body: JSON.stringify(body),
      });
      const json = await readJson(response);
      if (!response.ok || !json || json.ok !== true) throw toRequestError(response, json);
      return json.payload ? rememberPayload(normalizePayload(json.payload)) : null;
    }

    /* --------------------------------------------------------------------
     * Small helpers
     * ------------------------------------------------------------------ */

    /**
     * Read the persisted list/cards choice. Order: module fallback (instant
     * panel switches) → localStorage → default `'list'`; any failure falls back.
     */
    function readLayoutPreference() {
      if (cachedLayout === 'list' || cachedLayout === 'cards') return cachedLayout;
      let stored = null;
      try {
        if (typeof localStorage !== 'undefined' && localStorage && typeof localStorage.getItem === 'function') {
          stored = localStorage.getItem(LAYOUT_STORAGE_KEY);
        }
      } catch (error) {
        stored = null;
      }
      const layout = stored === 'cards' || stored === 'list' ? stored : 'list';
      cachedLayout = layout;
      return layout;
    }

    /** Persist the layout choice; storage failures keep the module fallback. */
    function writeLayoutPreference(layout) {
      if (layout !== 'list' && layout !== 'cards') return;
      cachedLayout = layout;
      try {
        if (typeof localStorage !== 'undefined' && localStorage && typeof localStorage.setItem === 'function') {
          localStorage.setItem(LAYOUT_STORAGE_KEY, layout);
        }
      } catch (error) {
        /* Storage unavailable (privacy mode, quota): the module fallback stands. */
      }
    }

    /** Reopening the panel starts from the last payload, never from a skeleton. */
    function createInitialState() {
      const layout = readLayoutPreference();
      if (cachedPayload) return { status: 'ready', payload: cachedPayload, error: null, layout: layout };
      return { status: 'loading', payload: null, error: null, layout: layout };
    }

    function hashName(name) {
      let hash = 0;
      for (let index = 0; index < name.length; index += 1) {
        hash = (hash * 31 + name.charCodeAt(index)) % 1000003;
      }
      return hash;
    }

    function tileStyle(name) {
      const entry = TILE_PALETTE[hashName(name) % TILE_PALETTE.length];
      return {
        background:
          'color-mix(in srgb, ' +
          entry.token +
          ' ' +
          entry.mix +
          '%, var(--dsw-alias-bg-layer-1))',
        color: 'var(--dsw-alias-label-primary)',
      };
    }

    function shortId(id) {
      return id.length > 8 ? id.slice(0, 8) : id;
    }

    function errorMessage(error) {
      if (!error) return '';
      if (typeof error === 'string') return error;
      return error.message ? String(error.message) : String(error);
    }

    /** `YYYY-MM-DD` in local time; an em dash for a missing timestamp. */
    function formatDateShort(timestamp) {
      if (typeof timestamp !== 'number' || !isFinite(timestamp) || timestamp <= 0) return '—';
      const date = new Date(timestamp);
      function pad(value) {
        return value < 10 ? '0' + value : String(value);
      }
      return date.getFullYear() + '-' + pad(date.getMonth() + 1) + '-' + pad(date.getDate());
    }

    /** `YYYY-MM-DD HH:mm` in local time; an em dash for a missing timestamp. */
    function formatDateTime(timestamp) {
      if (typeof timestamp !== 'number' || !isFinite(timestamp) || timestamp <= 0) return '—';
      const date = new Date(timestamp);
      function pad(value) {
        return value < 10 ? '0' + value : String(value);
      }
      return (
        date.getFullYear() +
        '-' +
        pad(date.getMonth() + 1) +
        '-' +
        pad(date.getDate()) +
        ' ' +
        pad(date.getHours()) +
        ':' +
        pad(date.getMinutes())
      );
    }

    /** Newest first, nulls last (0 when both are null). */
    function timeDesc(left, right) {
      if (left === null && right === null) return 0;
      if (left === null) return 1;
      if (right === null) return -1;
      return right - left;
    }

    /** `all` always matches; an active range excludes rows without a timestamp. */
    function inTimeRange(timestamp, range, now) {
      if (range === 'all') return true;
      if (timestamp === null) return false;
      const ageDays = (now - timestamp) / 86400000;
      if (range === '7') return ageDays <= 7;
      if (range === '30') return ageDays <= 30;
      if (range === '90') return ageDays <= 90;
      if (range === 'older') return ageDays > 90;
      return true;
    }

    function unionTexts(left, right) {
      const seen = {};
      const merged = [];
      left
        .concat(right)
        .forEach(function (text) {
          if (typeof text !== 'string' || text === '' || seen[text]) return;
          seen[text] = true;
          merged.push(text);
        });
      return merged;
    }

    /* --------------------------------------------------------------------
     * Icons — 16px grid, currentColor line art
     * ------------------------------------------------------------------ */

    function svgBase(size, children) {
      return h(
        'svg',
        {
          width: size,
          height: size,
          viewBox: '0 0 16 16',
          fill: 'none',
          'aria-hidden': 'true',
          focusable: 'false',
        },
        children,
      );
    }

    function IconSearch() {
      return svgBase(14, [
        h('circle', {
          key: 'c',
          cx: 7,
          cy: 7,
          r: 4.3,
          stroke: 'currentColor',
          strokeWidth: 1.4,
        }),
        h('path', {
          key: 'p',
          d: 'M10.3 10.3 13.4 13.4',
          stroke: 'currentColor',
          strokeWidth: 1.4,
          strokeLinecap: 'round',
        }),
      ]);
    }

    function IconRefresh() {
      return svgBase(14, [
        h('path', {
          key: 'arc',
          d: 'M13.4 8A5.4 5.4 0 1 1 12.1 4.3',
          stroke: 'currentColor',
          strokeWidth: 1.4,
          strokeLinecap: 'round',
        }),
        h('path', {
          key: 'head',
          d: 'M12.2 1.2v3.2H9',
          stroke: 'currentColor',
          strokeWidth: 1.4,
          strokeLinecap: 'round',
          strokeLinejoin: 'round',
        }),
      ]);
    }

    function IconMore() {
      return svgBase(14, [
        h('circle', { key: 'a', cx: 3.4, cy: 8, r: 1.15, fill: 'currentColor' }),
        h('circle', { key: 'b', cx: 8, cy: 8, r: 1.15, fill: 'currentColor' }),
        h('circle', { key: 'c', cx: 12.6, cy: 8, r: 1.15, fill: 'currentColor' }),
      ]);
    }

    function IconChevron() {
      return svgBase(14, [
        h('path', {
          key: 'c',
          d: 'M6.4 3.8 10.6 8l-4.2 4.2',
          stroke: 'currentColor',
          strokeWidth: 1.5,
          strokeLinecap: 'round',
          strokeLinejoin: 'round',
        }),
      ]);
    }

    function IconTrash() {
      return svgBase(14, [
        h('path', {
          key: 'lid',
          d: 'M3 4.6h10M6.3 4.6V3.2h3.4v1.4',
          stroke: 'currentColor',
          strokeWidth: 1.3,
          strokeLinecap: 'round',
          strokeLinejoin: 'round',
        }),
        h('path', {
          key: 'body',
          d: 'M4.5 4.6l.6 8.2h5.8l.6-8.2',
          stroke: 'currentColor',
          strokeWidth: 1.3,
          strokeLinecap: 'round',
          strokeLinejoin: 'round',
        }),
        h('path', {
          key: 'lines',
          d: 'M6.8 7v3.4M9.2 7v3.4',
          stroke: 'currentColor',
          strokeWidth: 1.2,
          strokeLinecap: 'round',
        }),
      ]);
    }

    function IconLink() {
      return svgBase(11, [
        h('path', {
          key: 'a',
          d: 'M6.7 9.3a2.5 2.5 0 0 0 3.5 0l1.9-1.9a2.5 2.5 0 0 0-3.5-3.5l-.8.8',
          stroke: 'currentColor',
          strokeWidth: 1.35,
          strokeLinecap: 'round',
        }),
        h('path', {
          key: 'b',
          d: 'M9.3 6.7a2.5 2.5 0 0 0-3.5 0L3.9 8.6a2.5 2.5 0 0 0 3.5 3.5l.8-.8',
          stroke: 'currentColor',
          strokeWidth: 1.35,
          strokeLinecap: 'round',
        }),
      ]);
    }

    function IconClose() {
      return svgBase(12, [
        h('path', {
          key: 'x',
          d: 'M4.2 4.2l7.6 7.6M11.8 4.2l-7.6 7.6',
          stroke: 'currentColor',
          strokeWidth: 1.4,
          strokeLinecap: 'round',
        }),
      ]);
    }

    function IconAlert(props) {
      const size = props && props.size ? props.size : 16;
      return svgBase(size, [
        h('circle', {
          key: 'c',
          cx: 8,
          cy: 8,
          r: 6.2,
          stroke: 'currentColor',
          strokeWidth: 1.4,
        }),
        h('path', {
          key: 'bar',
          d: 'M8 4.8v3.7',
          stroke: 'currentColor',
          strokeWidth: 1.4,
          strokeLinecap: 'round',
        }),
        h('circle', { key: 'dot', cx: 8, cy: 11.3, r: 0.85, fill: 'currentColor' }),
      ]);
    }

    function IconSparkles(props) {
      const size = props && props.size ? props.size : 16;
      return svgBase(size, [
        h('path', {
          key: 'star',
          d: 'M6.6 1.6Q7.7 5.5 11.6 6.6 7.7 7.7 6.6 11.6 5.5 7.7 1.6 6.6 5.5 5.5 6.6 1.6Z',
          fill: 'currentColor',
        }),
        h('path', {
          key: 'spark',
          d: 'M12 9.1Q12.5 11.1 14.5 11.6 12.5 12.1 12 14.1 11.5 12.1 9.5 11.6 11.5 11.1 12 9.1Z',
          fill: 'currentColor',
          fillOpacity: 0.85,
        }),
      ]);
    }

    function IconTag() {
      return svgBase(14, [
        h('path', {
          key: 'body',
          d: 'M7.9 2.1H3v4.9l5.3 5.3a1.2 1.2 0 0 0 1.7 0l3.2-3.2a1.2 1.2 0 0 0 0-1.7L7.9 2.1Z',
          stroke: 'currentColor',
          strokeWidth: 1.35,
          strokeLinejoin: 'round',
        }),
        h('circle', { key: 'hole', cx: 5.6, cy: 5.6, r: 0.95, fill: 'currentColor' }),
      ]);
    }

    function IconFilter() {
      return svgBase(13, [
        h('path', {
          key: 'funnel',
          d: 'M2.4 3h11.2l-4.3 5.1v4.1l-2.6 1.5V8.1L2.4 3Z',
          stroke: 'currentColor',
          strokeWidth: 1.35,
          strokeLinejoin: 'round',
          strokeLinecap: 'round',
        }),
      ]);
    }

    function IconSort() {
      return svgBase(13, [
        h('path', {
          key: 'lines',
          d: 'M2.6 4.2h5.2M2.6 7.6h3.6M2.6 11h1.9',
          stroke: 'currentColor',
          strokeWidth: 1.35,
          strokeLinecap: 'round',
        }),
        h('path', {
          key: 'arrow',
          d: 'M11.6 3.2v9.1M9.7 10.4l1.9 1.9 1.9-1.9',
          stroke: 'currentColor',
          strokeWidth: 1.35,
          strokeLinecap: 'round',
          strokeLinejoin: 'round',
        }),
      ]);
    }

    function IconChevronDown() {
      return svgBase(10, [
        h('path', {
          key: 'c',
          d: 'M2.6 4.4 6.2 8l3.6-3.6',
          stroke: 'currentColor',
          strokeWidth: 1.4,
          strokeLinecap: 'round',
          strokeLinejoin: 'round',
        }),
      ]);
    }

    function IconCheck() {
      return svgBase(12, [
        h('path', {
          key: 'c',
          d: 'M3 8.3 5.7 11l6.3-6.3',
          stroke: 'currentColor',
          strokeWidth: 1.6,
          strokeLinecap: 'round',
          strokeLinejoin: 'round',
        }),
      ]);
    }

    function IconList() {
      return svgBase(13, [
        h('path', {
          key: 'dots',
          d: 'M2.8 4.2h.9M2.8 8h.9M2.8 11.8h.9',
          stroke: 'currentColor',
          strokeWidth: 1.6,
          strokeLinecap: 'round',
        }),
        h('path', {
          key: 'rows',
          d: 'M6.3 4.2h6.9M6.3 8h6.9M6.3 11.8h6.9',
          stroke: 'currentColor',
          strokeWidth: 1.4,
          strokeLinecap: 'round',
        }),
      ]);
    }

    function IconGrid() {
      return svgBase(13, [
        h('rect', {
          key: 'a',
          x: 2.5,
          y: 2.5,
          width: 4.6,
          height: 4.6,
          rx: 1.2,
          stroke: 'currentColor',
          strokeWidth: 1.35,
        }),
        h('rect', {
          key: 'b',
          x: 8.9,
          y: 2.5,
          width: 4.6,
          height: 4.6,
          rx: 1.2,
          stroke: 'currentColor',
          strokeWidth: 1.35,
        }),
        h('rect', {
          key: 'c',
          x: 2.5,
          y: 8.9,
          width: 4.6,
          height: 4.6,
          rx: 1.2,
          stroke: 'currentColor',
          strokeWidth: 1.35,
        }),
        h('rect', {
          key: 'd',
          x: 8.9,
          y: 8.9,
          width: 4.6,
          height: 4.6,
          rx: 1.2,
          stroke: 'currentColor',
          strokeWidth: 1.35,
        }),
      ]);
    }

    /* --------------------------------------------------------------------
     * Sidebar entry icon: `{ size, active }`
     * ------------------------------------------------------------------ */

    function SidebarSkillIcon(props) {
      const size = props && typeof props.size === 'number' ? props.size : 16;
      const active = !!(props && props.active);
      return h(
        'svg',
        {
          width: size,
          height: size,
          viewBox: '0 0 16 16',
          fill: 'none',
          'aria-hidden': 'true',
          focusable: 'false',
          style: {
            display: 'block',
            color: active ? 'var(--dsw-alias-brand-primary)' : 'currentColor',
          },
        },
        h('path', {
          key: 'star',
          d: 'M6.6 1.6Q7.7 5.5 11.6 6.6 7.7 7.7 6.6 11.6 5.5 7.7 1.6 6.6 5.5 5.5 6.6 1.6Z',
          fill: 'currentColor',
        }),
        h('path', {
          key: 'spark',
          d: 'M12 9.1Q12.5 11.1 14.5 11.6 12.5 12.1 12 14.1 11.5 12.1 9.5 11.6 11.5 11.1 12 9.1Z',
          fill: 'currentColor',
          fillOpacity: 0.85,
        }),
      );
    }

    /* --------------------------------------------------------------------
     * Presentation pieces
     * ------------------------------------------------------------------ */

    /** Three-row skeleton; three grid cards when the cards layout is active. */
    function LoadingSkeleton(props) {
      const cardsLayout = !!(props && props.layout === 'cards');
      const items = [];
      for (let index = 0; index < 3; index += 1) {
        if (cardsLayout) {
          items.push(
            h(
              'li',
              { className: 'skm-gridCard skm-skGridCard', key: 'skm-sk-' + index },
              h('div', { className: 'skm-skLine', 'data-w': 'name' }),
              h('div', { className: 'skm-skLine', 'data-w': 'desc' }),
              h('div', { className: 'skm-skLine', 'data-w': 'meta' }),
            ),
          );
          continue;
        }
        items.push(
          h(
            'div',
            { className: 'skm-skCard', key: 'skm-sk-' + index },
            h('div', { className: 'skm-skTile' }),
            h(
              'div',
              { className: 'skm-skLines' },
              h('div', { className: 'skm-skLine', 'data-w': 'name' }),
              h('div', { className: 'skm-skLine', 'data-w': 'desc' }),
            ),
          ),
        );
      }
      return h(
        cardsLayout ? 'ul' : 'div',
        { className: cardsLayout ? 'skm-grid' : 'skm-skeleton', 'aria-busy': 'true' },
        items,
      );
    }

    function EmptyState(props) {
      const t = props.t;
      const filtered = props.kind === 'filtered';
      return h(
        'div',
        { className: 'skm-empty' },
        h('div', { className: 'skm-emptyGlyph' }, h(IconSparkles, { size: 30 })),
        h('p', { className: 'skm-emptyTitle' }, t(filtered ? 'emptyNoMatch' : 'emptyNoSkills')),
        h('p', { className: 'skm-emptyHint' }, t(filtered ? 'emptyNoMatchHint' : 'emptyNoSkillsHint')),
        filtered
          ? h(
              'div',
              { className: 'skm-emptyAction' },
              h('button', { type: 'button', className: 'skm-btn', onClick: props.onClear }, t('clearFilters')),
            )
          : null,
      );
    }

    function ErrorState(props) {
      const t = props.t;
      return h(
        'div',
        { className: 'skm-errorState' },
        h('div', { className: 'skm-errorGlyph' }, h(IconAlert, { size: 26 })),
        h('p', { className: 'skm-errorTitle' }, t('loadFailed')),
        props.message ? h('p', { className: 'skm-errorDetail' }, props.message) : null,
        h(
          'div',
          { className: 'skm-emptyAction' },
          h('button', { type: 'button', className: 'skm-btn', onClick: props.onRetry }, t('retry')),
        ),
      );
    }

    function WorkspacePanel(props) {
      const t = props.t;
      const [workspaceQuery, setWorkspaceQuery] = React.useState('');
      const workspaces = props.workspaces;
      const selected = props.selected;
      const query = workspaceQuery.trim().toLowerCase();
      const atLimit = selected.length >= BINDING_LIMIT;
      const currentId = props.currentWorkspaceId;
      const noWorkspaces = workspaces.length === 0;
      const items = [];

      if (!noWorkspaces) {
        /* Bound ids the host no longer lists stay visible and removable. */
        selected.forEach(function (id) {
          const known = workspaces.some(function (workspace) {
            return workspace.id === id;
          });
          if (!known) items.push({ id: id, title: '', path: '', sessions: 0, unlisted: true });
        });
        workspaces.forEach(function (workspace) {
          if (query !== '') {
            const hit =
              workspace.title.toLowerCase().indexOf(query) !== -1 ||
              workspace.path.toLowerCase().indexOf(query) !== -1 ||
              workspace.id.toLowerCase().indexOf(query) !== -1;
            if (!hit) return;
          }
          items.push({
            id: workspace.id,
            title: workspace.title,
            path: workspace.path,
            sessions: workspace.sessions,
            unlisted: false,
          });
        });
      }

      const fallback =
        noWorkspaces && selected.length > 0
          ? h(
              'div',
              { className: 'skm-bindFallback' },
              h('p', { className: 'skm-bindFallbackNote' }, t('boundFallbackHint')),
              h(
                'div',
                { className: 'skm-bindIdChips' },
                selected.map(function (id) {
                  return h(
                    'button',
                    {
                      type: 'button',
                      key: 'skm-ws-chip-' + id,
                      className: 'skm-chipId',
                      'aria-label': t('removeBinding', { name: id }),
                      title: t('removeBinding', { name: id }),
                      onClick: function () {
                        props.onToggle(id);
                      },
                    },
                    h('span', { className: 'skm-chipIdText' }, shortId(id)),
                    h(IconClose),
                  );
                }),
              ),
            )
          : null;

      const list =
        items.length === 0
          ? h(
              'p',
              { className: 'skm-bindEmpty' },
              noWorkspaces ? t('workspacesEmpty') : t('bindingEmpty'),
            )
          : items.map(function (item) {
              const checked = selected.indexOf(item.id) !== -1;
              const disabled = props.saving || (!checked && atLimit);
              const title = item.unlisted ? t('unlistedWorkspace') : item.title || t('untitledWorkspace');
              const isCurrent = !item.unlisted && currentId !== null && currentId === item.id;
              return h(
                'label',
                {
                  className: 'skm-bindItem',
                  key: item.id,
                  'data-checked': checked ? 'true' : 'false',
                },
                h('input', {
                  type: 'checkbox',
                  className: 'skm-bindCheck',
                  checked: checked,
                  disabled: disabled,
                  onChange: function () {
                    props.onToggle(item.id);
                  },
                }),
                h(
                  'span',
                  { className: 'skm-bindBody' },
                  h(
                    'span',
                    { className: 'skm-bindTitleRow' },
                    h('span', { className: 'skm-bindTitle', title: title }, title),
                    isCurrent
                      ? h('span', { className: 'skm-badge skm-badgeCurrent' }, t('currentWorkspace'))
                      : null,
                    item.sessions > 0
                      ? h(
                          'span',
                          { className: 'skm-bindMeta' },
                          t('workspaceSessions', { count: item.sessions }),
                        )
                      : null,
                  ),
                  item.path !== ''
                    ? h('span', { className: 'skm-bindPath', title: item.path }, item.path)
                    : item.unlisted
                      ? h('span', { className: 'skm-bindPath' }, item.id)
                      : null,
                ),
              );
            });

      return h(
        'div',
        { className: 'skm-bind' },
        h('p', { className: 'skm-bindHelp' }, t('bindingHelp')),
        fallback,
        h(
          'div',
          { className: 'skm-bindBar' },
          h(
            'div',
            { className: 'skm-bindSearch' },
            h(IconSearch),
            h('input', {
              type: 'search',
              value: workspaceQuery,
              placeholder: t('bindingSearch'),
              'aria-label': t('bindingSearch'),
              onChange: function (event) {
                setWorkspaceQuery(event.target.value);
              },
            }),
          ),
          h(
            'span',
            { className: 'skm-bindCount' },
            selected.length > 0
              ? t('bindingSelected', { count: selected.length })
              : t('bindingNone'),
          ),
          selected.length > 0
            ? h(
                'button',
                {
                  type: 'button',
                  className: 'skm-linkBtn',
                  onClick: props.onClear,
                  disabled: props.saving,
                },
                t('bindingClear'),
              )
            : null,
        ),
        h('div', { className: 'skm-bindList', role: 'group', 'aria-label': t('toggleBindings') }, list),
        atLimit ? h('p', { className: 'skm-bindHint' }, t('bindingLimit')) : null,
      );
    }

    /**
     * Tag section of the expanded detail: user tags are removable, AI tags are
     * muted. Every change POSTs the full { user, muted } arrays via setTags.
     */
    function TagsPanel(props) {
      const t = props.t;
      const skill = props.skill;
      const busy = props.busy === true;
      const [draft, setDraft] = React.useState('');
      const [hint, setHint] = React.useState('');
      const inputRef = React.useRef(null);

      React.useEffect(
        function () {
          if (!props.autoFocus) return;
          const input = inputRef.current;
          if (input && typeof input.focus === 'function') input.focus();
        },
        [props.autoFocus],
      );

      const userTags = skill.tags.filter(function (tag) {
        return tag.source !== 'ai';
      });
      const userTexts = userTags.map(function (tag) {
        return tag.text;
      });

      function submit() {
        const text = draft.trim();
        if (text === '') return;
        const duplicate = userTexts.some(function (existing) {
          return existing.toLowerCase() === text.toLowerCase();
        });
        if (duplicate) {
          setHint(t('tagDuplicate'));
          return;
        }
        if (userTexts.length >= USER_TAG_LIMIT) {
          setHint(t('tagLimit'));
          return;
        }
        setHint('');
        setDraft('');
        props.onAdd(text);
      }

      const chips = skill.tags.map(function (tag) {
        const isAi = tag.source === 'ai';
        const removeLabel = t(isAi ? 'tagMute' : 'tagRemove', { name: tag.text });
        return h(
          'span',
          {
            key: 'skm-tag-chip-' + tag.text,
            className: 'skm-tagChip skm-tagChipEditable' + (isAi ? ' skm-tagChipAi' : ''),
            title: isAi ? t('tagAiTooltip') : undefined,
          },
          isAi ? h('span', { className: 'skm-tagAiMark', 'aria-hidden': 'true' }, '✨') : null,
          h('span', { className: 'skm-tagText' }, tag.text),
          h(
            'button',
            {
              type: 'button',
              className: 'skm-tagRemove',
              'aria-label': removeLabel,
              title: removeLabel,
              disabled: busy,
              onClick: function () {
                if (isAi) props.onMute(tag.text);
                else props.onRemove(tag.text);
              },
            },
            h(IconClose),
          ),
        );
      });

      return h(
        'div',
        { className: 'skm-bind skm-tags' },
        skill.tags.length === 0
          ? h('p', { className: 'skm-tagsEmpty' }, t('tagsEmpty'))
          : h('div', { className: 'skm-tagList' }, chips),
        h(
          'div',
          { className: 'skm-tagAdd' },
          h('input', {
            type: 'text',
            className: 'skm-tagInput',
            ref: inputRef,
            value: draft,
            maxLength: TAG_TEXT_LIMIT,
            placeholder: t('tagAddPlaceholder'),
            'aria-label': t('tagAddPlaceholder'),
            disabled: busy,
            onChange: function (event) {
              setDraft(event.target.value);
              if (hint !== '') setHint('');
            },
            onKeyDown: function (event) {
              if (event.key !== 'Enter') return;
              event.preventDefault();
              submit();
            },
          }),
          h(
            'button',
            { type: 'button', className: 'skm-btn skm-btnSm', onClick: submit, disabled: busy },
            t('tagAdd'),
          ),
        ),
        hint !== '' ? h('p', { className: 'skm-tagHint' }, hint) : null,
        h(
          'div',
          { className: 'skm-tagMeta' },
          h('span', null, t('historyInstalled') + ' ' + formatDateTime(skill.installedAt)),
          h('span', null, t('historyUpdated') + ' ' + formatDateTime(skill.updatedAt)),
        ),
      );
    }

    /* --------------------------------------------------------------------
     * Shared row/card renderers — one implementation for both layouts
     * ------------------------------------------------------------------ */

    function skillSourceText(t, skill) {
      const sourceKey = SOURCE_LABELS[skill.source];
      return sourceKey ? t(sourceKey) : skill.source || t('sourceOther');
    }

    /** Tag chips; `max` caps the visible count and appends a `+N` chip. */
    function renderTagChips(options) {
      const t = options.t;
      const tags = options.tags || [];
      if (tags.length === 0) return null;
      const activeTags = options.activeTags || [];
      const max = typeof options.max === 'number' ? options.max : tags.length;
      const visible = tags.slice(0, max);
      const hidden = tags.slice(max);
      return h(
        'span',
        { className: options.className || 'skm-rowTags' },
        visible.map(function (tag) {
          const isAi = tag.source === 'ai';
          const active = activeTags.indexOf(tag.text) !== -1;
          return h(
            'button',
            {
              key: 'skm-tag-' + tag.text,
              type: 'button',
              className: 'skm-tagChip' + (isAi ? ' skm-tagChipAi' : ''),
              'aria-pressed': active ? 'true' : 'false',
              title: isAi ? t('tagAiTooltip') : tag.text,
              onClick: function (event) {
                event.stopPropagation();
                options.onTagToggle(tag.text);
              },
            },
            isAi ? h('span', { className: 'skm-tagAiMark', 'aria-hidden': 'true' }, '\u2728') : null,
            h('span', { className: 'skm-tagText' }, tag.text),
          );
        }),
        hidden.length > 0
          ? h(
              'span',
              {
                className: 'skm-tagMore',
                title: hidden
                  .map(function (tag) {
                    return tag.text;
                  })
                  .join(' · '),
              },
              '+' + hidden.length,
            )
          : null,
      );
    }

    function renderSwitchButton(options) {
      const t = options.t;
      const skill = options.skill;
      const label = t(skill.enabled ? 'disableSkill' : 'enableSkill', { name: skill.name });
      return h(
        'button',
        {
          type: 'button',
          role: 'switch',
          className: 'skm-switch',
          'aria-checked': skill.enabled ? 'true' : 'false',
          'aria-label': label,
          title: label,
          disabled: options.busy,
          onClick: options.onToggleEnabled,
        },
        h('span', { className: 'skm-switchThumb' }),
      );
    }

    /** ⋯ button + popover; identical in the list and the cards layout. */
    function renderMenu(options) {
      const t = options.t;
      const skill = options.skill;
      const menuId = 'skm-menu-' + skill.name;
      const items = [
        h(
          'button',
          { key: 'bindings', type: 'button', className: 'skm-menuItem', role: 'menuitem', onClick: options.onOpenDetail },
          h(IconLink),
          t('menuBindings'),
        ),
        h(
          'button',
          { key: 'tags', type: 'button', className: 'skm-menuItem', role: 'menuitem', onClick: options.onEditTags },
          h(IconTag),
          t('menuTags'),
        ),
      ];
      if (skill.deletable) {
        items.push(
          h(
            'button',
            {
              key: 'delete',
              type: 'button',
              className: 'skm-menuItem skm-menuDanger',
              role: 'menuitem',
              onClick: options.onAskDelete,
            },
            h(IconTrash),
            t('menuDelete'),
          ),
        );
      }
      return h(
        'div',
        { className: 'skm-menuWrap', ref: options.open ? options.menuRef : undefined },
        h(
          'button',
          {
            type: 'button',
            className: 'skm-iconBtn',
            'aria-label': t('moreActions'),
            'aria-haspopup': 'menu',
            'aria-expanded': options.open ? 'true' : 'false',
            'aria-controls': options.open ? menuId : undefined,
            title: t('moreActions'),
            ref: options.open ? options.menuTriggerRef : undefined,
            onClick: options.onToggleMenu,
            disabled: options.busy,
          },
          h(IconMore),
        ),
        options.open
          ? h(
              'div',
              { className: 'skm-menu', id: menuId, role: 'menu', 'data-up': options.menuUp ? 'true' : 'false' },
              items,
            )
          : null,
      );
    }

    /** Expanded detail (workspace picker + tag editor), shared by row and card. */
    function renderDetail(options) {
      const t = options.t;
      const skill = options.skill;
      return h(
        'div',
        { id: 'skm-detail-' + skill.name, className: 'skm-detail' },
        h(
          'section',
          { className: 'skm-detailSection' },
          h('h3', { className: 'skm-detailHeading' }, t('detailWorkspaces')),
          h(WorkspacePanel, {
            t: t,
            workspaces: options.workspaces,
            selected: options.bound,
            saving: options.busy,
            currentWorkspaceId: options.currentWorkspaceId,
            onToggle: options.onWorkspaceToggle,
            onClear: options.onClearBindings,
          }),
        ),
        h(
          'section',
          { className: 'skm-detailSection' },
          h('h3', { className: 'skm-detailHeading' }, t('detailTags')),
          h(TagsPanel, {
            t: t,
            skill: skill,
            busy: options.tagBusy,
            autoFocus: options.autoFocusTags,
            onAdd: options.onTagAdd,
            onRemove: options.onTagRemove,
            onMute: options.onTagMute,
          }),
        ),
      );
    }

    function renderDeleteConfirm(options) {
      const t = options.t;
      const skill = options.skill;
      return h(
        'div',
        { className: 'skm-confirm', role: 'group', 'aria-label': t('menuDelete') },
        h('span', { className: 'skm-confirmText' }, t('deleteConfirm', { name: skill.name })),
        h(
          'div',
          { className: 'skm-confirmActions' },
          h(
            'button',
            { type: 'button', className: 'skm-btn', onClick: options.onCancelDelete, disabled: options.busy },
            t('cancel'),
          ),
          h(
            'button',
            { type: 'button', className: 'skm-btn skm-btnDanger', onClick: options.onDelete, disabled: options.busy },
            options.busy ? t('deleting') : t('delete'),
          ),
        ),
      );
    }

    /** Expand affordance: the same chevron button in rows and cards. */
    function renderExpandButton(options) {
      const t = options.t;
      const open = !!options.open;
      return h(
        'button',
        {
          type: 'button',
          className: 'skm-iconBtn',
          'aria-label': t('detailToggle'),
          'aria-expanded': open ? 'true' : 'false',
          'aria-controls': open ? 'skm-detail-' + options.skill.name : undefined,
          title: t('detailToggle'),
          onClick: options.onToggleDetail,
          disabled: options.busy,
        },
        h('span', { className: 'skm-chevron', 'data-open': open ? 'true' : 'false' }, h(IconChevron)),
      );
    }

    /** List-layout row (unchanged markup/behaviour). */
    function SkillRow(props) {
      const t = props.t;
      const skill = props.skill;
      const boundCount = props.bound.length;
      const sourceText = skillSourceText(t, skill);

      return h(
        'li',
        { className: 'skm-card', 'data-open': props.openDetail || props.confirming ? 'true' : 'false' },
        h(
          'div',
          { className: 'skm-cardMain' },
          h(
            'div',
            { className: 'skm-tile', style: tileStyle(skill.name), 'aria-hidden': 'true' },
            (skill.name.charAt(0) || '?').toUpperCase(),
          ),
          h(
            'div',
            { className: 'skm-body' },
            h(
              'div',
              { className: 'skm-line1' },
              h('span', { className: 'skm-name', title: skill.name }, skill.name),
              h('span', { className: 'skm-badge' }, sourceText),
              boundCount > 0
                ? h(
                    'span',
                    { className: 'skm-badge skm-badgeBound' },
                    h(IconLink),
                    t('boundBadge', { count: boundCount }),
                  )
                : null,
              h('span', { className: 'skm-calls' }, t('calls', { count: skill.calls })),
              renderTagChips({
                t: t,
                tags: skill.tags,
                activeTags: props.activeTags,
                onTagToggle: props.onTagToggle,
              }),
            ),
            h(
              'p',
              { className: 'skm-desc' + (skill.description ? '' : ' skm-descEmpty') },
              skill.description || t('noDescription'),
            ),
          ),
          h(
            'div',
            { className: 'skm-actions' },
            renderExpandButton({
              t: t,
              skill: skill,
              open: props.openDetail,
              onToggleDetail: props.onToggleDetail,
              busy: props.busy,
            }),
            renderSwitchButton({
              t: t,
              skill: skill,
              busy: props.busy,
              onToggleEnabled: props.onToggleEnabled,
            }),
            renderMenu({
              t: t,
              skill: skill,
              open: props.openMenu,
              busy: props.busy,
              menuUp: props.menuUp,
              menuRef: props.menuRef,
              menuTriggerRef: props.menuTriggerRef,
              onToggleMenu: props.onToggleMenu,
              onOpenDetail: props.onOpenDetail,
              onEditTags: props.onEditTags,
              onAskDelete: props.onAskDelete,
            }),
          ),
        ),
        props.openDetail
          ? renderDetail({
              t: t,
              skill: skill,
              workspaces: props.workspaces,
              bound: props.bound,
              busy: props.busy,
              tagBusy: props.tagBusy,
              autoFocusTags: props.autoFocusTags,
              currentWorkspaceId: props.currentWorkspaceId,
              onWorkspaceToggle: props.onWorkspaceToggle,
              onClearBindings: props.onClearBindings,
              onTagAdd: props.onTagAdd,
              onTagRemove: props.onTagRemove,
              onTagMute: props.onTagMute,
            })
          : null,
        props.confirming
          ? renderDeleteConfirm({
              t: t,
              skill: skill,
              busy: props.busy,
              onCancelDelete: props.onCancelDelete,
              onDelete: props.onDelete,
            })
          : null,
      );
    }

    /** Cards (grid) layout: compact stacked card, detail spans the full grid. */
    function SkillCard(props) {
      const t = props.t;
      const skill = props.skill;
      const boundCount = props.bound.length;
      const sourceText = skillSourceText(t, skill);
      const meta = [
        h('span', { key: 'calls', className: 'skm-gridMetaText' }, t('calls', { count: skill.calls })),
        h('span', { key: 'dot-1', className: 'skm-gridDot', 'aria-hidden': 'true' }),
        h(
          'span',
          { key: 'updated', className: 'skm-gridMetaText' },
          t('historyUpdated') + ' ' + formatDateShort(skill.updatedAt),
        ),
      ];
      if (boundCount > 0) {
        meta.push(h('span', { key: 'dot-2', className: 'skm-gridDot', 'aria-hidden': 'true' }));
        meta.push(
          h(
            'span',
            { key: 'bound', className: 'skm-gridMetaText' },
            t('boundBadge', { count: boundCount }),
          ),
        );
      }

      return h(
        'li',
        {
          className: 'skm-gridCard' + (props.openDetail ? ' skm-gridCardOpen' : ''),
          'data-open': props.openDetail || props.confirming ? 'true' : 'false',
        },
        h(
          'div',
          { className: 'skm-gridHead' },
          h(
            'div',
            { className: 'skm-gridTitleRow' },
            h('span', { className: 'skm-name', title: skill.name }, skill.name),
            h('span', { className: 'skm-badge' }, sourceText),
          ),
          h(
            'div',
            { className: 'skm-gridHeadActions' },
            renderSwitchButton({
              t: t,
              skill: skill,
              busy: props.busy,
              onToggleEnabled: props.onToggleEnabled,
            }),
            renderMenu({
              t: t,
              skill: skill,
              open: props.openMenu,
              busy: props.busy,
              menuUp: false,
              menuRef: props.menuRef,
              menuTriggerRef: props.menuTriggerRef,
              onToggleMenu: props.onToggleMenu,
              onOpenDetail: props.onOpenDetail,
              onEditTags: props.onEditTags,
              onAskDelete: props.onAskDelete,
            }),
          ),
        ),
        h(
          'p',
          { className: 'skm-desc' + (skill.description ? '' : ' skm-descEmpty') },
          skill.description || t('noDescription'),
        ),
        skill.tags.length > 0
          ? h(
              'div',
              { className: 'skm-gridTags' },
              renderTagChips({
                t: t,
                tags: skill.tags,
                activeTags: props.activeTags,
                onTagToggle: props.onTagToggle,
                max: 3,
              }),
            )
          : null,
        h(
          'div',
          { className: 'skm-gridMeta' },
          meta,
          renderExpandButton({
            t: t,
            skill: skill,
            open: props.openDetail,
            onToggleDetail: props.onToggleDetail,
            busy: props.busy,
          }),
        ),
        props.openDetail
          ? renderDetail({
              t: t,
              skill: skill,
              workspaces: props.workspaces,
              bound: props.bound,
              busy: props.busy,
              tagBusy: props.tagBusy,
              autoFocusTags: props.autoFocusTags,
              currentWorkspaceId: props.currentWorkspaceId,
              onWorkspaceToggle: props.onWorkspaceToggle,
              onClearBindings: props.onClearBindings,
              onTagAdd: props.onTagAdd,
              onTagRemove: props.onTagRemove,
              onTagMute: props.onTagMute,
            })
          : null,
        props.confirming
          ? renderDeleteConfirm({
              t: t,
              skill: skill,
              busy: props.busy,
              onCancelDelete: props.onCancelDelete,
              onDelete: props.onDelete,
            })
          : null,
      );
    }

    /* --------------------------------------------------------------------
     * Page
     * ------------------------------------------------------------------ */

    function SkillManagerPage(props) {
      const t = props && typeof props.t === 'function' ? props.t : fallbackT;

      const [state, setState] = React.useState(createInitialState());
      const [query, setQuery] = React.useState('');
      const [filter, setFilter] = React.useState('all');
      const [sortBy, setSortBy] = React.useState('calls');
      const [tagFilter, setTagFilter] = React.useState([]);
      const [installedRange, setInstalledRange] = React.useState('all');
      const [updatedRange, setUpdatedRange] = React.useState('all');
      const [actionError, setActionError] = React.useState('');
      const [pending, setPending] = React.useState({});
      const [tagBusy, setTagBusy] = React.useState({});
      const [bindDraft, setBindDraft] = React.useState({});
      const [detailOpen, setDetailOpen] = React.useState(null);
      const [detailFocus, setDetailFocus] = React.useState(null);
      const [menuOpen, setMenuOpen] = React.useState(null);
      const [sortOpen, setSortOpen] = React.useState(false);
      const [filterOpen, setFilterOpen] = React.useState(false);
      const [confirming, setConfirming] = React.useState(null);
      const [refreshing, setRefreshing] = React.useState(false);
      /* createInitialState already resolved the persisted layout preference. */
      const [layoutMode, setLayoutMode] = React.useState(function () {
        if (state.layout === 'cards') return 'cards';
        if (state.layout === 'list') return 'list';
        return readLayoutPreference();
      });

      const aliveRef = React.useRef(true);
      const bindSeqRef = React.useRef({});
      const tagSeqRef = React.useRef({});
      const menuRef = React.useRef(null);
      const menuTriggerRef = React.useRef(null);
      const sortRef = React.useRef(null);
      const sortTriggerRef = React.useRef(null);
      const filterRef = React.useRef(null);
      const filterTriggerRef = React.useRef(null);

      /* Re-normalise on render so the page is safe for any payload shape. */
      const payload = state.payload ? normalizePayload(state.payload) : null;
      const skills = payload ? payload.skills : [];
      const workspaces = payload ? payload.workspaces : [];
      const currentWorkspaceId = payload ? payload.currentWorkspaceId : null;
      const summary = payload
        ? payload.summary
        : { total: 0, enabled: 0, disabled: 0, bound: 0, calls: 0 };
      const stats = payload ? payload.stats : { scanning: false, scannedSessions: 0, totalSessions: 0 };
      const scanning = stats.scanning === true;
      /* Older hosts answer without `inventory`: treat them as settled. */
      const inventory = payload
        ? payload.inventory
        : { ready: true, refreshing: false, updatedAt: 0 };
      const inventoryBusy = inventory.refreshing === true || inventory.ready === false;
      const tagOptions = payload ? payload.tags : [];
      const tagging = payload
        ? payload.tagging
        : {
            enabled: false,
            running: false,
            queued: 0,
            lastRunAt: 0,
            lastError: null,
            tagged: 0,
            model: null,
          };
      const taggingRunning = tagging.running === true;
      const pollingBusy = scanning || inventoryBusy || taggingRunning;

      function applyPayload(nextPayload) {
        rememberPayload(nextPayload);
        setState({ status: 'ready', payload: nextPayload, error: null });
      }

      function reportError(error) {
        setActionError(errorMessage(error));
      }

      async function fetchAndApply(silent) {
        try {
          const nextPayload = await getPayload();
          if (!aliveRef.current) return;
          applyPayload(nextPayload);
        } catch (error) {
          if (!aliveRef.current) return;
          if (silent) reportError(error);
          else setState({ status: 'error', payload: null, error: error });
        }
      }

      /* Initial load (and the retry button reuses it). With a cached payload
       * this is a silent background refresh: the cached rows stay on screen. */
      React.useEffect(function () {
        aliveRef.current = true;
        void fetchAndApply(cachedPayload !== null);
        return function () {
          aliveRef.current = false;
        };
      }, []);

      /* Poll while the host reports background work: statistics scan or a skill
       * inventory rescan. Quiet — a transient failure keeps the last payload. */
      React.useEffect(function () {
        if (!pollingBusy) return undefined;
        let cancelled = false;
        let remaining = POLL_LIMIT;
        let timer = 0;
        function step() {
          if (cancelled || remaining <= 0) return;
          remaining -= 1;
          getPayload()
            .then(
              function (nextPayload) {
                if (cancelled || !aliveRef.current) return;
                setState({ status: 'ready', payload: nextPayload, error: null });
              },
              function () {
                /* A failed poll keeps the last good payload. */
              },
            )
            .then(function () {
              if (cancelled) return;
              timer = setTimeout(step, POLL_INTERVAL_MS);
            });
        }
        timer = setTimeout(step, POLL_INTERVAL_MS);
        return function () {
          cancelled = true;
          if (timer) clearTimeout(timer);
        };
      }, [pollingBusy]);

      /* Popovers (row actions, sort, filter): close on Escape and outside pointer
       * down; Escape restores focus to the popover's trigger. */
      React.useEffect(
        function () {
          if (!menuOpen && !sortOpen && !filterOpen) return undefined;
          if (typeof document === 'undefined') return undefined;
          function onPointerDown(event) {
            const target = event.target;
            const insideMenu = menuRef.current && target && menuRef.current.contains(target);
            const insideSort = sortRef.current && target && sortRef.current.contains(target);
            const insideFilter = filterRef.current && target && filterRef.current.contains(target);
            if (insideMenu || insideSort || insideFilter) return;
            setMenuOpen(null);
            setSortOpen(false);
            setFilterOpen(false);
          }
          function onKeyDown(event) {
            if (event.key !== 'Escape') return;
            const trigger = menuOpen
              ? menuTriggerRef.current
              : sortOpen
                ? sortTriggerRef.current
                : filterTriggerRef.current;
            setMenuOpen(null);
            setSortOpen(false);
            setFilterOpen(false);
            if (trigger && typeof trigger.focus === 'function') trigger.focus();
          }
          document.addEventListener('mousedown', onPointerDown, true);
          document.addEventListener('keydown', onKeyDown);
          return function () {
            document.removeEventListener('mousedown', onPointerDown, true);
            document.removeEventListener('keydown', onKeyDown);
          };
        },
        [menuOpen, sortOpen, filterOpen],
      );

      function boundFor(skill) {
        const draft = bindDraft[skill.name];
        return Array.isArray(draft) ? draft : skill.boundWorkspaces;
      }

      async function toggleEnabled(skill) {
        if (pending[skill.name]) return;
        setPending(function (previous) {
          const next = Object.assign({}, previous);
          next[skill.name] = true;
          return next;
        });
        try {
          const nextPayload = await postAction('setEnabled', { name: skill.name, enabled: !skill.enabled });
          if (nextPayload) applyPayload(nextPayload);
          else void fetchAndApply(true);
        } catch (error) {
          reportError(error);
        } finally {
          setPending(function (previous) {
            const next = Object.assign({}, previous);
            delete next[skill.name];
            return next;
          });
        }
      }

      async function saveWorkspaces(skill, nextWorkspaces) {
        const seq = (bindSeqRef.current[skill.name] || 0) + 1;
        bindSeqRef.current[skill.name] = seq;
        setBindDraft(function (previous) {
          const next = Object.assign({}, previous);
          next[skill.name] = nextWorkspaces;
          return next;
        });
        try {
          const nextPayload = await postAction('setWorkspaces', {
            name: skill.name,
            workspaces: nextWorkspaces,
          });
          if (bindSeqRef.current[skill.name] !== seq) return;
          if (nextPayload) applyPayload(nextPayload);
          else void fetchAndApply(true);
        } catch (error) {
          if (bindSeqRef.current[skill.name] === seq) reportError(error);
        } finally {
          if (bindSeqRef.current[skill.name] === seq) {
            setBindDraft(function (previous) {
              const next = Object.assign({}, previous);
              delete next[skill.name];
              return next;
            });
          }
        }
      }

      function toggleWorkspace(skill, workspaceId) {
        const current = boundFor(skill);
        const has = current.indexOf(workspaceId) !== -1;
        if (!has && current.length >= BINDING_LIMIT) return;
        const next = has
          ? current.filter(function (id) {
              return id !== workspaceId;
            })
          : current.concat([workspaceId]);
        void saveWorkspaces(skill, next);
      }

      async function deleteSkill(skill) {
        if (pending[skill.name]) return;
        setPending(function (previous) {
          const next = Object.assign({}, previous);
          next[skill.name] = true;
          return next;
        });
        try {
          const nextPayload = await postAction('delete', { name: skill.name });
          if (nextPayload) applyPayload(nextPayload);
          else void fetchAndApply(true);
          setConfirming(null);
          setMenuOpen(null);
          setDetailOpen(null);
        } catch (error) {
          reportError(error);
        } finally {
          setPending(function (previous) {
            const next = Object.assign({}, previous);
            delete next[skill.name];
            return next;
          });
        }
      }

      async function refreshStats() {
        if (refreshing || scanning) return;
        setRefreshing(true);
        try {
          const nextPayload = await postAction('refreshStats');
          if (nextPayload) applyPayload(nextPayload);
          else await fetchAndApply(true);
        } catch (error) {
          reportError(error);
        } finally {
          setRefreshing(false);
        }
      }

      function toggleDetail(skill) {
        setMenuOpen(null);
        setDetailFocus(null);
        setDetailOpen(function (previous) {
          return previous === skill.name ? null : skill.name;
        });
      }

      function openDetail(skill, focusTags) {
        setMenuOpen(null);
        setDetailOpen(skill.name);
        setDetailFocus(focusTags ? skill.name : null);
      }

      function effectiveMuted(skill) {
        return unionTexts(skill.mutedTags, mutedTagsCache[skill.name] || []);
      }

      function userTagTexts(skill) {
        return skill.tags
          .filter(function (tag) {
            return tag.source !== 'ai';
          })
          .map(function (tag) {
            return tag.text;
          });
      }

      async function saveTags(skill, userTexts, mutedTexts) {
        const seq = (tagSeqRef.current[skill.name] || 0) + 1;
        tagSeqRef.current[skill.name] = seq;
        mutedTagsCache[skill.name] = mutedTexts;
        setTagBusy(function (previous) {
          const next = Object.assign({}, previous);
          next[skill.name] = true;
          return next;
        });
        try {
          const nextPayload = await postAction('setTags', {
            name: skill.name,
            user: userTexts,
            muted: mutedTexts,
          });
          if (tagSeqRef.current[skill.name] !== seq) return;
          if (nextPayload) applyPayload(nextPayload);
          else void fetchAndApply(true);
        } catch (error) {
          if (tagSeqRef.current[skill.name] === seq) reportError(error);
        } finally {
          if (tagSeqRef.current[skill.name] === seq) {
            setTagBusy(function (previous) {
              const next = Object.assign({}, previous);
              delete next[skill.name];
              return next;
            });
          }
        }
      }

      function addUserTag(skill, text) {
        if (userTagTexts(skill).length >= USER_TAG_LIMIT) return;
        void saveTags(skill, userTagTexts(skill).concat([text]), effectiveMuted(skill));
      }

      function removeUserTag(skill, text) {
        void saveTags(
          skill,
          userTagTexts(skill).filter(function (existing) {
            return existing !== text;
          }),
          effectiveMuted(skill),
        );
      }

      function muteAiTag(skill, text) {
        void saveTags(skill, userTagTexts(skill), unionTexts(effectiveMuted(skill), [text]));
      }

      async function requestTagNow() {
        if (taggingRunning || tagging.enabled !== true) return;
        try {
          const nextPayload = await postAction('tagNow');
          if (nextPayload) applyPayload(nextPayload);
          else void fetchAndApply(true);
        } catch (error) {
          reportError(error);
        }
      }

      function toggleTagFilter(text) {
        setTagFilter(function (previous) {
          if (previous.indexOf(text) !== -1) {
            return previous.filter(function (existing) {
              return existing !== text;
            });
          }
          return previous.concat([text]);
        });
      }

      function resetAllFilters() {
        setFilter('all');
        setQuery('');
        setTagFilter([]);
        setInstalledRange('all');
        setUpdatedRange('all');
      }

      function clearFilters() {
        setQuery('');
        setFilter('all');
      }

      /** Switch list/cards and persist it (module fallback + localStorage). */
      function chooseLayout(next) {
        if (next !== 'list' && next !== 'cards') return;
        writeLayoutPreference(next);
        setLayoutMode(next);
      }

      const layoutToggle = h(
        'div',
        { className: 'skm-segment', role: 'group', 'aria-label': t('layoutLabel') },
        h(
          'button',
          {
            type: 'button',
            className: 'skm-segBtn',
            'aria-pressed': layoutMode === 'list' ? 'true' : 'false',
            'aria-label': t('layoutList'),
            title: t('layoutList'),
            onClick: function () {
              chooseLayout('list');
            },
          },
          h(IconList),
        ),
        h(
          'button',
          {
            type: 'button',
            className: 'skm-segBtn',
            'aria-pressed': layoutMode === 'cards' ? 'true' : 'false',
            'aria-label': t('layoutCards'),
            title: t('layoutCards'),
            onClick: function () {
              chooseLayout('cards');
            },
          },
          h(IconGrid),
        ),
      );

      const activeFilterCount =
        (tagFilter.length > 0 ? 1 : 0) +
        (installedRange !== 'all' ? 1 : 0) +
        (updatedRange !== 'all' ? 1 : 0);

      const normalizedQuery = query.trim().toLowerCase();
      const now = Date.now();
      const filteredRows = skills.filter(function (skill) {
        if (filter === 'enabled' && !skill.enabled) return false;
        if (filter === 'disabled' && skill.enabled) return false;
        if (filter === 'bound' && skill.boundWorkspaces.length === 0) return false;
        if (tagFilter.length > 0) {
          const hit = skill.tags.some(function (tag) {
            return tagFilter.indexOf(tag.text) !== -1;
          });
          if (!hit) return false;
        }
        if (!inTimeRange(skill.installedAt, installedRange, now)) return false;
        if (!inTimeRange(skill.updatedAt, updatedRange, now)) return false;
        if (normalizedQuery === '') return true;
        return (
          skill.name.toLowerCase().indexOf(normalizedQuery) !== -1 ||
          skill.description.toLowerCase().indexOf(normalizedQuery) !== -1
        );
      });

      function compareName(left, right) {
        return left.name < right.name ? -1 : left.name > right.name ? 1 : 0;
      }

      /* Sort after search+filter; null timestamps last, name breaks ties. */
      function compareRows(left, right) {
        let primary = 0;
        if (sortBy === 'calls') primary = right.calls - left.calls;
        else if (sortBy === 'installed') primary = timeDesc(left.installedAt, right.installedAt);
        else if (sortBy === 'updated') primary = timeDesc(left.updatedAt, right.updatedAt);
        return primary !== 0 ? primary : compareName(left, right);
      }

      const rows = filteredRows.slice().sort(compareRows);

      const refreshDisabled = refreshing || scanning || state.status === 'loading';
      const refreshLabel = refreshing || scanning ? t('refreshStatsBusy') : t('refreshStats');

      const header = h(
        'header',
        { className: 'skm-header' },
        h(
          'div',
          { className: 'skm-heading' },
          h('h1', { className: 'skm-title' }, t('title')),
          h('p', { className: 'skm-subtitle' }, t('subtitle')),
        ),
        h(
          'button',
          {
            type: 'button',
            className: 'skm-btn',
            onClick: refreshStats,
            disabled: refreshDisabled,
            'aria-busy': refreshing ? 'true' : 'false',
          },
          h(IconRefresh),
          h('span', null, refreshLabel),
        ),
      );

      /* Chrome (title/subtitle/refresh + toolbar) renders in every state; only
       * the list area ever shows the skeleton or the load-error card. */
      const chips = [
        { id: 'all', label: t('filterAll'), count: summary.total },
        { id: 'enabled', label: t('filterEnabled'), count: summary.enabled },
        { id: 'disabled', label: t('filterDisabled'), count: summary.disabled },
        { id: 'bound', label: t('filterBound'), count: summary.bound },
      ];

      const searchField = h(
        'div',
        { className: 'skm-search' },
        h('span', { className: 'skm-searchIcon' }, h(IconSearch)),
        h('input', {
          type: 'search',
          className: 'skm-searchInput',
          value: query,
          placeholder: t('searchPlaceholder'),
          'aria-label': t('searchLabel'),
          onChange: function (event) {
            setQuery(event.target.value);
          },
        }),
        query !== ''
          ? h(
              'button',
              {
                type: 'button',
                className: 'skm-searchClear',
                'aria-label': t('clearSearch'),
                title: t('clearSearch'),
                onClick: function () {
                  setQuery('');
                },
              },
              h(IconClose),
            )
          : null,
      );

      const chipList = h(
        'div',
        { className: 'skm-chips', role: 'group', 'aria-label': t('searchLabel') },
        chips.map(function (chip) {
          return h(
            'button',
            {
              key: chip.id,
              type: 'button',
              className: 'skm-chip',
              'aria-pressed': filter === chip.id ? 'true' : 'false',
              onClick: function () {
                setFilter(chip.id);
              },
            },
            h('span', null, chip.label),
            h('span', { className: 'skm-chipCount' }, String(chip.count)),
          );
        }),
      );

      /* Toolbar controls: sort popover, filter popover, AI tagging trigger. */
      const sortLabel = t(SORT_LABELS[sortBy] || 'sortCalls');
      const sortControl = h(
        'div',
        { className: 'skm-menuWrap', ref: sortRef },
        h(
          'button',
          {
            type: 'button',
            className: 'skm-toolBtn',
            'aria-haspopup': 'menu',
            'aria-expanded': sortOpen ? 'true' : 'false',
            'aria-label': t('sortMenuLabel'),
            title: t('sortMenuLabel'),
            ref: sortTriggerRef,
            onClick: function () {
              setFilterOpen(false);
              setMenuOpen(null);
              setSortOpen(function (previous) {
                return !previous;
              });
            },
          },
          h(IconSort),
          h('span', null, sortLabel),
          h('span', { className: 'skm-toolChevron' }, h(IconChevronDown)),
        ),
        sortOpen
          ? h(
              'div',
              { className: 'skm-menu skm-sortMenu', role: 'menu', 'aria-label': t('sortMenuLabel') },
              SORT_OPTIONS.map(function (option) {
                return h(
                  'button',
                  {
                    key: 'skm-sort-' + option,
                    type: 'button',
                    className: 'skm-menuItem',
                    role: 'menuitemradio',
                    'aria-checked': sortBy === option ? 'true' : 'false',
                    onClick: function () {
                      setSortBy(option);
                      setSortOpen(false);
                    },
                  },
                  h('span', { className: 'skm-menuCheck' }, sortBy === option ? h(IconCheck) : null),
                  t(SORT_LABELS[option]),
                );
              }),
            )
          : null,
      );

      const rangeGroup = function (labelKey, value, onChange) {
        return h(
          'div',
          { className: 'skm-filterSection' },
          h('div', { className: 'skm-filterLabel' }, t(labelKey)),
          h(
            'div',
            { className: 'skm-filterRadios', role: 'radiogroup', 'aria-label': t(labelKey) },
            RANGE_OPTIONS.map(function (range) {
              return h(
                'button',
                {
                  key: 'skm-range-' + labelKey + '-' + range,
                  type: 'button',
                  className: 'skm-filterRadio',
                  role: 'radio',
                  'aria-checked': value === range ? 'true' : 'false',
                  onClick: function () {
                    onChange(range);
                  },
                },
                t(RANGE_LABELS[range]),
              );
            }),
          ),
        );
      };

      const filterPopover = h(
        'div',
        { className: 'skm-menu skm-filterMenu', role: 'group', 'aria-label': t('filterButton') },
        h(
          'div',
          { className: 'skm-filterSection' },
          h('div', { className: 'skm-filterLabel' }, t('filterTags')),
          tagOptions.length === 0
            ? h('p', { className: 'skm-filterEmpty' }, t('filterNoTags'))
            : h(
                'div',
                { className: 'skm-filterTags' },
                tagOptions.map(function (option) {
                  const active = tagFilter.indexOf(option.text) !== -1;
                  return h(
                    'button',
                    {
                      key: 'skm-filter-tag-' + option.text,
                      type: 'button',
                      className: 'skm-tagToggle',
                      'aria-pressed': active ? 'true' : 'false',
                      onClick: function () {
                        toggleTagFilter(option.text);
                      },
                    },
                    h('span', null, option.text),
                    h('span', { className: 'skm-chipCount' }, String(option.count)),
                  );
                }),
              ),
          tagFilter.length > 0
            ? h(
                'button',
                {
                  type: 'button',
                  className: 'skm-linkBtn skm-filterClear',
                  onClick: function () {
                    setTagFilter([]);
                  },
                },
                t('filterClearTags'),
              )
            : null,
        ),
        rangeGroup('filterInstalled', installedRange, setInstalledRange),
        rangeGroup('filterUpdated', updatedRange, setUpdatedRange),
        h(
          'div',
          { className: 'skm-filterFooter' },
          h('button', { type: 'button', className: 'skm-linkBtn', onClick: resetAllFilters }, t('filterReset')),
        ),
      );

      const filterControl = h(
        'div',
        { className: 'skm-menuWrap', ref: filterRef },
        h(
          'button',
          {
            type: 'button',
            className: 'skm-toolBtn' + (activeFilterCount > 0 ? ' skm-toolBtnActive' : ''),
            'aria-haspopup': 'true',
            'aria-expanded': filterOpen ? 'true' : 'false',
            'aria-label':
              activeFilterCount > 0
                ? t('filterButtonAria', { count: activeFilterCount })
                : t('filterButton'),
            title: t('filterButton'),
            ref: filterTriggerRef,
            onClick: function () {
              setSortOpen(false);
              setMenuOpen(null);
              setFilterOpen(function (previous) {
                return !previous;
              });
            },
          },
          h(IconFilter),
          h('span', null, t('filterButton')),
          activeFilterCount > 0 ? h('span', { className: 'skm-filterCount' }, String(activeFilterCount)) : null,
        ),
        filterOpen ? filterPopover : null,
      );

      const aiTagButton = h(
        'button',
        {
          type: 'button',
          className: 'skm-toolBtn',
          onClick: requestTagNow,
          disabled: tagging.enabled !== true || taggingRunning,
          title: tagging.enabled === true ? t('aiTagButton') : t('aiTaggingDisabled'),
        },
        h(IconSparkles),
        h('span', null, taggingRunning ? t('aiTaggingRunning') : t('aiTagButton')),
      );

      const toolbarActions = h(
        'div',
        { className: 'skm-toolbarActions' },
        layoutToggle,
        sortControl,
        filterControl,
        aiTagButton,
      );

      /* The host may be rescanning skills while we already show rows. */
      const showSyncHint =
        inventory.refreshing === true || (inventory.ready === false && skills.length === 0);

      const statsLine = payload
        ? h(
            'div',
            { className: 'skm-stats' },
            h(
              'span',
              { className: 'skm-statsText', 'aria-live': 'polite' },
              t('summary', {
                total: summary.total,
                enabled: summary.enabled,
                disabled: summary.disabled,
                calls: summary.calls,
              }),
            ),
            h(
              'span',
              { className: 'skm-aiStatus' },
              h(
                'span',
                { className: 'skm-aiStatusText' },
                t('aiTagged', { tagged: tagging.tagged, total: summary.total }),
              ),
              tagging.lastError
                ? h('span', {
                    className: 'skm-warnDot',
                    title: tagging.lastError,
                    'aria-label': tagging.lastError,
                  })
                : null,
            ),
            showSyncHint
              ? h(
                  'span',
                  { className: 'skm-scanning skm-syncing' },
                  h('span', { className: 'skm-dot', 'aria-hidden': 'true' }),
                  h('span', { className: 'skm-syncingText' }, t('syncingSkills')),
                )
              : null,
            scanning
              ? h(
                  'span',
                  { className: 'skm-scanning' },
                  h('span', { className: 'skm-dot', 'aria-hidden': 'true' }),
                  h('span', { className: 'skm-scanningText' }, t('scanning')),
                  stats.totalSessions > 0
                    ? h(
                        'span',
                        { className: 'skm-scanningProgress' },
                        t('scanned', { scanned: stats.scannedSessions, total: stats.totalSessions }),
                      )
                    : null,
                )
              : null,
          )
        : null;

      const errorBar =
        actionError !== ''
          ? h(
              'div',
              { className: 'skm-errorBar', role: 'alert' },
              h('span', { className: 'skm-errorBarText' }, t('actionFailed', { message: actionError })),
              h(
                'button',
                {
                  type: 'button',
                  className: 'skm-errorBarClose',
                  'aria-label': t('dismiss'),
                  title: t('dismiss'),
                  onClick: function () {
                    setActionError('');
                  },
                },
                h(IconClose),
              ),
            )
          : null;

      /* First paint or an empty-but-unready inventory shows the skeleton;
       * the real empty state only appears once the host says it is settled. */
      const showSkeleton =
        state.status === 'loading' || (skills.length === 0 && inventoryBusy);

      let listArea;
      if (state.status === 'error') {
        listArea = h(ErrorState, {
          t: t,
          message: errorMessage(state.error),
          onRetry: function () {
            setState(createInitialState());
            void fetchAndApply(false);
          },
        });
      } else if (showSkeleton) {
        listArea = h(LoadingSkeleton, { layout: layoutMode });
      } else if (rows.length === 0) {
        listArea = h(EmptyState, {
          t: t,
          kind: skills.length === 0 ? 'none' : 'filtered',
          onClear: clearFilters,
        });
      } else {
        const buildItemProps = function (skill, index) {
          return {
            key: skill.name,
            skill: skill,
            t: t,
            workspaces: workspaces,
            currentWorkspaceId: currentWorkspaceId,
            bound: boundFor(skill),
            openDetail: detailOpen === skill.name,
            autoFocusTags: detailOpen === skill.name && detailFocus === skill.name,
            tagBusy: !!tagBusy[skill.name],
            activeTags: tagFilter,
            openMenu: menuOpen === skill.name,
            confirming: confirming === skill.name,
            busy: !!pending[skill.name],
            menuUp: layoutMode === 'list' && index >= rows.length - 2,
            menuRef: menuRef,
            menuTriggerRef: menuTriggerRef,
            onToggleDetail: function () {
              toggleDetail(skill);
            },
            onOpenDetail: function () {
              openDetail(skill, false);
            },
            onEditTags: function () {
              openDetail(skill, true);
            },
            onTagToggle: function (text) {
              toggleTagFilter(text);
            },
            onTagAdd: function (text) {
              addUserTag(skill, text);
            },
            onTagRemove: function (text) {
              removeUserTag(skill, text);
            },
            onTagMute: function (text) {
              muteAiTag(skill, text);
            },
            onToggleEnabled: function () {
              void toggleEnabled(skill);
            },
            onToggleMenu: function () {
              setMenuOpen(menuOpen === skill.name ? null : skill.name);
            },
            onAskDelete: function () {
              setMenuOpen(null);
              setConfirming(skill.name);
            },
            onCancelDelete: function () {
              setConfirming(null);
            },
            onDelete: function () {
              void deleteSkill(skill);
            },
            onWorkspaceToggle: function (workspaceId) {
              toggleWorkspace(skill, workspaceId);
            },
            onClearBindings: function () {
              void saveWorkspaces(skill, []);
            },
          };
        };

        listArea = h(
          'ul',
          { className: layoutMode === 'cards' ? 'skm-grid' : 'skm-list' },
          rows.map(function (skill, index) {
            const itemProps = buildItemProps(skill, index);
            return layoutMode === 'cards' ? h(SkillCard, itemProps) : h(SkillRow, itemProps);
          }),
        );
      }

      const content = h(
        'div',
        null,
        h('div', { className: 'skm-toolbar' }, searchField, chipList, toolbarActions),
        statsLine,
        errorBar,
        listArea,
      );

      return h(
        'div',
        { className: 'skm-root' },
        h('style', null, CSS_TEXT),
        h('div', { className: 'skm-scroll' }, header, content),
      );
    }

    /* --------------------------------------------------------------------
     * Styles — only allowed theme tokens, no literal UI colours
     * ------------------------------------------------------------------ */

    const CSS_TEXT = `
.skm-root{height:100%;min-height:100%;display:block;overflow:auto;background:transparent;color:var(--dsw-alias-label-primary);font-family:inherit;font-size:13px;line-height:1.5}
.skm-root *{box-sizing:border-box}
.skm-scroll{max-width:1080px;margin:0 auto;padding:22px clamp(20px,3vw,32px) 48px}
.skm-header{display:flex;align-items:flex-start;justify-content:space-between;gap:16px;margin-bottom:20px}
.skm-heading{min-width:0}
.skm-title{margin:0;font-size:20px;font-weight:600;line-height:28px;letter-spacing:-.01em;color:var(--dsw-alias-label-primary)}
.skm-subtitle{margin:3px 0 0;font-size:13px;line-height:20px;color:var(--dsw-alias-label-secondary)}
.skm-toolbar{display:flex;align-items:center;gap:12px;flex-wrap:wrap;margin-bottom:12px}
.skm-search{display:flex;align-items:center;gap:8px;flex:1 1 240px;min-width:160px;height:34px;padding:0 10px;border:1px solid var(--dsw-alias-border-l1);border-radius:10px;background:var(--dsw-alias-bg-layer-1);color:var(--dsw-alias-label-secondary);transition:border-color .12s ease,background .12s ease}
.skm-search:hover{border-color:var(--dsw-alias-border-l2)}
.skm-search:focus-within{border-color:var(--dsw-alias-brand-primary)}
.skm-searchIcon{flex:none;display:inline-flex;align-items:center;justify-content:center;color:var(--dsw-alias-label-secondary)}
.skm-searchInput{flex:1;min-width:0;height:100%;padding:0;border:0;outline:0;background:transparent;color:var(--dsw-alias-label-primary);font:inherit;font-size:13px}
.skm-searchInput::placeholder{color:var(--dsw-alias-label-secondary);opacity:.75}
.skm-searchInput::-webkit-search-cancel-button{display:none}
.skm-searchClear{width:20px;height:20px;flex:none;display:inline-flex;align-items:center;justify-content:center;margin-right:-4px;padding:0;border:0;border-radius:6px;background:transparent;color:var(--dsw-alias-label-secondary);cursor:pointer}
.skm-searchClear:hover{color:var(--dsw-alias-label-primary);background:color-mix(in srgb,var(--dsw-alias-label-primary) 12%,transparent)}
.skm-chips{display:flex;align-items:center;gap:6px;flex-wrap:wrap}
.skm-chip{display:inline-flex;align-items:center;gap:6px;height:28px;padding:0 11px;border:1px solid transparent;border-radius:999px;background:transparent;color:var(--dsw-alias-label-secondary);font:inherit;font-size:12px;line-height:1;white-space:nowrap;cursor:pointer;transition:background .12s ease,color .12s ease,border-color .12s ease}
.skm-chip:hover{background:color-mix(in srgb,var(--dsw-alias-label-primary) 8%,transparent);color:var(--dsw-alias-label-primary)}
.skm-chip[aria-pressed="true"]{background:color-mix(in srgb,var(--dsw-alias-brand-primary) 14%,transparent);border-color:color-mix(in srgb,var(--dsw-alias-brand-primary) 20%,transparent);color:var(--dsw-alias-brand-primary)}
.skm-chipCount{font-size:11px;font-variant-numeric:tabular-nums;opacity:.72}
.skm-stats{display:flex;align-items:center;gap:10px;flex-wrap:wrap;min-height:18px;margin:0 0 14px;font-size:12px;line-height:18px;color:var(--dsw-alias-label-secondary);font-variant-numeric:tabular-nums}
.skm-scanning{display:inline-flex;align-items:center;gap:6px;color:var(--dsw-alias-label-secondary)}
.skm-scanningProgress{font-size:11px;opacity:.8;font-variant-numeric:tabular-nums}
.skm-dot{width:6px;height:6px;flex:none;border-radius:50%;background:var(--dsw-alias-brand-primary);animation:skmPulse 1.4s ease-in-out infinite}
@keyframes skmPulse{0%,100%{opacity:.25;transform:scale(.75)}50%{opacity:1;transform:scale(1)}}
.skm-errorBar{display:flex;align-items:flex-start;gap:10px;margin:0 0 12px;padding:9px 10px 9px 12px;border:1px solid color-mix(in srgb,var(--dsw-alias-state-error-primary) 36%,transparent);border-radius:10px;background:color-mix(in srgb,var(--dsw-alias-state-error-primary) 8%,transparent);font-size:12px;line-height:18px;color:var(--dsw-alias-label-primary)}
.skm-errorBarText{flex:1;min-width:0;overflow-wrap:anywhere}
.skm-errorBarClose{width:22px;height:22px;flex:none;display:inline-flex;align-items:center;justify-content:center;margin:-2px -2px 0 0;padding:0;border:0;border-radius:6px;background:transparent;color:var(--dsw-alias-label-secondary);cursor:pointer}
.skm-errorBarClose:hover{color:var(--dsw-alias-label-primary);background:color-mix(in srgb,var(--dsw-alias-label-primary) 12%,transparent)}
.skm-list{display:flex;flex-direction:column;gap:8px;margin:0;padding:0;list-style:none}
.skm-card{position:relative;border:1px solid var(--dsw-alias-border-l1);border-radius:12px;background:var(--dsw-alias-bg-layer-1);transition:background .12s ease,border-color .12s ease}
.skm-card:hover{background:var(--dsw-alias-bg-layer-2);border-color:var(--dsw-alias-border-l2)}
.skm-cardMain{display:flex;align-items:flex-start;gap:12px;padding:12px 12px 12px 14px}
.skm-tile{width:40px;height:40px;flex:none;display:flex;align-items:center;justify-content:center;border-radius:12px;font-size:16px;font-weight:600;line-height:1;text-transform:uppercase;user-select:none}
.skm-body{flex:1;min-width:0;padding-top:1px}
.skm-line1{display:flex;align-items:center;gap:8px;flex-wrap:wrap;min-height:20px}
.skm-name{font-size:14px;font-weight:600;line-height:20px;color:var(--dsw-alias-label-primary);font-family:ui-monospace,SFMono-Regular,Consolas,monospace;overflow-wrap:anywhere}
.skm-badge{display:inline-flex;align-items:center;gap:4px;height:18px;padding:0 6px;border:1px solid var(--dsw-alias-border-l1);border-radius:5px;background:color-mix(in srgb,var(--dsw-alias-label-primary) 6%,transparent);font-size:11px;line-height:16px;color:var(--dsw-alias-label-secondary);white-space:nowrap}
.skm-badge svg{flex:none}
.skm-badgeBound{background:color-mix(in srgb,var(--dsw-alias-brand-primary) 12%,transparent);border-color:color-mix(in srgb,var(--dsw-alias-brand-primary) 18%,transparent);color:var(--dsw-alias-brand-primary)}
.skm-calls{font-size:12px;line-height:18px;color:var(--dsw-alias-label-secondary);font-variant-numeric:tabular-nums;white-space:nowrap}
.skm-desc{margin:4px 0 0;font-size:13px;line-height:20px;color:var(--dsw-alias-label-secondary);display:-webkit-box;-webkit-line-clamp:2;-webkit-box-orient:vertical;overflow:hidden;overflow-wrap:anywhere}
.skm-descEmpty{opacity:.65}
.skm-actions{display:flex;align-items:center;gap:4px;flex:none;margin-left:2px;padding-top:3px}
.skm-iconBtn{width:28px;height:28px;flex:none;display:inline-flex;align-items:center;justify-content:center;padding:0;border:0;border-radius:8px;background:transparent;color:var(--dsw-alias-label-secondary);cursor:pointer;transition:background .12s ease,color .12s ease}
.skm-iconBtn:hover{background:color-mix(in srgb,var(--dsw-alias-label-primary) 10%,transparent);color:var(--dsw-alias-label-primary)}
.skm-iconBtn[aria-expanded="true"]{color:var(--dsw-alias-label-primary);background:color-mix(in srgb,var(--dsw-alias-label-primary) 8%,transparent)}
.skm-iconBtn:disabled{opacity:.5;cursor:default}
.skm-chevron{display:inline-flex;transition:transform .12s ease}
.skm-chevron[data-open="true"]{transform:rotate(90deg)}
.skm-switch{position:relative;display:inline-flex;align-items:center;width:34px;height:20px;flex:none;margin:0 2px;padding:2px;border:0;border-radius:999px;background:color-mix(in srgb,var(--dsw-alias-label-secondary) 30%,transparent);cursor:pointer;transition:background .12s ease}
.skm-switch:hover{background:color-mix(in srgb,var(--dsw-alias-label-secondary) 44%,transparent)}
.skm-switch[aria-checked="true"]{background:var(--dsw-alias-brand-primary)}
.skm-switch[aria-checked="true"]:hover{background:color-mix(in srgb,var(--dsw-alias-brand-primary) 88%,var(--dsw-alias-label-secondary))}
.skm-switchThumb{width:16px;height:16px;border-radius:999px;background:var(--dsw-alias-bg-base);transition:transform .12s ease}
.skm-switch[aria-checked="true"] .skm-switchThumb{transform:translateX(14px)}
.skm-switch:disabled{opacity:.55;cursor:default}
.skm-menuWrap{position:relative;display:inline-flex}
.skm-menu{position:absolute;top:calc(100% + 6px);right:0;z-index:60;display:flex;flex-direction:column;gap:2px;min-width:184px;padding:4px;border:1px solid var(--dsw-alias-border-l1);border-radius:10px;background:var(--dsw-alias-bg-overlay);box-shadow:0 12px 28px -12px color-mix(in srgb,var(--dsw-alias-bg-base) 92%,transparent);animation:skmMenuIn .12s ease}
.skm-menu[data-up="true"]{top:auto;bottom:calc(100% + 6px)}
@keyframes skmMenuIn{from{opacity:0;transform:translateY(-3px)}to{opacity:1;transform:none}}
.skm-menuItem{display:flex;align-items:center;gap:8px;width:100%;padding:6px 8px;border:0;border-radius:6px;background:transparent;color:var(--dsw-alias-label-primary);font:inherit;font-size:13px;line-height:18px;text-align:left;white-space:nowrap;cursor:pointer}
.skm-menuItem:hover{background:color-mix(in srgb,var(--dsw-alias-label-primary) 12%,transparent)}
.skm-menuItem svg{flex:none;color:var(--dsw-alias-label-secondary)}
.skm-menuDanger,.skm-menuDanger svg{color:var(--dsw-alias-state-error-primary)}
.skm-bind{margin:0;padding:12px;border:1px solid var(--dsw-alias-border-l1);border-radius:10px;background:color-mix(in srgb,var(--dsw-alias-label-primary) 4%,transparent)}
.skm-bindHelp{margin:0 0 10px;font-size:12px;line-height:18px;color:var(--dsw-alias-label-secondary)}
.skm-bindBar{display:flex;align-items:center;gap:10px;flex-wrap:wrap;margin-bottom:8px}
.skm-bindSearch{display:flex;align-items:center;gap:6px;flex:1 1 200px;min-width:150px;height:30px;padding:0 8px;border:1px solid var(--dsw-alias-border-l1);border-radius:8px;background:var(--dsw-alias-bg-base);color:var(--dsw-alias-label-secondary)}
.skm-bindSearch:focus-within{border-color:var(--dsw-alias-brand-primary)}
.skm-bindSearch input{flex:1;min-width:0;height:100%;padding:0;border:0;outline:0;background:transparent;color:var(--dsw-alias-label-primary);font:inherit;font-size:12px}
.skm-bindSearch input::placeholder{color:var(--dsw-alias-label-secondary);opacity:.75}
.skm-bindCount{font-size:12px;line-height:18px;color:var(--dsw-alias-label-secondary);font-variant-numeric:tabular-nums;white-space:nowrap}
.skm-linkBtn{padding:0;border:0;border-radius:4px;background:transparent;color:var(--dsw-alias-brand-primary);font:inherit;font-size:12px;line-height:18px;cursor:pointer}
.skm-linkBtn:hover{text-decoration:underline}
.skm-bindList{display:flex;flex-direction:column;gap:1px;max-height:320px;overflow:auto;padding:4px;border:1px solid var(--dsw-alias-border-l1);border-radius:8px;background:var(--dsw-alias-bg-base)}
.skm-bindItem{display:flex;align-items:flex-start;gap:9px;min-height:36px;padding:6px 8px;border-radius:6px;cursor:pointer;font-size:13px;line-height:18px;color:var(--dsw-alias-label-primary)}
.skm-bindItem:hover{background:color-mix(in srgb,var(--dsw-alias-label-primary) 7%,transparent)}
.skm-bindItem[data-checked="true"]{background:color-mix(in srgb,var(--dsw-alias-brand-primary) 9%,transparent)}
.skm-bindCheck{position:relative;flex:none;width:15px;height:15px;margin:2px 0 0;padding:0;appearance:none;-webkit-appearance:none;border:1px solid var(--dsw-alias-border-l2);border-radius:4px;background:transparent;cursor:pointer;transition:background .12s ease,border-color .12s ease}
.skm-bindCheck:hover:not(:disabled){border-color:var(--dsw-alias-label-secondary)}
.skm-bindCheck:checked{background:var(--dsw-alias-brand-primary);border-color:var(--dsw-alias-brand-primary)}
.skm-bindCheck:checked::after{content:"";position:absolute;left:4px;top:1px;width:4px;height:8px;border:solid var(--dsw-alias-bg-base);border-width:0 1.5px 1.5px 0;transform:rotate(45deg)}
.skm-bindCheck:disabled{opacity:.45;cursor:default}
.skm-bindBody{flex:1;min-width:0;display:flex;flex-direction:column;gap:1px}
.skm-bindTitleRow{display:flex;align-items:center;gap:6px;min-width:0}
.skm-bindTitle{flex:1 1 auto;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.skm-bindPath{display:block;max-width:100%;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;font-family:ui-monospace,SFMono-Regular,Consolas,monospace;font-size:12px;line-height:16px;color:var(--dsw-alias-label-secondary)}
.skm-bindMeta{flex:none;font-size:11px;line-height:16px;color:var(--dsw-alias-label-secondary);font-variant-numeric:tabular-nums;white-space:nowrap}
.skm-badgeCurrent{flex:none;color:var(--dsw-alias-brand-primary)}
.skm-bindFallback{margin:0 0 10px;padding:10px 12px;border:1px dashed var(--dsw-alias-border-l2);border-radius:8px;background:color-mix(in srgb,var(--dsw-alias-label-primary) 3%,transparent)}
.skm-bindFallbackNote{margin:0 0 8px;font-size:12px;line-height:18px;color:var(--dsw-alias-label-secondary)}
.skm-bindIdChips{display:flex;flex-wrap:wrap;gap:6px}
.skm-chipId{display:inline-flex;align-items:center;gap:5px;height:24px;padding:0 7px;border:1px solid var(--dsw-alias-border-l1);border-radius:6px;background:var(--dsw-alias-bg-layer-1);color:var(--dsw-alias-label-primary);font:inherit;font-family:ui-monospace,SFMono-Regular,Consolas,monospace;font-size:12px;line-height:1;cursor:pointer;transition:background .12s ease,border-color .12s ease}
.skm-chipId:hover{border-color:color-mix(in srgb,var(--dsw-alias-state-error-primary) 45%,transparent);background:color-mix(in srgb,var(--dsw-alias-state-error-primary) 10%,transparent)}
.skm-chipId svg{flex:none;color:var(--dsw-alias-label-secondary)}
.skm-chipId:hover svg{color:var(--dsw-alias-state-error-primary)}
.skm-chipIdText{max-width:180px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.skm-bindEmpty{margin:0;padding:16px 8px;text-align:center;font-size:12px;line-height:18px;color:var(--dsw-alias-label-secondary)}
.skm-bindHint{margin:8px 0 0;font-size:11px;line-height:16px;color:var(--dsw-alias-state-warn-primary)}
.skm-confirm{display:flex;align-items:center;justify-content:space-between;gap:12px;flex-wrap:wrap;margin:0 12px 12px 14px;padding:10px 12px;border:1px solid color-mix(in srgb,var(--dsw-alias-state-error-primary) 32%,transparent);border-radius:10px;background:color-mix(in srgb,var(--dsw-alias-state-error-primary) 7%,transparent)}
.skm-confirmText{flex:1;min-width:180px;font-size:12px;line-height:18px;color:var(--dsw-alias-label-primary)}
.skm-confirmActions{display:flex;align-items:center;gap:8px;flex:none}
.skm-btn{display:inline-flex;align-items:center;justify-content:center;gap:6px;height:30px;padding:0 12px;border:1px solid var(--dsw-alias-border-l1);border-radius:8px;background:var(--dsw-alias-bg-layer-1);color:var(--dsw-alias-label-primary);font:inherit;font-size:13px;line-height:1;white-space:nowrap;cursor:pointer;transition:background .12s ease,border-color .12s ease,color .12s ease}
.skm-btn:hover{background:var(--dsw-alias-bg-layer-2);border-color:var(--dsw-alias-border-l2)}
.skm-btn:disabled{opacity:.55;cursor:default}
.skm-btnDanger{border-color:color-mix(in srgb,var(--dsw-alias-state-error-primary) 38%,transparent);background:transparent;color:var(--dsw-alias-state-error-primary)}
.skm-btnDanger:hover{background:color-mix(in srgb,var(--dsw-alias-state-error-primary) 12%,transparent);border-color:color-mix(in srgb,var(--dsw-alias-state-error-primary) 58%,transparent)}
.skm-skeleton{display:flex;flex-direction:column;gap:8px}
.skm-skCard{display:flex;align-items:center;gap:12px;padding:14px;border:1px solid var(--dsw-alias-border-l1);border-radius:12px;background:var(--dsw-alias-bg-layer-1)}
.skm-skTile{width:40px;height:40px;flex:none;border-radius:12px}
.skm-skLines{flex:1;display:flex;flex-direction:column;gap:9px}
.skm-skLine{height:10px;border-radius:6px}
.skm-skLine[data-w="name"]{width:32%}
.skm-skLine[data-w="desc"]{width:76%}
.skm-skTile,.skm-skLine{background:var(--dsw-alias-bg-layer-2);animation:skmBreathe 1.4s ease-in-out infinite}
@keyframes skmBreathe{0%,100%{opacity:.5}50%{opacity:1}}
.skm-empty{display:flex;flex-direction:column;align-items:center;justify-content:center;padding:56px 24px;text-align:center;border:1px dashed var(--dsw-alias-border-l1);border-radius:12px;background:color-mix(in srgb,var(--dsw-alias-label-primary) 2%,transparent)}
.skm-emptyGlyph{color:var(--dsw-alias-label-secondary);opacity:.55;margin-bottom:12px}
.skm-emptyTitle{margin:0;font-size:14px;font-weight:500;line-height:20px;color:var(--dsw-alias-label-primary)}
.skm-emptyHint{margin:4px 0 0;max-width:380px;font-size:12px;line-height:18px;color:var(--dsw-alias-label-secondary)}
.skm-emptyAction{margin-top:14px}
.skm-errorState{display:flex;flex-direction:column;align-items:center;justify-content:center;padding:48px 24px;text-align:center;border:1px solid color-mix(in srgb,var(--dsw-alias-state-error-primary) 30%,transparent);border-radius:12px;background:color-mix(in srgb,var(--dsw-alias-state-error-primary) 6%,transparent)}
.skm-errorGlyph{color:var(--dsw-alias-state-error-primary);margin-bottom:10px}
.skm-errorTitle{margin:0;font-size:14px;font-weight:500;line-height:20px;color:var(--dsw-alias-label-primary)}
.skm-errorDetail{margin:4px 0 0;max-width:420px;font-size:12px;line-height:18px;color:var(--dsw-alias-label-secondary);overflow-wrap:anywhere}
.skm-root :focus-visible{outline:2px solid var(--dsw-alias-brand-primary);outline-offset:2px}
.skm-toolbarActions{display:flex;align-items:center;gap:6px;flex:none;margin-left:auto}
.skm-toolBtn{display:inline-flex;align-items:center;gap:6px;height:28px;padding:0 9px;border:1px solid var(--dsw-alias-border-l1);border-radius:8px;background:transparent;color:var(--dsw-alias-label-secondary);font:inherit;font-size:12px;line-height:1;white-space:nowrap;cursor:pointer;transition:background .12s ease,border-color .12s ease,color .12s ease}
.skm-toolBtn:hover{background:color-mix(in srgb,var(--dsw-alias-label-primary) 8%,transparent);color:var(--dsw-alias-label-primary)}
.skm-toolBtn[aria-expanded="true"],.skm-toolBtnActive{color:var(--dsw-alias-label-primary);background:color-mix(in srgb,var(--dsw-alias-label-primary) 8%,transparent);border-color:var(--dsw-alias-border-l2)}
.skm-toolBtn:disabled{opacity:.5;cursor:default}
.skm-toolBtn:disabled:hover{background:transparent;color:var(--dsw-alias-label-secondary)}
.skm-toolChevron{display:inline-flex;align-items:center;color:var(--dsw-alias-label-secondary)}
.skm-filterCount{min-width:16px;height:16px;padding:0 4px;border-radius:5px;background:color-mix(in srgb,var(--dsw-alias-brand-primary) 16%,transparent);color:var(--dsw-alias-brand-primary);font-size:10px;line-height:16px;text-align:center;font-variant-numeric:tabular-nums}
.skm-sortMenu{min-width:168px}
.skm-menuCheck{display:inline-flex;align-items:center;justify-content:center;width:12px;height:12px;flex:none;color:var(--dsw-alias-brand-primary)}
.skm-filterMenu{min-width:296px;max-width:min(340px,calc(100vw - 48px));max-height:min(72vh,560px);overflow:auto;padding:10px;gap:0}
.skm-filterSection{display:flex;flex-direction:column;gap:6px;padding:6px 2px 10px;border-bottom:1px solid var(--dsw-alias-border-l1)}
.skm-filterSection:last-of-type{border-bottom:0}
.skm-filterLabel{font-size:11px;font-weight:600;letter-spacing:.02em;color:var(--dsw-alias-label-secondary)}
.skm-filterEmpty{margin:0;font-size:12px;line-height:18px;color:var(--dsw-alias-label-secondary);opacity:.8}
.skm-filterTags{display:flex;flex-wrap:wrap;gap:6px}
.skm-tagToggle{display:inline-flex;align-items:center;gap:5px;height:24px;padding:0 8px;border:1px solid var(--dsw-alias-border-l1);border-radius:999px;background:transparent;color:var(--dsw-alias-label-secondary);font:inherit;font-size:12px;line-height:1;white-space:nowrap;cursor:pointer;transition:background .12s ease,border-color .12s ease,color .12s ease}
.skm-tagToggle:hover{background:color-mix(in srgb,var(--dsw-alias-label-primary) 8%,transparent);color:var(--dsw-alias-label-primary)}
.skm-tagToggle[aria-pressed="true"]{background:color-mix(in srgb,var(--dsw-alias-brand-primary) 14%,transparent);border-color:color-mix(in srgb,var(--dsw-alias-brand-primary) 24%,transparent);color:var(--dsw-alias-brand-primary)}
.skm-filterClear{align-self:flex-start;margin-top:2px}
.skm-filterRadios{display:flex;flex-wrap:wrap;gap:4px}
.skm-filterRadio{height:24px;padding:0 8px;border:1px solid transparent;border-radius:6px;background:transparent;color:var(--dsw-alias-label-secondary);font:inherit;font-size:12px;line-height:1;white-space:nowrap;cursor:pointer;transition:background .12s ease,border-color .12s ease,color .12s ease}
.skm-filterRadio:hover{background:color-mix(in srgb,var(--dsw-alias-label-primary) 8%,transparent);color:var(--dsw-alias-label-primary)}
.skm-filterRadio[aria-checked="true"]{background:color-mix(in srgb,var(--dsw-alias-brand-primary) 14%,transparent);border-color:color-mix(in srgb,var(--dsw-alias-brand-primary) 22%,transparent);color:var(--dsw-alias-brand-primary)}
.skm-filterFooter{display:flex;justify-content:flex-end;padding-top:8px}
.skm-aiStatus{display:inline-flex;align-items:center;gap:6px;color:var(--dsw-alias-label-secondary);font-size:11px;line-height:18px}
.skm-warnDot{width:6px;height:6px;flex:none;border-radius:50%;background:var(--dsw-alias-state-warn-primary)}
.skm-rowTags{display:inline-flex;align-items:center;gap:4px;flex-wrap:wrap}
.skm-tagChip{display:inline-flex;align-items:center;gap:4px;height:18px;padding:0 6px;border:1px solid var(--dsw-alias-border-l1);border-radius:5px;background:color-mix(in srgb,var(--dsw-alias-label-primary) 5%,transparent);color:var(--dsw-alias-label-secondary);font:inherit;font-size:11px;line-height:16px;white-space:nowrap;cursor:pointer;transition:background .12s ease,border-color .12s ease,color .12s ease}
.skm-tagChip:hover{color:var(--dsw-alias-label-primary);border-color:var(--dsw-alias-border-l2)}
.skm-tagChip[aria-pressed="true"]{background:color-mix(in srgb,var(--dsw-alias-brand-primary) 14%,transparent);border-color:color-mix(in srgb,var(--dsw-alias-brand-primary) 24%,transparent);color:var(--dsw-alias-brand-primary)}
.skm-tagChipAi{opacity:.82;border-style:dashed}
.skm-tagAiMark{font-size:9px;line-height:1;opacity:.9}
.skm-tagChipEditable{cursor:default;height:22px;padding:0 4px 0 7px}
.skm-tagList{display:flex;flex-wrap:wrap;gap:6px}
.skm-tagsEmpty{margin:0 0 2px;font-size:12px;line-height:18px;color:var(--dsw-alias-label-secondary);opacity:.8}
.skm-tagRemove{width:16px;height:16px;flex:none;display:inline-flex;align-items:center;justify-content:center;padding:0;border:0;border-radius:4px;background:transparent;color:var(--dsw-alias-label-secondary);cursor:pointer}
.skm-tagRemove:hover{color:var(--dsw-alias-state-error-primary);background:color-mix(in srgb,var(--dsw-alias-state-error-primary) 12%,transparent)}
.skm-tagRemove:disabled{opacity:.4;cursor:default}
.skm-tagAdd{display:flex;align-items:center;gap:8px;margin-top:10px}
.skm-tagInput{flex:1;min-width:0;height:28px;padding:0 8px;border:1px solid var(--dsw-alias-border-l1);border-radius:8px;background:var(--dsw-alias-bg-base);color:var(--dsw-alias-label-primary);font:inherit;font-size:12px}
.skm-tagInput:focus{outline:none;border-color:var(--dsw-alias-brand-primary)}
.skm-tagInput::placeholder{color:var(--dsw-alias-label-secondary);opacity:.75}
.skm-tagHint{margin:6px 0 0;font-size:11px;line-height:16px;color:var(--dsw-alias-state-warn-primary)}
.skm-tagMeta{display:flex;flex-direction:column;gap:2px;margin-top:10px;padding-top:8px;border-top:1px solid var(--dsw-alias-border-l1);font-size:12px;line-height:18px;color:var(--dsw-alias-label-secondary);font-variant-numeric:tabular-nums}
.skm-btnSm{height:28px;padding:0 10px;font-size:12px}
.skm-detail{display:flex;flex-direction:column;gap:12px;padding:0 12px 12px 14px}
.skm-detailSection{display:flex;flex-direction:column;gap:6px}
.skm-detailHeading{margin:0 0 0 2px;font-size:12px;font-weight:600;line-height:18px;color:var(--dsw-alias-label-secondary)}
.skm-segment{display:inline-flex;align-items:center;gap:1px;height:28px;padding:2px;border:1px solid var(--dsw-alias-border-l1);border-radius:8px;background:transparent}
.skm-segBtn{width:26px;height:22px;display:inline-flex;align-items:center;justify-content:center;padding:0;border:0;border-radius:6px;background:transparent;color:var(--dsw-alias-label-secondary);cursor:pointer;transition:background .12s ease,color .12s ease}
.skm-segBtn:hover{color:var(--dsw-alias-label-primary);background:color-mix(in srgb,var(--dsw-alias-label-primary) 8%,transparent)}
.skm-segBtn[aria-pressed="true"]{color:var(--dsw-alias-brand-primary);background:color-mix(in srgb,var(--dsw-alias-brand-primary) 14%,transparent)}
.skm-grid{display:grid;grid-template-columns:repeat(auto-fill,minmax(240px,1fr));gap:10px;margin:0;padding:0;list-style:none}
.skm-gridCard{display:flex;flex-direction:column;gap:8px;min-width:0;padding:12px;border:1px solid var(--dsw-alias-border-l1);border-radius:12px;background:var(--dsw-alias-bg-layer-1);transition:background .12s ease,border-color .12s ease}
.skm-gridCard:hover{background:var(--dsw-alias-bg-layer-2);border-color:var(--dsw-alias-border-l2)}
.skm-gridCard[data-open="true"]{grid-column:1 / -1}
.skm-gridHead{display:flex;align-items:flex-start;justify-content:space-between;gap:8px}
.skm-gridTitleRow{display:flex;align-items:center;gap:6px;min-width:0;flex-wrap:wrap}
.skm-gridTitleRow .skm-name{min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.skm-gridHeadActions{display:flex;align-items:center;gap:2px;flex:none;margin:-5px -5px 0 0}
.skm-gridCard .skm-desc{margin:0}
.skm-gridTags{display:flex;flex-wrap:wrap;gap:4px;min-width:0}
.skm-gridMeta{display:flex;align-items:center;gap:5px;min-width:0;margin-top:auto;font-size:11px;line-height:16px;color:var(--dsw-alias-label-secondary);overflow:hidden}
.skm-gridMetaText{min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.skm-gridDot{width:2px;height:2px;flex:none;border-radius:50%;background:var(--dsw-alias-label-secondary);opacity:.6}
.skm-gridMeta .skm-iconBtn{margin-left:auto}
.skm-tagMore{display:inline-flex;align-items:center;height:18px;padding:0 5px;border:1px dashed var(--dsw-alias-border-l1);border-radius:5px;color:var(--dsw-alias-label-secondary);font-size:11px;line-height:16px;white-space:nowrap}
.skm-gridCard .skm-detail{padding:10px 0 0;border-top:1px solid var(--dsw-alias-border-l1)}
.skm-gridCard .skm-confirm{margin:0}
.skm-skGridCard{min-height:104px;gap:10px}
.skm-skLine[data-w="meta"]{width:46%}
@media (max-width:560px){.skm-grid{grid-template-columns:1fr}}
@media (max-width:720px){
.skm-scroll{padding:18px 16px 40px}
.skm-toolbar{gap:8px}
.skm-search{flex:1 1 100%}
.skm-toolbarActions{width:100%;justify-content:flex-end;margin-left:0}
.skm-actions{gap:2px}
.skm-cardMain{padding:11px 10px 11px 12px;gap:10px}
.skm-detail{padding:0 10px 10px 12px}
.skm-confirm{margin:0 10px 10px 12px}
.skm-stats{font-size:11px}
.skm-scanningProgress{display:none}
.skm-menu{min-width:168px}
.skm-filterMenu{min-width:0;width:min(320px,calc(100vw - 32px))}
}
@media (prefers-reduced-motion:reduce){
.skm-dot,.skm-skTile,.skm-skLine{animation:none}
.skm-menu{animation:none}
.skm-card,.skm-switch,.skm-switchThumb,.skm-chevron,.skm-chip,.skm-iconBtn,.skm-search,.skm-menuItem,.skm-bindCheck,.skm-btn{transition:none}
}
`;

    /* --------------------------------------------------------------------
     * Plugin face
     * ------------------------------------------------------------------ */

    function apply(ctx) {
      ctx.effect(function () {
        try {
          return ctx.locale.register(NS, { zh: zh, en: en });
        } catch (error) {
          if (typeof console !== 'undefined' && console.warn) {
            console.warn('[skill-manager] locale registration failed:', error);
          }
          return function () {};
        }
      }, 'skill-manager: locale');

      const t = ctx.locale.bind(NS);

      // 注册失败自报：把异常回传给 Host（payload.client.lastError），便于排查槽位注册问题。
      function reportRegistrationFailure(where, error) {
        try {
          if (typeof fetch !== 'function') return;
          var message = where + ': ' + (error && error.message ? error.message : String(error));
          fetch(API_PATH, {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ action: 'reportClientError', message: message }),
          }).catch(function () {});
        } catch (ignored) {
          /* 诊断通道本身不可用则忽略 */
        }
      }

      function registerGuarded(where, callback) {
        try {
          return callback();
        } catch (error) {
          reportRegistrationFailure(where, error);
          throw error;
        }
      }

      try {
        ctx.slots.inject('sidebar.panellist', function () {
          return registerGuarded('sidebar.panellist', function () {
            return ctx.slots.register(
              {
                name: 'sidebar.panellist',
                id: 'skill-manager',
                order: 20,
                locale: NS,
                label: function () {
                  return t('nav');
                },
              },
              SidebarSkillIcon,
            );
          });
        });
      } catch (error) {
        reportRegistrationFailure('inject-sidebar.panellist', error);
      }

      try {
        ctx.slots.inject('main', function () {
          return registerGuarded('main', function () {
            return ctx.slots.register(
              {
                name: 'main',
                key: 'skill-manager',
                locale: NS,
              },
              SkillManagerPage,
            );
          });
        });
      } catch (error) {
        reportRegistrationFailure('inject-main', error);
      }
    }

    return {
      inject: ['slots', 'locale'],
      apply: apply,
    };
  },
});
