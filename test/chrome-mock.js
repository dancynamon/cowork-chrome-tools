// Minimal in-memory chrome.* mock and a loader that runs the extension's
// service-worker scripts in a fresh vm context, the way Chrome would.
'use strict';

const fs = require('fs');
const path = require('path');
const vm = require('vm');

const ROOT = path.join(__dirname, '..');

function event() {
  const listeners = [];
  return {
    addListener: (fn) => listeners.push(fn),
    dispatch: (...args) => listeners.map((fn) => fn(...args)),
    listeners
  };
}

function storageArea() {
  let data = {};
  return {
    async get(defaults) {
      const out = {};
      for (const [k, v] of Object.entries(defaults || {})) {
        out[k] = k in data ? structuredClone(data[k]) : v;
      }
      return out;
    },
    async set(obj) { Object.assign(data, structuredClone(obj)); },
    _dump: () => data,
    _reset: () => { data = {}; }
  };
}

function createChrome({ manifestVersion = '0.0.0' } = {}) {
  const groups = new Map(); // id -> {id, windowId, title, color}
  const tabs = new Map();   // id -> {id, windowId, groupId, index, url}
  const updates = [];       // log of tabGroups.update calls
  let nextGroupId = 100;

  const chrome = {
    tabGroups: {
      TAB_GROUP_ID_NONE: -1,
      onCreated: event(),
      onUpdated: event(),
      async get(id) {
        if (!groups.has(id)) throw new Error('No group with id: ' + id + '.');
        return { ...groups.get(id) };
      },
      async update(id, props) {
        if (!groups.has(id)) throw new Error('No group with id: ' + id + '.');
        const g = Object.assign(groups.get(id), props);
        updates.push({ id, ...props });
        return { ...g };
      }
    },
    tabs: {
      onUpdated: event(),
      onAttached: event(),
      async get(id) {
        if (!tabs.has(id)) throw new Error('No tab with id: ' + id + '.');
        return { ...tabs.get(id) };
      },
      async query({ groupId }) {
        return [...tabs.values()].filter((t) => t.groupId === groupId).map((t) => ({ ...t }));
      }
    },
    storage: { local: storageArea(), session: storageArea() },
    runtime: {
      onMessage: event(),
      getManifest: () => ({ version: manifestVersion })
    },

    // --- test helpers, not part of the chrome API ---
    _groups: groups,
    _tabs: tabs,
    _updates: updates,
    _addGroup({ windowId = 1, title = '', color = 'grey' } = {}) {
      const id = nextGroupId++;
      groups.set(id, { id, windowId, title, color });
      return id;
    },
    _addTab({ id, groupId, url, windowId = 1, index }) {
      const i = index !== undefined ? index : [...tabs.values()].filter((t) => t.groupId === groupId).length;
      tabs.set(id, { id, windowId, groupId, index: i, url });
    },
    _removeGroup(id) { groups.delete(id); }
  };
  return chrome;
}

// Load the background worker (which importScripts auto.js and restore.js) into
// a new context. Returns { ctx, chrome, get(name) } - get() reads top-level
// const/let bindings, which are not properties of the context object.
function loadBackground(opts) {
  const chrome = createChrome(opts);
  const ctx = vm.createContext({
    chrome, console, setTimeout, clearTimeout, URL, structuredClone
  });
  ctx.importScripts = (...files) => {
    for (const f of files) {
      vm.runInContext(fs.readFileSync(path.join(ROOT, f), 'utf8'), ctx, { filename: f });
    }
  };
  ctx.importScripts('background.js');
  return { ctx, chrome, get: (name) => vm.runInContext(name, ctx) };
}

// Send a runtime message the way a content script (sender.tab set) or the
// popup (no sender.tab) would, and resolve with the response.
function sendMessage(chrome, msg, sender = {}) {
  return new Promise((resolve) => {
    let async = false;
    for (const fn of chrome.runtime.onMessage.listeners) {
      if (fn(msg, sender, resolve) === true) async = true;
    }
    if (!async) setTimeout(() => resolve(undefined), 0);
  });
}

// Cross-realm values (arrays/objects made inside the vm) fail deepStrictEqual
// on prototype identity; normalize them first.
const plain = (v) => (v === undefined ? v : JSON.parse(JSON.stringify(v)));

module.exports = { createChrome, loadBackground, sendMessage, plain, ROOT };
